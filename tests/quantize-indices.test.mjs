// Tests for skills/doc-indexer/quantize-indices.mjs (the fp32 -> disk-optimized/quantized k-NN
// index migration tool, FND-20260829-f7fa). Two layers, matching this repo's own established
// convention (see skills/safety-monitor/monitor.mjs's runSweep(opts) + tests/monitor-sweep.test.mjs):
//
//   1. PURE FUNCTION tests: mapping transform, deep-equal, overlap %, disk-safety math, settings
//      sanitization, table rendering, argument parsing. No I/O, no fakes needed.
//   2. ORCHESTRATION tests against a tiny in-memory FAKE OpenSearch cluster (`makeFakeCluster()`
//      below) and a fake S3-backed state store (`makeFakeStateStore()`) -- dependency-injected in
//      exactly the shape `makeClient()`/`makeStateStore()` produce for the real thing, so
//      runPlan/runMigrateOne/runMigrateAll/runRollback exercise their REAL control flow (the state
//      machine, the swap gating, the resumability, the safety refusals) with no network, no AWS
//      credentials, and no chance of ever touching the real domain.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as Q from "../skills/doc-indexer/quantize-indices.mjs";

// ================================================================================================
// Fake cluster + fake state store
// ================================================================================================

function l2dist(a, b) {
  const n = Math.max(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) { const d = (a[i] || 0) - (b[i] || 0); s += d * d; }
  return s;
}

/**
 * A minimal, deterministic, in-memory stand-in for the real OpenSearch data plane, implementing
 * exactly the shape makeClient() produces. Real enough to exercise create/delete/reindex/verify end
 * to end: reindex actually copies `_source` by `_id` (so re-running it is idempotent, matching the
 * real API's overwrite-by-_id behavior this tool's resumability depends on), mget returns real
 * found/not-found docs, and a kNN query ranks by real (squared L2) distance over whatever field the
 * query names, so an intentionally-corrupted twin genuinely produces a low overlap score rather than
 * a hand-set boolean.
 */
function makeFakeCluster(initial = {}) {
  const indices = new Map();
  for (const [name, def] of Object.entries(initial)) {
    indices.set(name, {
      settings: structuredClone(def.settings || {}),
      properties: structuredClone(def.properties || {}),
      docs: new Map(Object.entries(def.docs || {}).map(([id, src]) => [id, structuredClone(src)])),
    });
  }
  let taskSeq = 0;
  const tasks = new Map();
  const calls = []; // {method, args} audit trail -- the counterfactual/spy tests read this
  let freeBytes = 10_000_000_000; // 10GB "free disk" by default -- plenty for small test fixtures
  let reindexHook = null; // (sourceName, destName) => number of docs to actually copy (undefined = all)

  const client = {
    async getIndex(index) {
      calls.push({ method: "getIndex", args: [index] });
      const idx = indices.get(index);
      if (!idx) return { status: 404, ok: false, json: null };
      return { status: 200, ok: true, json: { [index]: { settings: { index: idx.settings }, mappings: { properties: idx.properties } } } };
    },
    async createIndex(index, body) {
      calls.push({ method: "createIndex", args: [index] });
      if (indices.has(index)) return { status: 400, ok: false, json: { error: { type: "resource_already_exists_exception" } } };
      indices.set(index, { settings: structuredClone(body.settings?.index || {}), properties: structuredClone(body.mappings?.properties || {}), docs: new Map() });
      return { status: 200, ok: true, json: { acknowledged: true } };
    },
    async deleteIndex(index) {
      calls.push({ method: "deleteIndex", args: [index] });
      if (!indices.has(index)) return { status: 404, ok: false, json: null };
      indices.delete(index);
      return { status: 200, ok: true, json: { acknowledged: true } };
    },
    async reindexStart({ source, dest }) {
      calls.push({ method: "reindexStart", args: [source.index, dest.index] });
      const s = indices.get(source.index), d = indices.get(dest.index);
      if (!s || !d) return { status: 400, ok: false, json: { error: { reason: "index not found" } } };
      const taskId = `fakeNode:${++taskSeq}`;
      const limit = typeof reindexHook === "function" ? reindexHook(source.index, dest.index) : Infinity;
      let copied = 0;
      for (const [id, src] of s.docs) {
        if (copied >= limit) break;
        d.docs.set(id, structuredClone(src));
        copied++;
      }
      tasks.set(taskId, { completed: true, response: { failures: [] } });
      return { status: 200, ok: true, json: { task: taskId } };
    },
    async getTask(taskId) {
      calls.push({ method: "getTask", args: [taskId] });
      const t = tasks.get(taskId);
      if (!t) return { status: 404, ok: false, json: null };
      return { status: 200, ok: true, json: t };
    },
    async catIndices() {
      calls.push({ method: "catIndices", args: [] });
      return {
        status: 200, ok: true,
        json: [...indices.entries()].map(([index, idx]) => ({ index, "docs.count": String(idx.docs.size), "store.size": String(idx.docs.size * 1000 + 1) })),
      };
    },
    async catAllocation() {
      calls.push({ method: "catAllocation", args: [] });
      return { status: 200, ok: true, json: [{ node: "node1", "disk.avail": String(freeBytes) }, { node: null, "disk.avail": "999999999999" }] };
    },
    async mget(index, ids) {
      calls.push({ method: "mget", args: [index, ids] });
      const idx = indices.get(index);
      const docs = ids.map((id) => (idx && idx.docs.has(id) ? { _id: id, found: true, _source: idx.docs.get(id) } : { _id: id, found: false }));
      return { status: 200, ok: true, json: { docs } };
    },
    async search(index, body) {
      calls.push({ method: "search", args: [index, body] });
      const idx = indices.get(index);
      if (!idx) return { status: 404, ok: false, json: null };
      const size = body.size ?? 10;
      let ids = [...idx.docs.keys()];
      if (body.query?.knn) {
        const [field, spec] = Object.entries(body.query.knn)[0];
        ids = ids
          .map((id) => ({ id, dist: l2dist(idx.docs.get(id)[field] || [], spec.vector) }))
          .sort((a, b) => a.dist - b.dist)
          .map((x) => x.id);
      } else {
        ids = ids.sort();
      }
      return { status: 200, ok: true, json: { hits: { hits: ids.slice(0, size).map((id) => ({ _id: id })) } } };
    },
    async count(index) {
      calls.push({ method: "count", args: [index] });
      const idx = indices.get(index);
      return { status: 200, ok: true, count: idx ? idx.docs.size : 0 };
    },
  };

  return {
    client,
    indices,
    calls,
    setFreeBytes: (n) => { freeBytes = n; },
    setReindexHook: (fn) => { reindexHook = fn; },
    snapshot: (index) => (indices.has(index) ? structuredClone({ properties: indices.get(index).properties, docs: Object.fromEntries(indices.get(index).docs) }) : null),
  };
}

