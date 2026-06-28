#!/usr/bin/env node
/**
 * xero-token.mjs — SHARED Xero token broker for the whole fleet (both engines + all Container App Jobs).
 *
 * WHY: Xero refresh tokens are SINGLE-USE (rotate on every refresh). The old skills each did a
 * refresh_token grant on EVERY invocation, so two processes (CFO + CTO + cron) refreshing the same org
 * concurrently => one gets invalid_grant and the org's token DIES (forcing a manual re-consent).
 *
 * FIX: an access-token CACHE (Xero access tokens live ~30 min) + a cross-process refresh LOCK, both in
 * GCS so they are shared across engines and jobs:
 *   - getAccessContext(org) returns a cached access token if one is still valid (NO refresh, NO rotation).
 *   - Only when the cache is stale does ONE process (lock holder) refresh + rotate-persist + re-cache;
 *     everyone else reads the freshly-written cache. Rotations drop from per-call to ~1 per 30 min/org.
 *   - On refresh, /connections is checked: an empty list => the org was DISCONNECTED (a thrown
 *     XERO_DISCONNECTED:<org> that callers/monitor surface) rather than a confusing downstream "no tenant".
 *
 * Fail-open: any error in the cache/lock layer degrades to a direct refresh so posting is never blocked.
 *
 * Library:  import { getAccessContext } from "./xero-token.mjs"  ->  { access_token, tenantId, source }
 * CLI:      node xero-token.mjs check <org>        # one org, prints health, exit!=0 if unhealthy
 *           node xero-token.mjs monitor [orgs...]  # all (or listed) orgs; writes GCS health snapshot + alerts
 */
import crypto from "node:crypto"; import fs from "node:fs"; import os from "node:os";

