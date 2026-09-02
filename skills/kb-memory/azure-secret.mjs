// azure-secret.mjs — fetch a secret from Azure Key Vault. This is the fleet secret store after the
// GCP Secret Manager retirement (billing off, 2026-07). Returns the secret value (string) or null;
// NEVER throws (fail-open).
//
// THREE auth paths, tried in order (2026-07-05, A3-KV-REFERENCES / A9-MANAGED-IDENTITY groundwork):
//   1. MANAGED IDENTITY (preferred, no stored secret at all): if the container has IDENTITY_ENDPOINT
//      + IDENTITY_HEADER env vars (Azure Container Apps injects these automatically whenever a
//      user/system-assigned identity is attached — see
//      https://learn.microsoft.com/en-us/azure/container-apps/managed-identity#rest-endpoint-reference),
//      mint a Key Vault token from that sidecar endpoint. This eliminates the "one shared SP
//      client_secret baked into every job spec" bootstrap problem entirely: the identity's own
//      grant on the vault (Key Vault Secrets User RBAC role) IS the credential; nothing to leak,
//      nothing to rotate, nothing circular (unlike trying to store the SP's own secret IN the vault
//      it authenticates to, which is impossible by construction).
//   2. SP client_credentials (legacy fallback): AZURE_SP_CLIENT_ID/SECRET/TENANT_ID, still needed on
//      any job not yet migrated to managed identity. Migrate a job by: attach a user-assigned
//      identity, grant it Key Vault Secrets User on the vault, remove AZURE_SP_CLIENT_SECRET from
//      the job spec — no code change needed, this file picks the identity path automatically.
//   3. az-CLI / OIDC (secretless CI fallback, 2026-07-13): if neither of the above minted a token,
//      shell `az account get-access-token`. In a GitHub Actions job that ran `azure/login@v2` with
//      federated OIDC (client-id from a repo VARIABLE, id-token: write), the az CLI is authenticated
//      with NO client secret at rest — the federated login IS the credential. This is how the
//      claude-tools repo authenticates to Azure (see .github/workflows/verify-get-secret-migration.yml),
//      which deliberately does NOT set AZURE_SP_* secrets. Purely additive + last: it only runs when
//      paths 1 and 2 both yield no token, so every managed-identity or AZURE_SP_*-equipped environment
//      (Container Apps jobs, Hyperagent, the local seat) is byte-for-byte unchanged. Returns null (never
//      throws) if az is absent or not logged in.
//   AZURE_KEYVAULT_NAME   vault name (default kv-otc-55c84f6bef)
//
// Key Vault secret NAMES are a 1:1 mirror of the old GCP Secret Manager ids, so callers pass the
// exact same id (e.g. 'azure-legal-storage-key') they used with the GCP sm() helper.
//
// FIX (2026-07-08, RBAC-masking bug class): the old kvSecret() minted ONE token via vaultToken()
// (identity-first, SP-fallback-only-if-no-token-minted) and used it for the actual secret GET. This
// meant an identity that COULD mint a token but had NO RBAC role on the vault (a real, recurring
// operational mistake — happened on 4 live jobs: xero-health, xero-run, token-keeper,
// docintel-ocr-sweep) got a 403 on the real GET, which kvSecret() swallowed identically to "vault
// unreachable" or "secret doesn't exist" — and the perfectly-working SP fallback was NEVER TRIED,
// because a token HAD been minted (just an unauthorized one). kvSecret() now tries BOTH auth paths
// per call, in order, but ONLY escalates to the next path on an auth-shaped failure (401/403) from
// the actual secret GET — not on 404 (wrong secret name) or 5xx (vault genuinely down), where
// retrying via a different identity would silently mask a real, different bug instead of fixing
// this one. Whenever the SP path is what actually worked, it logs a loud warning so RBAC drift on
// the identity is visible in logs/alerts immediately, not discovered months later.

import { ssmSecret, ssmSecretDetailed, ssmSecretSet, awsCredsPresent } from "./aws-secret.mjs";
import { execFileSync } from "node:child_process";

