// Tests for eval-gate.mjs — compareToBaseline() (the CI eval-gate) and nextBaseline().
import { test } from "node:test";
import assert from "node:assert/strict";
import { compareToBaseline, nextBaseline } from "../eval-gate.mjs";

test("no baseline on record: never regresses, reports 'seeding' not a failure", () => {
  const sc = { avg: 0.7, passed: 5, total: 7, results: [] };
  const r = compareToBaseline(sc, null);
  assert.equal(r.hasBaseline, false);
  assert.equal(r.regressed, false);
  assert.equal(r.blocked, false);
  assert.match(r.line, /no baseline/i);
});

test("a seed baseline with total=0 is treated as no baseline (never gates against a placeholder)", () => {
  const sc = { avg: 0.5, passed: 3, total: 6, results: [] };
  const seed = { avg: 0.9, passed: 0, total: 0, recordedAt: "seed" };
  const r = compareToBaseline(sc, seed);
  assert.equal(r.hasBaseline, false);
  assert.equal(r.regressed, false);
});

test("avg within tolerance of baseline is OK, not a regression", () => {
  const sc = { avg: 0.78, passed: 6, total: 7, results: [] };
  const baseline = { avg: 0.8, passed: 6, total: 7, recordedAt: "2026-06-01T00:00:00Z" };
  const r = compareToBaseline(sc, baseline, { tolerance: 0.05 });
  assert.equal(r.hasBaseline, true);
  assert.equal(r.regressed, false);
  assert.match(r.line, /OK/);
});

test("avg dropping more than tolerance below baseline is a regression (report-only by default)", () => {
  const sc = { avg: 0.6, passed: 4, total: 7, results: [] };
  const baseline = { avg: 0.8, passed: 6, total: 7, recordedAt: "2026-06-01T00:00:00Z" };
  const r = compareToBaseline(sc, baseline, { tolerance: 0.05 });
  assert.equal(r.regressed, true);
  assert.equal(r.blocked, false); // report-only: enforce not set
  assert.match(r.line, /REGRESSION/);
  assert.match(r.line, /report-only/);
});

test("--enforce mode blocks (exit-code-driving) when regressed", () => {
  const sc = { avg: 0.5, passed: 3, total: 7, results: [] };
  const baseline = { avg: 0.8, passed: 6, total: 7, recordedAt: "2026-06-01T00:00:00Z" };
  const r = compareToBaseline(sc, baseline, { tolerance: 0.05, enforce: true });
  assert.equal(r.regressed, true);
  assert.equal(r.blocked, true);
  assert.match(r.line, /BLOCKING/);
});

test("--enforce mode does not block when not regressed", () => {
  const sc = { avg: 0.82, passed: 6, total: 7, results: [] };
  const baseline = { avg: 0.8, passed: 6, total: 7, recordedAt: "2026-06-01T00:00:00Z" };
  const r = compareToBaseline(sc, baseline, { tolerance: 0.05, enforce: true });
  assert.equal(r.regressed, false);
  assert.equal(r.blocked, false);
});

test("avg derived from results when top-level avg is missing", () => {
  const sc = { total: 2, results: [{ score: 1 }, { score: 0 }] };
  const baseline = { avg: 0.9, passed: 2, total: 2, recordedAt: "x" };
  const r = compareToBaseline(sc, baseline, { tolerance: 0.05 });
  assert.equal(r.avg, 0.5);
  assert.equal(r.regressed, true);
});

test("malformed scorecard/baseline degrade cleanly instead of throwing", () => {
  for (const bad of [null, undefined, 42, "nope", {}]) {
    const r = compareToBaseline(bad, bad);
    assert.equal(typeof r.line, "string");
    assert.equal(r.blocked, false);
  }
});

test("nextBaseline() captures avg/passed/total/model from an accepted scorecard", () => {
  const sc = { avg: 0.85, passed: 6, total: 7, model: "gpt-4o", results: [] };
  const b = nextBaseline(sc, null);
  assert.equal(b.avg, 0.85);
  assert.equal(b.passed, 6);
  assert.equal(b.total, 7);
  assert.equal(b.model, "gpt-4o");
  assert.ok(b.recordedAt);
});

test("nextBaseline() never overwrites a real baseline with an empty/failed run (total=0)", () => {
  const previous = { avg: 0.8, passed: 6, total: 7, recordedAt: "x" };
  const b = nextBaseline({ avg: 0, passed: 0, total: 0, results: [] }, previous);
  assert.deepEqual(b, previous);
});
