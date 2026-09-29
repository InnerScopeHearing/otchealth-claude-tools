// chunking.mjs -- the PURE chunked-room helpers push-search uses, extracted from indexer.mjs
// (2026-09-29, brain-save directive) so another tool can build byte-identical chunk documents WITHOUT
// importing indexer.mjs (whose top-level argv/profile/env validation runs as a side effect of import).
// indexer.mjs imports and re-exports every symbol here, so its own callers and tests are unchanged.
// See indexer.mjs's "CHUNKED-room ingest (2026-08-28)" header for the live evidence behind every field,
// size, and id choice below; skills/brain-save/ pins parity with a unit test (same chunk ids, same fields)
// so a nightly push-search and a brain-save push of the same object converge instead of duplicating.
import crypto from "node:crypto";
import { basename } from "node:path";

// The two knn_vector field names a doc room can carry on OpenSearch: FLAT rooms (one doc per record)
// use contentVector, CHUNKED rooms (one doc per chunk, linked by parent_id) use text_vector.
export const OS_VECTOR_FIELD_FLAT = "contentVector";
export const OS_VECTOR_FIELD_CHUNKED = "text_vector";

/** Classify a room's live shape from its `_mapping` response body (the SAME REST shape osGetMapping()
 *  returns): 'chunked' (carries text_vector -- fed by enrich.mjs / the migration bulk loader, never by
 *  push-search), 'flat' (carries contentVector -- what push-search itself creates/maintains), or
 *  'unknown' (the index exists but neither vector field is mapped yet -- a room created but never
 *  written to under either shape). Pure -- no network -- so the decision is directly unit-testable
 *  without a live cluster. `index` is the index name (OpenSearch nests the mapping response under it). */
export function classifyRoomShape(mappingJson, index) {
  const props = mappingJson?.[index]?.mappings?.properties || {};
  if (props[OS_VECTOR_FIELD_CHUNKED]) return "chunked";
  if (props[OS_VECTOR_FIELD_FLAT]) return "flat";
  return "unknown";
}

export function dirnameBelowRoot(path) {
  // Mirrors enrich.mjs's own private dirnameBelowRoot() exactly (this codebase's established
  // convention is a small parallel copy per file rather than a cross-file import for tiny
  // profile/path helpers -- see indexer.mjs's and enrich.mjs's own separately-maintained
  // PROFILES/STORAGE_PROFILES tables for the same pattern).
  const parts = String(path || "").split("/");
  parts.pop();
  return parts.join("/");
}

/** Word count matching enrich.mjs's own definition exactly. Pure, exported for a direct unit test
 *  and so a caller can compute it ONCE on the full sidecar text and reuse it across every chunk of
 *  that document (see buildChunkDocs -- word_count is a per-DOCUMENT value, not per-chunk). */
export function countWords(text) {
  return ((text || "").match(/\S+/g) || []).length;
}

/** Find the best split point in `text` within (from, to]: the last paragraph break, else the last
 *  sentence-ending punctuation, else the last newline, else the last plain space -- in that
 *  preference order -- so a chunk boundary never falls mid-word. Returns -1 when the window has no
 *  usable boundary at all (the caller then hard-cuts at `to`; this only happens for a pathological
 *  run of text with no whitespace anywhere in the lookback window, e.g. a very long URL or hash). */
export function findChunkBreak(text, from, to) {
  const window = text.slice(from, to);
  const para = window.lastIndexOf("\n\n");
  if (para > 0) return from + para + 2;
  let sentenceEnd = -1;
  for (const m of window.matchAll(/[.!?]["')\]]?\s+/g)) sentenceEnd = from + m.index + m[0].length;
  if (sentenceEnd > from) return sentenceEnd;
  const nl = window.lastIndexOf("\n");
  if (nl > 0) return from + nl + 1;
  const sp = window.lastIndexOf(" ");
  if (sp > 0) return from + sp + 1;
  return -1;
}

/** Split `text` into overlapping chunks of at most `maxChunkSize` characters each, with consecutive
 *  chunks overlapping by roughly `overlap` characters. Pure, exported for direct unit testing.
 *  Defaults (2000/200) match the live-measured chunked-room corpus -- see this section's header.
 *
 *  Prefers a paragraph/sentence/whitespace boundary near the target size (findChunkBreak) over a
 *  hard character cut, and snaps the START of the next chunk's overlap forward to the next
 *  whitespace run too, so neither the END of one chunk nor the START of the next ever falls
 *  mid-word except in a pathological no-whitespace run.
 *
 *  Returns [] for empty/whitespace-only input (a document with no real text must never produce a
 *  garbage chunk) and [text] unchanged when it already fits in one chunk (no spurious overlap on a
 *  short document -- matches buildFlatSearchDoc()'s own "no chunking needed" precedent for a flat
 *  room's single-document case). */
export function chunkText(text, opts = {}) {
  const maxChunkSize = Math.max(1, Math.floor(opts.maxChunkSize ?? 2000));
  const overlap = Math.max(0, Math.min(Math.floor(opts.overlap ?? 200), Math.floor(maxChunkSize / 2)));
  const t = String(text == null ? "" : text);
  if (!t.trim()) return [];
  if (t.length <= maxChunkSize) return [t];

  const LOOKBACK = Math.max(1, Math.floor(maxChunkSize * 0.3));
  const chunks = [];
  let start = 0;
  while (start < t.length) {
    let end = Math.min(start + maxChunkSize, t.length);
    if (end < t.length) {
      const bp = findChunkBreak(t, Math.max(start, end - LOOKBACK), end);
      if (bp > start) end = bp;
    }
    chunks.push(t.slice(start, end));
    if (end >= t.length) break;
    let next = end - overlap;
    if (next > start) {
      const m = t.slice(next, Math.min(next + 60, end)).search(/\s/);
      if (m >= 0) next += m + 1;
    }
    if (next <= start) next = end; // guarantee forward progress even on a pathological input
    start = next;
  }
  return chunks;
}

/** Build the OpenSearch chunk documents for ONE catalog row, given its text already split into
 *  `chunks` (see chunkText). Field-for-field the structural subset this section's header describes
 *  -- never an enrichment field (those are enrich.mjs's job, run separately, later; see the LEGAL
 *  WALL note above). Pure (no I/O; `vectors`/`wordCount` are passed in) so the exact document shape
 *  is directly assertable in a unit test with no live cluster or embedding call.
 *
 *  `vectors[i]`, when given, becomes chunk i's text_vector; a caller that has not embedded yet (or
 *  whose embed call failed) may omit `vectors` entirely and add it to the returned docs itself, or
 *  pass a sparse/undefined entry -- this function does not require every chunk to have a vector, it
 *  only ever sets the field when one is actually provided. */
export function buildChunkDocs(row, chunks, opts = {}) {
  const { account, container, vectors = [], wordCount = 0 } = opts;
  const parentId = crypto.createHash("sha1").update(row.path).digest("hex");
  const fullPath = `${account}/${container}/${row.path}`;
  const baseTitle = row.title || basename(row.path);
  const sourcePath = dirnameBelowRoot(row.path);
  return chunks.map((chunkStr, i) => {
    const chunk_id = `${parentId}_${i}`;
    const doc = {
      id: chunk_id,
      chunk_id,
      parent_id: parentId,
      path: fullPath,
      source_path: sourcePath,
      title: baseTitle,
      doc_title: baseTitle,
      chunk: chunkStr,
      content_hash: row.sha256 || "",
      entity: row.entity || "",
      word_count: wordCount,
    };
    if (vectors[i]) doc[OS_VECTOR_FIELD_CHUNKED] = vectors[i];
    return doc;
  });
}