let _identityTok = null, _identityExp = 0;
let _spTok = null, _spExp = 0;
let _azTok = null, _azExp = 0;
// The "OK (fallback): ... via the SP credential" notice is per-secret-fetch noise that agents on a seat
// with no managed identity (the norm) see on EVERY read/write. It is informational, not a failure, and
// three agents (CFO, CRO, and the migrated Developer) misread it as an error. Emit it ONCE per process
// per direction, then stay silent -- the diagnostic value (which credential path worked) is fully
// conveyed by the first line; repeating it on every fetch adds nothing but log spam.
let _spFallbackNotedRead = false, _spFallbackNotedWrite = false;
let _ssmFallbackNoted = false;

/** Container Apps managed-identity token, via the platform-injected sidecar endpoint. Returns null
 *  (never throws) if the container has no identity attached (IDENTITY_ENDPOINT unset) or the call
 *  fails for any reason — callers fall through to the SP path. */
async function identityToken() {
  const now = Date.now();
  if (_identityTok && _identityExp - now > 60_000) return _identityTok;
  const endpoint = process.env.IDENTITY_ENDPOINT;
  const header = process.env.IDENTITY_HEADER;
  if (!endpoint || !header) return null;
  try {
    const clientIdQS = process.env.AZURE_UAMI_CLIENT_ID ? `&client_id=${encodeURIComponent(process.env.AZURE_UAMI_CLIENT_ID)}` : "";
    const r = await fetch(`${endpoint}?resource=${encodeURIComponent("https://vault.azure.net")}&api-version=2019-08-01${clientIdQS}`, {
      headers: { "x-identity-header": header },
    });
    if (!r.ok) return null;
    const j = await r.json();
    if (!j.access_token) return null;
    _identityTok = j.access_token;
    _identityExp = now + 3600_000;
    return _identityTok;
  } catch {
    return null;
  }
}

async function spToken() {
  const now = Date.now();
  if (_spTok && _spExp - now > 60_000) return _spTok;
  const tenant = process.env.AZURE_SP_TENANT_ID;
  const cid = process.env.AZURE_SP_CLIENT_ID;
  const csec = process.env.AZURE_SP_CLIENT_SECRET;
  if (!tenant || !cid || !csec) return null;
  try {
    const r = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: cid, client_secret: csec, scope: "https://vault.azure.net/.default" }),
    });
    const j = await r.json();
    if (!j.access_token) return null;
    _spTok = j.access_token;
    _spExp = now + 3600_000;
    return _spTok;
  } catch {
    return null;
  }
}

/** az-CLI / OIDC token (SECRETLESS). After `azure/login@v2` (federated OIDC) in a GitHub Actions job,
 *  or in any az-authenticated shell, mint a Key Vault token via the az CLI — no client secret at rest.
 *  Returns null (never throws) if az is missing from PATH or not logged in, so callers fall through
 *  exactly as with the other paths. execFileSync (not a shell string) so `name`/args can never be
 *  interpolated into a shell; args are static. */
async function azCliToken() {
  const now = Date.now();
  if (_azTok && _azExp - now > 60_000) return _azTok;
  try {
    const out = execFileSync(
      "az",
      ["account", "get-access-token", "--resource", "https://vault.azure.net", "--query", "accessToken", "-o", "tsv"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 20_000 },
    );
    const tok = String(out || "").trim();
    if (!tok) return null;
    _azTok = tok;
    _azExp = now + 3000_000; // ~50 min; az KV tokens are typically ~60-75 min
    return _azTok;
  } catch {
    return null; // az absent / not logged in / any failure — fall through
  }
}

// For diagnostics/logging only — which path actually authenticated successfully last (or null if
// never minted). Kept for backward compatibility with any caller importing this.
let _authMode = null;
export function authMode() { return _authMode; }

let _noCredsNoted = false;

