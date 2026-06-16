#!/usr/bin/env node
// CFO source-doc store: durable, access-controlled object storage for financial exports and
// source documents. Private GCS bucket (default otchealth-cfo-source-docs) in
// otchealth-shared-prod, IAM-gated to the claude-driver SA (roles/storage.objectAdmin).
// Dependency-free; auth via the SA (GCP_CLAUDE_DRIVER_SA_JSON), same as the other CFO skills.
//
// WHY: the session sandbox is ephemeral, and raw multi-entity financials (incl. INND, a public
// company => material non-public info, and personal data) must NOT sit in a git repo. This is
// the proper internal, access-controlled home. Internal handling only, never disclosure.
//
// Creds (hydrated): GCP_CLAUDE_DRIVER_SA_JSON; bucket from CFO_SOURCE_BUCKET (cfo-source-bucket).
//
// Usage:
//   node store.mjs put <localFile> <objectName>
//   node store.mjs put-dir <localDir> <objectPrefix>     # recursive upload
//   node store.mjs list [prefix]
//   node store.mjs get <objectName> <localFile>
import crypto from "node:crypto";
import { readdirSync, statSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, relative, dirname } from "node:path";

const BUCKET = process.env.CFO_SOURCE_BUCKET || "otchealth-cfo-source-docs";
function need(n) { const v = process.env[n]; if (!v) { console.error(`Missing env ${n}`); process.exit(2); } return v; }

async function token() {
  const sa = JSON.parse(need("GCP_CLAUDE_DRIVER_SA_JSON"));
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const input = `${enc({ alg: "RS256", typ: "JWT" })}.${enc({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/devstorage.read_write", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 })}`;
  const sig = crypto.createSign("RSA-SHA256").update(input).sign(sa.private_key, "base64url");
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${encodeURIComponent(input + "." + sig)}` });
  if (!r.ok) { console.error("SM auth " + r.status); process.exit(1); }
  return (await r.json()).access_token;
}
async function putObject(tok, name, body, ctype) {
  const r = await fetch(`https://storage.googleapis.com/upload/storage/v1/b/${BUCKET}/o?uploadType=media&name=${encodeURIComponent(name)}`, { method: "POST", headers: { Authorization: `Bearer ${tok}`, "Content-Type": ctype || "application/octet-stream" }, body });
  if (!r.ok) throw new Error(`put ${name} ${r.status}: ${(await r.text()).slice(0, 160)}`);
}
function walk(d) { let o = []; for (const e of readdirSync(d)) { const p = join(d, e); statSync(p).isDirectory() ? (o = o.concat(walk(p))) : o.push(p); } return o; }

const [cmd, a1, a2] = process.argv.slice(2);
const tok = await token();
if (cmd === "put") {
  if (!a1 || !a2) { console.error("usage: store.mjs put <localFile> <objectName>"); process.exit(2); }
  const body = readFileSync(a1);
  await putObject(tok, a2, body);
  console.log(`put gs://${BUCKET}/${a2} (${body.length}b)`);
} else if (cmd === "put-dir") {
  if (!a1) { console.error("usage: store.mjs put-dir <localDir> <objectPrefix>"); process.exit(2); }
  const prefix = a2 || "";
  const files = walk(a1);
  let ok = 0, bytes = 0;
  for (const f of files) {
    const name = (prefix ? prefix.replace(/\/+$/, "") + "/" : "") + relative(a1, f).split(/[\\/]/).join("/");
    const body = readFileSync(f);
    try { await putObject(tok, name, body); ok++; bytes += body.length; console.log(`ok  ${name} (${body.length}b)`); }
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
  mkdirSync(dirname(a2), { recursive: true });
  writeFileSync(a2, Buffer.from(await r.arrayBuffer()));
  console.log(`got gs://${BUCKET}/${a1} -> ${a2}`);
} else {
  console.error("commands: put <file> <obj> | put-dir <dir> <prefix> | list [prefix] | get <obj> <file>");
  process.exit(2);
}
