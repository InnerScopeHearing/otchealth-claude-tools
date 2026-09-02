#!/usr/bin/env node
// quantize-indices.mjs -- migrates every k-NN index on the fleet's OpenSearch domain
// (otchealth-brain) from fp32 (in_memory) vectors to disk-optimized/quantized vectors, one index at
// a time, resumably, on the LIVE brain. Closes FND-20260829-f7fa (otchealth-brain: ALL 15 indices
// un-quantized, ~29GB fp32 3072-dim, KNNGraphMemoryUsagePercentage peaked 96.9%); `plan` below is
// also that finding's audit.
//
// REQUIRES OpenSearch 3.x (mode:"on_disk" / compression_level are OpenSearch 3.x mapping
// parameters; see https://docs.opensearch.org/latest/vector-search/optimizing-storage/
// disk-based-vector-search/, fetched and quoted in SKILL.md). Do not run this against the domain
// while it is still on 2.19 -- index creation will reject the mapping.
//
// WHY CREATE-A-TWIN-AND-REINDEX, NOT AN IN-PLACE MAPPING UPDATE: a knn_vector field's
// method/engine/mode/compression_level are fixed at index-creation time and cannot be changed by a
// mapping PUT on an existing index. This also means the transform below does not need to know or
// care what engine the SOURCE field currently uses (nmslib, faiss, or otherwise) -- it discovers the
// live field's actual dimension + space_type from the real mapping (never a hardcoded assumption),
// and REBUILDS a fresh on_disk-mode field from those two values only. on_disk mode self-selects the
// faiss engine (see the docs page above), so the source engine is irrelevant either way.
//
// THE INDEX NAME IS THE ADDRESS: there is no alias layer anywhere in this fleet's retrieval code
// (otchealth-mcp-server's search dispatcher, skills/company-brain/opensearch-rooms.mjs, and this
// skill's own push-search/index-one all reference literal index name strings). So the "better"
// option this tool's design brief offered is the only one that applies: swap by
// delete-original -> reindex twin back onto the original name -> verify again -> delete the twin.
// That means there is a short window, between deleting `<index>` and recreating it, where the name
// does not exist. This is a real, documented, unavoidable-within-scope limitation (see SKILL.md) --
// it is not eliminated, only minimized (the two steps run back-to-back with no other work between
// them) and never entered until the twin has been independently VERIFIED.
//
// LIVE-BRAIN SAFETY: the source index keeps receiving writes from the librarian/brain-reindex jobs
// while this runs. `_reindex` copies `_source` by overwriting-by-`_id`, which makes RE-RUNNING it
// after a partial failure or a doc-count mismatch always safe and convergent -- there is no
// duplicate-id risk. reindexUntilCountsConverge() below uses exactly that property: it reindexes,
// compares source/dest doc counts, and reindexes again (bounded) if they still disagree, rather than
// trying to track a point-in-time snapshot. It cannot make the source stop moving; it can only keep
// re-copying until it catches up, and it fails loud (not silently) if it never does.
//
// THE TWO DIRECTIONS HAVE OPPOSITE CONVERGENCE RULES (2026-09-02, memory-exec): the forward pass (live
// original -> frozen twin) converges on EQUAL counts; the swap-back (frozen twin -> the recreated
// original, the live write target from the instant it exists) converges on dest >= source and copies
// create-only, never overwriting a live doc -- see reindexUntilCountsConverge()'s `liveSide`. Between
// the last converged forward pass and the delete there is an UNAVOIDABLE sub-second gap (verify and
// delete run back-to-back; 0.2s measured on memory-exec) in which a write to the original is lost. The
// memory rooms are projections of the S3 kb-memory ledger and the doc rooms of their S3 source buckets,
// so such a write is re-materialized by the next librarian/brain-reindex run rather than lost for
// good. The zero-gap design is an alias swap; the fleet's writers address concrete index names today.
//
// RESUMABLE STATE lives in the fleet's existing S3 commons mirror (skills/kb-memory/
// commons-store.mjs, the SAME store setup/heartbeat.mjs already uses for `_HEARTBEAT/`), one JSON
// file per index under `_QUANTIZE_STATE/<index>.json`. Every state write is a plain overwrite (no
// concurrent writers are expected -- this tool runs as a single ECS task at a time); commons-store's
// own contract throws loud on any real I/O failure rather than silently reporting "not started".
//
// THE ONE INVARIANT THIS ENTIRE FILE EXISTS TO ENFORCE: the original `<index>` is never deleted
// until its twin `<index>--q` has been independently verified (doc-count convergence + a real
// sample doc-source comparison + a real kNN overlap check). The swap machinery below is a sequence
// of `if (state.phase === "...")` blocks precisely so that invariant is structural, not a comment --
// every step before "verified" only ever touches `<index>--q`; nothing before that phase can reach
// the block that deletes `<index>`.
//
// Dependency-free (node builtins + this toolkit's own SigV4 client only), no npm dependencies added.
import { pathToFileURL } from "node:url";
import {
  osGetIndex,
  osCreateIndex,
  osDeleteIndex,
  osReindexStart,
  osGetTask,
  osCatIndices,
  osCatAllocation,
  osMget,
  osSearch,
  osCount,
} from "./opensearch-client.mjs";
import { resolveOpenSearchConfig } from "../kb-memory/opensearch-write.mjs";
import { cGet, cPut, cList } from "../kb-memory/commons-store.mjs";

// ============================================================================================
// Constants
// ============================================================================================

/**
 * Rooms that carry finance-MNPI or attorney-privileged content, sourced from the gateway's OWN ring
 * registry (otchealth-mcp-server/src/tools/kb/search-privileged.ts INDEX_LANES + PERSONAL_LEGAL_RING,
 * read-only reference -- this tool never imports from or touches the gateway repo). Deliberately a
 * SUPERSET of the three-name/pattern shorthand ("finance-cfo-source-docs, legal-personal*,
 * finance-*-memory") this tool's own design brief used for illustration: that shorthand's literal
 * patterns would NOT match `legal-company` or `finance-otchealth-cfo-source-docs`, both of which the
 * gateway gates to EXEC_RING (finance-MNPI / attorney-privileged) exactly like the three it did name.
 * A migration tool's safety list should match the REAL ring boundary, not a slightly narrower
 * shorthand of it, so this list is the gateway's actual INDEX_LANES key set, verbatim:
 *   finance-cfo-source-docs            -> EXEC_RING
 *   finance-otchealth-cfo-source-docs  -> EXEC_RING
 *   finance-cfo-memory                 -> EXEC_RING
 *   legal-company                      -> EXEC_RING
 *   legal-personal                     -> PERSONAL_LEGAL_RING (most sensitive)
 *   legal-personal-memory              -> PERSONAL_LEGAL_RING
 * Non-privileged rooms (memory-exec, commons-company-journal, commerce-commerce-source-docs, and the
 * per-agent commons-<role>-memory rooms) are correctly ABSENT from this list and migrate by default.
 */
export const PRIVILEGED_ROOMS = new Set([
  "finance-cfo-source-docs",
  "finance-otchealth-cfo-source-docs",
  "finance-cfo-memory",
  "legal-company",
  "legal-personal",
  "legal-personal-memory",
]);

/** Pure. Whether `index` is one of the rooms migrate refuses by default. */
export function isPrivilegedRoom(index) {
  return PRIVILEGED_ROOMS.has(index);
}

/** Pure. OpenSearch/Kibana system indices (security config, ISM, etc.) start with `.` and are never
 *  a fleet room; `plan`/`migrate --all` both exclude them so the tool never touches cluster-internal
 *  state. */
export function isSystemIndex(index) {
  return typeof index === "string" && index.startsWith(".");
}

/** The suffix marking a migration's scratch/twin index. Exported so tests and `plan`'s own listing
 *  can recognize (and exclude from "needs migration") a twin left over from an in-flight or aborted
 *  run without special-casing string literals in more than one place. */
