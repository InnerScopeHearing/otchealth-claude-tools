// Tests for skills/recall-evals/mine-hard-negatives.mjs's OPENAI_BATCH mode (2026-09-02, the OpenAI
// cost-lever sweep's second lever). Mirrors recall-evals-mine-cases-batch.test.mjs's conventions.
//
// Every fake batch response returns an unparseable/incomplete candidate so validatePair() is never
// reached, keeping this suite a true unit test of the batch submission/chunking/result-parsing
// mechanics without spawning a real `node semantic.mjs` child process.
//
// DEFENSE IN DEPTH: none of the scenarios below reach a real writeFileSync(OUT, ...) call (every
// candidate is rejected before validatePair()'s validated-hit branch), but runBatchMode() DOES call it
// unconditionally on an actual validated hit, and OUT defaults to the REAL
// skills/recall-evals/hard-negative-set.json. Every test still redirects OUT to a throwaway temp file
// via process.argv (see withArgv/freshOutPath) so a future edit to these fixtures can never silently
// overwrite the real, hand-curated hard-negative set -- see recall-evals-mine-cases-batch.test.mjs's
// own header for the incident this pattern exists to prevent (it happened there, during this same PR).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function freshMod() {
  return import(`../skills/recall-evals/mine-hard-negatives.mjs?t=${Date.now()}-${Math.random()}`);
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
const TMP_DIR = mkdtempSync(join(tmpdir(), "mine-hard-negatives-batch-test-"));
let tmpCounter = 0;
function freshOutPath() { return join(TMP_DIR, `hard-negative-set-${++tmpCounter}.json`); }
function withIsolatedOut(fn) { return withArgv(["--out", freshOutPath()], fn); }

function fakePair(id) {
  return { oldRow: { id: `old-${id}`, text: `old note ${id}` }, newRow: { id: `new-${id}`, text: `new note ${id}`, agent: "cto" }, reason: "test-reason" };
}

function batchApiStub(contentByCustomId) {
  return async (url, init) => {
    const u = String(url);
    if (u === "https://api.openai.com/v1/files") return { ok: true, status: 200, json: async () => ({ id: "file-in-1" }) };
    if (u === "https://api.openai.com/v1/batches" && init.method === "POST") return { ok: true, status: 200, json: async () => ({ id: "batch_abc123" }) };
    if (u === "https://api.openai.com/v1/batches/batch_abc123") return { ok: true, status: 200, json: async () => ({ id: "batch_abc123", status: "completed", output_file_id: "file-out-1", error_file_id: null }) };
    if (u === "https://api.openai.com/v1/files/file-out-1/content") {
      const lines = Object.entries(contentByCustomId).map(([customId, content]) =>
        JSON.stringify(content === null
          ? { custom_id: customId, response: null, error: { message: "simulated per-line failure" } }
          : { custom_id: customId, response: { body: { choices: [{ message: { content } }] } }, error: null }));
      return { ok: true, status: 200, text: async () => lines.join("\n") };
    }
    throw new Error("unexpected url " + u);
  };
}

test("runBatchMode: filters out pairs already in haveOldNew BEFORE batching -- never pays to regenerate a known pair", async () =>
  withIsolatedOut(() => withEnv({ OPENAI_API_KEY: "sk-test" }, async () => {
    const { runBatchMode } = await freshMod();
    const eligible = [fakePair("a"), fakePair("b")];
    const haveOldNew = new Set(["old-a->new-a"]); // pair "a" already known
    let uploadedFileText = null;
    const result = await withStubbedFetch(async (url, init) => {
      if (String(url) === "https://api.openai.com/v1/files") {
        const form = init.body;
        // read the uploaded file's content back out of the FormData to prove only ONE line was sent
        const file = form.get("file");
        uploadedFileText = await file.text();
      }
      return batchApiStub({ "pair-0": '{"query":"","expect_new":[],"expect_old":[]}' })(url, init);
    }, () => runBatchMode(eligible, [], [], haveOldNew));
    assert.equal(uploadedFileText.trim().split("\n").length, 1, "only the ONE not-already-known pair should be submitted");
    assert.equal(result.tried, 1);
  })));

