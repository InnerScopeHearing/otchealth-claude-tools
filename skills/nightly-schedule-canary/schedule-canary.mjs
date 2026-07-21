#!/usr/bin/env node
// schedule-canary.mjs -- ITEM 2.3 (Wave 2, AI-OS research-pass 2026-07-21): CANARY-WATCHES-THE-CANARY,
// generalized from the original two (gateway-canary/drift-sentinel, see setup/heartbeat-registry.json's
// notes on those two entries) to cover EVERY nightly workflow's OWN GitHub Actions schedule, not just
// two specific sub-monitors.
//
// THE FAILURE CLASS THIS CLOSES: a workflow's cron can stop firing entirely -- GitHub Actions disables a
// SCHEDULED workflow in a repo after 60 days with no repo activity, a workflow YAML could be accidentally
// deleted or made unparseable, a cron expression typo could make it simply never match -- and NONE of
// that shows up as a red run of that workflow's own internal check (azure-canary.mjs / continuity-
// canary.mjs / run-evals.mjs / ...), because a workflow that never runs at all never gets the chance to
// go red. This is a fundamentally different failure class than "the workflow ran and its content check
// found a real problem" (which already pages separately, via each workflow's own `if: failure()` step
// calling setup/page-on-failure.mjs). "Silence = failure" is exactly the dead-man's-switch idea
// setup/heartbeat.mjs already implements for Container Apps Jobs; this applies the same idea to plain
// GitHub Actions cron workflows, which have no ARM job to poll, so they self-beat instead (see each
// nightly workflow's own "Heartbeat: mark this workflow's schedule as alive" step, which calls `node
// setup/heartbeat.mjs beat <job> ok` UNCONDITIONALLY -- regardless of whether that workflow's own check
// passed or failed -- because this beat represents "the schedule fired today", not "the content was
// healthy").
//
// REUSE, DO NOT DUPLICATE: this script does not reimplement heartbeat.mjs's own DEAD/LATE/LIVE
// classification (age vs each job's registered interval_min); it shells out to the existing `node
// setup/heartbeat.mjs check --json` (the exact same call skills/drift-sentinel.mjs already makes as one
// of its own three sub-checks) and then filters the result down to only the registry entries tagged
// "kind": "nightly-workflow" in setup/heartbeat-registry.json. That tag is the single source of truth for
// "which jobs is THIS check about" -- the tracked job list is read from the registry, never hardcoded
// here, so adding an 8th nightly workflow later is a one-line registry edit, not a code change.
//
// WHY THIS IS ITS OWN SCRIPT RATHER THAN drift-sentinel.mjs --strict: drift-sentinel.mjs already bundles
// heartbeat.mjs's check with two OTHER sub-checks (image-drift.mjs, drift-recon.mjs) into one combined
// verdict, and .github/workflows/nightly-fleet-sentinels.yml deliberately runs it WITHOUT --strict
// (report-only) precisely because, in this environment, image-drift and drift-recon already have real,
// pre-existing findings unrelated to nightly-workflow schedule freshness. Flipping drift-sentinel.mjs
// itself to --strict to get schedule-staleness paging would ALSO page on that unrelated, already-known
// drift every single night -- a broad, noisy side effect nobody asked for. This script stays narrowly
// scoped to exactly the "kind":"nightly-workflow" entries so it can page/gate on ONLY the failure class it
// exists to catch.
//
// Two modes mirror azure-canary.mjs / continuity-canary.mjs's convention exactly: default is report-only
// (safe for manual/local runs, always exits 0); --strict makes any tracked workflow's schedule going
// stale a non-zero exit, so a scheduled caller (nightly-fleet-sentinels.yml) can page on it via the same
// setup/page-on-failure.mjs every other nightly monitor uses.
//
// Auth: none of its own. It shells out to setup/heartbeat.mjs, which resolves its own Key Vault creds
// (azure-commons-storage-account/key) via the shared kvSecret three-path resolver; a missing/broken
// heartbeat.mjs run is itself reported as an anomaly (a dark sensor), never silently swallowed.
//
// Usage:
//   node skills/nightly-schedule-canary/schedule-canary.mjs [--json] [--strict]
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const REGISTRY_PATH = join(REPO_ROOT, "setup", "heartbeat-registry.json");
const HEARTBEAT_CLI = join(REPO_ROOT, "setup", "heartbeat.mjs");

const argv = process.argv.slice(2);
const STRICT = argv.includes("--strict") || process.env.NIGHTLY_SCHEDULE_CANARY_STRICT === "1";
const JSONOUT = argv.includes("--json");

function loadRegistry() {
  try {
    return JSON.parse(readFileSync(REGISTRY_PATH, "utf8"));
  } catch {
    return {};
  }
}

/** PURE: which registry job keys this check is responsible for -- every key whose entry carries
 *  "kind": "nightly-workflow". The registry is the single source of truth for the tracked set; this
 *  function never hardcodes job names. No I/O (takes an already-parsed registry object). Unit-tested. */
export function trackedJobNames(registry) {
  return Object.keys(registry || {})
    .filter((k) => registry[k] && registry[k].kind === "nightly-workflow")
    .sort();
}

