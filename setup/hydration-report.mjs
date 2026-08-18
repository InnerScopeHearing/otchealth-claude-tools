#!/usr/bin/env node
// setup/hydration-report.mjs — the ONE place that decides whether a session's fleet-secret
// hydration is complete, and prints the operator-facing banner explaining why.
//
// This is the redesign, not a patch, for the defect class three prior rounds each reintroduced in
// a new shape inside setup/session-start.sh: a failure returned as a plausible value. All three
// concrete bugs (see setup/hydration-result.mjs's header for the full history) trace to the SAME
// root cause -- the shell was reconstructing structured facts (is a required secret missing, how
// many, is that count complete) by regex-matching a sentence written for a human. Prose has no
// schema: an empty capture and an absent one print identically, and `-z` / unquoted word-splitting
// share that exact blind spot.
//
// session-start.sh no longer makes this decision. It runs each hydrator with
// FLEET_HYDRATION_RESULT_FILE set (setup/hydration-result.mjs), then calls THIS script (as a CLI,
// twice per session -- once in `gate` mode to decide whether the Key Vault fallback is even worth
// attempting, once in `report` mode after both arms have run) with paths to the result files and
// raw stdout captures. Every fact this script needs is typed data from JSON.parse, not a regex
// capture group -- so the specific failure mode that shipped three times (an empty/garbled capture
// read as "nothing missing") has no analogue here: there is no string to capture from, only a
// validated object or `null`.
//
// THE FIVE PROPERTIES THIS SCRIPT ENFORCES (traceability to the design brief):
//   A. Structured input only. Every completeness fact comes from readHydrationResult(), never from
//      re-parsing this script's OWN diagnostic text or a hydrator's stderr sentence.
//   B. "Could not determine" is a first-class, blocking state. See STATE in verdictFor(): UNKNOWN
//      and UNREACHABLE are distinct from OK and can never fall through to an all-clear.
//   C. Completeness is asserted, not assumed. verdictFor() independently recounts how many
//      assignment lines actually arrived on stdout and compares that to what the result file
//      claims it emitted -- a mismatch downgrades a reachable, well-formed result to `truncated`,
//      which every downstream consumer treats the same as `unknown`.
//   D. Both arms get identical treatment: verdictFor() is the ONE function used for the SSM arm
//      and the Key Vault arm. There is no separate, weaker code path for either (computeReport()
//      below calls it twice, with the same argument shape).
//   E. Store-truth and session-truth are reported as different fields (`coveredBy: 'store'` vs
//      `coveredBy: 'session-env'`) on every required secret in computeReport(), and the two are
//      never collapsed into one "covered" bit before the human-facing text is rendered, so "the
//      store still lacks X but this session happens to carry X via a direct env var" cannot print
//      as "the store gap closed".
//
// Every function here is a pure function of its explicit arguments (no hidden env reads inside
// verdictFor/computeReport), so tests/hydration-report.test.mjs exercises the actual decision
// logic directly -- no bash, no subprocess, no fixture shell scripts to keep in sync.

import { readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { readHydrationResult } from "./hydration-result.mjs";
import { MAP } from "./secret-map.mjs";

function readTextFile(path) {
  if (!path) return null;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** How many `ENV='value'` assignment lines are actually present in raw hydrator stdout. */
export function countAssignmentLines(text) {
  if (text == null) return null;
  let n = 0;
  for (const line of text.split("\n")) {
    if (/^[A-Za-z_][A-Za-z0-9_]*='/.test(line)) n += 1;
  }
  return n;
}

/**
 * The ONE verdict function, run identically for the SSM arm and the Key Vault arm (property D).
 *
 * `readResult` and `readFetched` are injectable (default to real file reads) purely so tests can
 * supply in-memory content instead of writing temp files for every case.
 *
 * Returns { attempted, state, store?, requiredMissing?, emittedClaimed?, emittedActual? } where
 * `state` is one of:
 *   'not-attempted'  this arm never ran this session
 *   'unknown'        the result could not be read/parsed/schema-validated at all -- completeness
 *                    could not be determined, full stop
 *   'unreachable'    the store answered "I could not be reached" (reachable === false)
 *   'truncated'      the result claims N emitted lines but the actual stdout payload disagrees, or
 *                    could not be measured -- the JSON survived (a local file, not a pipe), but the
 *                    SECRET VALUES it describes travelled over stdout and that transfer is provably
 *                    (or unmeasurably) incomplete, so nothing about this run can be called complete
 *   'partial'        reachable and parseable, but requiredMissing.length > 0 (a NAMED gap)
 *   'ok'             reachable, parseable, and every required secret resolved
 * `requiredMissing` is present ONLY for 'partial'/'ok' -- omitting it for every other state means
 * there is no empty array anywhere that could be misread as "checked, and nothing was missing".
 */
export function verdictFor({ attempted, resultFile, fetchedFile, readResult = readHydrationResult, readFetched = readTextFile }) {
  if (!attempted) return { attempted: false, state: "not-attempted" };

  const result = readResult(resultFile);
  if (result === null) return { attempted: true, state: "unknown" };

  if (!result.reachable) return { attempted: true, state: "unreachable", store: result.store };

  const actual = countAssignmentLines(readFetched(fetchedFile));
  // A `null` actual count (the fetched-content could not be read/measured) is treated the same as
  // a mismatch: this transfer's completeness cannot be corroborated, so it cannot be called
  // complete. Only a MEASURED match clears the truncation check.
  if (actual === null || actual !== result.emittedCount) {
    return { attempted: true, state: "truncated", store: result.store, emittedClaimed: result.emittedCount, emittedActual: actual };
  }

  return {
    attempted: true,
    state: result.requiredMissing.length > 0 ? "partial" : "ok",
    store: result.store,
    requiredMissing: result.requiredMissing,
    emittedClaimed: result.emittedCount,
    emittedActual: actual,
  };
}

/** True only for a verdict whose `requiredMissing` can be trusted as a complete, real list. */
function hasNamedMissingList(v) {
  return v.state === "partial" || v.state === "ok";
}

/** Should the OTHER store even be attempted, given this arm's verdict? Conservative on purpose:
 *  anything short of a clean, fully-verified 'ok' says yes -- attempting an unnecessary fallback
 *  is harmless, skipping a needed one is not. */
export function needsFallback(v) {
  return v.state !== "ok";
}

/**
 * Combine both arms' verdicts into the final, honest completeness picture.
 *
 * `env` defaults to process.env but is injectable for tests. Every required secret from
 * setup/secret-map.mjs lands in exactly one of three buckets:
 *   covered          resolved -- `coveredBy` says whether that was a STORE or a direct SESSION env
 *                    var (property E: these are never merged into one undifferentiated "covered")
 *   stillMissing     at least one arm produced a trustworthy (named) missing-list that names it,
 *                    and no store or session var covers it -- a real, confirmed absence
 *   unknownCoverage  NEITHER arm could produce a trustworthy list at all, and no session var
 *                    covers it -- coverage was never actually checked, which is not the same as
 *                    "missing" and must never be reported as either covered or missing
 */
export function computeReport({ ssmAttempted, ssmResultFile, ssmFetchedFile, kvAttempted, kvResultFile, kvFetchedFile, env = process.env, readResult, readFetched }) {
  const inject = {};
  if (readResult) inject.readResult = readResult;
  if (readFetched) inject.readFetched = readFetched;

  const ssm = verdictFor({ attempted: !!ssmAttempted, resultFile: ssmResultFile || "", fetchedFile: ssmFetchedFile || "", ...inject });
  const kv = verdictFor({ attempted: !!kvAttempted, resultFile: kvResultFile || "", fetchedFile: kvFetchedFile || "", ...inject });

  const required = MAP.filter((m) => m.required);
  const covered = [];
  const stillMissing = [];
  const unknownCoverage = [];

  for (const { id, env: envName } of required) {
    const missingFromSsm = hasNamedMissingList(ssm) && ssm.requiredMissing.some((m) => m.env === envName);
    const missingFromKv = hasNamedMissingList(kv) && kv.requiredMissing.some((m) => m.env === envName);
    const resolvedByStore = (hasNamedMissingList(ssm) && !missingFromSsm) || (hasNamedMissingList(kv) && !missingFromKv);

    if (resolvedByStore) {
      covered.push({ id, env: envName, coveredBy: "store" });
      continue;
    }
    const directVal = env[envName];
    if (directVal) {
      // Session truth, not store truth (property E) -- kept as its own coveredBy value all the
      // way to the caller so it is never rendered indistinguishably from a real store hit.
      covered.push({ id, env: envName, coveredBy: "session-env" });
      continue;
    }
    const anyTrustworthyArm = hasNamedMissingList(ssm) || hasNamedMissingList(kv);
    if (anyTrustworthyArm) stillMissing.push({ id, env: envName });
    else unknownCoverage.push({ id, env: envName });
  }

  return { ssm, kv, required, covered, stillMissing, unknownCoverage, secretSource: secretSource(ssm, kv), lines: renderLines(ssm, kv, required, covered, stillMissing, unknownCoverage) };
}

function secretSource(ssm, kv) {
  const ssmOk = ssm.state === "ok" || ssm.state === "partial";
  const kvOk = kv.state === "ok" || kv.state === "partial";
  const parts = [];
  if (ssmOk) parts.push(ssm.state === "partial" ? "aws-ssm(partial)" : "aws-ssm");
  else if (ssm.state === "truncated") parts.push("aws-ssm(truncated)");
  if (kvOk) parts.push(kv.state === "partial" && !ssmOk ? "azure-keyvault(partial)" : "azure-keyvault");
  return parts.join("+") || "none";
}

const BAR = "===================================================================================";

function describeArm(name, v) {
  switch (v.state) {
    case "not-attempted":
      return [];
    case "unknown":
      return [`[octools] WARN: ${name} produced no usable completeness result — treat this session as UNVERIFIED for ${name}.`];
    case "unreachable":
      return [`[octools] ${name}: unreachable this session.`];
    case "truncated":
      return [
        `[octools] WARN: ${name} TRUNCATED — claimed ${v.emittedClaimed} secret(s) hydrated, ${v.emittedActual === null ? "the transfer could not be measured" : `only ${v.emittedActual} arrived`}. Which secrets were lost is UNKNOWN.`,
      ];
    case "partial":
      return [`[octools] ${name} PARTIAL — ${v.emittedClaimed} secret(s) loaded, but REQUIRED secret(s) missing: ${v.requiredMissing.map((m) => m.env).join(", ")}`];
    case "ok":
      return [`[octools] ${name} OK — ${v.emittedClaimed} secret(s) loaded; every REQUIRED secret resolved (not a completeness check on optional secrets).`];
    default:
      return [];
  }
}

function renderLines(ssm, kv, required, covered, stillMissing, unknownCoverage) {
  const lines = [...describeArm("AWS SSM", ssm), ...describeArm("Azure Key Vault", kv)];

  if (stillMissing.length > 0 || unknownCoverage.length > 0) {
    lines.push(BAR);
    if (unknownCoverage.length > 0) {
      lines.push(`[octools] WARN: could not determine whether these REQUIRED secret(s) are available: ${unknownCoverage.map((m) => m.env).join(", ")}`);
      lines.push("          No source produced a trustworthy result for them. This is UNKNOWN, not an all-clear.");
    }
    if (stillMissing.length > 0) {
      lines.push(`[octools] WARN: REQUIRED fleet secret(s) still MISSING after every store: ${stillMissing.map((m) => m.env).join(", ")}`);
      lines.push("          The session IS hydrated, but incompletely — tools needing these will fail.");
    }
    lines.push("          Fix: add them to AWS SSM (or supply as a direct env var), then re-run: bash setup/session-start.sh");
    lines.push(BAR);
  } else if (required.length > 0) {
    const sessionEnvOnly = covered.filter((c) => c.coveredBy === "session-env");
    if (sessionEnvOnly.length > 0) {
      lines.push(
        `[octools] Every REQUIRED secret is present. ${sessionEnvOnly.map((m) => m.env).join(", ")} came from a direct session env var, not a store — that is fine, but it is SESSION truth, not STORE truth: it will not be there for a future session unless it is also added to a store.`,
      );
    } else {
      lines.push("[octools] All required secrets are present (verified against a store).");
    }
  }

  if (ssm.state === "not-attempted" && kv.state === "not-attempted") {
    lines.push(BAR);
    lines.push("[octools] WARN: no fleet secret store was even attempted this session.");
    lines.push(BAR);
  }

  return lines;
}

// ─── CLI ────────────────────────────────────────────────────────────────────────────────────────
// Only runs when this file is executed directly, so importing the functions above (for tests, or
// for a future caller) never has a side effect.
//
// REALPATH, NOT A LITERAL STRING COMPARE (fixed while building this file's own test harness --
// caught immediately, before it ever shipped, precisely BECAUSE the harness invokes this script
// through a symlink, which is also exactly how session-start.sh's TOOLS_DIR could plausibly reach
// it). `import.meta.url` is Node's RESOLVED path for the running module -- symlinks followed --
// while `process.argv[1]` is the literal path given on the command line, symlink and all. A naive
// `fileURLToPath(import.meta.url) === process.argv[1]` is false whenever the two differ only by a
// symlink hop, so the CLI body silently never runs: the process still exits 0, having printed
// nothing at all. That is the exact defect class this whole rewrite exists to eliminate, and it
// would have shipped inside the very rewrite meant to close it. realpathSync() canonicalizes
// process.argv[1] before the comparison, so a symlinked invocation and a direct one are judged
// identically. A path that cannot be resolved (nonsensical argv[1]) safely renders `isMainModule`
// false rather than throwing.
function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const mode = process.argv[2] || "report";

  if (mode === "gate") {
    // `node hydration-report.mjs gate <resultFile> <fetchedFile>` -> prints "1" (attempt the
    // fallback) or "0" (skip it), nothing else. Used by session-start.sh to decide whether the Key
    // Vault arm is worth running at all, using the SAME verdict logic the final report uses --
    // never a separate, looser check.
    const v = verdictFor({ attempted: true, resultFile: process.argv[3] || "", fetchedFile: process.argv[4] || "" });
    process.stdout.write(needsFallback(v) ? "1" : "0");
  } else {
    const report = computeReport({
      ssmAttempted: process.env.HR_SSM_ATTEMPTED === "1",
      ssmResultFile: process.env.HR_SSM_RESULT_FILE || "",
      ssmFetchedFile: process.env.HR_SSM_FETCHED_FILE || "",
      kvAttempted: process.env.HR_KV_ATTEMPTED === "1",
      kvResultFile: process.env.HR_KV_RESULT_FILE || "",
      kvFetchedFile: process.env.HR_KV_FETCHED_FILE || "",
    });
    process.stdout.write(`SECRET_SOURCE=${report.secretSource}\n`);
    for (const l of report.lines) process.stdout.write(`${l}\n`);
  }
}
