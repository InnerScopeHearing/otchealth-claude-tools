// setup/hydration-result.mjs — the ONE machine-readable summary a secret hydrator writes about
// itself, so nothing downstream ever has to re-derive what happened by parsing a human sentence.
//
// WHY THIS EXISTS (2026-08-18, round 4 of the same defect class)
//
// Three rounds of fixes to setup/session-start.sh's hydration reporting each shipped a version of
// the SAME shape of bug: a failure rendered as a plausible success. Round 3's specific mechanism
// was BASH RE-PARSING A HUMAN-READABLE LOG LINE:
//
//   SSM_MISSING_ENVS="$(sed -n "s/.../\1/p" "$SSM_ERR" | tr '\n' ' ')"
//   ...
//   if [ -z "$SSM_MISSING_ENVS" ]; then <UNKNOWN> else for env_name in $SSM_MISSING_ENVS; do ...
//
// This has TWO independent failure surfaces, both silent-empty by construction:
//   1. sed's capture group is `\([A-Z0-9_]*\)` -- a `*`, not a `+`. A MISSING line whose env
//      capture is EMPTY (a garbled or reformatted diagnostic) still matches, and `tr '\n' ' '`
//      turns that empty capture into a single space. `[ -z " " ]` is FALSE (a space is not
//      empty), so the "I could not determine" branch is skipped -- but the subsequent
//      `for env_name in $SSM_MISSING_ENVS` word-splits " " into ZERO tokens, so the loop body
//      never runs, STILL_MISSING stays empty, and the all-clear prints having checked nothing.
//   2. Nothing compares the NUMBER of MISSING lines the hydrator emitted against the number of
//      names bash actually recovered from them, so a partially-unparseable list is silently
//      treated as a fully-parsed one.
//
// Both surfaces exist because the shell was reconstructing structured facts (which secrets are
// missing, how many, whether that count is complete) out of PROSE meant for a human. Prose has no
// schema: an empty field and an absent field print identically, and nothing forces the reader to
// notice the difference. Shell testing compounds it: `-z` and unquoted word-splitting share the
// same "empty and absent look alike" blind spot the prose already had.
//
// THE STRUCTURAL FIX: a hydrator no longer reports completeness in a sentence for a downstream
// parser to reconstruct. It calls writeHydrationResult() with the SAME {id, env} objects it
// already holds in memory from setup/secret-map.mjs -- never text re-derived by pattern-matching a
// diagnostic string. The consumer (setup/hydration-report.mjs) calls readHydrationResult(), which
// schema-validates every field including the shape of each requiredMissing entry, and returns
// `null` -- a distinct, impossible-to-mistake-for-success value -- for anything it cannot fully
// trust: a missing file, invalid JSON, a wrong type, or an entry whose count does not match its
// own array. There is no capture group here that could match zero characters and no string for
// `-z`/word-splitting to misjudge, because there is no string in the loop at all: an env name is
// either a validated JS string in a JS array, or the whole result is null.
//
// SCHEMA WRITTEN TO DISK (one JSON object per hydrator run):
//   {
//     store:          'aws-ssm' | 'azure-keyvault',
//     reachable:       boolean,   // could the store be reached at all (creds/auth resolvable)
//     emittedCount:    number,    // how many ENV='value' lines this run wrote to stdout
//     requiredTotal:   number,    // how many setup/secret-map.mjs entries are required:true
//     requiredMissing: [{id, env}],  // EXACTLY the required entries that did not resolve
//   }
//
// `requiredMissing.length` IS the missing count -- there is deliberately no separate integer
// field for it that could drift out of sync with the array. See statusOf() for the three
// (plus one) states this collapses to.

import { readFileSync, writeFileSync } from "node:fs";

/**
 * Record what a hydrator run did, as data. Best-effort: a failed write must not crash the
 * hydration itself. `path` is optional -- a caller with nothing to report to (a unit test driving
 * the hydrator directly, say) can omit it and this is a no-op.
 */
export function writeHydrationResult(path, result) {
  if (!path) return;
  try {
    writeFileSync(path, JSON.stringify(result));
  } catch (e) {
    // The reader side already treats a missing/unreadable file as "unknown", which is the honest
    // outcome here too -- this is diagnostics, not a second code path to keep in sync.
    console.error(`[hydration-result] could not write ${path}: ${e.message}`);
  }
}

/**
 * Read + schema-validate a hydration result file.
 *
 * Returns the validated object, or `null` if ANYTHING about it cannot be fully trusted: the file
 * is missing or unreadable, the JSON is malformed, a field is the wrong type, an entry's `env` is
 * not a safe/complete identifier, or the declared totals are internally inconsistent.
 *
 * `null` is not an error to log and route around -- it IS the answer, for exactly the case this
 * module exists to name honestly: "this hydrator's completeness could not be determined." Every
 * caller must render a null result as UNKNOWN, and must never fall through from it into any
 * branch that claims completeness.
 */
export function readHydrationResult(path) {
  if (!path) return null;
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  let r;
  try {
    r = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!r || typeof r !== "object" || Array.isArray(r)) return null;
  if (typeof r.store !== "string" || !r.store) return null;
  if (typeof r.reachable !== "boolean") return null;
  if (!Number.isInteger(r.emittedCount) || r.emittedCount < 0) return null;
  if (!Number.isInteger(r.requiredTotal) || r.requiredTotal < 0) return null;
  if (!Array.isArray(r.requiredMissing)) return null;
  for (const m of r.requiredMissing) {
    if (!m || typeof m !== "object") return null;
    if (typeof m.id !== "string" || !m.id) return null;
    // The env name must be a complete, safe shell/bash identifier. This is what makes the
    // downstream indirect-expansion lookup (`${!env_name}`) and variable assignment
    // (`printf -v "PREFIX_${i}_ENV" ...`) safe by construction, with no separate runtime guard
    // needed against a garbled or empty capture -- there is no capture here to garble.
    if (typeof m.env !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(m.env)) return null;
  }
  // Internal consistency: a result claiming more missing entries than it claims exist at all
  // cannot be trusted, whatever produced it.
  if (r.requiredMissing.length > r.requiredTotal) return null;
  return r;
}

/**
 * The state a hydrator's completeness collapses to, given a VALIDATED (non-null) result.
 *   'unreachable'  the store itself could not be reached — reachable === false. requiredMissing
 *                  on an unreachable result is not evidence of anything and must not be read as a
 *                  named gap; only the store's presence/absence should be reported.
 *   'partial'      the store was reached, but requiredMissing.length > 0 (a NAMED gap).
 *   'ok'           the store was reached and every required secret resolved.
 * A fourth state, 'unknown', is represented by `null` itself (see readHydrationResult), not by a
 * value in this enum — callers check for null before ever calling statusOf().
 */
export function statusOf(r) {
  if (!r.reachable) return "unreachable";
  return r.requiredMissing.length > 0 ? "partial" : "ok";
}
