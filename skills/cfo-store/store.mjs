#!/usr/bin/env node
// CFO source-doc store: durable, access-controlled object storage for financial exports and
// source documents. TWO backends, same put/put-dir/list/get verbs:
//   - gcs   (default, legacy)  : private GCS bucket otchealth-cfo-source-docs, claude-driver SA.
//   - azure (the funded lane)  : Azure Blob account otchealthcfodata (off Google, per the Azure
//                                directive). SharedKey auth, mirrors the legal-store pattern.
// Pick the backend with --azure / --gcs or STORAGE_BACKEND=azure|gcs (default gcs while the
// books are reconstructed on GCS; flip to azure for the migrated data room).
//
// WHY: the session sandbox is ephemeral, and raw multi-entity financials (incl. INND, a public
// company => material non-public info, and personal data) must NOT sit in a git repo. This is
// the proper internal, access-controlled home. Internal handling only, never disclosure.
//
// Creds (hydrated, else self-resolved from Secret Manager via the claude-driver SA):
//   GCS:   GCP_CLAUDE_DRIVER_SA_JSON; bucket from CFO_SOURCE_BUCKET (cfo-source-bucket).
//   Azure: AZURE_STORAGE_ACCOUNT / AZURE_STORAGE_CONTAINER / AZURE_STORAGE_KEY
//          (secrets azure-cfo-storage-account / -container / -key). Account defaults to
//          otchealthcfodata, container defaults to cfo-source-docs (auto-created on first put).
//
// Usage:
//   node store.mjs [--azure|--gcs] put <localFile> <objectName>
//   node store.mjs [--azure|--gcs] put-dir <localDir> <objectPrefix>     # recursive upload
//   node store.mjs [--azure|--gcs] list [prefix]
//   node store.mjs [--azure|--gcs] get <objectName> <localFile>
//   node store.mjs --azure create-container                              # idempotent
import crypto from "node:crypto";
import { readdirSync, statSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, relative, dirname, extname } from "node:path";

const argv = process.argv.slice(2);
function takeVal(name) { const i = argv.indexOf(name); if (i >= 0) { const v = argv[i + 1]; argv.splice(i, 2); return v; } return null; }
const containerOverride = takeVal("--container"); // valued flag: pull it (and its value) out before positional parse
const accountOverride = takeVal("--account");      // override the Azure storage account (e.g. otchealthlegalstore)
const keySecretOverride = takeVal("--key-secret"); // override which SM secret holds the account key
const flags = new Set(argv.filter((a) => a.startsWith("--")));
const pos = argv.filter((a) => !a.startsWith("--"));
const BACKEND = flags.has("--azure") ? "azure" : flags.has("--gcs") ? "gcs" : (process.env.STORAGE_BACKEND || "gcs").toLowerCase();
const [cmd, a1, a2] = pos;

const SM = "otchealth-shared-prod";
const BUCKET = process.env.CFO_SOURCE_BUCKET || "otchealth-cfo-source-docs";
function need(n) { const v = process.env[n]; if (!v) { console.error(`Missing env ${n}`); process.exit(2); } return v; }
function walk(d) { let o = []; for (const e of readdirSync(d)) { const p = join(d, e); statSync(p).isDirectory() ? (o = o.concat(walk(p))) : o.push(p); } return o; }
const CT = { ".pdf": "application/pdf", ".csv": "text/csv", ".json": "application/json", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".xls": "application/vnd.ms-excel", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".txt": "text/plain", ".zip": "application/zip" };
const ctOf = (name) => CT[extname(name).toLowerCase()] || "application/octet-stream";

