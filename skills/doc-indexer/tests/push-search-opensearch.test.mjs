// Tests for skills/doc-indexer/indexer.mjs's push-search / search-init / cloud-search OpenSearch
// port (2026-08-27) -- the same class of fix as skills/kb-memory/tests/index-one-dispatch.test.mjs
// (SEARCH_BACKEND=opensearch is now the default, Azure AI Search died with subscription 55c84f6b),
// applied here to the doc-indexer librarian pipeline's `push-search` command.
//
// TWO layers, matching this repo's own established convention for a hard-to-mock CLI script:
//   1. PURE FUNCTION tests (flatRoomMapping/classifyRoomShape/buildFlatSearchDoc, all exported
//      specifically so this is possible -- see opensearch-write.mjs's memoryIndexMapping() for the
//      same pattern) -- fast, hermetic, no subprocess, no network.
//   2. A full subprocess integration test using the `--import` global-fetch-stub technique
//      index-one-dispatch.test.mjs already proved out, extended here to ALSO mock the S3 storage
//      layer (indexer.mjs's own tests/fail-loud-sidecar.test.mjs called full network mocking "not
//      practical" for this file when it was written in 2026-08-18 -- the --import preload technique,
//      which installs the stub before the script's own top-level code runs, makes it practical now).
//
// EXTENDED 2026-08-28 with the CHUNKED-room ingest path (chunkText/countWords/buildChunkDocs +
// runPushSearchOpenSearchChunked): every real doc room in the fleet turned out to be CHUNKED on
// OpenSearch, so the two tests below that used to assert push-search "cleanly SKIPS" a chunked
// room were the exact behavior this addition replaces -- they are REWRITTEN, not merely
// supplemented, to assert the room now receives real chunk documents instead.
//
// indexer.mjs is a script (heavy top-level argv/profile-table side effects, a `if (import.meta.url
// === file://process.argv[1])` CLI-entrypoint guard), not an importable module in the general case --
// but it DOES already export a few pure helpers for exactly this reason (see isXfaPlaceholder), and
// importing it for those, from a plain `node --test` process, is proven safe by this file's own
// "sanity" test below (mirrors tests/fail-loud-sidecar.test.mjs's and
// tests/storage-backend-default.test.mjs's existing conventions in this same directory).
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as Indexer from "../indexer.mjs";

const execFileP = promisify(execFile);
const HERE = fileURLToPath(new URL(".", import.meta.url));
const INDEXER_MJS = join(HERE, "..", "indexer.mjs");

// =========================================================================================
// Layer 1: pure function tests (no subprocess, no network)
// =========================================================================================

test("flatRoomMapping(): a knn-enabled index with a contentVector knn_vector field at the right dimension -- the exact field vectorFieldFor() expects for a NON-chunked room", () => {
  const m = Indexer.flatRoomMapping(3072);
  assert.equal(m.settings.index.knn, true, "knn must be enabled at index-create time (cannot be added later)");
  const props = m.mappings.properties;
  assert.equal(props.contentVector.type, "knn_vector");
  assert.equal(props.contentVector.dimension, 3072);
  // BM25_FIELDS parity (otchealth-mcp-server/src/search/opensearch.ts): a flat room's query side
  // multi_matches against title/content/summary -- the write side must actually populate those names.
  assert.equal(props.title.type, "text");
  assert.equal(props.content.type, "text");
  assert.equal(props.summary.type, "text");
  // Must NOT accidentally carry the chunked-room field -- a room this function creates is, by
  // definition, never chunked.
  assert.equal(props.text_vector, undefined, "flatRoomMapping must never define the chunked room's vector field");
});

test("flatRoomMapping() dimension defaults to EMB_DIMS (3072, text-embedding-3-large) when called with no argument", () => {
  const m = Indexer.flatRoomMapping();
  assert.equal(m.mappings.properties.contentVector.dimension, 3072);
});

test("classifyRoomShape(): a mapping carrying text_vector is CHUNKED regardless of whatever else it carries", () => {
  const mapping = { "my-room": { mappings: { properties: { text_vector: { type: "knn_vector" }, contentVector: { type: "knn_vector" } } } } };
  assert.equal(Indexer.classifyRoomShape(mapping, "my-room"), "chunked", "text_vector present must win -- a room fed by enrich.mjs's bulk loader is never a flat push target");
});

test("classifyRoomShape(): a mapping carrying only contentVector is FLAT", () => {
  const mapping = { "my-room": { mappings: { properties: { contentVector: { type: "knn_vector" } } } } };
  assert.equal(Indexer.classifyRoomShape(mapping, "my-room"), "flat");
});

test("classifyRoomShape(): a mapping with neither vector field is UNKNOWN, never guessed as flat or chunked", () => {
  const mapping = { "my-room": { mappings: { properties: { id: { type: "keyword" } } } } };
  assert.equal(Indexer.classifyRoomShape(mapping, "my-room"), "unknown");
});

test("classifyRoomShape(): tolerates a missing/malformed mapping body without throwing", () => {
  assert.equal(Indexer.classifyRoomShape({}, "my-room"), "unknown");
  assert.equal(Indexer.classifyRoomShape(null, "my-room"), "unknown");
  assert.equal(Indexer.classifyRoomShape(undefined, "my-room"), "unknown");
});