function makeFakeStateStore() {
  const store = new Map();
  return {
    async get(index) { return store.has(index) ? structuredClone(store.get(index)) : null; },
    async put(index, state) { store.set(index, structuredClone(state)); },
    async list() { return [...store.keys()]; },
    _raw: store,
  };
}

/** A realistic pre-quantization flat-room field, matching skills/kb-memory/opensearch-write.mjs's
 *  memoryIndexMapping() exactly (dimension/method/engine/space_type) so tests exercise the tool
 *  against the ACTUAL live shape, not a simplified stand-in. */
function fp32Field(dimension = 4) {
  return { type: "knn_vector", dimension, method: { name: "hnsw", engine: "nmslib", space_type: "cosinesimil" } };
}

const noopLog = () => {};

// ================================================================================================
// 1. Pure function tests
// ================================================================================================

test("buildQuantizedField: transforms a live fp32 field into the on_disk shape, preserving dimension + space_type, dropping method/engine", () => {
  const out = Q.buildQuantizedField(fp32Field(3072), "32x");
  assert.deepEqual(out, { type: "knn_vector", dimension: 3072, data_type: "float", space_type: "cosinesimil", mode: "on_disk", compression_level: "32x" });
});

test("buildQuantizedField: honors a top-level space_type over method.space_type when both are present", () => {
  const field = { type: "knn_vector", dimension: 8, space_type: "l2", method: { name: "hnsw", engine: "faiss", space_type: "cosinesimil" } };
  assert.equal(Q.buildQuantizedField(field).space_type, "l2");
});

test("buildQuantizedField: refuses a missing dimension", () => {
  assert.throws(() => Q.buildQuantizedField({ type: "knn_vector", method: { space_type: "cosinesimil" } }), /dimension/i);
});

test("buildQuantizedField: refuses a non-positive-integer dimension", () => {
  assert.throws(() => Q.buildQuantizedField({ type: "knn_vector", dimension: 0, method: { space_type: "cosinesimil" } }), /dimension/i);
  assert.throws(() => Q.buildQuantizedField({ type: "knn_vector", dimension: 3.5, method: { space_type: "cosinesimil" } }), /dimension/i);
});

test("buildQuantizedField: refuses a missing space_type rather than guessing one", () => {
  assert.throws(() => Q.buildQuantizedField({ type: "knn_vector", dimension: 8 }), /space_type/i);
});

test("buildQuantizedField: refuses a field that is already on_disk", () => {
  assert.throws(() => Q.buildQuantizedField({ type: "knn_vector", dimension: 8, space_type: "l2", mode: "on_disk" }), /already/i);
});

test("buildQuantizedField: refuses an invalid compression level", () => {
  assert.throws(() => Q.buildQuantizedField(fp32Field(), "64x"), /compression level/i);
});

test("buildQuantizedField: defaults to 32x when no level is given", () => {
  assert.equal(Q.buildQuantizedField(fp32Field()).compression_level, "32x");
});

test("validateCompressionLevel: accepts every documented value, rejects anything else", () => {
  for (const v of ["1x", "2x", "4x", "8x", "16x", "32x"]) assert.equal(Q.validateCompressionLevel(v), v);
  assert.throws(() => Q.validateCompressionLevel("32X"));
  assert.throws(() => Q.validateCompressionLevel(""));
  assert.throws(() => Q.validateCompressionLevel(undefined));
});

test("findVectorField: finds the single knn_vector field by introspection, whatever it is named", () => {
  assert.deepEqual(Q.findVectorField({ id: { type: "keyword" }, text_vector: fp32Field() }), { field: "text_vector", def: fp32Field() });
  assert.deepEqual(Q.findVectorField({ contentVector: fp32Field() }).field, "contentVector");
});

test("findVectorField: returns null (not an error) for a room with no vector field", () => {
  assert.equal(Q.findVectorField({ id: { type: "keyword" } }), null);
  assert.equal(Q.findVectorField({}), null);
  assert.equal(Q.findVectorField(null), null);
});

test("findVectorField: THROWS on more than one knn_vector field rather than guessing", () => {
  assert.throws(() => Q.findVectorField({ contentVector: fp32Field(), text_vector: fp32Field() }), /2 knn_vector fields/);
});

test("extractSpaceType: reads top-level first, falls back to method.space_type, else null", () => {
  assert.equal(Q.extractSpaceType({ space_type: "l2", method: { space_type: "cosinesimil" } }), "l2");
  assert.equal(Q.extractSpaceType({ method: { space_type: "cosinesimil" } }), "cosinesimil");
  assert.equal(Q.extractSpaceType({}), null);
  assert.equal(Q.extractSpaceType(null), null);
});

test("isOnDiskMode / isPrivilegedRoom / isSystemIndex / isTwinIndex: basic classification", () => {
  assert.equal(Q.isOnDiskMode({ mode: "on_disk" }), true);
  assert.equal(Q.isOnDiskMode({ mode: "in_memory" }), false);
  assert.equal(Q.isOnDiskMode({}), false);
  assert.equal(Q.isPrivilegedRoom("finance-cfo-source-docs"), true);
  assert.equal(Q.isPrivilegedRoom("legal-company"), true, "legal-company is EXEC_RING-gated in the real gateway even though it does not match the task brief's literal 'legal-personal*' shorthand");
  assert.equal(Q.isPrivilegedRoom("finance-otchealth-cfo-source-docs"), true);
  assert.equal(Q.isPrivilegedRoom("legal-personal-memory"), true);
  assert.equal(Q.isPrivilegedRoom("memory-exec"), false);
  assert.equal(Q.isPrivilegedRoom("commons-coo-memory"), false, "per-agent commons memory rooms are NOT in the gateway's EXEC_RING/PERSONAL_LEGAL_RING");
  assert.equal(Q.isSystemIndex(".kibana"), true);
  assert.equal(Q.isSystemIndex("memory-exec"), false);
  assert.equal(Q.isTwinIndex("memory-exec--q"), true);
  assert.equal(Q.isTwinIndex("memory-exec"), false);
  assert.equal(Q.twinName("memory-exec"), "memory-exec--q");
});

