// azure-secret.mjs — the fleet's secret resolver. Returns the secret value (string) or null;
// NEVER throws (fail-open). ~400 callers depend on that contract; do not change it.
//
// THE ACTIVE STORE IS AWS SSM (2026-08-18, Azure-exit item 2). Azure subscription 55c84f6b is
// PERMANENTLY GONE, so Key Vault cannot serve any read. SECRET_BACKEND therefore defaults to "ssm"
// (see secretBackend() below) instead of the historical "keyvault". The file keeps its name and its
// Key Vault code paths on purpose: they are the transition fallback, they are what a future
// re-provisioned vault would use, and renaming a module ~400 call sites import is a bigger blast
// radius than the outage this fixes. Set SECRET_BACKEND=keyvault to restore the legacy ordering.
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

import { ssmSecret, ssmSecretSet, ssmAvailable } from "./aws-secret.mjs";
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
let _kvMirrorSkipNoted = false;
let _backendWarned = false;

/**
 * Which store is the ACTIVE PRIMARY: "ssm" (default) or "keyvault".
 *
 * DEFAULT CHANGED 2026-08-18 from "keyvault" to "ssm". Azure subscription 55c84f6b is permanently
 * gone, so the old default made every read address a dead store first and pay the full three-path
 * Key Vault auth walk (identity -> SP -> az CLI, each a network round trip) before reaching the SSM
 * mirror that already holds all 444 parameters. SECRET_BACKEND was grep-confirmed unset everywhere
 * in the fleet, so nothing was overriding it and every caller paid that cost on every read.
 *
 * An UNRECOGNISED value resolves to "ssm" rather than erroring or falling back to "keyvault": a
 * typo must not silently route the fleet at a store that cannot answer. It warns once so the typo
 * is visible without turning a config slip into an outage.
 */
