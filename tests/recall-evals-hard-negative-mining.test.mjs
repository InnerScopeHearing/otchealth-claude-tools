// Unit tests for the hard-negative (contrastive) MINING logic (skills/recall-evals/mine-hard-negatives.mjs).
// Every function under test here is PURE (no IO): no fetch, no fs, no credentials, no network, no
// process.env reads. This guards the safety filters (agent allowlist, PHI/MNPI deny, exhaust-type,
// progress-log exclusion, jaccard band) and the pair-resolution/candidate-parsing logic that a mining
// run depends on, without needing live Azure/LLM access to prove they behave correctly.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isSafeAgentPair,
  isContentSafe,
  isEligiblePair,
  resolveSupersedePairs,
  parseHardNegCandidate,
  UNSAFE_AGENTS,
  PHI_DENY,
  MNPI_DENY,
  EXHAUST_TYPES,
  PROGRESS_LOG_RE,
  JACCARD_MIN,
  JACCARD_MAX,
} from "../skills/recall-evals/mine-hard-negatives.mjs";

// ---- isSafeAgentPair --------------------------------------------------------------------------
test("isSafeAgentPair: both agents outside the unsafe set -> true", () => {
  assert.equal(isSafeAgentPair("cto", "developer"), true);
  assert.equal(isSafeAgentPair("coo", "coo"), true);
});
test("isSafeAgentPair: either agent in the unsafe (finance/legal/MNPI) set -> false", () => {
  assert.equal(isSafeAgentPair("cfo", "cfo"), false);
  assert.equal(isSafeAgentPair("cto", "cfo"), false);
  assert.equal(isSafeAgentPair("clo", "cto"), false);
  assert.equal(isSafeAgentPair("cto", "clo-personal"), false);
  for (const a of UNSAFE_AGENTS) assert.equal(isSafeAgentPair(a, "cto"), false, `${a} must be unsafe`);
});
test("isSafeAgentPair: missing agent on either side -> false (defensive)", () => {
  assert.equal(isSafeAgentPair("", "cto"), false);
  assert.equal(isSafeAgentPair("cto", undefined), false);
  assert.equal(isSafeAgentPair(null, null), false);
});

// ---- isContentSafe (PHI_DENY / MNPI_DENY) ----------------------------------------------------
test("isContentSafe: ordinary engineering text -> true", () => {
  assert.equal(isContentSafe("Front Door WAF policy names must be alphanumeric only"), true);
});
test("isContentSafe: PHI-adjacent terms -> false", () => {
  assert.equal(isContentSafe("the patient's audiogram showed a hearing number of 40"), false);
  assert.equal(isContentSafe("MedReview PHI workload"), false);
});
test("isContentSafe: MNPI/finance-securities terms -> false", () => {
  assert.equal(isContentSafe("the INND Series C derivative valuation model"), false);
  assert.equal(isContentSafe("GS Capital convertible note reclass"), false);
  assert.equal(isContentSafe("a SEC filing 10-K securities disclosure"), false);
});
test("PHI_DENY / MNPI_DENY are RegExp instances (sanity)", () => {
  assert.ok(PHI_DENY instanceof RegExp);
  assert.ok(MNPI_DENY instanceof RegExp);
});

// ---- isEligiblePair ---------------------------------------------------------------------------
// Inject a fake jaccard/tokenize pair so these tests don't depend on the real dedupe.mjs tokenizer's
// exact numbers -- they test isEligiblePair's OWN branching logic, not dedupe.mjs's math (that has
// its own test coverage in tests/ for dedupe.mjs, if any changes there should not break this file).
const fakeTokenize = (s) => new Set(String(s || "").split(" "));
function fakeJaccardAt(value) { return () => value; }

const OLD_ROW = { id: "old-1", agent: "cto", type: "fact", text: "the fleet backup is broken and produces a corpse copy" };
const NEW_ROW = { id: "new-1", agent: "cto", type: "correction", text: "the fleet backup is now fixed and produces a valid restorable copy" };