test("sanitizeIndexSettings: strips server-assigned keys (including nested/dotted) and forces knn:true", () => {
  const dirty = {
    knn: false,
    uuid: "abc123",
    creation_date: "1234567890",
    provided_name: "memory-exec",
    version: { created: "136000000" },
    number_of_shards: "1",
    number_of_replicas: "1",
    blocks: { write: true },
  };
  const clean = Q.sanitizeIndexSettings(dirty);
  assert.equal(clean.knn, true, "knn:true must be forced even if the source somehow had it false");
  assert.equal(clean.uuid, undefined);
  assert.equal(clean.creation_date, undefined);
  assert.equal(clean.provided_name, undefined);
  assert.equal(clean.version, undefined);
  assert.equal(clean.blocks, undefined);
  assert.equal(clean.number_of_shards, "1", "a legitimate, portable setting must survive sanitization");
  assert.equal(clean.number_of_replicas, "1");
});

test("sanitizeIndexSettings: preserves a custom nested setting untouched (e.g. a custom analysis block)", () => {
  const clean = Q.sanitizeIndexSettings({ knn: true, analysis: { analyzer: { custom1: { type: "standard" } } } });
  assert.deepEqual(clean.analysis, { analyzer: { custom1: { type: "standard" } } });
});

test("sanitizeIndexSettings: tolerates a missing/empty input without throwing", () => {
  assert.deepEqual(Q.sanitizeIndexSettings(undefined), { knn: true });
  assert.deepEqual(Q.sanitizeIndexSettings({}), { knn: true });
});

test("buildTwinIndexBody: preserves every OTHER mapping field untouched, replaces only the vector field", () => {
  const sourceBody = {
    settings: { index: { knn: true, uuid: "should-be-stripped" } },
    mappings: { properties: { id: { type: "keyword" }, text: { type: "text" }, contentVector: fp32Field(3072) } },
  };
  const body = Q.buildTwinIndexBody(sourceBody, "contentVector", fp32Field(3072), "16x");
  assert.deepEqual(body.mappings.properties.id, { type: "keyword" });
  assert.deepEqual(body.mappings.properties.text, { type: "text" });
  assert.equal(body.mappings.properties.contentVector.mode, "on_disk");
  assert.equal(body.mappings.properties.contentVector.compression_level, "16x");
  assert.equal(body.settings.index.uuid, undefined);
  assert.equal(body.settings.index.knn, true);
});

test("deepEqual: order-insensitive for object keys, order-sensitive for arrays", () => {
  assert.equal(Q.deepEqual({ a: 1, b: 2 }, { b: 2, a: 1 }), true);
  assert.equal(Q.deepEqual([1, 2, 3], [1, 2, 3]), true);
  assert.equal(Q.deepEqual([1, 2, 3], [3, 2, 1]), false, "array element order matters -- a vector's element order is meaningful");
  assert.equal(Q.deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }), true);
  assert.equal(Q.deepEqual({ a: 1 }, { a: 1, b: 2 }), false, "extra key must be a mismatch");
  assert.equal(Q.deepEqual(null, {}), false);
  assert.equal(Q.deepEqual(1, "1"), false);
  assert.equal(Q.deepEqual(NaN, NaN), true);
});

test("deepEqual: a real embedding-shaped vector array compares correctly", () => {
  const a = { contentVector: [0.1, -0.2, 0.30000001, 3072e-4] };
  const b = { contentVector: [0.1, -0.2, 0.30000001, 3072e-4] };
  const c = { contentVector: [0.1, -0.2, 0.3, 3072e-4] };
  assert.equal(Q.deepEqual(a, b), true);
  assert.equal(Q.deepEqual(a, c), false);
});

test("computeOverlapPct: full, none, partial, and vacuous-empty overlap", () => {
  assert.equal(Q.computeOverlapPct(["a", "b", "c"], ["a", "b", "c"], 3), 100);
  assert.equal(Q.computeOverlapPct(["a", "b", "c"], ["x", "y", "z"], 3), 0);
  assert.equal(Q.computeOverlapPct(["a", "b"], ["b", "c"], 2), 50);
  assert.equal(Q.computeOverlapPct([], [], 10), 100, "an empty index has nothing to disagree about");
  assert.equal(Q.computeOverlapPct(["a"], [], 10), 0, "one side returning real neighbors while the other returns none at all is a genuine 0, not a vacuous pass");
});

test("computeOverlapPct: a corpus smaller than the requested k is judged against what it COULD return, not the raw k -- a perfectly-matching 5-hit result on a 5-document room must not read as a 50% failure", () => {
  const fiveHits = ["0", "1", "2", "3", "4"];
  assert.equal(Q.computeOverlapPct(fiveHits, fiveHits, 10), 100, "identical small result sets must score 100%, not 50%, when k=10 exceeds the corpus size");
  assert.equal(Q.computeOverlapPct(fiveHits, ["9", "8", "7", "6", "5"], 10), 0, "a genuinely disjoint small result set must still score 0%, not be diluted by the unreachable k");
});

test("diskSafetyCheck / sumAvailableBytes: the 2x-free-space rule, and unassigned-shard rows are never counted as node capacity", () => {
  const rows = [{ node: "n1", "disk.avail": "1000" }, { node: "n2", "disk.avail": "1000" }, { node: null, "disk.avail": "999999" }];
  assert.equal(Q.sumAvailableBytes(rows), 2000, "the null-node row must be excluded");
  assert.deepEqual(Q.diskSafetyCheck(2000, 1000), { ok: true, reason: null });
  assert.equal(Q.diskSafetyCheck(1999, 1000).ok, false);
  assert.equal(Q.diskSafetyCheck(2000, null).ok, false, "an undiscoverable index size must refuse, not default to 0");
  assert.equal(Q.diskSafetyCheck(NaN, 1000).ok, false);
});

test("formatBytes: human-readable sizes", () => {
  assert.equal(Q.formatBytes(0), "0.0B");
  assert.equal(Q.formatBytes(1024), "1.00KB");
  assert.equal(Q.formatBytes(13_000_000_000).endsWith("GB"), true);
  assert.equal(Q.formatBytes(NaN), "?");
});