// ---- shared: claude-driver SA token (scope-parameterized) ----
function saJwt(scope) {
  const sa = JSON.parse(need("GCP_CLAUDE_DRIVER_SA_JSON"));
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const input = `${enc({ alg: "RS256", typ: "JWT" })}.${enc({ iss: sa.client_email, scope, aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 })}`;
  const sig = crypto.createSign("RSA-SHA256").update(input).sign(sa.private_key, "base64url");
  return { input, sig };
}
async function gToken(scope) {
  const { input, sig } = saJwt(scope);
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${encodeURIComponent(input + "." + sig)}` });
  if (!r.ok) { console.error("SA auth " + r.status); process.exit(1); }
  return (await r.json()).access_token;
}
async function smRead(id) {
  try { const t = await gToken("https://www.googleapis.com/auth/cloud-platform"); const r = await fetch(`https://secretmanager.googleapis.com/v1/projects/${SM}/secrets/${id}/versions/latest:access`, { headers: { Authorization: `Bearer ${t}` } }); if (!r.ok) return null; return Buffer.from((await r.json()).payload.data, "base64").toString("utf8").trim(); } catch { return null; }
}

// ============================ GCS backend ============================
async function gcsToken() { return gToken("https://www.googleapis.com/auth/devstorage.read_write"); }
async function gcsPut(tok, name, body, ctype) {
  const r = await fetch(`https://storage.googleapis.com/upload/storage/v1/b/${BUCKET}/o?uploadType=media&name=${encodeURIComponent(name)}`, { method: "POST", headers: { Authorization: `Bearer ${tok}`, "Content-Type": ctype || "application/octet-stream" }, body });
  if (!r.ok) throw new Error(`put ${name} ${r.status}: ${(await r.text()).slice(0, 160)}`);
}
async function runGcs() {
  const tok = await gcsToken();
  if (cmd === "put") {
    if (!a1 || !a2) { console.error("usage: store.mjs put <localFile> <objectName>"); process.exit(2); }
    const body = readFileSync(a1); await gcsPut(tok, a2, body, ctOf(a2));
    console.log(`put gs://${BUCKET}/${a2} (${body.length}b)`);
  } else if (cmd === "put-dir") {
    if (!a1) { console.error("usage: store.mjs put-dir <localDir> <objectPrefix>"); process.exit(2); }
    const prefix = a2 || ""; const files = walk(a1); let ok = 0, bytes = 0;
    for (const f of files) {
      const name = (prefix ? prefix.replace(/\/+$/, "") + "/" : "") + relative(a1, f).split(/[\\/]/).join("/");
      const body = readFileSync(f);
      try { await gcsPut(tok, name, body, ctOf(name)); ok++; bytes += body.length; console.log(`ok  ${name} (${body.length}b)`); }
      catch (e) { console.error(`FAIL ${e.message}`); }
    }
    console.log(`\n${ok}/${files.length} files, ${(bytes / 1048576).toFixed(1)} MB -> gs://${BUCKET}/`);
  } else if (cmd === "list") {
    let url = `https://storage.googleapis.com/storage/v1/b/${BUCKET}/o?maxResults=1000${a1 ? `&prefix=${encodeURIComponent(a1)}` : ""}`, n = 0;
    while (url) {
      const r = await fetch(url, { headers: { Authorization: `Bearer ${tok}` } });
      if (!r.ok) { console.error(`list ${r.status}: ${(await r.text()).slice(0, 160)}`); process.exit(1); }
      const j = await r.json();
      for (const o of j.items || []) { console.log(`${(o.size + "").padStart(10)}  ${o.updated.slice(0, 10)}  ${o.name}`); n++; }
      url = j.nextPageToken ? `https://storage.googleapis.com/storage/v1/b/${BUCKET}/o?maxResults=1000&pageToken=${j.nextPageToken}${a1 ? `&prefix=${encodeURIComponent(a1)}` : ""}` : null;
    }
    console.log(`(${n} objects)`);
  } else if (cmd === "get") {
    if (!a1 || !a2) { console.error("usage: store.mjs get <objectName> <localFile>"); process.exit(2); }
    const r = await fetch(`https://storage.googleapis.com/storage/v1/b/${BUCKET}/o/${encodeURIComponent(a1)}?alt=media`, { headers: { Authorization: `Bearer ${tok}` } });
    if (!r.ok) { console.error(`get ${r.status}: ${(await r.text()).slice(0, 160)}`); process.exit(1); }
    mkdirSync(dirname(a2), { recursive: true }); writeFileSync(a2, Buffer.from(await r.arrayBuffer()));
    console.log(`got gs://${BUCKET}/${a1} -> ${a2}`);
  } else { console.error("commands: put | put-dir | list | get"); process.exit(2); }
}

