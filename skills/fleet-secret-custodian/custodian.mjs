#!/usr/bin/env node
/**
 * fleet-secret-custodian — autonomous secret-lifecycle custody for the OTCHealth fleet.
 *
 * TIER 1 of the CEO's 3-tier "CTO owns all secrets" directive (Matt, no ongoing human token
 * management). This is the audit + classification + autonomous-rotation engine, with a
 * tamper-evident audit trail for after-the-fact ACCOUNTABILITY — it never waits for approval.
 *
 * WHAT IT IS (and, as importantly, what it is NOT):
 *   - It BUILDS ON the existing primitives, it does not reinvent them:
 *       * Key Vault read/write  -> skills/kb-memory/azure-secret.mjs (kvSecret / kvSecretSet /
 *         requireSecrets / authMode) — managed-identity-first, SP fallback, never-throws-on-read.
 *       * OAuth refresh-token rotation -> skills/token-keeper (Xero 60d, QBO 100d) is the CANONICAL
 *         single writer for every OAuth-rotating credential. Per runbooks/CREDENTIAL-OWNERSHIP-MAP.md
 *         the fleet's #1 secret-lockout class is TWO writers on one rotating token (the Xero innd v474
 *         / dead-Stripe-MCP failure). The custodian therefore CLASSIFIES those secrets as
 *         `owner:token-keeper` and REFUSES to rotate them itself (fail-closed on category), so it can
 *         never become a second writer. It audits them; token-keeper rotates them.
 *
 * VERBS:
 *   node custodian.mjs audit    [--json]   read-only inventory + classification + hygiene findings.
 *                                          Safe to run anytime; NEVER mutates a secret. Writes ONE
 *                                          audit record to the tamper-evident log.
 *   node custodian.mjs report   [--json]   human-readable summary of the latest audit (counts by
 *                                          category, dead-secret candidates, missing-expiry gaps).
 *   node custodian.mjs rotate <secret-name> [--force] [--dry-run]
 *                                          execute rotation for a category-(a)/(b)-self secret.
 *                                          FAIL-CLOSED: refuses loudly if the secret is not in a
 *                                          custodian-rotatable category; verify-before-retire; keeps
 *                                          the prior Key Vault version enabled for a grace window so a
 *                                          bad new value is instantly rolled back. Dry-run by default
 *                                          unless --force (mirrors token-keeper's two-engine safety).
 *   node custodian.mjs rotate-due [--force] rotate every category-(a)/(b)-self secret older than the
 *                                          configured age threshold (the cron entrypoint).
 *   node custodian.mjs selftest            no writes: identity/KV reachability + audit-log writability.
 *
 * FAIL POSTURE (house convention, per synthetic-health-data fail-CLOSED vs kb-memory fail-OPEN):
 *   - `audit`/`report` are fail-OPEN on any single secret (a metadata-read miss degrades that one row
 *     to `unknown`, never aborts the whole inventory) — like kb-memory recall.
 *   - `rotate` is fail-CLOSED (like synthetic-health-data's de-identifier): any uncertainty ->
 *     do NOT rotate, exit non-zero, leave the old secret working. Never leave a half-rotated state.
 *
 * SECURITY: secret VALUES are never printed, logged, or written to the audit trail — only NAMES,
 * versions, timestamps, categories, and outcomes. Non-PHI ring. Apple/bank-gated + PHI secrets are
 * classified OUT OF SCOPE and are never touched.
 *
 * ENV (set in the Container Apps Job spec; none are secret values):
 *   AZURE_KEYVAULT_NAME        default kv-otc-55c84f6bef
 *   CUSTODIAN_STORAGE_ACCOUNT  Blob account for the tamper-evident audit log (see IaC / runbook;
 *                              passed as env, NOT hardcoded — confirm the exact account before deploy)
 *   CUSTODIAN_CONTAINER        default "secret-custodian-audit"
 *   GATEWAY_BASE_URL           default https://mcp.otchealth.app  (for the Cosmos work-ledger mirror)
 *   ROTATE_AGE_DAYS_APIKEY     default 90   (age threshold for API-key-class rotation; configurable)
 *   ROTATE_AGE_DAYS_DEFAULT    default 180  (fallback threshold for anything else custodian-rotatable)
 *   CUSTODIAN_GRACE_HOURS      default 24   (how long the retired KV version stays ENABLED for rollback)
 *   AZURE_SUBSCRIPTION_ID      required for category-(a) Azure-native rotation (ARM regenerateKey)
 *   GATEWAY_LEDGER_TOKEN       (optional) bearer for the work-ledger mirror; read from KV if unset
 */

import crypto from "node:crypto";
import { pathToFileURL } from "node:url";

const VAULT = process.env.AZURE_KEYVAULT_NAME || "kv-otc-55c84f6bef";
const KV_API = "7.4";
const AUDIT_CONTAINER = process.env.CUSTODIAN_CONTAINER || "secret-custodian-audit";
const GRACE_HOURS = Number(process.env.CUSTODIAN_GRACE_HOURS || 24);
const AGE_APIKEY = Number(process.env.ROTATE_AGE_DAYS_APIKEY || 90);
const AGE_DEFAULT = Number(process.env.ROTATE_AGE_DAYS_DEFAULT || 180);

// ───────────────────────────────────────────────────────────────────────────
// Auth — managed-identity-first, exactly the two-path pattern from
// skills/kb-memory/azure-secret.mjs (identity sidecar, then SP client_credentials).
// Re-implemented here (not imported) so the job stays a single self-contained file the
// Container Apps `git clone && node` entrypoint runs with zero install step — same as
// skills/fleet-backup/backup.mjs. Behaviour is intentionally identical to azure-secret.mjs.
// ───────────────────────────────────────────────────────────────────────────
const _tokCache = new Map(); // resource -> { tok, exp }

