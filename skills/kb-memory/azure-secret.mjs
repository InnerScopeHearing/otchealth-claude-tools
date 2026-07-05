// azure-secret.mjs — fetch a secret from Azure Key Vault. This is the fleet secret store after the
// GCP Secret Manager retirement (billing off, 2026-07). Returns the secret value (string) or null;
// NEVER throws (fail-open).
//
// TWO auth paths, tried in order (2026-07-05, A3-KV-REFERENCES / A9-MANAGED-IDENTITY groundwork):
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
//   AZURE_KEYVAULT_NAME   vault name (default kv-otc-55c84f6bef)
//
// Key Vault secret NAMES are a 1:1 mirror of the old GCP Secret Manager ids, so callers pass the
// exact same id (e.g. 'azure-legal-storage-key') they used with the GCP sm() helper.

let _tok = null;
let _exp = 0;
let _authMode = null; // "identity" | "sp" | null — set on first successful mint, for diagnostics only

/** Container Apps managed-identity token, via the platform-injected sidecar endpoint. Returns null
 *  (never throws) if the container has no identity attached (IDENTITY_ENDPOINT unset) or the call
 *  fails for any reason — callers fall through to the SP path. */
async function identityToken() {
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
    return j.access_token || null;
  } catch {
    return null;
  }
}

async function spToken() {
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
    return j.access_token || null;
  } catch {
    return null;
  }
}

async function vaultToken() {
  const now = Date.now();
  if (_tok && _exp - now > 60_000) return _tok; // reuse a still-valid token across calls in this process
  let tok = await identityToken();
  let mode = "identity";
  if (!tok) { tok = await spToken(); mode = "sp"; }
  if (!tok) return null;
  _tok = tok; _authMode = mode;
  _exp = now + 3600_000; // conservative fixed TTL; both paths' real tokens outlive this, and re-minting early is cheap and safe
  return _tok;
}

/** For diagnostics/logging only — which path actually authenticated last (or null if never minted). */
export function authMode() { return _authMode; }

/** Write/overwrite a secret in Key Vault (SP needs "Key Vault Secrets Officer"). Returns true on
 *  success, false otherwise. Never throws. This is the Azure replacement for the retired GCP
 *  Secret Manager addVersion() path used by OAuth token-rotation persistence (Xero/Gmail/OneDrive/QBO). */
export async function kvSecretSet(name, value) {
  const vault = process.env.AZURE_KEYVAULT_NAME || "kv-otc-55c84f6bef";
  const tok = await vaultToken();
  if (!tok) return false;
  try {
    const r = await fetch(`https://${vault}.vault.azure.net/secrets/${name}?api-version=7.4`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
      body: JSON.stringify({ value: String(value) }),
    });
    return r.ok;
  } catch {
    return false;
  }
}

/** Fetch one secret from Key Vault. Returns the trimmed value, or null if unavailable. Never throws. */
export async function kvSecret(name) {
  const vault = process.env.AZURE_KEYVAULT_NAME || "kv-otc-55c84f6bef";
  const tok = await vaultToken();
  if (!tok) return null;
  try {
    const r = await fetch(`https://${vault}.vault.azure.net/secrets/${name}?api-version=7.4`, { headers: { Authorization: `Bearer ${tok}` } });
    if (!r.ok) return null;
    const v = (await r.json()).value;
    return v == null ? null : String(v).trim() || null;
  } catch {
    return null;
  }
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
    console.error("==================================================================================");
    console.error(`[FATAL] Required secret(s) UNAVAILABLE from Key Vault (${vault}): ${missing.join(", ")}`);
    console.error(`        AZURE_SP_* creds present: ${spOk ? "yes" : "NO — set AZURE_SP_CLIENT_ID/SECRET/TENANT_ID"}.`);
    console.error("        Refusing to run with missing credentials (fail-loud, not silent). GCP Secret Manager is retired.");
    console.error("==================================================================================");
    process.exit(78);
  }
  return out;
}

// Non-exiting variant: throw (for callers that want to catch). Never returns null.
export async function kvSecretOrThrow(name) {
  const v = await kvSecret(name);
  if (v == null) throw new Error(`required secret '${name}' unavailable from Key Vault (${process.env.AZURE_KEYVAULT_NAME || "kv-otc-55c84f6bef"})`);
  return v;
}
