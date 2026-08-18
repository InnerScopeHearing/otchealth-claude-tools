#!/usr/bin/env node
// get-secret.mjs — materialize a single secret on demand. THE canonical single-secret fetch tool
// (claude-tools/CLAUDE.md: "fetch it by the row's Secret Manager ID via `node setup/get-secret.mjs
// <id> <outfile>`"), so its behavior is widely depended on across the fleet.
//
// REFACTORED 2026-08-18 (the agent-seat credential bootstrap fix) to read through kb-memory's shared
// kvSecret() resolver instead of a hand-rolled, SP-client-credentials-ONLY fetch. The old hand-rolled
// path hard-required AZURE_SP_CLIENT_ID/SECRET/TENANT_ID and had NO fallback at all -- since Azure Key
// Vault became permanently unreachable on 2026-08-18 (see azure-secret.mjs's header), that meant this
// script could no longer fetch ANYTHING, from ANY seat, by ANY means. It now tries every path
// kvSecret() supports (managed identity -> AZURE_SP_* -> az-CLI/OIDC -> the AWS SSM mirror), so a seat
// with only OTC_AWS_ACCESS_KEY_ID/SECRET set (see skills/kb-memory/SKILL.md "Credential bootstrap")
// can fetch again.
//
// BEHAVIOR NOTE (review this if a previously-working PEM/multiline secret ever looks subtly wrong):
// kvSecret() trims leading/trailing whitespace off every value it returns (matching get-secret-aws.mjs's
// existing, already-shipped SSM-path behavior, so the two sibling scripts stay consistent with each
// other) -- the OLD hand-rolled fetch in this file did NOT trim. For a typical API key this is a no-op.
// For a PEM this means a trailing newline the secret was originally stored with will not survive a
// re-fetch; every PEM parser this fleet uses (OpenSSL / Node crypto / ASC's own upload) tolerates a
// missing final newline, so this is not expected to break anything, but it IS a real behavior change
// from before and is called out here rather than left to be discovered later.
//
// For PEM / multiline / binary secrets that must NOT go in the flat credentials.env
// (e.g. medreview-asc-api-key-p8). Writes to a file (chmod 600) or stdout.
//
// Usage:
//   node setup/get-secret.mjs <secret-id> [outfile]
// Auth (any ONE is sufficient; see skills/kb-memory/SKILL.md "Credential bootstrap"):
//   AZURE_SP_CLIENT_ID / AZURE_SP_CLIENT_SECRET / AZURE_SP_TENANT_ID   Azure service principal
//   IDENTITY_ENDPOINT / IDENTITY_HEADER                                Azure Container Apps managed identity
//   OTC_AWS_ACCESS_KEY_ID / OTC_AWS_SECRET_ACCESS_KEY                  AWS SSM mirror (Azure-independent)
//   AZURE_KEYVAULT_NAME (default kv-otc-55c84f6bef), used only for diagnostic messages
//
//   node setup/get-secret.mjs medreview-asc-api-key-p8 /tmp/AuthKey.p8
//   node setup/get-secret.mjs fourvault-neon-database-url   # -> stdout

import { writeFileSync, chmodSync } from 'node:fs';
import { kvSecret } from '../skills/kb-memory/azure-secret.mjs';
import { awsCredsPresent } from '../skills/kb-memory/aws-secret.mjs';

const id = process.argv[2];
const outfile = process.argv[3];
if (!id) { console.error('usage: get-secret.mjs <secret-id> [outfile]'); process.exit(1); }

const VAULT = process.env.AZURE_KEYVAULT_NAME || 'kv-otc-55c84f6bef';

const val = await kvSecret(id);
if (val == null) {
  const identityOk = Boolean(process.env.IDENTITY_ENDPOINT && process.env.IDENTITY_HEADER);
  const spOk = Boolean(process.env.AZURE_SP_CLIENT_ID && process.env.AZURE_SP_CLIENT_SECRET && process.env.AZURE_SP_TENANT_ID);
  const aws = awsCredsPresent();
  console.error(
    `[get-secret] '${id}' unavailable from Key Vault (${VAULT}) or its AWS SSM fallback. ` +
    `managed identity: ${identityOk ? 'yes' : 'no'}. AZURE_SP_* present: ${spOk ? 'yes' : 'no'}. ` +
    `AWS creds resolvable: ${aws.any ? 'yes, but this secret was not found there either' : 'NO -- set OTC_AWS_ACCESS_KEY_ID + OTC_AWS_SECRET_ACCESS_KEY'}. ` +
    `See [kv-secret] log lines above for which auth path(s) failed and how.`,
  );
  process.exit(1);
}
if (outfile) { writeFileSync(outfile, val, { mode: 0o600 }); chmodSync(outfile, 0o600); console.error(`[get-secret] wrote ${val.length} bytes -> ${outfile} (600)`); }
else process.stdout.write(val);