export const TWIN_SUFFIX = "--q";
export const twinName = (index) => `${index}${TWIN_SUFFIX}`;
export const isTwinIndex = (index) => typeof index === "string" && index.endsWith(TWIN_SUFFIX);

/** Valid `compression_level` values per the knn_vector field-type reference
 *  (https://docs.opensearch.org/latest/mappings/supported-field-types/knn-vector/, "Valid values are
 *  1x, 2x, 4x, 8x, 16x, and 32x"). */
export const VALID_COMPRESSION_LEVELS = new Set(["1x", "2x", "4x", "8x", "16x", "32x"]);
export const DEFAULT_COMPRESSION_LEVEL = "32x";
export const DEFAULT_MIN_OVERLAP_PCT = 90;
export const SAMPLE_SIZE = 25;
export const KNN_K = 10;
export const MAX_REINDEX_CONVERGE_ATTEMPTS = 3;
export const STATE_PREFIX = "_QUANTIZE_STATE/";

/** Throws (loudly, with the exact list) on an unrecognized compression level rather than silently
 *  passing an invalid value through to OpenSearch, which would surface as a much less clear
 *  index-creation 400 several steps later. */
export function validateCompressionLevel(level) {
  if (!VALID_COMPRESSION_LEVELS.has(level)) {
    throw new Error(
      `invalid compression level '${level}'; valid values are ${[...VALID_COMPRESSION_LEVELS].join(", ")}`,
    );
  }
  return level;
}

// ============================================================================================
// Pure mapping/field helpers
// ============================================================================================

/**
 * Find the (at most one) knn_vector field in a mapping's top-level `properties`. Every real room in
 * this fleet is a flat, single-vector-field schema (see skills/company-brain/opensearch-rooms.mjs's
 * CHUNKED_ROOMS/vectorFieldFor -- `text_vector` on doc rooms, `contentVector` on memory rooms, never
 * both on the same index), so this deliberately does NOT hardcode either name: it discovers whichever
 * field is actually typed `knn_vector` on THIS index's live mapping.
 *
 * Returns `null` (a normal, expected outcome -- callers should skip the index) when no such field
 * exists. THROWS when more than one is found: a room with two vector fields is a real anomaly this
 * tool has no safe default for (which one is "the" vector to quantize?), so it refuses to guess.
 */
export function findVectorField(properties) {
  const props = properties && typeof properties === "object" ? properties : {};
  const matches = Object.entries(props).filter(([, def]) => def && def.type === "knn_vector");
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    throw new Error(
      `index has ${matches.length} knn_vector fields (${matches.map(([n]) => n).join(", ")}); ` +
        `refusing to guess which one to quantize`,
    );
  }
  const [field, def] = matches[0];
  return { field, def };
}

/** Pure. A field is already migrated when its mapping carries `mode:"on_disk"`. */
export function isOnDiskMode(fieldDef) {
  return Boolean(fieldDef) && fieldDef.mode === "on_disk";
}

/** Pure. `space_type` may be declared top-level on the field (the NEW on_disk shape this tool
 *  writes) or nested under `method.space_type` (the shape every live room's field currently uses,
 *  per skills/kb-memory/opensearch-write.mjs's memoryIndexMapping()). Top-level wins if somehow both
 *  are present (matches the field-type reference's own note: "This value can also be specified
 *  within the method"). Returns `null`, never a guessed default, when neither is present. */
export function extractSpaceType(fieldDef) {
  if (!fieldDef) return null;
  if (typeof fieldDef.space_type === "string" && fieldDef.space_type) return fieldDef.space_type;
  if (fieldDef.method && typeof fieldDef.method.space_type === "string" && fieldDef.method.space_type) {
    return fieldDef.method.space_type;
  }
  return null;
}

/**
 * Build the REPLACEMENT field definition for the twin index's mapping: a fresh on_disk-mode
 * knn_vector field carrying only {type, dimension, data_type, space_type, mode, compression_level}.
 * Deliberately DROPS the source field's `method`/`engine` entirely -- on_disk mode self-selects the
 * faiss engine (per the docs page cited at the top of this file) regardless of what engine the
 * source used, so carrying an old `method.engine` forward would at best be inert and at worst
 * conflict with on_disk mode's own engine selection.
 *
 * Throws (refuses to guess) on a missing/non-positive-integer dimension, a missing space_type, or a
 * source field that is already on_disk (callers must check isOnDiskMode() first -- this function
 * unconditionally treats its input as "needs migrating").
 */
export function buildQuantizedField(fieldDef, compressionLevel = DEFAULT_COMPRESSION_LEVEL) {
  if (isOnDiskMode(fieldDef)) {
    throw new Error("buildQuantizedField: field is already mode:on_disk; refusing to re-wrap it");
  }
  const dimension = fieldDef && fieldDef.dimension;
  if (!Number.isInteger(dimension) || dimension <= 0) {
    throw new Error(`buildQuantizedField: missing/invalid dimension (${JSON.stringify(dimension)}); refusing to guess`);
  }
  const spaceType = extractSpaceType(fieldDef);
  if (!spaceType) {
    throw new Error("buildQuantizedField: no discoverable space_type (checked top-level and method.space_type); refusing to guess");
  }
  validateCompressionLevel(compressionLevel);
  return {
    type: "knn_vector",
    dimension,
    data_type: "float", // on_disk mode "only works with the float data type" (docs page cited above)
    space_type: spaceType,
    mode: "on_disk",
    compression_level: compressionLevel,
  };
}

/**
 * Index `settings.index` keys that are server-assigned/non-portable and must never be replayed into
 * a PUT-create call (a PUT carrying `index.uuid`, for example, is rejected outright). This is the
 * standard denylist shape any "clone a live index's settings" tool needs; kept as an explicit
 * denylist (not an allowlist) so a legitimate custom setting on a room -- a custom analyzer, a
 * mapping.total_fields.limit bump -- is preserved rather than silently dropped.
 */
export const SETTINGS_DENYLIST_KEYS = [
  "uuid",
  "creation_date",
  "creation_date_string",
  "provided_name",
  "version",
  "resize",
  "store.snapshot",
  "frozen",
  "blocks",
  "routing.allocation.initial_recovery",
  "verified_before_close",
  "search.throttled",
];

/** Pure. Deep-clones `indexSettings` (the object under a GET response's `settings.index`), strips
 *  every SETTINGS_DENYLIST_KEYS entry (top-level or dotted-nested), and forces `knn:true` (required
 *  for any knn_vector field, on_disk or otherwise -- present already on every live room per
 *  opensearch-write.mjs's memoryIndexMapping(), forced here as a defensive floor rather than assumed). */
export function sanitizeIndexSettings(indexSettings) {
  const src = indexSettings && typeof indexSettings === "object" ? indexSettings : {};
  const flat = flattenObject(src);
  for (const key of Object.keys(flat)) {
    if (SETTINGS_DENYLIST_KEYS.some((denied) => key === denied || key.startsWith(`${denied}.`))) {
      delete flat[key];
    }
  }
  const out = unflattenObject(flat);
  out.knn = true;
  return out;
}