test("runBatchMode: an already-empty toMine set (everything already known) never calls the Batch API at all", async () =>
  withIsolatedOut(() => withEnv({ OPENAI_API_KEY: "sk-test" }, async () => {
    const { runBatchMode } = await freshMod();
    const eligible = [fakePair("a")];
    const haveOldNew = new Set(["old-a->new-a"]);
    let called = false;
    const result = await withStubbedFetch(async () => { called = true; return { ok: true, status: 200, json: async () => ({}) }; }, () => runBatchMode(eligible, [], [], haveOldNew));
    assert.equal(called, false);
    assert.deepEqual(result, { tried: 0, validated: 0 });
  })));

test("runBatchMode: a per-pair batch error is logged and skipped, never thrown for the whole run", async () =>
  withIsolatedOut(() => withEnv({ OPENAI_API_KEY: "sk-test" }, async () => {
    const { runBatchMode } = await freshMod();
    const eligible = [fakePair("a")];
    const result = await withStubbedFetch(batchApiStub({ "pair-0": null }), () => runBatchMode(eligible, [], [], new Set()));
    assert.equal(result.tried, 1);
    assert.equal(result.validated, 0);
  })));

test("runBatchMode: an unparseable/incomplete candidate (parseHardNegCandidate returns null) is logged and skipped", async () =>
  withIsolatedOut(() => withEnv({ OPENAI_API_KEY: "sk-test" }, async () => {
    const { runBatchMode } = await freshMod();
    const eligible = [fakePair("a")];
    const result = await withStubbedFetch(batchApiStub({ "pair-0": "not json at all" }), () => runBatchMode(eligible, [], [], new Set()));
    assert.equal(result.tried, 1);
    assert.equal(result.validated, 0);
  })));

test("runBatchMode: an MNPI-flagged candidate query is skipped without ever reaching validatePair (no spawn, no false 'validated')", async () =>
  withIsolatedOut(() => withEnv({ OPENAI_API_KEY: "sk-test" }, async () => {
    const { runBatchMode, isContentSafe } = await freshMod();
    // Prove the fixture actually trips the SAME guard the batch loop calls -- a self-checking fixture,
    // not an assumption about isContentSafe's internals.
    assert.equal(isContentSafe("what did the investor say about the capital raise"), false);
    const eligible = [fakePair("a")];
    const content = JSON.stringify({ query: "what did the investor say about the capital raise", expect_new: ["x"], expect_old: ["y"] });
    const result = await withStubbedFetch(batchApiStub({ "pair-0": content }), () => runBatchMode(eligible, [], [], new Set()));
    assert.equal(result.tried, 1);
    assert.equal(result.validated, 0, "an MNPI-flagged candidate must never be counted as validated");
  })));

test("runBatchMode: throws 'missing openai-api-key' and never reaches the Batch API endpoints when no key is resolvable", async () =>
  withIsolatedOut(() => withEnv({ OPENAI_API_KEY: undefined }, async () => {
    const { runBatchMode } = await freshMod();
    let batchApiCalled = false;
    await assert.rejects(
      () => withStubbedFetch(async (url) => {
        const u = String(url);
        if (u === "https://api.openai.com/v1/files" || u === "https://api.openai.com/v1/batches") batchApiCalled = true;
        return { ok: false, status: 404, text: async () => "not found", json: async () => ({}) };
      }, () => runBatchMode([fakePair("a")], [], [], new Set())),
      /missing openai-api-key/
    );
    assert.equal(batchApiCalled, false);
  })));

test("runBatchMode: assertAllBatchResultsPresent's guard propagates when a pair's custom_id never appears in the batch output at all", async () =>
  withIsolatedOut(() => withEnv({ OPENAI_API_KEY: "sk-test" }, async () => {
    const { runBatchMode } = await freshMod();
    await assert.rejects(
      () => withStubbedFetch(async (url, init) => {
        if (String(url) === "https://api.openai.com/v1/files/file-out-1/content") return { ok: true, status: 200, text: async () => "" };
        return batchApiStub({})(url, init);
      }, () => runBatchMode([fakePair("a")], [], [], new Set())),
      /custom_id\(s\) got NO result at all/
    );
  })));
