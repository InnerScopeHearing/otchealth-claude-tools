#!/usr/bin/env node
// cfo-sharepoint.mjs — read SharePoint sites + document libraries (app-only Graph) so the
// CFO can reach finance docs that live on Team sites (FinanceTeam WF-9145 statements, etc.),
// beyond the personal-OneDrive-only scope of the cfo-onedrive skill. READ-ONLY.
//
// Auth: app-only client-credentials (dedicated app "OTCHealth CFO SharePoint Ingestion",
// Sites.Read.All application, admin-consented). Reads from env or Secret Manager via the
// claude-driver SA (GCP_CLAUDE_DRIVER_SA_JSON):
//   graph-sites-client-id      -> GRAPH_SITES_CLIENT_ID
//   graph-sites-client-secret  -> GRAPH_SITES_CLIENT_SECRET
//   graph-mail-tenant-id       -> GRAPH_MAIL_TENANT_ID   (same INND tenant)
//
// App-only SharePoint works (only app-only PERSONAL OneDrive is tenant-blocked). Non-PHI
// ring only: never point this at a MedReview/PHI site. Downloads land locally; the CFO
// routes them into the Azure Blob data room (per the Azure directive, not GCS).
//
// Usage:
//   node cfo-sharepoint.mjs sites [search]                  # list sites (id | name | webUrl)
//   node cfo-sharepoint.mjs drives <siteId>                 # document libraries on a site (driveId | name)
//   node cfo-sharepoint.mjs ls <driveId> [path]             # list a folder in a drive
//   node cfo-sharepoint.mjs tree <driveId> [path]           # recursive listing
//   node cfo-sharepoint.mjs pull <driveId> <path> <localDir># download a folder (recursive) or a file
//   node cfo-sharepoint.mjs whoami                          # verify the app-only token + permission

import crypto from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";

const GRAPH = "https://graph.microsoft.com/v1.0";
const SM = "otchealth-shared-prod";
const argv = process.argv.slice(2);
const cmd = argv[0];
const pos = argv.slice(1).filter((a) => !a.startsWith("--"));

async function smToken() {
  const sa = JSON.parse(process.env.GCP_CLAUDE_DRIVER_SA_JSON);
  const now = Math.floor(Date.now() / 1000);
  const e = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const i = `${e({ alg: "RS256", typ: "JWT" })}.${e({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/cloud-platform", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 })}`;
  const s = crypto.createSign("RSA-SHA256").update(i).sign(sa.private_key, "base64url");
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${encodeURIComponent(i + "." + s)}` });
  if (!r.ok) throw new Error("SM auth " + r.status);
  return (await r.json()).access_token;
}
async function smRead(id) {
  if (!process.env.GCP_CLAUDE_DRIVER_SA_JSON) return null;
  try { const t = await smToken(); const r = await fetch(`https://secretmanager.googleapis.com/v1/projects/${SM}/secrets/${id}/versions/latest:access`, { headers: { Authorization: `Bearer ${t}` } }); if (!r.ok) return null; return Buffer.from((await r.json()).payload.data, "base64").toString("utf8").trim(); } catch { return null; }
}
async function cred(env, id) { return process.env[env] || (await smRead(id)); }