// ============================ Azure backend ============================
const AVER = "2021-12-02";
let ACCT, AKEY, CONTAINER, SAS;
async function azCred() {
  ACCT = accountOverride || process.env.AZURE_STORAGE_ACCOUNT || (await smRead("azure-cfo-storage-account")) || "otchealthcfodata";
  // Default container is the CFO data room (cfo-source-docs). The CLO legal store uses
  //   --account otchealthlegalstore --key-secret azure-legal-storage-key --container company|personal
  CONTAINER = containerOverride || process.env.CFO_AZURE_CONTAINER || "cfo-source-docs";
  AKEY = (keySecretOverride ? await smRead(keySecretOverride) : null) || process.env.AZURE_STORAGE_KEY || (await smRead("azure-cfo-storage-key"));
  if (!AKEY) { console.error(`Missing storage key for account ${ACCT}, container ${CONTAINER} (secret ${keySecretOverride || "azure-cfo-storage-key"}).`); process.exit(2); }
  SAS = buildAzSas();
}
const encPath = (name) => name.split("/").map(encodeURIComponent).join("/");
// Account SAS: signs the SAS fields, not the blob path, so special-char names (spaces, &, +,
// parens) work where per-request SharedKey canonicalization 403s. Includes delete (rm).
function buildAzSas() {
  const sv = "2021-12-02", sp = "rwdlc", ss = "b", srt = "co";
  const st = new Date(Date.now() - 5 * 60000).toISOString().slice(0, 19) + "Z";
  const se = new Date(Date.now() + 12 * 3600 * 1000).toISOString().slice(0, 19) + "Z";
  const sts = [ACCT, sp, ss, srt, st, se, "", "https", sv, ""].join("\n") + "\n";
  const sig = crypto.createHmac("sha256", Buffer.from(AKEY, "base64")).update(sts, "utf8").digest("base64");
  return new URLSearchParams({ sv, ss, srt, sp, st, se, spr: "https", sig }).toString();
}
async function azCreateContainer() {
  const r = await fetch(`https://${ACCT}.blob.core.windows.net/${CONTAINER}?restype=container&${SAS}`, { method: "PUT" });
  if (r.ok) return "created";
  if (r.status === 409) return "exists";
  throw new Error("container create " + r.status + " " + (await r.text()).slice(0, 160));
}
async function azPut(name, buf, ctype) {
  const ct = ctype || ctOf(name);
  let r = await fetch(`https://${ACCT}.blob.core.windows.net/${CONTAINER}/${encPath(name)}?${SAS}`, { method: "PUT", headers: { "x-ms-blob-type": "BlockBlob", "Content-Type": ct }, body: buf });
  if (r.status === 404) { await azCreateContainer(); return azPut(name, buf, ctype); } // container missing -> create + retry
  if (!r.ok) throw new Error("blob put " + r.status + " " + (await r.text()).slice(0, 160));
}
async function azGet(name) {
  const r = await fetch(`https://${ACCT}.blob.core.windows.net/${CONTAINER}/${encPath(name)}?${SAS}`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error("blob get " + r.status);
  return Buffer.from(await r.arrayBuffer());
}
async function azList(prefix) {
  const out = []; let marker = "";
  do {
    let url = `https://${ACCT}.blob.core.windows.net/${CONTAINER}?restype=container&comp=list&${SAS}`;
    if (prefix) url += `&prefix=${encodeURIComponent(prefix)}`;
    if (marker) url += `&marker=${encodeURIComponent(marker)}`;
    const r = await fetch(url);
    if (r.status === 404) return out;
    if (!r.ok) throw new Error("blob list " + r.status + " " + (await r.text()).slice(0, 160));
    const xml = await r.text();
    for (const m of xml.matchAll(/<Blob>([\s\S]*?)<\/Blob>/g)) {
      const b = m[1];
      const name = (b.match(/<Name>([^<]+)<\/Name>/) || [])[1];
      const size = (b.match(/<Content-Length>([^<]+)<\/Content-Length>/) || [])[1] || "";
      const mod = (b.match(/<Last-Modified>([^<]+)<\/Last-Modified>/) || [])[1] || "";
      if (name) out.push({ name, size, mod });
    }
    marker = (xml.match(/<NextMarker>([^<]+)<\/NextMarker>/) || [])[1] || "";
  } while (marker);
  return out;
}
async function azDelete(name) {
  const r = await fetch(`https://${ACCT}.blob.core.windows.net/${CONTAINER}/${encPath(name)}?${SAS}`, { method: "DELETE" });
  if (r.status === 404) return false;
  if (!r.ok) throw new Error("blob delete " + r.status + " " + (await r.text()).slice(0, 160));
  return true;
}
async function runAzure() {
  await azCred();
  if (cmd === "create-container") {
    console.log(`container ${CONTAINER} on ${ACCT}: ${await azCreateContainer()}`);
  } else if (cmd === "rm") {
    if (!a1) { console.error("usage: store.mjs --azure rm <objectName>"); process.exit(2); }
    console.log((await azDelete(a1)) ? `deleted azure://${ACCT}/${CONTAINER}/${a1}` : `not found ${a1}`);
  } else if (cmd === "put") {
    if (!a1 || !a2) { console.error("usage: store.mjs --azure put <localFile> <objectName>"); process.exit(2); }
    const buf = readFileSync(a1); await azPut(a2, buf);
    console.log(`put azure://${ACCT}/${CONTAINER}/${a2} (${buf.length}b)`);
  } else if (cmd === "put-dir") {
    if (!a1) { console.error("usage: store.mjs --azure put-dir <localDir> <objectPrefix>"); process.exit(2); }
    const prefix = a2 || ""; const files = walk(a1); let ok = 0, bytes = 0;
    await azCreateContainer();
    for (const f of files) {
      const name = (prefix ? prefix.replace(/\/+$/, "") + "/" : "") + relative(a1, f).split(/[\\/]/).join("/");
      const buf = readFileSync(f);
      try { await azPut(name, buf); ok++; bytes += buf.length; if (ok % 25 === 0 || files.length < 25) console.log(`ok  ${name} (${buf.length}b)`); }
      catch (e) { console.error(`FAIL ${name}: ${e.message}`); }
    }
    console.log(`\n${ok}/${files.length} files, ${(bytes / 1048576).toFixed(1)} MB -> azure://${ACCT}/${CONTAINER}/`);
  } else if (cmd === "list") {
    const rows = await azList(a1 || ""); let n = 0;
    for (const o of rows) { console.log(`${(o.size + "").padStart(10)}  ${o.mod ? new Date(o.mod).toISOString().slice(0, 10) : "          "}  ${o.name}`); n++; }
    console.log(`(${n} objects)`);
  } else if (cmd === "get") {
    if (!a1 || !a2) { console.error("usage: store.mjs --azure get <objectName> <localFile>"); process.exit(2); }
    const buf = await azGet(a1);
    if (buf === null) { console.error(`get: not found ${a1}`); process.exit(1); }
    mkdirSync(dirname(a2), { recursive: true }); writeFileSync(a2, buf);
    console.log(`got azure://${ACCT}/${CONTAINER}/${a1} -> ${a2} (${buf.length}b)`);
  } else { console.error("commands: put | put-dir | list | get | rm | create-container"); process.exit(2); }
}

// ---- dispatch ----
try {
  if (BACKEND === "azure") await runAzure();
  else await runGcs();
} catch (e) { console.error("ERROR: " + e.message); process.exit(1); }
