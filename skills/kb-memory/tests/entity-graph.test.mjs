// Tests for the Phase 4D entity-RELATIONSHIP (edge) layer in kb-memory/entity-graph.mjs: building a
// link row's content fields, and the pure in-memory 1-2 hop graph walk. Pure-function tests, imported
// directly from the sibling module (mirrors skills/kb-memory/tests/semantic-trust-recall.test.mjs) so
// they run fully offline -- no Cosmos, no Azure Key Vault, no GCP SA, no network at all. mem.mjs itself
// is NOT imported here: its bottom-of-file IIFE calls process.exit() on an unrecognized/empty argv,
// which would kill the test runner process if imported directly -- exactly why mem.mjs delegates its
// pure logic to sibling modules like dedupe.mjs / blobwrite.mjs / this one, and why tests target those
// modules instead of mem.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { normRelation, linkFields, formatEdge, walkGraph } from "../entity-graph.mjs";

// ---- normRelation ----

test("normRelation collapses casing and punctuation like mem.mjs's normKey", () => {
  assert.equal(normRelation("Depends On"), "depends_on");
  assert.equal(normRelation("depends-on"), "depends_on");
  assert.equal(normRelation("  depends_on  "), "depends_on");
  assert.equal(normRelation("BLOCKS"), "blocks");
  assert.equal(normRelation(""), "");
  assert.equal(normRelation(undefined), "");
});

// ---- linkFields ----

test("linkFields builds the entity_link row content fields, relation normalized", () => {
  const f = linkFields("iheartest", "Depends On", "posthog_project_468379");
  assert.equal(f.type, "entity_link");
  assert.equal(f.ekey, "iheartest");
  assert.equal(f.relation, "depends_on");
  assert.equal(f.evalue, "posthog_project_468379");
  assert.equal(f.text, "iheartest -> depends_on -> posthog_project_468379");
});

test("linkFields never mutates or resolves its inputs (that is the caller's job via resolveAlias)", () => {
  // Passing already-weird-cased keys through unchanged proves this function does not silently
  // re-normalize the endpoint keys -- only the relation. Endpoint normalization is resolveAlias's job
  // in mem.mjs, called BEFORE linkFields (exactly like `entity set` resolves its key before writing).
  const f = linkFields("Not_Normalized_Key", "blocks", "Another Raw Key");
  assert.equal(f.ekey, "Not_Normalized_Key");
  assert.equal(f.evalue, "Another Raw Key");
});

// ---- formatEdge ----

test("formatEdge renders '<from-key> -> <relation> -> <to-key>'", () => {
  assert.equal(formatEdge({ from: "a", relation: "depends_on", to: "b" }), "a -> depends_on -> b");
});

// ---- walkGraph ----

// Small helper: build a fixture entity_link row the way mem.mjs's commitAppend would (id/ts + the
// linkFields content), so fixtures look like real ledger rows.
let seq = 0;
function linkRow(from, relation, to) {
  seq += 1;
  return { id: `20260101-${String(seq).padStart(3, "0")}-fx`, ts: `2026-01-01T00:00:0${seq}Z`, by: "cto", tags: [], ...linkFields(from, relation, to) };
}

test("1-hop outgoing edge: X depends_on Y is found by walking from X", () => {
  const rows = [linkRow("iheartest", "depends_on", "posthog_468379")];
  const g = walkGraph(rows, "iheartest", { hops: 1 });
  assert.equal(g.edges.length, 1);
  assert.deepEqual(g.edges[0], { from: "iheartest", relation: "depends_on", to: "posthog_468379", depth: 1 });
  assert.deepEqual(new Set(g.nodes), new Set(["iheartest", "posthog_468379"]));
});

test("1-hop incoming edge: 'what depends on X' -- querying the TARGET finds the SOURCE", () => {
  // This is the flagship scenario from the goal: A depends on X. Asking the graph for X (not A) must
  // still surface the edge, because the caller does not know A in advance.
  const rows = [linkRow("flatstick_api", "depends_on", "neon_postgres")];
  const g = walkGraph(rows, "neon_postgres", { hops: 1 });
  assert.equal(g.edges.length, 1);
  assert.deepEqual(g.edges[0], { from: "flatstick_api", relation: "depends_on", to: "neon_postgres", depth: 1 });
  assert.ok(g.nodes.includes("flatstick_api"), "the dependent node is reachable from the dependency");
});

test("2-hop transitive walk: A -> B -> C is reachable from A at hops=2", () => {
  const rows = [linkRow("a", "depends_on", "b"), linkRow("b", "depends_on", "c")];
  const g = walkGraph(rows, "a", { hops: 2 });
  const seen = g.edges.map((e) => `${e.from}>${e.to}`).sort();
  assert.deepEqual(seen, ["a>b", "b>c"]);
  assert.deepEqual(new Set(g.nodes), new Set(["a", "b", "c"]));
  // depth is recorded relative to the start, so a caller can render hop-1 vs hop-2 separately.
  assert.equal(g.edges.find((e) => e.to === "b").depth, 1);
  assert.equal(g.edges.find((e) => e.to === "c").depth, 2);
});

