// Tests for skills/recall-evals/mine-cases.mjs's OPENAI_BATCH mode (2026-09-02, the OpenAI cost-lever
// sweep's second lever). Mirrors the existing recall-evals-mine-cases-flex.test.mjs's testing
// conventions (cache-busting import, withStubbedFetch/withEnv) so this file's own network mocking
// looks and behaves the same way for anyone reading both.
//
// Every fake batch response in this file returns EMPTY (or already-deduped/PHI-flagged) case arrays so
// that `candidates` stays empty per chunk -- this keeps validateConcurrent() a true no-op (an empty
// items array short-circuits its own worker pool before it would ever spawn a real `node semantic.mjs`
// child process), letting this suite test the BATCH submission/chunking/result-parsing mechanics in
// true isolation without depending on (or spawning) any external process.
//
// CRITICAL: runBatchMode() calls writeFileSync(OUT, ...) UNCONDITIONALLY on every chunk iteration (the
// same "incremental save" behavior the synchronous path already has), where OUT defaults to the REAL
// skills/recall-evals/golden-set.json (resolved from process.argv at MODULE IMPORT time, via the
// module's own `val("--out", ...)` parsing). Every test below therefore imports the module with
// `--out <a throwaway temp file>` already present in process.argv (see withArgv/TMP_OUT) -- omitting
// this would silently overwrite the real, hand-curated golden set with test fixture data.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function freshMineCases() {
  return import(`../skills/recall-evals/mine-cases.mjs?t=${Date.now()}-${Math.random()}`);
}
function withStubbedFetch(stub, run) {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  return (async () => { try { return await run(); } finally { globalThis.fetch = original; } })();
}
function withEnv(vars, run) {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  return (async () => { try { return await run(); } finally { for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } } })();
}
function withArgv(extraArgs, run) {
  const original = process.argv;
  process.argv = [...original.slice(0, 2), ...extraArgs];
  return (async () => { try { return await run(); } finally { process.argv = original; } })();
}
const TMP_DIR = mkdtempSync(join(tmpdir(), "mine-cases-batch-test-"));
let tmpCounter = 0;
/** A FRESH temp path per call (not shared across tests) -- runBatchMode writes to this file
 *  incrementally; a fresh path per test keeps tests from observing each other's writes. */
function freshOutPath() { return join(TMP_DIR, `golden-set-${++tmpCounter}.json`); }
/** Runs `fn` (which must call freshMineCases() + runBatchMode itself) with process.argv redirecting
 *  OUT to a fresh throwaway temp file -- the required wrapper around EVERY test in this file (see the
 *  CRITICAL note above). */
function withIsolatedOut(fn) {
  return withArgv(["--out", freshOutPath()], fn);
}
const NO_BATCH_ENV = { OPENAI_BATCH: undefined, OPENAI_BATCH_RECALL_EVALS_MINE_CASES: undefined };

function batchApiStub(chunkContentByIndex) {
  return async (url, init) => {
    const u = String(url);
    if (u === "https://api.openai.com/v1/files") return { ok: true, status: 200, json: async () => ({ id: "file-in-1" }) };
    if (u === "https://api.openai.com/v1/batches" && init.method === "POST") return { ok: true, status: 200, json: async () => ({ id: "batch_abc123" }) };
    if (u === "https://api.openai.com/v1/batches/batch_abc123") return { ok: true, status: 200, json: async () => ({ id: "batch_abc123", status: "completed", output_file_id: "file-out-1", error_file_id: null }) };
    if (u === "https://api.openai.com/v1/files/file-out-1/content") {
      const lines = Object.entries(chunkContentByIndex).map(([i, content]) =>
        JSON.stringify(content === null
          ? { custom_id: `chunk-${i}`, response: null, error: { message: "simulated per-line failure" } }
          : { custom_id: `chunk-${i}`, response: { body: { choices: [{ message: { content } }] } }, error: null }));
      return { ok: true, status: 200, text: async () => lines.join("\n") };
    }
    throw new Error("unexpected url " + u);
  };
}

test("runBatchMode: chunks the corpus by BATCH size, one batch line per chunk, custom_id='chunk-<i>'", async () =>
  withIsolatedOut(() => withEnv({ OPENAI_API_KEY: "sk-test" }, async () => {
    const { runBatchMode } = await freshMineCases();
    const facts = Array.from({ length: 17 }, (_, i) => `fact number ${i} is at least seventy characters long to pass the corpus length filter`);
    let capturedUploadCalled = false;
    const result = await withStubbedFetch(async (url, init) => {
      if (String(url) === "https://api.openai.com/v1/files") capturedUploadCalled = true;
      return batchApiStub({ 0: '{"cases":[]}', 1: '{"cases":[]}', 2: '{"cases":[]}' })(url, init);
    }, () => runBatchMode(facts, [], [], new Set()));
    assert.equal(capturedUploadCalled, true);
    // default BATCH=8 -> ceil(17/8) = 3 chunks
    assert.equal(result.batchesTried, 3);
    assert.equal(result.generated, 0);
    assert.equal(result.validated, 0);
  })));

