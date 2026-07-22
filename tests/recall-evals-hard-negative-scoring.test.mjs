// Unit tests for the hard-negative (contrastive) SCORING core (skills/recall-evals/hard-negative-scoring.mjs).
// Pure: no IO. Guards the "did the current fact show up AND did the retracted one stay suppressed"
// math the contrastive eval pages on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { hardNegItemResult, aggregateHardNeg, answerMatches } from "../skills/recall-evals/hard-negative-scoring.mjs";

test("hardNegItemResult: current fact found, retracted fact absent -> passed", () => {
  const results = ["fleet-backup now iterates expected-indexes.json and works", "unrelated noise"];
  const r = hardNegItemResult(results, ["now iterates"], ["backup of a corpse"], 5);
  assert.deepEqual(r, { newHit: 1, oldLeak: 0, passed: 1 });
});
test("hardNegItemResult: retracted fact LEAKS into top-k -> not passed, even if current also found", () => {
  const results = ["fleet-backup now iterates expected-indexes.json", "the fleet backup is a backup of a corpse"];
  const r = hardNegItemResult(results, ["now iterates"], ["backup of a corpse"], 5);
  assert.equal(r.newHit, 1);
  assert.equal(r.oldLeak, 1);
  assert.equal(r.passed, 0);
});
test("hardNegItemResult: current fact NOT found at all -> not passed regardless of leak", () => {
  const results = ["totally unrelated result"];
  const r = hardNegItemResult(results, ["now iterates"], ["backup of a corpse"], 5);
  assert.equal(r.newHit, 0);
  assert.equal(r.passed, 0);
});
test("hardNegItemResult: leak outside the k window does not count (respects the cutoff)", () => {
  const results = ["now iterates hit here", "noise", "noise", "noise", "noise", "backup of a corpse leak, but past k"];
  const r = hardNegItemResult(results, ["now iterates"], ["backup of a corpse"], 5);
  assert.equal(r.newHit, 1);
  assert.equal(r.oldLeak, 0);
  assert.equal(r.passed, 1);
});
test("hardNegItemResult: empty results -> both zero, not passed", () => {
  const r = hardNegItemResult([], ["x"], ["y"], 5);
  assert.deepEqual(r, { newHit: 0, oldLeak: 0, passed: 0 });
});

test("aggregateHardNeg: mixed pass/fail/leak across several items", () => {
  const items = [
    { results: ["now iterates"], expectNew: ["now iterates"], expectOld: ["backup of a corpse"] },              // pass
    { results: ["now iterates", "backup of a corpse"], expectNew: ["now iterates"], expectOld: ["backup of a corpse"] }, // found + leaked -> fail
    { results: ["nothing relevant"], expectNew: ["now iterates"], expectOld: ["backup of a corpse"] },          // not found -> fail
  ];
  const agg = aggregateHardNeg(items, 5);
  assert.equal(agg.n, 3);
  assert.ok(Math.abs(agg.correctRate - 2 / 3) < 1e-9);   // items 1 and 2 found the current fact
  assert.ok(Math.abs(agg.leakRate - 1 / 3) < 1e-9);       // only item 2 leaked
  assert.ok(Math.abs(agg.passRate - 1 / 3) < 1e-9);       // only item 1 both found + leak-free
});
test("aggregateHardNeg: empty item list -> all zeros, no crash", () => {
  assert.deepEqual(aggregateHardNeg([], 5), { n: 0, correctRate: 0, leakRate: 0, passRate: 0 });
});
test("aggregateHardNeg: perfect run -> correctRate 1, leakRate 0, passRate 1", () => {
  const items = [
    { results: ["a fact"], expectNew: ["a fact"], expectOld: ["wrong fact"] },
    { results: ["b fact"], expectNew: ["b fact"], expectOld: ["wrong fact 2"] },
  ];
  const agg = aggregateHardNeg(items, 5);
  assert.equal(agg.correctRate, 1);
  assert.equal(agg.leakRate, 0);
  assert.equal(agg.passRate, 1);
});
test("aggregateHardNeg: total-failure run (everything leaks, nothing found) -> passRate 0", () => {
  const items = [{ results: ["wrong fact only"], expectNew: ["a fact"], expectOld: ["wrong fact"] }];
  const agg = aggregateHardNeg(items, 5);
  assert.equal(agg.correctRate, 0);
  assert.equal(agg.leakRate, 1);
  assert.equal(agg.passRate, 0);
});

test("answerMatches: substring match against a synthesized answer string, case-insensitive", () => {
  assert.equal(answerMatches("Yes, the fleet backup now iterates and WORKS correctly.", ["now iterates"]), true);
  assert.equal(answerMatches("Yes, the fleet backup now iterates and WORKS correctly.", ["backup of a corpse"]), false);
});
test("answerMatches: defensive on empty/missing inputs", () => {
  assert.equal(answerMatches("", ["x"]), false);
  assert.equal(answerMatches("hello", []), false);
  assert.equal(answerMatches(null, ["x"]), false);
});
