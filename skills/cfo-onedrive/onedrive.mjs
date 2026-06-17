#!/usr/bin/env node
// CFO <-> Matt OneDrive file exchange (DELEGATED, acts as matthew@innd.com on his OneDrive).
// Folders at the root of Matt's OneDrive:
//   CFO Outgoing  = Matt drops files here FOR the CFO to review/process
//   CFO Processed = CFO MOVES items here after processing (her owned, organized archive)
//   CFO Incoming  = CFO delivers work product here FOR Matt
//
// Why delegated: the tenant blocks app-only OneDrive access (503). This skill uses a delegated
// refresh token (graph-onedrive-refresh-token) so it acts AS Matt, scoped to Files.ReadWrite.
// The refresh token rotates on use and is auto-persisted back to Secret Manager.
//
// Creds (hydrated): GRAPH_MAIL_CLIENT_ID / GRAPH_MAIL_CLIENT_SECRET / GRAPH_MAIL_TENANT_ID (the app),
// GCP_CLAUDE_DRIVER_SA_JSON (reads/writes graph-onedrive-refresh-token in Secret Manager).
//
// Usage:
//   node onedrive.mjs inbox                       # list CFO Outgoing (what Matt left for you)
//   node onedrive.mjs pull <name> [localDir]      # download a file from CFO Outgoing
//   node onedrive.mjs process <name>              # MOVE a file CFO Outgoing -> CFO Processed
//   node onedrive.mjs deliver <localFile> [name]  # upload work product to CFO Incoming
//   node onedrive.mjs incoming-list | processed-list
import crypto from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { basename } from "node:path";

const SM = "otchealth-shared-prod";
const GRAPH = "https://graph.microsoft.com/v1.0";
const OUTGOING = process.env.CFO_OUTGOING_FOLDER || "CFO Outgoing";
const INCOMING = process.env.CFO_INCOMING_FOLDER || "CFO Incoming";
const PROCESSED = process.env.CFO_PROCESSED_FOLDER || "CFO Processed";
function need(n) { const v = process.env[n]; if (!v) { console.error("Missing env " + n); process.exit(2); } return v; }
function encPath(p) { return p.split("/").map(encodeURIComponent).join("/"); }

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
async function listFolder(tok, folder) {
  const r = await gx(tok, "GET", `/me/drive/root:/${encPath(folder)}:/children?$select=name,id,size,lastModifiedDateTime,folder&$top=500`);
  if (!r.ok) throw new Error(`list "${folder}" ${r.status}: ${(await r.text()).slice(0, 160)}`);
  return (await r.json()).value || [];
}

const [cmd, a1, a2] = process.argv.slice(2);
try {
  const tok = await accessToken();
  if (cmd === "inbox" || cmd === "outgoing-list") {
    const items = await listFolder(tok, OUTGOING);
    console.log(`CFO Outgoing (Matt -> CFO): ${items.length} item(s)`);
    for (const f of items) console.log(`  ${((f.size ?? "") + "").padStart(9)}  ${(f.lastModifiedDateTime || "").slice(0, 10)}  ${f.name}${f.folder ? "/" : ""}`);
  } else if (cmd === "incoming-list") {
    const items = await listFolder(tok, INCOMING); console.log(`CFO Incoming (CFO -> Matt): ${items.length}`); for (const f of items) console.log(`  ${f.name}`);
  } else if (cmd === "processed-list") {
    const items = await listFolder(tok, PROCESSED); console.log(`CFO Processed (archive): ${items.length}`); for (const f of items) console.log(`  ${f.name}`);
  } else if (cmd === "pull") {
    if (!a1) { console.error("usage: onedrive.mjs pull <name> [localDir]"); process.exit(2); }
    const dir = a2 || "."; mkdirSync(dir, { recursive: true });
    const r = await gx(tok, "GET", `/me/drive/root:/${encPath(OUTGOING + "/" + a1)}:/content`);
    if (!r.ok) { console.error(`pull ${r.status}: ${(await r.text()).slice(0, 160)}`); process.exit(1); }
    const out = `${dir}/${basename(a1)}`; writeFileSync(out, Buffer.from(await r.arrayBuffer())); console.log("pulled -> " + out);
  } else if (cmd === "deliver") {
    if (!a1) { console.error("usage: onedrive.mjs deliver <localFile> [destName]"); process.exit(2); }
    const name = a2 || basename(a1); const data = readFileSync(a1);
    const r = await gx(tok, "PUT", `/me/drive/root:/${encPath(INCOMING + "/" + name)}:/content`, { headers: { "Content-Type": "application/octet-stream" }, body: data });
    if (!r.ok) { console.error(`deliver ${r.status}: ${(await r.text()).slice(0, 160)}`); process.exit(1); }
    console.log(`delivered "${name}" -> CFO Incoming (${data.length} bytes)`);
  } else if (cmd === "process") {
    if (!a1) { console.error("usage: onedrive.mjs process <name>"); process.exit(2); }
    const it = await gx(tok, "GET", `/me/drive/root:/${encPath(OUTGOING + "/" + a1)}?$select=id`);
    if (!it.ok) { console.error(`find "${a1}" in CFO Outgoing: ${it.status}`); process.exit(1); }
    const itemId = (await it.json()).id;
    const pf = await gx(tok, "GET", `/me/drive/root:/${encPath(PROCESSED)}?$select=id`);
    const procId = (await pf.json()).id;
    const mv = await gx(tok, "PATCH", `/me/drive/items/${itemId}`, { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ parentReference: { id: procId } }) });
    if (!mv.ok) { console.error(`move ${mv.status}: ${(await mv.text()).slice(0, 160)}`); process.exit(1); }
    console.log(`processed: moved "${a1}" from CFO Outgoing -> CFO Processed`);
  } else {
    console.error("commands: inbox | incoming-list | processed-list | pull <name> [dir] | deliver <file> [name] | process <name>");
    process.exit(2);
  }
} catch (e) { console.error("ERROR: " + e.message); process.exit(1); }
