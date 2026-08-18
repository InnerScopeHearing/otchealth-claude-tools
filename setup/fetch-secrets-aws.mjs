#!/usr/bin/env node
// fetch-secrets-aws.mjs — hydrate a session's fleet secrets from AWS SSM Parameter Store.
//
// The AWS sibling of fetch-secrets-azure.mjs, and the one that works: Azure subscription 55c84f6b
// is permanently gone, so the Key Vault hydrator returns nothing and every agent session was
// starting with an empty ~/.designer/credentials.env. All 444 fleet secrets are already mirrored to
// SSM under /otchealth/<id>; this is the read path session-start.sh was missing.
//
// Output contract is IDENTICAL to fetch-secrets-azure.mjs, because session-start.sh folds either
// one into the same file with the same parser: `ENV_NAME='value'` lines on stdout, single-quoted
// with embedded quotes escaped, one per resolved secret, nothing else. Diagnostics go to stderr.
// Exit 0 on success, 2 if a `required: true` secret was missing, 1 if the store was unreachable.
//
// Env:
//   AWS_REGION      default us-east-1
//   AWS_SSM_PREFIX  default /otchealth
//   Credentials via the ECS/EC2 task role, else AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY.
//
// The id -> env table lives in setup/secret-map.mjs, shared with the Azure hydrator so the two
// cannot drift (see that file, and tests/secret-map-parity.test.mjs).

import { ssmListDetailed, ssmSecret, ssmAvailable } from '../skills/kb-memory/aws-secret.mjs';
import { MAP } from './secret-map.mjs';

const PREFIX = process.env.AWS_SSM_PREFIX || '/otchealth';
const REGION = process.env.AWS_REGION || 'us-east-1';

if (!(await ssmAvailable())) {
  // Distinguish "no credentials here" from "credentials fine, secret absent". Exiting 1 with an
  // empty stdout lets session-start.sh fall through to its next hydration source rather than
  // treating an unreachable store as an empty one.
  console.error(`[fetch-secrets-aws] no resolvable AWS credentials (no task role, and AWS_ACCESS_KEY_ID is unset or a sandbox proxy placeholder) — cannot fetch from ${PREFIX} in ${REGION}.`);
  process.exit(1);
}

// ENUMERATE FIRST, THEN FETCH ONLY WHAT EXISTS.
//
// The naive shape is one GetParameter per mapped id, but ~60 of these 98 secrets are optional and
// legitimately absent, so that spends ~60 round trips discovering nothing on every single session
// start. One GetParametersByPath pass tells us what is actually there, and we then fetch only the
// intersection.
//
// A failed enumeration is NOT treated as "the store is empty". ssmListDetailed() returns [] when
// the first page fails (store not reachable from here) and THROWS on a mid-pagination truncation
// precisely so a partial inventory can never masquerade as a complete one. Either way we fall back
// to fetching every mapped id directly: slower, but it cannot silently under-hydrate a session,
// which is the failure this whole script exists to fix.
let present = null;
try {
  const listed = await ssmListDetailed();
  if (listed.length) present = new Set(listed.map((p) => p.id));
  else console.error('[fetch-secrets-aws] enumeration returned nothing; falling back to per-secret fetch.');
} catch (e) {
  console.error(`[fetch-secrets-aws] enumeration incomplete (${e.message}); falling back to per-secret fetch.`);
}

const wanted = present ? MAP.filter((m) => present.has(m.id)) : MAP;
// A required secret is always attempted even when enumeration says it is absent, so its miss is
// reported by the real fetch below rather than inferred from a listing that may itself be wrong.
for (const m of MAP) {
  if (m.required && !wanted.includes(m)) wanted.push(m);
}

let hadRequiredMiss = false;
let emitted = 0;
for (const { id, env, required } of wanted) {
  let val = null;
  try {
    val = await ssmSecret(id);
  } catch (e) {
    console.error(`[fetch-secrets-aws] ${id}: ${e.message}`);
  }
  if (val) {
    // Same single-quote escaping as the Azure hydrator: session-start.sh reads these back with a
    // shell-quoted parser, so a value containing a quote must not be able to terminate the literal.
    const safe = `'${val.replace(/'/g, "'\\''")}'`;
    process.stdout.write(`${env}=${safe}\n`);
    emitted += 1;
  } else if (required) {
    // The env name is on this line ON PURPOSE. session-start.sh parses it back out to check, AFTER
    // its Key Vault fallback has run, whether the gap actually got filled -- and the table that
    // knows id -> env lives here, not in bash. Copying it into the shell would recreate exactly the
    // drift bug secret-map.mjs was extracted to kill. Keep the `MISSING required secret '<id>'`
    // prefix byte-for-byte: the shell's sed and tests/fetch-secrets-aws.test.mjs both match on it.
    console.error(`[fetch-secrets-aws] MISSING required secret '${id}' (env ${env}) at ${PREFIX}/${id} (${REGION}).`);
    hadRequiredMiss = true;
  }
}

console.error(`[fetch-secrets-aws] ${emitted} secret(s) hydrated from ${PREFIX} (${REGION})${present ? ` of ${present.size} parameter(s) present` : ''}.`);
process.exit(hadRequiredMiss ? 2 : 0);