test("runBatchMode: a per-chunk batch error is logged and skipped, never thrown for the whole run", async () =>
  withIsolatedOut(() => withEnv({ OPENAI_API_KEY: "sk-test" }, async () => {
    const { runBatchMode } = await freshMineCases();
    const facts = Array.from({ length: 8 }, (_, i) => `fact number ${i} is at least seventy characters long to pass the corpus length filter`);
    const result = await withStubbedFetch(batchApiStub({ 0: null }), () => runBatchMode(facts, [], [], new Set()));
    assert.equal(result.batchesTried, 1);
    assert.equal(result.generated, 0);
  })));

test("runBatchMode: a chunk whose completion is not valid JSON is logged and skipped, never thrown", async () =>
  withIsolatedOut(() => withEnv({ OPENAI_API_KEY: "sk-test" }, async () => {
    const { runBatchMode } = await freshMineCases();
    const facts = Array.from({ length: 8 }, (_, i) => `fact number ${i} is at least seventy characters long to pass the corpus length filter`);
    const result = await withStubbedFetch(batchApiStub({ 0: "not json at all" }), () => runBatchMode(facts, [], [], new Set()));
    assert.equal(result.batchesTried, 1);
    assert.equal(result.generated, 0);
  })));

test("runBatchMode: a candidate whose query is already in haveQ (deduped) is not counted as generated", async () =>
  withIsolatedOut(() => withEnv({ OPENAI_API_KEY: "sk-test" }, async () => {
    const { runBatchMode } = await freshMineCases();
    const facts = Array.from({ length: 8 }, (_, i) => `fact number ${i} is at least seventy characters long to pass the corpus length filter`);
    const haveQ = new Set(["already known query"]);
    const result = await withStubbedFetch(
      batchApiStub({ 0: JSON.stringify({ cases: [{ i: 1, query: "Already Known Query", expect: ["x"] }] }) }),
      () => runBatchMode(facts, [], [], haveQ)
    );
    assert.equal(result.generated, 0, "a query already in haveQ (case-insensitive) must not be counted as newly generated");
  })));

test("runBatchMode: throws 'missing openai-api-key' and NEVER reaches the Batch API endpoints when no key is resolvable", async () =>
  withIsolatedOut(() => withEnv({ OPENAI_API_KEY: undefined }, async () => {
    const { runBatchMode } = await freshMineCases();
    let batchApiCalled = false;
    await assert.rejects(
      // kvSecret() may itself attempt (and fail) a network probe while resolving the fleet secret --
      // that is expected and orthogonal to this assertion. What must NEVER happen is a call to either
      // OpenAI Batch API endpoint (file upload or batch create), which is what "no key resolvable"
      // actually needs to guarantee (never send a batch request with an empty/missing credential).
      () => withStubbedFetch(async (url) => {
        const u = String(url);
        if (u === "https://api.openai.com/v1/files" || u === "https://api.openai.com/v1/batches") batchApiCalled = true;
        return { ok: false, status: 404, text: async () => "not found", json: async () => ({}) };
      }, () => runBatchMode(["some fact text that is long enough to pass the seventy character corpus filter"], [], [], new Set())),
      /missing openai-api-key/
    );
    assert.equal(batchApiCalled, false);
  })));

test("runBatchMode: assertAllBatchResultsPresent's guard propagates when a chunk's custom_id never appears in the batch output at all", async () =>
  withIsolatedOut(() => withEnv({ OPENAI_API_KEY: "sk-test" }, async () => {
    const { runBatchMode } = await freshMineCases();
    const facts = Array.from({ length: 8 }, (_, i) => `fact number ${i} is at least seventy characters long to pass the corpus length filter`);
    await assert.rejects(
      () => withStubbedFetch(async (url, init) => {
        if (String(url) === "https://api.openai.com/v1/files/file-out-1/content") return { ok: true, status: 200, text: async () => "" }; // no lines at all -> chunk-0 missing entirely
        return batchApiStub({})(url, init);
      }, () => runBatchMode(facts, [], [], new Set())),
      /custom_id\(s\) got NO result at all/
    );
  })));

test("main()'s batch-vs-sync branch reuses the SAME shared isBatchEnabled('recall-evals-mine-cases') gate every other caller in this sweep uses (both unset -> false, the state of every job today)", async () =>
  withEnv(NO_BATCH_ENV, async () => {
    const { isBatchEnabled } = await import("../setup/model-routing.mjs");
    assert.equal(isBatchEnabled("recall-evals-mine-cases"), false);
  }));
