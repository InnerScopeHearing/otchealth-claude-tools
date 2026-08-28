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
// indexer.mjs is a script (heavy top-level argv/profile-table side effects, a `if (import.meta.url
// === file://process.argv[1])` CLI-entrypoint guard), not an importable module in the general case --
// but it DOES already export a few pure helpers for exactly this reason (see isXfaPlaceholder), and
// importing it for those, from a plain `node --test` process, is proven safe by this file's own
// "sanity" test below (mirrors tests/fail-loud-sidecar.test.mjs's and
// tests/storage-backend-default.test.mjs's existing conventions in this same directory).
import { test } from "node:test";
import assert from "node:assert/strict";
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
 *  live bucket. */
const CATALOG_ROW = { path: "test/doc1.md", sidecar: true, title: "Doc One", entity: "OTCHealth", category: "testing", summary: "a short summary", material: false, execution_status: "", has_signature: false };
const DOC_TEXT = "This is the full extracted text of the fixture document.";

/** Preload module: replaces globalThis.fetch with a router over the exact hosts/paths this test's
 *  scenarios reach, and appends a `{method,url,body}` JSON line per call to `logPath` so assertions
 *  can inspect not just WHICH host was hit but WHAT was actually sent (the bulk payload's field
 *  shape in particular). `roomShape` controls what the OpenSearch `_mapping` GET reports for the
 *  target index -- 'absent' (404, so push-search must create it) or 'chunked' (text_vector already
 *  mapped, so push-search must skip cleanly and never reach `_bulk` at all). */
function preloadSource(logPath, roomShape) {
  return `
import { appendFileSync } from "node:fs";
function isHost(u, host) { try { return new URL(u).host === host; } catch { return false; } }
function pathOf(u) { try { return new URL(u).pathname; } catch { return ""; } }
globalThis.fetch = async (url, opts) => {
  const u = String(typeof url === "string" ? url : url?.url || url);
  const method = (opts && opts.method) || "GET";
  appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ method, url: u, body: opts && opts.body ? String(opts.body).slice(0, 20000) : null }) + "\\n");

  // ---- S3 (storage layer: catalog + text sidecar) ----
  if (isHost(u, ${JSON.stringify(S3_HOST)})) {
    const p = pathOf(u);
    if (p === ${JSON.stringify("/" + S3_KEY_PREFIX + "_CATALOG/catalog.jsonl")}) {
      return new Response(JSON.stringify(${JSON.stringify(CATALOG_ROW)}) + "\\n", { status: 200 });
    }
    if (p === ${JSON.stringify("/" + S3_KEY_PREFIX + "_TEXT/test/doc1.md.txt")}) {
      return new Response(${JSON.stringify(DOC_TEXT)}, { status: 200 });
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
      return new Response(JSON.stringify({ hits: { hits: [] } }), { status: 200 }); // existingIds: nothing indexed yet
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
    const body = JSON.parse(opts.body);
    return new Response(JSON.stringify({ data: body.input.map((_, i) => ({ index: i, embedding: [0.01, 0.02, 0.03] })) }), { status: 200 });
  }

  // Anything else (a stray secret lookup, an ambient credential probe) degrades harmlessly rather
  // than throwing -- the assertions below are about what WAS called, not the stub's own control flow.
  return new Response("not found", { status: 404 });
};
`;
}

function runIndexer(args, { roomShape = "absent", envExtra = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "push-search-os-test-"));
  const logPath = join(dir, "calls.log");
  writeFileSync(logPath, "");
  const preload = join(dir, "preload.mjs");
  writeFileSync(preload, preloadSource(logPath, roomShape));
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

test("push-search cleanly SKIPS a room the live OpenSearch mapping reports as CHUNKED -- never attempts an invalid flat write, and exits 0", async () => {
  const r = await runIndexer(["push-search", "--profile", "finance", "--s3"], { roomShape: "chunked" }); // no --index override: resolves to finance-cfo-source-docs, a REAL CHUNKED_ROOMS entry
  assert.equal(r.status, 0, `a chunked-room skip must still be a clean exit; stderr: ${r.stderr}`);
  assert.match(r.stderr, /SKIP.*CHUNKED/i, "must explain why nothing was pushed");
  assert.deepEqual(r.calls.filter((c) => isHost(c.url, OS_HOST) && pathOf(c.url).endsWith("/_bulk")), [], "a chunked room must never receive a flat bulk write");
  assert.deepEqual(r.calls.filter((c) => AZURE_HOST_RE.test(c.url)), [], "the skip path must not fall back to Azure either");
});

test("push-search never even calls loadCatalog()/getBuf() for a chunked room -- the skip happens before any S3 read, not merely before the bulk write", async () => {
  const r = await runIndexer(["push-search", "--profile", "finance", "--s3"], { roomShape: "chunked" });
  assert.equal(r.status, 0);
  assert.deepEqual(r.calls.filter((c) => isHost(c.url, S3_HOST)), [], "a chunked room's catalog/text should never be read at all -- the shape check happens first");
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
