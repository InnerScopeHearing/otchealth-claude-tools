// Regression gate for FND-20260728-b8a0 ("backup.mjs Cosmos work-ledger export produces 0 rows
// nightly despite an active ledger"). Root cause, confirmed live against the real gateway on
// 2026-08-04: fetchOffloaded() in skills/fleet-backup/backup.mjs had the wrong contract for
// gateway_fetch_result. The real tool is 0-indexed (`page` default 0) and returns
// {found, total_bytes, page, pages, chunk, expired} -- there is no has_more/hasMore/next_page
// field anywhere. The old code started at page=1 (skipping page 0 of every offloaded payload) and
// checked `chunk.has_more ?? chunk.hasMore ?? false`, which is unconditionally false since neither
// key exists, so the loop always stopped after exactly one (wrong) page. The resulting truncated
// JSON fragment failed to parse, and the old `catch { return combined; }` silently returned a raw
// broken string instead of throwing; exportLedger()'s `page.tasks || page.items || []` then read
// that string as "0 tasks" -- a job that reports Succeeded while quietly backing up nothing. Any
// large task_list/task_get/brain_search response that gets JIT-offloaded hits this same path, so
// it was not specific to the ledger export. These tests pin the fixed contract: walk real
// page/pages, reassemble correctly across N pages, and THROW (never silently degrade) on an
// out-of-range/expired/malformed page.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchOffloaded } from "../skills/fleet-backup/backup.mjs";

async function withStubbedFetch(stub, run) {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try { return await run(); } finally { globalThis.fetch = original; }
}

// Builds a fetch stub that serves a `gateway_fetch_result` MCP tools/call response for the given
// 0-indexed page, matching the gateway's real output shape (src/tools/gateway-fetch-result.ts).
function mcpFetchResultStub(pagesOfText, { resultId = "jitres_test_1" } = {}) {
  return async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.equal(body.params.name, "gateway_fetch_result");
    assert.equal(body.params.arguments.result_id, resultId);
    const page = body.params.arguments.page ?? 0;
    const found = page >= 0 && page < pagesOfText.length;
    const result = found
      ? { found: true, total_bytes: pagesOfText.join("").length, page, pages: pagesOfText.length, chunk: pagesOfText[page] }
      : { found: false };
    return {
      ok: true,
      text: async () => JSON.stringify({
        jsonrpc: "2.0",
        id: body.id,
        result: { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: { result } },
      }),
    };
  };
}

test("fetchOffloaded: single-page payload (page 0 only, pages=1) reassembles and parses correctly", async () => {
  const payload = JSON.stringify({ count: 2, tasks: [{ id: "t_1" }, { id: "t_2" }] });
  const result = await withStubbedFetch(
    mcpFetchResultStub([payload]),
    () => fetchOffloaded("test-bearer", "jitres_test_1"),
  );
  assert.deepEqual(result, { count: 2, tasks: [{ id: "t_1" }, { id: "t_2" }] });
});

test("fetchOffloaded: multi-page payload (regression pin -- the real 8-page shape observed live) walks page 0..N-1 and reassembles the full JSON", async () => {
  const full = JSON.stringify({ count: 61, tasks: Array.from({ length: 61 }, (_, i) => ({ id: `t_${i}` })) });
  // Split into 8 chunks the way the gateway's real offload store does (arbitrary byte boundaries).
  const chunkSize = Math.ceil(full.length / 8);
  const pages = [];
  for (let i = 0; i < full.length; i += chunkSize) pages.push(full.slice(i, i + chunkSize));
  assert.equal(pages.length, 8);

  const result = await withStubbedFetch(
    mcpFetchResultStub(pages),
    () => fetchOffloaded("test-bearer", "jitres_test_1"),
  );
  assert.equal(result.count, 61);
  assert.equal(result.tasks.length, 61);
  assert.deepEqual(result.tasks[0], { id: "t_0" });
  assert.deepEqual(result.tasks[60], { id: "t_60" });
});

test("fetchOffloaded: regression pin -- OLD BUG would have requested page=1 first and stopped immediately (missing page 0, never reaching page 2+)", async () => {
  const seenPages = [];
  const payload = JSON.stringify({ count: 1, tasks: [{ id: "only" }] });
  const stub = async (_url, init) => {
    const body = JSON.parse(init.body);
    seenPages.push(body.params.arguments.page ?? 0);
    return mcpFetchResultStub([payload])(_url, init);
  };
  await withStubbedFetch(stub, () => fetchOffloaded("test-bearer", "jitres_test_1"));
  // The fixed code must request page 0 first (not 1), and must stop once page >= pages (1 page
  // total here), i.e. exactly one call to page 0 -- proving both the off-by-one and the missing
  // termination condition are fixed.
  assert.deepEqual(seenPages, [0]);
});

test("fetchOffloaded: throws (never silently returns an empty/partial result) when a page is out of range", async () => {
  // Simulates the exact failure mode of the old code: requesting a page past the real page count.
  await assert.rejects(
    () => withStubbedFetch(mcpFetchResultStub([], { resultId: "jitres_gone" }), () => fetchOffloaded("test-bearer", "jitres_gone")),
    /not found/,
  );
});

test("fetchOffloaded: throws (never silently returns a raw string) when the reassembled payload is not valid JSON", async () => {
  await assert.rejects(
    () => withStubbedFetch(mcpFetchResultStub(["{not valid json"]), () => fetchOffloaded("test-bearer", "jitres_test_1")),
    /failed to parse/,
  );
});

test("fetchOffloaded: throws on an expired result instead of silently degrading", async () => {
  const stub = async (_url, init) => {
    const body = JSON.parse(init.body);
    const result = { found: true, expired: true, page: body.params.arguments.page ?? 0 };
    return { ok: true, text: async () => JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: { result } } }) };
  };
  await assert.rejects(
    () => withStubbedFetch(stub, () => fetchOffloaded("test-bearer", "jitres_test_1")),
    /expired/,
  );
});
