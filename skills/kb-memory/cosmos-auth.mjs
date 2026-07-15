// cosmos-auth.mjs -- shared Cosmos DB for NoSQL Authorization-header builder for the fleet's 4
// background-job Cosmos REST clients:
//   - skills/kb-memory/cosmos-memory-read.mjs
//   - skills/decision-clock/cosmos-client.mjs
//   - skills/signal-radar/common.mjs
//   - skills/doc-indexer/job/agent-state-janitor.mjs
// All four talk to the SAME agent-state Cosmos account (cosmos-otc-agentstate-55c84, database
// "agent-state") that otchealth-mcp-server's src/agentstate/cosmos.ts (the gateway) already talks
// to. This is the Phase 5 Cosmos-migration follow-on: the gateway already got a COSMOS_AUTH_MODE=
// key|aad flag (see that file's header comment, merged); this module gives the 4 job clients the
// SAME flag, with the same two auth shapes, so they can move off the Cosmos master key onto the
// Container Apps Jobs' own managed identity (UAMI id-otc-jobs-kv, clientId
// 01b82248-86b1-4237-a8f3-8317cf9d5f33), which now holds "Cosmos DB Built-in Data Contributor" on
// the account (granted alongside the gateway's own managed identity, same rollout).
//
// INERT BY DEFAULT: COSMOS_AUTH_MODE unset (or 'key') is BYTE-FOR-BYTE every one of the 4 callers'
// PRE-EXISTING master-key HMAC behavior -- nothing about what ships changes until an operator
// deliberately sets COSMOS_AUTH_MODE=aad on a job's Container Apps env (Matt-gated; disableLocalAuth
// on the Cosmos account stays FALSE regardless of this file -- the master key keeps working as the
// fallback for as long as that is true).
//
// key mode (default) auth -- do NOT "tidy" the casing, it is load-bearing (matches
// otchealth-mcp-server's cosmos.ts and all 4 of this repo's pre-existing Cosmos clients
// byte-for-byte):
//   stringToSign = verb.toLowerCase() + "\n" + resType.toLowerCase() + "\n" +
//                  resourceLink + "\n" + date.toLowerCase() + "\n" + "" + "\n"
//   sig = base64( HMAC-SHA256( base64decode(masterKey), stringToSign ) )
//   Authorization = urlencode("type=master&ver=1.0&sig=" + sig)
// resourceLink keeps its original case (db/container/doc ids are case-sensitive).
//
// aad mode auth -- mirrors otchealth-mcp-server's cosmos.ts aadAuthToken() exactly: no HMAC, no
// string-to-sign, the whole Authorization value IS the bearer token:
//   Authorization = urlencode("type=aad&ver=1.0&sig=" + <raw AAD access token>)
// The token is minted from THIS PROCESS'S OWN Container Apps Job MSI sidecar endpoint
// (IDENTITY_ENDPOINT / IDENTITY_HEADER, Azure-injected automatically whenever a user- or
// system-assigned identity is attached to the Job) against the resource https://cosmos.azure.com --
// the same first-party Cosmos App ID URI the gateway's own miToken() uses, NOT a per-account
// https://<account>.documents.azure.com audience. The client_id query param pins the mint to the
// JOBS user-assigned identity specifically (default 01b82248-86b1-4237-a8f3-8317cf9d5f33, i.e.
// id-otc-jobs-kv; override with AZURE_JOBS_UAMI_CLIENT_ID -- deliberately a DIFFERENT env var from
// azure-secret.mjs's AZURE_UAMI_CLIENT_ID, which is a Key-Vault-token concern, not a Cosmos-data-plane
// one, even though today they happen to name the same physical identity) so a Job with more than one
// identity attached still mints for the right one. x-ms-version stays 2018-12-31 in both modes.
//
// DUAL-CONTEXT FALLBACK (read before setting COSMOS_AUTH_MODE=aad anywhere but a job): aad mode only
// makes sense INSIDE a Container Apps Job, where the platform injects IDENTITY_ENDPOINT/
// IDENTITY_HEADER for the job's attached identity. An interactive Claude Code session (or any other
// non-job context -- a laptop, Hyperagent, a local dev run of one of these skills) has no such
// sidecar. So this module distinguishes two different situations:
//   1. "aad requested, no identity sidecar present at all" -- an ENVIRONMENT-SHAPE fact, checked
//      BEFORE attempting anything (hasIdentitySidecar()). This silently falls back to key mode, so
//      running kb-memory / decision-clock / signal-radar / the janitor from an interactive session
//      keeps working unchanged via the master key even after a job's Container Apps env is flipped
//      to COSMOS_AUTH_MODE=aad -- only the actual job invocation, which DOES have the sidecar, ever
//      uses AAD.
//   2. "aad requested, sidecar IS present, but the mint call itself failed" -- a real, actionable
//      misconfiguration (missing RBAC grant, IMDS unreachable, wrong client_id). This does NOT fall
//      back -- it throws a clear, cosmos-auth-labelled error. Masking a broken AAD path behind an
//      apparently-working key fallback would hide exactly the kind of misconfiguration this
//      migration needs surfaced. Mirrors the gateway cosmos.ts's own "fails LOUD, never an automatic
//      fallback" policy for this case.
// If key mode is reached (by default, or via case 1 above) with no master key available, behavior is
// UNCHANGED from before this file existed: each of the 4 clients' own cfg()/cosmosConfig() already
// treats a missing key as "not configured" and degrades or errors exactly as it did before.

