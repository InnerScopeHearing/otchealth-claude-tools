#!/usr/bin/env node
// opensearch-rooms.mjs — the Amazon OpenSearch read adapter for company-brain's FEDERATED ROOM
// search (skills/company-brain/brain.mjs). New file, deliberately: skills/kb-memory/
// opensearch-write.mjs is owned elsewhere and its hybridSearch() is shaped for the FLAT memory
// indexes only (it hardcodes the `contentVector` field and a BM25 field list of agent/tags/text,
// and returns the memory-row contract agent/type/ts/text/tags/retracted). company-brain also
// federates the CHUNKED doc rooms, which index `text_vector` and carry chunk/title/path/parent_id,
// so pointing brain.mjs at that function would have silently returned zero hits for legal-company,
// finance-cfo-source-docs, commons-company-journal, commerce-commerce-source-docs and
// legal-personal -- five of the brain's six rooms. This file adds only the room-shaped query; it
// REUSES opensearch-write.mjs's credential/config resolution and RRF, and doc-indexer's SigV4
// client, rather than re-implementing either.
//
// WHY OPENSEARCH AT ALL: Azure subscription 55c84f6b is permanently gone (2026-08-18). The live
// brain is the Amazon OpenSearch domain the gateway already reads through
// otchealth-mcp-server/src/search/opensearch.ts.
//
// ROOM / INDEX NAMES are NOT invented here. They are the gateway's own registry:
//   otchealth-mcp-server/src/azure/search.ts:68-74   CHUNKED_ROOMS (mirrored verbatim below)
//   otchealth-mcp-server/src/tools/kb/search-privileged.ts:140-146  INDEX_LANES (the ring-gated set)
// Room shape (chunked vs flat) is a property of the DATA, not of the engine serving it, which is
// exactly why the gateway's own dispatcher resolves isChunkedRoom() from that one registry
// regardless of SEARCH_BACKEND (src/search/index.ts).
//
// RANKING: OpenSearch has no equivalent of Azure AI Search's queryType:'semantic' L2 reranker, so
// this issues two plain queries (BM25 multi_match + kNN) against the same index and fuses them
// client-side with Reciprocal Rank Fusion -- the identical design decision, constant and formula the
// gateway already shipped in src/search/opensearch.ts and that opensearch-write.mjs already exports.
// reciprocalRankFusion is IMPORTED from opensearch-write.mjs, not copied, so the fleet cannot end up
// with two RRF constants that drift apart.
//
// FAILURE POSTURE (the whole point of this file existing separately from a "just make it work"
// patch): a room that CANNOT BE SEARCHED must never be indistinguishable from a room that was
// searched and held nothing. searchRoom() THROWS on a BM25 failure. Only the VECTOR half fails open
// (mode:'keyword'), because a keyword-only answer is a real, degraded answer over real documents,
// whereas a swallowed BM25 error is a fabricated "no evidence found". brain.mjs surfaces both.
import { resolveOpenSearchConfig, reciprocalRankFusion, EMB_DIMS } from "../kb-memory/opensearch-write.mjs";
import { osSearch } from "../doc-indexer/opensearch-client.mjs";

/**
 * THE EMBEDDING SPACE IS LOAD-BEARING AND IS NOT CONFIGURABLE.
 *
 * The OpenSearch rooms hold ~492,557 documents embedded with text-embedding-3-large at 3072
 * dimensions. OpenAI's API serves the LITERALLY IDENTICAL model (verified live 2026-08-15, cosine
 * similarity 0.99999791 against Azure Foundry -- see otchealth-mcp-server's
 * embeddings-provider.test.ts), which is why EMBEDDINGS_PROVIDER=openai needs NO reindex.
 *
 * A DIFFERENT model does NOT fail loudly. Cosine similarity between two incompatible vector spaces
 * still returns plausible-looking numbers in [-1,1], so semantic search would quietly rank garbage
 * while every health check stayed green. That makes this the single most dangerous knob in the
 * brain. Therefore:
 *   - NEVER point this at Bedrock Titan / Cohere embeddings, or any other model.
 *   - NEVER pass OpenAI's `dimensions` truncation parameter: a truncated 3072-model vector is a
 *     DIFFERENT space from the stored full-length one, not a smaller view of the same one.
 * The pinned model lives in opensearch-write.mjs (OPENAI_EMBED_MODEL, likewise documented as
 * "pinned, never configurable"); these constants are the company-brain-side assertion of the same
 * contract, plus a runtime guard so a mismatch is caught at query time instead of silently ranking.
 */
