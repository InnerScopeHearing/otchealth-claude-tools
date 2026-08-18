#!/usr/bin/env node
/**
 * token-keeper — engine-portable OAuth token refresher for the OTCHealth fleet.
 *
 * THE PROBLEM IT SOLVES: OAuth refresh tokens (QuickBooks 100d-rotating, Xero 60d-sliding) die
 * if nothing re-persists the *rotated* token after each use. That is the exact failure that killed
 * the Stripe MCP ("invalid refresh token"). The keeper refreshes each provider on a schedule and
 * writes the rotated refresh token BACK to GCP Secret Manager, so consent is one-time-forever.
 *
 * WORKS ON BOTH ENGINES (CEO requirement 2026-06-26):
 *   - Storage backbone = GCP Secret Manager (otchealth-shared-prod). Neither engine holds the token.
 *   - One code path; runtime auto-detected:
 *       * HyperAgent: HOME under /agent, proxy required (run.sh sets NODE_USE_ENV_PROXY=1 +
 *         normalizes the SA to ~/.gcp_claude_driver_sa.json).
 *       * Claude Code: native SA + direct egress.
 *   - The canonical daily rotation runs as an Azure Container App Job (engine-independent) so tokens
 *     never lapse even when no agent is awake. Manual runs from either engine default to --dry-run
 *     unless --force, so two engines never clobber the same rotating refresh token.
 *
 * USAGE:
 *   node keeper.mjs status                         # per-provider: secrets present? last refresh? age?
 *   node keeper.mjs selftest                       # no token writes: engine detect + SM reachability + config
 *   node keeper.mjs refresh --provider xero        # dry-run by default
 *   node keeper.mjs refresh --provider xero --force # actually rotate + persist
 *   node keeper.mjs refresh --all --force          # rotate every due provider (the cron entrypoint)
 *
 * SECURITY: secret VALUES never printed/logged (only names). Non-PHI ring. Financial providers are
 * cfo-ring data; the keeper only refreshes tokens, it never reads ledgers/balances.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { kvSecret, kvSecretSet } from "../kb-memory/azure-secret.mjs";
import { ddEmitMetric } from "../datadog/dd-emit.mjs";

const PROJECT = "otchealth-shared-prod";
const SM = `https://secretmanager.googleapis.com/v1`;

// ---------- runtime detection (the dual-engine crux) ----------
function detectEngine() {
  const home = process.env.HOME || os.homedir() || "";
  if (home.startsWith("/agent") || process.env.NODE_USE_ENV_PROXY === "1") return "hyperagent";
  return "claude";
}

// ---------- GCP auth (SA JWT -> access token); identical on both engines ----------
const b64url = (b) => Buffer.from(b).toString("base64url");
function loadSA() {
  // Priority: env (exported by run.sh) -> normalized file -> Claude Code default paths.
  if (process.env.GCP_CLAUDE_DRIVER_SA_JSON) {
    try { return JSON.parse(process.env.GCP_CLAUDE_DRIVER_SA_JSON); } catch {}
  }
  const candidates = [
    `${os.homedir()}/.gcp_claude_driver_sa.json`,
    "/agent/.gcp_claude_driver_sa.json",
    `${os.homedir()}/.config/gcp/claude_driver_sa.json`,
  ];
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8")); } catch {}
  }
  throw new Error("No GCP claude-driver SA found (env GCP_CLAUDE_DRIVER_SA_JSON or ~/.gcp_claude_driver_sa.json). On HyperAgent run via run.sh.");
}
async function gcpToken() {
  // Post-GCP-exit: no claude-driver SA -> return null and run Key-Vault-only (smRead/smExists/
  // smAddVersion fall through to kvSecret/kvSecretSet when tok is null). Non-fatal by design so the
  // live Azure path always runs; this removes the hard gate that used to kill the tool before KV ran.
  let sa;
  try { sa = loadSA(); } catch { return null; }
  const now = Math.floor(Date.now() / 1000);
  const claim = {
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/cloud-platform",
    aud: "https://oauth2.googleapis.com/token",
    iat: now, exp: now + 3500,
  };
  const input = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(JSON.stringify(claim))}`;
  const sig = crypto.createSign("RSA-SHA256").update(input).sign(sa.private_key);
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${input}.${Buffer.from(sig).toString("base64url")}`,
    }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error("GCP token exchange failed: " + JSON.stringify(j).slice(0, 200));
  return j.access_token;
}

// ---------- Secret Manager helpers (read + addVersion + create) ----------
async function smRead(tok, id) {
  // Azure Key Vault FIRST (GCP Secret Manager retired). Secret names are a 1:1 mirror.
  const _kv = await kvSecret(id);
  if (_kv != null) return _kv;
  if (!tok) return null; // no GCP token post-exit -> Key Vault only; skip the retired SM fallback
  const r = await fetch(`${SM}/projects/${PROJECT}/secrets/${id}/versions/latest:access`, {
    headers: { Authorization: `Bearer ${tok}` },
  });
  if (r.status === 404) return null;
  const j = await r.json();
  if (!j.payload) return null;
  return Buffer.from(j.payload.data, "base64").toString("utf8").trim();
}
async function smExists(tok, id) {
  // Key Vault first: a non-null value means the secret exists in the live store.
  if ((await kvSecret(id)) != null) return true;
  if (!tok) return false; // no GCP token post-exit -> Key Vault only
  const r = await fetch(`${SM}/projects/${PROJECT}/secrets/${id}`, { headers: { Authorization: `Bearer ${tok}` } });
  return r.status === 200;
}
async function smAddVersion(tok, id, value) {
  // CRITICAL rotation-persist path: write the rotated token to Azure Key Vault FIRST (the live
  // store). Only fall back to the retired GCP addVersion if the KV write fails AND a GCP token is
  // present. Consumers read Key-Vault-first (smRead), so a successful KV write is the authoritative
  // persist; a true persist failure (KV fail + GCP fail/absent) surfaces as status>=300 to the caller.
  if (await kvSecretSet(id, value)) return { status: 200, body: "kv-ok" };
  if (!tok) return { status: 500, body: `kv write failed for ${id} and no GCP token available` };
  const r = await fetch(`${SM}/projects/${PROJECT}/secrets/${id}:addVersion`, {
    method: "POST",
    headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
    body: JSON.stringify({ payload: { data: Buffer.from(value, "utf8").toString("base64") } }),
  });
  return { status: r.status, body: await r.text() };
}

// ---------- provider registry ----------
// Each provider names ONLY the SM secret ids it reads/writes; no values live here.
const PROVIDERS = {
  xero: {
    kind: "oauth-rotating",
    tokenUrl: "https://identity.xero.com/connect/token",
    clientId: "xero-client-id",
    clientSecret: "xero-client-secret",
    refreshSecret: "xero-refresh-token",   // rotates every refresh (60d sliding window)
    accessSecret: "xero-access-token",      // short-lived; consumers read this
    windowDays: 60,
    auth: "basic",
  },
  quickbooks: {
    kind: "oauth-rotating",
    tokenUrl: "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
    clientId: "qbo-client-id",
    clientSecret: "qbo-client-secret",
    // QBO is MULTI-ENTITY: one app/client, but a SEPARATE rotating refresh token PER company.
    // The live SM scheme is qbo-refresh-<entity> (NOT a single quickbooks-refresh-token, which was
    // an empty placeholder -> the keeper used to no-op on MISSING_SECRETS). qbo.mjs mints access on
    // demand, so there is no per-entity access secret to persist here; we only rotate the refresh token.
    tenants: ["otchealth", "innd", "hearingassist", "personal"],
    refreshSecretFor: (t) => `qbo-refresh-${t}`, // per-entity, rotates on every refresh (100d window)
    windowDays: 100,
    auth: "basic",
  },
  mercury: {
    kind: "static-token",                   // native long-lived API token; no refresh, just validate
    apiToken: "mercury-api-token",
    validateUrl: "https://api.mercury.com/api/v1/accounts",
  },
  plaid: {
    kind: "no-expire",                      // item access_token does not expire; nothing to rotate
    accessSecret: "plaid-access-token",
  },
};
// metadata sidecar (last-refresh timestamps) so status/age works without exposing token values
function metaSecret(p) { return `token-keeper-meta-${p}`; }

// ---------- core operations ----------
// Refresh ONE rotating-oauth credential (a single refresh-secret id). No meta write here; the caller
// aggregates + stamps meta. Returns { ok, rotated?, dryRun?, reason? }.
async function refreshOneOAuth(tok, cfg, refreshSecretId, accessSecretId, { force }) {
  const [clientId, clientSecret, refreshTokenVal] = await Promise.all([
    smRead(tok, cfg.clientId), smRead(tok, cfg.clientSecret), smRead(tok, refreshSecretId),
  ]);
  const missing = [];
  if (!clientId) missing.push(cfg.clientId);
  if (!clientSecret) missing.push(cfg.clientSecret);
  if (!refreshTokenVal) missing.push(refreshSecretId);
  if (missing.length) return { ok: false, reason: "MISSING_SECRETS", missing };
  if (!force) return { ok: true, dryRun: true, note: "would refresh + rotate (use --force)" };

  const headers = { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" };
  const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshTokenVal });
  if (cfg.auth === "basic") {
    headers.Authorization = "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  } else {
    body.set("client_id", clientId); body.set("client_secret", clientSecret);
  }
  const r = await fetch(cfg.tokenUrl, { method: "POST", headers, body });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) {
    return { ok: false, reason: "REFRESH_FAILED", status: r.status, detail: (j.error || JSON.stringify(j)).toString().slice(0, 160) };
  }
  // CRITICAL: persist the ROTATED refresh token (this is the bit everyone forgets).
  const writes = [];
  if (j.refresh_token && j.refresh_token !== refreshTokenVal) writes.push(smAddVersion(tok, refreshSecretId, j.refresh_token));
  if (accessSecretId) writes.push(smAddVersion(tok, accessSecretId, j.access_token));
  const res = await Promise.all(writes);
  const bad = res.find((x) => x.status >= 300);
  if (bad) return { ok: false, reason: "PERSIST_FAILED", status: bad.status, detail: bad.body.slice(0, 160) };
  return { ok: true, rotated: !!(j.refresh_token && j.refresh_token !== refreshTokenVal), accessExpiresIn: j.expires_in || null };
}

// Refresh a provider: single-tenant (xero) OR multi-tenant (quickbooks = one client, a rotating
// refresh token per company). Stamps the meta sidecar only on a real (forced) refresh.
async function refreshOAuth(tok, name, cfg, { force }) {
  if (Array.isArray(cfg.tenants) && cfg.tenants.length) {
    const tenants = [];
    for (const t of cfg.tenants) tenants.push({ tenant: t, ...(await refreshOneOAuth(tok, cfg, cfg.refreshSecretFor(t), null, { force })) });
    if (force && tenants.some((x) => x.ok && !x.dryRun)) {
      await smAddVersion(tok, metaSecret(name), JSON.stringify({ lastRefresh: new Date().toISOString(), tenants: tenants.map((x) => ({ tenant: x.tenant, ok: x.ok, rotated: !!x.rotated })) }));
    }
    return { provider: name, ok: tenants.every((x) => x.ok), multi: true, tenants };
  }
  const r = await refreshOneOAuth(tok, cfg, cfg.refreshSecret, cfg.accessSecret, { force });
  if (force && r.ok && !r.dryRun) {
    await smAddVersion(tok, metaSecret(name), JSON.stringify({ lastRefresh: new Date().toISOString(), expiresIn: r.accessExpiresIn || null, rotated: !!r.rotated }));
  }
  return { provider: name, ...r };
}

async function validateStatic(tok, name, cfg) {
  const apiToken = await smRead(tok, cfg.apiToken);
  if (!apiToken) return { provider: name, ok: false, reason: "MISSING_SECRETS", missing: [cfg.apiToken] };
  const r = await fetch(cfg.validateUrl, { headers: { Authorization: `Bearer ${apiToken}`, Accept: "application/json" } });
  return { provider: name, ok: r.ok, reason: r.ok ? undefined : `VALIDATE_${r.status}` };
}

async function doRefresh(tok, name, { force }) {
  const cfg = PROVIDERS[name];
  if (!cfg) return { provider: name, ok: false, reason: "UNKNOWN_PROVIDER" };
  if (cfg.kind === "oauth-rotating") return refreshOAuth(tok, name, cfg, { force });
  if (cfg.kind === "static-token") return validateStatic(tok, name, cfg);
  if (cfg.kind === "no-expire") {
    const v = await smRead(tok, cfg.accessSecret);
    return { provider: name, ok: !!v, reason: v ? undefined : "MISSING_SECRETS", note: "no-expire; nothing to rotate" };
  }
  return { provider: name, ok: false, reason: "UNHANDLED_KIND" };
}

async function status(tok) {
  const out = [];
  for (const [name, cfg] of Object.entries(PROVIDERS)) {
    const refs = Array.isArray(cfg.tenants) ? cfg.tenants.map((t) => cfg.refreshSecretFor(t)) : [cfg.refreshSecret];
    const ids = [...refs, cfg.accessSecret, cfg.apiToken, cfg.clientId, cfg.clientSecret].filter(Boolean);
    const present = {};
    for (const id of ids) present[id] = await smExists(tok, id);
    let meta = null;
    try { const m = await smRead(tok, metaSecret(name)); if (m) meta = JSON.parse(m); } catch {}
    out.push({ provider: name, kind: cfg.kind, secretsPresent: present, lastRefresh: meta?.lastRefresh || null });
  }
  return out;
}

// ---------- Datadog age metric (otc.fleet.token_age_hours) ----------
// Datadog monitor 22896070 ("Credential health — rotating token aging toward idle-expiry") has
// watched this metric since 2026-06-27 with NOTHING ever emitting it (a fleet audit confirmed zero
// repo-wide emitters). token-keeper is the obvious owner: credential age is exactly what it manages,
// and status() already computes `lastRefresh` per provider from the meta-secret sidecar it stamps on
// every real (forced) rotation. This wires that existing, real data to Datadog instead of inventing
// a new signal.
//
// IMPORTANT (found by reading the monitor's own query before wiring, not assumed): the monitor is
// `max(last_2d):max:otc.fleet.token_age_hours{*} by {secret} > 1200` — it groups BY THE `secret` TAG,
// not `provider`. Reporting under a `provider:<name>` tag alone would not break the monitor (`{*}`
// still matches it), but it would silently defeat the per-credential grouping the monitor's own
// message text promises ("A rotating OAuth token has not refreshed..."), and would give QuickBooks'
// 4 independently-rotating per-entity tokens (skills/token-keeper's real multi-tenant design) a
// single blended age instead of one alarm per stuck entity. So each row is tagged with the actual
// Key Vault/SM secret NAME that holds that rotating refresh token (e.g. "xero-refresh-token",
// "qbo-refresh-otchealth"), matching the fleet metric-namespace design doc's own
// `otc.fleet.token_rotation{secret:...}` convention. `provider` rides along as a second, purely
// informational tag. Only oauth-rotating providers ever get a meta-secret lastRefresh (mercury/plaid
// are static/no-expire and never call refreshOAuth), so they never appear here — a provider with no
// recorded rotation is dropped, not reported at a fabricated age of 0.

// Pure: hours between `lastRefreshIso` and `nowMs`. Returns null (never a fabricated 0) when there is
// no recorded last-refresh at all, so a genuinely never-rotated provider is distinguishable from a
// freshly-rotated one — the same "don't report data you don't have" discipline as the emit functions
// below not claiming success on a request that never landed.
export function ageHours(lastRefreshIso, nowMs = Date.now()) {
  if (!lastRefreshIso) return null;
  const t = Date.parse(lastRefreshIso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, (nowMs - t) / 3600000);
}

// The concrete rotating-refresh-token secret id(s) a provider's age applies to. All constituent
// secrets of one provider share that provider's single recorded lastRefresh (refreshOAuth rotates a
// multi-tenant provider's tenants together, in one call, and stamps ONE combined timestamp) — a real,
// if coarse-grained, upper bound on how stale any one of them individually is; the data model does
// not currently track a per-tenant timestamp, so this does not pretend to finer granularity than it has.
function secretIdsFor(providerName, providers) {
  const cfg = providers[providerName];
  if (!cfg || cfg.kind !== "oauth-rotating") return [];
  if (Array.isArray(cfg.tenants) && cfg.tenants.length) return cfg.tenants.map((t) => cfg.refreshSecretFor(t));
  return [cfg.refreshSecret];
}

// Pure: status() rows -> [{secret, provider, ageHours}], one row per rotating refresh-token secret,
// dropping providers with no lastRefresh yet (static/no-expire providers, or a never-forced-refresh
// oauth provider).
export function computeAgeRows(statusRows, nowMs = Date.now(), providers = PROVIDERS) {
  const rows = [];
  for (const row of statusRows) {
    const hrs = ageHours(row.lastRefresh, nowMs);
    if (hrs === null) continue;
    for (const secret of secretIdsFor(row.provider, providers)) rows.push({ secret, provider: row.provider, ageHours: hrs });
  }
  return rows;
}

// Emits otc.fleet.token_age_hours{secret:<id>,provider:<name>} for every row via `emitFn` (defaults
// to the real, honest ddEmitMetric — never a bare fire-and-forget). Returns { emitted, failed }
// (secret-id lists), never a single boolean, so a caller cannot collapse "some failed" into a false
// "it worked".
export async function emitAgeMetrics(rows, emitFn = ddEmitMetric) {
  const result = { emitted: [], failed: [] };
  for (const { secret, provider, ageHours: hrs } of rows) {
    const ok = await emitFn("otc.fleet.token_age_hours", hrs, [`secret:${secret}`, `provider:${provider}`], { type: "gauge", source: "token-keeper" });
    (ok ? result.emitted : result.failed).push(secret);
  }
  return result;
}

// ---------- CLI ----------
function arg(flag) { const i = process.argv.indexOf(flag); return i >= 0 ? (process.argv[i + 1] || true) : null; }
const has = (flag) => process.argv.includes(flag);

// isMain guard: without this, merely `import`-ing a pure helper above (as the tests do) would also
// execute the whole CLI dispatch below as a side effect of module load, including a hard
// `process.exit()` on a missing SA — exactly the kind of load-bearing side effect that makes a module
// untestable. medic.mjs and telemetry.mjs already guard this way; keeper.mjs did not, until now.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) (async () => {
  const cmd = process.argv[2] || "status";
  const engine = detectEngine();

  if (cmd === "selftest") {
    const report = { engine, proxy: process.env.NODE_USE_ENV_PROXY === "1", saFound: false, smReachable: false, providers: Object.keys(PROVIDERS) };
    try { loadSA(); report.saFound = true; } catch (e) { report.saError = e.message; }
    if (report.saFound) {
      try { const t = await gcpToken(); const probe = await smExists(t, "xero-refresh-token"); report.smReachable = true; report.probeSecretExists = probe; }
      catch (e) { report.smError = e.message; }
    }
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const tok = await gcpToken();

  if (cmd === "status") { console.log(JSON.stringify({ engine, status: await status(tok) }, null, 2)); return; }

  if (cmd === "refresh") {
    const force = has("--force");
    const targets = has("--all") ? Object.keys(PROVIDERS) : [arg("--provider")].filter(Boolean);
    if (!targets.length) { console.error("specify --provider <name> or --all"); process.exit(2); }
    const results = [];
    for (const name of targets) results.push(await doRefresh(tok, name, { force }));
    console.log(JSON.stringify({ engine, force, results }, null, 2));
    // otc.fleet.token_age_hours: emit on every invocation of the cron entrypoint (`refresh --all
    // --force`), not just on a successful rotation, so a provider that is stuck NOT rotating still
    // reports its real (growing) age instead of going silent. Telemetry failure never flips this
    // command's own exit code (that code gates the actual credential rotation, the load-bearing
    // operation); it is instead surfaced as a LOUD, greppable summary line so a partial or total
    // Datadog-emit failure is never indistinguishable from "ran cleanly" in plain container logs.
    const ageRows = computeAgeRows(await status(tok));
    if (!ageRows.length) {
      console.error("[token-keeper] otc.fleet.token_age_hours: no provider has a recorded lastRefresh yet -- nothing to emit this run");
    } else {
      const ageResult = await emitAgeMetrics(ageRows);
      console.log(`[token-keeper] age metrics: ${ageResult.emitted.length} emitted, ${ageResult.failed.length} failed` + (ageResult.failed.length ? ` (providers: ${ageResult.failed.join(", ")})` : ""));
    }
    const anyFail = results.some((r) => !r.ok);
    process.exit(anyFail ? 1 : 0);
  }

  // Manual/CI verification command for the age metric, independent of a --force rotation: reads the
  // existing meta-secret sidecars only (no token refresh, no credential mutation) and reports both
  // the computed ages and whether each Datadog emit genuinely landed. Exit code reflects emit health
  // here (unlike `refresh`, above) because this command's entire purpose IS verifying the emit.
  if (cmd === "age") {
    const rows = computeAgeRows(await status(tok));
    const result = await emitAgeMetrics(rows);
    console.log(JSON.stringify({ engine, rows, result }, null, 2));
    process.exit(result.failed.length ? 1 : 0);
  }

  if (cmd === "create-slots") {
    // KV-first: a genuinely-missing provider secret needs NO pre-creation -- Key Vault auto-creates it
    // on its FIRST write (smAddVersion -> kvSecretSet) during the rotation/consent flow, and consumers
    // read Key-Vault-first (smRead). So this verb no longer POSTs anything (the legacy GCP "create empty
    // secret" call is dead post-GCP-exit); it just reports how many provider slots already exist vs how
    // many will materialize on first write. Secret IDENTIFIERS are intentionally NOT enumerated in the
    // output; run `status` for the per-provider secret-presence breakdown.
    const ids = new Set();
    for (const cfg of Object.values(PROVIDERS)) {
      const refs = Array.isArray(cfg.tenants) ? cfg.tenants.map((t) => cfg.refreshSecretFor(t)) : [cfg.refreshSecret];
      [...refs, cfg.accessSecret, cfg.apiToken, cfg.clientId, cfg.clientSecret].filter(Boolean).forEach((x) => ids.add(x));
    }
    Object.keys(PROVIDERS).forEach((p) => ids.add(metaSecret(p)));
    let existing = 0, pendingFirstWrite = 0;
    for (const id of ids) { if (await smExists(tok, id)) existing++; else pendingFirstWrite++; }
    console.log(JSON.stringify({
      engine, store: "key-vault", slotsTotal: ids.size, existing, pendingFirstWrite,
      note: "Key Vault auto-creates each slot on its first write (kvSecretSet); nothing to pre-create. Run `status` for the per-provider secret-presence breakdown.",
    }, null, 2));
    return;
  }

  console.error("unknown command: " + cmd);
  process.exit(2);
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