export function secretBackend() {
  const raw = process.env.SECRET_BACKEND;
  if (raw == null || raw === "") return "ssm";
  const v = String(raw).trim().toLowerCase();
  if (v === "ssm" || v === "keyvault") return v;
  if (!_backendWarned) {
    _backendWarned = true;
    console.warn(`[kv-secret] note (once): SECRET_BACKEND="${raw}" is not recognised (expected "ssm" or "keyvault"); using "ssm".`);
  }
  return "ssm";
}

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
  // DUAL-WRITE (2026-08-16). Nothing syncs Key Vault to SSM -- the mirror was a one-time bulk copy.
  // If a rotation landed in only one store, the other would keep serving the OLD value, the read
  // would SUCCEED, no fallback would fire, and the damage would surface later as an unexplained auth
  // failure somewhere else entirely. Writing both here is what keeps the fallback above trustworthy.
  // The SSM leg is attempted first and its result folded into the return value, so a half-written
  // rotation is reported rather than silently accepted.
  const backend = secretBackend();
  const ssmOk = await ssmSecretSet(name, value).catch(() => false);

  // MIRROR LEG. With Key Vault as primary this is the anti-drift dual-write described above and it
  // always runs. With SSM as primary (the default since the Azure exit) the vault is a dead host:
  // writing to it would burn all three auth paths on every single write and then report a "partial
  // rotation" that is not a divergence at all, just a store that no longer exists. So it is OFF by
  // default there and re-armed with SECRET_MIRROR_KEYVAULT=1 the moment a vault exists again.
  const mirrorKeyVault = backend === "keyvault" || process.env.SECRET_MIRROR_KEYVAULT === "1";
  if (!mirrorKeyVault && !_kvMirrorSkipNoted) {
    _kvMirrorSkipNoted = true;
    console.warn(
      `[kv-secret] note (once): writing to AWS SSM only; the Key Vault mirror leg is off because ` +
        `SECRET_BACKEND=ssm (Azure subscription retired). Set SECRET_MIRROR_KEYVAULT=1 to dual-write again.`,
    );
  }
  const kvOk = mirrorKeyVault ? await kvSecretSetAzure(name, value) : false;

  // Divergence is only meaningful when BOTH stores were actually written. When the mirror leg is
  // deliberately skipped, kvOk is false by construction and shouting "PARTIAL ROTATION" on every
  // write would be a permanent false alarm -- the exact alert-fatigue shape that trains a fleet to
  // ignore a real one.
  if (mirrorKeyVault) {
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
  // BUG FIXED 2026-08-18: this used to read `(process.env.SECRET_BACKEND || "keyvault") === "ssm"`,
  // so with SECRET_BACKEND unset (its state everywhere in the fleet) it returned kvOk. Against a
  // retired subscription kvOk is always false, so setup/set-secret.mjs printed FAILED and exited 1
  // on every write that had in fact landed in SSM correctly -- reporting a durable, successful
  // rotation as a failure.
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

/** Fetch one fleet secret. Returns the trimmed value, or null if no store can serve it.
 *
 *  NEVER THROWS. This is a load-bearing contract, not an implementation detail: roughly 400 call
 *  sites treat a null as "not configured" and degrade gracefully. Making this throw would convert
 *  a partial outage into a total one across the whole fleet.
 *
 *  Resolution order is the ACTIVE PRIMARY store first (AWS SSM by default, see secretBackend()),
 *  then the other store on any failure of the first. Per-store credential behaviour is documented
 *  on keyVaultRead() and resolveSecret(). For which store answered, use kvSecretStatus(). */
export async function kvSecret(name, opts) {
  return (await resolveSecret(name, opts)).value;
}

/**
 * The Key Vault leg, on its own, so that "stop trying Azure credentials" can never mean "stop
 * trying other STORES".
 *
 * BUG FIXED 2026-08-18: this loop used to live inline in kvSecret(), where its non-auth bail-out
 * (`if (r.status !== 401 && r.status !== 403) return null`) returned from kvSecret ITSELF and
 * therefore jumped clean over the SSM fallback below it. Any Key Vault reply that was not exactly
 * 401/403 -- a 5xx, a gateway/proxy error, the not-found-shaped response a retired subscription's
 * vault host produces -- resolved the whole call to null while a perfectly good SSM copy sat
 * unread. The fallback existed but was unreachable for a whole class of failures.
 *
 * The credential-escalation policy itself is deliberately unchanged: a 404 (wrong secret name) or
 * 5xx (vault genuinely down) still stops us from trying the OTHER AZURE IDENTITY, because retrying
 * with a different credential cannot fix either one and would mask a real, different bug. It now
 * returns from this helper, so the caller's cross-store fallback still runs.
 *
 * EXPORTED (2026-08-18) so a caller that must compare the two STORES can address this leg directly
 * instead of going through kvSecret() and hoping SECRET_BACKEND keeps it on the Azure side. That
 * hope was misplaced: skills/kb-memory/secret-drift.mjs forced SECRET_BACKEND=keyvault for exactly
 * that reason, but this helper's non-auth bail-out returns to resolveSecret(), whose cross-store
 * fallback then answered from SSM -- so the drift check compared SSM against itself and reported
 * perfect agreement. A checker must never reach the store it is checking AGAINST through a resolver
 * whose whole job is to paper over which store answered.
 *
 * `attempts` is the honest half of the return: it separates "the vault answered and said 404" from
 * "no auth path here could even reach a vault". Collapsing those two into a bare null is what lets
 * an unreachable store masquerade as an empty one.
 *
 * @returns {Promise<{ value: string|null, attempts: string[] }>}
 */
export async function keyVaultRead(name, { raw = false } = {}) {
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
        // raw: exact stored bytes (PEM materialization). See ssmSecret()'s header for why the trim
        // is the default everywhere else and why it is wrong for a key file.
        if (v == null) return { value: null, attempts };
        return { value: raw ? String(v) : String(v).trim() || null, attempts };
      }
      attempts.push(`${mode}:http-${r.status}`);
      if (r.status !== 401 && r.status !== 403) return { value: null, attempts }; // 404/5xx: don't retry via the other AZURE credential
    } catch (e) {
      attempts.push(`${mode}:error-${String(e && e.message || e)}`);
    }
  }
  return { value: null, attempts };
}

/**
 * Shared resolver behind kvSecret() and kvSecretStatus(). Tries the ACTIVE primary store first,
 * then the other one -- always, for every failure mode of the first.
 *
 * The cross-store fallback is the whole point: it is what lets a job keep its credentials when one
 * cloud is unreachable. Without it, an outage does not merely degrade the brain, it takes away
 * every job's ability to authenticate to anything, including whatever would have reported the
 * outage. Never throws.
 *
 * @returns {Promise<{ value: string|null, source: "ssm"|"keyvault"|null, backend: string,
 *                     keyVaultAttempts: string[], ssmTried: boolean }>}
 */
