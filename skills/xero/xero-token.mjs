#!/usr/bin/env node
/**
 * xero-token.mjs — SHARED Xero token broker for the whole fleet (both engines + all Container App Jobs).
 *
 * WHY: Xero refresh tokens are SINGLE-USE (rotate on every refresh). The old skills each did a
 * refresh_token grant on EVERY invocation, so two processes (CFO + CTO + cron) refreshing the same org
 * concurrently => one gets invalid_grant and the org's token DIES (forcing a manual re-consent).
 *
 * FIX: a cross-process refresh LOCK serializes the single-use rotation. The durable refresh-token
 * store of record is AWS SSM Parameter Store (`/otchealth/xero-refresh-token-<org>`, via
 * kvSecret/kvSecretSet in azure-secret.mjs, which defaults to SSM) — that leg already works and is
 * untouched by this file. What this file owns is: (1) the LOCK that stops two processes from calling
 * Xero's single-use refresh_token grant at the same instant, and (2) an IN-PROCESS-ONLY access-token
 * cache (Xero access tokens live ~30 min) so repeated calls within the SAME process do not re-refresh.
 * There is deliberately no durable CROSS-process access-token cache: a fresh process always earns its
 * own access token via a lock-guarded refresh, and refreshAndPersist() always re-reads the refresh
 * token fresh from SSM at call time, so a process that had to wait for the lock still gets the
 * correctly-rotated value once it is its turn — never the stale one it observed before waiting.
 *
 * LOCK (2026-08-27, ported off Azure Blob — the Azure subscription holding kv-otc-55c84f6bef and every
 * Azure Blob account was PERMANENTLY DELETED 2026-08-13, so every call through this file's old Azure
 * Blob lock/cache was silently failing every fetch and falling through to fail-open direct refresh —
 * reintroducing the exact concurrent-refresh race this file exists to prevent, the same failure SHAPE
 * as the 2026-07-05 GCS incident below, just a different dead backend). Now an S3 conditional-create
 * lock via skills/kb-memory/s3-blob.mjs's createObjectIfAbsentInS3() (`If-None-Match: '*'` — S3's
 * native conditional-write, the same atomic create-only-if-absent semantics the old GCS
 * ifGenerationMatch=0 / Azure If-None-Match provided). The lock record carries an `expiresAt` (TTL
 * ~120s) so a crashed holder's lock is detected as stale and broken by a waiter, rather than blocking
 * forever; a holder whose refresh runs long renews the TTL on an interval so it is never mistaken for
 * stale while genuinely still working. The lock object lives in the SAME (account, container) the old
 * Azure Blob cache/lock used (the CFO source-docs room) via s3-blob.mjs's existing MIRROR table entry
 * — not a new bucket.
 *
 * HISTORICAL INCIDENT NOTE (2026-07-05, preserved — the failure CLASS recurred verbatim on a different
 * dead backend, see above): while this lock's backend was silently on dead GCS, every call fell
 * through to fail-open (direct refresh, no lock) — root-causing "refresh token has been consumed"
 * failures across all 4 orgs that day.
 *
 * Fail-open: any error in the LOCK layer itself (not "someone else holds it" — a genuine infra
 * failure) degrades to a direct, unlocked refresh so posting is never blocked by the lock layer being
 * unavailable. This is an intentional, pre-existing tradeoff (kept byte-for-byte from before this
 * port), not a new gap: the common case is fully serialized; only a broken lock layer forgoes it.
 *
 * Library:  import { getAccessContext } from "./xero-token.mjs"  ->  { access_token, tenantId, source }
 * CLI:      node xero-token.mjs check <org>        # one org, prints health, exit!=0 if unhealthy
 *           node xero-token.mjs monitor [orgs...]  # all (or listed) orgs; writes an S3 health snapshot + alerts
 *
 * HEALTH CHECK ARCHITECTURE (2026-08-01, post GATEWAY SOLE-CONSUMER GUARD below): `check`/`monitor`
 * no longer read or refresh org tokens directly (that IS the fork-the-chain failure this guard
 * exists to prevent — doing so 100% failed every hourly run of the `xero-health` Container Apps Job
 * for 16+ days, since the guard was added 2026-07-16, and left the Datadog monitor "Xero org
 * connection DOWN" stuck alerting on stale/no data instead of real state). They now go through the
 * gateway's own read-only `xero_orgs` tool (probe:true) on a `cfo`-lane client_credentials bearer
 * (gateway-connect.mjs — same pattern as skills/cfo-reconstruction/xero-readonly.mjs), and emit the
 * SAME `otc.fleet.xero_connection_ok{org:<org>}` Datadog metric based on the gateway's answer.
 * XERO_ALLOW_DIRECT=1 switches back to the pre-hardening direct-refresh check (the same escape hatch
 * documented on guardGatewayOwnedOrg below): a genuinely gateway-independent org, or an operator
 * emergency re-seed check.
 */