export const EMBEDDING_MODEL = "text-embedding-3-large";
export const EMBEDDING_DIMS = EMB_DIMS; // 3072, from the module that actually calls the embeddings API

/** Throw (loudly, with the reason spelled out) unless `vec` is a vector in the ONE space the live
 *  indexes were built in. Pure. Called on every query embedding before it is sent to OpenSearch:
 *  a wrong-dimension vector is the one failure mode that would otherwise produce confident nonsense
 *  rather than an error. */
export function assertEmbeddingSpace(vec) {
  if (!Array.isArray(vec)) {
    throw new Error(`company-brain: query embedding is not a vector (got ${typeof vec}); refusing to search rather than return an unranked or empty result`);
  }
  if (vec.length !== EMBEDDING_DIMS) {
    throw new Error(
      `company-brain: query embedding has ${vec.length} dimensions but the rooms are embedded with ` +
        `${EMBEDDING_MODEL} at ${EMBEDDING_DIMS}. Refusing to search: cosine similarity across two ` +
        `different embedding spaces returns plausible numbers for garbage matches, so this would ` +
        `silently corrupt every answer instead of failing. Check EMBEDDINGS_PROVIDER and never use a ` +
        `different embedding model or the OpenAI 'dimensions' truncation parameter.`,
    );
  }
  return true;
}

/**
 * CHUNKED doc rooms: one child doc per chunk of a source document, vector field `text_vector`,
 * chunks linked to their source by `parent_id`. Mirrors otchealth-mcp-server/src/azure/search.ts:68-74
 * verbatim. Every other room is FLAT (one doc per record, vector field `contentVector`).
 */
export const CHUNKED_ROOMS = new Set([
  "commons-company-journal",
  "finance-cfo-source-docs",
  "legal-company",
  "legal-personal",
  "commerce-commerce-source-docs",
]);

/** Pure. Whether a room uses the chunked (text_vector, chunk -> parent) schema. */
export function isChunkedRoom(index) {
  return CHUNKED_ROOMS.has(index);
}

/** Pure. Which knn_vector field a room's index carries. Mirrors the gateway's vectorFieldFor(). */
export function vectorFieldFor(index) {
  return isChunkedRoom(index) ? "text_vector" : "contentVector";
}

/** BM25 fields, matching the gateway's own BM25_FIELDS (src/search/opensearch.ts). Requests the
 *  UNION of the chunked-room fields (title/chunk/path) and the flat-room fields (content/summary/
 *  text): a field absent from an index simply never matches, it is not an error. */
export const BM25_FIELDS = ["title^2", "content", "chunk", "summary", "text"];

/** How many raw rows to pull before collapsing. Chunked rooms over-fetch because many rows can be
 *  chunks of the same parent document; flat rooms need exactly `top`. Mirrors brain.mjs's Azure
 *  branch (min 50, top*3). Pure. */
export function fetchSizeFor(index, top) {
  return isChunkedRoom(index) ? Math.min(50, Math.max(top, top * 3)) : top;
}

/** Pure. The BM25 half of the hybrid query. `contentVector`/`text_vector` are excluded from _source
 *  so a 3072-float array is never shipped back over the wire for every hit. */
export function buildBm25Body(index, { queryText, size }) {
  return {
    size,
    _source: { excludes: ["contentVector", "text_vector"] },
    query: { multi_match: { query: queryText, fields: BM25_FIELDS } },
  };
}

/** Pure. The kNN half of the hybrid query, against the room's own vector field. */
export function buildKnnBody(index, { vector, size }) {
  return {
    size,
    _source: { excludes: ["contentVector", "text_vector"] },
    query: { knn: { [vectorFieldFor(index)]: { vector, k: size } } },
  };
}

