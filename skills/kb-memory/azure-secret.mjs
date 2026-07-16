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
    const vault = process.env.AZURE_KEYVAULT_NAME || "kv-otc-55c84f6bef";
    const spOk = Boolean(process.env.AZURE_SP_CLIENT_ID && process.env.AZURE_SP_CLIENT_SECRET && process.env.AZURE_SP_TENANT_ID);
    const identityOk = Boolean(process.env.IDENTITY_ENDPOINT && process.env.IDENTITY_HEADER);
    const azOk = Boolean(await azCliToken());
    console.error("==================================================================================");
    console.error(`[FATAL] Required secret(s) UNAVAILABLE from Key Vault (${vault}): ${missing.join(", ")}`);
    console.error(`        Managed identity attached: ${identityOk ? "yes" : "no"}. AZURE_SP_* creds present: ${spOk ? "yes" : "NO"}. az-CLI/OIDC login: ${azOk ? "yes" : "no — run azure/login@v2 (OIDC) or 'az login'"}.`);
    console.error("        All three auth paths were tried per secret (see [kv-secret] WARN/ERROR lines above for which");
    console.error("        path failed and how — a 401/403 means an RBAC grant is likely missing on the identity).");
    console.error("        Refusing to run with missing credentials (fail-loud, not silent). GCP Secret Manager is retired.");
    console.error("==================================================================================");
    process.exit(78);
  }
  return out;
}

// Non-exiting variant: throw (for callers that want to catch). Never returns null.
export async function kvSecretOrThrow(name) {
  const v = await kvSecret(name);
  if (v == null) throw new Error(`required secret '${name}' unavailable from Key Vault (${process.env.AZURE_KEYVAULT_NAME || "kv-otc-55c84f6bef"}) — see [kv-secret] log lines above for which auth path(s) failed`);
  return v;
}
