// Tests for nightly-summary.mjs summarize() — the report-only floor guard for the scheduled nightly eval.
import { test } from "node:test";
import assert from "node:assert/strict";
import { summarize } from "../nightly-summary.mjs";

test("a healthy scorecard is above floor and renders the pass summary", () => {
  const sc = { model: "gpt-4o", avg: 0.82, passed: 6, total: 7, results: [{ agent: "cto", id: "x", pass: true, score: 0.9, notes: "ok" }] };
  const r = summarize(sc, 0.6);
  assert.equal(r.belowFloor, false);
  assert.equal(r.passed, 6);
  assert.equal(r.total, 7);
  assert.match(r.line, /6\/7 passed/);
  assert.match(r.markdown, /Nightly Eval Baseline/);
});

test("an average below the floor flags belowFloor (regression signal)", () => {
  const sc = { model: "gpt-4o", avg: 0.42, passed: 2, total: 7, results: [] };
  const r = summarize(sc, 0.6);
  assert.equal(r.belowFloor, true);
  assert.match(r.markdown, /below the 60% floor/i);
});

test("avg is derived from results when the top-level avg field is missing", () => {
  const sc = { total: 2, results: [{ score: 1, pass: true }, { score: 0, pass: false }] };
  const r = summarize(sc, 0.6);
  assert.equal(r.avg, 0.5);
  assert.equal(r.belowFloor, true);
});

test("an empty/zero-task scorecard is never flagged below floor (no data != regression)", () => {
  const r = summarize({ avg: 0, passed: 0, total: 0, results: [] }, 0.6);
  assert.equal(r.belowFloor, false);
  assert.match(r.markdown, /No scorecard data/i);
});

test("a malformed scorecard degrades cleanly instead of throwing", () => {
  for (const bad of [null, undefined, 42, "nope", {}]) {
    const r = summarize(bad, 0.6);
    assert.equal(typeof r.markdown, "string");
    assert.equal(r.belowFloor, false);
  }
});
