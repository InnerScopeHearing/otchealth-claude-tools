#!/usr/bin/env node
// migrate-cfo-room.mjs — one-time bulk migration of the CFO data room from GCS to Azure Blob.
// Source: gs://otchealth-cfo-source-docs   Dest: otchealthcfodata / cfo-source-docs (Azure).
// Resumable + concurrent: skips objects already in Azure with a matching size, so re-runs only
// copy the delta. Reads source via the claude-driver SA (GCS read-only); reads the Azure key from
// Secret Manager (azure-cfo-storage-key). Internal store-to-store move of the company's own data.
//
// Usage: node setup/migrate-cfo-room.mjs [--concurrency 16] [--dry-run]
import crypto from "node:crypto";
import { extname } from "node:path";

const SM = "otchealth-shared-prod";
const GBUCKET = process.env.CFO_SOURCE_BUCKET || "otchealth-cfo-source-docs";
const AVER = "2021-12-02";
const args = process.argv.slice(2);
const CONC = parseInt((args[args.indexOf("--concurrency") + 1]) || "16", 10) || 16;
const DRY = args.includes("--dry-run");
const CT = { ".pdf": "application/pdf", ".csv": "text/csv", ".json": "application/json", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".xls": "application/vnd.ms-excel", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".txt": "text/plain", ".zip": "application/zip", ".html": "text/html" };
const ctOf = (n) => CT[extname(n).toLowerCase()] || "application/octet-stream";
const enc = (p) => p.split("/").map(encodeURIComponent).join("/");

// ---- GCS auth (claude-driver SA, read-only) ----
function saJwt(scope) {
  const sa = JSON.parse(process.env.GCP_CLAUDE_DRIVER_SA_JSON);
  const now = Math.floor(Date.now() / 1000);
  const e = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const i = `${e({ alg: "RS256", typ: "JWT" })}.${e({ iss: sa.client_email, scope, aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 })}`;
  const s = crypto.createSign("RSA-SHA256").update(i).sign(sa.private_key, "base64url");
  return i + "." + s;
}
let _g = null, _gAt = 0;
async function gTok(scope) { const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${encodeURIComponent(saJwt(scope))}` }); return (await r.json()).access_token; }
async function gcsAuth() { if (!_g || Date.now() - _gAt > 50 * 60 * 1000) { _g = await gTok("https://www.googleapis.com/auth/devstorage.read_only"); _gAt = Date.now(); } return _g; }
async function sm(id) { const t = await gTok("https://www.googleapis.com/auth/cloud-platform"); const r = await fetch(`https://secretmanager.googleapis.com/v1/projects/${SM}/secrets/${id}/versions/latest:access`, { headers: { Authorization: `Bearer ${t}` } }); if (!r.ok) return null; return Buffer.from((await r.json()).payload.data, "base64").toString("utf8").trim(); }

// ---- Azure dest ----
let ACCT, AKEY, CONTAINER, SAS;
// Account SAS: signature is over the SAS fields, not the blob path -> special-char blob names
// (+, spaces, parens, &) work where per-request SharedKey canonicalization fails.
function buildSas() {
  const sv = "2021-12-02", sp = "rwlc", ss = "b", srt = "co";
  const st = new Date(Date.now() - 5 * 60000).toISOString().slice(0, 19) + "Z";
  const se = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 19) + "Z";
  const sts = [ACCT, sp, ss, srt, st, se, "", "https", sv, ""].join("\n") + "\n";
  const sig = crypto.createHmac("sha256", Buffer.from(AKEY, "base64")).update(sts, "utf8").digest("base64");
  return new URLSearchParams({ sv, ss, srt, sp, st, se, spr: "https", sig }).toString();
}
async function azEnsureContainer() { const r = await fetch(`https://${ACCT}.blob.core.windows.net/${CONTAINER}?restype=container&${SAS}`, { method: "PUT" }); if (!(r.ok || r.status === 409)) throw new Error("ensure container " + r.status + " " + (await r.text()).slice(0, 120)); }
async function azList() {
  const map = new Map(); let marker = "";
  do {
    let url = `https://${ACCT}.blob.core.windows.net/${CONTAINER}?restype=container&comp=list&${SAS}`; if (marker) url += `&marker=${encodeURIComponent(marker)}`;
    const r = await fetch(url);
    if (r.status === 404) return map; if (!r.ok) throw new Error("az list " + r.status + " " + (await r.text()).slice(0, 120));
    const xml = await r.text();
    for (const m of xml.matchAll(/<Blob>([\s\S]*?)<\/Blob>/g)) { const name = (m[1].match(/<Name>([^<]+)<\/Name>/) || [])[1]; const size = +((m[1].match(/<Content-Length>([^<]+)<\/Content-Length>/) || [])[1] || -1); if (name) map.set(name, size); }
    marker = (xml.match(/<NextMarker>([^<]+)<\/NextMarker>/) || [])[1] || "";
  } while (marker);
  return map;
}
async function azPut(name, buf, ct) {
  const r = await fetch(`https://${ACCT}.blob.core.windows.net/${CONTAINER}/${enc(name)}?${SAS}`, { method: "PUT", headers: { "x-ms-blob-type": "BlockBlob", "Content-Type": ct }, body: buf });
  if (!r.ok) throw new Error("put " + r.status + " " + (await r.text()).slice(0, 120));
}
async function gcsGet(name) { const r = await fetch(`https://storage.googleapis.com/storage/v1/b/${GBUCKET}/o/${encodeURIComponent(name)}?alt=media`, { headers: { Authorization: `Bearer ${await gcsAuth()}` } }); if (!r.ok) throw new Error("gcs get " + r.status); return Buffer.from(await r.arrayBuffer()); }
async function gcsList() {
  const out = []; let url = `https://storage.googleapis.com/storage/v1/b/${GBUCKET}/o?fields=items(name,size),nextPageToken&maxResults=1000`;
  while (url) { const r = await fetch(url, { headers: { Authorization: `Bearer ${await gcsAuth()}` } }); if (!r.ok) throw new Error("gcs list " + r.status); const j = await r.json(); for (const o of j.items || []) out.push({ name: o.name, size: +o.size }); url = j.nextPageToken ? `https://storage.googleapis.com/storage/v1/b/${GBUCKET}/o?fields=items(name,size),nextPageToken&maxResults=1000&pageToken=${j.nextPageToken}` : null; }
  return out;
}