test("classifyRow: already-quantized, needs-migration, privileged, no-vector-field, system, twin, and anomaly labels", () => {
  assert.equal(Q.classifyRow({ index: ".kibana", mappingProps: {} }).status, "SYSTEM");
  assert.equal(Q.classifyRow({ index: "memory-exec--q", mappingProps: {} }).status, "TWIN_SCRATCH");
  assert.equal(Q.classifyRow({ index: "memory-exec", mappingProps: {} }).status, "NO_VECTOR_FIELD");
  assert.equal(Q.classifyRow({ index: "memory-exec", mappingProps: { contentVector: fp32Field() } }).status, "NEEDS_MIGRATION");
  assert.equal(Q.classifyRow({ index: "finance-cfo-source-docs", mappingProps: { text_vector: fp32Field() } }).status, "PRIVILEGED NEEDS_MIGRATION");
  assert.match(Q.classifyRow({ index: "memory-exec", mappingProps: { contentVector: { type: "knn_vector", dimension: 8, space_type: "l2", mode: "on_disk", compression_level: "32x" } } }).status, /ALREADY_QUANTIZED/);
  assert.match(Q.classifyRow({ index: "memory-exec", mappingProps: { contentVector: fp32Field(), text_vector: fp32Field() } }).status, /ANOMALY/);
  assert.match(Q.classifyRow({ index: "memory-exec", mappingProps: { contentVector: fp32Field() }, statePhase: "reindexing" }).status, /IN_PROGRESS\(reindexing\)/);
  assert.match(Q.classifyRow({ index: "memory-exec", mappingProps: { contentVector: fp32Field() }, statePhase: "failed" }).status, /FAILED/);
});

test("renderPlanTable: aligned columns, headers present, one row per index", () => {
  const rows = [
    { index: "memory-exec", docsCount: 100, storeSizeBytes: 2048, vectorField: "contentVector", dimension: 3072, spaceType: "cosinesimil", status: "NEEDS_MIGRATION" },
    { index: ".kibana", docsCount: 1, storeSizeBytes: 10, vectorField: null, dimension: null, status: "SYSTEM" },
  ];
  const table = Q.renderPlanTable(rows);
  assert.match(table, /INDEX/);
  assert.match(table, /STATUS/);
  assert.match(table, /memory-exec/);
  assert.match(table, /NEEDS_MIGRATION/);
  assert.equal(table.split("\n").length, 2 + rows.length, "header + separator + one line per row");
});

test("parseArgs: valid plan/migrate/rollback invocations, and defaults", () => {
  assert.equal(Q.parseArgs(["plan"]).errors.length, 0);
  const m = Q.parseArgs(["migrate", "--index", "memory-exec"]);
  assert.equal(m.errors.length, 0);
  assert.equal(m.compression, "32x");
  assert.equal(m.minOverlapPct, 90);
  assert.equal(m.commit, false);
  assert.equal(Q.parseArgs(["migrate", "--all", "--commit"]).errors.length, 0);
  assert.equal(Q.parseArgs(["rollback", "--index", "memory-exec"]).errors.length, 0);
});

test("parseArgs: rejects the invalid combinations and values a live run must never be allowed to reach", () => {
  assert.ok(Q.parseArgs(["migrate"]).errors.length > 0, "migrate needs --index or --all");
  assert.ok(Q.parseArgs(["migrate", "--index", "x", "--all"]).errors.length > 0, "not both");
  assert.ok(Q.parseArgs(["migrate", "--index", "x", "--compression", "64x"]).errors.length > 0);
  assert.ok(Q.parseArgs(["migrate", "--index", "x", "--min-overlap-pct", "150"]).errors.length > 0);
  assert.ok(Q.parseArgs(["migrate", "--index", "x", "--min-overlap-pct", "nope"]).errors.length > 0);
  assert.ok(Q.parseArgs(["rollback"]).errors.length > 0, "rollback needs --index");
  assert.ok(Q.parseArgs(["frobnicate"]).errors.length > 0);
  assert.ok(Q.parseArgs(["plan", "--nonsense"]).errors.length > 0);
});

// ================================================================================================
// 2. verifyParity / reindexUntilCountsConverge / pollTaskToCompletion (surgical, small fakes)
// ================================================================================================

test("verifyParity: an empty source index is a vacuous pass (nothing to sample or probe)", async () => {
  const { client } = makeFakeCluster({ a: {}, b: {} });
  const v = await Q.verifyParity(client, { sourceIndex: "a", destIndex: "b", vectorField: "contentVector" });
  assert.equal(v.ok, true);
  assert.equal(v.sampleChecked, 0);
});

test("verifyParity: a doc missing on the destination is reported and fails", async () => {
  const { client } = makeFakeCluster({ a: { docs: { "1": { contentVector: [1, 0] } } }, b: {} });
  const v = await Q.verifyParity(client, { sourceIndex: "a", destIndex: "b", vectorField: "contentVector" });
  assert.equal(v.ok, false);
  assert.match(v.reason, /found on source=true dest=false/);
});

test("verifyParity: a _source mismatch on a NON-vector field (e.g. a corrupted text value) is caught even though doc counts match", async () => {
  const { client, indices } = makeFakeCluster({
    a: { docs: { "1": { text: "hello", contentVector: [1, 0, 0, 0] } } },
    b: { docs: { "1": { text: "hello", contentVector: [1, 0, 0, 0] } } },
  });
  indices.get("b").docs.set("1", { text: "corrupted", contentVector: [1, 0, 0, 0] }); // simulate corruption
  const v = await Q.verifyParity(client, { sourceIndex: "a", destIndex: "b", vectorField: "contentVector" });
  assert.equal(v.ok, false);
  assert.match(v.reason, /_source differs/);
});

