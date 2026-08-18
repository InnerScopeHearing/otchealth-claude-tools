#!/usr/bin/env node
// get-secret-azure.mjs — materialize a single fleet secret on demand.
//
// Usage:  node setup/get-secret-azure.mjs <secret-name> [outfile]
//
// KEPT AS AN ALIAS, NOT A SECOND IMPLEMENTATION. This file and get-secret.mjs were byte-for-byte
// the same open-coded, Key-Vault-only HTTP call with no fallback, so the retired Azure subscription
// broke both identically. Rather than fix the same bug twice and leave two copies to drift, this
// now delegates to get-secret.mjs, which delegates in turn to the shared kvSecret() resolver
// (AWS SSM first, Azure Key Vault fallback).
//
// The name survives because scripts, runbooks and muscle memory across the fleet still type it. The
// "-azure" in it is now historical: it names the file, not the store it reads. For new work use
// get-secret.mjs (or get-secret-aws.mjs when a caller must bypass the fallback and hit SSM only).
//
// Auth and env are whatever the shared resolver accepts -- AWS task role or AWS_ACCESS_KEY_ID for
// SSM, then Azure managed identity / AZURE_SP_* / az-CLI for Key Vault. SECRET_BACKEND=keyvault
// restores the legacy Key-Vault-first ordering.
//
//   node setup/get-secret-azure.mjs medreview-asc-api-key-p8 /tmp/AuthKey.p8
//   node setup/get-secret-azure.mjs fourvault-neon-database-url   # -> stdout

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
if (!args[0]) { console.error('usage: get-secret-azure.mjs <secret-name> [outfile]'); process.exit(1); }

// Delegate through the real binary rather than importing it: get-secret.mjs is a top-level-await
// CLI that writes to stdout and calls process.exit, so importing it would fire its side effects at
// module-load time and make the exit code impossible to forward cleanly. stdio:'inherit' keeps the
// stdout bytes exact (no trailing newline added) and preserves the 600-mode outfile behaviour.
const target = join(dirname(fileURLToPath(import.meta.url)), 'get-secret.mjs');
const r = spawnSync(process.execPath, [target, ...args], { stdio: 'inherit' });
if (r.error) { console.error(`[get-secret-azure] ${r.error.message}`); process.exit(1); }
process.exit(r.status == null ? 1 : r.status);