// Credential shapes that must never survive into a log line, applied at the SINK (2026-09-02).
//
// WHY AT THE SINK, NOT THE PRODUCER. ssmSecretDetailed()'s `detail` can carry ssmCall()'s transport
// catch, which builds `error-${e.message}` from a raw Error. A raw Error.message is exactly what the
// fleet rule forbids putting in a log: an execFile or fetch rejection can embed the entire attempted
// request, Authorization header included. That is not hypothetical -- it is the eval-runner incident
// (otchealth-mcp-server #256), where a scheduled job wrote a live gateway bearer into CloudWatch once
// per failing case for days. The lesson recorded from it was: redact where the string is PRINTED,
// never trust that a secret can be kept out of the string in the first place, and match a SHAPE as
// well as any exact value so a rotated or different credential is still caught.
//
// Deliberately shape-only and lossy-but-readable: "fetch failed" survives intact (it is useful and
// benign), while any bearer, AWS key id, long base64/hex run, or key:value credential pair becomes
// [redacted]. CodeQL also flags `name` on these same lines; that half is a FALSE POSITIVE -- `name`
// is a secret NAME (e.g. "mercury-api-token"), which the fleet rule explicitly permits logging
// ("names fine, values never"), and CodeQL cannot distinguish token-keeper's `cfg.apiToken` (a name
// literal) from its `apiToken` (the resolved value). Naming the secret is the entire diagnostic
// value of these lines, so it stays.
// HARDENED 2026-09-02 (auto-critic on PR #515 found two gaps; verifying them found a third, and the
// third is the one that matters most because it FAKES success):
//   1. Only AKIA was matched. AWS TEMPORARY credentials are ASIA-prefixed, and every ECS task role in
//      this fleet uses temporary credentials -- so the one environment the redactor most needed to
//      cover was the one it missed. All documented AWS unique-id prefixes are now matched.
//   2. The long base64 run omitted `_` and `-`, so a base64url token (JWT segments, URL-safe keys)
//      was split below the 40-char threshold and survived.
//   3. FOUND WHILE VERIFYING 1 AND 2, not reported by the critic: SigV4 puts the key id in
//      `Credential=<AK>/<date>/<region>/<service>/aws4_request`, and the `authorization: ...` rule
//      stops at the first whitespace (it matched only "AWS4-HMAC-SHA256"). The output therefore read
//      "[redacted] Credential=ASIA.../..." -- a visible redaction marker sitting next to the live key
//      id. That is worse than no redaction, because it reads as safe. `Credential=` is now matched
//      explicitly, and the widened long-run rule catches it a second time (defense in depth).
// METHOD NOTE: the first verification pass asked "does [redacted] appear in the output", which case 3
// PASSES while leaking. Assert the SECRET SUBSTRING IS GONE; a marker proves only that something,
// somewhere, matched.
const CREDENTIAL_SHAPES = [
  /\bBearer\s+[\w.\-~+/]+=*/gi,
  // AWS unique-id prefixes (docs: IAM identifiers). ASIA = temporary/STS, the ECS task-role case.
  /\b(?:AKIA|ASIA|ABIA|ACCA|AIDA|AROA|ANPA|ANVA|APKA)[0-9A-Z]{16}\b/g,
  /\bCredential=[^\s,;]+/gi,
  /\b(?:authorization|x-amz-security-token|password|secret|api[_-]?key|token)\b\s*[:=]\s*\S+/gi,
  /\b[0-9a-f]{40,}\b/gi, // long hex run
];

// Long high-entropy runs, widened to base64url (`_` and `-`). Applied via a callback rather than a
// blanket replace so it does not eat the long lowercase kebab paths this codebase logs deliberately
// (e.g. "/otchealth/some-long-secret-name"): a run that is ONLY lowercase, digits, slash and hyphen
// is an identifier or path, never a credential -- real keys and tokens carry mixed case, `_`, `+`
// or base64 padding.
const LONG_RUN = /\b[A-Za-z0-9+/_-]{40,}={0,2}\b/g;
const LOOKS_LIKE_PATH_OR_KEBAB = /^[a-z0-9/-]+$/;

