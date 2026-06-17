#!/usr/bin/env node
// CFO OneDrive control skill (DELEGATED, acts as matthew@innd.com across his WHOLE OneDrive).
//
// The CFO is the controlling party for Matt's OneDrive: full read/write/move/copy/dedupe.
// Two layers:
//   1) The Matt <-> CFO exchange folders at the drive root:
//        CFO Outgoing  = Matt drops files here FOR the CFO
//        CFO Processed = the CFO's organized archive / audit data room
//        CFO Incoming  = the CFO delivers work product here FOR Matt
//   2) General drive primitives (any path from the drive root) so the CFO can build a
//      per-company / per-category audit data room, move files in, and dedupe.
//
// Why delegated: the tenant blocks app-only OneDrive access (503). This skill uses a delegated
// refresh token (graph-onedrive-refresh-token) scoped to Files.ReadWrite (full access to Matt's
// own OneDrive). The refresh token rotates on use and is auto-persisted to Secret Manager.
//
// Creds (hydrated): GRAPH_MAIL_CLIENT_ID / GRAPH_MAIL_CLIENT_SECRET / GRAPH_MAIL_TENANT_ID (the app),
// GCP_CLAUDE_DRIVER_SA_JSON (reads/writes graph-onedrive-refresh-token in Secret Manager).
//
// All <path> args are relative to the OneDrive ROOT (e.g. "CFO Processed/OTCHealth/Bank Statements").
//
// Exchange commands:
//   inbox                              list CFO Outgoing (what Matt left for you)
//   pull <name> [dir]                  download a file from CFO Outgoing
//   process <name>                     MOVE a file CFO Outgoing -> CFO Processed (root)
//   deliver <localFile> [destName]     upload work product to CFO Incoming
//   incoming-list | processed-list
// General drive commands (work anywhere in Matt's OneDrive):
//   ls [path]                          list a folder (default = drive root)
//   tree [path]                        recursive listing
//   stat <path>                        item metadata (size, hash, ids)
//   mkdir <path>                       create a folder (parents auto-created, mkdir -p)
//   mv <src> <destFolder> [newName]    move an item (destFolder auto-created if missing)
//   cp <src> <destFolder> [newName]    copy/duplicate an item (async; polls to completion)
//   rm <path>                          delete an item (to the OneDrive recycle bin, recoverable)
//   upload <localFile> <destPath>      upload a local file to an arbitrary OneDrive path
//   download <path> [dir]              download any file by path
//   catalog [path] [outfile]           recursive inventory -> JSON (+ duplicate-hash report)
//   find-dupes [path]                  list groups of byte-identical files (same quickXorHash)
//   dataroom-init [parent]             scaffold an audit data room (per-company + _Duplicates)
import crypto from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { basename } from "node:path";

const SM = "otchealth-shared-prod";
const GRAPH = "https://graph.microsoft.com/v1.0";
const OUTGOING = process.env.CFO_OUTGOING_FOLDER || "CFO Outgoing";
const INCOMING = process.env.CFO_INCOMING_FOLDER || "CFO Incoming";
const PROCESSED = process.env.CFO_PROCESSED_FOLDER || "CFO Processed";
function need(n) { const v = process.env[n]; if (!v) { console.error("Missing env " + n); process.exit(2); } return v; }
function encPath(p) { return p.split("/").filter(Boolean).map(encodeURIComponent).join("/"); }
function itemRef(path) { return path && path !== "/" ? `/me/drive/root:/${encPath(path)}` : "/me/drive/root"; }