import crypto from "node:crypto"; import fs from "node:fs"; import os from "node:os";
import { kvSecret, kvSecretSet, requireSecrets } from "../kb-memory/azure-secret.mjs";
import { mintToken as mintGatewayToken, GATEWAY_MCP } from "../gateway-connect/connect.mjs";
import { createObjectIfAbsentInS3, getTextFromS3, putObjectToS3, deleteObjectFromS3 } from "../kb-memory/s3-blob.mjs";

const SM_PROJECT = "otchealth-shared-prod";
// S3 lock/health location (2026-08-27 port off dead Azure Blob). Reuses the SAME (account, container)
// the old Azure Blob cache/lock lived in — the CFO source-docs room — via s3-blob.mjs's existing,
// tested MIRROR entry ("otchealthcfodata"/"cfo-source-docs" -> bucket otchealth-finance-legal-dr-55c84f6b),
// NOT a new bucket. keyPrefix stays "xero-token-cache/" for 1:1 path parity with the pre-migration names.
const S3_ACCOUNT = "otchealthcfodata";
const S3_CONTAINER = "cfo-source-docs";
const LOCK = (org) => `xero-token-cache/${org}.lock`;
const HEALTH = "xero-token-cache/health.json";
const TOKEN_URL = "https://identity.xero.com/connect/token";
const CONN_URL = "https://api.xero.com/connections";
const ORGS_ALL = ["otchealth", "innd", "hearingassist", "personal"];
const SKEW_MS = 120000;       // treat the access token as stale 2 min before its real expiry
const LOCK_TTL_MS = 120000;   // a lock older than this is considered abandoned and reclaimed (stale-holder recovery)
const LOCK_REFRESH_MS = Math.floor((LOCK_TTL_MS * 2) / 3); // renew the lock's TTL if the held refresh runs long
const LOCK_WAIT_MS = 20000;   // max time to wait for another process's refresh before forcing our own (fail-open)
const b64url = (b) => Buffer.from(b).toString("base64url");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// IN-PROCESS-ONLY access-token cache (see header comment: deliberately not durable/cross-process).
const _memCache = new Map(); // org -> { access_token, tenantId, exp_ms, scope }

// GATEWAY SOLE-CONSUMER GUARD (2026-07-16). The gateway (otchealth-mcp-server, src/tools/xero) is now
// the SOLE consumer of the live rotate-on-use Xero chain for all 4 orgs: it maintains the live token in
// its Cosmos `cache` container, and the KV `xero-refresh-token-<org>` secrets are now SPENT bootstraps.
// Running THIS skill against those orgs would read a spent token and FORK / break the gateway's live
// chain (the exact "refresh token has been consumed" failure). Refuse by default at every rotation path.
// Escape hatch XERO_ALLOW_DIRECT=1 is only for a genuinely gateway-independent org, or an operator-run
// emergency re-seed. The consent flow (consent-exchange.mjs, authorization_code) does NOT pass through
// here, so operator re-consent to mint a fresh KV bootstrap still works and the gateway adopts it.
function guardGatewayOwnedOrg(org) {
  if (ORGS_ALL.includes(org) && process.env.XERO_ALLOW_DIRECT !== "1") {
    throw new Error(
      `xero skill refuses org '${org}': the gateway is the SOLE Xero consumer since 2026-07-16 ` +
      `(it owns the live rotate-on-use chain in Cosmos). Use the gateway xero_* tools on an exec lane ` +
      `(xero_orgs / xero_report / xero_accounts / xero_manual_journals / xero_bank_transactions / xero_invoices). ` +
      `Running this skill would fork and break the gateway's live token. Override ONLY for a ` +
      `gateway-independent org or an operator emergency re-seed: set XERO_ALLOW_DIRECT=1.`
    );
  }
}

