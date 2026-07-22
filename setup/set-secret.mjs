#!/usr/bin/env node
// set-secret.mjs, write a single secret to Azure Key Vault via kvSecretSet.
// GCP Secret Manager is fully retired fleet-wide (billing intentionally disabled, 2026-07). This is
// the write-side companion to get-secret.mjs, which was already rewritten onto Key Vault. It reuses
// kvSecretSet() from skills/kb-memory/azure-secret.mjs (the same managed-identity -> SP client
// credentials -> az-CLI/OIDC 3-path auth resolver every other fleet writer already relies on)
// instead of reimplementing the Key Vault PUT /secrets/{name} call from scratch.
//
// Key Vault secret NAMES are a 1:1 mirror of the old GCP Secret Manager ids, so every existing call
// site keeps its exact CLI shape unchanged:
//   node setup/set-secret.mjs <secret-id> <value>          # value as an arg
//   node setup/set-secret.mjs <secret-id> -                # value from stdin (PEM / multiline / binary)
//   VALUE=... node setup/set-secret.mjs <secret-id> --env  # value from $VALUE (keeps it out of argv)
//
// Auth (same 3-path resolver as get-secret.mjs's sibling primitives, via kvSecretSet):
//   1. managed identity (IDENTITY_ENDPOINT / IDENTITY_HEADER, Container Apps sidecar)
//   2. AZURE_SP_CLIENT_ID / AZURE_SP_CLIENT_SECRET / AZURE_SP_TENANT_ID (client_credentials)
//   3. az-CLI / OIDC (az account get-access-token, for federated GitHub Actions logins)
// AZURE_KEYVAULT_NAME overrides the target vault (default kv-otc-55c84f6bef).
//
// Unlike Secret Manager, Key Vault has no separate create-container step: a PUT on a secret name
// creates it if new, or adds a new version if it already exists, so this script is a single call
// (no create-then-addVersion two-step, and no 409-means-exists special case).

import { readFileSync } from 'node:fs';
import { kvSecretSet } from '../skills/kb-memory/azure-secret.mjs';

const id = process.argv[2];
const src = process.argv[3];
if (!id || src === undefined) { console.error('usage: set-secret.mjs <secret-id> <value|-|--env>'); process.exit(1); }

let value;
if (src === '-') value = readFileSync(0); // stdin (Buffer)
else if (src === '--env') { value = process.env.VALUE; if (value === undefined) { console.error('set-secret: --env given but $VALUE is unset'); process.exit(1); } }
else value = src;
const str = Buffer.isBuffer(value) ? value.toString('utf8') : String(value);

const ok = await kvSecretSet(id, str);
if (!ok) {
  console.error(`[set-secret] FAILED to write "${id}" to Key Vault (see the [kv-secret] log lines above for which auth path(s) failed)`);
  process.exit(1);
}
console.error(`[set-secret] wrote ${str.length} chars -> Key Vault secret "${id}"`);