async function identityToken(resource) {
  const endpoint = process.env.IDENTITY_ENDPOINT;
  const header = process.env.IDENTITY_HEADER;
  if (!endpoint || !header) return null;
  try {
    const clientIdQS = process.env.AZURE_UAMI_CLIENT_ID ? `&client_id=${encodeURIComponent(process.env.AZURE_UAMI_CLIENT_ID)}` : "";
    const r = await fetch(`${endpoint}?resource=${encodeURIComponent(resource)}&api-version=2019-08-01${clientIdQS}`, {
      headers: { "x-identity-header": header },
    });
    if (!r.ok) return null;
    return (await r.json()).access_token || null;
  } catch { return null; }
}

async function spToken(resource) {
  const tenant = process.env.AZURE_SP_TENANT_ID;
  const cid = process.env.AZURE_SP_CLIENT_ID;
  const csec = process.env.AZURE_SP_CLIENT_SECRET;
  if (!tenant || !cid || !csec) return null;
  try {
    const r = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: cid, client_secret: csec, scope: `${resource}/.default` }),
    });
    return (await r.json()).access_token || null;
  } catch { return null; }
}

/** Token for a given Azure resource audience. Identity first, SP fallback. Cached per-resource. */
async function tokenFor(resource) {
  const now = Date.now();
  const c = _tokCache.get(resource);
  if (c && c.exp - now > 60_000) return c.tok;
  let tok = await identityToken(resource);
  if (!tok) tok = await spToken(resource);
  if (!tok) return null;
  _tokCache.set(resource, { tok, exp: now + 3600_000 });
  return tok;
}

const vaultToken = () => tokenFor("https://vault.azure.net");
const armToken = () => tokenFor("https://management.azure.com");
const blobToken = () => tokenFor("https://storage.azure.com");

// ───────────────────────────────────────────────────────────────────────────
// Key Vault data-plane: list, get-with-metadata, versions, set, enable/disable version.
// ───────────────────────────────────────────────────────────────────────────
function kvBase() { return `https://${VAULT}.vault.azure.net`; }

/** Enumerate every secret in the vault (names + attributes). Paginates nextLink. */
async function kvListSecrets() {
  const tok = await vaultToken();
  if (!tok) throw new Error(`no Key Vault token (identity+SP both unavailable) for ${VAULT}`);
  const out = [];
  let url = `${kvBase()}/secrets?api-version=${KV_API}&maxresults=25`;
  while (url) {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${tok}` } });
    if (!r.ok) throw new Error(`KV list failed: ${r.status} ${(await r.text()).slice(0, 200)}`);
    const j = await r.json();
    for (const s of j.value || []) out.push(s);
    url = j.nextLink || null;
  }
  return out;
}

/** Metadata for a secret's CURRENT version (attributes only; never the value). */
async function kvSecretMeta(name) {
  const tok = await vaultToken();
  if (!tok) return null;
  try {
    const r = await fetch(`${kvBase()}/secrets/${encodeURIComponent(name)}?api-version=${KV_API}`, { headers: { Authorization: `Bearer ${tok}` } });
    if (!r.ok) return null;
    return await r.json(); // { id, attributes:{created,updated,exp,nbf,enabled}, tags, contentType, ... }
  } catch { return null; }
}

/** Read a secret VALUE (used only during rotation to verify/compare; never logged). */
async function kvGetValue(name) {
  const tok = await vaultToken();
  if (!tok) return null;
  try {
    const r = await fetch(`${kvBase()}/secrets/${encodeURIComponent(name)}?api-version=${KV_API}`, { headers: { Authorization: `Bearer ${tok}` } });
    if (!r.ok) return null;
    const j = await r.json();
    return j.value == null ? null : String(j.value);
  } catch { return null; }
}

/** All versions of a secret (for grace-window rollback + last-rotated history). */
async function kvListVersions(name) {
  const tok = await vaultToken();
  if (!tok) return [];
  const out = [];
  let url = `${kvBase()}/secrets/${encodeURIComponent(name)}/versions?api-version=${KV_API}&maxresults=25`;
  while (url) {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${tok}` } });
    if (!r.ok) break;
    const j = await r.json();
    for (const v of j.value || []) out.push(v);
    url = j.nextLink || null;
  }
  return out;
}

/** Write a NEW version of a secret. Returns the new version's full metadata, or null. */
async function kvSetValue(name, value, { expUnix } = {}) {
  const tok = await vaultToken();
  if (!tok) return null;
  const body = { value: String(value) };
  if (expUnix) body.attributes = { exp: expUnix };
  try {
    const r = await fetch(`${kvBase()}/secrets/${encodeURIComponent(name)}?api-version=${KV_API}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

/** Enable/disable a SPECIFIC version (grace-window rollback control). versionId is the full KV id.
 *  Returns false (never throws) on a missing token (every Key Vault auth path unavailable) or any
 *  API/network failure -- callers MUST check this return value. A rollback caller that ignores it
 *  would report "rolled back" while the bad version could still be the live, readable one. */
async function kvSetVersionEnabled(versionId, enabled) {
  const tok = await vaultToken();
  if (!tok) return false;
  try {
    // versionId looks like https://<vault>.vault.azure.net/secrets/<name>/<ver>
    const r = await fetch(`${versionId}?api-version=${KV_API}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
      body: JSON.stringify({ attributes: { enabled } }),
    });
    return r.ok;
  } catch { return false; }
}

