#!/usr/bin/env node
// gmail.mjs — the CLO's Gmail retrieval skill. Search Matt's PERSONAL Gmail
// (Mattrmoore85@gmail.com), pull full messages, and DOWNLOAD ATTACHMENTS + the raw .eml,
// so documents that exist only as a Gmail attachment (never saved to OneDrive) are reachable.
//
// The Gmail MCP can search/read but cannot download attachment bytes; this skill can.
//
// Auth: Google OAuth (read-only, gmail.readonly). Reads from env or Secret Manager via the
// claude-driver SA (GCP_CLAUDE_DRIVER_SA_JSON):
//   gmail-oauth-client-id      -> GMAIL_OAUTH_CLIENT_ID      (a Google "Desktop app" OAuth client)
//   gmail-oauth-client-secret  -> GMAIL_OAUTH_CLIENT_SECRET
//   gmail-refresh-token[-<user>] -> GMAIL_REFRESH_TOKEN      (minted once via `consent`)
//
// CONFIDENTIAL: this is Matt's privileged personal Gmail (divorce/custody/criminal/civil).
// Route exports into the legal store `personal` container or the CLO OneDrive folders only.
// Never co-mingle with company records; never commit contents to git.
//
// Usage:
//   node gmail.mjs consent                                  # one-time: authorize + store the refresh token
//   node gmail.mjs search "<gmail query>" [--max 50]        # list matching messages (id | date | from | subject)
//   node gmail.mjs get <messageId>                          # headers + body snippet + attachment list
//   node gmail.mjs export <messageId> <dir>                 # save <dir>/<id>.eml (full RFC822) + extract attachments
//   node gmail.mjs pull "<gmail query>" <dir> [--max 200]   # export every matching message into <dir>
//   [--user <name>]  use gmail-refresh-token-<name> (default account otherwise)

import crypto from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";

const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const pos = argv.filter((a, i, arr) => !a.startsWith("--") && !(arr[i - 1] || "").startsWith("--"));
const cmd = pos[0];
const USER = flag("user");
const REFRESH_ID = USER ? `gmail-refresh-token-${USER}` : "gmail-refresh-token";
const SM = "otchealth-shared-prod";
const SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const REDIRECT = "http://localhost:4747/callback"; // loopback; on remote the page won't load, copy the URL back

// ---- Secret Manager (read + write the refresh token) ----
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
async function smWrite(id, v) {
  const t = await smToken();
  const body = JSON.stringify({ payload: { data: Buffer.from(v, "utf8").toString("base64") } });
  let r = await fetch(`https://secretmanager.googleapis.com/v1/projects/${SM}/secrets/${id}:addVersion`, { method: "POST", headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" }, body });
  if (r.status === 404) { await fetch(`https://secretmanager.googleapis.com/v1/projects/${SM}/secrets?secretId=${id}`, { method: "POST", headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" }, body: JSON.stringify({ replication: { automatic: {} } }) }); r = await fetch(`https://secretmanager.googleapis.com/v1/projects/${SM}/secrets/${id}:addVersion`, { method: "POST", headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" }, body }); }
  if (!r.ok) throw new Error("SM write " + r.status);
}
async function cred(env, id) { return process.env[env] || (await smRead(id)); }

// ---- Google OAuth ----
async function accessToken() {
  const cid = await cred("GMAIL_OAUTH_CLIENT_ID", "gmail-oauth-client-id");
  const cs = await cred("GMAIL_OAUTH_CLIENT_SECRET", "gmail-oauth-client-secret");
  const rt = await cred("GMAIL_REFRESH_TOKEN", REFRESH_ID);
  if (!cid || !cs) { console.error("Missing gmail-oauth-client-id / gmail-oauth-client-secret (create a Google Desktop OAuth client, store both)."); process.exit(2); }
  if (!rt) { console.error(`Missing ${REFRESH_ID}. Run: node gmail.mjs consent  (one-time authorization).`); process.exit(2); }
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: cid, client_secret: cs, refresh_token: rt, grant_type: "refresh_token" }) });
  if (!r.ok) { console.error("token refresh failed " + r.status + ": " + (await r.text()).slice(0, 200)); process.exit(1); }
  return (await r.json()).access_token;
}
async function gapi(tok, path) {
  const r = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, { headers: { Authorization: `Bearer ${tok}` } });
  if (!r.ok) throw new Error(`Gmail ${r.status} ${path}: ${(await r.text()).slice(0, 160)}`);
  return r.json();
}
const hdr = (m, n) => ((m.payload?.headers || []).find((h) => h.name.toLowerCase() === n.toLowerCase()) || {}).value || "";
function walkParts(part, out = []) { if (!part) return out; if (part.filename && part.body?.attachmentId) out.push({ filename: part.filename, attachmentId: part.body.attachmentId, mimeType: part.mimeType, size: part.body.size }); for (const p of part.parts || []) walkParts(p, out); return out; }
const safe = (s) => (s || "").replace(/[^\w.\- ]+/g, "_").slice(0, 80).trim();