// ---- run ----
ACCT = process.env.AZURE_STORAGE_ACCOUNT || (await sm("azure-cfo-storage-account")) || "otchealthcfodata";
CONTAINER = process.env.CFO_AZURE_CONTAINER || "cfo-source-docs";
AKEY = process.env.AZURE_STORAGE_KEY || (await sm("azure-cfo-storage-key"));
if (!AKEY) { console.error("missing azure-cfo-storage-key"); process.exit(2); }
SAS = buildSas();
await azEnsureContainer();
console.error(`[migrate] gs://${GBUCKET}  ->  azure://${ACCT}/${CONTAINER}  (concurrency ${CONC}${DRY ? ", DRY-RUN" : ""})`);
const src = await gcsList();
const dst = await azList();
const todo = src.filter((o) => dst.get(o.name) !== o.size);
const totBytes = todo.reduce((a, o) => a + o.size, 0);
console.error(`[migrate] source ${src.length} objs | already in azure ${dst.size} | to copy ${todo.length} (${(totBytes / 1048576).toFixed(0)} MB)`);
if (DRY) { console.log("dry-run: would copy " + todo.length + " objects"); process.exit(0); }

let done = 0, copied = 0, bytes = 0, fail = 0, idx = 0;
async function worker() {
  while (idx < todo.length) {
    const o = todo[idx++];
    try { const buf = await gcsGet(o.name); await azPut(o.name, buf, ctOf(o.name)); copied++; bytes += buf.length; }
    catch (e) { fail++; if (fail <= 20) console.error("  FAIL " + o.name.slice(-50) + ": " + e.message.slice(0, 80)); }
    if (++done % 500 === 0) console.error(`  ...${done}/${todo.length}  (${(bytes / 1048576).toFixed(0)} MB, ${fail} fail)`);
  }
}
await Promise.all(Array.from({ length: CONC }, worker));
console.log(`[migrate] DONE: copied ${copied}/${todo.length} (${(bytes / 1048576).toFixed(0)} MB), ${fail} failures. Azure now has ${dst.size + copied} objects (re-run to retry failures).`);
