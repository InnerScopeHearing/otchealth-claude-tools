// azure-secret.mjs — fetch a secret from Azure Key Vault via an Entra service principal
// (client_credentials). This is the fleet secret store after the GCP Secret Manager retirement
// (billing off, 2026-07). Returns the secret value (string) or null; NEVER throws (fail-open).
//
// Env (populated by session-start.sh / the Claude Cloud environment):
//   AZURE_SP_CLIENT_ID / AZURE_SP_CLIENT_SECRET / AZURE_SP_TENANT_ID   (required)
//   AZURE_KEYVAULT_NAME   vault name (default kv-otc-55c84f6bef)
//
// Key Vault secret NAMES are a 1:1 mirror of the old GCP Secret Manager ids, so callers pass the
// exact same id (e.g. 'azure-legal-storage-key') they used with the GCP sm() helper.

let _tok = null;
let _exp = 0;

async function vaultToken() {
  const tenant = process.env.AZURE_SP_TENANT_ID;
  const cid = process.env.AZURE_SP_CLIENT_ID;
  const csec = process.env.AZURE_SP_CLIENT_SECRET;
  if (!tenant || !cid || !csec) return null;
  const now = Date.now();
  if (_tok && _exp - now > 60_000) return _tok; // reuse a still-valid token across calls in this process
  try {
    const r = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: cid, client_secret: csec, scope: "https://vault.azure.net/.default" }),
    });
    const j = await r.json();
    if (!j.access_token) return null;
    _tok = j.access_token;
    _exp = now + (Number(j.expires_in) || 3600) * 1000;
    return _tok;
  } catch {
    return null;
  }
}

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
