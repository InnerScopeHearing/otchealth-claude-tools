#!/usr/bin/env node
// get-secret-azure.mjs — materialize a single secret from Azure Key Vault on demand.
// Azure mirror of get-secret.mjs (GCP retired). For PEM / multiline / binary secrets
// that must NOT go in the flat credentials.env (e.g. medreview-asc-api-key-p8).
//
// Usage:  node setup/get-secret-azure.mjs <secret-name> [outfile]
// Auth:   AZURE_SP_CLIENT_ID / AZURE_SP_CLIENT_SECRET / AZURE_SP_TENANT_ID
//         AZURE_KEYVAULT_NAME (default kv-otc-55c84f6bef)
//
//   node setup/get-secret-azure.mjs medreview-asc-api-key-p8 /tmp/AuthKey.p8
//   node setup/get-secret-azure.mjs fourvault-neon-database-url   # -> stdout

import { writeFileSync, chmodSync } from 'node:fs';

const name = process.argv[2];
const outfile = process.argv[3];
if (!name) { console.error('usage: get-secret-azure.mjs <secret-name> [outfile]'); process.exit(1); }

const VAULT  = process.env.AZURE_KEYVAULT_NAME || 'kv-otc-55c84f6bef';
const TENANT = process.env.AZURE_SP_TENANT_ID;
const CID    = process.env.AZURE_SP_CLIENT_ID;
const CSEC   = process.env.AZURE_SP_CLIENT_SECRET;
if (!TENANT || !CID || !CSEC) { console.error('[get-secret-azure] AZURE_SP_* not set'); process.exit(1); }

const tr = await fetch(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`, {
  method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'client_credentials', client_id: CID, client_secret: CSEC, scope: 'https://vault.azure.net/.default' }),
});
const tj = await tr.json().catch(() => ({}));
if (!tj.access_token) { console.error(`[get-secret-azure] auth ${tj.error || tr.status}`); process.exit(1); }

const r = await fetch(`https://${VAULT}.vault.azure.net/secrets/${name}?api-version=7.4`, { headers: { Authorization: `Bearer ${tj.access_token}` } });
if (!r.ok) { console.error(`access ${name} ${r.status}: ${(await r.text()).slice(0, 200)}`); process.exit(1); }
const val = (await r.json()).value || '';
if (outfile) { writeFileSync(outfile, val, { mode: 0o600 }); chmodSync(outfile, 0o600); console.error(`[get-secret-azure] wrote ${val.length} bytes -> ${outfile} (600)`); }
else process.stdout.write(val);