// 2026-09-02 live finding (commons-cco-memory on otchealth-brain 3.7): the twin is created with
// index.knn.derived_source.enabled=true, so its `_source` vector is RECONSTRUCTED from the quantized
// on-disk graph and is never byte-identical to the fp32 original. Every sampled doc failed as
// "_source differs" while every non-vector field matched. The vector field is therefore excluded from
// the _source parity check; vector fidelity is measured by the kNN top-k overlap probe instead.
test("verifyParity: a derived (quantized) vector that differs from the fp32 source does NOT fail _source parity when every other field matches", async () => {
  const { client } = makeFakeCluster({
    a: { docs: { "1": { text: "hello", contentVector: [1, 0, 0, 0] } } },
    b: { docs: { "1": { text: "hello", contentVector: [0.99, 0.01, 0, 0] } } },
  });
  const v = await Q.verifyParity(client, { sourceIndex: "a", destIndex: "b", vectorField: "contentVector" });
  assert.equal(v.ok, true, v.reason);
  assert.equal(v.mismatches.length, 0);
  assert.deepEqual(Q.sourceWithoutVector({ text: "t", contentVector: [1] }, "contentVector"), { text: "t" });
  assert.equal(Q.sourceWithoutVector(null, "contentVector"), null);
});

test("verifyParity: kNN overlap below the threshold fails with the overlap % reported (isolated from the doc-parity check)", async () => {
  // 30 docs on a line, zero-padded ids so string-sort (the fake cluster's match_all order) equals
  // numeric order. Ids "00".."11" (the first 12 -- exactly what sampleSize:12 samples) are BYTE
  // IDENTICAL between 'a' and 'b', so the _source-parity half of verifyParity passes cleanly and
  // this test genuinely isolates the kNN-overlap half. Ids "20".."22" exist ONLY in 'b', placed
  // closer to the probe (doc "00", vector [0]) than most of 'a's real top-10 neighbors, which
  // demonstrably displaces them from 'b's top-10 -- a REAL divergence from a REAL kNN query, not a
  // hand-set boolean.
  const docsA = {}, docsB = {};
  for (let i = 0; i < 30; i++) { const id = String(i).padStart(2, "0"); docsA[id] = { v: [i] }; docsB[id] = { v: i <= 11 ? [i] : [1000 + i] }; }
  docsB["20"] = { v: [0.1] };
  docsB["21"] = { v: [0.2] };
  docsB["22"] = { v: [0.3] };
  const { client } = makeFakeCluster({ a: { docs: docsA }, b: { docs: docsB } });

  const v = await Q.verifyParity(client, { sourceIndex: "a", destIndex: "b", vectorField: "v", minOverlapPct: 90, sampleSize: 12, k: 10 });
  assert.equal(v.mismatches.length, 0, "the sampled docs (00-11) must be identical between a and b -- this test isolates the overlap check");
  assert.equal(v.ok, false);
  assert.match(v.reason, /overlap/i);
  assert.equal(v.overlapPct, 70, "top-10 from probe doc '00': a={00..09}, b={00,20,21,22,01..06} -> 7/10 shared");
});

test("verifyParity: identical indexes pass with 100% overlap", async () => {
  const docs = {};
  for (let i = 0; i < 12; i++) docs[String(i)] = { v: [i, i * 2, i * 3] };
  const { client } = makeFakeCluster({ a: { docs }, b: { docs: structuredClone(docs) } });
  const v = await Q.verifyParity(client, { sourceIndex: "a", destIndex: "b", vectorField: "v", sampleSize: 12, k: 10 });
  assert.equal(v.ok, true);
  assert.equal(v.overlapPct, 100);
});

test("reindexUntilCountsConverge: converges immediately when the reindex copies everything in one pass", async () => {
  const { client } = makeFakeCluster({ a: { docs: { "1": {}, "2": {} } }, b: {} });
  const r = await Q.reindexUntilCountsConverge(client, { source: "a", dest: "b" }, { log: noopLog });
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 1);
  assert.equal(r.dstCount, 2);
});

test("reindexUntilCountsConverge: retries when the source is 'still receiving writes' and converges within the attempt budget", async () => {
  const cluster = makeFakeCluster({ a: { docs: { "1": {}, "2": {}, "3": {} } }, b: {} });
  let call = 0;
  cluster.setReindexHook(() => { call++; return call < 3 ? call : Infinity; }); // 1 doc, then 2, then all
  const r = await Q.reindexUntilCountsConverge(cluster.client, { source: "a", dest: "b" }, { log: noopLog });
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 3);
});