/** Bound what may be interpolated into a diagnostic from an upstream `detail`/error string. */
export function safeDetail(detail) {
  let d = String(detail ?? "").trim();
  if (!d) return "unspecified";
  for (const re of CREDENTIAL_SHAPES) d = d.replace(re, "[redacted]");
  d = d.replace(LONG_RUN, (m) => (LOOKS_LIKE_PATH_OR_KEBAB.test(m) ? m : "[redacted]"));
  d = d.replace(/\s+/g, " ");
  return d.length > 160 ? `${d.slice(0, 160)}...` : d;
}

/**
 * Explain an SSM read that produced no value, under the ssm-sole-path default.
 *
 * The whole point of ssmSecretDetailed() is that these three cases are NOT the same event, so they
 * must not produce the same output:
 *   not-found      SILENT. The store was reached and answered honestly. Plenty of callers read
 *                  genuinely optional secrets (a PostHog key, a Datadog key) and treat null as "not
 *                  configured" -- printing an error for that trains readers to ignore this prefix,
 *                  which is how a real one gets missed. Absence is an answer, not a failure.
 *   denied         LOUD, every time, per secret. A missing IAM grant is never routine and is exactly
 *                  the case that must never be mistaken for "the secret does not exist".
 *   no-credentials LOUD, but ONCE per process: it is an environment-wide condition, identical for
 *                  every name, so a job reading twenty secrets would otherwise emit twenty copies.
 *   error          LOUD, per secret: transport/HTTP shapes differ per call and each is worth seeing.
 */
function reportSsmMiss(name, outcome, detail) {
  if (outcome === "not-found") return;
  if (outcome === "no-credentials") {
    if (_noCredsNoted) return;
    _noCredsNoted = true;
    const aws = awsCredsPresent();
    console.error(
      `[kv-secret] cannot reach the secret store (AWS SSM /otchealth/*): no AWS credentials resolvable ` +
        `on this seat (ECS task role: ${aws.ecs ? "yes" : "no"}, AWS_ACCESS_KEY_ID: ${aws.env ? "yes" : "no"}, ` +
        `OTC_AWS_ACCESS_KEY_ID: ${aws.otc ? "yes" : "no"}). Set OTC_AWS_ACCESS_KEY_ID + OTC_AWS_SECRET_ACCESS_KEY ` +
        `(NOT the plain AWS_ names -- this sandbox's proxy injects a non-functional placeholder into those). ` +
        `Suppressing further per-secret copies of this notice.`,
    );
    return;
  }
  if (outcome === "denied") {
    console.error(
      `[kv-secret] ACCESS DENIED reading "${name}" from AWS SSM /otchealth/* (${safeDetail(detail)}). This is a ` +
        `PERMISSIONS problem, not a missing secret: the parameter may well exist. Check the ssm:GetParameter ` +
        `grant (and the KMS decrypt grant for SecureString) on this task role or IAM user.`,
    );
    return;
  }
  console.error(`[kv-secret] READ error for "${name}" from AWS SSM /otchealth/*: ${safeDetail(detail)}`);
}

/** Mint a Key Vault (vault.azure.net) access token via the SAME three-path resolver kvSecret() uses
 *  (managed identity -> SP client_credentials -> az-CLI/OIDC), returning the raw token string (or
 *  null if no path yields one). kvSecret() reads ONE secret by name; callers that need to LIST
 *  secrets (e.g. the credential registry) need the raw token to hit the vault's /secrets endpoint
 *  themselves. Same auth ORDER as kvSecret so it works byte-for-byte in the same environments:
 *  Container Apps Jobs (identity), the local/Hyperagent seat (AZURE_SP_*), and OIDC CI (az). Never
 *  throws; returns null on total failure so callers can fail-loud on their own terms. */
export async function vaultToken() {
  return (await identityToken()) || (await spToken()) || (await azCliToken()) || null;
}

/** Write/overwrite a secret in Key Vault (whichever identity is used needs "Key Vault Secrets
 *  Officer"). Returns true on success, false otherwise. Never throws. This is the Azure replacement
 *  for the retired GCP Secret Manager addVersion() path used by OAuth token-rotation persistence
 *  (Xero/Gmail/OneDrive/QBO). Tries identity first, falls back to SP on an auth-shaped failure only
 *  — same policy as kvSecret() below, for the same reason. */