async function smToken() {
  const sa = JSON.parse(need("GCP_CLAUDE_DRIVER_SA_JSON"));
  const now = Math.floor(Date.now() / 1000);
  const e = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const i = `${e({ alg: "RS256", typ: "JWT" })}.${e({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/cloud-platform", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 })}`;
  const s = crypto.createSign("RSA-SHA256").update(i).sign(sa.private_key, "base64url");
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${encodeURIComponent(i + "." + s)}` });
  if (!r.ok) throw new Error("SM auth " + r.status);
  return (await r.json()).access_token;
}
async function smRead(t, id) { const r = await fetch(`https://secretmanager.googleapis.com/v1/projects/${SM}/secrets/${id}/versions/latest:access`, { headers: { Authorization: `Bearer ${t}` } }); if (!r.ok) return null; return Buffer.from((await r.json()).payload.data, "base64").toString("utf8").trim(); }
async function smWrite(t, id, v) { const body = JSON.stringify({ payload: { data: Buffer.from(v, "utf8").toString("base64") } }); let r = await fetch(`https://secretmanager.googleapis.com/v1/projects/${SM}/secrets/${id}:addVersion`, { method: "POST", headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" }, body }); if (r.status === 404) { await fetch(`https://secretmanager.googleapis.com/v1/projects/${SM}/secrets?secretId=${id}`, { method: "POST", headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" }, body: JSON.stringify({ replication: { automatic: {} } }) }); r = await fetch(`https://secretmanager.googleapis.com/v1/projects/${SM}/secrets/${id}:addVersion`, { method: "POST", headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" }, body }); } if (!r.ok) throw new Error("SM write " + r.status); }

async function accessToken() {
  const smt = await smToken();
  const refresh = await smRead(smt, "graph-onedrive-refresh-token");
  if (!refresh) throw new Error("No graph-onedrive-refresh-token in Secret Manager. Run the OneDrive consent first.");
  const T = need("GRAPH_MAIL_TENANT_ID"), CID = need("GRAPH_MAIL_CLIENT_ID"), SEC = need("GRAPH_MAIL_CLIENT_SECRET");
  const r = await fetch(`https://login.microsoftonline.com/${T}/oauth2/v2.0/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: CID, client_secret: SEC, grant_type: "refresh_token", refresh_token: refresh, scope: "offline_access Files.ReadWrite" }) });
  const j = await r.json();
  if (!j.access_token) throw new Error("token refresh failed " + r.status + ": " + JSON.stringify(j).slice(0, 200));
  if (j.refresh_token && j.refresh_token !== refresh) { try { await smWrite(smt, "graph-onedrive-refresh-token", j.refresh_token); console.error("rotated OneDrive refresh token -> persisted."); } catch (e) { console.error("ROTATE PERSIST FAILED: " + e.message); } }
  return j.access_token;
}
async function gx(tok, method, path, opts = {}) { return fetch(path.startsWith("http") ? path : GRAPH + path, { method, headers: { Authorization: `Bearer ${tok}`, ...(opts.headers || {}) }, body: opts.body }); }

async function getItem(tok, path, select = "id,name,size,lastModifiedDateTime,folder,file,parentReference") {
  const r = await gx(tok, "GET", `${itemRef(path)}?$select=${select}`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`stat "${path}" ${r.status}: ${(await r.text()).slice(0, 160)}`);
  return await r.json();
}
async function listChildren(tok, path = "") {
  let url = `${itemRef(path)}:/children?$select=name,id,size,lastModifiedDateTime,folder,file&$top=200`;
  if (!path || path === "/") url = `/me/drive/root/children?$select=name,id,size,lastModifiedDateTime,folder,file&$top=200`;
  const out = [];
  while (url) {
    const r = await gx(tok, "GET", url);
    if (!r.ok) throw new Error(`list "${path}" ${r.status}: ${(await r.text()).slice(0, 160)}`);
    const j = await r.json();
    out.push(...(j.value || []));
    url = j["@odata.nextLink"] || null;
  }
  return out;
}
// mkdir -p: create each missing path segment, return the leaf folder id.
async function ensureFolder(tok, path) {
  const segs = path.split("/").filter(Boolean);
  let parent = "", id = null;
  for (const seg of segs) {
    const cur = parent ? parent + "/" + seg : seg;
    let it = await getItem(tok, cur, "id,folder");
    if (!it) {
      const createUrl = parent ? `${itemRef(parent)}:/children` : "/me/drive/root/children";
      const r = await gx(tok, "POST", createUrl, { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: seg, folder: {}, "@microsoft.graph.conflictBehavior": "fail" }) });
      if (!r.ok && r.status !== 409) throw new Error(`mkdir "${cur}" ${r.status}: ${(await r.text()).slice(0, 160)}`);
      it = await getItem(tok, cur, "id,folder");
    }
    parent = cur; id = it.id;
  }
  return id;
}
async function walk(tok, path, rel = "", acc = []) {
  const kids = await listChildren(tok, path);
  for (const k of kids) {
    const childRel = rel ? rel + "/" + k.name : k.name;
    const childPath = path ? path + "/" + k.name : k.name;
    if (k.folder) { acc.push({ path: childRel, type: "folder", children: k.folder.childCount }); await walk(tok, childPath, childRel, acc); }
    else acc.push({ path: childRel, type: "file", size: k.size ?? 0, modified: (k.lastModifiedDateTime || "").slice(0, 19), hash: k.file?.hashes?.quickXorHash || null });
  }
  return acc;
}
function dupeGroups(files) {
  const byHash = {};
  for (const f of files) { if (f.type !== "file" || !f.hash) continue; (byHash[f.hash] ||= []).push(f); }
  return Object.values(byHash).filter((g) => g.length > 1);
}

const args = process.argv.slice(2);
const [cmd, a1, a2, a3] = args;
try {
  const tok = await accessToken();

  if (cmd === "inbox" || cmd === "outgoing-list") {
    const items = await listChildren(tok, OUTGOING);
    console.log(`CFO Outgoing (Matt -> CFO): ${items.length} item(s)`);
    for (const f of items) console.log(`  ${((f.size ?? "") + "").padStart(10)}  ${(f.lastModifiedDateTime || "").slice(0, 10)}  ${f.name}${f.folder ? "/" : ""}`);

  } else if (cmd === "incoming-list") {
    const items = await listChildren(tok, INCOMING); console.log(`CFO Incoming (CFO -> Matt): ${items.length}`); for (const f of items) console.log(`  ${f.name}${f.folder ? "/" : ""}`);

  } else if (cmd === "processed-list") {
    const items = await listChildren(tok, PROCESSED); console.log(`CFO Processed (archive): ${items.length}`); for (const f of items) console.log(`  ${f.name}${f.folder ? "/" : ""}`);

  } else if (cmd === "ls") {
    const path = a1 || "";
    const items = await listChildren(tok, path);
    console.log(`${path || "(root)"}: ${items.length} item(s)`);
    for (const f of items) console.log(`  ${f.folder ? "d" : "-"} ${((f.size ?? "") + "").padStart(10)}  ${(f.lastModifiedDateTime || "").slice(0, 10)}  ${f.name}${f.folder ? "/" : ""}`);

  } else if (cmd === "tree") {
    const rows = await walk(tok, a1 || "");
    for (const r of rows) console.log(`  ${r.type === "folder" ? "[D]" : "   "} ${r.path}${r.type === "file" ? `  (${r.size}b)` : "/"}`);
    console.log(`total: ${rows.filter((r) => r.type === "file").length} files, ${rows.filter((r) => r.type === "folder").length} folders`);

  } else if (cmd === "stat") {
    if (!a1) { console.error("usage: stat <path>"); process.exit(2); }
    const it = await getItem(tok, a1);
    if (!it) { console.error(`not found: ${a1}`); process.exit(1); }
    console.log(JSON.stringify({ name: it.name, id: it.id, size: it.size, folder: !!it.folder, modified: it.lastModifiedDateTime, quickXorHash: it.file?.hashes?.quickXorHash || null }, null, 2));

  } else if (cmd === "mkdir") {
    if (!a1) { console.error("usage: mkdir <path>"); process.exit(2); }
    const id = await ensureFolder(tok, a1);
    console.log(`mkdir -p "${a1}" (id ${id})`);

  } else if (cmd === "mv") {
    if (!a1 || !a2) { console.error("usage: mv <srcPath> <destFolder> [newName]"); process.exit(2); }
    const src = await getItem(tok, a1, "id,name");
    if (!src) { console.error(`source not found: ${a1}`); process.exit(1); }
    const destId = await ensureFolder(tok, a2);
    const body = { parentReference: { id: destId } }; if (a3) body.name = a3;
    const r = await gx(tok, "PATCH", `/me/drive/items/${src.id}`, { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) { console.error(`mv ${r.status}: ${(await r.text()).slice(0, 200)}`); process.exit(1); }
    console.log(`moved "${a1}" -> "${a2}/${a3 || src.name}"`);

  } else if (cmd === "cp") {
    if (!a1 || !a2) { console.error("usage: cp <srcPath> <destFolder> [newName]"); process.exit(2); }
    const src = await getItem(tok, a1, "id,name");
    if (!src) { console.error(`source not found: ${a1}`); process.exit(1); }
    const destId = await ensureFolder(tok, a2);
    const body = { parentReference: { id: destId } }; if (a3) body.name = a3;
    const r = await gx(tok, "POST", `/me/drive/items/${src.id}/copy`, { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (r.status !== 202 && !r.ok) { console.error(`cp ${r.status}: ${(await r.text()).slice(0, 200)}`); process.exit(1); }
    const monitor = r.headers.get("location");
    let status = "accepted";
    for (let i = 0; monitor && i < 15; i++) {
      await new Promise((res) => setTimeout(res, 1000));
      const m = await fetch(monitor); const mj = await m.json().catch(() => ({}));
      status = mj.status || status;
      if (status === "completed" || status === "failed") break;
    }
    console.log(`copied "${a1}" -> "${a2}/${a3 || src.name}" (${status})`);

  } else if (cmd === "rm") {
    if (!a1) { console.error("usage: rm <path>"); process.exit(2); }
    const it = await getItem(tok, a1, "id,name");
    if (!it) { console.error(`not found: ${a1}`); process.exit(1); }
    const r = await gx(tok, "DELETE", `/me/drive/items/${it.id}`);
    if (!r.ok) { console.error(`rm ${r.status}: ${(await r.text()).slice(0, 160)}`); process.exit(1); }
    console.log(`deleted "${a1}" (-> OneDrive recycle bin, recoverable)`);

  } else if (cmd === "upload") {
    if (!a1 || !a2) { console.error("usage: upload <localFile> <destPath>"); process.exit(2); }
    const data = readFileSync(a1);
    const slash = a2.lastIndexOf("/");
    if (slash > 0) await ensureFolder(tok, a2.slice(0, slash));
    const r = await gx(tok, "PUT", `${itemRef(a2)}:/content`, { headers: { "Content-Type": "application/octet-stream" }, body: data });
    if (!r.ok) { console.error(`upload ${r.status}: ${(await r.text()).slice(0, 200)}`); process.exit(1); }
    console.log(`uploaded "${a2}" (${data.length} bytes)`);

  } else if (cmd === "download" || cmd === "pull") {
    // pull = legacy: source is CFO Outgoing/<name>. download = arbitrary path.
    if (!a1) { console.error(`usage: ${cmd} <path> [dir]`); process.exit(2); }
    const path = cmd === "pull" ? `${OUTGOING}/${a1}` : a1;
    const dir = a2 || "."; mkdirSync(dir, { recursive: true });
    const r = await gx(tok, "GET", `${itemRef(path)}:/content`);
    if (!r.ok) { console.error(`${cmd} ${r.status}: ${(await r.text()).slice(0, 160)}`); process.exit(1); }
    const out = `${dir}/${basename(a1)}`; writeFileSync(out, Buffer.from(await r.arrayBuffer())); console.log("saved -> " + out);

  } else if (cmd === "deliver") {
    if (!a1) { console.error("usage: deliver <localFile> [destName]"); process.exit(2); }
    const name = a2 || basename(a1); const data = readFileSync(a1);
    const r = await gx(tok, "PUT", `${itemRef(INCOMING + "/" + name)}:/content`, { headers: { "Content-Type": "application/octet-stream" }, body: data });
    if (!r.ok) { console.error(`deliver ${r.status}: ${(await r.text()).slice(0, 160)}`); process.exit(1); }
    console.log(`delivered "${name}" -> CFO Incoming (${data.length} bytes)`);

  } else if (cmd === "process") {
    if (!a1) { console.error("usage: process <name>"); process.exit(2); }
    const src = await getItem(tok, `${OUTGOING}/${a1}`, "id");
    if (!src) { console.error(`"${a1}" not found in CFO Outgoing`); process.exit(1); }
    const destId = await ensureFolder(tok, PROCESSED);
    const r = await gx(tok, "PATCH", `/me/drive/items/${src.id}`, { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ parentReference: { id: destId } }) });
    if (!r.ok) { console.error(`process ${r.status}: ${(await r.text()).slice(0, 160)}`); process.exit(1); }
    console.log(`processed: moved "${a1}" CFO Outgoing -> CFO Processed`);

  } else if (cmd === "catalog") {
    const path = a1 || PROCESSED;
    const out = a2 || "cfo-onedrive-catalog.json";
    const rows = await walk(tok, path);
    const files = rows.filter((r) => r.type === "file");
    const dupes = dupeGroups(files);
    writeFileSync(out, JSON.stringify({ root: path, generatedAt: new Date().toISOString(), counts: { files: files.length, folders: rows.length - files.length, totalBytes: files.reduce((s, f) => s + f.size, 0), duplicateGroups: dupes.length }, items: rows, duplicates: dupes }, null, 2));
    console.log(`catalog of "${path}": ${files.length} files, ${rows.length - files.length} folders, ${dupes.length} duplicate group(s) -> ${out}`);

  } else if (cmd === "find-dupes") {
    const rows = await walk(tok, a1 || PROCESSED);
    const dupes = dupeGroups(rows.filter((r) => r.type === "file"));
    console.log(`${dupes.length} duplicate group(s) by content hash:`);
    for (const g of dupes) { console.log(`  [${g.length}x ${g[0].size}b]`); for (const f of g) console.log(`     ${f.path}`); }

  } else if (cmd === "dataroom-init") {
    const parent = a1 || `${PROCESSED}/Audit Data Room`;
    const companies = ["OTCHealth", "InnerScope (INND)", "Hearing Assist", "Matthew Moore Personal"];
    await ensureFolder(tok, `${parent}/_Duplicates`);
    for (const c of companies) await ensureFolder(tok, `${parent}/${c}`);
    console.log(`data room scaffolded under "${parent}":`);
    console.log(`  _Duplicates/ + per-company folders: ${companies.join(", ")}`);
    console.log(`  (add category subfolders per company with: mkdir "${parent}/OTCHealth/Bank Statements")`);

  } else {
    console.error("commands: inbox | incoming-list | processed-list | pull <name> [dir] | process <name> | deliver <file> [name]\n          ls [path] | tree [path] | stat <path> | mkdir <path> | mv <src> <dest> [name] | cp <src> <dest> [name] | rm <path>\n          upload <file> <destPath> | download <path> [dir] | catalog [path] [out] | find-dupes [path] | dataroom-init [parent]");
    process.exit(2);
  }
} catch (e) { console.error("ERROR: " + e.message); process.exit(1); }
