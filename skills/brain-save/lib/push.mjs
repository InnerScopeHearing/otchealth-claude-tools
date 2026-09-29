// push.mjs -- chunk + embed + bulk push ONE stored object into commons-company-journal.
// PARITY CONTRACT with the nightly indexer: the row is exactly what runIndex() would catalog for this
// object ({path: key, entity: "_KNOWLEDGE", title: basename(key), sha256: sha256(object bytes)}) and the
// chunks come from the SAME chunkText/buildChunkDocs (skills/doc-indexer/chunking.mjs) at 2000/200, so
// parent_id = sha1(key) and chunk ids match a nightly push or --reindex exactly: nightly converges on
// brain-save's output instead of duplicating it. tests/push.test.mjs pins this.
// ATOMICITY: every chunk of a document is embedded BEFORE any is pushed; a partial embed or partial
// bulk failure deletes that parent's chunks. Never writes _CATALOG/ or _TEXT/ (the nightly index owns those).
import { basename } from "node:path";
import { chunkText, buildChunkDocs, countWords } from "../../doc-indexer/chunking.mjs";
import { sha1, sha256, ROOM_ACCOUNT, ROOM_CONTAINER } from "./provenance.mjs";

export const CHUNK_MAX = 2000;
export const CHUNK_OVERLAP = 200;
const EMB_BATCH = 16;
const PUSH_BATCH = 64;

export function rowForKey(key, objectText) {
  return { path: key, entity: key.split("/")[0] || "(root)", title: basename(key), sha256: sha256(Buffer.from(objectText, "utf8")) };
}
export const parentIdFor = (key) => sha1(key);

/** Pure: the exact chunk docs (without vectors) for a stored object. */
export function chunkDocsFor(key, objectText, vectors = []) {
  const chunks = chunkText(objectText, { maxChunkSize: CHUNK_MAX, overlap: CHUNK_OVERLAP });
  return buildChunkDocs(rowForKey(key, objectText), chunks, { account: ROOM_ACCOUNT, container: ROOM_CONTAINER, vectors, wordCount: countWords(objectText) });
}

let _shapeChecked = false;
export function _resetShapeCacheForTests() { _shapeChecked = false; }

/** Never create or alter the room mapping: abort unless the live room is CHUNKED. */
export async function assertChunkedRoom(backend) {
  if (_shapeChecked) return;
  const shape = await backend.roomShape();
  if (shape !== "chunked") {
    const err = new Error(`commons-company-journal live mapping is "${shape}", not "chunked"; brain-save never creates or alters the room mapping`);
    err.exit = 3;
    throw err;
  }
  _shapeChecked = true;
}

/** Embed + push. Returns {chunks}. Throws (after cleaning up this parent's chunks) on any failure. */
export async function pushObject(backend, key, objectText) {
  await assertChunkedRoom(backend);
  const chunks = chunkText(objectText, { maxChunkSize: CHUNK_MAX, overlap: CHUNK_OVERLAP });
  if (!chunks.length) throw new Error(`no text to push for ${key}`);
  const vectors = [];
  for (let i = 0; i < chunks.length; i += EMB_BATCH) {
    const v = await backend.embed(chunks.slice(i, i + EMB_BATCH));
    if (!Array.isArray(v) || v.length !== Math.min(EMB_BATCH, chunks.length - i)) throw new Error(`embedding returned ${Array.isArray(v) ? v.length : "no"} vectors for ${key}`);
    vectors.push(...v);
  }
  const docs = buildChunkDocs(rowForKey(key, objectText), chunks, { account: ROOM_ACCOUNT, container: ROOM_CONTAINER, vectors, wordCount: countWords(objectText) });
  try {
    for (let i = 0; i < docs.length; i += PUSH_BATCH) {
      const r = await backend.pushDocs(docs.slice(i, i + PUSH_BATCH));
      if (!r || !r.ok) throw new Error(`bulk push failed: ${JSON.stringify((r && r.errors || []).slice(0, 2)).slice(0, 300)}`);
    }
  } catch (e) {
    try { await backend.deleteByParent(parentIdFor(key)); } catch { /* best-effort cleanup; the error below is what matters */ }
    throw e;
  }
  // Converge: chunk ids are `<parent_id>_<n>`, so re-pushing a key whose text changed length (a header
  // correction on an existing key, an audit --repair of a re-written object) upserts 0..n-1 but would
  // leave n.. from the previous push behind. Remove exactly the ids this push did not write.
  let pruned = 0;
  try { pruned = await backend.deleteByParent(parentIdFor(key), { keepIds: new Set(docs.map((d) => String(d.id))) }); }
  catch { /* a stale tail chunk is harmless to the proof; audit reports chunk-count drift */ }
  return { chunks: docs.length, pruned };
}