/**
 * Fail-safe wrapper around the rollback half of `kvSetVersionEnabled(id, false)`. This exists because
 * a rollback (disabling a bad/unaccounted new secret version) is itself an action that can fail for the
 * SAME reason the surrounding rotation is being rolled back in the first place -- e.g. every Key Vault
 * auth path (managed identity + SP client_credentials) is unavailable. Silently awaiting the disable call
 * and moving on would let the caller log "ROLLED_BACK" or otherwise imply safety was restored when the bad
 * version may STILL be enabled (an unversioned GET against a secret returns its newest-updated enabled
 * version). This wrapper makes that failure impossible to miss: it never returns a "looks fine" result
 * when the disable did not actually happen.
 * Returns { disabled: boolean, reason: string|null }.
 */
async function safeguardDisable(versionId, label) {
  if (!versionId) return { disabled: false, reason: "no version id to disable" };
  const disabled = await kvSetVersionEnabled(versionId, false);
  if (!disabled) {
    console.error(
      `[CRITICAL] could not disable ${label} (version ${versionId}) -- it may STILL be the enabled, ` +
      `readable Key Vault version. This happens when every Key Vault auth path (managed identity + SP ` +
      `client_credentials) is unavailable, or the API call itself failed. MANUAL ACTION REQUIRED: disable ` +
      `this version directly in Key Vault (or re-run once an auth path is restored).`,
    );
  }
  return { disabled, reason: disabled ? null : "kvSetVersionEnabled returned false (auth failure or API error); see the CRITICAL log line above" };
}

// ───────────────────────────────────────────────────────────────────────────
// Tamper-evident audit log — Blob append-only, hash-chained (WHY BLOB, see runbook):
//  * Cosmos is NOT reachable from this job's tool surface (no Cosmos data-plane role; the fleet
//    reaches the work-ledger only through the read-only gateway, which exposes no arbitrary-append).
//  * Blob supports a real immutability (WORM) time-based-retention policy at the container level —
//    that is what makes the trail genuinely tamper-EVIDENT rather than just tamper-discouraged.
//  * Each record carries the SHA-256 of the previous record (`prevHash`) so any deletion or edit
//    of a middle record breaks the chain and is detectable even without relying on the WORM policy.
// We ALSO mirror a one-line summary into the Cosmos work-ledger via the gateway `task_create`
// (best-effort, fail-open) so rotations are visible in the same place the rest of the fleet's work
// lands — but the Blob chain, not the mirror, is the authoritative accountability record.
//
// Layout: one append-only NDJSON blob per UTC day, custodian-audit/log-<date>.ndjson, via the
// Append Blob API (x-ms-blob-type: AppendBlob + the appendblock comp), so concurrent runs never
// clobber each other and history only ever grows.
// ───────────────────────────────────────────────────────────────────────────
function auditAccount() { return process.env.CUSTODIAN_STORAGE_ACCOUNT || null; }
function todayStamp() { return new Date().toISOString().slice(0, 10); }
function sha256Hex(s) { return crypto.createHash("sha256").update(s).digest("hex"); }

async function ensureAppendBlob(account, blobName) {
  const tok = await blobToken();
  if (!tok) throw new Error("no storage token for audit log");
  const url = `https://${account}.blob.core.windows.net/${AUDIT_CONTAINER}/${blobName}`;
  // HEAD first; only create if absent (PUT AppendBlob is not idempotent — it truncates).
  const head = await fetch(url, { method: "HEAD", headers: { Authorization: `Bearer ${tok}`, "x-ms-version": "2023-11-03" } });
  if (head.status === 200) return url;
  const put = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${tok}`,
      "x-ms-version": "2023-11-03",
      "x-ms-blob-type": "AppendBlob",
      "Content-Length": "0",
    },
  });
  if (!put.ok && put.status !== 409 /* already exists, race */) {
    throw new Error(`create append blob failed: ${put.status} ${(await put.text()).slice(0, 200)}`);
  }
  return url;
}

/** Read the last record's hash from today's log so the new record can chain onto it. */
async function lastHash(account, blobName) {
  const tok = await blobToken();
  if (!tok) return null;
  try {
    const url = `https://${account}.blob.core.windows.net/${AUDIT_CONTAINER}/${blobName}`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${tok}`, "x-ms-version": "2023-11-03" } });
    if (!r.ok) return null;
    const text = await r.text();
    const lines = text.trimEnd().split("\n").filter(Boolean);
    if (!lines.length) return null;
    const last = JSON.parse(lines[lines.length - 1]);
    return last.recordHash || null;
  } catch { return null; }
}

/**
 * Append one tamper-evident record. FAIL-CLOSED for rotate (a rotation that cannot be recorded is
 * treated by the caller as a failed rotation — accountability is not optional for a mutation);
 * best-effort for audit/report. Returns { ok, recordHash } or { ok:false, reason }.
 */