async function consent() {
  const cid = await cred("GMAIL_OAUTH_CLIENT_ID", "gmail-oauth-client-id");
  const cs = await cred("GMAIL_OAUTH_CLIENT_SECRET", "gmail-oauth-client-secret");
  if (!cid || !cs) { console.error("Store gmail-oauth-client-id + gmail-oauth-client-secret first (a Google Desktop OAuth client)."); process.exit(2); }
  const code = flag("code") || pos[1];
  if (!code) {
    const url = `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({ client_id: cid, redirect_uri: REDIRECT, response_type: "code", scope: SCOPE, access_type: "offline", prompt: "consent" })}`;
    console.log("1) Open this URL in the browser, signed in as Mattrmoore85@gmail.com, and approve:\n\n" + url + "\n\n2) The browser will redirect to http://localhost:4747/callback?code=... and fail to load (expected on a remote session).\n   Copy the FULL redirected URL (or just the code=... value) and run:\n   node gmail.mjs consent \"<that URL or code>\"");
    return;
  }
  let c = code; try { c = new URL(code).searchParams.get("code") || code; } catch {}
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: cid, client_secret: cs, code: c, grant_type: "authorization_code", redirect_uri: REDIRECT }) });
  if (!r.ok) { console.error("code exchange failed " + r.status + ": " + (await r.text()).slice(0, 200)); process.exit(1); }
  const j = await r.json();
  if (!j.refresh_token) { console.error("No refresh_token returned (re-run consent; the URL uses prompt=consent + access_type=offline)."); process.exit(1); }
  await smWrite(REFRESH_ID, j.refresh_token);
  console.log(`stored ${REFRESH_ID} in Secret Manager. Gmail retrieval is ready.`);
}

try {
  if (cmd === "consent") { await consent(); process.exit(0); }
  const tok = await accessToken();

  if (cmd === "search") {
    const q = pos[1]; if (!q) { console.error('usage: search "<gmail query>" [--max 50]'); process.exit(2); }
    const max = parseInt(flag("max") || "50", 10);
    let ids = [], pageToken;
    while (ids.length < max) {
      const j = await gapi(tok, `messages?q=${encodeURIComponent(q)}&maxResults=${Math.min(100, max - ids.length)}${pageToken ? `&pageToken=${pageToken}` : ""}`);
      ids.push(...(j.messages || [])); pageToken = j.nextPageToken; if (!pageToken || !(j.messages || []).length) break;
    }
    console.log(`${ids.length} message(s) for "${q}":`);
    for (const { id } of ids.slice(0, max)) { const m = await gapi(tok, `messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`); const atts = walkParts(m.payload).length; console.log(`  ${id} | ${hdr(m, "Date").slice(0, 16)} | ${hdr(m, "From").slice(0, 40)} | ${hdr(m, "Subject").slice(0, 60)}${atts ? ` | [${atts} attachment(s)]` : ""}`); }

  } else if (cmd === "get") {
    const id = pos[1]; if (!id) { console.error("usage: get <messageId>"); process.exit(2); }
    const m = await gapi(tok, `messages/${id}?format=full`);
    console.log(`From: ${hdr(m, "From")}\nTo: ${hdr(m, "To")}\nDate: ${hdr(m, "Date")}\nSubject: ${hdr(m, "Subject")}\n`);
    console.log("Snippet:", (m.snippet || "").slice(0, 400));
    const atts = walkParts(m.payload); if (atts.length) { console.log(`\nAttachments (${atts.length}):`); for (const a of atts) console.log(`  ${a.filename} (${a.mimeType}, ${a.size}b)`); }

  } else if (cmd === "export") {
    const id = pos[1], dir = pos[2]; if (!id || !dir) { console.error("usage: export <messageId> <dir>"); process.exit(2); }
    mkdirSync(dir, { recursive: true });
    const raw = await gapi(tok, `messages/${id}?format=raw`);
    const subj = safe(hdr(await gapi(tok, `messages/${id}?format=metadata&metadataHeaders=Subject`), "Subject")) || id;
    writeFileSync(`${dir}/${id}-${subj}.eml`, Buffer.from(raw.raw, "base64"));
    const full = await gapi(tok, `messages/${id}?format=full`);
    const atts = walkParts(full.payload); let n = 0;
    for (const a of atts) { const ad = await gapi(tok, `messages/${id}/attachments/${a.attachmentId}`); writeFileSync(`${dir}/${id}-${safe(a.filename)}`, Buffer.from(ad.data, "base64")); n++; }
    console.log(`exported ${id}: ${dir}/${id}-${subj}.eml + ${n} attachment(s)`);

  } else if (cmd === "pull") {
    const q = pos[1], dir = pos[2]; if (!q || !dir) { console.error('usage: pull "<gmail query>" <dir> [--max 200]'); process.exit(2); }
    const max = parseInt(flag("max") || "200", 10);
    mkdirSync(dir, { recursive: true });
    let ids = [], pageToken;
    while (ids.length < max) { const j = await gapi(tok, `messages?q=${encodeURIComponent(q)}&maxResults=${Math.min(100, max - ids.length)}${pageToken ? `&pageToken=${pageToken}` : ""}`); ids.push(...(j.messages || [])); pageToken = j.nextPageToken; if (!pageToken || !(j.messages || []).length) break; }
    console.log(`pulling ${Math.min(ids.length, max)} message(s) for "${q}" -> ${dir}`);
    let docs = 0, files = 0;
    for (const { id } of ids.slice(0, max)) {
      const raw = await gapi(tok, `messages/${id}?format=raw`); const full = await gapi(tok, `messages/${id}?format=full`);
      const subj = safe(hdr(full, "Subject")) || id;
      writeFileSync(`${dir}/${id}-${subj}.eml`, Buffer.from(raw.raw, "base64")); docs++;
      for (const a of walkParts(full.payload)) { const ad = await gapi(tok, `messages/${id}/attachments/${a.attachmentId}`); writeFileSync(`${dir}/${id}-${safe(a.filename)}`, Buffer.from(ad.data, "base64")); files++; }
    }
    console.log(`done: ${docs} emails (.eml) + ${files} attachment(s) in ${dir}`);

  } else {
    console.error('commands: consent | search "<q>" [--max] | get <id> | export <id> <dir> | pull "<q>" <dir> [--max]');
    process.exit(2);
  }
} catch (e) { console.error("ERROR: " + e.message); process.exit(1); }