test("buildFlatSearchDoc(): the exact bulk-payload shape, incl. the vector field NAMED contentVector -- matching vectorFieldFor()'s flat-room expectation and pickText()'s content field", () => {
  const row = { path: "shopify-library/00-index.md", title: "Index", entity: "OTCHealth", category: "commerce", summary: "a summary", material: true, execution_status: "signed", has_signature: true };
  const vector = [0.1, 0.2, 0.3];
  const doc = Indexer.buildFlatSearchDoc(row, "the full extracted text", vector, "2026-08-27T00:00:00.000Z");
  assert.deepEqual(Object.keys(doc).sort(), ["category", "content", "contentVector", "entity", "execution_status", "id", "indexed_at", "material", "path", "signed", "summary", "title"].sort());
  assert.equal(doc.contentVector, vector, "the vector must land under the exact field name 'contentVector', not 'text_vector' or any other name");
  assert.equal(doc.content, "the full extracted text");
  assert.equal(doc.path, row.path);
  assert.equal(doc.title, "Index");
  assert.equal(doc.material, true);
  assert.equal(doc.signed, true);
  assert.equal(doc.indexed_at, "2026-08-27T00:00:00.000Z");
  // The id must be deterministic (sha1 of the path) so a re-run's resumability check (existingIds)
  // actually matches a previously-pushed row instead of creating a duplicate every time.
  const again = Indexer.buildFlatSearchDoc(row, "different text this time", [9, 9, 9], "2026-08-27T01:00:00.000Z");
  assert.equal(doc.id, again.id, "the id must be stable across re-runs of the SAME catalog row (content-independent, path-derived)");
});

test("buildFlatSearchDoc(): defaults absent optional row fields to falsy/empty rather than 'undefined' leaking into the document", () => {
  const doc = Indexer.buildFlatSearchDoc({ path: "x/y.md" }, "text", [1]);
  assert.equal(doc.entity, "");
  assert.equal(doc.category, "");
  assert.equal(doc.summary, "");
  assert.equal(doc.execution_status, "");
  assert.equal(doc.material, false);
  assert.equal(doc.signed, false);
  assert.equal(doc.title, "y.md", "falls back to the basename when the row carries no title");
});

