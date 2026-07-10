// Unit tests for company-brain's diff mode: the pure diffMemory() bucketer, the selectLanes()
// privilege wall (mirrors selectRooms' clo-personal gate), and the ringSafeForDiff() MNPI/PHI content
// wall. All hermetic (no Azure AI Search / Azure OpenAI / Blob calls) so the delta semantics stay
// pinned even as the I/O glue around them changes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { diffMemory, selectLanes, ringSafeForDiff } from "../skills/company-brain/brain.mjs";

const SINCE = "2026-06-20T00:00:00Z";
const NOW = "2026-07-01T00:00:00Z";

test("a brand-new row inside the window with nothing superseding it is ADDED", () => {
  const rows = [{ id: "a1", agent: "cto", type: "fact", ts: "2026-06-25T00:00:00Z", text: "New fact" }];
  const d = diffMemory(rows, SINCE, { now: NOW });
  assert.equal(d.added.length, 1);
  assert.equal(d.added[0].id, "a1");
  assert.equal(d.changed.length, 0);
  assert.equal(d.retired.length, 0);
});

test("a row inside the window that supersedes an earlier row is CHANGED, with the full chain", () => {
  const rows = [
    { id: "old1", agent: "cto", type: "fact", ts: "2026-05-01T00:00:00Z", text: "n8n Cloud is production" },
    { id: "new1", agent: "cto", type: "correction", ts: "2026-06-22T00:00:00Z", text: "n8n self-host is production", supersedes: "old1", was: "n8n Cloud is production" },
  ];
  const d = diffMemory(rows, SINCE, { now: NOW });
  assert.equal(d.changed.length, 1);
  assert.equal(d.changed[0].chain.length, 2);
  assert.equal(d.changed[0].chain[0].id, "old1");
  assert.equal(d.changed[0].chain[1].id, "new1");
  assert.equal(d.added.length, 0, "the old row must not ALSO show as added");
});

test("a row that pre-dates the window but was superseded INSIDE the window is RETIRED", () => {
  const rows = [
    { id: "old2", agent: "cfo", type: "fact", ts: "2026-01-01T00:00:00Z", text: "Codemagic is the iOS build path" },
    { id: "new2", agent: "cfo", type: "correction", ts: "2026-06-24T00:00:00Z", text: "Depot is the iOS build path", supersedes: "old2", was: "Codemagic is the iOS build path" },
  ];
  const d = diffMemory(rows, SINCE, { now: NOW });
  assert.equal(d.retired.length, 1);
  assert.equal(d.retired[0].id, "old2");
  assert.equal(d.retired[0].retiredBy, "new2");
  // the new row IS in the window and supersedes something -> it is CHANGED, not double-counted as retired
  assert.equal(d.changed.length, 1);
});

test("a row that pre-dates the window, is still active, and was untouched is STILL TRUE (not a delta item)", () => {
  const rows = [{ id: "old3", agent: "clo", type: "decision", ts: "2026-01-15T00:00:00Z", text: "Branch discipline: feature branches only" }];
  const d = diffMemory(rows, SINCE, { now: NOW });
  assert.equal(d.stillTrue.length, 1);
  assert.equal(d.added.length, 0);
  assert.equal(d.changed.length, 0);
  assert.equal(d.retired.length, 0);
});

test("a multi-hop supersedes chain (WAS -> WAS -> NOW) renders the FULL chain in order", () => {
  const rows = [
    { id: "v1", agent: "cto", type: "fact", ts: "2026-01-01T00:00:00Z", text: "v1: gpt-4o primary" },
    { id: "v2", agent: "cto", type: "correction", ts: "2026-03-01T00:00:00Z", text: "v2: gpt-4.1-mini fallback", supersedes: "v1" },
    { id: "v3", agent: "cto", type: "correction", ts: "2026-06-25T00:00:00Z", text: "v3: gpt-5.1 fallback (gpt-4.1-mini banned)", supersedes: "v2" },
  ];
  const d = diffMemory(rows, SINCE, { now: NOW });
  assert.equal(d.changed.length, 1);
  assert.deepEqual(d.changed[0].chain.map((r) => r.id), ["v1", "v2", "v3"]);
});

test("a row with no ts never crashes the bucketer and is never miscounted as a WINDOW delta", () => {
  // malformed/missing ts must not throw, and must never land in added/changed (both require a
  // confirmed in-window ts); it safely falls through to still-true (context, not a delta claim).
  const rows = [{ id: "bad", agent: "cto", type: "fact", text: "no timestamp" }];
  const d = diffMemory(rows, SINCE, { now: NOW });
  assert.equal(d.added.length, 0);
  assert.equal(d.changed.length, 0);
  assert.equal(d.retired.length, 0);
});

// ---- selectLanes (privilege wall) ----
test("selectLanes excludes clo-personal by default", () => {
  const lanes = ["cto", "cfo", "clo", "clo-personal"];
  assert.deepEqual(selectLanes(lanes, {}).sort(), ["cfo", "clo", "cto"]);
});

test("selectLanes includes clo-personal ONLY for agent=clo + includePersonal", () => {
  const lanes = ["cto", "clo-personal"];
  assert.ok(selectLanes(lanes, { agent: "clo", includePersonal: true }).includes("clo-personal"));
  assert.ok(!selectLanes(lanes, { agent: "clo", includePersonal: false }).includes("clo-personal"));
  assert.ok(!selectLanes(lanes, { agent: "cfo", includePersonal: true }).includes("clo-personal"));
});

// ---- ringSafeForDiff (MNPI/PHI content wall) ----
test("an INND/MNPI-flagged row is hidden from a non-authorized agent's diff", () => {
  const row = { text: "INND Reg D raise terms finalized", tags: [] };
  assert.equal(ringSafeForDiff(row, "growth"), false);
  assert.equal(ringSafeForDiff(row, "cfo"), true, "cfo is MNPI-authorized");
  assert.equal(ringSafeForDiff(row, "clo"), true, "clo is MNPI-authorized");
});

test("a plain non-sensitive row is visible to every agent", () => {
  const row = { text: "Depot macOS runners are the iOS build path now" };
  assert.equal(ringSafeForDiff(row, "growth"), true);
  assert.equal(ringSafeForDiff(row, "developer"), true);
});