export async function kvSecretSet(name, value) {
  // DUAL-WRITE (2026-08-16). Nothing syncs Key Vault to SSM -- the mirror was a one-time bulk copy.
  // If a rotation landed in only one store, the other would keep serving the OLD value, the read
  // would SUCCEED, no fallback would fire, and the damage would surface later as an unexplained auth
  // failure somewhere else entirely. Writing both here is what keeps the fallback above trustworthy.
  // The SSM leg is attempted first and its result folded into the return value, so a half-written
  // rotation is reported rather than silently accepted.
  const backend = process.env.SECRET_BACKEND || "ssm";
  const ssmOk = await ssmSecretSet(name, value).catch(() => false);
  // Key Vault kv-otc-55c84f6bef died with Azure subscription 55c84f6b (permanently deleted
  // 2026-08-13). Under the ssm default the KV leg is SKIPPED entirely: attempting it burns the
  // whole dead-vault token ladder on every rotation and then logs a spurious PARTIAL ROTATION
  // error even though the live store (SSM) took the write -- which is exactly the failure shape
  // that made every token-keeper rotation report FAILURE while actually succeeding. Setting
  // SECRET_BACKEND=keyvault restores the old dual-write for a hypothetical future vault.
  const kvOk = backend === "ssm" ? false : await kvSecretSetAzure(name, value);
  if (backend !== "ssm") {
    if (kvOk && !ssmOk) {
      console.error(
        `[kv-secret] PARTIAL ROTATION for "${name}": Key Vault updated, SSM mirror did NOT. The stores ` +
          `have diverged -- the SSM fallback will serve a STALE value for this secret until it is reconciled.`,
      );
    }
    if (!kvOk && ssmOk) {
      console.error(`[kv-secret] PARTIAL ROTATION for "${name}": SSM updated, Key Vault did NOT.`);
    }
  }
  // Success means the ACTIVE primary took the write; a mirror-only failure is loud but not fatal.
  return backend === "ssm" ? ssmOk : kvOk;
}

/** The original Key-Vault-only writer, now one leg of the dual-write above. */
async function kvSecretSetAzure(name, value) {
  const vault = process.env.AZURE_KEYVAULT_NAME || "kv-otc-55c84f6bef";
  const attempts = [];
  for (const mode of ["identity", "sp", "azcli"]) {
    const tok = mode === "identity" ? await identityToken() : mode === "sp" ? await spToken() : await azCliToken();
    if (!tok) { attempts.push(`${mode}:no-token`); continue; }
    try {
      const r = await fetch(`https://${vault}.vault.azure.net/secrets/${name}?api-version=7.4`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
        body: JSON.stringify({ value: String(value) }),
      });
      if (r.ok) {
        _authMode = mode;
        if (mode === "sp" && !_spFallbackNotedWrite) {
          _spFallbackNotedWrite = true;
          // CLARIFIED 2026-07-10 (real fleet incident, 2nd occurrence -- CFO then CRO both misread
          // this exact line as evidence of a broken/failing write, when in fact the write ALREADY
          // SUCCEEDED (r.ok is true) by the time this prints -- it's a diagnostic note about WHICH
          // credential worked, not an error. Emitted ONCE per process (2026-07-16): the same misread
          // recurred, and repeating it on every write was pure spam.
          console.warn(`[kv-secret] note (once): WRITEs are succeeding via the SP credential, not a managed identity (identity token rejected -- expected on a seat with no managed identity). This is informational, not a failure; suppressing further per-write notices.`);
        }
        return true;
      }
      attempts.push(`${mode}:http-${r.status}`);
      if (r.status !== 401 && r.status !== 403) return false; // 404/5xx: a different real problem, don't mask it
    } catch (e) {
      attempts.push(`${mode}:error-${String(e && e.message || e)}`);
    }
  }
  console.error(`[kv-secret] WRITE failed for "${name}" via all auth paths: ${attempts.join(", ")}`);
  return false;
}