async function token() {
  const cid = await cred("GRAPH_SITES_CLIENT_ID", "graph-sites-client-id");
  const cs = await cred("GRAPH_SITES_CLIENT_SECRET", "graph-sites-client-secret");
  const tenant = await cred("GRAPH_MAIL_TENANT_ID", "graph-mail-tenant-id");
  if (!cid || !cs || !tenant) { console.error("Missing graph-sites-client-id / graph-sites-client-secret / graph-mail-tenant-id."); process.exit(2); }
  const r = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: cid, client_secret: cs, scope: "https://graph.microsoft.com/.default", grant_type: "client_credentials" }) });
  if (!r.ok) { console.error("token mint failed " + r.status + ": " + (await r.text()).slice(0, 200)); process.exit(1); }
  return (await r.json()).access_token;
}
async function g(tok, path) {
  const r = await fetch(path.startsWith("http") ? path : GRAPH + path, { headers: { Authorization: `Bearer ${tok}` } });
  if (!r.ok) throw new Error(`Graph ${r.status} ${path}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}
const enc = (p) => (p || "").split("/").filter(Boolean).map(encodeURIComponent).join("/");
const childrenUrl = (driveId, path) => path ? `/drives/${driveId}/root:/${enc(path)}:/children` : `/drives/${driveId}/root/children`;

async function walk(tok, driveId, path, acc = []) {
  const j = await g(tok, childrenUrl(driveId, path));
  for (const it of j.value || []) {
    const rel = path ? `${path}/${it.name}` : it.name;
    if (it.folder) { acc.push({ type: "d", path: rel }); await walk(tok, driveId, rel, acc); }
    else acc.push({ type: "f", path: rel, size: it.size, id: it.id, url: it["@microsoft.graph.downloadUrl"] });
  }
  return acc;
}

try {
  const tok = await token();
  if (cmd === "whoami") {
    const j = await g(tok, "/sites?search=*&$top=1");
    console.log("app-only token OK; SharePoint read works. sample site:", (j.value && j.value[0]) ? j.value[0].webUrl : "(none returned)");

  } else if (cmd === "sites") {
    const q = pos[0] || "*";
    const j = await g(tok, `/sites?search=${encodeURIComponent(q)}`);
    console.log(`${(j.value || []).length} site(s):`);
    for (const s of j.value || []) console.log(`  ${s.id}\n     ${s.displayName || s.name} | ${s.webUrl}`);

  } else if (cmd === "drives") {
    const siteId = pos[0]; if (!siteId) { console.error("usage: drives <siteId>"); process.exit(2); }
    const j = await g(tok, `/sites/${siteId}/drives`);
    for (const d of j.value || []) console.log(`  ${d.id} | ${d.name} | ${d.webUrl}`);

  } else if (cmd === "ls") {
    const driveId = pos[0], path = pos[1]; if (!driveId) { console.error("usage: ls <driveId> [path]"); process.exit(2); }
    const j = await g(tok, childrenUrl(driveId, path));
    for (const it of j.value || []) console.log(`  ${it.folder ? "[D]" : "   "} ${it.name}${it.folder ? "/" : `  (${it.size}b)`}`);

  } else if (cmd === "tree") {
    const driveId = pos[0], path = pos[1]; if (!driveId) { console.error("usage: tree <driveId> [path]"); process.exit(2); }
    const rows = await walk(tok, driveId, path || "");
    for (const r of rows) console.log(`  ${r.type === "d" ? "[D]" : "   "} ${r.path}${r.type === "f" ? `  (${r.size}b)` : "/"}`);
    console.log(`total: ${rows.filter((r) => r.type === "f").length} files, ${rows.filter((r) => r.type === "d").length} folders`);

  } else if (cmd === "pull") {
    const driveId = pos[0], path = pos[1], dir = pos[2]; if (!driveId || !path || !dir) { console.error("usage: pull <driveId> <path> <localDir>"); process.exit(2); }
    mkdirSync(dir, { recursive: true });
    // single file or folder?
    let isFile = false, meta;
    try { meta = await g(tok, `/drives/${driveId}/root:/${enc(path)}`); isFile = !meta.folder; } catch {}
    const files = isFile ? [{ path, id: meta.id, url: meta["@microsoft.graph.downloadUrl"], size: meta.size }] : (await walk(tok, driveId, path)).filter((r) => r.type === "f");
    let n = 0;
    for (const f of files) {
      const url = f.url || (await g(tok, `/drives/${driveId}/items/${f.id}`))["@microsoft.graph.downloadUrl"];
      const r = await fetch(url); if (!r.ok) { console.error(`  skip ${f.path}: ${r.status}`); continue; }
      const buf = Buffer.from(await r.arrayBuffer());
      const out = `${dir}/${f.path.replace(/[\/]/g, "__")}`;
      writeFileSync(out, buf); n++;
      if (n % 25 === 0) console.error(`  ...${n} files`);
    }
    console.log(`pulled ${n} file(s) from drive ${driveId.slice(0, 12)}... path "${path}" -> ${dir}`);

  } else {
    console.error('commands: sites [q] | drives <siteId> | ls <driveId> [path] | tree <driveId> [path] | pull <driveId> <path> <dir> | whoami');
    process.exit(2);
  }
} catch (e) { console.error("ERROR: " + e.message); process.exit(1); }