test("sanity: importing indexer.mjs for these pure-function tests does not itself dispatch a CLI command", () => {
  const src = readFileSync(INDEXER_MJS, "utf8");
  assert.match(src, /if \(import\.meta\.url === `file:\/\/\$\{process\.argv\[1\]\}`\) \{/);
});

// =========================================================================================
// Layer 1b: CHUNKED-room ingest pure functions (chunkText / countWords / buildChunkDocs)
// =========================================================================================

/** Deterministic, non-repeating filler text for chunk-boundary tests: a seeded PRNG generating
 *  distinct base36 tokens, so no substring longer than one token can coincidentally repeat --
 *  which would otherwise let a naive longest-common-affix search in the reassembly test below
 *  find a LARGER accidental match than the chunker's real overlap and produce a false failure. */
function seededTokenText(n, seed = 42) {
  let s = seed >>> 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const words = [];
  for (let i = 0; i < n; i++) words.push(Math.floor(rnd() * 36 ** 6).toString(36));
  return words.join(" ");
}

/** Reassemble a chunk list back into one string by trimming each chunk's overlap with the
 *  previous one (longest matching suffix/prefix). If chunkText() never drops or duplicates any
 *  non-overlap text, this must reproduce the original input byte-for-byte -- the strongest
 *  possible correctness check for a chunker (no data loss across the whole document). */
function reassemble(chunks) {
  if (!chunks.length) return "";
  let out = chunks[0];
  for (let i = 1; i < chunks.length; i++) {
    const b = chunks[i];
    let k = Math.min(out.length, b.length);
    while (k > 0 && out.slice(-k) !== b.slice(0, k)) k--;
    out += b.slice(k);
  }
  return out;
}

test("chunkText(): empty and whitespace-only input produce zero chunks (never a garbage chunk)", () => {
  assert.deepEqual(Indexer.chunkText(""), []);
  assert.deepEqual(Indexer.chunkText("   \n\t  "), []);
  assert.deepEqual(Indexer.chunkText(null), []);
  assert.deepEqual(Indexer.chunkText(undefined), []);
});

test("chunkText(): text already under maxChunkSize is returned as a single chunk, byte-identical, no spurious overlap", () => {
  const text = "This is a short document that easily fits in one chunk.";
  assert.deepEqual(Indexer.chunkText(text, { maxChunkSize: 2000, overlap: 200 }), [text]);
});

test("chunkText(): a long document splits into multiple chunks, none exceeding maxChunkSize, and reassembles to the exact original text", () => {
  const original = seededTokenText(1500); // long enough for several 2000-char chunks
  const chunks = Indexer.chunkText(original, { maxChunkSize: 2000, overlap: 200 });
  assert.ok(chunks.length >= 3, `expected several chunks for a ~${original.length}-char document, got ${chunks.length}`);
  for (const c of chunks) assert.ok(c.length <= 2000, `chunk of length ${c.length} exceeds maxChunkSize`);
  assert.equal(reassemble(chunks), original, "trimming each chunk's overlap with the previous one must reproduce the original text exactly -- no character may be dropped or duplicated outside the overlap");
});

test("chunkText(): consecutive chunks of the same document actually overlap (a non-empty, bounded shared span), matching the live-measured ~200-char corpus overlap", () => {
  const original = seededTokenText(1500);
  const chunks = Indexer.chunkText(original, { maxChunkSize: 2000, overlap: 200 });
  assert.ok(chunks.length >= 2);
  for (let i = 0; i < chunks.length - 1; i++) {
    const a = chunks[i], b = chunks[i + 1];
    let k = Math.min(a.length, b.length, 260);
    while (k > 0 && a.slice(-k) !== b.slice(0, k)) k--;
    assert.ok(k > 0, `chunk ${i} and ${i + 1} must share a non-empty overlap`);
    assert.ok(k <= 200, `overlap of ${k} chars must not exceed the requested 200`);
  }
});

test("chunkText(): is deterministic -- the same input and options always produce the same chunks", () => {
  const original = seededTokenText(1200);
  const a = Indexer.chunkText(original, { maxChunkSize: 1500, overlap: 150 });
  const b = Indexer.chunkText(original, { maxChunkSize: 1500, overlap: 150 });
  assert.deepEqual(a, b);
});

test("chunkText(): a smaller maxChunkSize produces proportionally more chunks, each still under the new, smaller ceiling", () => {
  const original = seededTokenText(1500);
  const big = Indexer.chunkText(original, { maxChunkSize: 2000, overlap: 200 });
  const small = Indexer.chunkText(original, { maxChunkSize: 500, overlap: 50 });
  assert.ok(small.length > big.length, "a smaller chunk size must produce more chunks for the same document");
  for (const c of small) assert.ok(c.length <= 500);
  assert.equal(reassemble(small), original, "a smaller chunk size must still lose no text");
});

test("chunkText(): a pathological run of text with no whitespace anywhere still terminates and produces bounded, non-empty chunks (no infinite loop, no runaway chunk)", () => {
  const original = "x".repeat(9000); // one giant unbreakable 'word'
  const chunks = Indexer.chunkText(original, { maxChunkSize: 2000, overlap: 200 });
  assert.ok(chunks.length >= 4);
  for (const c of chunks) { assert.ok(c.length > 0); assert.ok(c.length <= 2000); }
  assert.equal(chunks.join("").length >= original.length, true, "hard-cut chunks (no whitespace to snap to) must still cover every character of the original, even if the exact overlap trim differs from the whitespace-aware case");
});

test("countWords(): matches enrich.mjs's own \\S+ definition exactly, so a freshly-chunked row's word_count already agrees with what enrich.mjs computes later for the same document", () => {
  assert.equal(Indexer.countWords(""), 0);
  assert.equal(Indexer.countWords("   \n\t  "), 0);
  assert.equal(Indexer.countWords(null), 0);
  assert.equal(Indexer.countWords("one two  three\nfour"), 4);
});

test("buildChunkDocs(): the exact structural field shape for every chunk of one document -- chunk_id/parent_id/path/source_path/title/doc_title/chunk/content_hash/entity/word_count, and NOTHING else unless a vector is supplied", () => {
  const row = { path: "shopify-library/00-index.md", title: "00-index.md", entity: "Company", sha256: "deadbeef" };
  const chunks = ["first chunk text", "second chunk text"];
  const docs = Indexer.buildChunkDocs(row, chunks, { account: "otchealthcommerce", container: "commerce-source-docs", wordCount: 486 });
  assert.equal(docs.length, 2);
  const expectedParentId = crypto.createHash("sha1").update(row.path).digest("hex");
  for (let i = 0; i < docs.length; i++) {
    const d = docs[i];
    assert.deepEqual(Object.keys(d).sort(), ["chunk", "chunk_id", "content_hash", "doc_title", "entity", "id", "parent_id", "path", "source_path", "title", "word_count"].sort(), `chunk ${i} must carry ONLY the structural fields -- no 'content' key, no enrichment field, no vector when none was given`);
    assert.equal(d.id, `${expectedParentId}_${i}`);
    assert.equal(d.chunk_id, d.id);
    assert.equal(d.parent_id, expectedParentId);
    assert.equal(d.path, "otchealthcommerce/commerce-source-docs/shopify-library/00-index.md", "path must be '<account>/<container>/<catalog-row-path>' -- the live-verified chunked-room convention, distinct from the flat room's un-prefixed path");
    assert.equal(d.source_path, "shopify-library");
    assert.equal(d.title, "00-index.md");
    assert.equal(d.doc_title, "00-index.md", "doc_title defaults to the same value as title until enrich.mjs's LLM pass overwrites it");
    assert.equal(d.chunk, chunks[i]);
    assert.equal(d.content_hash, "deadbeef");
    assert.equal(d.entity, "Company");
    assert.equal(d.word_count, 486);
  }
  assert.equal(docs[0].parent_id, docs[1].parent_id, "every chunk of the SAME document must share the SAME parent_id");
  assert.equal(docs[0].content_hash, docs[1].content_hash, "content_hash is the PARENT document's hash, identical across every one of its chunks -- confirmed live, not a per-chunk hash");
  assert.equal(docs[0].word_count, docs[1].word_count, "word_count is the PARENT document's total word count, identical across every one of its chunks -- confirmed live, not a per-chunk count");
});

test("buildChunkDocs(): falls back to the path's basename for title/doc_title when the catalog row carries no title, matching buildFlatSearchDoc()'s own fallback", () => {
  const docs = Indexer.buildChunkDocs({ path: "a/b/c.md" }, ["text"], { account: "acct", container: "cont", wordCount: 2 });
  assert.equal(docs[0].title, "c.md");
  assert.equal(docs[0].doc_title, "c.md");
  assert.equal(docs[0].entity, "", "an absent entity must default to an empty string, never 'undefined'");
  assert.equal(docs[0].content_hash, "", "an absent sha256 must default to an empty string, never 'undefined'");
});

test("buildChunkDocs(): sets the vector field (text_vector, the CHUNKED room's field name) only when a vector is actually supplied, and NEVER writes the flat room's contentVector name", () => {
  const withVec = Indexer.buildChunkDocs({ path: "x.md" }, ["a", "b"], { account: "acct", container: "cont", vectors: [[0.1, 0.2], [0.3, 0.4]], wordCount: 2 });
  assert.deepEqual(withVec[0].text_vector, [0.1, 0.2]);
  assert.deepEqual(withVec[1].text_vector, [0.3, 0.4]);
  assert.equal(withVec[0].contentVector, undefined, "must never write the FLAT room's field name onto a chunk document");
  const noVec = Indexer.buildChunkDocs({ path: "x.md" }, ["a"], { account: "acct", container: "cont", wordCount: 1 });
  assert.equal("text_vector" in noVec[0], false, "the vector field must be entirely ABSENT, not present-and-null, when no vector was given");
});

// =========================================================================================
// Layer 2: full subprocess integration tests (S3 storage + OpenSearch search, both mocked)
// =========================================================================================
const OS_HOST = "unit-test-brain.us-east-1.es.amazonaws.com";
// The finance profile's default (account, container) -- "otchealthcfodata/cfo-source-docs" -- is a
// REAL, verified row in s3-blob.mjs's MIRROR table, so --profile finance --s3 with no overrides
// resolves past the fail-closed "no S3 mirror mapping" guard without needing to fabricate a new
// mapping entry just for this test. The resulting S3 bucket/keyPrefix below are copied from that
// same table (skills/kb-memory/s3-blob.mjs).
const S3_BUCKET = "otchealth-finance-legal-dr-55c84f6b";
const S3_KEY_PREFIX = "otchealthcfodata/cfo-source-docs/";
const S3_HOST = `${S3_BUCKET}.s3.us-east-1.amazonaws.com`;
const AZURE_HOST_RE = /\.(search\.windows\.net|openai\.azure\.com|cognitiveservices\.azure\.com|vault\.azure\.net)/i;

function isHost(u, host) {
  try { return new URL(u).host === host; } catch { return false; }
}
function pathOf(u) {
  try { return new URL(u).pathname; } catch { return ""; }
}

/** One synthetic catalog row + its _TEXT sidecar, served over the mocked S3 layer -- exercises the
 *  SAME loadCatalog()/getBuf() path a real librarian run uses, just against a fixture instead of a
 *  live bucket. This is the DEFAULT fixture (preloadSource()'s default catalogRows/sidecars) so
 *  every pre-existing flat-room test below, none of which pass their own catalogRows/sidecars,
 *  keeps seeing exactly this one document -- unchanged from before the chunked-room additions. */
const CATALOG_ROW = { path: "test/doc1.md", sidecar: true, title: "Doc One", entity: "OTCHealth", category: "testing", summary: "a short summary", material: false, execution_status: "", has_signature: false };
const DOC_TEXT = "This is the full extracted text of the fixture document.";

/** A SECOND, separate fixture used only by the CHUNKED-room tests below: a document long enough to
 *  produce several chunks (unlike DOC_TEXT, which deliberately stays a single chunk), with a
 *  sha256 set (so content_hash has something real to assert against) and a distinct path so it
 *  never collides with CATALOG_ROW/DOC_TEXT above. seededTokenText is Layer 1b's own deterministic,
 *  non-repeating generator (defined earlier in this file) -- reused here for the identical
 *  no-accidental-repeated-substring reason. */
const CATALOG_ROW_MULTI = { path: "test/doc-multi.md", sidecar: true, title: "Doc Multi", entity: "OTCHealth", category: "testing", sha256: "deadbeefsha256fixture", material: false, execution_status: "", has_signature: false };
const DOC_TEXT_MULTI = seededTokenText(900);

/** Preload module: replaces globalThis.fetch with a router over the exact hosts/paths this test's
 *  scenarios reach, and appends a `{method,url,body}` JSON line per call to `logPath` so assertions
 *  can inspect not just WHICH host was hit but WHAT was actually sent (the bulk payload's field
 *  shape in particular).
 *    - `roomShape` controls what the OpenSearch `_mapping` GET reports for the target index --
 *      'absent' (404, so push-search must create the FLAT schema) or 'chunked' (text_vector
 *      already mapped, so push-search must dispatch to the CHUNKED ingest path -- see the 2026-08-28
 *      rewrite of the two tests that used to assert a chunked room is skipped).
 *    - `catalogRows`/`sidecars` (default: the single CATALOG_ROW/DOC_TEXT fixture above) let a test
 *      supply its OWN catalog + text-sidecar content without disturbing every other test's fixture.
 *    - `scrollHits` (default: none) makes the OpenSearch `_search` (scroll) response report those
 *      full `path` values as already present -- the RESUMABILITY test below uses this to prove a
 *      document already indexed (by path) is skipped, with no fabricated historical parentId needed. */
function preloadSource(logPath, { roomShape = "absent", catalogRows = [CATALOG_ROW], sidecars = { "test/doc1.md": DOC_TEXT }, scrollHits = [], failEmbeddingsAfterCalls = Number.MAX_SAFE_INTEGER } = {}) {
  const catalogBody = catalogRows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  return `
import { appendFileSync } from "node:fs";
function isHost(u, host) { try { return new URL(u).host === host; } catch { return false; } }
function pathOf(u) { try { return new URL(u).pathname; } catch { return ""; } }
const SIDECARS = ${JSON.stringify(sidecars)};
const SCROLL_HITS = ${JSON.stringify(scrollHits)};
const FAIL_EMBEDDINGS_AFTER_CALLS = ${JSON.stringify(failEmbeddingsAfterCalls)};
let embedCallCount = 0;
globalThis.fetch = async (url, opts) => {
  const u = String(typeof url === "string" ? url : url?.url || url);
  const method = (opts && opts.method) || "GET";
  appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ method, url: u, body: opts && opts.body ? String(opts.body).slice(0, 20000) : null }) + "\\n");

  // ---- S3 (storage layer: catalog + text sidecars) ----
  if (isHost(u, ${JSON.stringify(S3_HOST)})) {
    const p = pathOf(u);
    if (p === ${JSON.stringify("/" + S3_KEY_PREFIX + "_CATALOG/catalog.jsonl")}) {
      return new Response(${JSON.stringify(catalogBody)}, { status: 200 });
    }
    for (const [relPath, text] of Object.entries(SIDECARS)) {
      if (p === "/" + ${JSON.stringify(S3_KEY_PREFIX)} + "_TEXT/" + relPath + ".txt") {
        return new Response(text, { status: 200 });
      }
    }
    return new Response("not found", { status: 404 });
  }

  // ---- OpenSearch (search layer) ----
  if (isHost(u, ${JSON.stringify(OS_HOST)})) {
    const p = pathOf(u);
    if (p.endsWith("/_mapping")) {
      const index = decodeURIComponent(p.slice(1, -"/_mapping".length));
      if (${JSON.stringify(roomShape)} === "chunked") {
        return new Response(JSON.stringify({ [index]: { mappings: { properties: { text_vector: { type: "knn_vector" }, parent_id: { type: "keyword" } } } } }), { status: 200 });
      }
      return new Response("index_not_found_exception", { status: 404 });
    }
    if (method === "PUT" && !p.includes("/_")) {
      return new Response(JSON.stringify({ acknowledged: true }), { status: 200 }); // index create
    }
    if (p.endsWith("/_search") && method === "POST") {
      // Same endpoint serves BOTH the flat path's existingIds() and the chunked path's
      // osExistingChunkPaths() scroll -- both just want a hits list, shaped per whichever
      // source field they asked for; SCROLL_HITS (default []) lets a test seed it as already-present.
      const hits = SCROLL_HITS.map((path, i) => ({ _id: "existing_" + i, _source: { path } }));
      return new Response(JSON.stringify({ hits: { hits } }), { status: 200 });
    }
    if (p.endsWith("/_bulk")) {
      return new Response(JSON.stringify({ errors: false, items: [{ update: { _id: "x", status: 200 } }] }), { status: 200 });
    }
    if (p.endsWith("/_refresh")) {
      return new Response(JSON.stringify({ _shards: { total: 1, successful: 1, failed: 0 } }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }

  // ---- OpenAI (embeddings) ----
  if (isHost(u, "api.openai.com") && u.includes("/v1/embeddings")) {
    embedCallCount++;
    if (embedCallCount > FAIL_EMBEDDINGS_AFTER_CALLS) {
      return new Response(JSON.stringify({ error: { message: "unit-test forced embedding failure" } }), { status: 500 });
    }
    const body = JSON.parse(opts.body);
    return new Response(JSON.stringify({ data: body.input.map((_, i) => ({ index: i, embedding: [0.01, 0.02, 0.03] })) }), { status: 200 });
  }

  // Anything else (a stray secret lookup, an ambient credential probe) degrades harmlessly rather
  // than throwing -- the assertions below are about what WAS called, not the stub's own control flow.
  return new Response("not found", { status: 404 });
};
`;
}

function runIndexer(args, { roomShape = "absent", envExtra = {}, catalogRows, sidecars, scrollHits, failEmbeddingsAfterCalls } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "push-search-os-test-"));
  const logPath = join(dir, "calls.log");
  writeFileSync(logPath, "");
  const preload = join(dir, "preload.mjs");
  writeFileSync(preload, preloadSource(logPath, { roomShape, catalogRows, sidecars, scrollHits, failEmbeddingsAfterCalls }));
  const env = {
    PATH: process.env.PATH,
    // AWS creds resolve straight from env (no ECS-metadata / SSM / Key-Vault network hop needed) --
    // matches this repo's own s3-blob-write-path.test.mjs / index-one-dispatch.test.mjs convention.
    AWS_ACCESS_KEY_ID: "AKIAUNITTESTFAKE0000",
    AWS_SECRET_ACCESS_KEY: "unit-test-fake-secret-access-key-not-real",
    OPENSEARCH_ENDPOINT: OS_HOST,
    OPENSEARCH_REGION: "us-east-1",
    OPENAI_API_KEY: "sk-unit-test-fake-not-real",
    // No GCP SA, no OTC_AWS_*, no AZURE_* by default: this run must not need, or reach, either.
    // The fetch stub above ALSO 404s any stray SSM/Key-Vault secret lookup this process's ambient
    // AWS credentials (if this sandbox happens to have real ones -- observed live, see the loud-
    // failure test below) would otherwise let through to the REAL secret store.
    ...envExtra,
  };
  return execFileP(process.execPath, ["--import", preload, INDEXER_MJS, ...args], { env, timeout: 30000 })
    .then((r) => ({ status: 0, stdout: r.stdout, stderr: r.stderr, calls: readCalls(logPath) }))
    .catch((e) => ({ status: e.code ?? 1, stdout: e.stdout || "", stderr: e.stderr || "", calls: readCalls(logPath) }));
}
function readCalls(logPath) {
  return readFileSync(logPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

test("push-search with NO --search-backend flag (the default) reaches OpenSearch and creates the room, with ZERO Azure calls", async () => {
  const r = await runIndexer(["push-search", "--profile", "finance", "--s3", "--index", "otc-test-flat-room-fixture"]);
  assert.equal(r.status, 0, `expected a clean exit; stderr: ${r.stderr}`);
  assert.deepEqual(r.calls.filter((c) => AZURE_HOST_RE.test(c.url)), [], "the default backend must never reach an Azure host");
  assert.ok(r.calls.some((c) => isHost(c.url, OS_HOST) && pathOf(c.url).endsWith("/_bulk")), "must have reached the OpenSearch bulk endpoint");
  assert.ok(r.calls.some((c) => isHost(c.url, "api.openai.com")), "must have embedded via OpenAI (the default EMBEDDINGS_PROVIDER)");
});

test("push-search's OpenSearch bulk payload carries the exact flat-room field shape, incl. contentVector as an array of numbers", async () => {
  const r = await runIndexer(["push-search", "--profile", "finance", "--s3", "--index", "otc-test-flat-room-fixture"]);
  assert.equal(r.status, 0, `expected a clean exit; stderr: ${r.stderr}`);
  const bulkCall = r.calls.find((c) => isHost(c.url, OS_HOST) && pathOf(c.url).endsWith("/_bulk"));
  assert.ok(bulkCall, "no bulk call was captured");
  const lines = bulkCall.body.trim().split("\n").filter(Boolean);
  assert.equal(lines.length, 2, "one action line + one doc line for the single fixture row");
  const action = JSON.parse(lines[0]);
  assert.ok(action.update, "must use the bulk API's update action (doc_as_upsert), never index/PUT _doc -- see opensearch-write.mjs's header for why");
  const payload = JSON.parse(lines[1]);
  assert.ok(payload.doc_as_upsert, "must set doc_as_upsert:true so a first-ever write still creates the document");
  const doc = payload.doc;
  assert.equal(doc.path, "test/doc1.md");
  assert.equal(doc.title, "Doc One");
  assert.equal(doc.content, DOC_TEXT);
  assert.ok(Array.isArray(doc.contentVector) && doc.contentVector.length > 0, "the vector must be present under the name 'contentVector' -- what vectorFieldFor() queries for a flat room");
  assert.equal(doc.text_vector, undefined, "must never write the CHUNKED room's field name onto a flat document");
  assert.equal(doc["@search.action"], undefined, "must never carry Azure's mergeOrUpload marker on the OpenSearch path");
});

test("push-search creates the room with the flat schema (settings.index.knn + a contentVector knn_vector field) before ever writing to it", async () => {
  const r = await runIndexer(["push-search", "--profile", "finance", "--s3", "--index", "otc-test-flat-room-fixture"]);
  assert.equal(r.status, 0);
  const createCall = r.calls.find((c) => isHost(c.url, OS_HOST) && c.method === "PUT" && !pathOf(c.url).includes("/_"));
  assert.ok(createCall, "no index-create PUT was captured");
  const body = JSON.parse(createCall.body);
  assert.equal(body.settings.index.knn, true);
  assert.equal(body.mappings.properties.contentVector.type, "knn_vector");
  // The create PUT must happen BEFORE the bulk write (an index must exist to be written to).
  const bulkIdx = r.calls.findIndex((c) => isHost(c.url, OS_HOST) && pathOf(c.url).endsWith("/_bulk"));
  const createIdx = r.calls.indexOf(createCall);
  assert.ok(createIdx < bulkIdx, "index creation must precede the bulk write");
});

// =========================================================================================
// Layer 2b: the CHUNKED-room ingest path itself (2026-08-28) -- REPLACES the two tests that used
// to assert push-search "cleanly SKIPS" a chunked room. That was the correct behavior for the
// flat-only push this file originally shipped; it is now exactly the gap this addition closes, so
// asserting a skip here would be asserting the OLD, now-wrong behavior.
// =========================================================================================

test("push-search on a CHUNKED OpenSearch room now performs a real chunked write (not a skip): multiple chunks, correct ids, never a flat contentVector doc", async () => {
  const r = await runIndexer(
    ["push-search", "--profile", "finance", "--s3"], // no --index override: resolves to finance-cfo-source-docs, a REAL chunked room name
    { roomShape: "chunked", catalogRows: [CATALOG_ROW_MULTI], sidecars: { "test/doc-multi.md": DOC_TEXT_MULTI } },
  );
  assert.equal(r.status, 0, `expected a clean exit; stderr: ${r.stderr}`);
  assert.deepEqual(r.calls.filter((c) => AZURE_HOST_RE.test(c.url)), [], "the chunked path must never reach an Azure host either");
  // NOTE: the per-batch progress line legitimately prints "(skip N)" for the doc-already-present
  // counter (N=0 here), so this must match the ROOM-level skip prefix specifically, not a bare
  // /skip/i (which would false-positive on that routine counter text).
  assert.doesNotMatch(r.stderr, /\[push-search\] SKIP:/, "a chunked room must no longer be reported as room-level skipped");

  const bulkCalls = r.calls.filter((c) => isHost(c.url, OS_HOST) && pathOf(c.url).endsWith("/_bulk"));
  assert.equal(bulkCalls.length, 1, "expected exactly one bulk call for this small fixture (well under PUSH_BATCH=64)");
  const lines = bulkCalls[0].body.trim().split("\n").filter(Boolean);

  const expectedChunks = Indexer.chunkText(DOC_TEXT_MULTI, { maxChunkSize: 2000, overlap: 200 });
  assert.ok(expectedChunks.length >= 3, `fixture text should itself produce several chunks (sanity on the fixture, got ${expectedChunks.length})`);
  assert.equal(lines.length, expectedChunks.length * 2, "one action line + one doc line per chunk, no more, no fewer");

  const expectedParentId = crypto.createHash("sha1").update("test/doc-multi.md").digest("hex");
  const expectedWordCount = Indexer.countWords(DOC_TEXT_MULTI);
  for (let i = 0; i < expectedChunks.length; i++) {
    const action = JSON.parse(lines[2 * i]);
    const payload = JSON.parse(lines[2 * i + 1]);
    assert.ok(action.update, "must use the bulk API's update action (doc_as_upsert), never index/PUT _doc");
    assert.equal(action.update._id, `${expectedParentId}_${i}`, `chunk ${i} must use the "<parentId>_<index>" id shape`);
    assert.ok(payload.doc_as_upsert, "must set doc_as_upsert:true so a first-ever write still creates the document");
    const doc = payload.doc;
    assert.equal(doc.chunk_id, `${expectedParentId}_${i}`);
    assert.equal(doc.parent_id, expectedParentId);
    assert.equal(doc.path, "otchealthcfodata/cfo-source-docs/test/doc-multi.md", "path must be '<account>/<container>/<catalog-row-path>', the live-verified chunked-room convention");
    assert.equal(doc.source_path, "test");
    assert.equal(doc.title, "Doc Multi");
    assert.equal(doc.doc_title, "Doc Multi");
    assert.equal(doc.chunk, expectedChunks[i], "the chunk text pushed must be EXACTLY what chunkText() itself produces for this document");
    assert.equal(doc.content, undefined, "must NEVER write a 'content' field on a chunk document -- live production docs never carry one");
    assert.equal(doc.content_hash, "deadbeefsha256fixture", "content_hash must be the catalog row's sha256 (the PARENT document's hash)");
    assert.equal(doc.word_count, expectedWordCount, "word_count must be the whole document's count, identical on every chunk");
    assert.ok(Array.isArray(doc.text_vector) && doc.text_vector.length > 0, "the vector must be present under 'text_vector' -- the CHUNKED room's field name, never 'contentVector'");
    assert.equal(doc.contentVector, undefined, "must never write the FLAT room's vector field name onto a chunk document");
    assert.equal(doc["@search.action"], undefined, "must never carry Azure's mergeOrUpload marker");
  }
  assert.equal(r.stdout.trim(), `pushed ${expectedChunks.length} chunk(s) across 1 new document(s) (0 doc(s) already present, 0 doc(s) with no usable text) to OpenSearch CHUNKED index finance-cfo-source-docs`);
});

test("push-search on a CHUNKED room DOES read the catalog and text sidecar from S3 -- chunking requires the real document text, unlike the old blanket skip", async () => {
  const r = await runIndexer(
    ["push-search", "--profile", "finance", "--s3"],
    { roomShape: "chunked", catalogRows: [CATALOG_ROW_MULTI], sidecars: { "test/doc-multi.md": DOC_TEXT_MULTI } },
  );
  assert.equal(r.status, 0, `expected a clean exit; stderr: ${r.stderr}`);
  const s3Calls = r.calls.filter((c) => isHost(c.url, S3_HOST));
  assert.ok(s3Calls.some((c) => pathOf(c.url).endsWith("_CATALOG/catalog.jsonl")), "must read the catalog to know what to chunk");
  assert.ok(s3Calls.some((c) => pathOf(c.url).endsWith("_TEXT/test/doc-multi.md.txt")), "must read the document's own text sidecar to actually build chunks from");
});

test("push-search on a CHUNKED room is RESUMABLE by document path, not by a pre-computed id: a document already present (per the live path field) is skipped with zero bulk writes", async () => {
  const r = await runIndexer(
    ["push-search", "--profile", "finance", "--s3"],
    {
      roomShape: "chunked",
      catalogRows: [CATALOG_ROW_MULTI],
      sidecars: { "test/doc-multi.md": DOC_TEXT_MULTI },
      // Seed the mocked scroll response as if this exact document's chunks already exist in the
      // room -- under some OTHER (e.g. the unknown historical-migration) parentId scheme. Because
      // resumability is checked by `path`, not by re-deriving that scheme, this must still be
      // recognized and skipped.
      scrollHits: ["otchealthcfodata/cfo-source-docs/test/doc-multi.md"],
    },
  );
  assert.equal(r.status, 0, `expected a clean exit; stderr: ${r.stderr}`);
  assert.deepEqual(r.calls.filter((c) => isHost(c.url, OS_HOST) && pathOf(c.url).endsWith("/_bulk")), [], "an already-present document must never be re-chunked or re-pushed");
  assert.deepEqual(r.calls.filter((c) => isHost(c.url, S3_HOST) && pathOf(c.url).endsWith("_TEXT/test/doc-multi.md.txt")), [], "a skipped document's text sidecar should not even need to be fetched");
  assert.match(r.stdout, /pushed 0 chunk\(s\) across 0 new document\(s\) \(1 doc\(s\) already present/);
});

test("push-search on a CHUNKED room handles the single-chunk case end to end, and defaults content_hash to an empty string when the catalog row carries no sha256", async () => {
  // A short single-chunk document (mirrors the DOC_TEXT fixture's size) through the chunked path,
  // proving the single-chunk case also works end to end (not just the multi-chunk fixture above).
  const r = await runIndexer(
    ["push-search", "--profile", "finance", "--s3"],
    { roomShape: "chunked", catalogRows: [CATALOG_ROW], sidecars: { "test/doc1.md": DOC_TEXT } },
  );
  assert.equal(r.status, 0, `expected a clean exit; stderr: ${r.stderr}`);
  const bulkCalls = r.calls.filter((c) => isHost(c.url, OS_HOST) && pathOf(c.url).endsWith("/_bulk"));
  assert.equal(bulkCalls.length, 1);
  const lines = bulkCalls[0].body.trim().split("\n").filter(Boolean);
  assert.equal(lines.length, 2, "a short document under maxChunkSize must still produce exactly ONE chunk, not zero and not several");
  const doc = JSON.parse(lines[1]).doc;
  assert.equal(doc.chunk, DOC_TEXT);
  assert.equal(doc.content_hash, "", "CATALOG_ROW carries no sha256 in this fixture -- content_hash must default to an empty string, never 'undefined'");
});

test("push-search on a CHUNKED room NEVER pushes a partial chunk set: a document whose SECOND embed batch fails gets ZERO chunks written, is counted embed-failed, and the run still exits 0 (isolated per document, not fatal)", async () => {
  // >16 chunks (EMB_BATCH) so embedding this ONE document spans two embed calls; failing the
  // second call (embedCallCount > 1) proves the atomicity guarantee at the point that actually
  // matters -- a batch AFTER the first one already looked like it might succeed.
  const bigPath = "test/doc-big.md";
  const bigText = seededTokenText(5500); // ~38k chars -> 22 chunks at 2000/200
  const bigRow = { path: bigPath, sidecar: true, title: "Doc Big", entity: "OTCHealth", sha256: "bigfixturesha" };
  const r = await runIndexer(
    ["push-search", "--profile", "finance", "--s3"],
    { roomShape: "chunked", catalogRows: [bigRow], sidecars: { [bigPath]: bigText }, failEmbeddingsAfterCalls: 1 },
  );
  assert.equal(r.status, 0, `an embed failure on one document must not be fatal to the whole run; stderr: ${r.stderr}`);
  assert.deepEqual(r.calls.filter((c) => isHost(c.url, OS_HOST) && pathOf(c.url).endsWith("/_bulk")), [], "NOT EVEN THE FIRST, successfully-embedded batch of chunks may be pushed for a document whose embedding did not fully complete");
  assert.match(r.stdout, /pushed 0 chunk\(s\) across 0 new document\(s\) \(0 doc\(s\) already present, 0 doc\(s\) with no usable text, 1 doc\(s\) embed-failed \(retried next run\)\)/);
});

test("--search-backend azure fails LOUD (nonzero exit, a diagnosable message) when Azure Search is unconfigured -- it must never silently fall through to OpenSearch instead", async () => {
  // Uses the SAME stubbed-network harness as the OpenSearch tests above (a plain execFileSync with
  // no stub, tried first, turned out to reach this actual sandbox's REAL ambient AWS credentials --
  // sm()'s SSM tier successfully resolved the real, live azure-search-endpoint/-admin-key SSM
  // parameters and the run failed at the network layer against the real, now-disabled
  // 'otchealth-dataroom-s1' Azure Search service instead of at the intended config-missing guard.
  // That is itself a valid loud failure, but not a HERMETIC one -- it depends on this process
  // inheriting real secrets, which will not be true in every environment this test runs in. Routing
  // through the stub makes the specific guard being tested deterministic regardless.
  const r = await runIndexer(
    ["push-search", "--profile", "finance", "--s3", "--search-backend", "azure"],
    {
      envExtra: {
        // Short-circuits the (independent) embeddings-config check via env, so THIS test proves the
        // azure-search-endpoint/-admin-key guard specifically, not whichever of the two happens to
        // be checked first.
        AZURE_OPENAI_ENDPOINT: "https://unit-test-not-real.openai.azure.com",
        AZURE_OPENAI_API_KEY: "unit-test-fake-not-real",
        // Deliberately NOT set: AZURE_SEARCH_ENDPOINT / AZURE_SEARCH_KEY. sm()'s attempt to look
        // them up in SSM/Key Vault hits the shared stub's catch-all 404 (see preloadSource above),
        // so AIS_EP/AIS_KEY resolve to "" regardless of what this sandbox's ambient credentials
        // could otherwise reach.
      },
    },
  );
  assert.notEqual(r.status, 0, "an unconfigured --search-backend azure run must not succeed");
  assert.equal(r.status, 2, `expected the loud-failure exit code 2; stderr was: ${r.stderr}`);
  assert.match(r.stderr, /Missing azure-search-endpoint/, "must name exactly what is missing, not a generic failure");
  assert.doesNotMatch(r.stdout, /pushed \d+ new docs/, "must never print a success line when misconfigured");
  assert.deepEqual(r.calls.filter((c) => isHost(c.url, OS_HOST)), [], "a run explicitly selecting the azure backend must never fall through to OpenSearch");
});

test("source-level regression lock: SEARCH_BACKEND defaults to opensearch, not azure", () => {
  const src = readFileSync(INDEXER_MJS, "utf8");
  assert.match(src, /const SEARCH_BACKEND = .*process\.env\.SEARCH_BACKEND \|\| "opensearch"[\s\S]{0,40}\.toLowerCase\(\);/, "SEARCH_BACKEND must default to opensearch");
  assert.match(src, /const EMBEDDINGS_PROVIDER = .*process\.env\.EMBEDDINGS_PROVIDER \|\| "openai"[\s\S]{0,40}\.toLowerCase\(\);/, "EMBEDDINGS_PROVIDER must default to openai");
});

test("source-level regression lock: the azure branch is still present and reachable, the port made it conditional, it did not delete it", () => {
  const src = readFileSync(INDEXER_MJS, "utf8");
  assert.match(src, /async function runPushSearchAzure\(\)/, "the pre-existing Azure push-search implementation must still exist");
  assert.match(src, /async function runPushSearchOpenSearch\(\)/, "the new OpenSearch implementation must exist alongside it");
  assert.match(src, /SEARCH_BACKEND === "azure" \? runPushSearchAzure\(\) : runPushSearchOpenSearch\(\)/, "push-search must actually branch on SEARCH_BACKEND");
});

test("source-level regression lock: a CHUNKED OpenSearch room is no longer blanket-skipped by push-search -- it dispatches to a real chunked-ingest implementation", () => {
  const src = readFileSync(INDEXER_MJS, "utf8");
  assert.doesNotMatch(
    src,
    /A flat push does not apply to this room; it is fed by enrich\.mjs's OpenSearch write path \/ the migration bulk loader instead/,
    "the old blanket-skip message for a chunked OpenSearch room must be gone -- that behavior is exactly what the chunked-ingest path replaces",
  );
  assert.match(src, /async function runPushSearchOpenSearchChunked\(cfg, index\)/, "the chunked-room push implementation must exist");
  assert.match(
    src,
    /if \(shape === "chunked"\) \{\s*return runPushSearchOpenSearchChunked\(cfg, IDXNAME\);\s*\}/,
    "runPushSearchOpenSearch must DISPATCH to the chunked implementation on a chunked room, not skip",
  );
});