/** Fetch one secret from Key Vault. Returns the trimmed value, or null if unavailable. Never throws.
 *  Tries the identity path first (preferred — no stored secret needed), then the SP path, but ONLY
 *  escalates to the next path when the actual secret GET comes back 401/403 (an auth-shaped
 *  failure — "this credential isn't allowed", worth retrying via the other credential). A 404 (wrong
 *  secret name) or 5xx (vault down) stops immediately without trying the other path, because
 *  silently retrying there would mask a genuinely different bug behind "it worked anyway via SP". */
export async function kvSecret(name) {
  // SECRET_BACKEND DEFAULTS to ssm (2026-08-27): AWS SSM /otchealth/* is the store of record since
  // Azure subscription 55c84f6b -- and Key Vault kv-otc-55c84f6bef with it -- was permanently
  // deleted 2026-08-13.
  //
  // SSM IS NOW THE SOLE READ PATH UNDER THIS DEFAULT (2026-09-02). Until now an SSM miss still fell
  // through to the Azure ladder below "in case the mirror does not yet carry a newly-created secret".
  // That reasoning expired the day the vault was deleted: a permanently-deleted Key Vault cannot
  // carry a secret SSM lacks, so the fallback could never succeed -- it could only fail and then
  // describe the failure wrongly. What it actually printed on every miss was
  //   [kv-secret] READ failed for "x" via all auth paths: identity:no-token, sp:no-token, azcli:no-token
  // naming three Azure credentials as the cause of what was simply "not in SSM", and never naming the
  // store actually consulted -- sending the reader after an Azure auth problem that does not exist.
  //
  // ON COST, MEASURED HONESTLY: on a seat with no AZURE_SP_* (every current seat and job -- checked
  // live against the running ECS task definitions), the ladder makes NO network call, and removing it
  // is NOT a measurable latency win: warm miss 68ms after vs 63ms before, i.e. noise, because the SSM
  // round trip (~60ms) dwarfs the failed `az` spawn. An earlier draft of this comment claimed
  // "250ms vs 91ms"; that was a cold first call misread as ladder cost, and is retracted. The real
  // wins are the honest diagnostic above, and that any seat which DOES carry AZURE_SP_* would
  // otherwise POST to login.microsoftonline.com on every miss for a token it can do nothing with.
  //
  // This mirrors the policy kvSecretSet() has applied to WRITES since 2026-08-27 (see its own
  // comment) -- reads simply never got it. SECRET_BACKEND=keyvault restores the full ladder for a
  // hypothetical future vault; that escape hatch is pinned by a counterfactual test.
  if ((process.env.SECRET_BACKEND || "ssm") === "ssm") {
    const { value, outcome, detail } = await ssmSecretDetailed(name);
    if (outcome === "found") return value;
    reportSsmMiss(name, outcome, detail);
    return null;
  }
  const vault = process.env.AZURE_KEYVAULT_NAME || "kv-otc-55c84f6bef";
  const attempts = [];
  for (const mode of ["identity", "sp", "azcli"]) {
    const tok = mode === "identity" ? await identityToken() : mode === "sp" ? await spToken() : await azCliToken();
    if (!tok) { attempts.push(`${mode}:no-token`); continue; }
    try {
      const r = await fetch(`https://${vault}.vault.azure.net/secrets/${name}?api-version=7.4`, { headers: { Authorization: `Bearer ${tok}` } });
      if (r.ok) {
        _authMode = mode;
        if (mode === "sp" && !_spFallbackNotedRead) {
          _spFallbackNotedRead = true;
          // CLARIFIED 2026-07-10 (real fleet incident, 2nd occurrence -- CFO then CRO both misread
          // this exact line as evidence of a broken/failing read, when in fact the read ALREADY
          // SUCCEEDED (r.ok is true) by the time this prints -- it's a diagnostic note about WHICH
          // credential worked, not an error. Emitted ONCE per process (2026-07-16): the same misread
          // recurred (migrated Developer seat), and repeating it on every read was pure spam.
          console.warn(`[kv-secret] note (once): READs are succeeding via the SP credential, not a managed identity (identity token rejected -- expected on a seat with no managed identity). This is informational, not a failure; suppressing further per-read notices.`);
        }
        const v = (await r.json()).value;
        return v == null ? null : String(v).trim() || null;
      }
      attempts.push(`${mode}:http-${r.status}`);
      if (r.status !== 401 && r.status !== 403) return null; // 404/5xx: don't retry via the other path
    } catch (e) {
      attempts.push(`${mode}:error-${String(e && e.message || e)}`);
    }
  }
  if (attempts.length) {
    console.error(`[kv-secret] READ failed for "${name}" via all auth paths: ${attempts.join(", ")}`);
  }
  // Key Vault could not serve it. If SSM was not already tried as primary, try it now -- this is the
  // branch that actually runs during an Azure outage, when every attempt above fails on auth or
  // network.
  if ((process.env.SECRET_BACKEND || "ssm") !== "ssm") {
    const v = await ssmSecret(name);
    if (v != null) {
      if (!_ssmFallbackNoted) {
        _ssmFallbackNoted = true;
        console.warn(
          `[kv-secret] note (once): serving secrets from the AWS SSM mirror because Key Vault did not answer. ` +
            `This is the Azure-outage fallback working as designed, not a failure.`,
        );
      }
      return v;
    }
  }
  return null;
}