function flattenObject(obj, prefix = "", out = {}) {
  for (const [k, v] of Object.entries(obj || {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) flattenObject(v, key, out);
    else out[key] = v;
  }
  return out;
}
// OpenSearch reports index settings FLATTENED, and a key can be BOTH a leaf and a namespace at once:
// on 3.x a GET of any k-NN index returns `knn: "true"` next to `knn.derived_source.enabled: "true"`.
// A naive unflatten walks into the string "true" and throws (`Cannot create property 'derived_source'
// on string 'true'`, hit live on otchealth-brain 3.7, 2026-09-02, the moment the tool re-read a twin
// it had created). When an intermediate node is already a primitive, the remainder of the key is kept
// DOTTED at that level -- OpenSearch accepts dotted settings keys, so the create body stays valid.
function unflattenObject(flat) {
  const out = {};
  // shorter (parent) keys first, so `knn` is placed before `knn.derived_source.enabled` whatever the
  // insertion order of the flattened map -- otherwise the later leaf would overwrite the namespace.
  const entries = Object.entries(flat).sort(([a], [b]) => a.split(".").length - b.split(".").length);
  for (const [key, v] of entries) {
    const parts = key.split(".");
    let node = out;
    let placed = false;
    for (let i = 0; i < parts.length - 1; i++) {
      const existing = node[parts[i]];
      if (existing !== undefined && (existing === null || typeof existing !== "object" || Array.isArray(existing))) {
        node[parts.slice(i).join(".")] = v;
        placed = true;
        break;
      }
      node = node[parts[i]] ||= {};
    }
    if (!placed) node[parts.at(-1)] = v;
  }
  return out;
}

/**
 * Build the full `{settings, mappings}` PUT-create body for a twin index, from the raw GET-response
 * body of the SOURCE index (the value under its own name in a GET /<index> response) and the
 * already-discovered `{field, def}` vector field. Pure (no I/O); the caller supplies the live source
 * body and does the actual PUT.
 */
export function buildTwinIndexBody(sourceIndexBody, vectorFieldName, vectorFieldDef, compressionLevel) {
  const props = (sourceIndexBody && sourceIndexBody.mappings && sourceIndexBody.mappings.properties) || {};
  const quantizedField = buildQuantizedField(vectorFieldDef, compressionLevel);
  return {
    settings: { index: sanitizeIndexSettings((sourceIndexBody && sourceIndexBody.settings && sourceIndexBody.settings.index) || {}) },
    mappings: { properties: { ...props, [vectorFieldName]: quantizedField } },
  };
}

// ============================================================================================
// Deep-equal (order-insensitive for objects, order-sensitive for arrays -- a vector's element order
// matters; a JSON object's key order does not) -- used for the "identical _source" doc-parity check.
// ============================================================================================
export function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "number") return Number.isNaN(a) && Number.isNaN(b) ? true : a === b;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  const ak = Object.keys(a), bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!deepEqual(a[k], b[k])) return false;
  }
  return true;
}

/**
 * Pure. Percentage overlap between two top-K id lists (order ignored -- this is a recall-style
 * overlap check, not a rank-agreement check).
 *
 * The denominator is `min(k, idsA.length, idsB.length)`, NOT the raw requested `k`. A room with
 * fewer than `k` total documents can never return `k` hits on EITHER side no matter how healthy it
 * is (a 5-document index queried with k=10 returns at most 5 hits from both the fp32 and the
 * quantized copy) -- dividing by the raw `k` would report a perfect, fully-overlapping 5-hit match
 * as a mere 50% and incorrectly fail a real fleet room this small (verified against a 5-doc fixture
 * during this tool's own test-writing: it reported a false 50% "failure" before this fix). Dividing
 * by what both sides could ACTUALLY have returned measures the thing that matters -- do the results
 * agree -- without conflating it with "is the corpus smaller than k". A genuine problem (one side
 * returning meaningfully fewer hits than the other despite a large corpus) is a distinct signal this
 * function deliberately does not try to also capture; `k` stays the ceiling once both sides are
 * large enough to reach it. Two empty lists (an empty index) is a vacuous 100 -- there is nothing to
 * disagree about; exactly one side empty (the other found live neighbors) is a genuine 0.
 */
export function computeOverlapPct(idsA, idsB, k = KNN_K) {
  const a = Array.isArray(idsA) ? idsA : [];
  const b = Array.isArray(idsB) ? idsB : [];
  if (a.length === 0 && b.length === 0) return 100;
  const effectiveK = Math.min(k, a.length, b.length);
  if (effectiveK === 0) return 0;
  const setB = new Set(b);
  const intersection = a.filter((id) => setB.has(id)).length;
  return Math.round((intersection / effectiveK) * 10000) / 100;
}

/** Pure. The 2x-free-space safety rule: refuse to start if free disk (summed across nodes) is less
 *  than 2x the target index's current total store size. `indexBytes` of `null` (index not found in
 *  the _cat/indices listing -- should not happen for a live room, but handled rather than crashing)
 *  refuses conservatively rather than silently proceeding. */
export function diskSafetyCheck(freeBytes, indexBytes) {
  if (!Number.isFinite(indexBytes) || indexBytes < 0) {
    return { ok: false, reason: "could not determine the index's current store size from _cat/indices" };
  }
  if (!Number.isFinite(freeBytes)) {
    return { ok: false, reason: "could not determine free disk space from _cat/allocation" };
  }
  const required = indexBytes * 2;
  if (freeBytes < required) {
    return {
      ok: false,
      reason: `free disk ${formatBytes(freeBytes)} is less than 2x the index's store size ${formatBytes(indexBytes)} (need >= ${formatBytes(required)})`,
    };
  }
  return { ok: true, reason: null };
}

/** Pure. Sum `disk.avail` across every _cat/allocation row that names a real node -- an
 *  unassigned-shards row reports `node: null` and must not be double-counted or mistaken for spare
 *  node capacity. */
export function sumAvailableBytes(allocationRows) {
  const rows = Array.isArray(allocationRows) ? allocationRows : [];
  return rows.reduce((sum, r) => {
    if (!r || r.node == null || r.node === "") return sum;
    const v = Number(r["disk.avail"]);
    return sum + (Number.isFinite(v) ? v : 0);
  }, 0);
}

