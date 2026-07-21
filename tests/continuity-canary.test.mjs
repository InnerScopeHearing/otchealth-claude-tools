import { test } from "node:test";
import assert from "node:assert/strict";
import { assessDocFreshness, pageExitCode } from "../skills/continuity-canary/continuity-canary.mjs";

const NOW = Date.parse("2026-07-21T20:00:00Z");
const MAX_AGE_DAYS = 7;

test("assessDocFreshness: a doc committed today is FRESH", () => {
  const v = assessDocFreshness({ path: "CLAUDE.md", lastCommitEpoch: Date.parse("2026-07-21T10:00:00Z"), maxAgeDays: MAX_AGE_DAYS, nowEpoch: NOW });
  assert.equal(v.state, "FRESH");
  assert.equal(v.stale, false);
});

test("assessDocFreshness: a doc untouched well past its SLO is STALE (the CTO-KICKOFF-PROMPT.md real finding)", () => {
  // 32 days old against a 10-day SLO -- the actual live gap found while building this canary.
  const v = assessDocFreshness({ path: "CTO-KICKOFF-PROMPT.md", lastCommitEpoch: Date.parse("2026-06-19T08:19:40Z"), maxAgeDays: 10, nowEpoch: Date.parse("2026-07-21T20:45:00Z") });
  assert.equal(v.state, "STALE");
  assert.equal(v.stale, true);
  assert.ok(v.ageDays > 10);
});

test("assessDocFreshness: exactly at the SLO boundary is still FRESH (<=, matches azure-canary's convention)", () => {
  const boundary = NOW - MAX_AGE_DAYS * 86_400_000;
  const v = assessDocFreshness({ path: "CLAUDE.md", lastCommitEpoch: boundary, maxAgeDays: MAX_AGE_DAYS, nowEpoch: NOW });
  assert.equal(v.state, "FRESH");
  assert.equal(v.stale, false);
});

test("assessDocFreshness: one millisecond past the boundary is STALE", () => {
  const justOver = NOW - MAX_AGE_DAYS * 86_400_000 - 1;
  const v = assessDocFreshness({ path: "CLAUDE.md", lastCommitEpoch: justOver, maxAgeDays: MAX_AGE_DAYS, nowEpoch: NOW });
  assert.equal(v.state, "STALE");
  assert.equal(v.stale, true);
});

test("assessDocFreshness: null lastCommitEpoch (git failed / path untracked / no repo found) is NO_DATA, not STALE and not FRESH", () => {
  const v = assessDocFreshness({ path: "CLAUDE.md", lastCommitEpoch: null, maxAgeDays: MAX_AGE_DAYS, nowEpoch: NOW });
  assert.equal(v.state, "NO_DATA");
  assert.equal(v.stale, false);
});

test("assessDocFreshness: a non-finite lastCommitEpoch (e.g. NaN from a bad date parse) is also NO_DATA", () => {
  const v = assessDocFreshness({ path: "CLAUDE.md", lastCommitEpoch: NaN, maxAgeDays: MAX_AGE_DAYS, nowEpoch: NOW });
  assert.equal(v.state, "NO_DATA");
  assert.equal(v.stale, false);
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
