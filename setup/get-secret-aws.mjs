#!/usr/bin/env node
// get-secret-aws.mjs — materialize a single secret from AWS SSM Parameter Store on demand.
//
// The AWS sibling of get-secret-azure.mjs / get-secret.mjs, and the one that SURVIVES the Azure
// retirement: SSM (arn:aws:ssm:us-east-1:*:parameter/otchealth/*) is already the store the gateway
// task definition reads every one of its ~65 secrets from. New fleet secrets should land here first,
// with Key Vault kept only as a transition mirror.
//
// Usage:  node setup/get-secret-aws.mjs <secret-name> [outfile]
//   node setup/get-secret-aws.mjs tavily-api-key /tmp/tavily.key
//   node setup/get-secret-aws.mjs tavily-api-key          # -> stdout, no trailing newline
//
// Name handling matches the rest of the toolkit: pass the BARE name ("tavily-api-key"). ssmSecret()
// prefixes /otchealth/ itself, so a caller never has to know the parameter-store layout -- and a
// fully-qualified name would double the prefix, so do NOT pass one.
//
// Auth: the same chain ssmSecret() itself uses — the task/instance role when running inside AWS,
// then AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY, then the aws-cto-* keys out of Key Vault. Exits
// non-zero on a miss so a caller can fall back to the Azure/GCP helpers rather than silently
// proceeding with an empty value.
import { writeFileSync, chmodSync } from 'node:fs';
import { ssmSecret } from '../skills/kb-memory/aws-secret.mjs';

const name = process.argv[2];
const outfile = process.argv[3];
if (!name) {
  console.error('usage: get-secret-aws.mjs <secret-name> [outfile]');
  process.exit(1);
}

let value = null;
try {
  value = await ssmSecret(name);
} catch (e) {
  console.error(`[get-secret-aws] ${name}: ${e.message}`);
  process.exit(1);
}
if (value == null || value === '') {
  console.error(`[get-secret-aws] ${name}: not found in SSM`);
  process.exit(1);
}

if (outfile) {
  writeFileSync(outfile, value);
  chmodSync(outfile, 0o600); // same posture as the Azure/GCP helpers: never world-readable
  console.error(`[get-secret-aws] ${name} -> ${outfile}`);
} else {
  // No trailing newline: callers do `$(node get-secret-aws.mjs x)` and a newline would corrupt a
  // header value. Matches get-secret-azure.mjs.
  process.stdout.write(value);
}