const SM_PROJECT = "otchealth-shared-prod";
const BUCKET = "otchealth-cfo-source-docs";
const CACHE = (org) => `xero-token-cache/${org}.json`;
const LOCK = (org) => `xero-token-cache/${org}.lock`;
const HEALTH = "xero-token-cache/health.json";
const TOKEN_URL = "https://identity.xero.com/connect/token";
const CONN_URL = "https://api.xero.com/connections";
const ORGS_ALL = ["otchealth", "innd", "hearingassist", "personal"];
const SKEW_MS = 120000;     // treat the access token as stale 2 min before its real expiry
const LOCK_TTL_MS = 60000;  // a lock older than this is considered abandoned and reclaimed
const LOCK_WAIT_MS = 20000; // max time to wait for another process's refresh before forcing our own
const b64url = (b) => Buffer.from(b).toString("base64url");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadSA() {
  if (process.env.GCP_CLAUDE_DRIVER_SA_JSON) { try { return JSON.parse(process.env.GCP_CLAUDE_DRIVER_SA_JSON); } catch {} }
  for (const p of [`${os.homedir()}/.gcp_claude_driver_sa.json`, "/agent/.gcp_claude_driver_sa.json"]) {
    try { if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8")); } catch {}
  }
  throw new Error("no GCP SA (GCP_CLAUDE_DRIVER_SA_JSON or ~/.gcp_claude_driver_sa.json)");
}
let _gt = null;
async function gcp() {
  if (_gt) return _gt;
  const sa = loadSA(); const now = Math.floor(Date.now() / 1000);
  const cl = { iss: sa.client_email, scope: "https://www.googleapis.com/auth/cloud-platform", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3500 };
  const i = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(JSON.stringify(cl))}`;
  const s = crypto.createSign("RSA-SHA256").update(i).sign(sa.private_key);
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${i}.${Buffer.from(s).toString("base64url")}` }) });
  return (_gt = (await r.json()).access_token);
}
async function smRead(id) {
  const r = await fetch(`https://secretmanager.googleapis.com/v1/projects/${SM_PROJECT}/secrets/${id}/versions/latest:access`, { headers: { Authorization: `Bearer ${await gcp()}` } });
  if (!r.ok) return null;
  return Buffer.from((await r.json()).payload.data, "base64").toString("utf8").trim();
}
async function smWrite(id, val) {
  const t = await gcp();
  const e = await fetch(`https://secretmanager.googleapis.com/v1/projects/${SM_PROJECT}/secrets/${id}`, { headers: { Authorization: `Bearer ${t}` } });
  if (e.status === 404) await fetch(`https://secretmanager.googleapis.com/v1/projects/${SM_PROJECT}/secrets?secretId=${id}`, { method: "POST", headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" }, body: JSON.stringify({ replication: { automatic: {} } }) });
  const r = await fetch(`https://secretmanager.googleapis.com/v1/projects/${SM_PROJECT}/secrets/${id}:addVersion`, { method: "POST", headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" }, body: JSON.stringify({ payload: { data: Buffer.from(val, "utf8").toString("base64") } }) });
  return r.status;
}
// ---- GCS cache/lock primitives ----
async function gcsGetJson(name) {
  const r = await fetch(`https://storage.googleapis.com/storage/v1/b/${BUCKET}/o/${encodeURIComponent(name)}?alt=media`, { headers: { Authorization: `Bearer ${await gcp()}` } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error("gcsGet " + r.status);
  try { return JSON.parse(Buffer.from(await r.arrayBuffer()).toString("utf8")); } catch { return null; }
}
async function gcsPutJson(name, obj) {
  const r = await fetch(`https://storage.googleapis.com/upload/storage/v1/b/${BUCKET}/o?uploadType=media&name=${encodeURIComponent(name)}`, { method: "POST", headers: { Authorization: `Bearer ${await gcp()}`, "Content-Type": "application/json" }, body: JSON.stringify(obj) });
  if (!r.ok) throw new Error("gcsPut " + r.status);
}
async function gcsCreateIfAbsent(name, obj) { // returns true if WE created it (lock acquired), false if it already exists
  const r = await fetch(`https://storage.googleapis.com/upload/storage/v1/b/${BUCKET}/o?uploadType=media&name=${encodeURIComponent(name)}&ifGenerationMatch=0`, { method: "POST", headers: { Authorization: `Bearer ${await gcp()}`, "Content-Type": "application/json" }, body: JSON.stringify(obj) });
  if (r.status === 200) return true;
  if (r.status === 412) return false; // already exists
  throw new Error("gcsCreate " + r.status);
}
async function gcsDelete(name) {
  await fetch(`https://storage.googleapis.com/storage/v1/b/${BUCKET}/o/${encodeURIComponent(name)}`, { method: "DELETE", headers: { Authorization: `Bearer ${await gcp()}` } }).catch(() => {});
}
// ---- Xero refresh (single source of truth for rotation + persist + disconnect detection) ----
async function clientBasic() {
  let id = process.env.XERO_CLIENT_ID, sec = process.env.XERO_CLIENT_SECRET;
  if (!id) id = await smRead("xero-client-id");
  if (!sec) sec = await smRead("xero-client-secret");
  if (!id || !sec) throw new Error("missing xero client creds (SM xero-client-id/secret)");
  return Buffer.from(`${id}:${sec}`).toString("base64");
}
async function refreshAndPersist(org) {
  const secretId = `xero-refresh-token-${org}`;
  let persistId = secretId;
  let refresh = await smRead(secretId);
  if (!refresh && org === "otchealth") { const legacy = await smRead("xero-refresh-token"); if (legacy) { refresh = legacy; persistId = "xero-refresh-token"; } }
  if (!refresh) throw new Error(`no refresh token for '${org}' (SM ${secretId}) — run OAuth consent`);
  const basic = await clientBasic();
  const r = await fetch(TOKEN_URL, { method: "POST", headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" }, body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(refresh)}` });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error(`refresh ${org} failed ${r.status}: ${JSON.stringify(j).slice(0, 160)}`);
  if (j.refresh_token && j.refresh_token !== refresh) {
    const ps = await smWrite(persistId, j.refresh_token);
    if (ps >= 300) throw new Error(`refreshed ${org} but FAILED to persist rotated token (SM ${ps}) — aborting to avoid token loss`);
  }
  const cr = await fetch(CONN_URL, { headers: { Authorization: `Bearer ${j.access_token}`, Accept: "application/json" } });
  const conns = cr.ok ? await cr.json() : [];
  if (!Array.isArray(conns) || conns.length === 0) throw new Error(`XERO_DISCONNECTED:${org} (token valid but /connections is empty — re-consent required)`);
  const tenantId = conns[0].tenantId;
  return { access_token: j.access_token, tenantId, exp_ms: Date.now() + ((+j.expires_in || 1800) * 1000), scope: j.scope || "" };
}
// ---- public: cached + locked access context ----
export async function getAccessContext(org, opts = {}) {
  const now = Date.now();
  // 1) fast path: a still-valid cached access token
  try {
    if (!opts.forceRefresh) {
      const c = await gcsGetJson(CACHE(org));
      if (c && c.access_token && c.tenantId && (c.exp_ms - now) > SKEW_MS) return { access_token: c.access_token, tenantId: c.tenantId, source: "cache" };
    }
  } catch {}
  // 2) need a refresh — serialize via the lock
  const deadline = now + LOCK_WAIT_MS;
  try {
    while (Date.now() < deadline) {
      let got = false;
      try { got = await gcsCreateIfAbsent(LOCK(org), { ts: Date.now(), holder: `${os.hostname()}:${process.pid}` }); } catch { break; } // lock infra error -> fail open
      if (got) {
        try {
          // double-checked: someone may have refreshed just before we got the lock
          const c2 = await gcsGetJson(CACHE(org)).catch(() => null);
          if (c2 && c2.access_token && c2.tenantId && (c2.exp_ms - Date.now()) > SKEW_MS) return { access_token: c2.access_token, tenantId: c2.tenantId, source: "cache" };
          const ctx = await refreshAndPersist(org);
          await gcsPutJson(CACHE(org), { ...ctx, updated: new Date().toISOString() }).catch(() => {});
          return { ...ctx, source: "refresh" };
        } finally { await gcsDelete(LOCK(org)); }
      }
      // locked by someone else: reclaim if stale, else wait then re-check cache
      const lk = await gcsGetJson(LOCK(org)).catch(() => null);
      if (lk && (Date.now() - (lk.ts || 0)) > LOCK_TTL_MS) { await gcsDelete(LOCK(org)); continue; }
      await sleep(1500);
      const c3 = await gcsGetJson(CACHE(org)).catch(() => null);
      if (c3 && c3.access_token && c3.tenantId && (c3.exp_ms - Date.now()) > SKEW_MS) return { access_token: c3.access_token, tenantId: c3.tenantId, source: "cache-after-wait" };
    }
  } catch (e) {
    if (String(e.message || "").startsWith("XERO_DISCONNECTED")) throw e; // propagate the real signal
  }
  // 3) fail-open: do a direct refresh so posting is never blocked by the cache/lock layer
  const ctx = await refreshAndPersist(org);
  await gcsPutJson(CACHE(org), { ...ctx, updated: new Date().toISOString() }).catch(() => {});
  return { ...ctx, source: "fail-open" };
}
// best-effort Datadog metric (no-op if no key); keeps the monitor self-contained
async function ddEmit(metric, value, tags) {
  try {
    const key = await smRead("datadog-api-key"); if (!key) return;
    const site = (await smRead("datadog-site")) || "datadoghq.com";
    await fetch(`https://api.${site}/api/v2/series`, { method: "POST", headers: { "DD-API-KEY": key, "Content-Type": "application/json" }, body: JSON.stringify({ series: [{ metric, type: 3, points: [{ timestamp: Math.floor(Date.now() / 1000), value }], tags }] }) }).catch(() => {});
  } catch {}
}
// ---- CLI ----
// Definitive, low-churn liveness check: obtain a token via the broker (cache when warm; only refreshes
// when the access token is actually stale), then make a real /connections call. An empty list = the org
// was DISCONNECTED even if a cached token is still technically valid — which a pure cache read would miss.
async function liveCheck(org) {
  const c = await getAccessContext(org);
  const r = await fetch(CONN_URL, { headers: { Authorization: `Bearer ${c.access_token}`, Accept: "application/json" } });
  const conns = r.ok ? await r.json() : [];
  if (!Array.isArray(conns) || conns.length === 0) throw new Error(`XERO_DISCONNECTED:${org} (re-consent required)`);
  return conns[0].tenantId;
}
async function cliCheck(orgs) {
  const results = [];
  for (const org of orgs) {
    try { const tid = await liveCheck(org); results.push({ org, ok: true, tenantId: tid }); console.log(`OK         ${org.padEnd(13)} tenant ${tid}`); await ddEmit("otc.fleet.xero_connection_ok", 1, [`org:${org}`]); }
    catch (e) { const disc = String(e.message || "").startsWith("XERO_DISCONNECTED"); results.push({ org, ok: false, disconnected: disc, error: e.message }); console.log(`${disc ? "DISCONNECTED" : "ERROR      "} ${org.padEnd(13)} ${e.message}`); await ddEmit("otc.fleet.xero_connection_ok", 0, [`org:${org}`, disc ? "state:disconnected" : "state:error"]); }
  }
  return results;
}
async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "check") { const r = await cliCheck(rest.length ? rest : ["hearingassist"]); process.exit(r.every((x) => x.ok) ? 0 : 1); }
  if (cmd === "monitor") {
    const orgs = rest.length ? rest : ORGS_ALL;
    const r = await cliCheck(orgs);
    const snapshot = { ts: new Date().toISOString(), results: r, unhealthy: r.filter((x) => !x.ok).map((x) => x.org) };
    try { await gcsPutJson(HEALTH, snapshot); } catch {}
    if (snapshot.unhealthy.length) console.error(`ALERT xero connections unhealthy: ${snapshot.unhealthy.join(", ")}`);
    else console.log("all xero connections healthy");
    process.exit(snapshot.unhealthy.length ? 1 : 0);
  }
  console.error("usage: xero-token.mjs check <org> | monitor [orgs...]"); process.exit(2);
}
if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error("ERR", e.message); process.exit(1); });
