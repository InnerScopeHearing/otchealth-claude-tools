import { test } from "node:test";
import assert from "node:assert/strict";
import { assessFreshness, pageExitCode } from "../skills/azure-canary/canary.mjs";

const IX = { index: "finance-cfo-source-docs", max_age_h: 168, timestamp_field: "indexed_at" };
const NOW = Date.parse("2026-07-13T20:00:00Z");

test("assessFreshness: recent timestamp is FRESH", () => {
  const v = assessFreshness(IX, "2026-07-13T18:00:00Z", NOW); // 2h old, SLO 168h
  assert.equal(v.state, "FRESH");
  assert.equal(v.ageH, 2);
});

test("assessFreshness: a frozen index older than its SLO is STALE (the otchealth-brain failure)", () => {
  const v = assessFreshness(IX, "2026-07-01T00:00:00Z", NOW); // ~308h old, SLO 168h
  assert.equal(v.state, "STALE");
  assert.ok(v.ageH > 168);
});

test("assessFreshness: no timestamp (backfill not run / no dateable doc) is NO_DATE, not FRESH", () => {
  assert.equal(assessFreshness(IX, null, NOW).state, "NO_DATE");
  assert.equal(assessFreshness(IX, "not-a-date", NOW).state, "NO_DATE");
});

test("assessFreshness: exactly at the SLO boundary is still FRESH (<=)", () => {
  const boundary = new Date(NOW - IX.max_age_h * 3_600_000).toISOString();
  assert.equal(assessFreshness(IX, boundary, NOW).state, "FRESH");
});

test("pageExitCode: strict + anomaly pages (exit 1) -- a frozen index cannot sit silent", () => {
  assert.equal(pageExitCode(false, true), 1);
});

test("pageExitCode: strict + all-ok does not page (exit 0)", () => {
  assert.equal(pageExitCode(true, true), 0);
});

test("pageExitCode: non-strict never pages, even on an anomaly (report-only default)", () => {
  assert.equal(pageExitCode(false, false), 0);
  assert.equal(pageExitCode(true, false), 0);
});