test("reindexUntilCountsConverge: fails loud (does not silently accept a mismatch) when counts never converge", async () => {
  const cluster = makeFakeCluster({ a: { docs: { "1": {}, "2": {}, "3": {} } }, b: {} });
  cluster.setReindexHook(() => 1); // never copies more than 1, however many attempts
  const r = await Q.reindexUntilCountsConverge(cluster.client, { source: "a", dest: "b" }, { log: noopLog, maxAttempts: 2 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /never converged/);
});

test("pollTaskToCompletion: an already-completed task returns immediately", async () => {
  const client = { getTask: async () => ({ status: 200, ok: true, json: { completed: true, response: { failures: [] } } }) };
  const r = await Q.pollTaskToCompletion(client, "n:1", { sleepFn: () => Promise.resolve() });
  assert.equal(r.ok, true);
});

test("pollTaskToCompletion: a completed task carrying per-document failures is reported as a failure, not a success", async () => {
  const client = { getTask: async () => ({ status: 200, ok: true, json: { completed: true, response: { failures: [{ index: "a", id: "1", cause: { reason: "boom" } }] } } }) };
  const r = await Q.pollTaskToCompletion(client, "n:1", { sleepFn: () => Promise.resolve() });
  assert.equal(r.ok, false);
  assert.match(r.reason, /failure/);
});

test("pollTaskToCompletion: a 404 mid-poll is treated as ambiguous/failed, never as silent success", async () => {
  const client = { getTask: async () => ({ status: 404, ok: false, json: null }) };
  const r = await Q.pollTaskToCompletion(client, "n:1", { sleepFn: () => Promise.resolve() });
  assert.equal(r.ok, false);
  assert.match(r.reason, /not found/);
});

test("pollTaskToCompletion: never-completing task fails loud once maxWaitMs elapses (bounded, not an infinite hang)", async () => {
  const client = { getTask: async () => ({ status: 200, ok: true, json: { completed: false, task: { status: {} } } }) };
  const r = await Q.pollTaskToCompletion(client, "n:1", { sleepFn: () => Promise.resolve(), intervalMs: 0, maxWaitMs: 5 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /did not complete/);
});

// ================================================================================================
// 3. runMigrateOne: the full state machine against the fake cluster
// ================================================================================================

function baseFixture() {
  const docs = {};
  for (let i = 0; i < 5; i++) docs[String(i)] = { text: `doc ${i}`, contentVector: [i, i + 1, i + 2, i + 3] };
  return makeFakeCluster({
    "memory-exec": { settings: { knn: true }, properties: { text: { type: "text" }, contentVector: fp32Field(4) }, docs },
  });
}

test("runMigrateOne: dry run (no --commit) creates and verifies the twin but makes ZERO mutating calls against the original index -- the counterfactual", async () => {
  const cluster = baseFixture();
  const stateStore = makeFakeStateStore();
  const before = cluster.snapshot("memory-exec");

  const result = await Q.runMigrateOne("memory-exec", { client: cluster.client, stateStore, log: noopLog });

  assert.equal(result.ok, true);
  assert.equal(result.dryRun, true);
  assert.deepEqual(cluster.snapshot("memory-exec"), before, "the original index's docs/mapping must be byte-identical to before the run");
  assert.ok(cluster.indices.has("memory-exec--q"), "the twin must have been created");
  assert.equal(cluster.indices.get("memory-exec--q").docs.size, 5, "the twin must have been fully reindexed");
  const mutatingOnOriginal = cluster.calls.filter((c) => (c.method === "deleteIndex" || c.method === "createIndex") && c.args[0] === "memory-exec");
  assert.deepEqual(mutatingOnOriginal, [], "no createIndex/deleteIndex call may EVER target the original index name without --commit");
});

test("runMigrateOne: --commit performs the full swap -- original ends up quantized, twin is cleaned up, data preserved", async () => {
  const cluster = baseFixture();
  const stateStore = makeFakeStateStore();

  const result = await Q.runMigrateOne("memory-exec", { client: cluster.client, stateStore, log: noopLog, commit: true });

  assert.equal(result.ok, true, result.reason);
  assert.equal(result.phase, "complete");
  assert.equal(cluster.indices.has("memory-exec--q"), false, "the twin must be deleted once the swap is verified");
  const finalIdx = cluster.indices.get("memory-exec");
  assert.ok(finalIdx, "the original name must still resolve to something");
  assert.equal(finalIdx.properties.contentVector.mode, "on_disk", "the original index must now carry the quantized mapping");
  assert.equal(finalIdx.docs.size, 5, "all documents must have survived the swap");
  assert.deepEqual(finalIdx.docs.get("2"), { text: "doc 2", contentVector: [2, 3, 4, 5] }, "document content must be byte-identical after the round trip");
});

test("runMigrateOne: never deletes the original when verification fails -- the load-bearing safety invariant", async () => {
  const cluster = baseFixture();
  const stateStore = makeFakeStateStore();
  // Force a verification failure by making the twin reindex copy nothing (so counts never converge
  // and the pipeline must stop at reindex/verify, never reaching the swap).
  cluster.setReindexHook((source) => (source === "memory-exec" ? 0 : Infinity));

  const result = await Q.runMigrateOne("memory-exec", { client: cluster.client, stateStore, log: noopLog, commit: true });

  assert.equal(result.ok, false);
  assert.ok(cluster.indices.has("memory-exec"), "the original index must still exist");
  assert.equal(cluster.indices.get("memory-exec").docs.size, 5, "the original's documents must be untouched");
  const deletedOriginal = cluster.calls.some((c) => c.method === "deleteIndex" && c.args[0] === "memory-exec");
  assert.equal(deletedOriginal, false, "deleteIndex must NEVER be called on the original when its twin was never verified");
});

test("runMigrateOne: is resumable -- a state already at 'verified' from a prior run skips straight to the swap without recreating or re-reindexing the twin", async () => {
  const cluster = baseFixture();
  const stateStore = makeFakeStateStore();

  // First pass (dry run) gets us a real, verified twin + a persisted 'verified' state.
  const first = await Q.runMigrateOne("memory-exec", { client: cluster.client, stateStore, log: noopLog });
  assert.equal(first.phase, "verified");
  const callsBeforeResume = cluster.calls.length;

  // "Resume" with --commit: must NOT create the twin again or reindex forward again.
  const second = await Q.runMigrateOne("memory-exec", { client: cluster.client, stateStore, log: noopLog, commit: true });
  assert.equal(second.ok, true, second.reason);

  const callsDuringResume = cluster.calls.slice(callsBeforeResume);
  const forwardReindexCalls = callsDuringResume.filter((c) => c.method === "reindexStart" && c.args[0] === "memory-exec" && c.args[1] === "memory-exec--q");
  const twinCreateCalls = callsDuringResume.filter((c) => c.method === "createIndex" && c.args[0] === "memory-exec--q");
  assert.deepEqual(forwardReindexCalls, [], "resuming from 'verified' must not reindex memory-exec -> twin again");
  assert.deepEqual(twinCreateCalls, [], "resuming from 'verified' must not recreate the twin");
});

test("runMigrateOne: calling it WITHOUT --commit while a prior --commit run left it mid-swap reports the real phase instead of a stale 'ready to swap' message, and mutates nothing", async () => {
  const cluster = baseFixture();
  const stateStore = makeFakeStateStore();
  await Q.runMigrateOne("memory-exec", { client: cluster.client, stateStore, log: noopLog }); // -> verified
  await stateStore.put("memory-exec", Q.withPhase(await stateStore.get("memory-exec"), "swap_reindexing_back")); // simulate a prior --commit run stopped here
  const callsBefore = cluster.calls.length;

  const result = await Q.runMigrateOne("memory-exec", { client: cluster.client, stateStore, log: noopLog }); // no --commit

  assert.equal(result.dryRun, true);
  assert.match(result.message, /already mid-swap or complete \(phase: swap_reindexing_back\)/);
  assert.deepEqual(cluster.calls.slice(callsBefore), [], "a non-committing call must not touch the client AT ALL once state is already mid-swap");
});

test("runMigrateOne: resuming a run that died right after deleting the original (before recreating it) completes cleanly", async () => {
  const cluster = baseFixture();
  const stateStore = makeFakeStateStore();
  // Manually seed a state that reflects 'the process died after deleting the original' -- a REAL
  // prior run would have persisted vector_field back at twin-creation time, well before ever
  // reaching this phase, so a realistic fixture must include it too.
  await stateStore.put("memory-exec", Q.withPhase(Q.initialState({ index: "memory-exec", twin: "memory-exec--q", vectorField: "contentVector" }), "swap_deleted_original"));
  cluster.indices.delete("memory-exec");
  // The twin must already exist and be fully populated + quantized for this to be a realistic resume.
  const seedDocs = Object.fromEntries([0, 1, 2, 3, 4].map((i) => [String(i), { text: `doc ${i}`, contentVector: [i, i + 1, i + 2, i + 3] }]));
  await cluster.client.createIndex("memory-exec--q", { settings: { index: { knn: true } }, mappings: { properties: { text: { type: "text" }, contentVector: Q.buildQuantizedField(fp32Field(4)) } } });
  for (const [id, src] of Object.entries(seedDocs)) cluster.indices.get("memory-exec--q").docs.set(id, src);

  const result = await Q.runMigrateOne("memory-exec", { client: cluster.client, stateStore, log: noopLog, commit: true });

  assert.equal(result.ok, true, result.reason);
  assert.equal(cluster.indices.has("memory-exec--q"), false);
  assert.equal(cluster.indices.get("memory-exec").docs.size, 5);
});

test("runMigrateOne: an existing, correctly-shaped twin from a previous attempt is reused rather than recreated", async () => {
  const cluster = baseFixture();
  const stateStore = makeFakeStateStore();
  await cluster.client.createIndex("memory-exec--q", { settings: { index: { knn: true } }, mappings: { properties: { text: { type: "text" }, contentVector: Q.buildQuantizedField(fp32Field(4)) } } });
  const callsAfterSetup = cluster.calls.length;

  const result = await Q.runMigrateOne("memory-exec", { client: cluster.client, stateStore, log: noopLog });
  assert.equal(result.ok, true, result.reason);
  const createTwinCalls = cluster.calls.slice(callsAfterSetup).filter((c) => c.method === "createIndex" && c.args[0] === "memory-exec--q");
  assert.equal(createTwinCalls.length, 0, "an already-existing, already-quantized twin must not be re-created");
});

test("runMigrateOne: refuses to reindex into a twin that exists but is NOT the expected quantized shape", async () => {
  const cluster = baseFixture();
  const stateStore = makeFakeStateStore();
  await cluster.client.createIndex("memory-exec--q", { settings: { index: { knn: true } }, mappings: { properties: { contentVector: fp32Field(4) } } }); // still fp32!

  const result = await Q.runMigrateOne("memory-exec", { client: cluster.client, stateStore, log: noopLog });
  assert.equal(result.ok, false);
  assert.match(result.reason, /is NOT a quantized/);
});

test("runMigrateOne: an index with no knn_vector field is a clean, successful no-op skip", async () => {
  const cluster = makeFakeCluster({ "plain-index": { properties: { text: { type: "text" } }, docs: { "1": { text: "hi" } } } });
  const stateStore = makeFakeStateStore();
  const result = await Q.runMigrateOne("plain-index", { client: cluster.client, stateStore, log: noopLog, commit: true });
  assert.equal(result.ok, true);
  assert.equal(result.skipped, true);
});

test("runMigrateOne: an already-quantized index is a clean, successful no-op skip", async () => {
  const cluster = makeFakeCluster({ done: { properties: { contentVector: { ...fp32Field(4), mode: "on_disk", compression_level: "32x", method: undefined, space_type: "cosinesimil" } }, docs: {} } });
  const stateStore = makeFakeStateStore();
  const result = await Q.runMigrateOne("done", { client: cluster.client, stateStore, log: noopLog, commit: true });
  assert.equal(result.ok, true);
  assert.equal(result.skipped, true);
  assert.match(result.reason, /already quantized/);
});

test("runMigrateOne: refuses to start when free disk is below the 2x-index-size floor, and touches nothing", async () => {
  const cluster = baseFixture();
  cluster.setFreeBytes(1); // effectively zero
  const stateStore = makeFakeStateStore();
  const result = await Q.runMigrateOne("memory-exec", { client: cluster.client, stateStore, log: noopLog, commit: true });
  assert.equal(result.ok, false);
  assert.match(result.reason, /free disk/);
  assert.equal(cluster.indices.has("memory-exec--q"), false, "must not have created the twin before the disk check");
});

// ---- privileged-room exclusion ----

test("runMigrateOne: refuses a privileged room by default and makes NO client calls at all", async () => {
  const cluster = makeFakeCluster({ "legal-company": { properties: { text_vector: fp32Field(4) }, docs: { "1": { text_vector: [1, 2, 3, 4] } } } });
  const stateStore = makeFakeStateStore();
  const result = await Q.runMigrateOne("legal-company", { client: cluster.client, stateStore, log: noopLog, commit: true });
  assert.equal(result.ok, false);
  assert.equal(result.skipped, true);
  assert.match(result.reason, /privileged/i);
  assert.deepEqual(cluster.calls, [], "a refused privileged room must not touch the client at all");
});

test("runMigrateOne: migrates a privileged room when --include-privileged is explicitly passed", async () => {
  const cluster = makeFakeCluster({ "legal-company": { properties: { text_vector: fp32Field(4) }, docs: { "1": { text_vector: [1, 2, 3, 4] } } } });
  const stateStore = makeFakeStateStore();
  const result = await Q.runMigrateOne("legal-company", { client: cluster.client, stateStore, log: noopLog, commit: true, includePrivileged: true });
  assert.equal(result.ok, true, result.reason);
});

// ================================================================================================
// 4. runMigrateAll
// ================================================================================================

test("migrate --all: processes smallest-first, skips privileged by default, skips already-quantized, and one failure does not stop the run", async () => {
  const cluster = makeFakeCluster({
    big: { properties: { contentVector: fp32Field(2) }, docs: Object.fromEntries([0, 1, 2, 3, 4, 5].map((i) => [String(i), { contentVector: [i, i] }])) },
    small: { properties: { contentVector: fp32Field(2) }, docs: { "1": { contentVector: [1, 1] } } },
    "legal-company": { properties: { text_vector: fp32Field(2) }, docs: { "1": { text_vector: [1, 1] } } },
    already: { properties: { contentVector: { ...fp32Field(2), mode: "on_disk", compression_level: "32x", method: undefined } }, docs: {} },
  });
  cluster.setReindexHook((source) => (source === "big" ? 0 : Infinity)); // force "big" to fail verification
  const stateStore = makeFakeStateStore();
  const log = [];
  const summary = await Q.runMigrateAll({ client: cluster.client, stateStore, log: (m) => log.push(m), commit: true });

  assert.equal(summary.ok, false, "overall summary must reflect that at least one index failed");
  const indexOrder = summary.results.map((r) => r.index);
  assert.deepEqual(indexOrder, ["small", "big"], "smallest-first, and legal-company/already must not appear at all");
  assert.equal(summary.results.find((r) => r.index === "small").ok, true);
  assert.equal(summary.results.find((r) => r.index === "big").ok, false);
  assert.ok(cluster.indices.has("big"), "the failed index must be left completely intact");
});

// ================================================================================================
// 5. runRollback
// ================================================================================================

test("rollback: recreates a missing original from its twin and reindexes it back", async () => {
  const cluster = makeFakeCluster({});
  await cluster.client.createIndex("memory-exec--q", { settings: { index: { knn: true } }, mappings: { properties: { contentVector: Q.buildQuantizedField(fp32Field(4)) } } });
  cluster.indices.get("memory-exec--q").docs.set("1", { contentVector: [1, 2, 3, 4] });

  const result = await Q.runRollback("memory-exec", { client: cluster.client, log: noopLog, commit: true });
  assert.equal(result.ok, true, result.reason);
  assert.equal(cluster.indices.get("memory-exec").docs.size, 1);
  assert.ok(cluster.indices.has("memory-exec--q"), "rollback must never delete the twin -- it is a safety valve, not a cleanup step");
});

test("rollback: a healthy original relative to its twin is a no-op skip", async () => {
  const cluster = makeFakeCluster({
    "memory-exec--q": { properties: {}, docs: { "1": {} } },
    "memory-exec": { properties: {}, docs: { "1": {} } },
  });
  const result = await Q.runRollback("memory-exec", { client: cluster.client, log: noopLog, commit: true });
  assert.equal(result.ok, true);
  assert.equal(result.skipped, true);
});

test("rollback: refuses to overwrite a present-but-broken original without --force", async () => {
  const cluster = makeFakeCluster({
    "memory-exec--q": { properties: {}, docs: { "1": {}, "2": {}, "3": {}, "4": {}, "5": {}, "6": {}, "7": {}, "8": {}, "9": {}, "10": {} } },
    "memory-exec": { properties: {}, docs: { "1": {} } }, // missing 9 of 10 docs -- clearly broken
  });
  const result = await Q.runRollback("memory-exec", { client: cluster.client, log: noopLog, commit: true });
  assert.equal(result.ok, false);
  assert.match(result.reason, /broken/);
  assert.equal(cluster.indices.get("memory-exec").docs.size, 1, "must not have touched the broken index without --force");
});

test("rollback: --force overwrites a broken original from the twin", async () => {
  const cluster = makeFakeCluster({
    "memory-exec--q": { properties: { contentVector: Q.buildQuantizedField(fp32Field(4)) }, docs: { "1": { contentVector: [1, 1, 1, 1] }, "2": { contentVector: [2, 2, 2, 2] } } },
    "memory-exec": { properties: {}, docs: {} },
  });
  const result = await Q.runRollback("memory-exec", { client: cluster.client, log: noopLog, commit: true, force: true });
  assert.equal(result.ok, true, result.reason);
  assert.equal(cluster.indices.get("memory-exec").docs.size, 2);
});

test("rollback: without --twin, refuses with a clear reason instead of guessing", async () => {
  const cluster = makeFakeCluster({});
  const result = await Q.runRollback("memory-exec", { client: cluster.client, log: noopLog, commit: true });
  assert.equal(result.ok, false);
  assert.match(result.reason, /does not exist/);
});

// ================================================================================================
// 6. runPlan
// ================================================================================================

test("runPlan: audits a mix of statuses, is fully read-only, and reflects an in-flight migration's phase", async () => {
  const cluster = makeFakeCluster({
    "memory-exec": { properties: { contentVector: fp32Field(4) }, docs: { "1": {} } },
    "legal-company": { properties: { text_vector: fp32Field(4) }, docs: {} },
    ".kibana": { properties: {}, docs: {} },
    "memory-exec--q": { properties: { contentVector: Q.buildQuantizedField(fp32Field(4)) }, docs: {} },
  });
  const stateStore = makeFakeStateStore();
  await stateStore.put("legal-company", Q.withPhase(Q.initialState({ index: "legal-company", twin: "legal-company--q" }), "reindexing"));

  const rows = await Q.runPlan({ client: cluster.client, stateStore, log: noopLog });

  const byIndex = Object.fromEntries(rows.map((r) => [r.index, r]));
  assert.equal(byIndex["memory-exec"].status, "NEEDS_MIGRATION");
  assert.match(byIndex["legal-company"].status, /PRIVILEGED IN_PROGRESS\(reindexing\)/);
  assert.equal(byIndex[".kibana"].status, "SYSTEM");
  assert.equal(byIndex["memory-exec--q"].status, "TWIN_SCRATCH");

  const mutatingCalls = cluster.calls.filter((c) => ["createIndex", "deleteIndex", "reindexStart"].includes(c.method));
  assert.deepEqual(mutatingCalls, [], "plan must never issue a mutating call");
});

// ================================================================================================
// 7. CLI plumbing (main()) -- argument -> orchestration wiring, still fully injected/offline
// ================================================================================================

test("main(): plan with an injected client/stateStore never resolves real OpenSearch config and returns exit code 0", async () => {
  const cluster = makeFakeCluster({ a: { properties: {}, docs: {} } });
  const stateStore = makeFakeStateStore();
  const code = await Q.main(["plan"], { client: cluster.client, stateStore, log: noopLog });
  assert.equal(code, 0);
});

test("main(): invalid arguments return exit code 2 without touching any client", async () => {
  const code = await Q.main(["migrate"], { client: { getIndex: () => { throw new Error("must not be called"); } }, stateStore: makeFakeStateStore(), log: noopLog });
  assert.equal(code, 2);
});

test("main(): a failed migrate returns a non-zero exit code", async () => {
  const cluster = baseFixture();
  cluster.setFreeBytes(1);
  const code = await Q.main(["migrate", "--index", "memory-exec", "--commit"], { client: cluster.client, stateStore: makeFakeStateStore(), log: noopLog });
  assert.equal(code, 1);
});

test("main(): a successful migrate returns exit code 0", async () => {
  const cluster = baseFixture();
  const code = await Q.main(["migrate", "--index", "memory-exec", "--commit"], { client: cluster.client, stateStore: makeFakeStateStore(), log: noopLog });
  assert.equal(code, 0);
});