function loadSA() {
  if (process.env.GCP_CLAUDE_DRIVER_SA_JSON) { try { return JSON.parse(process.env.GCP_CLAUDE_DRIVER_SA_JSON); } catch {} }
  for (const p of [`${os.homedir()}/.gcp_claude_driver_sa.json`, "/agent/.gcp_claude_driver_sa.json"]) {
    try { if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8")); } catch {}
  }
  return null; // fail-open: this is now only a dead-GCP fallback inside smRead/smWrite, which already try Azure Key Vault first
}
let _gt = null;
async function gcp() {
  if (_gt) return _gt;
  const sa = loadSA(); if (!sa || !sa.private_key) return null; const now = Math.floor(Date.now() / 1000);
  const cl = { iss: sa.client_email, scope: "https://www.googleapis.com/auth/cloud-platform", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3500 };
  const i = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(JSON.stringify(cl))}`;
  const s = crypto.createSign("RSA-SHA256").update(i).sign(sa.private_key);
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${i}.${Buffer.from(s).toString("base64url")}` }) });
  return (_gt = (await r.json()).access_token);
}
async function smRead(id) { const _kv = await kvSecret(id); if (_kv != null) return _kv;
  const r = await fetch(`https://secretmanager.googleapis.com/v1/projects/${SM_PROJECT}/secrets/${id}/versions/latest:access`, { headers: { Authorization: `Bearer ${await gcp()}` } });
  if (!r.ok) return null;
  return Buffer.from((await r.json()).payload.data, "base64").toString("utf8").trim();
}
async function smWrite(id, val) { const _ok = await kvSecretSet(id, val); if (_ok) return true;
  const t = await gcp();
  const e = await fetch(`https://secretmanager.googleapis.com/v1/projects/${SM_PROJECT}/secrets/${id}`, { headers: { Authorization: `Bearer ${t}` } });
  if (e.status === 404) await fetch(`https://secretmanager.googleapis.com/v1/projects/${SM_PROJECT}/secrets?secretId=${id}`, { method: "POST", headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" }, body: JSON.stringify({ replication: { automatic: {} } }) });
  const r = await fetch(`https://secretmanager.googleapis.com/v1/projects/${SM_PROJECT}/secrets/${id}:addVersion`, { method: "POST", headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" }, body: JSON.stringify({ payload: { data: Buffer.from(val, "utf8").toString("base64") } }) });
  return r.status;
}
// ---- S3 conditional-create lock (ported off Azure Blob 2026-08-27 — see header comment for why).
// createObjectIfAbsentInS3/getTextFromS3/putObjectToS3/deleteObjectFromS3 come from
// skills/kb-memory/s3-blob.mjs, which already carries the (account, container) -> S3 bucket mapping,
// SigV4 signing, and the 404/403-vs-loud-failure contracts this file used to hand-roll for Azure Blob.
// No local blob-credential/SAS plumbing is needed here anymore -- s3-blob.mjs resolves AWS credentials
// itself (ECS task role / env / OTC_AWS_* -- see aws-secret.mjs). ----
// ---- Xero refresh (single source of truth for rotation + persist + disconnect detection) ----
async function clientBasic() {
  let id = process.env.XERO_CLIENT_ID, sec = process.env.XERO_CLIENT_SECRET;
  if (!id) id = await smRead("xero-client-id");
  if (!sec) sec = await smRead("xero-client-secret");
  if (!id || !sec) throw new Error("missing xero client creds (SM xero-client-id/secret)");
  return Buffer.from(`${id}:${sec}`).toString("base64");
}
async function refreshAndPersist(org) {
  guardGatewayOwnedOrg(org); // the rotation primitive: hard-stop a fork of the gateway-owned chain
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
// ---- lock helpers (S3 conditional-create; see header + block comment above) --------------------
/** Try to acquire the org's lock. Returns {acquired:true, holder} on success (a fresh 201-equivalent
 *  create), or {acquired:false} when it is already held (S3 answered If-None-Match:'*' with 412 —
 *  createObjectIfAbsentInS3 turns that into created:false rather than throwing). Any OTHER failure
 *  (auth/network/5xx) THROWS, so the caller can tell "someone else holds the lock" (expected, not an
 *  error) apart from "the lock layer itself is broken" (the caller's fail-open path). */
async function tryAcquireLock(org) {
  const holder = `${os.hostname()}:${process.pid}:${crypto.randomUUID()}`;
  const body = JSON.stringify({ holder, acquiredAt: Date.now(), expiresAt: Date.now() + LOCK_TTL_MS });
  const res = await createObjectIfAbsentInS3(S3_ACCOUNT, S3_CONTAINER, LOCK(org), body, "application/json");
  return res.created ? { acquired: true, holder } : { acquired: false };
}
/** Best-effort: read the current lock record (null if absent or unreadable — never throws). */
async function readLock(org) {
  try { const text = await getTextFromS3(S3_ACCOUNT, S3_CONTAINER, LOCK(org)); return text ? JSON.parse(text) : null; }
  catch { return null; }
}
/** Best-effort renew (fire-and-forget from an interval timer) — extends the TTL so a holder whose
 *  refresh is running long is never mistaken for a crashed/stale holder by a waiter. */
async function renewLock(org, holder) {
  const body = JSON.stringify({ holder, acquiredAt: Date.now(), expiresAt: Date.now() + LOCK_TTL_MS });
  await putObjectToS3(S3_ACCOUNT, S3_CONTAINER, LOCK(org), body, "application/json");
}
/** Best-effort release/break — never throws (a failed delete just lets the lock expire on its own TTL). */
async function dropLock(org) {
  try { await deleteObjectFromS3(S3_ACCOUNT, S3_CONTAINER, LOCK(org)); } catch {}
}

// ---- public: locked access context (see header comment for the full cache/lock design) ----
export async function getAccessContext(org, opts = {}) {
  guardGatewayOwnedOrg(org); // library entry: steer all skill data-ops to the gateway xero_* tools
  await requireSecrets(["xero-client-id", "xero-client-secret"]);
  const now = Date.now();
  // 1) fast path: a still-valid access token cached IN THIS PROCESS ONLY (see header comment — there
  //    is deliberately no durable cross-process cache anymore).
  if (!opts.forceRefresh) {
    const c = _memCache.get(org);
    if (c && c.access_token && c.tenantId && (c.exp_ms - now) > SKEW_MS) return { access_token: c.access_token, tenantId: c.tenantId, source: "cache" };
  }
  // 2) need a refresh — serialize via the S3 conditional-create lock so two processes never call
  //    Xero's single-use refresh_token grant for the same org at the same time.
  const deadline = now + LOCK_WAIT_MS;
  try {
    while (Date.now() < deadline) {
      let lock;
      try { lock = await tryAcquireLock(org); } catch { break; } // lock infra error -> fail open (step 3)
      if (lock.acquired) {
        let renewTimer = null;
        try {
          renewTimer = setInterval(() => { renewLock(org, lock.holder).catch((e) => { console.error(`[xero-token] lock renew failed for ${org}: ${e.message} (TTL is the backstop)`); }); }, LOCK_REFRESH_MS);
          const ctx = await refreshAndPersist(org);
          _memCache.set(org, ctx);
          return { ...ctx, source: "refresh" };
        } finally {
          if (renewTimer) clearInterval(renewTimer);
          await dropLock(org);
        }
      }
      // locked by someone else: break it if the embedded expiry is in the past (stale-holder
      // recovery — a crashed process's lock must not block every future caller forever), else wait
      // and retry acquiring (there is no durable cache to re-check here; the next holder to acquire
      // the lock does its OWN refresh, reading the refresh token fresh from SSM at that time, so it
      // always gets the correctly-rotated value even though it could not observe the prior rotation).
      const lk = await readLock(org);
      if (lk && typeof lk.expiresAt === "number" && Date.now() > lk.expiresAt) { await dropLock(org); continue; }
      await sleep(1500);
    }
  } catch (e) {
    if (String(e.message || "").startsWith("XERO_DISCONNECTED")) throw e; // propagate the real signal
  }
  // 3) fail-open: the lock layer itself could not serialize us within the wait window (or is
  //    genuinely broken) — do a direct, unlocked refresh so posting is never blocked by it.
  const ctx = await refreshAndPersist(org);
  _memCache.set(org, ctx);
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
//
// DIRECT-PATH ONLY: this reads/refreshes the org's token directly, which guardGatewayOwnedOrg() refuses
// for otchealth/innd/hearingassist/personal unless XERO_ALLOW_DIRECT=1 (the documented escape hatch —
// a genuinely gateway-independent org, or an operator emergency re-seed). NOT used by the default health
// check below; see cliCheckViaGateway().
async function liveCheck(org) {
  const c = await getAccessContext(org);
  const r = await fetch(CONN_URL, { headers: { Authorization: `Bearer ${c.access_token}`, Accept: "application/json" } });
  const conns = r.ok ? await r.json() : [];
  if (!Array.isArray(conns) || conns.length === 0) throw new Error(`XERO_DISCONNECTED:${org} (re-consent required)`);
  return conns[0].tenantId;
}

// ---- Gateway-backed health check (2026-08-01) ----
// Since 2026-07-16 the gateway is the SOLE consumer of the live rotate-on-use Xero chain for all 4
// orgs (guardGatewayOwnedOrg above), so this skill can no longer read/refresh org tokens directly to
// check health — that IS the fork-the-chain failure mode the guard exists to prevent. Post-hardening,
// health must be read the same way any other read-only consumer reads Xero: through the gateway's own
// read-only `xero_orgs` tool (probe:true live-checks every configured org in ONE call), authenticated
// as a lane the gateway allows to reach Xero. Mirrors skills/cfo-reconstruction/xero-readonly.mjs
// (same gateway-connect.mjs mintToken() client_credentials pattern, same GATEWAY_MCP endpoint).
//
// LANE NOTE (load-bearing): xero_orgs is gated by isXeroAllowed() in the gateway
// (otchealth-mcp-server/src/tools/xero/client.ts), which only accepts EXEC_RING lanes
// ('cfo','clo','clo-personal','cpo','cco','exec') — 'cto' and 'developer' are NOT on that list and
// get a ring refusal. This health check MUST mint a 'cfo' lane bearer, not 'cto'.
function extractLeadingJson(text) {
  const s = String(text || "");
  const start = s.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    if (s[i] === "{") depth++;
    else if (s[i] === "}") { depth--; if (depth === 0) return s.slice(start, i + 1); }
  }
  return null; // unbalanced — truncated response
}
async function gatewayXeroOrgs() {
  const { token } = await mintGatewayToken("cfo");
  const r = await fetch(GATEWAY_MCP, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "xero_orgs", arguments: { probe: true, acknowledge_warning: true } } }),
  });
  const txt = await r.text();
  let j;
  try { j = JSON.parse(txt); } catch { const m = txt.match(/data: (\{[\s\S]*\})/); j = m ? JSON.parse(m[1]) : null; }
  if (!j) throw new Error(`gateway xero_orgs: unparseable response (HTTP ${r.status}): ${txt.slice(0, 200)}`);
  if (j.error) throw new Error(`gateway xero_orgs JSON-RPC error: ${JSON.stringify(j.error).slice(0, 200)}`);
  const res = j.result;
  if (!res) throw new Error(`gateway xero_orgs: no result (HTTP ${r.status}): ${txt.slice(0, 200)}`);
  if (res.isError) {
    const errText = (res.content && res.content[0] && res.content[0].text) || JSON.stringify(res);
    throw new Error(`gateway xero_orgs tool error: ${String(errText).slice(0, 300)}`);
  }
  // Prefer structuredContent.result (clean JSON). content[0].text carries the SAME JSON followed by a
  // prose summary line, so the whole string is NOT valid JSON — a documented fleet pitfall (gateway
  // MCP tools put structured fields in structuredContent.result, not content[0].text; verify response
  // SHAPE before diagnosing a "broken" deploy).
  const structOrgs = res.structuredContent && res.structuredContent.result && res.structuredContent.result.orgs;
  if (Array.isArray(structOrgs)) return structOrgs;
  const text = (res.content && res.content[0] && res.content[0].text) || "";
  const leading = extractLeadingJson(text);
  if (leading) { try { const parsed = JSON.parse(leading); if (Array.isArray(parsed.orgs)) return parsed.orgs; } catch {} }
  throw new Error(`gateway xero_orgs: could not locate orgs[] in response: ${text.slice(0, 300)}`);
}
/** Real-down (dead/unbootstrapped) vs a healthy 'live' org, per the gateway's own probe. */
function isOrgHealthy(status) { return status === "live"; }

async function cliCheckViaGateway(orgs) {
  const results = [];
  let probed;
  try {
    probed = await gatewayXeroOrgs();
  } catch (e) {
    // The gateway itself is unreachable, or lane auth failed — that is ALSO a real health signal (we
    // cannot verify anything), not a pass. Report every requested org as unhealthy rather than
    // silently exiting 0, and emit 0 so the Datadog monitor still sees a fresh (if bad) value.
    for (const org of orgs) {
      results.push({ org, ok: false, error: `gateway check failed: ${e.message}` });
      console.log(`ERROR      ${org.padEnd(13)} gateway check failed: ${e.message}`);
      await ddEmit("otc.fleet.xero_connection_ok", 0, [`org:${org}`, "state:gateway-error"]);
    }
    return results;
  }
  const byOrg = new Map(probed.map((o) => [o.org, o]));
  for (const org of orgs) {
    const o = byOrg.get(org);
    if (!o) {
      results.push({ org, ok: false, error: `org '${org}' missing from gateway xero_orgs response` });
      console.log(`ERROR      ${org.padEnd(13)} missing from gateway xero_orgs response`);
      await ddEmit("otc.fleet.xero_connection_ok", 0, [`org:${org}`, "state:missing"]);
      continue;
    }
    if (isOrgHealthy(o.status)) {
      results.push({ org, ok: true, tenantName: o.tenantName });
      console.log(`OK         ${org.padEnd(13)} tenant ${o.tenantName || "?"} (via gateway)`);
      await ddEmit("otc.fleet.xero_connection_ok", 1, [`org:${org}`]);
    } else {
      const disconnected = o.status === "unbootstrapped" || o.status === "dead";
      results.push({ org, ok: false, disconnected, status: o.status, error: o.detail || o.status });
      console.log(`${o.status === "unbootstrapped" ? "DISCONNECTED" : "ERROR      "} ${org.padEnd(13)} status=${o.status}${o.detail ? " " + o.detail : ""}`);
      await ddEmit("otc.fleet.xero_connection_ok", 0, [`org:${org}`, `state:${o.status}`]);
    }
  }
  return results;
}
async function cliCheckDirect(orgs) {
  // The ORIGINAL direct-refresh liveness check, preserved for the documented escape hatch
  // (XERO_ALLOW_DIRECT=1): a genuinely gateway-independent org, or an operator emergency re-seed.
  const results = [];
  for (const org of orgs) {
    try { const tid = await liveCheck(org); results.push({ org, ok: true, tenantId: tid }); console.log(`OK         ${org.padEnd(13)} tenant ${tid} (direct)`); await ddEmit("otc.fleet.xero_connection_ok", 1, [`org:${org}`]); }
    catch (e) { const disc = String(e.message || "").startsWith("XERO_DISCONNECTED"); results.push({ org, ok: false, disconnected: disc, error: e.message }); console.log(`${disc ? "DISCONNECTED" : "ERROR      "} ${org.padEnd(13)} ${e.message}`); await ddEmit("otc.fleet.xero_connection_ok", 0, [`org:${org}`, disc ? "state:disconnected" : "state:error"]); }
  }
  return results;
}
// Default entry point: gateway-backed (post-2026-07-16 architecture). XERO_ALLOW_DIRECT=1 switches to
// the pre-hardening direct path (same escape hatch guardGatewayOwnedOrg documents everywhere else in
// this file) — kept for a genuinely gateway-independent org or an operator emergency re-seed check.
async function cliCheck(orgs) {
  return process.env.XERO_ALLOW_DIRECT === "1" ? cliCheckDirect(orgs) : cliCheckViaGateway(orgs);
}
async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "check") { const r = await cliCheck(rest.length ? rest : ["hearingassist"]); process.exit(r.every((x) => x.ok) ? 0 : 1); }
  if (cmd === "monitor") {
    const orgs = rest.length ? rest : ORGS_ALL;
    const r = await cliCheck(orgs);
    const snapshot = { ts: new Date().toISOString(), results: r, unhealthy: r.filter((x) => !x.ok).map((x) => x.org) };
    try { await putObjectToS3(S3_ACCOUNT, S3_CONTAINER, HEALTH, JSON.stringify(snapshot), "application/json"); } catch {}
    if (snapshot.unhealthy.length) console.error(`ALERT xero connections unhealthy: ${snapshot.unhealthy.join(", ")}`);
    else console.log("all xero connections healthy");
    process.exit(snapshot.unhealthy.length ? 1 : 0);
  }
  console.error("usage: xero-token.mjs check <org> | monitor [orgs...]"); process.exit(2);
}
if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error("ERR", e.message); process.exit(1); });