async function auditAppend(record) {
  const account = auditAccount();
  if (!account) return { ok: false, reason: "CUSTODIAN_STORAGE_ACCOUNT unset" };
  const blobName = `log-${todayStamp()}.ndjson`;
  try {
    await ensureAppendBlob(account, blobName);
    const prevHash = await lastHash(account, blobName);
    const enriched = { ...record, ts: new Date().toISOString(), prevHash };
    const canonical = JSON.stringify(enriched);
    const recordHash = sha256Hex((prevHash || "") + canonical);
    const line = JSON.stringify({ ...enriched, recordHash }) + "\n";

    const tok = await blobToken();
    const url = `https://${account}.blob.core.windows.net/${AUDIT_CONTAINER}/${blobName}?comp=appendblock`;
    const buf = Buffer.from(line, "utf8");
    const r = await fetch(url, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${tok}`,
        "x-ms-version": "2023-11-03",
        "Content-Length": String(buf.length),
      },
      body: buf,
    });
    if (!r.ok) return { ok: false, reason: `appendblock ${r.status} ${(await r.text()).slice(0, 160)}` };
    return { ok: true, recordHash };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

/** Best-effort mirror of a rotation summary into the Cosmos work-ledger (fail-open). */
async function ledgerMirror(summary) {
  const base = process.env.GATEWAY_BASE_URL || "https://mcp.otchealth.app";
  let bearer = process.env.GATEWAY_LEDGER_TOKEN || null;
  if (!bearer) bearer = await kvGetValue("gateway-bearer-token"); // may be null; that's fine
  if (!bearer) return { ok: false, reason: "no gateway token; mirror skipped" };
  try {
    const r = await fetch(`${base}/tools/task_create`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
      body: JSON.stringify({ title: summary.title, body: summary.body, owner: "fleet-secret-custodian", labels: ["secret-custody", summary.action] }),
    });
    return { ok: r.ok };
  } catch (e) { return { ok: false, reason: e.message }; }
}

// ───────────────────────────────────────────────────────────────────────────
// Classification — the heart of the design. Deterministic, name-pattern-driven, so `audit` needs
// NO secret values. Categories map 1:1 to the task brief:
//   a-azure-native     rotatable now via ARM regenerateKey (storage/cosmos/search/cognitive keys)
//   b-thirdparty-self  a vendor programmatic regenerate the CUSTODIAN can drive end-to-end
//   b-shortlived-better a static secret whose RIGHT answer is migrating to a short-lived-token
//                       architecture (e.g. GitHub App installation tokens) — flagged, not rotated
//   owner-token-keeper OAuth-rotating; token-keeper is the single writer (custodian must NOT rotate)
//   tier2-bootstrap    needs a one-time human/admin-consent bootstrap (Entra app secrets) before
//                       any automation can take over — the Tier-2 plan
//   tier3-out-of-scope permanently manual: Apple/bank/hardware-MFA-gated, or PHI-ring
//   public-nonsecret   publishable-by-design (DSNs, phc_ capture keys, endpoints, ids) — no rotation
//   unknown            could not classify from name; surfaced for human triage, never auto-rotated
// The rules below encode the fleet's actual secret registry (setup/fetch-secrets.mjs) +
// CREDENTIAL-OWNERSHIP-MAP.md. New secrets fall through to `unknown` (safe default), which `audit`
// reports so the map can be extended — it never silently guesses a secret is safe to rotate.
// ───────────────────────────────────────────────────────────────────────────
function classify(name) {
  const n = name.toLowerCase();

  // ---- public / non-secret by design: never rotate ----
  if (/(sentry-dsn|-sentry-dsn|posthog.*(project|capture)|-project-key|posthog-fleet|posthog-personal-api-key|phc_)/.test(n)) return cat("public-nonsecret", "Publishable-by-design (client-side / DSN / capture key). Rotation is pointless and can break shipped clients.");
  if (/(endpoint|-region|-host|-url|-id$|-client-id$|realm|-env$|-deployment$|-bucket$|-container$|-account$|-version$|-site$|app-installation-id)/.test(n) && !/secret|key|token|password|pat|refresh/.test(n)) return cat("public-nonsecret", "Non-secret configuration value (endpoint/id/region/version/name), not a credential.");

  // ---- Tier 3: permanently out of scope (Apple / bank / hardware-MFA / PHI) ----
  if (/(asc[-_]|apple|_p8$|-p8$|-p8-|keystore|\.p8|medreview|companion|phi)/.test(n)) return cat("tier3-out-of-scope", "Apple/hardware-MFA or PHI-ring credential. Rotation requires human/hardware interaction; permanently manual per Matt's directive.");
  if (/(mercury-api-token|plaid-access-token|plaid-secret|plaid-client)/.test(n)) return cat("tier3-out-of-scope", "Bank-aggregator credential. Bank linking is a human hard-gate (Matt 2026-06-21); custodian never rotates.");

  // ---- OAuth-rotating: token-keeper / xero.mjs are the single canonical writer ----
  if (/(xero-refresh-token|qbo-refresh|quickbooks-refresh|gmail-refresh-token|amzn-sp-refresh-token|-refresh-token$|-refresh-)/.test(n)) return cat("owner-token-keeper", "OAuth-rotating refresh token. CREDENTIAL-OWNERSHIP-MAP requires ONE writer (token-keeper/xero.mjs). Custodian AUDITS but never rotates — a second writer causes the invalid_grant lockout class.");
  if (/(xero-access-token|qbo-access|quickbooks-access|-access-token$)/.test(n)) return cat("owner-token-keeper", "Short-lived OAuth access token minted from a refresh token by its skill. Not independently rotated.");

  // ---- Entra / Azure AD app client secrets: Tier-2 bootstrap ----
  if (/(graph-mail-client-secret|graph-sites-client-secret|gmail-oauth-client-secret|miro-client-secret|azure-sp-client-secret|-client-secret$)/.test(n)) return cat("tier2-bootstrap", "Entra/OAuth app client secret. Programmatic rotation needs the app's own Graph/app-registration credential + (for some) a one-time admin-consent bootstrap — the Tier-2 plan. Not auto-rotatable in Tier 1.");

  // ---- GitHub: the short-lived-beats-rotation exemplar ----
  if (/(github-app-private-key|github-app)/.test(n)) return cat("b-shortlived-better", "GitHub App private key: installation tokens are ALREADY minted programmatically and auto-expire hourly (skills/github-app). The PEM itself is long-lived but rarely used directly; the RIGHT lifecycle answer is the existing short-lived-token pattern, not periodic PEM rotation. Flag, don't auto-rotate.");
  if (/(github-user-pat|-pat$|github.*token)/.test(n)) return cat("b-shortlived-better", "Static GitHub PAT. RECOMMENDED: migrate the caller to the GitHub App installation-token pattern (already in the fleet) which auto-expires hourly and eliminates the rotation problem. Custodian flags this migration rather than rotating a PAT it cannot regenerate without GitHub UI/MFA.");

  // ---- Azure-native data-plane keys: rotatable NOW via ARM regenerateKey ----
  if (/(-storage-key$|storage-account-key)/.test(n)) return cat("a-azure-native", "Azure Storage account key. Rotatable via ARM Storage `regenerateKey` (key1/key2 dual-key swap) — the textbook zero-downtime rotation. Needs Storage Account Key Operator RBAC on the target account.", { arm: "storage" });
  if (/(cosmos.*key|-cosmos-)/.test(n)) return cat("a-azure-native", "Azure Cosmos DB key. Rotatable via ARM Cosmos `regenerateKey` (primary/secondary swap).", { arm: "cosmos" });
  if (/(azure-search-admin-key|search-admin-key)/.test(n)) return cat("a-azure-native", "Azure AI Search admin key. Rotatable via ARM Search `regenerateAdminKey` (primary/secondary).", { arm: "search" });
  if (/(azure-openai-key|azure-docintel-key|azure-foundry-key|azure-speech-key|cognitive.*key|-cognitive-)/.test(n)) return cat("a-azure-native", "Azure Cognitive Services / OpenAI key. Rotatable via ARM CognitiveServices `regenerateKey` (Key1/Key2).", { arm: "cognitiveservices" });

  // ---- third-party API keys the vendor lets you regenerate via API but NOT cleanly end-to-end ----
  if (/(stripe-secret-key|stripe-webhook-secret)/.test(n)) return cat("tier2-bootstrap", "Stripe key. Stripe supports rolling restricted keys via API, but the fleet's key is the account secret key managed on the gateway env (single-writer = gateway thread). Safe autonomous rotation needs a restricted-key architecture first (Tier-2), not a blind roll of the live account key.");
  if (/(cloudflare-api-token|cloudflare.*token)/.test(n)) return cat("tier2-bootstrap", "Cloudflare API token. Cloudflare exposes a token `roll` endpoint, but rolling the very token you authenticate with is a bootstrap problem; needs a dedicated rotation-scoped token provisioned first (Tier-2).");
  if (/(sentry-auth-token|datadog-app-key|datadog-api-key|netlify-token|railway-token|n8n-api-key|greptile-token|replicate-api-token|make-api-token|daytona-api-key|context7-api-key|govinfo-api-key|legal-courtlistener|massive-api-key|depot-token|recraft-api-key|elevenlabs-api-key|openai-api-key|fourvault-gemini-api-key|amzn-lwa-client-secret|miro-token)/.test(n)) return cat("tier2-bootstrap", "Third-party API key. Most of these vendors have NO programmatic self-rotation endpoint (or gate it behind dashboard/MFA). Rotation stays a Tier-2 item: either adopt the vendor's short-lived-token option where one exists, or a scripted dashboard flow via browser-agent. Not auto-rotatable in Tier 1.");

  // ---- infra / keystone: explicitly do-not-touch ----
  if (/(claude-driver|gcp.*sa|_sa_json|gateway-bearer-token|oauth-token-signing-secret|oauth-client-secret|copilot-agent-token|token-signing)/.test(n)) return cat("tier2-bootstrap", "Keystone/infra credential (SA key, gateway signing/bearer). Rotating these is high-blast-radius and coupled to the gateway/identity bootstrap; owned by the gateway thread. Tier-2 with an explicit cutover plan, never a blind cron rotation.");
  if (/(neon-database-url|database-url|-connection-string|connstring)/.test(n)) return cat("tier2-bootstrap", "Database connection string / URL embedding a credential. Rotatable only in lockstep with the DB's own credential rotation; needs a coordinated plan (Tier-2).");

  return cat("unknown", "Unclassified secret name. Surfaced for human triage; custodian will NEVER auto-rotate an unknown secret (fail-closed).");
}
function cat(category, rationale, extra = {}) { return { category, rationale, ...extra }; }

const ROTATABLE_BY_CUSTODIAN = new Set(["a-azure-native"]); // Tier-1 autonomous scope (see runbook)

// ───────────────────────────────────────────────────────────────────────────
// Inventory + hygiene
// ───────────────────────────────────────────────────────────────────────────
function daysSince(iso) { if (!iso) return null; return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000); }
function unixToIso(u) { return u ? new Date(u * 1000).toISOString() : null; }

async function buildInventory() {
  const secrets = await kvListSecrets(); // throws if the vault is entirely unreachable (fail-loud)
  const rows = [];
  for (const s of secrets) {
    // s.id = https://<vault>.vault.azure.net/secrets/<name>
    const name = decodeURIComponent(s.id.split("/secrets/")[1].split("/")[0]);
    const attrs = s.attributes || {};
    const created = unixToIso(attrs.created);
    const updated = unixToIso(attrs.updated); // Key Vault's native "last-rotated" signal
    const exp = unixToIso(attrs.exp);
    const cls = classify(name);
    rows.push({
      name,
      enabled: attrs.enabled !== false,
      created,
      lastRotated: updated,           // KV updates `updated` on every new version
      ageDays: daysSince(updated || created),
      expiry: exp,
      hasExpiry: Boolean(exp),
      category: cls.category,
      rationale: cls.rationale,
      arm: cls.arm || null,
      custodianRotatable: ROTATABLE_BY_CUSTODIAN.has(cls.category),
    });
  }
  return rows;
}

/** USAGE cross-reference is done by the caller/CI (GitHub code-search) and passed in; the runtime
 *  job records only what it can see live. `audit` emits the list of names so a follow-up code-search
 *  step (or the runbook's documented one) can flag dead-secret candidates. We also flag the two
 *  hygiene gaps the brief calls out directly from KV metadata: missing-expiry + very-old age. */
function hygiene(rows) {
  const missingExpiry = rows.filter((r) => !r.hasExpiry && r.category !== "public-nonsecret").map((r) => r.name);
  const staleApiKeys = rows.filter((r) => r.ageDays != null && r.ageDays > AGE_APIKEY && (r.category === "a-azure-native" || r.category === "tier2-bootstrap")).map((r) => ({ name: r.name, ageDays: r.ageDays }));
  const disabled = rows.filter((r) => !r.enabled).map((r) => r.name);
  const unknown = rows.filter((r) => r.category === "unknown").map((r) => r.name);
  return { missingExpiry, staleApiKeys, disabled, unknownClassification: unknown };
}

function summarize(rows) {
  const byCat = {};
  for (const r of rows) byCat[r.category] = (byCat[r.category] || 0) + 1;
  return { total: rows.length, byCategory: byCat, custodianRotatableNow: rows.filter((r) => r.custodianRotatable).length };
}

// ───────────────────────────────────────────────────────────────────────────
// audit / report
// ───────────────────────────────────────────────────────────────────────────
async function audit({ json }) {
  let rows;
  try {
    rows = await buildInventory();
  } catch (e) {
    console.error(`[FATAL] cannot read Key Vault ${VAULT}: ${e.message}. Refusing to emit a partial inventory as if complete.`);
    process.exit(78);
  }
  const summary = summarize(rows);
  const gaps = hygiene(rows);
  const record = { action: "audit", vault: VAULT, authMode: _tokCache.has("https://vault.azure.net") ? "resolved" : "none", summary, gaps, names: rows.map((r) => r.name) };
  const logged = await auditAppend(record);
  const out = { ...record, rows, auditLog: logged };
  if (json) { console.log(JSON.stringify(out, null, 2)); return; }
  printReport(out);
}

async function report({ json }) {
  // report re-runs the read-only inventory (cheap) and prints the human view. Identical data source
  // to audit; kept as a separate verb so a human can ask for the summary without writing a new
  // audit record (report does NOT append to the log — it's a pure read).
  let rows;
  try { rows = await buildInventory(); } catch (e) { console.error(`[FATAL] cannot read Key Vault: ${e.message}`); process.exit(78); }
  const out = { action: "report", vault: VAULT, summary: summarize(rows), gaps: hygiene(rows), rows };
  if (json) { console.log(JSON.stringify(out, null, 2)); return; }
  printReport(out);
}

function printReport(out) {
  const s = out.summary, g = out.gaps;
  console.log(`\n=== fleet-secret-custodian — ${out.action} — vault ${out.vault} ===`);
  console.log(`Total secrets: ${s.total}`);
  console.log(`Custodian-rotatable NOW (Tier-1, category a-azure-native): ${s.custodianRotatableNow}`);
  console.log(`\nBy category:`);
  for (const [c, n] of Object.entries(s.byCategory).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(3)}  ${c}`);
  console.log(`\nHygiene findings:`);
  console.log(`  missing-expiry (real gap, ${g.missingExpiry.length}): ${g.missingExpiry.join(", ") || "none"}`);
  console.log(`  stale (> ${AGE_APIKEY}d, ${g.staleApiKeys.length}): ${g.staleApiKeys.map((x) => `${x.name}(${x.ageDays}d)`).join(", ") || "none"}`);
  console.log(`  disabled versions (${g.disabled.length}): ${g.disabled.join(", ") || "none"}`);
  console.log(`  UNCLASSIFIED — human triage (${g.unknownClassification.length}): ${g.unknownClassification.join(", ") || "none"}`);
  console.log(`\nRun \`report --json\` for the full per-secret table.`);
  console.log(`(Dead-secret cross-reference: run the GitHub code-search step in RUNBOOK-fleet-secret-custodian.md against the emitted \`names\` list.)\n`);
}

// ───────────────────────────────────────────────────────────────────────────
// rotate — FAIL-CLOSED. Only category a-azure-native is Tier-1 autonomous.
//   1. Classify the target. If not custodian-rotatable -> refuse, exit non-zero. (never guesses)
//   2. Dry-run unless --force (two-engine safety, mirrors token-keeper).
//   3. Azure-native: ARM regenerateKey on the SECONDARY key -> read the new secondary -> write it as
//      a NEW Key Vault version -> VERIFY the new version reads back and is enabled -> only THEN
//      leave the prior version enabled for CUSTODIAN_GRACE_HOURS (rollback window). We rotate the
//      *secondary* first so any consumer still pinned to the primary keeps working during the swap;
//      the follow-up run rotates primary once consumers have picked up secondary. This is the
//      standard zero-downtime dual-key dance and is why we NEVER leave a half-rotated state.
//   4. Record the outcome in the tamper-evident log BEFORE returning success. If the audit append
//      fails, the rotation is reported as FAILED (accountability is mandatory for a mutation).
// NOTE: the actual ARM regenerateKey call requires AZURE_SUBSCRIPTION_ID + the resource id, which is
// resolved from the secret's `tags` (see runbook: each rotatable secret must be tagged with its
// source resourceId at provisioning). Without that tag the rotate FAILS CLOSED with a clear message
// rather than guessing which Azure resource a key belongs to.
// ───────────────────────────────────────────────────────────────────────────
async function armRegenerateKey(resourceId, armKind) {
  const tok = await armToken();
  if (!tok) return { ok: false, reason: "no ARM token (need AZURE_SP_* or an identity with the resource's Key Operator role)" };
  const map = {
    storage: { path: "listKeys", regen: "regenerateKey", apiVersion: "2023-05-01", body: { keyName: "key2" }, read: (j) => (j.keys || []).find((k) => k.keyName === "key2")?.value },
    cosmos: { path: "listKeys", regen: "regenerateKey", apiVersion: "2024-05-15", body: { keyKind: "secondary" }, read: null },
    search: { path: "listAdminKeys", regen: "regenerateAdminKey/secondary", apiVersion: "2023-11-01", body: {}, read: (j) => j.secondaryKey },
    cognitiveservices: { path: "listKeys", regen: "regenerateKey", apiVersion: "2023-05-01", body: { keyName: "Key2" }, read: (j) => j.key2 },
  };
  const m = map[armKind];
  if (!m) return { ok: false, reason: `unsupported arm kind ${armKind}` };
  try {
    const base = `https://management.azure.com${resourceId}`;
    const regenUrl = `${base}/${m.regen}?api-version=${m.apiVersion}`;
    const rr = await fetch(regenUrl, { method: "POST", headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" }, body: JSON.stringify(m.body) });
    if (!rr.ok) return { ok: false, reason: `regenerate ${rr.status} ${(await rr.text()).slice(0, 200)}` };
    let newVal = m.read ? m.read(await rr.json().catch(() => ({}))) : null;
    if (!newVal) {
      // some regenerate endpoints return the full key list; others require a follow-up listKeys
      const lr = await fetch(`${base}/${m.path}?api-version=${m.apiVersion}`, { method: "POST", headers: { Authorization: `Bearer ${tok}` } });
      if (!lr.ok) return { ok: false, reason: `listKeys ${lr.status}` };
      const lj = await lr.json();
      newVal = m.read ? m.read(lj) : (lj.secondaryMasterKey || lj.primaryMasterKey);
    }
    if (!newVal) return { ok: false, reason: "regenerated but could not read the new key value back" };
    return { ok: true, newVal };
  } catch (e) { return { ok: false, reason: e.message }; }
}

async function rotate(name, { force, dryRun }) {
  const cls = classify(name);
  const trigger = process.env.CUSTODIAN_TRIGGER || "manual";

  // (1) FAIL-CLOSED category gate.
  if (!ROTATABLE_BY_CUSTODIAN.has(cls.category)) {
    const msg = `refusing to rotate '${name}': category '${cls.category}' is not custodian-rotatable in Tier 1. ${cls.rationale}`;
    console.error(`[BLOCKED] ${msg}`);
    await auditAppend({ action: "rotate", result: "BLOCKED", secret: name, category: cls.category, reason: cls.rationale, trigger });
    process.exit(3);
  }

  const meta = await kvSecretMeta(name);
  if (!meta) { console.error(`[FATAL] '${name}' has no readable Key Vault metadata; cannot rotate safely.`); await auditAppend({ action: "rotate", result: "FAILED", secret: name, reason: "no KV metadata", trigger }); process.exit(78); }
  const resourceId = meta.tags?.resourceId || null;
  if (!resourceId) { console.error(`[FATAL] '${name}' is missing the required tag 'resourceId' (source Azure resource). Tag it at provisioning; refusing to guess.`); await auditAppend({ action: "rotate", result: "FAILED", secret: name, reason: "missing resourceId tag", trigger }); process.exit(78); }

  if (!force || dryRun) {
    console.log(JSON.stringify({ action: "rotate", dryRun: true, secret: name, category: cls.category, arm: cls.arm, resourceId, note: "would ARM-regenerate secondary key -> new KV version -> verify -> grace-window prior version. Use --force to execute." }, null, 2));
    return;
  }

  // (2) capture the current version so we can guarantee rollback.
  const priorVersionId = meta.id; // full versioned id of the current secret

  // (3) ARM regenerate the SECONDARY key and read it back.
  const regen = await armRegenerateKey(resourceId, cls.arm);
  if (!regen.ok) {
    console.error(`[FAILED] ARM regenerate for '${name}': ${regen.reason}. Old secret untouched (fail-closed).`);
    await auditAppend({ action: "rotate", result: "FAILED", secret: name, category: cls.category, reason: regen.reason, trigger });
    process.exit(1);
  }

  // (4) write the new value as a NEW KV version.
  const newVer = await kvSetValue(name, regen.newVal);
  if (!newVer) {
    console.error(`[FAILED] wrote regenerated key to Azure but could not persist to Key Vault '${name}'. MANUAL ATTENTION: the Azure secondary key was regenerated; re-run once KV is writable. Old KV version still valid.`);
    await auditAppend({ action: "rotate", result: "FAILED", secret: name, reason: "KV write failed after ARM regenerate", trigger });
    process.exit(1);
  }

  // (5) VERIFY the new version reads back (never retire the old until the new is proven).
  const readback = await kvGetValue(name);
  const verified = readback != null && readback === regen.newVal;
  if (!verified) {
    console.error(`[FAILED] new KV version for '${name}' did not verify on readback. Disabling the new version and keeping the prior version active (fail-closed rollback).`);
    // Never assume the rollback itself succeeded: safeguardDisable() only reports "disabled" when the
    // Key Vault PATCH is actually confirmed ok -- if EVERY auth path failed (or the API call errored),
    // the audit record says so explicitly (ROLLBACK_FAILED) instead of the misleading ROLLED_BACK.
    const sg = await safeguardDisable(newVer.id, `the unverified new version of '${name}'`);
    await auditAppend({
      action: "rotate",
      result: sg.disabled ? "ROLLED_BACK" : "ROLLBACK_FAILED",
      secret: name,
      reason: sg.disabled ? "readback verify failed" : `readback verify failed AND rollback disable also failed (${sg.reason})`,
      priorVersionId, newVersionId: newVer.id, trigger,
    });
    process.exit(1);
  }

  // (6) SUCCESS. Prior KV version stays ENABLED for the grace window (rollback safety); we record the
  // retire-at time rather than disabling immediately, so a consumer still holding the old value has a
  // window. A later run (or the grace-sweep) disables versions past their retireAt.
  const retireAt = new Date(Date.now() + GRACE_HOURS * 3600_000).toISOString();
  const rec = { action: "rotate", result: "SUCCESS", secret: name, category: cls.category, arm: cls.arm, resourceId, priorVersionId, newVersionId: newVer.id, priorVersionRetireAt: retireAt, graceHours: GRACE_HOURS, trigger };
  const logged = await auditAppend(rec);
  if (!logged.ok) {
    // accountability is mandatory for a mutation: if we cannot record it, treat as failed and roll back.
    console.error(`[FAILED] rotation succeeded but the tamper-evident audit append FAILED (${logged.reason}). Rolling back to the prior version to preserve the never-unaccounted-mutation invariant.`);
    // Same rule as the readback-failure branch above: do not assume the disable worked. If it also
    // failed, this is now the worst case (an unaccounted-for, un-rolled-back new version) -- say so
    // loudly rather than exiting 1 with no signal of which failure mode actually occurred.
    const sg = await safeguardDisable(newVer.id, `the unaccounted new version of '${name}' (audit append also failed)`);
    if (!sg.disabled) {
      console.error(`[CRITICAL] rollback ALSO failed for '${name}': the new version may remain enabled with NO audit record of the rotation. Highest-priority manual follow-up.`);
    }
    process.exit(1);
  }
  await ledgerMirror({ action: "rotate", title: `secret rotated: ${name}`, body: `fleet-secret-custodian rotated ${name} (${cls.arm}); prior version retires ${retireAt}; auditHash ${logged.recordHash}` });
  console.log(JSON.stringify({ ...rec, auditHash: logged.recordHash }, null, 2));
}

async function rotateDue({ force }) {
  let rows;
  try { rows = await buildInventory(); } catch (e) { console.error(`[FATAL] ${e.message}`); process.exit(78); }
  const due = rows.filter((r) => r.custodianRotatable && r.ageDays != null && r.ageDays >= (r.category === "a-azure-native" ? AGE_APIKEY : AGE_DEFAULT));
  console.log(`[rotate-due] ${due.length} custodian-rotatable secret(s) over threshold (${AGE_APIKEY}d):`, due.map((r) => `${r.name}(${r.ageDays}d)`).join(", ") || "none");
  const results = [];
  for (const r of due) {
    try { await rotate(r.name, { force, dryRun: !force }); results.push({ name: r.name, ok: true }); }
    catch (e) { results.push({ name: r.name, ok: false, err: e.message }); }
  }
  if (!due.length) console.log("[rotate-due] nothing due; exiting clean.");
}

async function selftest() {
  const report = {
    vault: VAULT,
    identityPresent: Boolean(process.env.IDENTITY_ENDPOINT && process.env.IDENTITY_HEADER),
    spPresent: Boolean(process.env.AZURE_SP_CLIENT_ID && process.env.AZURE_SP_CLIENT_SECRET && process.env.AZURE_SP_TENANT_ID),
    kvListReachable: false, secretCount: null, auditLogWritable: false, armTokenReachable: false,
  };
  try { const s = await kvListSecrets(); report.kvListReachable = true; report.secretCount = s.length; } catch (e) { report.kvError = e.message; }
  report.armTokenReachable = Boolean(await armToken());
  const probe = await auditAppend({ action: "selftest", note: "reachability probe (no secret touched)" });
  report.auditLogWritable = probe.ok; if (!probe.ok) report.auditError = probe.reason;
  console.log(JSON.stringify(report, null, 2));
}

// ───────────────────────────────────────────────────────────────────────────
// exported for tests: the pure/near-pure pieces (auth-fallback resolvers + the classifier + the
// fail-safe rollback wrapper) so a test can exercise "every auth path failed" without needing real
// network or credentials, and without executing the CLI dispatch below (guarded by isMain, same
// pattern as skills/fleet-medic/medic.mjs and skills/github-app/gh-app.mjs).
export { identityToken, spToken, tokenFor, kvSetVersionEnabled, safeguardDisable, classify, ROTATABLE_BY_CUSTODIAN };

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const cmd = process.argv[2] || "audit";
  const flags = new Set(process.argv.slice(3).filter((a) => a.startsWith("--")));
  const positional = process.argv.slice(3).filter((a) => !a.startsWith("--"));
  const opts = { json: flags.has("--json"), force: flags.has("--force"), dryRun: flags.has("--dry-run") };

  (async () => {
    if (cmd === "audit") return audit(opts);
    if (cmd === "report") return report(opts);
    if (cmd === "selftest") return selftest();
    if (cmd === "rotate") {
      if (!positional[0]) { console.error("usage: node custodian.mjs rotate <secret-name> [--force]"); process.exit(2); }
      return rotate(positional[0], opts);
    }
    if (cmd === "rotate-due") return rotateDue(opts);
    console.error(`unknown command '${cmd}'. usage: node custodian.mjs <audit|report|rotate <name>|rotate-due|selftest> [--json] [--force] [--dry-run]`);
    process.exit(2);
  })().catch((e) => { console.error("ERR", e.message); process.exit(1); });
}
