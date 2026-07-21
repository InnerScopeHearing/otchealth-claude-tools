// Defect-2 fix tests: gateway-parity recall-quality safeguards for kb-memory/semantic.mjs's local
// recall() path. The gateway (otchealth-mcp-server) applies retraction filtering, operational-exhaust
// room hygiene, and authority/freshness re-rank (the last already covered by rankHitsByTrust, tested in
// semantic-trust-recall.test.mjs) that this local recall() lacked. These tests pin the two genuinely-new
// safeguards: computeRetractedIds (the PRODUCER: which ledger ids get tagged `retracted`) and
// filterHygiene (the CONSUMER: recall() dropping retracted/exhaust rows). Both are pure and fail-open.
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeRetractedIds, filterHygiene, EXHAUST_TYPES } from "../semantic.mjs";

// ── computeRetractedIds(): the producer side ────────────────────────────────────────────────────────

test("computeRetractedIds: an entry that is some other entry's `supersedes` target is retracted", () => {
  const entries = [
    { id: "20260701-001-aa", text: "the Mercury balance is $300k" },
    { id: "20260705-002-bb", text: "correction: the Mercury balance is $412k", supersedes: "20260701-001-aa" },
  ];
  const retracted = computeRetractedIds(entries);
  assert.ok(retracted.has("20260701-001-aa"), "the superseded (old, wrong) entry must be flagged retracted");
  assert.ok(!retracted.has("20260705-002-bb"), "the superseding (new, correct) entry must NOT be flagged retracted");
});

test("computeRetractedIds: an entry with no corrector is never retracted", () => {
  const entries = [{ id: "a", text: "still true" }, { id: "b", text: "unrelated" }];
  assert.equal(computeRetractedIds(entries).size, 0);
});

test("computeRetractedIds: a chain of corrections retracts every earlier link, not just the first", () => {
  // A --supersedes B, B --supersedes C: both B and C are retracted; only the newest (A) survives.
  const entries = [
    { id: "C", text: "v1" },
    { id: "B", text: "v2", supersedes: "C" },
    { id: "A", text: "v3", supersedes: "B" },
  ];
  const retracted = computeRetractedIds(entries);
  assert.ok(retracted.has("C"));
  assert.ok(retracted.has("B"));
  assert.ok(!retracted.has("A"), "the newest link in the chain is never itself retracted");
});

test("computeRetractedIds: malformed/empty input never throws", () => {
  assert.doesNotThrow(() => computeRetractedIds([]));
  assert.doesNotThrow(() => computeRetractedIds(null));
  assert.doesNotThrow(() => computeRetractedIds([null, undefined, {}, { id: "x" }]));
  assert.equal(computeRetractedIds(null).size, 0);
});

// ── filterHygiene(): the consumer side (what recall() actually applies to search hits) ────────────────

test("filterHygiene drops a retracted hit (the retraction-filtering safeguard)", () => {
  const hits = [
    { agent: "cfo", type: "fact", ts: "2026-07-01", text: "old, corrected balance", retracted: true },
    { agent: "cfo", type: "fact", ts: "2026-07-05", text: "current balance" },
  ];
  const out = filterHygiene(hits);
  assert.equal(out.length, 1);
  assert.equal(out[0].text, "current balance");
});

test("filterHygiene drops operational-exhaust chatter by default (status/episode/heartbeat/digest)", () => {
  const hits = [
    { agent: "coo", type: "status", ts: "t", text: "working on X" },
    { agent: "cto", type: "episode", ts: "t", text: "auto-journal entry" },
    { agent: "cto", type: "heartbeat", ts: "t", text: "alive" },
    { agent: "cco", type: "digest", ts: "t", text: "daily digest" },
    { agent: "cfo", type: "pitfall", ts: "t", text: "a durable lesson" },
    { agent: "cfo", type: "decision", ts: "t", text: "a real decision" },
  ];
  const out = filterHygiene(hits);
  assert.deepEqual(out.map((h) => h.type), ["pitfall", "decision"], "only non-exhaust types survive by default");
});

test("filterHygiene: --include-ops (includeOps:true) restores exhaust types but NEVER restores retracted rows", () => {
  const hits = [
    { agent: "coo", type: "status", ts: "t", text: "working on X" },
    { agent: "cfo", type: "fact", ts: "t", text: "stale corrected fact", retracted: true },
    { agent: "cfo", type: "fact", ts: "t", text: "current fact" },
  ];
  const out = filterHygiene(hits, { includeOps: true });
  assert.deepEqual(out.map((h) => h.text), ["working on X", "current fact"], "ops chatter comes back, but a retracted row never does -- retraction is not gated by includeOps");
});

test("filterHygiene: an explicit --type request is honored even if it names an exhaust type (no self-defeating filter)", () => {
  const hits = [
    { agent: "coo", type: "status", ts: "t", text: "working on X" },
    { agent: "cco", type: "status", ts: "t", text: "working on Y" },
  ];
  const out = filterHygiene(hits, { typeFilter: "status" });
  assert.equal(out.length, 2, "the caller explicitly asked for --type status; the exhaust filter must not silently strip its own results back out");
});

test("filterHygiene: a doc from BEFORE the retracted field existed (undefined, not false) is treated as NOT retracted (fail-open default)", () => {
  const hits = [{ agent: "cto", type: "fact", ts: "t", text: "pre-fix doc, no retracted field at all" }];
  const out = filterHygiene(hits);
  assert.equal(out.length, 1, "an absent `retracted` field must default to shown, not hidden -- this is the fail-open contract for a not-yet-reindexed doc");
});

test("filterHygiene: EXHAUST_TYPES is exactly the four categories named in the defect (status/episode/heartbeat/digest)", () => {
  assert.deepEqual([...EXHAUST_TYPES].sort(), ["digest", "episode", "heartbeat", "status"]);
});

test("filterHygiene: fail-open on a throw inside the predicate (a malformed hit shape never blanks recall)", () => {
  // A getter that throws simulates an unexpected hit shape; filterHygiene must return the ORIGINAL input
  // rather than propagate the error (recall() would otherwise crash instead of degrading gracefully).
  const evil = [{ get type() { throw new Error("boom"); }, text: "x" }];
  assert.doesNotThrow(() => filterHygiene(evil));
  const out = filterHygiene(evil);
  assert.equal(out, evil, "on internal failure, filterHygiene returns the untouched input array");
});

test("filterHygiene: empty input handled cleanly", () => {
  assert.deepEqual(filterHygiene([]), []);
  assert.deepEqual(filterHygiene(null), []);
});