/** Pure. Human-readable byte formatter for the `plan` table and error messages. */
export function formatBytes(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return "?";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = num, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 && i > 0 ? 2 : 1)}${units[i]}`;
}

// ============================================================================================
// State (resumable, one JSON file per index in the S3 commons mirror)
// ============================================================================================

/** Phases entered ONLY after "verified" -- i.e. only once the twin is independently proven good --
 *  during which the ORIGINAL `<index>` has already been (or is about to be) deleted/recreated.
 *  Exported so runMigrateOne can skip its "re-discover the source mapping" step when resuming into
 *  one of these (the original may genuinely not exist yet at that point) and so tests can assert
 *  phase membership without hardcoding the string list a second time. */
export const SWAP_PHASES = ["swap_deleted_original", "swap_recreated_target", "swap_reindexing_back", "swap_reverifying", "cleanup_pending"];
/**
 * Pure. The phase a `failed` state should resume in when the failure happened MID-SWAP (the original
 * index is already deleted, the twin holds the data): `failed_in_phase` when recorded, otherwise the
 * most recent non-`failed` history entry (states persisted before failed_in_phase existed). Returns
 * null when the failure was pre-swap, where a fresh start from the still-present original is correct.
 */
export function resumablePhase(state) {
  if (!state || state.phase !== "failed") return null;
  let phase = state.failed_in_phase;
  if (!phase) {
    for (let i = (state.history || []).length - 1; i >= 0; i--) {
      const h = state.history[i];
      if (h && h.phase && h.phase !== "failed") { phase = h.phase; break; }
    }
  }
  return SWAP_PHASES.includes(phase) ? phase : null;
}

/** Pure. The initial state for an index nobody has touched yet. */
export function initialState({ index, twin, vectorField = null, dimension = null, spaceType = null, compressionLevel = DEFAULT_COMPRESSION_LEVEL }) {
  const ts = new Date().toISOString();
  return {
    schema: 1,
    index,
    twin,
    phase: "planned",
    vector_field: vectorField,
    dimension,
    space_type: spaceType,
    compression_level: compressionLevel,
    source_doc_count: null,
    twin_doc_count: null,
    overlap_pct: null,
    error: null,
    started_at: ts,
    updated_at: ts,
    history: [{ ts, phase: "planned", note: "initialized" }],
  };
}

/** Pure. Advance `state` to `phase`, stamping `updated_at` and appending a history row. Returns a
 *  NEW object (never mutates its input) so orchestration code and tests can both reason about it
 *  functionally. */
export function withPhase(state, phase, note = "") {
  const ts = new Date().toISOString();
  return { ...state, phase, updated_at: ts, error: phase === "failed" ? state.error : null, history: [...state.history, { ts, phase, note }] };
}

/** Pure. Mark `state` failed with `reason`, preserving history. */
export function withFailure(state, reason) {
  const ts = new Date().toISOString();
  // failed_in_phase (2026-09-02): a failure must not erase WHERE the run was. The first live swap died
  // in swap_recreated_target with the original already deleted; recording plain phase:"failed" made the
  // resume path treat it as a fresh run and GET the (gone) original. resumablePhase() reads this back.
  return { ...state, phase: "failed", failed_in_phase: state.phase, error: reason, updated_at: ts, history: [...state.history, { ts, phase: "failed", note: reason }] };
}

/** Thin wrapper over the fleet's existing S3 commons mirror (skills/kb-memory/commons-store.mjs),
 *  scoped to this tool's own prefix. `get()` returns `null` on a genuine 404 (no state yet -- a
 *  normal, expected first-run outcome) and THROWS on anything else (cGet's own contract), which is
 *  exactly the fail-loud behavior a resumable migration needs: a transient S3 error must never be
 *  silently read as "nothing in flight, safe to start from scratch". */
export function makeStateStore() {
  const keyOf = (index) => `${STATE_PREFIX}${index}.json`;
  return {
    async get(index) {
      const text = await cGet(keyOf(index));
      return text ? JSON.parse(text) : null;
    },
    async put(index, state) {
      await cPut(keyOf(index), JSON.stringify(state, null, 2), "application/json");
    },
    async list() {
      const names = await cList(STATE_PREFIX);
      return names.map((n) => n.slice(STATE_PREFIX.length).replace(/\.json$/, ""));
    },
  };
}

// ============================================================================================
// I/O client (a thin, injectable wrapper over opensearch-client.mjs bound to a resolved cfg) --
// EVERY orchestration function below takes a `client` object of this shape, so tests supply a fake
// one and never touch the network, mirroring skills/safety-monitor/monitor.mjs's runSweep(opts)
// dependency-injection convention.
// ============================================================================================
export function makeClient(cfg) {
  return {
    getIndex: (index) => osGetIndex(cfg, index),
    createIndex: (index, body) => osCreateIndex(cfg, index, body),
    deleteIndex: (index) => osDeleteIndex(cfg, index),
    reindexStart: (body) => osReindexStart(cfg, body),
    getTask: (taskId) => osGetTask(cfg, taskId),
    catIndices: () => osCatIndices(cfg),
    catAllocation: () => osCatAllocation(cfg),
    mget: (index, ids) => osMget(cfg, index, ids),
    search: (index, body) => osSearch(cfg, index, body),
    count: async (index) => {
      const r = await osCount(cfg, index, { match_all: {} });
      return { ...r, count: r.ok ? r.json?.count : null };
    },
  };
}

/** A short, human-readable description of a non-2xx osJson()-shaped response, for error messages. */
function describeErr(res) {
  const body = res && res.json ? JSON.stringify(res.json) : res && res.text;
  return `HTTP ${res?.status}: ${String(body || "").slice(0, 300)}`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll an async task (started by client.reindexStart) until OpenSearch reports it `completed`.
 *  `sleepFn` is injectable so tests never wait on a real timer. Bounded by `maxWaitMs` (default 2h --
 *  the finance room alone is ~13GB; see FND-20260829-f7fa) so a stuck cluster fails loud instead of
 *  hanging an ECS task forever. A 404 on the task mid-poll is treated as a FAILURE here (not a
 *  success) -- per this file's header note, task ids are node-local and do not survive a node
 *  restart, so "task not found" is genuinely ambiguous; the caller (reindexUntilCountsConverge) is
 *  the layer that turns an ambiguous outcome into a safe re-run via the doc-count convergence loop,
 *  not this function guessing which way to resolve the ambiguity. */
export async function pollTaskToCompletion(client, taskId, { sleepFn = sleep, intervalMs = 5000, maxWaitMs = 2 * 60 * 60 * 1000, log = () => {} } = {}) {
  const deadline = Date.now() + maxWaitMs;
  for (;;) {
    const res = await client.getTask(taskId);
    if (res.status === 404) {
      return { ok: false, reason: `task '${taskId}' not found (node restart or the id expired); cannot confirm completion` };
    }
    if (!res.ok) return { ok: false, reason: `GET /_tasks/${taskId} failed: ${describeErr(res)}` };
    const j = res.json || {};
    if (j.completed) {
      const failures = j.response?.failures;
      if (Array.isArray(failures) && failures.length) {
        return { ok: false, reason: `reindex task completed with ${failures.length} per-document failure(s): ${JSON.stringify(failures[0]).slice(0, 300)}` };
      }
      return { ok: true, response: j.response || {} };
    }
    if (Date.now() > deadline) {
      return { ok: false, reason: `task '${taskId}' did not complete within ${Math.round(maxWaitMs / 60000)} minutes` };
    }
    const status = j.task?.status;
    if (status) log(`  ... reindex in progress: ${status.created ?? "?"} created, ${status.updated ?? "?"} updated, ${status.total ?? "?"} total`);
    await sleepFn(intervalMs);
  }
}

/**
 * Reindex `source` -> `dest` and keep retrying (bounded) until their doc counts converge. This is
 * the mechanism that makes migrating a LIVE index safe: `_reindex` overwrites by `_id`, so re-running
 * it after new documents land is always safe, never duplicates, and eventually catches up. Fails loud
 * (does not silently accept a mismatch) if counts never converge within `maxAttempts`.
 *
 * `liveSide` names which of the two indexes is receiving live writes while this runs, because the two
 * directions this tool uses have OPPOSITE convergence rules:
 *   - "source" (default; the forward pass, live original -> frozen twin): `dest` must catch UP to
 *     `source`, and only exact equality proves it did. A `dest` count ABOVE `source` here would mean
 *     docs deleted from the live original were resurrected in the twin, so equality stays strict.
 *   - "dest" (the swap-back, frozen twin -> the recreated original, which is the LIVE write target from
 *     the instant it exists): `dest` legitimately grows PAST `source` by every live write that lands
 *     during the pass, so `dest >= source` IS convergence and equality can never be demanded --
 *     retrying only accumulates more live writes and then fails (2026-09-02, memory-exec: source=17675
 *     dest=17678 after three full passes; the tool declared FAILED and left the twin behind while the
 *     original was already complete and quantized). In this direction the reindex also runs with
 *     dest.op_type="create" + conflicts="proceed": a doc that already exists on the live `dest` is
 *     NEVER overwritten by the twin's older copy (a resume after a mid-pass failure would otherwise
 *     revert every doc updated live since the first pass); the pass only fills the ids `dest` lacks.
 */
export async function reindexUntilCountsConverge(client, { source, dest }, { maxAttempts = MAX_REINDEX_CONVERGE_ATTEMPTS, log = () => {}, pollOpts = {}, liveSide = "source" } = {}) {
  if (liveSide !== "source" && liveSide !== "dest") {
    throw new Error(`reindexUntilCountsConverge: liveSide must be "source" or "dest", got ${JSON.stringify(liveSide)}`);
  }
  const destLive = liveSide === "dest";
  let lastSrc = null, lastDst = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    log(`  reindexing ${source} -> ${dest} (attempt ${attempt}/${maxAttempts}${destLive ? ", create-only: live dest docs are never overwritten" : ""})...`);
    const body = destLive
      ? { conflicts: "proceed", source: { index: source }, dest: { index: dest, op_type: "create" } }
      : { source: { index: source }, dest: { index: dest } };
    const start = await client.reindexStart(body);
    if (!start.ok || !start.json || !start.json.task) {
      return { ok: false, reason: `starting _reindex ${source} -> ${dest} failed: ${describeErr(start)}` };
    }
    const done = await pollTaskToCompletion(client, start.json.task, { log, ...pollOpts });
    if (!done.ok) return { ok: false, reason: done.reason };
    const [srcRes, dstRes] = await Promise.all([client.count(source), client.count(dest)]);
    if (!srcRes.ok || !dstRes.ok) {
      return { ok: false, reason: `post-reindex count check failed (source ok=${srcRes.ok}, dest ok=${dstRes.ok})` };
    }
    lastSrc = srcRes.count; lastDst = dstRes.count;
    const converged = destLive ? lastDst >= lastSrc : lastSrc === lastDst;
    if (converged) return { ok: true, srcCount: lastSrc, dstCount: lastDst, attempts: attempt, liveSide };
    log(destLive
      ? `  live dest '${dest}' still holds fewer docs than frozen source '${source}' (source=${lastSrc} dest=${lastDst}); retrying`
      : `  counts diverged after reindex (source=${lastSrc} dest=${lastDst}); likely live writes landed mid-pass; retrying`);
  }
  return {
    ok: false,
    reason: destLive
      ? `live dest '${dest}' never caught up to frozen source '${source}' after ${maxAttempts} reindex attempts (last source=${lastSrc} dest=${lastDst}); ` +
        `docs are missing on '${dest}' -- inspect before deleting '${source}'`
      : `doc counts never converged after ${maxAttempts} reindex attempts (last source=${lastSrc} dest=${lastDst}); ` +
        `'${source}' is likely receiving writes faster than this tool can converge -- retry during a quieter window`,
  };
}

/**
 * Verify `destIndex` is a faithful copy of `sourceIndex`: (1) a real sample of up to SAMPLE_SIZE doc
 * ids, fetched once from `sourceIndex`, present on BOTH sides with byte-identical `_source` --
 * excluding nothing, including the vector field itself (the vector VALUES are untouched by a mapping
 * change; only how OpenSearch indexes them for ANN changes); (2) one real kNN query -- using one of
 * the sampled docs' OWN embedded vector, an actual vector that is genuinely in the corpus, never a
 * synthetic probe -- run against both indexes, requiring the top-K id sets to overlap by at least
 * `minOverlapPct`. Never mutates anything.
 */
/**
 * `_source` parity is checked with the vector field REMOVED from both sides. Live finding
 * (otchealth-brain 3.7, 2026-09-02, commons-cco-memory): the twin is created with
 * `index.knn.derived_source.enabled=true` + `mode:on_disk` + a compression level, so OpenSearch does
 * not store the vector in `_source` at all -- it DERIVES it from the (quantized) k-NN index on read.
 * A derived, quantized vector is never byte-identical to the fp32 original, so every sampled doc
 * reported "_source differs" while every non-vector field matched exactly. Vector fidelity is what the
 * k-NN top-k overlap probe below measures; the `_source` check is for everything else.
 */
export function sourceWithoutVector(src, vectorField) {
  if (!src || typeof src !== "object") return src;
  const { [vectorField]: _omitted, ...rest } = src;
  return rest;
}

export async function verifyParity(client, { sourceIndex, destIndex, vectorField, minOverlapPct = DEFAULT_MIN_OVERLAP_PCT, sampleSize = SAMPLE_SIZE, k = KNN_K }) {
  const sampleRes = await client.search(sourceIndex, { size: sampleSize, _source: false, query: { match_all: {} } });
  if (!sampleRes.ok) return { ok: false, reason: `sampling ${sourceIndex} failed: ${describeErr(sampleRes)}` };
  const ids = (sampleRes.json?.hits?.hits ?? []).map((h) => h._id);
  if (ids.length === 0) {
    return { ok: true, reason: "source index is empty; nothing to sample or probe", sampleChecked: 0, mismatches: [], overlapPct: 100 };
  }

  const [srcM, dstM] = await Promise.all([client.mget(sourceIndex, ids), client.mget(destIndex, ids)]);
  if (!srcM.ok) return { ok: false, reason: `mget ${sourceIndex} failed: ${describeErr(srcM)}` };
  if (!dstM.ok) return { ok: false, reason: `mget ${destIndex} failed: ${describeErr(dstM)}` };
  const srcById = new Map((srcM.json?.docs ?? []).map((d) => [d._id, d]));
  const dstById = new Map((dstM.json?.docs ?? []).map((d) => [d._id, d]));

  const mismatches = [];
  for (const id of ids) {
    const s = srcById.get(id), d = dstById.get(id);
    if (!s?.found || !d?.found) { mismatches.push({ id, reason: `found on source=${Boolean(s?.found)} dest=${Boolean(d?.found)}` }); continue; }
    if (!deepEqual(sourceWithoutVector(s._source, vectorField), sourceWithoutVector(d._source, vectorField))) mismatches.push({ id, reason: "_source differs" });
  }
  if (mismatches.length) {
    return { ok: false, reason: `${mismatches.length}/${ids.length} sampled doc(s) mismatched: ${JSON.stringify(mismatches.slice(0, 5))}`, sampleChecked: ids.length, mismatches };
  }

  const probeId = ids[0];
  const probeVector = srcById.get(probeId)?._source?.[vectorField];
  if (!Array.isArray(probeVector) || probeVector.length === 0) {
    return { ok: false, reason: `sampled doc '${probeId}' has no usable '${vectorField}' vector to probe with` };
  }
  const knnBody = { size: k, _source: false, query: { knn: { [vectorField]: { vector: probeVector, k } } } };
  const [srcKnn, dstKnn] = await Promise.all([client.search(sourceIndex, knnBody), client.search(destIndex, knnBody)]);
  if (!srcKnn.ok) return { ok: false, reason: `kNN probe against ${sourceIndex} failed: ${describeErr(srcKnn)}` };
  if (!dstKnn.ok) return { ok: false, reason: `kNN probe against ${destIndex} failed: ${describeErr(dstKnn)}` };
  const srcIds = (srcKnn.json?.hits?.hits ?? []).map((h) => h._id);
  const dstIds = (dstKnn.json?.hits?.hits ?? []).map((h) => h._id);
  const overlapPct = computeOverlapPct(srcIds, dstIds, k);

  if (overlapPct < minOverlapPct) {
    return { ok: false, reason: `kNN top-${k} overlap ${overlapPct}% is below the required ${minOverlapPct}%`, sampleChecked: ids.length, mismatches: [], overlapPct };
  }
  return { ok: true, reason: null, sampleChecked: ids.length, mismatches: [], overlapPct };
}

// ============================================================================================
// plan (read-only audit)
// ============================================================================================

/** Pure. Classify one index's row from a joined (cat-row, mapping) pair into the label `plan` shows. */
export function classifyRow({ index, mappingProps, statePhase }) {
  if (isSystemIndex(index)) return { status: "SYSTEM", vectorField: null };
  if (isTwinIndex(index)) return { status: "TWIN_SCRATCH", vectorField: null };
  let found;
  try {
    found = findVectorField(mappingProps);
  } catch (e) {
    return { status: `ANOMALY: ${e.message}`, vectorField: null };
  }
  if (!found) return { status: "NO_VECTOR_FIELD", vectorField: null };
  const privileged = isPrivilegedRoom(index) ? "PRIVILEGED " : "";
  if (isOnDiskMode(found.def)) return { status: `${privileged}ALREADY_QUANTIZED`, vectorField: found.field, dimension: found.def.dimension, compressionLevel: found.def.compression_level };
  if (statePhase && statePhase !== "planned" && statePhase !== "failed" && statePhase !== "complete") {
    return { status: `${privileged}IN_PROGRESS(${statePhase})`, vectorField: found.field, dimension: found.def.dimension, spaceType: extractSpaceType(found.def) };
  }
  if (statePhase === "failed") return { status: `${privileged}FAILED(retry)`, vectorField: found.field, dimension: found.def.dimension, spaceType: extractSpaceType(found.def) };
  return { status: `${privileged}NEEDS_MIGRATION`, vectorField: found.field, dimension: found.def.dimension, spaceType: extractSpaceType(found.def) };
}

/** Pure. Render `plan`'s table from already-classified rows. */
export function renderPlanTable(rows) {
  const headers = ["INDEX", "DOCS", "SIZE", "FIELD", "DIM", "SPACE", "STATUS"];
  const lines = rows.map((r) => [
    r.index,
    String(r.docsCount ?? "?"),
    formatBytes(r.storeSizeBytes),
    r.vectorField ?? "-",
    r.dimension != null ? String(r.dimension) : "-",
    r.spaceType ?? "-",
    r.status,
  ]);
  const widths = headers.map((h, i) => Math.max(h.length, ...lines.map((l) => l[i].length)));
  const fmt = (cols) => cols.map((c, i) => c.padEnd(widths[i])).join("  ");
  return [fmt(headers), fmt(widths.map((w) => "-".repeat(w))), ...lines.map(fmt)].join("\n");
}

/** Enumerate every index, classify it, print (or return, for --json) the audit table. Read-only:
 *  makes no mutating call. Also folds in the state store so an in-flight/failed migration shows up
 *  instead of looking indistinguishable from "never started". */
export async function runPlan({ client, stateStore, log = console.log, json = false }) {
  const catRes = await client.catIndices();
  if (!catRes.ok) throw new Error(`plan: _cat/indices failed: ${describeErr(catRes)}`);
  // Deliberately NOT pre-filtering system indices out here -- "list every index" means every index;
  // classifyRow() labels them SYSTEM (and skips the mapping GET for them below) so the audit is
  // complete rather than silently incomplete for a class of index this tool will never touch anyway.
  const rows = [];
  for (const cr of catRes.json || []) {
    const index = cr.index;
    let mappingProps = {};
    if (!isSystemIndex(index)) {
      const g = await client.getIndex(index);
      mappingProps = g.ok ? g.json?.[index]?.mappings?.properties || {} : {};
    }
    let statePhase = null;
    if (!isTwinIndex(index)) {
      const st = await stateStore.get(index).catch(() => null);
      statePhase = st?.phase ?? null;
    }
    const classified = classifyRow({ index, mappingProps, statePhase });
    rows.push({
      index,
      docsCount: cr["docs.count"] != null ? Number(cr["docs.count"]) : null,
      storeSizeBytes: cr["store.size"] != null ? Number(cr["store.size"]) : null,
      ...classified,
    });
  }
  if (json) log(JSON.stringify(rows, null, 2));
  else log(renderPlanTable(rows));
  return rows;
}

// ============================================================================================
// migrate (the mutating pipeline; every mutating step is gated on --commit, and the swap itself is
// further gated on state.phase === "verified" -- see the header comment for why that is the load-
// bearing invariant)
// ============================================================================================

async function ensureTwinCreated(client, state, { index, twin, field, def, compressionLevel }) {
  const twinGet = await client.getIndex(twin);
  if (twinGet.ok) {
    const twinDef = twinGet.json?.[twin]?.mappings?.properties?.[field];
    if (!twinDef || !isOnDiskMode(twinDef)) {
      throw new Error(`twin index '${twin}' already exists but is NOT a quantized '${field}' field; refusing to reindex into it -- inspect/delete it manually`);
    }
    return withPhase(state, "twin_created", "twin already existed and is the expected quantized shape");
  }
  if (twinGet.status !== 404) throw new Error(`GET /${twin} failed unexpectedly: ${describeErr(twinGet)}`);

  const srcGet = await client.getIndex(index);
  if (!srcGet.ok) throw new Error(`GET /${index} failed while building the twin body: ${describeErr(srcGet)}`);
  const body = buildTwinIndexBody(srcGet.json[index], field, def, compressionLevel);
  const create = await client.createIndex(twin, body);
  if (!create.ok) throw new Error(`create twin '${twin}' failed: ${describeErr(create)}`);
  return withPhase(state, "twin_created", `created ${twin}`);
}

/** The full per-index pipeline. Never throws -- every failure is caught, persisted to state, and
 *  returned as `{ok:false, ...}` so `migrate --all` can continue past one bad room. `commit=false`
 *  (the default) stops after verification and reports what WOULD happen; nothing before `--commit`
 *  ever mutates `index` itself, only `twin`. */
export async function runMigrateOne(index, opts) {
  const {
    client,
    stateStore,
    log = console.log,
    commit = false,
    compressionLevel = DEFAULT_COMPRESSION_LEVEL,
    minOverlapPct = DEFAULT_MIN_OVERLAP_PCT,
    includePrivileged = false,
  } = opts;

  if (isSystemIndex(index) || isTwinIndex(index)) {
    return { index, ok: false, skipped: true, reason: "refusing to operate on a system or twin-scratch index directly" };
  }
  if (isPrivilegedRoom(index) && !includePrivileged) {
    return { index, ok: false, skipped: true, reason: "privileged room (finance-MNPI / attorney-privileged); pass --include-privileged to migrate it deliberately" };
  }
  try {
    validateCompressionLevel(compressionLevel);
  } catch (e) {
    return { index, ok: false, reason: e.message };
  }

  const twin = twinName(index);
  let state = (await stateStore.get(index)) || initialState({ index, twin, compressionLevel });
  let field = state.vector_field || null;

  try {
    // Once a resume lands in or past SWAP_PHASES, the original `index` has already been (or is
    // about to be) deleted -- GET-ing and re-validating it against the OLD fp32 mapping is not just
    // unnecessary at that point, it is IMPOSSIBLE (the index legitimately does not exist mid-swap)
    // and must not be treated as a fresh failure. `field` for those phases comes from `state`,
    // persisted back at twin-creation time below; the swap steps never need the fp32 `def` itself
    // (the quantized shape they recreate `index` with comes from the TWIN's own live mapping).
    const resumeAt = resumablePhase(state);
    if (resumeAt) {
      state = withPhase(state, resumeAt, `resuming mid-swap after a failure recorded in ${resumeAt}`);
      await save();
      log(`  '${index}': resuming mid-swap at ${resumeAt} (original may already be deleted; twin holds the data)`);
    }
    if (!SWAP_PHASES.includes(state.phase)) {
      const srcGet = await client.getIndex(index);
      if (!srcGet.ok) return await fail(`GET /${index} failed: ${describeErr(srcGet)}`);
      const body = srcGet.json[index];
      const found = findVectorField(body?.mappings?.properties || {});
      if (!found) return { index, ok: true, skipped: true, reason: "no knn_vector field on this index; nothing to quantize" };
      const def = found.def;
      field = found.field;
      if (isOnDiskMode(def)) return { index, ok: true, skipped: true, reason: "already quantized (mode=on_disk)" };

      state = { ...state, vector_field: field, dimension: def.dimension, space_type: extractSpaceType(def) };

      if (state.phase === "planned" || state.phase === "failed") {
        const [catIdx, catAlloc] = await Promise.all([client.catIndices(), client.catAllocation()]);
        if (!catIdx.ok) return await fail(`disk-safety check failed: _cat/indices: ${describeErr(catIdx)}`);
        if (!catAlloc.ok) return await fail(`disk-safety check failed: _cat/allocation: ${describeErr(catAlloc)}`);
        const row = (catIdx.json || []).find((r) => r.index === index);
        const safety = diskSafetyCheck(sumAvailableBytes(catAlloc.json), row ? Number(row["store.size"]) : null);
        if (!safety.ok) return await fail(`refusing to start: ${safety.reason}`);
        state = withPhase(state, "creating_twin", "disk safety check passed");
        await save();
      }

      if (state.phase === "creating_twin") {
        state = await ensureTwinCreated(client, state, { index, twin, field, def, compressionLevel });
        await save();
      }

      if (state.phase === "twin_created" || state.phase === "reindexing") {
        state = withPhase(state, "reindexing");
        await save();
        const conv = await reindexUntilCountsConverge(client, { source: index, dest: twin }, { log });
        if (!conv.ok) return await fail(conv.reason);
        state = { ...withPhase(state, "reindex_done", `converged at ${conv.dstCount} docs (${conv.attempts} attempt(s))`), source_doc_count: conv.srcCount, twin_doc_count: conv.dstCount };
        await save();
      }

      if (state.phase === "reindex_done" || state.phase === "verifying") {
        state = withPhase(state, "verifying");
        await save();
        const v = await verifyParity(client, { sourceIndex: index, destIndex: twin, vectorField: field, minOverlapPct });
        if (!v.ok) return await fail(`verification failed: ${v.reason}`);
        state = { ...withPhase(state, "verified", `overlap ${v.overlapPct}%, ${v.sampleChecked} doc(s) sampled`), overlap_pct: v.overlapPct };
        await save();
      }
    } else if (!field) {
      return await fail("resuming mid-swap but no vector_field recorded in state; cannot proceed safely -- inspect state manually");
    }

    if (!commit) {
      // A resume that lands here already at/past "verified" from an EARLIER --commit run (killed
      // mid-swap) is a real, if unusual, case -- the generic "created + reindexed + verified, ready
      // to swap" wording below would be actively wrong (the swap may already be partially done, or
      // even finished), so it gets its own accurate message instead of reporting stale pre-swap state.
      if (SWAP_PHASES.includes(state.phase) || state.phase === "complete") {
        return { index, ok: true, phase: state.phase, dryRun: true, message: `'${index}' is already mid-swap or complete (phase: ${state.phase}) from a prior --commit run; re-run with --commit to continue/finish it.` };
      }
      return {
        index, ok: true, phase: state.phase, dryRun: true,
        message: `dry run: '${twin}' created + reindexed + verified (${state.source_doc_count} docs, kNN overlap ${state.overlap_pct}%). Re-run with --commit to swap '${index}' onto the quantized mapping.`,
      };
    }

    // ---- swap (only reachable at/after "verified" -- see header comment) ----
    if (state.phase === "verified") { state = withPhase(state, "swap_deleted_original"); await save(); }

    if (state.phase === "swap_deleted_original") {
      // Resuming a process that died AFTER this delete succeeded but before the phase advanced past
      // it lands right back here and calls deleteIndex() again -- OpenSearch answers that with a
      // plain 404, which the check below treats as success rather than a new failure.
      const del = await client.deleteIndex(index);
      if (!del.ok && del.status !== 404) return await fail(`deleting original '${index}' before swap failed: ${describeErr(del)}`);
      state = withPhase(state, "swap_recreated_target", del.status === 404 ? "already deleted (resume)" : "deleted");
      await save();
    }

    if (state.phase === "swap_recreated_target") {
      const targetGet = await client.getIndex(index);
      if (targetGet.ok) {
        const tf = targetGet.json?.[index]?.mappings?.properties?.[field];
        if (!tf || !isOnDiskMode(tf)) return await fail(`'${index}' was recreated but is not the expected quantized shape; manual intervention needed`);
      } else if (targetGet.status === 404) {
        const twinGet = await client.getIndex(twin);
        if (!twinGet.ok) return await fail(`twin '${twin}' unreadable while recreating '${index}': ${describeErr(twinGet)}`);
        const twinBody = twinGet.json[twin];
        const recreateBody = { settings: { index: sanitizeIndexSettings(twinBody.settings?.index || {}) }, mappings: twinBody.mappings };
        const create = await client.createIndex(index, recreateBody);
        if (!create.ok) return await fail(`recreating '${index}' with the quantized mapping failed: ${describeErr(create)}`);
      } else {
        return await fail(`GET /${index} failed while recreating it: ${describeErr(targetGet)}`);
      }
      state = withPhase(state, "swap_reindexing_back");
      await save();
    }

    if (state.phase === "swap_reindexing_back") {
      const conv = await reindexUntilCountsConverge(client, { source: twin, dest: index }, { log, liveSide: "dest" });
      if (!conv.ok) return await fail(`reindexing '${twin}' back onto '${index}' failed: ${conv.reason}`);
      state = withPhase(state, "swap_reverifying", `converged at ${conv.dstCount} docs`);
      await save();
    }

    if (state.phase === "swap_reverifying") {
      const v = await verifyParity(client, { sourceIndex: twin, destIndex: index, vectorField: field, minOverlapPct });
      if (!v.ok) return await fail(`post-swap verification failed (twin vs. recreated original): ${v.reason}`);
      state = withPhase(state, "cleanup_pending", `post-swap overlap ${v.overlapPct}%`);
      await save();
    }

    if (state.phase === "cleanup_pending") {
      const del = await client.deleteIndex(twin);
      if (!del.ok && del.status !== 404) {
        return await fail(`swap succeeded but deleting the now-redundant twin '${twin}' failed: ${describeErr(del)}. Safe to delete '${twin}' manually, or re-run this command.`);
      }
      state = withPhase(state, "complete", "twin deleted");
      await save();
    }

    return { index, ok: true, phase: state.phase, message: `'${index}' is now quantized (compression_level=${state.compression_level}); twin cleaned up.` };
  } catch (e) {
    return await fail(`unexpected error: ${e?.message || e}`);
  }

  async function fail(reason) {
    state = withFailure(state, reason);
    await stateStore.put(index, state).catch(() => {}); // best-effort; never mask the real error with a state-write error
    return { index, ok: false, phase: state.phase, reason };
  }
  async function save() {
    await stateStore.put(index, state);
  }
}

/** `migrate --all`: enumerate every index, exclude system/twin/privileged(unless opted in)/already-
 *  quantized, sort ascending by store size ("smallest first"), and run runMigrateOne sequentially.
 *  ONE index's failure never stops the run (each is independently reported); the overall exit code
 *  (via `ok`) reflects whether ANY index failed, so unattended/CI-style callers still see a failure
 *  signal even though forward progress on the other rooms was preserved. */
export async function runMigrateAll(opts) {
  const { client, stateStore, log = console.log, includePrivileged = false } = opts;
  const catRes = await client.catIndices();
  if (!catRes.ok) throw new Error(`migrate --all: _cat/indices failed: ${describeErr(catRes)}`);
  const candidates = [];
  for (const row of catRes.json || []) {
    const index = row.index;
    if (isSystemIndex(index) || isTwinIndex(index)) continue;
    if (isPrivilegedRoom(index) && !includePrivileged) {
      log(`[quantize] skipping '${index}': privileged room, pass --include-privileged to include it`);
      continue;
    }
    const g = await client.getIndex(index);
    const props = g.ok ? g.json?.[index]?.mappings?.properties || {} : {};
    let found;
    try { found = findVectorField(props); } catch { found = null; }
    if (!found) continue;
    if (isOnDiskMode(found.def)) continue;
    candidates.push({ index, storeSizeBytes: Number(row["store.size"]) || 0 });
  }
  candidates.sort((a, b) => a.storeSizeBytes - b.storeSizeBytes);
  log(`[quantize] migrate --all: ${candidates.length} index(es) queued (smallest first): ${candidates.map((c) => c.index).join(", ") || "(none)"}`);

  const results = [];
  for (const { index } of candidates) {
    log(`[quantize] -- ${index} --`);
    let result;
    try {
      result = await runMigrateOne(index, opts);
    } catch (e) {
      result = { index, ok: false, reason: `runMigrateOne threw unexpectedly: ${e?.message || e}` };
    }
    log(`[quantize]    ${result.ok ? "OK" : "FAILED"}: ${result.message || result.reason || ""}`);
    results.push(result);
  }
  const ok = results.every((r) => r.ok || r.skipped);
  return { ok, results };
}

// ============================================================================================
// rollback
// ============================================================================================

/** If `<index>--q` exists and `<index>` is missing, recreate `<index>` from the twin's (already
 *  quantized) mapping and reindex the twin back onto it. If `<index>` exists but looks "broken"
 *  (doc count far short of the twin's, or its vector field is gone/malformed), this refuses to
 *  overwrite it automatically -- an index that exists but differs from the twin might hold data the
 *  twin does not, and silently clobbering it would be the exact kind of destructive guess this whole
 *  tool exists to avoid. Pass `force:true` to override that refusal and reindex anyway. Never
 *  deletes the twin itself -- rollback is a safety valve, not a cleanup step. */
export async function runRollback(index, opts) {
  const { client, log = console.log, commit = false, force = false } = opts;
  const twin = twinName(index);
  const twinGet = await client.getIndex(twin);
  if (!twinGet.ok) return { index, ok: false, reason: `twin '${twin}' does not exist; nothing to roll back from` };
  const twinBody = twinGet.json[twin];
  const twinCount = await client.count(twin);
  if (!twinCount.ok) return { index, ok: false, reason: `could not count '${twin}': ${describeErr(twinCount)}` };

  const targetGet = await client.getIndex(index);
  let situation;
  if (!targetGet.ok && targetGet.status === 404) situation = "missing";
  else if (!targetGet.ok) return { index, ok: false, reason: `GET /${index} failed: ${describeErr(targetGet)}` };
  else {
    const targetCount = await client.count(index);
    const shortfall = targetCount.ok && twinCount.count > 0 ? (twinCount.count - targetCount.count) / twinCount.count : 0;
    situation = shortfall > 0.01 || !targetCount.ok ? "broken" : "healthy";
  }

  if (situation === "healthy") return { index, ok: true, skipped: true, reason: `'${index}' looks healthy relative to '${twin}'; rollback not needed` };
  if (situation === "broken" && !force) {
    return { index, ok: false, reason: `'${index}' exists but looks broken relative to '${twin}'; refusing to overwrite it without --force (it may hold data the twin does not)` };
  }
  if (!commit) {
    return { index, ok: true, dryRun: true, message: `dry run: would recreate/repair '${index}' from '${twin}' (situation: ${situation}) and reindex it back. Re-run with --commit to do it.` };
  }

  if (situation === "broken") {
    const del = await client.deleteIndex(index);
    if (!del.ok && del.status !== 404) return { index, ok: false, reason: `deleting broken '${index}' failed: ${describeErr(del)}` };
  }
  const recreate = await client.createIndex(index, { settings: { index: sanitizeIndexSettings(twinBody.settings?.index || {}) }, mappings: twinBody.mappings });
  if (!recreate.ok && recreate.status !== 400) return { index, ok: false, reason: `recreating '${index}' failed: ${describeErr(recreate)}` };
  const conv = await reindexUntilCountsConverge(client, { source: twin, dest: index }, { log, liveSide: "dest" });
  if (!conv.ok) return { index, ok: false, reason: `reindexing '${twin}' back onto '${index}' failed: ${conv.reason}` };
  const field = findVectorField(twinBody.mappings?.properties || {})?.field;
  const v = field ? await verifyParity(client, { sourceIndex: twin, destIndex: index, vectorField: field }) : { ok: true, overlapPct: null };
  if (!v.ok) return { index, ok: false, reason: `post-rollback verification failed: ${v.reason}` };
  return { index, ok: true, message: `'${index}' restored from '${twin}' (${conv.dstCount} docs, overlap ${v.overlapPct}%). '${twin}' left in place.` };
}

// ============================================================================================
// CLI
// ============================================================================================

const USAGE = `Usage:
  node quantize-indices.mjs plan [--json]
  node quantize-indices.mjs migrate --index <name> [--commit] [--compression 32x] [--include-privileged] [--min-overlap-pct 90]
  node quantize-indices.mjs migrate --all [--commit] [--compression 32x] [--include-privileged] [--min-overlap-pct 90]
  node quantize-indices.mjs rollback --index <name> [--commit] [--force]