/** PURE: given heartbeat.mjs `check --json` rows and the tracked job-name set, decide which tracked
 *  jobs are healthy vs stale. A tracked job is an anomaly if heartbeat.mjs classified its status as
 *  anything other than LIVE (LATE / DEAD / NO-DATA / NO-ARM) -- any of those means its own GitHub Actions
 *  schedule has not produced a fresh beat inside its configured window, independent of whatever that
 *  workflow's own internal check last reported. A tracked name with no matching row at all is reported
 *  as MISSING_ROW rather than silently skipped: heartbeat.mjs is expected to emit exactly one row per
 *  registry key (it unions registry keys with seen beat files), so a MISSING_ROW here would itself
 *  indicate a real bug in that plumbing, not a healthy state. No I/O. Unit-tested. */
export function assessScheduleHealth(rows, trackedJobs) {
  const byJob = new Map((rows || []).filter((r) => r && r.job).map((r) => [r.job, r]));
  const results = trackedJobs.map((job) => {
    const row = byJob.get(job);
    if (!row) return { job, state: "MISSING_ROW", ageMin: null, intervalMin: null, owner: "" };
    const anomalous = row.status !== "LIVE";
    return { job, state: anomalous ? row.status : "LIVE", ageMin: row.ageMin ?? null, intervalMin: row.intervalMin ?? null, owner: row.owner || "" };
  });
  const anomalies = results.filter((r) => r.state !== "LIVE");
  return { ok: anomalies.length === 0, results, anomalies };
}

/** Exit-code policy, mirrors azure-canary.mjs / continuity-canary.mjs's pageExitCode() convention
 *  exactly: report-only by default (never pages), --strict pages (non-zero exit) on any anomaly. Pure,
 *  unit-tested. */
export function pageExitCode(anomalyCount, strict) {
  return strict && anomalyCount > 0 ? 1 : 0;
}

/** Shell out to the existing heartbeat.mjs (reuse, do not reimplement its ARM/blob-read logic). Returns
 *  { ok: true, rows } on success, or { ok: false, error } if heartbeat.mjs itself could not even run
 *  (missing creds -> exit 78, a crash, unparseable output) -- a dark sensor is itself an anomaly, never
 *  a silent skip. Mirrors drift-sentinel.mjs's own runSub()/parseSubOutput() crash-handling shape. */
function runHeartbeatCheck() {
  try {
    const out = execFileSync(process.execPath, [HEARTBEAT_CLI, "check", "--json"], {
      encoding: "utf8",
      timeout: 90_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, rows: JSON.parse(out) };
  } catch (e) {
    const stdout = e.stdout ? e.stdout.toString("utf8") : "";
    const stderr = e.stderr ? e.stderr.toString("utf8") : "";
    if (stdout.trim()) {
      try {
        return { ok: true, rows: JSON.parse(stdout) };
      } catch {
        /* fall through to the crash report below */
      }
    }
    return { ok: false, error: `heartbeat.mjs check crashed: exit ${e.status ?? "?"}: ${(stderr || e.message || "").toString().slice(0, 300)}` };
  }
}

function main() {
  const registry = loadRegistry();
  const trackedJobs = trackedJobNames(registry);
  if (!trackedJobs.length) {
    console.log('[nightly-schedule-canary] no registry entries tagged "kind": "nightly-workflow" -- nothing to check.');
    process.exit(0);
  }

  const hb = runHeartbeatCheck();
  if (!hb.ok) {
    console.error(`::error::[nightly-schedule-canary] ${hb.error}`);
    // heartbeat.mjs itself could not run -- a dark sensor is an anomaly worth paging on in --strict
    // mode, the same convention azure-canary/continuity-canary use for "cannot run at all".
    process.exit(STRICT ? 1 : 0);
    return;
  }

  const verdict = assessScheduleHealth(hb.rows, trackedJobs);

  if (JSONOUT) {
    console.log(JSON.stringify(verdict, null, 2));
  } else {
    console.log(`[nightly-schedule-canary] ${trackedJobs.length} nightly workflow schedule(s) tracked; ${verdict.anomalies.length} needing attention`);
    for (const r of verdict.results) {
      const age = r.ageMin == null ? "never" : r.ageMin < 60 ? `${r.ageMin}m` : `${Math.round(r.ageMin / 60)}h`;
      console.log(`  [${r.state.padEnd(11)}] ${r.job.padEnd(28)} last beat ${age}${r.intervalMin ? ` (expect <=${r.intervalMin}m)` : ""}`);
    }
  }
  for (const r of verdict.anomalies) {
    console.log(
      `::warning::[nightly-schedule-canary] ${r.job}: ${r.state} -- its own GitHub Actions schedule has not produced a fresh heartbeat inside its expected window. The workflow may have stopped firing entirely (a dead/disabled/malformed cron), a different failure class than that workflow's own content check going red.`,
    );
  }
  console.log(
    verdict.ok
      ? "[nightly-schedule-canary] OK (every tracked nightly workflow's schedule is alive)"
      : `[nightly-schedule-canary] ANOMALIES: ${verdict.anomalies.length} workflow schedule(s) stale/dead/missing: ${verdict.anomalies.map((r) => r.job).join(", ")}`,
  );
  if (STRICT && !verdict.ok) {
    console.error(
      "::error::[nightly-schedule-canary] STRICT: paging on the above -- a nightly workflow whose own schedule has stopped firing never gets a chance to go red on its own content check, so this is the only signal that would ever catch it.",
    );
  }
  process.exit(pageExitCode(verdict.anomalies.length, STRICT));
}

// Only run as a script (not when imported by tests, matching every other canary in this repo).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