test("hops=1 does not walk past the immediate neighborhood", () => {
  const rows = [linkRow("a", "depends_on", "b"), linkRow("b", "depends_on", "c")];
  const g = walkGraph(rows, "a", { hops: 1 });
  assert.equal(g.edges.length, 1);
  assert.equal(g.edges[0].to, "b");
  assert.ok(!g.nodes.includes("c"), "c is 2 hops away and must not appear at hops=1");
});

test("hops is clamped to the 1-2 contract even if a caller asks for more", () => {
  const rows = [linkRow("a", "depends_on", "b"), linkRow("b", "depends_on", "c"), linkRow("c", "depends_on", "d")];
  const g = walkGraph(rows, "a", { hops: 99 });
  assert.equal(g.hops, 2);
  assert.ok(!g.nodes.includes("d"), "d is 3 hops away; the walk is capped at 2 no matter what was requested");
});

test("a mutual cycle (A <-> B) terminates and does not duplicate the edge", () => {
  const rows = [linkRow("a", "depends_on", "b"), linkRow("b", "depends_on", "a")];
  const g = walkGraph(rows, "a", { hops: 2 });
  assert.equal(g.edges.length, 2, "both distinct rows are real edges, but neither is double-counted");
  const seen = new Set(g.edges.map((e) => `${e.from} ${e.relation} ${e.to}`));
  assert.equal(seen.size, 2);
});

test("a self-referential edge does not infinite-loop", () => {
  const rows = [linkRow("a", "depends_on", "a")];
  const g = walkGraph(rows, "a", { hops: 2 });
  assert.equal(g.edges.length, 1);
  assert.deepEqual(g.nodes, ["a"]);
});

test("a diamond (A->B, A->C, B->D, C->D) reaches D once via each parent, no duplicate D edges", () => {
  const rows = [linkRow("a", "depends_on", "b"), linkRow("a", "depends_on", "c"), linkRow("b", "depends_on", "d"), linkRow("c", "depends_on", "d")];
  const g = walkGraph(rows, "a", { hops: 2 });
  assert.equal(g.edges.length, 4, "all four distinct physical edges are present, none dropped, none duplicated");
  const toD = g.edges.filter((e) => e.to === "d");
  assert.equal(toD.length, 2, "two distinct edges land on d (from b and from c)");
});

test("a missing/unknown start key returns an empty, non-throwing result", () => {
  const rows = [linkRow("a", "depends_on", "b")];
  const g = walkGraph(rows, "nonexistent_key", { hops: 2 });
  assert.deepEqual(g.edges, []);
  assert.deepEqual(g.nodes, ["nonexistent_key"]);
});

test("an empty or absent key returns an empty result without throwing", () => {
  const rows = [linkRow("a", "depends_on", "b")];
  assert.deepEqual(walkGraph(rows, "").edges, []);
  assert.deepEqual(walkGraph(rows, null).edges, []);
  assert.deepEqual(walkGraph(rows, undefined).edges, []);
});

test("an empty or missing rows array is handled without throwing", () => {
  assert.deepEqual(walkGraph([], "a").edges, []);
  assert.deepEqual(walkGraph(null, "a").edges, []);
  assert.deepEqual(walkGraph(undefined, "a").edges, []);
});

test("non-entity_link rows in the ledger (facts, entities, status, aliases) are ignored", () => {
  const rows = [
    { id: "1", ts: "2026-01-01T00:00:00Z", type: "fact", text: "the sky is blue", ekey: "a", evalue: "b" }, // decoy: has ekey/evalue but wrong type
    { id: "2", ts: "2026-01-01T00:00:00Z", type: "entity", ekey: "a", evalue: "some current value" },
    { id: "3", ts: "2026-01-01T00:00:00Z", type: "alias", ekey: "a", evalue: "b" },
    { id: "4", ts: "2026-01-01T00:00:00Z", type: "status", text: "working on it" },
    linkRow("a", "depends_on", "b"),
  ];
  const g = walkGraph(rows, "a", { hops: 2 });
  assert.equal(g.edges.length, 1, "only the real entity_link row produces an edge");
  assert.equal(g.edges[0].relation, "depends_on");
});

test("malformed entity_link rows (missing ekey/relation/evalue) are skipped, not thrown on", () => {
  const rows = [
    { id: "1", ts: "2026-01-01T00:00:00Z", type: "entity_link", ekey: "a", relation: "depends_on" }, // no evalue
    { id: "2", ts: "2026-01-01T00:00:00Z", type: "entity_link", relation: "depends_on", evalue: "b" }, // no ekey
    { id: "3", ts: "2026-01-01T00:00:00Z", type: "entity_link", ekey: "a", evalue: "b" }, // no relation
    linkRow("a", "depends_on", "b"),
  ];
  const g = walkGraph(rows, "a", { hops: 1 });
  assert.equal(g.edges.length, 1, "only the well-formed row produces an edge");
});