Without --commit, migrate/rollback are dry runs: they report exactly what they would do and mutate
nothing beyond the scratch twin index ('<name>--q'). Privileged finance/legal rooms are excluded by
default; see PRIVILEGED_ROOMS in this file.`;

/** Pure. Parses argv into a validated options object, or returns `{errors:[...]}` -- never throws,
 *  never touches process.exit (the CLI entrypoint at the bottom of this file owns that). */
export function parseArgs(argv) {
  const args = Array.isArray(argv) ? [...argv] : [];
  const cmd = args.shift();
  const out = { cmd, index: null, all: false, commit: false, compression: DEFAULT_COMPRESSION_LEVEL, includePrivileged: false, minOverlapPct: DEFAULT_MIN_OVERLAP_PCT, json: false, force: false, errors: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--index") out.index = args[++i];
    else if (a === "--all") out.all = true;
    else if (a === "--commit") out.commit = true;
    else if (a === "--compression") out.compression = args[++i];
    else if (a === "--include-privileged") out.includePrivileged = true;
    else if (a === "--min-overlap-pct") out.minOverlapPct = Number(args[++i]);
    else if (a === "--json") out.json = true;
    else if (a === "--force") out.force = true;
    else out.errors.push(`unrecognized argument: ${a}`);
  }
  if (!["plan", "migrate", "rollback"].includes(cmd)) out.errors.push(`unknown command '${cmd || ""}'`);
  if (cmd === "migrate") {
    if (out.all && out.index) out.errors.push("migrate: pass either --index <name> or --all, not both");
    if (!out.all && !out.index) out.errors.push("migrate: requires --index <name> or --all");
    try { if (out.compression) validateCompressionLevel(out.compression); } catch (e) { out.errors.push(e.message); }
    if (!Number.isFinite(out.minOverlapPct) || out.minOverlapPct < 0 || out.minOverlapPct > 100) out.errors.push("--min-overlap-pct must be a number between 0 and 100");
  }
  if (cmd === "rollback" && !out.index) out.errors.push("rollback: requires --index <name>");
  return out;
}

function printResult(result, log) {
  if (result.skipped) log(`[quantize] ${result.index}: SKIPPED -- ${result.reason}`);
  else if (result.dryRun) log(`[quantize] ${result.index}: DRY RUN -- ${result.message}`);
  else if (result.ok) log(`[quantize] ${result.index}: OK -- ${result.message}`);
  else log(`[quantize] ${result.index}: FAILED -- ${result.reason}`);
}

/** The CLI entrypoint, importable so tests can call it with injected `client`/`stateStore`/`log`
 *  instead of a real cluster (mirrors monitor.mjs's runSweep(opts) DI convention). Returns a process
 *  exit CODE; never calls process.exit itself. */
export async function main(argv, io = {}) {
  const args = parseArgs(argv);
  const log = io.log || console.log;
  if (args.errors.length) {
    for (const e of args.errors) console.error(`[quantize-indices] ${e}`);
    console.error(USAGE);
    return 2;
  }
  // An injected client (tests, or a caller that already built one) must never trigger live config
  // resolution: resolveOpenSearchConfig() reaches for AWS credentials and throws where none exist
  // (CI), which is exactly what the injected client is there to avoid.
  const cfg = io.cfg || (io.client ? null : await resolveOpenSearchConfig());
  const client = io.client || makeClient(cfg);
  const stateStore = io.stateStore || makeStateStore();

  if (args.cmd === "plan") {
    await runPlan({ client, stateStore, log, json: args.json });
    return 0;
  }
  if (args.cmd === "migrate") {
    if (args.all) {
      const summary = await runMigrateAll({ client, stateStore, log, commit: args.commit, compressionLevel: args.compression, includePrivileged: args.includePrivileged, minOverlapPct: args.minOverlapPct });
      for (const r of summary.results) printResult(r, log);
      return summary.ok ? 0 : 1;
    }
    const result = await runMigrateOne(args.index, { client, stateStore, log, commit: args.commit, compressionLevel: args.compression, includePrivileged: args.includePrivileged, minOverlapPct: args.minOverlapPct });
    printResult(result, log);
    return result.ok || result.skipped ? 0 : 1;
  }
  if (args.cmd === "rollback") {
    const result = await runRollback(args.index, { client, log, commit: args.commit, force: args.force });
    printResult(result, log);
    return result.ok ? 0 : 1;
  }
  console.error(`[quantize-indices] unknown command: ${args.cmd}`);
  console.error(USAGE);
  return 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main(process.argv.slice(2))
    .then((code) => { process.exitCode = code; })
    .catch((e) => { console.error("[quantize-indices] FATAL:", e?.stack || e); process.exitCode = 1; });
}
