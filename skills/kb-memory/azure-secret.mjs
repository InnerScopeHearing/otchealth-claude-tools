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
