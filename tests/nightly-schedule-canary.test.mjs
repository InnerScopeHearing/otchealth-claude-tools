// ITEM 2.3 (Wave 2, AI-OS research-pass 2026-07-21): guards the pure classifier behind
// skills/nightly-schedule-canary/schedule-canary.mjs -- the "canary watches the canary" schedule-
// liveness check, generalized from gateway-canary/drift-sentinel to every nightly workflow. Mirrors
// tests/azure-canary-freshness.test.mjs / tests/continuity-canary.test.mjs's discipline: the pure
// classification + exit-code logic is hermetically tested with no Azure/network access at all.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { trackedJobNames, assessScheduleHealth, pageExitCode } from "../skills/nightly-schedule-canary/schedule-canary.mjs";

test("trackedJobNames: only entries tagged kind:nightly-workflow are tracked, sorted, never hardcoded", () => {
  const registry = {
    "daily-digest": { interval_min: 1560, owner: "coo" }, // no kind -- not a nightly-workflow entry
    "nightly-eval": { interval_min: 1560, owner: "cto", kind: "nightly-workflow" },
    "nightly-azure-canary": { interval_min: 1560, owner: "cto", kind: "nightly-workflow" },
    "gateway-canary": { interval_min: 60, owner: "cto" }, // untagged sub-monitor, not tracked here
  };
  assert.deepEqual(trackedJobNames(registry), ["nightly-azure-canary", "nightly-eval"]);
});

test("trackedJobNames: an empty or missing registry tracks nothing, never throws", () => {
  assert.deepEqual(trackedJobNames({}), []);
  assert.deepEqual(trackedJobNames(undefined), []);
});

test("assessScheduleHealth: all tracked jobs LIVE is ok with zero anomalies", () => {
  const rows = [
    { job: "nightly-azure-canary", status: "LIVE", ageMin: 30, intervalMin: 1560 },
    { job: "nightly-eval", status: "LIVE", ageMin: 45, intervalMin: 1560 },
  ];
  const v = assessScheduleHealth(rows, ["nightly-azure-canary", "nightly-eval"]);
  assert.equal(v.ok, true);
  assert.deepEqual(v.anomalies, []);
});

test("assessScheduleHealth: a DEAD tracked job (schedule stopped firing) is an anomaly", () => {
  const rows = [
    { job: "nightly-azure-canary", status: "LIVE", ageMin: 30, intervalMin: 1560 },
    { job: "oauth-clients-canary", status: "DEAD", ageMin: 5000, intervalMin: 480 },
  ];
  const v = assessScheduleHealth(rows, ["nightly-azure-canary", "oauth-clients-canary"]);
  assert.equal(v.ok, false);
  assert.equal(v.anomalies.length, 1);
  assert.equal(v.anomalies[0].job, "oauth-clients-canary");
  assert.equal(v.anomalies[0].state, "DEAD");
});

test("assessScheduleHealth: a LATE tracked job is also an anomaly, not just DEAD", () => {
  const rows = [{ job: "nightly-recall-eval", status: "LATE", ageMin: 1600, intervalMin: 1560 }];
  const v = assessScheduleHealth(rows, ["nightly-recall-eval"]);
  assert.equal(v.ok, false);
  assert.equal(v.anomalies[0].state, "LATE");
});

test("assessScheduleHealth: a tracked job with no matching row at all is MISSING_ROW, not silently skipped", () => {
  const v = assessScheduleHealth([], ["nightly-fleet-sentinels"]);
  assert.equal(v.ok, false);
  assert.equal(v.anomalies.length, 1);
  assert.equal(v.anomalies[0].job, "nightly-fleet-sentinels");
  assert.equal(v.anomalies[0].state, "MISSING_ROW");
});

test("assessScheduleHealth: rows for untracked jobs are ignored entirely (scoped only to the tracked set)", () => {
  const rows = [
    { job: "daily-digest", status: "DEAD", ageMin: 99999, intervalMin: 1560 }, // real drift elsewhere, not our concern
    { job: "nightly-eval", status: "LIVE", ageMin: 10, intervalMin: 1560 },
  ];
  const v = assessScheduleHealth(rows, ["nightly-eval"]);
  assert.equal(v.ok, true);
  assert.equal(v.results.length, 1);
});

test("pageExitCode: strict + an anomaly present pages (exit 1)", () => {
  assert.equal(pageExitCode(1, true), 1);
});

test("pageExitCode: strict + zero anomalies does not page (exit 0)", () => {
  assert.equal(pageExitCode(0, true), 0);
});

test("pageExitCode: non-strict never pages, even with anomalies (report-only default)", () => {
  assert.equal(pageExitCode(3, false), 0);
  assert.equal(pageExitCode(0, false), 0);
});

test("the live registry: all 8 nightly-workflow entries are present and each carries a positive interval_min", () => {
  // Guards against a silent typo/removal in setup/heartbeat-registry.json itself dropping one of the
  // 8 tracked entries or leaving its interval_min unset (which would make heartbeat.mjs's own status
  // math treat it as NO-DATA instead of a real staleness check).
  const registry = JSON.parse(readFileSync(new URL("../setup/heartbeat-registry.json", import.meta.url), "utf8"));
  const expected = [
    "nightly-azure-canary",
    "nightly-continuity-canary",
    "nightly-embedding-drift",
    "nightly-eval",
    "nightly-fleet-sentinels",
    "nightly-recall-eval",
    "oauth-clients-canary",
    "nightly-s3-dr-mirror",
  ].sort();
  assert.deepEqual(trackedJobNames(registry), expected);
  for (const job of expected) {
    assert.ok(registry[job].interval_min > 0, `${job} must carry a positive interval_min`);
    assert.equal(registry[job].owner, "cto");
  }
});
