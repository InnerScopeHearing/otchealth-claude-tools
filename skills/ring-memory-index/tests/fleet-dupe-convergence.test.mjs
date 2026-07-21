// Defect-1 fix tests: the dual-writer duplication in memory-exec.
//
// Two writers used to index overlapping content into the SAME `memory-exec` Azure AI Search index under
// DIFFERENT id schemes + text formats (kb-memory/semantic.mjs's reindex() vs this skill's fleet push),
// producing ~882/6176 (~14%) duplicate rows that diluted recall. The fix converges both writers onto ONE
// id scheme (semantic.mjs's own docId(), imported not reimplemented -- see fleetKeyFor) and ONE text
// format (raw entry text, not type-prefixed) for a given source entry, and a `reconcile-fleet-dupes`
// verb cleans the pre-fix leftovers. These tests pin: (a) the convergence property itself (the crux of
// the fix -- proves the REAL production code path, not a test-side reimplementation), and (b) the
// cleanup planner's safety invariant (never proposes deleting the only copy of a fact).
import { test } from "node:test";
import assert from "node:assert/strict";
import { docId as semanticDocId } from "../../kb-memory/semantic.mjs";
import { fleetKeyFor, fallbackRowId, planFleetDupeCleanup, RINGS } from "../index-ring-memory.mjs";

const cooRing = RINGS.find((r) => r.label === "coo");

// ── fleetKeyFor(): the convergence property ─────────────────────────────────────────────────────────

test("fleetKeyFor produces the IDENTICAL key semantic.mjs's reindex() would produce for the same shared entry", () => {
  // The exact shape of a --share'd entry: it lives under the SAME id in BOTH _MEMORY/coo.jsonl (read by
  // indexRing here) and _MEMORY/_exec/coo.jsonl (read by semantic.mjs's readExecFeed()) -- mem.mjs's
  // append() builds one entry object and writes it, unmodified, to both places.
  const sharedEntry = { id: "20260721-001-ab12", ts: "2026-07-21T00:00:00.000Z", type: "fact", text: "Mercury cash position is $412k" };
  const whatSemanticWrites = semanticDocId("coo", sharedEntry.id); // reindex()'s doc: id: e._docId (== docId(agent,id) for the non-colliding common case)
  const whatFleetPushWrites = fleetKeyFor(cooRing, sharedEntry, 0); // indexRing()'s fleet doc: id: c.fleetId
  assert.equal(whatFleetPushWrites, whatSemanticWrites, "both writers must land on the SAME Azure AI Search document key for a shared entry -- this is what makes mergeOrUpload collapse them to one row instead of two");
  assert.equal(whatFleetPushWrites, "coo__20260721-001-ab12");
});

test("fleetKeyFor differs across agents and across ids (no false convergence / cross-agent collision)", () => {
  const a = fleetKeyFor(cooRing, { id: "20260721-001-ab12" }, 0);
  const cfoRing = RINGS.find((r) => r.label === "cfo");
  const b = fleetKeyFor(cfoRing, { id: "20260721-001-ab12" }, 0); // same id, different ring/agent
  const c = fleetKeyFor(cooRing, { id: "20260721-002-cd34" }, 0); // same ring, different id
  assert.notEqual(a, b);
  assert.notEqual(a, c);
});

test("fleetKeyFor is deterministic and stable across repeated calls (idempotent re-runs)", () => {
  const entry = { id: "20260721-005-ff00", ts: "2026-07-21T00:00:00.000Z" };
  assert.equal(fleetKeyFor(cooRing, entry, 0), fleetKeyFor(cooRing, entry, 0));
});

test("fallbackRowId falls back to a per-ring synthetic id ONLY when the row has no real .id (defensive path)", () => {
  const withId = fallbackRowId(cooRing, { id: "20260721-001-ab12" }, 3);
  assert.equal(withId, "20260721-001-ab12", "a real ledger id is used as-is, never replaced");
  const withoutId = fallbackRowId(cooRing, { ts: "2026-07-21T00:00:00.000Z" }, 3);
  assert.equal(withoutId, "coom-3-2026-07-21T00:00:00", "falls back to <idPrefix>-<index>-<ts prefix> when .id is absent");
});