test("isEligiblePair: a genuine same-topic correction within the jaccard band -> eligible", () => {
  const r = isEligiblePair(OLD_ROW, NEW_ROW, { jaccardFn: fakeJaccardAt(0.2), tokenizeFn: fakeTokenize });
  assert.equal(r.eligible, true);
  assert.match(r.reason, /same-topic correction/);
});
test("isEligiblePair: missing old or new row -> ineligible", () => {
  assert.equal(isEligiblePair(null, NEW_ROW).eligible, false);
  assert.equal(isEligiblePair(OLD_ROW, null).eligible, false);
});
test("isEligiblePair: unsafe agent on either side -> ineligible regardless of content", () => {
  const r = isEligiblePair({ ...OLD_ROW, agent: "cfo" }, NEW_ROW, { jaccardFn: fakeJaccardAt(0.2), tokenizeFn: fakeTokenize });
  assert.equal(r.eligible, false);
  assert.match(r.reason, /unsafe agent/);
});
test("isEligiblePair: new row is an exhaust-type (status/episode/heartbeat/digest) -> ineligible", () => {
  for (const t of EXHAUST_TYPES) {
    const r = isEligiblePair(OLD_ROW, { ...NEW_ROW, type: t }, { jaccardFn: fakeJaccardAt(0.2), tokenizeFn: fakeTokenize });
    assert.equal(r.eligible, false, `type=${t} should be ineligible`);
    assert.match(r.reason, /exhaust-type/);
  }
});
test("isEligiblePair: PHI/MNPI-adjacent content on either side -> ineligible", () => {
  const r1 = isEligiblePair({ ...OLD_ROW, text: "INND Series C derivative valuation model" }, NEW_ROW, { jaccardFn: fakeJaccardAt(0.2), tokenizeFn: fakeTokenize });
  assert.equal(r1.eligible, false);
  assert.match(r1.reason, /PHI\/MNPI/);
  const r2 = isEligiblePair(OLD_ROW, { ...NEW_ROW, text: "patient audiogram hearing number 40" }, { jaccardFn: fakeJaccardAt(0.2), tokenizeFn: fakeTokenize });
  assert.equal(r2.eligible, false);
});
test("isEligiblePair: progress-log chatter on both sides -> ineligible", () => {
  const oldP = { ...OLD_ROW, text: "Batch tagging progress: 158 of 853 memories tagged. Continuing through remaining singletons in batches of 20." };
  const newP = { ...NEW_ROW, text: "Batch tagging progress: 178 of 853 memories tagged. Continuing through remaining singletons in batches of 20." };
  const r = isEligiblePair(oldP, newP, { jaccardFn: fakeJaccardAt(0.2), tokenizeFn: fakeTokenize });
  assert.equal(r.eligible, false);
  assert.match(r.reason, /progress-log/);
  assert.match(PROGRESS_LOG_RE.source, /singletons/); // sanity: the regex this test relies on
});
test("isEligiblePair: jaccard above JACCARD_MAX -> ineligible (near-duplicate)", () => {
  const r = isEligiblePair(OLD_ROW, NEW_ROW, { jaccardFn: fakeJaccardAt(JACCARD_MAX + 0.1), tokenizeFn: fakeTokenize });
  assert.equal(r.eligible, false);
  assert.match(r.reason, /near-duplicate/);
});
test("isEligiblePair: jaccard below JACCARD_MIN -> ineligible (likely unrelated topics)", () => {
  const r = isEligiblePair(OLD_ROW, NEW_ROW, { jaccardFn: fakeJaccardAt(Math.max(0, JACCARD_MIN - 0.01)), tokenizeFn: fakeTokenize });
  assert.equal(r.eligible, false);
  assert.match(r.reason, /unrelated topics/);
});
test("isEligiblePair: jaccard exactly at the band edges is INCLUSIVE (boundary check)", () => {
  const atMin = isEligiblePair(OLD_ROW, NEW_ROW, { jaccardFn: fakeJaccardAt(JACCARD_MIN), tokenizeFn: fakeTokenize });
  assert.equal(atMin.eligible, true);
  const atMax = isEligiblePair(OLD_ROW, NEW_ROW, { jaccardFn: fakeJaccardAt(JACCARD_MAX), tokenizeFn: fakeTokenize });
  assert.equal(atMax.eligible, true);
});

