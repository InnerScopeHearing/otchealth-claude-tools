#!/usr/bin/env node
// get-secret.mjs — materialize a single fleet secret on demand.
//
// This is the command every CLAUDE.md in the fleet tells an agent to run, so its CLI contract is
// frozen:  node setup/get-secret.mjs <secret-id> [outfile]
// With an outfile it writes the raw value to that path at mode 600; otherwise it writes the value
// to stdout with NO trailing newline (callers do `$(node setup/get-secret.mjs x)` and a newline
// would corrupt a header value). Exits 1 on any miss.
//
// STORE (2026-08-18): resolution is delegated to kvSecret() in skills/kb-memory/azure-secret.mjs,
// the same resolver ~400 fleet call sites already use. That means AWS SSM first (the live store)
// with an Azure Key Vault fallback, and it means this script inherits every future change to the
// fleet's secret routing for free.
//
// WHY THIS STOPPED BEING A DIRECT HTTP CALL: it used to open-code its own Key-Vault-only token
// exchange and GET, with no fallback of any kind, and it exited 1 up front unless AZURE_SP_* were
// all set. Against the retired Azure subscription that made the fleet's single most-documented
// command fail 100% of the time -- on a seat with no Azure SP it never even attempted a read, and
// on a seat with one it authenticated to a dead vault -- while the value sat readable in SSM. A
// second copy of the resolution logic was the bug; there is now one copy.
//
// Auth is whatever the shared resolver accepts, in its order:
//   AWS   task/instance role, else AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY  (AWS_REGION, AWS_SSM_PREFIX)
//   Azure managed identity, else AZURE_SP_CLIENT_ID/_SECRET/_TENANT_ID, else az CLI / OIDC
//         (AZURE_KEYVAULT_NAME, default kv-otc-55c84f6bef)
// SECRET_BACKEND=keyvault restores the legacy Key-Vault-first ordering.
//
//   node setup/get-secret.mjs medreview-asc-api-key-p8 /tmp/AuthKey.p8
//   node setup/get-secret.mjs fourvault-neon-database-url   # -> stdout

import { writeFileSync, chmodSync } from 'node:fs';
import { kvSecretStatus, secretBackend } from '../skills/kb-memory/azure-secret.mjs';

const id = process.argv[2];
const outfile = process.argv[3];
if (!id) { console.error('usage: get-secret.mjs <secret-id> [outfile]'); process.exit(1); }

// kvSecretStatus is the diagnostic sibling of kvSecret: same resolution, but it also reports which
// store answered. On a miss that detail is the difference between "typo in the name" and "neither
// store is reachable from this seat", so it is worth surfacing on the error path.
//
// raw: true is REQUIRED here, not a preference. This script's whole reason to exist is
// materializing PEM / multiline / binary secrets, and the shared resolver trims by default --
// correct for the header-and-connection-string callers it was built for, wrong for a key file.
// Without it, routing this path through the resolver silently truncated every stored PEM by its
// terminating newline: measured, a 148-byte asc-api-key-p8 landed on disk as 147 bytes with exit 0
// and "wrote 147 bytes" printed as if nothing had happened. The same trim collapsed a
// whitespace-only value to null and reported a secret the store IS holding as a total miss. Pinned
// by tests/get-secret-raw-bytes.test.mjs.
const res = await kvSecretStatus(id, { raw: true });
if (res.value == null) {
  console.error(`[get-secret] "${id}" not available from either store (primary: ${secretBackend()}).`);
  if (res.keyVaultAttempts.length) console.error(`[get-secret] key vault attempts: ${res.keyVaultAttempts.join(', ')}`);
  if (!res.ssmTried) console.error('[get-secret] AWS SSM was not reached (no resolvable AWS credentials on this seat).');
  process.exit(1);
}

const val = res.value;
if (outfile) {
  writeFileSync(outfile, val, { mode: 0o600 });
  chmodSync(outfile, 0o600);
  console.error(`[get-secret] wrote ${val.length} bytes -> ${outfile} (600) [from ${res.source}]`);
} else {
  process.stdout.write(val);
}
