// Unit tests for the recall-evals PURE scoring core (skills/recall-evals/scoring.mjs). No IO: no
// fetch, no fs, no credentials, no network. Guards the math the recall-quality harness reports on.
import { test } from "node:test";
import assert from "node:assert";
import { lineMatches, precisionAtK, hitAtK, reciprocalRank, aggregate } from "../skills/recall-evals/scoring.mjs";

test("lineMatches: case-insensitive substring match against any expect term", () => {
  assert.equal(lineMatches("The WAF Policy names must be alphanumeric only", ["waf policy names must be alphanumeric"]), true);
  assert.equal(lineMatches("unrelated line about something else", ["waf policy"]), false);
  assert.equal(lineMatches("A or B present here", ["zzz", "present here"]), true);
});
test("lineMatches: defensive on empty/missing inputs", () => {
  assert.equal(lineMatches("", ["x"]), false);
  assert.equal(lineMatches("hello", []), false);
  assert.equal(lineMatches("hello", null), false);
  assert.equal(lineMatches(null, ["x"]), false);
});

test("precisionAtK: all relevant -> 1.0", () => {
  const results = ["fact about foo", "another foo mention"];
  assert.equal(precisionAtK(results, ["foo"], 2), 1);
});
test("precisionAtK: none relevant -> 0", () => {
  const results = ["bar line", "baz line"];
  assert.equal(precisionAtK(results, ["foo"], 2), 0);
});
test("precisionAtK: partial relevance within k", () => {
  const results = ["foo hit", "bar miss", "baz miss", "foo hit again"];
  // top-2: 1 of 2 relevant
  assert.equal(precisionAtK(results, ["foo"], 2), 0.5);
});
test("precisionAtK: k larger than results uses full list length", () => {
  const results = ["foo hit", "bar miss"];
  assert.equal(precisionAtK(results, ["foo"], 10), 0.5);
});
test("precisionAtK: empty results -> 0", () => {
  assert.equal(precisionAtK([], ["foo"], 5), 0);
});
test("precisionAtK: k<=0 -> 0", () => {
  assert.equal(precisionAtK(["foo"], ["foo"], 0), 0);
  assert.equal(precisionAtK(["foo"], ["foo"], -3), 0);
});

test("hitAtK: at least one relevant line in top-k -> 1", () => {
  assert.equal(hitAtK(["bar", "foo hit", "baz"], ["foo"], 3), 1);
});
test("hitAtK: relevant line outside the k window -> 0", () => {
  assert.equal(hitAtK(["bar", "baz", "foo hit"], ["foo"], 2), 0);
});
test("hitAtK: no relevant line anywhere -> 0", () => {
  assert.equal(hitAtK(["bar", "baz"], ["foo"], 5), 0);
});
test("hitAtK: k<=0 -> 0 even if a relevant line exists", () => {
  assert.equal(hitAtK(["foo hit"], ["foo"], 0), 0);
  assert.equal(hitAtK(["foo hit"], ["foo"], -1), 0);
});

test("reciprocalRank: first line relevant -> 1.0", () => {
  assert.equal(reciprocalRank(["foo hit", "bar"], ["foo"]), 1);
});
test("reciprocalRank: second line relevant -> 0.5", () => {
  assert.equal(reciprocalRank(["bar", "foo hit"], ["foo"]), 0.5);
});
test("reciprocalRank: third line relevant -> 1/3", () => {
  assert.equal(reciprocalRank(["bar", "baz", "foo hit"], ["foo"]), 1 / 3);
});
test("reciprocalRank: never relevant -> 0", () => {
  assert.equal(reciprocalRank(["bar", "baz"], ["foo"]), 0);
});
test("reciprocalRank: empty results -> 0", () => {
  assert.equal(reciprocalRank([], ["foo"]), 0);
});

test("aggregate: mixes hits and misses across multiple golden items", () => {
  const items = [
    { results: ["foo hit", "noise"], expect: ["foo"] },      // p@2=0.5, hit=1, rr=1
    { results: ["noise", "noise2"], expect: ["zzz"] },        // p@2=0, hit=0, rr=0
    { results: ["noise", "bar hit"], expect: ["bar"] },       // p@2=0.5, hit=1, rr=0.5
  ];
  const agg = aggregate(items, 2);
  assert.equal(agg.n, 3);
  assert.ok(Math.abs(agg.meanPrecisionAtK - (0.5 + 0 + 0.5) / 3) < 1e-9);
  assert.ok(Math.abs(agg.hitRate - 2 / 3) < 1e-9);
  assert.ok(Math.abs(agg.mrr - (1 + 0 + 0.5) / 3) < 1e-9);
});
test("aggregate: empty item list -> all zeros, no crash", () => {
  const agg = aggregate([], 5);
  assert.deepEqual(agg, { n: 0, meanPrecisionAtK: 0, hitRate: 0, mrr: 0 });
});
test("aggregate: perfect recall on every item -> all metrics 1", () => {
  const items = [
    { results: ["foo hit"], expect: ["foo"] },
    { results: ["bar hit"], expect: ["bar"] },
  ];
  const agg = aggregate(items, 5);
  assert.equal(agg.meanPrecisionAtK, 1);
  assert.equal(agg.hitRate, 1);
  assert.equal(agg.mrr, 1);
});

test("scoring core has no IO surface (sanity: module exports are pure functions only)", () => {
  const mod = { lineMatches, precisionAtK, hitAtK, reciprocalRank, aggregate };
  for (const [name, fn] of Object.entries(mod)) {
    assert.equal(typeof fn, "function", `${name} should be a function`);
  }
});
