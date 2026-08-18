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
//
// COMPLETENESS is reported STRUCTURALLY, not just in the stderr prose above: when
// FLEET_HYDRATION_RESULT_FILE is set, writeHydrationResult() (setup/hydration-result.mjs) writes a
// JSON record of exactly what happened -- reachable, how many lines were emitted, and the precise
// {id, env} of every required secret that did not resolve. session-start.sh's report
// (setup/hydration-report.mjs) reads that file instead of re-deriving the same facts by
// pattern-matching this file's stderr sentences, which is the parsing step that hid three rounds
// of "failure reported as success" bugs. See hydration-result.mjs for the full history.

import { ssmListDetailed, ssmSecret, ssmAvailable } from '../skills/kb-memory/aws-secret.mjs';
import { MAP } from './secret-map.mjs';
import { writeHydrationResult } from './hydration-result.mjs';

const PREFIX = process.env.AWS_SSM_PREFIX || '/otchealth';
const REGION = process.env.AWS_REGION || 'us-east-1';
// When set, session-start.sh reads THIS file (via hydration-report.mjs) instead of re-parsing the
// human-readable stderr lines below. Optional so this script still runs standalone / under test
// with no path at all -- writeHydrationResult() is a no-op without one.
const RESULT_FILE = process.env.FLEET_HYDRATION_RESULT_FILE || '';
const REQUIRED_TOTAL = MAP.filter((m) => m.required).length;

// NEVER call process.exit() IN THIS FILE (bug fixed 2026-08-18). stdout here is a PIPE -- the
// caller is `FETCHED="$(node setup/fetch-secrets-aws.mjs ...)"` in session-start.sh -- and Node
// writes to a pipe ASYNCHRONOUSLY. process.exit() tears the process down immediately and DISCARDS
// whatever is still queued, so the exit code says "complete" about output that is not. Measured
// through that exact command-substitution shape: 1000 queued lines arrived as 35-47, exit 0, no
// warning anywhere. That directly contradicts session-start.sh's "THE HYDRATOR'S EXIT CODE IS THE
// ANSWER" -- a trusted rc=0 could accompany a silently half-hydrated session, which is the same
// failure-as-a-plausible-value shape this whole branch exists to remove.
//
// So: set process.exitCode and RETURN. Node then drains stdout before exiting on its own. The work
// lives in main() purely so an early failure can `return` instead of reaching for process.exit().
// tests/fetch-secrets-aws.test.mjs pins both the no-process.exit rule and the byte-completeness.
async function main() {
if (!(await ssmAvailable())) {
  // Distinguish "no credentials here" from "credentials fine, secret absent". Exiting 1 with an
  // empty stdout lets session-start.sh fall through to its next hydration source rather than
  // treating an unreachable store as an empty one.
  console.error(`[fetch-secrets-aws] no resolvable AWS credentials (no task role, and AWS_ACCESS_KEY_ID is unset or a sandbox proxy placeholder) — cannot fetch from ${PREFIX} in ${REGION}.`);
  // Store-truth, not session-truth: the STORE could not be reached, so its own requiredMissing
  // list is not evidence of anything (a caller must read `reachable` first -- see statusOf() in
  // hydration-result.mjs). Populated anyway for a complete, self-consistent record rather than an
  // empty array that would misleadingly read as "reachable, nothing missing".
  writeHydrationResult(RESULT_FILE, {
    store: 'aws-ssm',
    reachable: false,
    emittedCount: 0,
    requiredTotal: REQUIRED_TOTAL,
    requiredMissing: MAP.filter((m) => m.required).map((m) => ({ id: m.id, env: m.env })),
  });
  process.exitCode = 1;
  return;
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
// The requiredMissing entries below are the SAME {id, env} pairs the `MAP` rows already hold --
// never text re-derived from the console.error() sentence a few lines down. That sentence is for
// a human reading the log; this array is what session-start.sh's report actually consumes (via
// hydration-report.mjs), and the two are independent so a wording change to one can never affect
// the other's meaning.
const requiredMissing = [];
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
    // Human-readable only from here down. Nothing downstream parses this string -- see the
    // `requiredMissing` array above for the machine-readable equivalent.
    console.error(`[fetch-secrets-aws] MISSING required secret '${id}' (env ${env}) at ${PREFIX}/${id} (${REGION}).`);
    requiredMissing.push({ id, env });
    hadRequiredMiss = true;
  }
}

// Human-readable summary, unchanged in spirit from before -- but no longer load-bearing. The
// structured result written below is what session-start.sh's completeness/truncation checks
// actually read; this line is diagnostics for a person tailing the log.
console.error(`[fetch-secrets-aws] ${emitted} secret(s) hydrated from ${PREFIX} (${REGION})${present ? ` of ${present.size} parameter(s) present` : ''}.`);

writeHydrationResult(RESULT_FILE, {
  store: 'aws-ssm',
  reachable: true,
  emittedCount: emitted,
  requiredTotal: REQUIRED_TOTAL,
  requiredMissing,
});

process.exitCode = hadRequiredMiss ? 2 : 0;
}

await main();
