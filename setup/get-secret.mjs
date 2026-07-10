#!/usr/bin/env node
// get-secret.mjs — materialize a single secret from Azure Key Vault on demand.
// GCP Secret Manager is fully retired (billing intentionally disabled fleet-wide, 2026-07) — this
// script now reads Key Vault directly instead of GCP. Key Vault secret NAMES are a 1:1 mirror of the
// old GCP Secret Manager ids, so every existing call site across the fleet keeps working unchanged.
// (This absorbs get-secret-azure.mjs's logic under the original, muscle-memory filename/CLI so no
// script or agent habit needs to change what it types.)
//
// For PEM / multiline / binary secrets that must NOT go in the flat credentials.env
// (e.g. medreview-asc-api-key-p8). Writes to a file (chmod 600) or stdout.
//
// Usage:
//   node setup/get-secret.mjs <secret-id> [outfile]
// Auth: AZURE_SP_CLIENT_ID / AZURE_SP_CLIENT_SECRET / AZURE_SP_TENANT_ID
//       AZURE_KEYVAULT_NAME (default kv-otc-55c84f6bef)
//
//   node setup/get-secret.mjs medreview-asc-api-key-p8 /tmp/AuthKey.p8
//   node setup/get-secret.mjs fourvault-neon-database-url   # -> stdout

import { writeFileSync, chmodSync } from 'node:fs';

const id = process.argv[2];
const outfile = process.argv[3];
if (!id) { console.error('usage: get-secret.mjs <secret-id> [outfile]'); process.exit(1); }

const VAULT  = process.env.AZURE_KEYVAULT_NAME || 'kv-otc-55c84f6bef';
const TENANT = process.env.AZURE_SP_TENANT_ID;
const CID    = process.env.AZURE_SP_CLIENT_ID;
const CSEC   = process.env.AZURE_SP_CLIENT_SECRET;
if (!TENANT || !CID || !CSEC) { console.error('[get-secret] AZURE_SP_* not set (GCP Secret Manager is retired, this now requires Azure SP creds)'); process.exit(1); }

const tr = await fetch(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`, {
  method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'client_credentials', client_id: CID, client_secret: CSEC, scope: 'https://vault.azure.net/.default' }),
});
const tj = await tr.json().catch(() => ({}));
if (!tj.access_token) { console.error(`[get-secret] auth ${tj.error || tr.status}`); process.exit(1); }

const r = await fetch(`https://${VAULT}.vault.azure.net/secrets/${id}?api-version=7.4`, { headers: { Authorization: `Bearer ${tj.access_token}` } });
if (!r.ok) { console.error(`access ${id} ${r.status}: ${(await r.text()).slice(0, 200)}`); process.exit(1); }
const val = (await r.json()).value || '';
if (outfile) { writeFileSync(outfile, val, { mode: 0o600 }); chmodSync(outfile, 0o600); console.error(`[get-secret] wrote ${val.length} bytes -> ${outfile} (600)`); }
else process.stdout.write(val);