import crypto from "node:crypto";

const COSMOS_AAD_RESOURCE = "https://cosmos.azure.com";
const DEFAULT_JOBS_UAMI_CLIENT_ID = "01b82248-86b1-4237-a8f3-8317cf9d5f33"; // id-otc-jobs-kv

/** The Cosmos master-key Authorization header value (URL-encoded token). Pure. The ONE
 *  implementation of the HMAC formula every job Cosmos client previously carried its own inline
 *  copy of -- do NOT "tidy" the casing, it is load-bearing (see the file header). */
export function keyAuthToken(verb, resType, resourceLink, date, masterKey) {
  const stringToSign = `${verb.toLowerCase()}\n${resType.toLowerCase()}\n${resourceLink}\n${date.toLowerCase()}\n\n`;
  const sig = crypto.createHmac("sha256", Buffer.from(masterKey, "base64")).update(stringToSign, "utf8").digest("base64");
  return encodeURIComponent(`type=master&ver=1.0&sig=${sig}`);
}

/** The Cosmos-for-NoSQL AAD Authorization header value (URL-encoded). Pure. `sig` is the RAW AAD
 *  access token (no HMAC, no "Bearer " prefix) -- mirrors otchealth-mcp-server's cosmos.ts
 *  aadAuthToken() exactly, same output shape. */
export function aadAuthToken(accessToken) {
  return encodeURIComponent(`type=aad&ver=1.0&sig=${accessToken}`);
}

/** 'aad' only when COSMOS_AUTH_MODE is exactly (case-insensitively) 'aad'; every other value
 *  (unset, 'key', anything else/typo'd) resolves to 'key', the safe default. Pure. */
export function resolveAuthMode(env = process.env) {
  return String((env && env.COSMOS_AUTH_MODE) || "key").toLowerCase() === "aad" ? "aad" : "key";
}

/** True only when THIS process has an Azure-injected managed-identity sidecar to mint a token from
 *  (IDENTITY_ENDPOINT + IDENTITY_HEADER both present) -- i.e. it is actually running inside a
 *  Container Apps Job/App with an identity attached, not an interactive/dev session. Pure. */
export function hasIdentitySidecar(env = process.env) {
  return Boolean(env && env.IDENTITY_ENDPOINT && env.IDENTITY_HEADER);
}

let _aadTok = null;
let _aadTokExp = 0; // module-level: one mint serves every caller/request in this process