async function resolveSecret(name, { raw = false } = {}) {
  const backend = secretBackend();
  const out = { value: null, source: null, backend, keyVaultAttempts: [], ssmTried: false };

  if (backend === "ssm") {
    out.ssmTried = true;
    const v = await ssmSecret(name, { raw });
    if (v != null) { out.value = v; out.source = "ssm"; return out; }
    // Fall through to Key Vault rather than returning null: during the transition the mirror may
    // not yet carry a newly-created secret.
  }

  const kv = await keyVaultRead(name, { raw });
  out.keyVaultAttempts = kv.attempts;
  if (kv.value != null) { out.value = kv.value; out.source = "keyvault"; return out; }
  if (kv.attempts.length) {
    console.error(`[kv-secret] READ failed for "${name}" via all auth paths: ${kv.attempts.join(", ")}`);
  }

  // Key Vault could not serve it. If SSM was not already tried as primary, try it now -- this is
  // the branch that runs during an Azure outage, when every attempt above fails on auth or network.
  if (!out.ssmTried) {
    out.ssmTried = true;
    const v = await ssmSecret(name, { raw });
    if (v != null) {
      if (!_ssmFallbackNoted) {
        _ssmFallbackNoted = true;
        console.warn(
          `[kv-secret] note (once): serving secrets from the AWS SSM mirror because Key Vault did not answer. ` +
            `This is the Azure-outage fallback working as designed, not a failure.`,
        );
      }
      out.value = v;
      out.source = "ssm";
      return out;
    }
  }
  return out;
}

/**
 * DIAGNOSTIC sibling of kvSecret() for health checks, canaries and pagers: same resolution, but it
 * reports WHICH store answered and what each path did, instead of collapsing everything to a value
 * or null.
 *
 * Added as a SEPARATE primitive on purpose. kvSecret()'s header promises "NEVER throws (fail-open)"
 * and roughly 400 call sites are built on that promise; making it throw during an outage would turn
 * a degraded fleet into a dead one. This function does not throw either -- a health caller decides
 * for itself what to do with `{ value: null, source: null }`, which is strictly more information
 * than an exception carries. kvSecretOrThrow() remains the throwing option for callers that want
 * one.
 */
export async function kvSecretStatus(name, opts) {
  return resolveSecret(name, opts);
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
    const backend = secretBackend();
    const ssmOk = await ssmAvailable();
    console.error("==================================================================================");
    console.error(`[FATAL] Required secret(s) UNAVAILABLE from BOTH stores: ${missing.join(", ")}`);
    console.error(`        Active primary: ${backend === "ssm" ? `AWS SSM (${process.env.AWS_SSM_PREFIX || "/otchealth"}, region ${process.env.AWS_REGION || "us-east-1"})` : `Azure Key Vault (${vault})`}.`);
    console.error(`        AWS credentials resolvable: ${ssmOk ? "yes" : "NO — no task role and no usable AWS_ACCESS_KEY_ID"}.`);
    console.error(`        Azure fallback: managed identity ${identityOk ? "yes" : "no"}, AZURE_SP_* ${spOk ? "yes" : "NO"}, az-CLI/OIDC ${azOk ? "yes" : "no"}.`);
    console.error("        Both stores were tried per secret (see [kv-secret] WARN/ERROR lines above for which path");
    console.error("        failed and how — a 401/403 means an RBAC grant is likely missing on the identity).");
    console.error("        Refusing to run with missing credentials (fail-loud, not silent). GCP Secret Manager is retired,");
    console.error("        and Azure subscription 55c84f6b is permanently gone — AWS SSM is the live store.");
    console.error("==================================================================================");
    process.exit(78);
  }
  return out;
}

// Non-exiting variant: throw (for callers that want to catch). Never returns null.
export async function kvSecretOrThrow(name) {
  const v = await kvSecret(name);
  if (v == null) {
    const backend = secretBackend();
    const where = backend === "ssm"
      ? `AWS SSM (${process.env.AWS_SSM_PREFIX || "/otchealth"}) with an Azure Key Vault (${process.env.AZURE_KEYVAULT_NAME || "kv-otc-55c84f6bef"}) fallback`
      : `Azure Key Vault (${process.env.AZURE_KEYVAULT_NAME || "kv-otc-55c84f6bef"}) with an AWS SSM fallback`;
    throw new Error(`required secret '${name}' unavailable from ${where} — see [kv-secret] log lines above for which path(s) failed`);
  }
  return v;
}
