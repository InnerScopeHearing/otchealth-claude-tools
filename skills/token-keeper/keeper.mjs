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
  const sa = loadSA();
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
  const r = await fetch(`${SM}/projects/${PROJECT}/secrets/${id}/versions/latest:access`, {
    headers: { Authorization: `Bearer ${tok}` },
  });
  if (r.status === 404) return null;
  const j = await r.json();
  if (!j.payload) return null;
  return Buffer.from(j.payload.data, "base64").toString("utf8").trim();
}
async function smExists(tok, id) {
  const r = await fetch(`${SM}/projects/${PROJECT}/secrets/${id}`, { headers: { Authorization: `Bearer ${tok}` } });
  return r.status === 200;
}
async function smCreate(tok, id) {
  const r = await fetch(`${SM}/projects/${PROJECT}/secrets?secretId=${id}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
    body: JSON.stringify({ replication: { automatic: {} }, labels: { owner: "token-keeper", ring: "cfo" } }),
  });
  return { status: r.status, body: await r.text() };
}
async function smAddVersion(tok, id, value) {
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
    clientId: "quickbooks-client-id",
    clientSecret: "quickbooks-client-secret",
    refreshSecret: "quickbooks-refresh-token", // rotates (100d window)
    accessSecret: "quickbooks-access-token",
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
async function refreshOAuth(tok, name, cfg, { force }) {
  const [clientId, clientSecret, refreshTokenVal] = await Promise.all([
    smRead(tok, cfg.clientId), smRead(tok, cfg.clientSecret), smRead(tok, cfg.refreshSecret),
  ]);
  const missing = [];
  if (!clientId) missing.push(cfg.clientId);
  if (!clientSecret) missing.push(cfg.clientSecret);
  if (!refreshTokenVal) missing.push(cfg.refreshSecret);
  if (missing.length) return { provider: name, ok: false, reason: "MISSING_SECRETS", missing };
  if (!force) return { provider: name, ok: true, dryRun: true, note: "would refresh + rotate (use --force)" };

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
    return { provider: name, ok: false, reason: "REFRESH_FAILED", status: r.status, detail: (j.error || JSON.stringify(j)).toString().slice(0, 160) };
  }
  // CRITICAL: persist the ROTATED refresh token (this is the bit everyone forgets).
  const writes = [];
  if (j.refresh_token && j.refresh_token !== refreshTokenVal) {
    writes.push(smAddVersion(tok, cfg.refreshSecret, j.refresh_token));
  }
  writes.push(smAddVersion(tok, cfg.accessSecret, j.access_token));
  writes.push(smAddVersion(tok, metaSecret(name), JSON.stringify({ lastRefresh: new Date().toISOString(), expiresIn: j.expires_in || null, rotated: !!j.refresh_token })));
  const res = await Promise.all(writes);
  const bad = res.find((x) => x.status >= 300);
  if (bad) return { provider: name, ok: false, reason: "PERSIST_FAILED", status: bad.status, detail: bad.body.slice(0, 160) };
  return { provider: name, ok: true, rotated: !!(j.refresh_token && j.refresh_token !== refreshTokenVal), accessExpiresIn: j.expires_in || null };
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
    const ids = [cfg.refreshSecret, cfg.accessSecret, cfg.apiToken, cfg.clientId, cfg.clientSecret].filter(Boolean);
    const present = {};
    for (const id of ids) present[id] = await smExists(tok, id);
    let meta = null;
    try { const m = await smRead(tok, metaSecret(name)); if (m) meta = JSON.parse(m); } catch {}
    out.push({ provider: name, kind: cfg.kind, secretsPresent: present, lastRefresh: meta?.lastRefresh || null });
  }
  return out;
}

// ---------- CLI ----------
function arg(flag) { const i = process.argv.indexOf(flag); return i >= 0 ? (process.argv[i + 1] || true) : null; }
const has = (flag) => process.argv.includes(flag);

(async () => {
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
    const anyFail = results.some((r) => !r.ok);
    process.exit(anyFail ? 1 : 0);
  }

  if (cmd === "create-slots") {
    // idempotent: create the empty SM secrets (NAMES only) so consent flows have a place to write.
    const created = [], existed = [], failed = [];
    const ids = new Set();
    for (const cfg of Object.values(PROVIDERS)) {
      [cfg.refreshSecret, cfg.accessSecret, cfg.apiToken, cfg.clientId, cfg.clientSecret].filter(Boolean).forEach((x) => ids.add(x));
    }
    Object.keys(PROVIDERS).forEach((p) => ids.add(metaSecret(p)));
    for (const id of ids) {
      if (await smExists(tok, id)) { existed.push(id); continue; }
      const res = await smCreate(tok, id);
      if (res.status < 300) created.push(id); else failed.push({ id, status: res.status, detail: res.body.slice(0, 120) });
    }
    console.log(JSON.stringify({ engine, created, existed, failed }, null, 2));
    return;
  }

  console.error("unknown command: " + cmd);
  process.exit(2);
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