/** Test-only: clear the in-module AAD token cache so test cases do not leak state across each
 *  other. A no-op in production use (nothing in this file's real call paths calls this). */
export function _resetAadTokenCacheForTests() {
  _aadTok = null;
  _aadTokExp = 0;
}

/** Mint (or reuse the cached) managed-identity bearer token for the Cosmos data plane, scoped to the
 *  Jobs UAMI. Refreshes ~2 minutes before expiry. Fails LOUD: a token-fetch failure throws a clear,
 *  cosmos-auth-labelled error -- this is only ever called once hasIdentitySidecar(env) is already
 *  known true, so a failure here is a real, actionable problem (missing RBAC grant, IMDS
 *  unreachable, wrong client_id), never silently papered over (see the DUAL-CONTEXT FALLBACK note
 *  at the top of this file). */
async function mintJobsAadToken(env) {
  const now = Date.now();
  if (_aadTok && _aadTokExp - now > 120_000) return _aadTok;
  const endpoint = env.IDENTITY_ENDPOINT;
  const header = env.IDENTITY_HEADER;
  const clientId = env.AZURE_JOBS_UAMI_CLIENT_ID || DEFAULT_JOBS_UAMI_CLIENT_ID;
  const url = `${endpoint}?resource=${encodeURIComponent(COSMOS_AAD_RESOURCE)}&api-version=2019-08-01&client_id=${encodeURIComponent(clientId)}`;
  const r = await fetch(url, { headers: { "X-IDENTITY-HEADER": header } });
  if (!r.ok) {
    throw new Error(`cosmos-auth: managed-identity token request failed (HTTP ${r.status}) for ${COSMOS_AAD_RESOURCE}: ${(await r.text()).slice(0, 200)}`);
  }
  const j = await r.json();
  if (!j.access_token) throw new Error(`cosmos-auth: managed-identity token response missing access_token for ${COSMOS_AAD_RESOURCE}`);
  const expSec = typeof j.expires_on === "string" ? parseInt(j.expires_on, 10) : Number(j.expires_on || 0);
  const expEpochMs = Number.isFinite(expSec) && expSec > 0 ? expSec * 1000 : now + 3_600_000;
  _aadTok = j.access_token;
  _aadTokExp = expEpochMs;
  return _aadTok;
}

/**
 * The single entry point every job Cosmos client's request()/cosmosRequest() should call in place of
 * its old inline authToken()/cosmosAuthToken() call, to build the Authorization header VALUE
 * (already url-encoded).
 *
 *  - COSMOS_AUTH_MODE unset or 'key' (the default): returns EXACTLY keyAuthToken(verb, resType,
 *    resourceLink, date, masterKey) -- byte-for-byte today's behavior on every one of the 4 callers.
 *  - COSMOS_AUTH_MODE='aad' AND hasIdentitySidecar(env) is true (i.e. actually running inside a
 *    Container Apps Job with an identity attached): mints/reuses the managed-identity token and
 *    returns the aad-mode header; masterKey is ignored entirely on this path.
 *  - COSMOS_AUTH_MODE='aad' but NO identity sidecar present (e.g. an interactive dev session): falls
 *    back to key mode -- see the DUAL-CONTEXT FALLBACK note at the top of this file. (If the sidecar
 *    IS present but the mint itself fails, this does NOT fall back -- it throws, see
 *    mintJobsAadToken above.)
 *
 * `env` defaults to process.env for real callers; tests inject a plain object so cases never mutate
 * global state or fight the module-level AAD token cache across unrelated assertions.
 */
export async function cosmosAuthHeader({ verb, resType, resourceLink, date, masterKey, env = process.env }) {
  const mode = resolveAuthMode(env);
  if (mode === "aad" && hasIdentitySidecar(env)) {
    const token = await mintJobsAadToken(env);
    return aadAuthToken(token);
  }
  return keyAuthToken(verb, resType, resourceLink, date, masterKey);
}