// ---- resolveSupersedePairs ---------------------------------------------------------------------
test("resolveSupersedePairs: resolves a simple chain of two rows", () => {
  const rows = [
    { id: "a", agent: "cto", text: "old claim" },
    { id: "b", agent: "cto", text: "new claim", supersedes: "a" },
  ];
  const pairs = resolveSupersedePairs(rows);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].newRow.id, "b");
  assert.equal(pairs[0].oldRow.id, "a");
});
test("resolveSupersedePairs: a multi-hop chain resolves EACH link independently", () => {
  const rows = [
    { id: "a", text: "gen 1" },
    { id: "b", text: "gen 2", supersedes: "a" },
    { id: "c", text: "gen 3", supersedes: "b" },
  ];
  const pairs = resolveSupersedePairs(rows);
  assert.equal(pairs.length, 2);
  assert.deepEqual(pairs.map((p) => `${p.oldRow.id}->${p.newRow.id}`).sort(), ["a->b", "b->c"]);
});
test("resolveSupersedePairs: a supersedes id absent from the array is skipped, not thrown", () => {
  const rows = [{ id: "b", text: "new claim", supersedes: "missing-id" }];
  assert.deepEqual(resolveSupersedePairs(rows), []);
});
test("resolveSupersedePairs: rows with no supersedes field are simply not paired", () => {
  const rows = [{ id: "a", text: "just a fact" }, { id: "b", text: "another fact" }];
  assert.deepEqual(resolveSupersedePairs(rows), []);
});
test("resolveSupersedePairs: empty/non-array input -> empty output, never throws", () => {
  assert.deepEqual(resolveSupersedePairs([]), []);
  assert.deepEqual(resolveSupersedePairs(undefined), []);
  assert.deepEqual(resolveSupersedePairs(null), []);
});
test("resolveSupersedePairs: null/undefined entries in the array are skipped defensively", () => {
  const rows = [null, { id: "a", text: "old" }, undefined, { id: "b", text: "new", supersedes: "a" }];
  const pairs = resolveSupersedePairs(rows);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].newRow.id, "b");
});

// ---- parseHardNegCandidate ----------------------------------------------------------------------
test("parseHardNegCandidate: a well-formed reply parses cleanly", () => {
  const raw = JSON.stringify({ query: "is the fleet backup verified", expect_new: ["now iterates", "valid"], expect_old: ["backup of a corpse"] });
  const c = parseHardNegCandidate(raw);
  assert.deepEqual(c, { query: "is the fleet backup verified", expectNew: ["now iterates", "valid"], expectOld: ["backup of a corpse"] });
});
test("parseHardNegCandidate: caps expect arrays at 2 entries", () => {
  const raw = JSON.stringify({ query: "q", expect_new: ["a", "b", "c"], expect_old: ["d", "e", "f"] });
  const c = parseHardNegCandidate(raw);
  assert.equal(c.expectNew.length, 2);
  assert.equal(c.expectOld.length, 2);
});
test("parseHardNegCandidate: missing query -> null", () => {
  assert.equal(parseHardNegCandidate(JSON.stringify({ expect_new: ["a"], expect_old: ["b"] })), null);
});
test("parseHardNegCandidate: empty query -> null", () => {
  assert.equal(parseHardNegCandidate(JSON.stringify({ query: "   ", expect_new: ["a"], expect_old: ["b"] })), null);
});
test("parseHardNegCandidate: missing expect_new -> null", () => {
  assert.equal(parseHardNegCandidate(JSON.stringify({ query: "q", expect_old: ["b"] })), null);
});
test("parseHardNegCandidate: missing expect_old -> null", () => {
  assert.equal(parseHardNegCandidate(JSON.stringify({ query: "q", expect_new: ["a"] })), null);
});
test("parseHardNegCandidate: empty-array expect_new/expect_old -> null", () => {
  assert.equal(parseHardNegCandidate(JSON.stringify({ query: "q", expect_new: [], expect_old: ["b"] })), null);
});
test("parseHardNegCandidate: malformed JSON -> null, never throws", () => {
  assert.equal(parseHardNegCandidate("not json at all {{{"), null);
  assert.equal(parseHardNegCandidate(""), null);
  assert.equal(parseHardNegCandidate(undefined), null);
});
test("parseHardNegCandidate: non-string entries in expect arrays are filtered out, not kept", () => {
  const raw = JSON.stringify({ query: "q", expect_new: ["a", 5, null], expect_old: ["b"] });
  const c = parseHardNegCandidate(raw);
  assert.deepEqual(c.expectNew, ["a"]);
});
test("parseHardNegCandidate: query longer than 500 chars is truncated, not rejected", () => {
  const raw = JSON.stringify({ query: "q".repeat(600), expect_new: ["a"], expect_old: ["b"] });
  const c = parseHardNegCandidate(raw);
  assert.equal(c.query.length, 500);
});