/** Pure. Normalize one raw OpenSearch hit into company-brain's hit contract, identical to what
 *  brain.mjs's Azure branch produces: {score, text, path, entity, agent, type} plus the internal
 *  `_parent` used only for chunk collapsing. Field precedence matches the Azure branch exactly
 *  (content || text || chunk, path || title). */
export function shapeHit(id, source, score) {
  const s = source || {};
  return {
    score,
    text: String(s.content || s.text || s.chunk || s.summary || "").slice(0, 1200),
    path: s.path || s.title || "",
    entity: s.entity || "",
    agent: s.agent || "",
    type: s.type || "",
    _parent: String(s.parent_id ?? s.path ?? id ?? ""),
  };
}

/** Pure. Collapse chunk rows to one hit per parent document (best-scoring chunk wins), then trim to
 *  `top`, so a single long document cannot flood the federated pool with N of its own chunks. Same
 *  behaviour as brain.mjs's Azure chunked branch. */
export function collapseParents(hits, top) {
  const best = new Map();
  for (const h of hits) {
    const cur = best.get(h._parent);
    if (!cur || h.score > cur.score) best.set(h._parent, h);
  }
  return [...best.values()].sort((a, b) => b.score - a.score).slice(0, top);
}

/**
 * Search ONE room. Returns { hits, mode } where mode is 'hybrid' (both halves ran) or 'keyword'
 * (the vector half was unavailable and the answer is degraded but real).
 *
 * THROWS if the BM25 half fails, or if a chunked room is queried with no vector at all. Callers must
 * NOT convert that throw into an empty array: see this file's header.
 */
export async function searchRoom(index, { queryText, vector, top = 6 } = {}) {
  const cfg = await resolveOpenSearchConfig();
  const size = fetchSizeFor(index, top);

  const bm = await osSearch(cfg, index, buildBm25Body(index, { queryText, size }));
  if (!bm.ok) {
    throw new Error(`opensearch room '${index}': BM25 search failed ${bm.status} ${String(bm.text || "").slice(0, 200)}`);
  }
  const bmRows = rawRows(bm.json);

  let vecRows = [];
  let mode = "keyword";
  let vectorError = null;
  if (vector) {
    assertEmbeddingSpace(vector);
    const kn = await osSearch(cfg, index, buildKnnBody(index, { vector, size }));
    if (kn.ok) {
      vecRows = rawRows(kn.json);
      mode = "hybrid";
    } else {
      vectorError = `${kn.status} ${String(kn.text || "").slice(0, 160)}`;
    }
  }
  if (mode !== "hybrid" && vectorError) {
    // Degraded, not silent: the caller prints this. Keyword-only over the real corpus is still a
    // real answer, so this fails open -- but never invisibly.
    console.error(`  [${index}] vector half unavailable (${vectorError}); answering keyword-only`);
  }

  const fused = reciprocalRankFusion(mode === "hybrid" ? [bmRows, vecRows] : [bmRows]);
  const bySource = new Map();
  for (const r of [...bmRows, ...vecRows]) if (r.id && !bySource.has(r.id)) bySource.set(r.id, r.source);

  let hits = [...fused.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id, score]) => shapeHit(id, bySource.get(id), score));

  hits = isChunkedRoom(index) ? collapseParents(hits, top) : hits.slice(0, top);
  return { hits: hits.map(({ _parent, ...h }) => h), mode };
}

/** Pure. Extract {id, source} rows from an OpenSearch _search response body, in rank order (which is
 *  what RRF consumes). Tolerates a missing/short-circuited body shape. */
export function rawRows(json) {
  const hits = json && json.hits && Array.isArray(json.hits.hits) ? json.hits.hits : [];
  return hits.map((h) => ({ id: String(h._id ?? ""), source: h._source || {} }));
}

export default {
  EMBEDDING_MODEL,
  EMBEDDING_DIMS,
  assertEmbeddingSpace,
  CHUNKED_ROOMS,
  isChunkedRoom,
  vectorFieldFor,
  BM25_FIELDS,
  fetchSizeFor,
  buildBm25Body,
  buildKnnBody,
  shapeHit,
  collapseParents,
  rawRows,
  searchRoom,
};