// ── FAIL-LOUD startup guard (P0 stability, 2026-07-04) ──────────────────────
// Convergent-P0 #1: never run silently without required credentials. The GCP path
// fails OPEN (kvSecret returns null, never throws) so the LIVE Azure path always runs;
// this guard is where a TOTAL creds failure fails LOUD instead of silent-nulling.
// Call at the top of any job/skill: `await requireSecrets(["azure-cfo-storage-key", ...])`.
// Returns { name: value } for the resolved set; on ANY miss it names the missing keys
// and exits non-zero (78 = EX_CONFIG) so the failure is impossible to miss.
export async function requireSecrets(names) {
  const out = {};
  const missing = [];
  for (const n of names) {
    const v = await kvSecret(n);
    if (v == null) missing.push(n);
    else out[n] = v;
  }
  if (missing.length) {
    // BACKEND-AWARE (2026-09-02). This banner used to assert, unconditionally, that "all four auth
    // paths (Azure identity/SP/az-CLI, then AWS SSM) were tried per secret". Under the ssm default
    // that is now FALSE -- only SSM is consulted -- and a banner that names three dead Azure
    // credentials as candidate causes is the same misdirection this change removed from kvSecret()
    // itself. Report what was actually tried, per backend.
    const aws = awsCredsPresent();
    const ssmOnly = (process.env.SECRET_BACKEND || "ssm") === "ssm";
    console.error("==================================================================================");
    if (ssmOnly) {
      console.error(`[FATAL] Required secret(s) UNAVAILABLE from AWS SSM Parameter Store (/otchealth/*): ${missing.join(", ")}`);
      console.error(`        AWS: ECS task role: ${aws.ecs ? "yes" : "no"}. AWS_ACCESS_KEY_ID/SECRET present: ${aws.env ? "yes" : "no"}. OTC_AWS_ACCESS_KEY_ID/SECRET present: ${aws.otc ? "yes" : "NO"}.`);
      console.error("        SSM is the ONLY store consulted (SECRET_BACKEND=ssm, the default). Azure Key Vault");
      console.error("        kv-otc-55c84f6bef was permanently deleted 2026-08-13 and is NOT a fallback -- do not go");
      console.error("        looking for an Azure auth problem. See the [kv-secret] lines above: a DENIED means an");
      console.error("        ssm:GetParameter / KMS-decrypt grant is missing on this role; silence means the parameter");
      console.error("        genuinely is not there (check the name, or write it with setup/set-secret.mjs). No AWS creds");
      console.error("        at all means set OTC_AWS_ACCESS_KEY_ID + OTC_AWS_SECRET_ACCESS_KEY (NOT the plain AWS_ names --");
      console.error("        this sandbox's proxy injects a non-functional placeholder into those; see");
      console.error("        skills/kb-memory/SKILL.md 'Credential bootstrap' for the full per-seat guide).");
    } else {
      const vault = process.env.AZURE_KEYVAULT_NAME || "kv-otc-55c84f6bef";
      const spOk = Boolean(process.env.AZURE_SP_CLIENT_ID && process.env.AZURE_SP_CLIENT_SECRET && process.env.AZURE_SP_TENANT_ID);
      const identityOk = Boolean(process.env.IDENTITY_ENDPOINT && process.env.IDENTITY_HEADER);
      const azOk = Boolean(await azCliToken());
      console.error(`[FATAL] Required secret(s) UNAVAILABLE from Key Vault (${vault}) OR its SSM fallback: ${missing.join(", ")}`);
      console.error(`        Azure: managed identity attached: ${identityOk ? "yes" : "no"}. AZURE_SP_* creds present: ${spOk ? "yes" : "NO"}. az-CLI/OIDC login: ${azOk ? "yes" : "no — run azure/login@v2 (OIDC) or 'az login'"}.`);
      console.error(`        AWS (SSM fallback, /otchealth/* mirror): ECS task role: ${aws.ecs ? "yes" : "no"}. AWS_ACCESS_KEY_ID/SECRET present: ${aws.env ? "yes" : "no"}. OTC_AWS_ACCESS_KEY_ID/SECRET present: ${aws.otc ? "yes" : "NO"}.`);
      console.error("        All four auth paths (Azure identity/SP/az-CLI, then AWS SSM) were tried per secret (see [kv-secret]");
      console.error("        WARN/ERROR lines above for which path failed and how -- a 401/403 means an RBAC grant is likely");
      console.error("        missing on the identity; SSM failing with no AWS creds present means set OTC_AWS_ACCESS_KEY_ID +");
      console.error("        OTC_AWS_SECRET_ACCESS_KEY (NOT the plain AWS_ names -- this sandbox's proxy injects a non-functional");
      console.error("        placeholder into those; see skills/kb-memory/SKILL.md 'Credential bootstrap' for the full per-seat guide).");
      console.error("        NOTE: SECRET_BACKEND=keyvault is set explicitly -- kv-otc-55c84f6bef was permanently deleted");
      console.error("        2026-08-13, so this ladder cannot succeed. Unset it to use the live SSM store.");
    }
    console.error("        Refusing to run with missing credentials (fail-loud, not silent). GCP Secret Manager is retired.");
    console.error("==================================================================================");
    process.exit(78);
  }
  return out;
}