// ── planFleetDupeCleanup(): the reconcile-fleet-dupes safety invariant ─────────────────────────────

test("planFleetDupeCleanup: a fleet__ doc with a same-agent-same-ts converged twin is marked for deletion (the actual ~882 duplicate case)", () => {
  const docs = [
    { id: "coo__20260721-001-ab12", agent: "coo", ts: "2026-07-21T00:00:00.000Z" }, // converged doc (either writer, post-fix)
    { id: "fleet__coo__oldlocalhash", agent: "coo", ts: "2026-07-21T00:00:00.000Z" }, // pre-fix duplicate of the SAME fact
  ];
  const { toDelete, kept } = planFleetDupeCleanup(docs);
  assert.deepEqual(toDelete, ["fleet__coo__oldlocalhash"]);
  assert.deepEqual(kept, []);
});

test("planFleetDupeCleanup: a fleet__ doc with NO converged twin is KEPT, never deleted (no fact is ever silently lost)", () => {
  const docs = [
    { id: "fleet__coo__onlycopy", agent: "coo", ts: "2026-07-21T09:00:00.000Z" }, // never --share'd: this IS the only copy of the fact
    { id: "coo__unrelated", agent: "coo", ts: "2026-07-21T10:00:00.000Z" }, // a different fact, different ts -- not a twin
  ];
  const { toDelete, kept } = planFleetDupeCleanup(docs);
  assert.deepEqual(toDelete, []);
  assert.deepEqual(kept, ["fleet__coo__onlycopy"]);
});

test("planFleetDupeCleanup: never touches non-fleet__ docs (they are never candidates for deletion)", () => {
  const docs = [
    { id: "coo__a", agent: "coo", ts: "T1" },
    { id: "cfo__b", agent: "cfo", ts: "T2" },
  ];
  const { toDelete, kept } = planFleetDupeCleanup(docs);
  assert.deepEqual(toDelete, []);
  assert.deepEqual(kept, []);
});

test("planFleetDupeCleanup: the (agent,ts) join is agent-scoped -- a different agent's doc at the SAME ts is not treated as a twin", () => {
  const docs = [
    { id: "cfo__x", agent: "cfo", ts: "2026-07-21T00:00:00.000Z" }, // different agent, coincidentally same ts
    { id: "fleet__coo__y", agent: "coo", ts: "2026-07-21T00:00:00.000Z" },
  ];
  const { toDelete, kept } = planFleetDupeCleanup(docs);
  assert.deepEqual(toDelete, [], "a cfo doc must never be treated as coo's twin, even at the same timestamp");
  assert.deepEqual(kept, ["fleet__coo__y"]);
});

test("planFleetDupeCleanup: handles a mixed realistic batch correctly in one pass", () => {
  const docs = [
    { id: "coo__001", agent: "coo", ts: "T1" },
    { id: "fleet__coo__001old", agent: "coo", ts: "T1" }, // dupe of coo__001 -> delete
    { id: "fleet__coo__002only", agent: "coo", ts: "T2" }, // no twin -> keep
    { id: "cco__003", agent: "cco", ts: "T3" },
    { id: "fleet__cco__003old", agent: "cco", ts: "T3" }, // dupe of cco__003 -> delete
    { id: "fleet__developer__004only", agent: "developer", ts: "T4" }, // no twin -> keep
  ];
  const { toDelete, kept } = planFleetDupeCleanup(docs);
  assert.deepEqual(new Set(toDelete), new Set(["fleet__coo__001old", "fleet__cco__003old"]));
  assert.deepEqual(new Set(kept), new Set(["fleet__coo__002only", "fleet__developer__004only"]));
});

test("planFleetDupeCleanup: empty / malformed input never throws", () => {
  assert.doesNotThrow(() => planFleetDupeCleanup([]));
  assert.doesNotThrow(() => planFleetDupeCleanup(null));
  assert.doesNotThrow(() => planFleetDupeCleanup([null, undefined, {}, { id: "fleet__x" }]));
  const { toDelete, kept } = planFleetDupeCleanup([null, undefined, {}, { id: "fleet__x" }]);
  assert.deepEqual(toDelete, []);
  assert.deepEqual(kept, ["fleet__x"], "a fleet__ doc with no ts can never be matched to a twin, so it is conservatively kept");
});
