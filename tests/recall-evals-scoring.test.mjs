// Unit tests for the recall-evals PURE scoring core (skills/recall-evals/scoring.mjs). No IO: no
// fetch, no fs, no credentials, no network. Guards the math the recall-quality harness reports on.
import { test } from "node:test";
import assert from "node:assert";
import { lineMatches, precisionAtK, hitAtK, reciprocalRank, aggregate, groupHitLines } from "../skills/recall-evals/scoring.mjs";

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
  const mod = { lineMatches, precisionAtK, hitAtK, reciprocalRank, aggregate, groupHitLines };
  for (const [name, fn] of Object.entries(mod)) {
    assert.equal(typeof fn, "function", `${name} should be a function`);
  }
});

// groupHitLines: the fix for the line-vs-hit miscalibration found 2026-07-17. semantic.mjs recall()
// renders each retrieved memory as 2-3 stdout lines (header / text / optional tags); before this fix,
// run-evals.mjs fed every raw line into a line-based top-k cutoff, so "k=5" silently evaluated only
// the first ~2 real hits instead of the top 5 retrieved memories. These guard the grouping so a future
// change to the runner can't reintroduce that miscalibration.
test("groupHitLines: a 3-line header+text+tags hit becomes ONE array entry", () => {
  const raw = [
    "[cto] [pitfall] 2026-07-01 (score 0.033 | trust: unverified t=0.38, 1 agent)",
    "Front Door WAF policy names must be alphanumeric only (no hyphens)",
    "tags: auto-reflect",
  ];
  const hits = groupHitLines(raw);
  assert.equal(hits.length, 1, "one hit block, not three separate lines");
  assert.match(hits[0], /alphanumeric only/);
  assert.match(hits[0], /tags: auto-reflect/);
});

test("groupHitLines: multiple hits (with and without a tags line) are split at each header", () => {
  const raw = [
    "[cto] [pitfall] 2026-07-01 (score 0.033 | trust: unverified t=0.38, 1 agent)",
    "first fact text",
    "tags: a, b",
    "[cto] [decision] 2026-07-01 (score 0.031 | trust: unverified t=0.38, 1 agent)",
    "second fact text, no tags line this time",
    "[coo] [fact] 2026-07-02 (score 0.030 | trust: unverified t=0.38, 1 agent)",
    "third fact text",
  ];
  const hits = groupHitLines(raw);
  assert.equal(hits.length, 3);
  assert.match(hits[0], /first fact text/);
  assert.match(hits[1], /second fact text/);
  assert.match(hits[2], /third fact text/);
});

test("groupHitLines: the exact bug reproduction -- 5 real hits used to be truncated to ~2 by a k=5 line cutoff", () => {
  // 5 hits x ~2.8 lines each = 14 raw lines. A line-based top-5 cutoff (the pre-fix behavior) would see
  // only hit 1 (3 lines) + the header+text of hit 2 (cut off before its tags line) -- 2 real hits, not 5.
  const raw = [];
  for (let i = 1; i <= 5; i++) {
    raw.push(`[cto] [fact] 2026-07-0${i} (score 0.0${30 - i} | trust: unverified t=0.38, 1 agent)`);
    raw.push(`fact number ${i} text here`);
    if (i !== 2) raw.push(`tags: item-${i}`); // hit 2 has no tags line, matching real recall output variance
  }
  const hits = groupHitLines(raw);
  assert.equal(hits.length, 5, "all 5 real hits must be recovered as 5 array entries");
  const top5 = hits.slice(0, 5);
  assert.ok(top5.some((h) => h.includes("fact number 5")), "the 5th real hit must be reachable within a top-5 cutoff after grouping");
});

test("groupHitLines: empty input -> empty output, never throws", () => {
  assert.deepEqual(groupHitLines([]), []);
  assert.deepEqual(groupHitLines(undefined), []);
});

test("groupHitLines: a line that doesn't match the header pattern at position 0 still starts a block (defensive)", () => {
  const hits = groupHitLines(["not a header line", "continuation"]);
  assert.equal(hits.length, 1);
  assert.match(hits[0], /not a header line continuation/);
});