// Non-exiting variant: throw (for callers that want to catch). Never returns null.
export async function kvSecretOrThrow(name) {
  const v = await kvSecret(name);
  if (v == null) {
    const aws = awsCredsPresent();
    const credState = aws.any
      ? "yes, but the secret itself was not found there either"
      : "NO -- set OTC_AWS_ACCESS_KEY_ID + OTC_AWS_SECRET_ACCESS_KEY";
    // Backend-aware for the same reason as requireSecrets()'s banner: under the ssm default Key Vault
    // is never consulted, so naming it as a store that "failed" sends the reader after a nonexistent
    // Azure auth problem. The keyvault wording is kept verbatim for the explicit opt-in path.
    throw new Error(
      (process.env.SECRET_BACKEND || "ssm") === "ssm"
        ? `required secret '${name}' unavailable from AWS SSM (/otchealth/*), the sole secret store ` +
          `(AWS creds resolvable: ${credState}) -- see [kv-secret] log lines above; Azure Key Vault is ` +
          `permanently deleted and is NOT consulted, so this is not an Azure auth problem`
        : `required secret '${name}' unavailable from Key Vault (${process.env.AZURE_KEYVAULT_NAME || "kv-otc-55c84f6bef"}) or its SSM fallback ` +
          `(AWS creds resolvable: ${credState}) ` +
          `-- see [kv-secret] log lines above for which auth path(s) failed`,
    );
  }
  return v;
}
