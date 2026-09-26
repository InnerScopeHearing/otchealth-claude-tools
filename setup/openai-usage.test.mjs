// Tests for setup/openai-usage.mjs. No real network and no real Datadog credential is EVER touched,
// including at process exit: `beforeEach` below unconditionally injects a fake, in-memory ddMetric
// via _setDdMetricForTests() before every single test (even ones that do not themselves assert on
// Datadog calls), and every test redirects the local ledger to a throwaway tmp dir via
// _setLedgerDirForTests(). This matters specifically because recordOpenAIUsage() lazily installs a
// `beforeExit` auto-flush hook on its first real call (see that function's own doc comment) -- without
// this default mock in place, a test that buffers a record but never calls flush() itself would still
// have that record flushed via the REAL ddMetric (and therefore a REAL Datadog network call) once this
// test file's own process eventually exits. A single static import (not a fresh one per test) is used
// deliberately: _resetForTests() alone is sufficient for isolation (the module reads no env var at
// import time, only inside functions at call time), and a single shared module instance means at most
// ONE `beforeExit` listener is ever installed by this whole file, avoiding both a MaxListeners warning
// and the multi-instance real-network risk described above.
//
// OPENAI_USAGE_DISABLE is explicitly cleared here (mirroring run-tests.sh's fleet-wide safety net for
// EVERY OTHER instrumented file's tests) because this file specifically needs to observe
// recordOpenAIUsage()'s real buffering/ledger/flush behavior -- the kill-switch would make every
// assertion here vacuously pass against a permanently-empty buffer.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  estimateCostUsd,
  recordOpenAIUsage,
  flush,
  installAutoFlushOnExit,
  _resetForTests,
  _setLedgerDirForTests,
  _setDdMetricForTests,
  _bufferLengthForTests,
  _peekBufferForTests,
} from "./openai-usage.mjs";
import { awaitBatch } from "./model-routing.mjs";

delete process.env.OPENAI_USAGE_DISABLE;

let tmpDir;
function mockResponse({ status, requestId } = {}) {
  const headers = new Map(requestId ? [["x-request-id", requestId]] : []);
  return {
    ...(status === undefined ? {} : { status }),
    headers: { get: (name) => headers.get(String(name).toLowerCase()) ?? null },
  };
}

function recordUsage({ kind = "chat", model, id, usage, response = mockResponse({ status: 200, requestId: "req_synthetic_test" }) } = {}) {
  const body = {
    ...(model === undefined ? {} : { model }),
    ...(id === undefined ? {} : { id }),
    usage,
  };
  recordOpenAIUsage({ kind, response, body });
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "openai-usage-test-"));
  _resetForTests();
  _setLedgerDirForTests(tmpDir);
  // Default mock: always "succeeds", never touches the network. Individual tests override this with
  // their own tracking function when they need to assert on what was actually emitted.
  _setDdMetricForTests(async () => ({ ok: true }));
});
afterEach(async () => {
  // Drain anything this test buffered through the (still-mocked) emitter before the tmp dir is
  // removed, so no test leaves state for the next one and no buffered record is left dangling for a
  // later real-exit flush to pick up against a deleted ledger directory.
  await flush().catch(() => {});
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// ============================== estimateCostUsd (pure) ==============================

test("estimateCostUsd: known chat model (gpt-4o) prices input+output at the published per-1M rate", () => {
  const { costUsd, unknown } = estimateCostUsd({ model: "gpt-4o", kind: "chat", promptTokens: 1_000_000, completionTokens: 1_000_000 });
  assert.equal(unknown, false);
  assert.ok(Math.abs(costUsd - 12.5) < 1e-9, `expected ~$12.50 (2.50 in + 10.00 out), got ${costUsd}`);
});

test("estimateCostUsd: cached prompt tokens price at the cheaper cached-input rate, not the fresh rate", () => {
  const allFresh = estimateCostUsd({ model: "gpt-4o", kind: "chat", promptTokens: 1_000_000, completionTokens: 0, cachedTokens: 0 });
  const allCached = estimateCostUsd({ model: "gpt-4o", kind: "chat", promptTokens: 1_000_000, completionTokens: 0, cachedTokens: 1_000_000 });
  assert.ok(allCached.costUsd < allFresh.costUsd, "an all-cached-prompt call must cost less than an all-fresh one");
  assert.ok(Math.abs(allCached.costUsd - 1.25) < 1e-9, `expected the $1.25/1M cached rate, got ${allCached.costUsd}`);
});

test("estimateCostUsd: known embedding model (text-embedding-3-large) prices at its published per-1M rate", () => {
  const { costUsd, unknown } = estimateCostUsd({ model: "text-embedding-3-large", kind: "embedding", promptTokens: 1_000_000 });
  assert.equal(unknown, false);
  assert.ok(Math.abs(costUsd - 0.13) < 1e-9, `expected $0.13, got ${costUsd}`);
});

test("estimateCostUsd: an unrecognized chat model falls through to unknown_model, priced at the MOST expensive known chat family (never under-counts)", () => {
  // NOT gpt-5.6-luna/-sol/-terra: those are now KNOWN rows in CHAT_PRICES (see the dedicated
  // gpt-5.6-* tests below) -- this needs a name genuinely absent from the table.
  const unknownModel = estimateCostUsd({ model: "gpt-9.9-nova", kind: "chat", promptTokens: 1_000_000, completionTokens: 1_000_000 });
  const knownGpt4o = estimateCostUsd({ model: "gpt-4o", kind: "chat", promptTokens: 1_000_000, completionTokens: 1_000_000 });
  const knownSol = estimateCostUsd({ model: "gpt-5.6-sol", kind: "chat", promptTokens: 1_000_000, completionTokens: 1_000_000 });
  assert.equal(unknownModel.unknown, true);
  assert.ok(unknownModel.costUsd >= knownGpt4o.costUsd, "the unknown bucket must never be cheaper than the most expensive KNOWN short-context family");
  assert.ok(unknownModel.costUsd >= knownSol.costUsd, "the unknown bucket must never be cheaper than gpt-5.6-sol's own short-context rate either");
});

// ============================== gpt-5.6 family (2026-09-03 price-table addition) ==============================

// NOTE: these short-context tests deliberately use 100,000 prompt/completion tokens, NOT 1,000,000 --
// 1,000,000 is well past GPT_5_6_LONG_CONTEXT_THRESHOLD (272,000) and would silently exercise the
// LONG-context rate instead of the short one this block means to pin (caught by this suite's own
// first draft: a 1,000,000-prompt-token gpt-5.6-sol case landed on $38, not the expected $24, because
// it was actually pricing at the long-context 8.00/30.00 rates). The dedicated long-context tests
// below use a prompt size on the correct side of the boundary on purpose.
test("estimateCostUsd: gpt-5.6-sol short-context prices at the published promotional rate (4.00 in / 20.00 out per 1M)", () => {
  const { costUsd, unknown } = estimateCostUsd({ model: "gpt-5.6-sol", kind: "chat", promptTokens: 100_000, completionTokens: 100_000 });
  assert.equal(unknown, false);
  assert.ok(Math.abs(costUsd - 2.4) < 1e-9, `expected $2.40 (0.1M x 4.00 in + 0.1M x 20.00 out), got ${costUsd}`);
});

test("estimateCostUsd: gpt-5.6-terra short-context prices at 2.00 in / 12.00 out per 1M", () => {
  const { costUsd, unknown } = estimateCostUsd({ model: "gpt-5.6-terra", kind: "chat", promptTokens: 100_000, completionTokens: 100_000 });
  assert.equal(unknown, false);
  assert.ok(Math.abs(costUsd - 1.4) < 1e-9, `expected $1.40 (0.1M x 2.00 in + 0.1M x 12.00 out), got ${costUsd}`);
});

test("estimateCostUsd: gpt-5.6-luna short-context prices at 0.20 in / 1.20 out per 1M (the fleet's OPENAI_TIERS cheap default)", () => {
  const { costUsd, unknown } = estimateCostUsd({ model: "gpt-5.6-luna", kind: "chat", promptTokens: 100_000, completionTokens: 100_000 });
  assert.equal(unknown, false);
  assert.ok(Math.abs(costUsd - 0.14) < 1e-9, `expected $0.14 (0.1M x 0.20 in + 0.1M x 1.20 out), got ${costUsd}`);
});

test("estimateCostUsd: gpt-5.6-luna cached prompt tokens price at its cheaper cached-input rate (0.02/1M), not the fresh 0.20/1M rate", () => {
  const allFresh = estimateCostUsd({ model: "gpt-5.6-luna", kind: "chat", promptTokens: 100_000, completionTokens: 0, cachedTokens: 0 });
  const allCached = estimateCostUsd({ model: "gpt-5.6-luna", kind: "chat", promptTokens: 100_000, completionTokens: 0, cachedTokens: 100_000 });
  assert.ok(allCached.costUsd < allFresh.costUsd, "an all-cached-prompt gpt-5.6-luna call must cost less than an all-fresh one");
  assert.ok(Math.abs(allCached.costUsd - 0.002) < 1e-9, `expected the $0.02/1M cached rate (0.1M tokens -> $0.002), got ${allCached.costUsd}`);
});

test("estimateCostUsd: gpt-5.6-* long-context boundary -- AT exactly 272,000 prompt_tokens still prices short-context; one token OVER switches to the long-context rate", () => {
  const atThreshold = estimateCostUsd({ model: "gpt-5.6-sol", kind: "chat", promptTokens: 272_000, completionTokens: 0 });
  const overThreshold = estimateCostUsd({ model: "gpt-5.6-sol", kind: "chat", promptTokens: 272_001, completionTokens: 0 });
  assert.ok(Math.abs(atThreshold.costUsd - (272_000 / 1e6) * 4.0) < 1e-9, "at exactly the threshold, gpt-5.6-sol must still price at its 4.00/1M short-context input rate");
  assert.ok(Math.abs(overThreshold.costUsd - (272_001 / 1e6) * 8.0) < 1e-6, "one token past the threshold, gpt-5.6-sol must price at its 8.00/1M long-context input rate");
  assert.ok(overThreshold.costUsd > atThreshold.costUsd * 1.9, "the long-context rate is roughly double the short-context rate for the same near-threshold prompt size");
});

test("estimateCostUsd: gpt-5.6-sol long-context tier also applies its own long-context cached-input and output rates, not just input", () => {
  const longFresh = estimateCostUsd({ model: "gpt-5.6-sol", kind: "chat", promptTokens: 300_000, completionTokens: 1_000_000, cachedTokens: 0 });
  const longCached = estimateCostUsd({ model: "gpt-5.6-sol", kind: "chat", promptTokens: 300_000, completionTokens: 0, cachedTokens: 300_000 });
  const expectedFresh = (300_000 / 1e6) * 8.0 + (1_000_000 / 1e6) * 30.0;
  assert.ok(Math.abs(longFresh.costUsd - expectedFresh) < 1e-6, `expected long-context input+output pricing, got ${longFresh.costUsd} vs ${expectedFresh}`);
  assert.ok(Math.abs(longCached.costUsd - (300_000 / 1e6) * 0.8) < 1e-9, "an all-cached long-context prompt must use the long-context cached-input rate (0.80/1M), not the short-context one (0.40/1M)");
});

test("estimateCostUsd: an unrecognized embedding model falls through to unknown_model, priced at the most expensive known embedding family", () => {
  const { costUsd, unknown } = estimateCostUsd({ model: "text-embedding-4-giant", kind: "embedding", promptTokens: 1_000_000 });
  assert.equal(unknown, true);
  assert.ok(Math.abs(costUsd - 0.13) < 1e-9, "text-embedding-3-large (0.13/1M) is the most expensive known embedding family in this table");
});

test("estimateCostUsd: kind:'image' with a recognized model name (gpt-image-1) is NOT tagged unknown, even using the flat fallback rate", () => {
  const { costUsd, unknown } = estimateCostUsd({ model: "gpt-image-1", kind: "image", images: 3 });
  assert.equal(unknown, false);
  assert.ok(costUsd > 0);
});

test("estimateCostUsd: kind:'image' with an unrecognized model name IS tagged unknown", () => {
  const { unknown } = estimateCostUsd({ model: "some-future-image-model", kind: "image", images: 1 });
  assert.equal(unknown, true);
});

// ============================== recordOpenAIUsage (provider receipts + local JSONL) ===============

test("recordOpenAIUsage: NEVER throws and ignores non-response fields", () => {
  assert.doesNotThrow(() => recordOpenAIUsage());
  assert.doesNotThrow(() => recordOpenAIUsage(null));
  assert.doesNotThrow(() => recordOpenAIUsage({ model: "caller-model", kind: "not-a-real-kind", promptTokens: "NaN", completionTokens: -5 }));
  assert.equal(_bufferLengthForTests(), 0);
});

test("recordOpenAIUsage: OPENAI_USAGE_DISABLE=1 is a hard kill-switch", () => {
  process.env.OPENAI_USAGE_DISABLE = "1";
  try {
    recordUsage({ model: "caller-model", usage: { prompt_tokens: 100 } });
  } finally {
    delete process.env.OPENAI_USAGE_DISABLE;
  }
  assert.equal(_bufferLengthForTests(), 0);
  assert.equal(existsSync(join(tmpDir, `usage-${new Date().toISOString().slice(0, 10)}.jsonl`)), false);
});

test("recordOpenAIUsage: records only response-derived metadata and usage in the existing JSONL", () => {
  const response = mockResponse({ status: 200, requestId: "req_synthetic_chat_01" });
  const body = {
    id: "chatcmpl_synthetic_01",
    model: "gpt-4o-2024-08-06",
    usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500, prompt_tokens_details: { cached_tokens: 40 } },
    choices: [{ message: { content: "SENSITIVE_TEST_RESPONSE_SENTINEL" } }],
  };
  recordOpenAIUsage({
    kind: "chat",
    response,
    body,
    model: "caller-supplied-model",
    promptTokens: 9_999,
    costUsdOverride: 100,
    caller: "SENSITIVE_TEST_USER_SENTINEL",
  });

  assert.equal(_bufferLengthForTests(), 1);
  const rec = _peekBufferForTests()[0];
  assert.equal(rec.provider, "openai");
  assert.equal(rec.model, "gpt-4o-2024-08-06");
  assert.equal(rec.kind, "chat");
  assert.equal(rec.requestId, "req_synthetic_chat_01");
  assert.equal(rec.responseId, "chatcmpl_synthetic_01");
  assert.equal(rec.httpStatus, 200);
  assert.deepEqual(rec.usage, body.usage);
  assert.deepEqual(Object.keys(rec).sort(), ["httpStatus", "kind", "model", "provider", "requestId", "responseId", "ts", "usage"]);
  assert.equal(Number.isNaN(Date.parse(rec.ts)), false);

  const ledgerPath = join(tmpDir, `usage-${new Date().toISOString().slice(0, 10)}.jsonl`);
  const lines = readFileSync(ledgerPath, "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), rec);
  assert.doesNotMatch(lines[0], /SENSITIVE_TEST_RESPONSE_SENTINEL|SENSITIVE_TEST_USER_SENTINEL|caller-supplied-model|9999|costUsd|caller/);
});

test("recordOpenAIUsage: missing response and usage fields stay omitted while provider-reported zero stays zero", () => {
  recordUsage({
    response: mockResponse(),
    usage: { prompt_tokens: 0, prompt_tokens_details: { cached_tokens: 0 } },
  });
  const rec = _peekBufferForTests()[0];
  assert.deepEqual(rec.usage, { prompt_tokens: 0, prompt_tokens_details: { cached_tokens: 0 } });
  assert.deepEqual(Object.keys(rec).sort(), ["kind", "provider", "ts", "usage"]);
  assert.equal(Object.hasOwn(rec.usage, "completion_tokens"), false);
  assert.equal(Object.hasOwn(rec.usage, "total_tokens"), false);
  assert.equal(Object.hasOwn(rec, "model"), false);
  assert.equal(Object.hasOwn(rec, "requestId"), false);
  assert.equal(Object.hasOwn(rec, "responseId"), false);
  assert.equal(Object.hasOwn(rec, "httpStatus"), false);
});

test("recordOpenAIUsage: a response without numeric usage creates no receipt", () => {
  recordOpenAIUsage({
    kind: "chat",
    response: mockResponse({ status: 200, requestId: "req_synthetic_no_usage" }),
    body: { id: "chatcmpl_synthetic_no_usage", model: "gpt-4o", choices: [{ message: { content: "not logged" } }] },
  });
  assert.equal(_bufferLengthForTests(), 0);
  assert.equal(existsSync(join(tmpDir, `usage-${new Date().toISOString().slice(0, 10)}.jsonl`)), false);
});

test("recordOpenAIUsage: usage receipts exclude prompts, outputs, tool arguments, credentials, and user identity", () => {
  const body = {
    id: "chatcmpl_synthetic_private",
    model: "gpt-5.6-terra",
    usage: {
      prompt_tokens: 12,
      completion_tokens: 4,
      prompt_tokens_details: {
        cached_tokens: 2,
        note: "SENSITIVE_TEST_USAGE_TEXT_SENTINEL",
        user_id: 7123,
        estimated_cost_usd: 0.25,
      },
      cost_usd_est: 0.5,
      user_id: 4567,
    },
    input: "SENSITIVE_TEST_PROMPT_SENTINEL",
    choices: [{ message: { content: "SENSITIVE_TEST_RESPONSE_SENTINEL", tool_calls: [{ function: { arguments: "SENSITIVE_TEST_TOOL_ARGUMENTS_SENTINEL" } }] } }],
    api_key: "SENSITIVE_TEST_SECRET_SENTINEL",
    user: "SENSITIVE_TEST_USER_SENTINEL",
  };
  recordOpenAIUsage({ kind: "chat", response: mockResponse({ status: 200, requestId: "req_synthetic_private" }), body });
  const serialized = readFileSync(join(tmpDir, `usage-${new Date().toISOString().slice(0, 10)}.jsonl`), "utf8");
  for (const sentinel of ["SENSITIVE_TEST_USAGE_TEXT_SENTINEL", "SENSITIVE_TEST_PROMPT_SENTINEL", "SENSITIVE_TEST_RESPONSE_SENTINEL", "SENSITIVE_TEST_TOOL_ARGUMENTS_SENTINEL", "SENSITIVE_TEST_SECRET_SENTINEL", "SENSITIVE_TEST_USER_SENTINEL"]) {
    assert.equal(serialized.includes(sentinel), false, `${sentinel} must not be recorded`);
  }
  const rec = JSON.parse(serialized.trim());
  assert.deepEqual(rec.usage, { prompt_tokens: 12, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 2 } });
  assert.deepEqual(Object.keys(rec).sort(), ["httpStatus", "kind", "model", "provider", "requestId", "responseId", "ts", "usage"]);
});

test("recordOpenAIUsage: GPT Image response usage is recorded without image data or an unreturned model", () => {
  const body = {
    created: 1_797_000_000,
    data: [{ b64_json: "SENSITIVE_TEST_IMAGE_BYTES_SENTINEL", revised_prompt: "SENSITIVE_TEST_IMAGE_PROMPT_SENTINEL" }],
    usage: { input_tokens: 7, input_tokens_details: { text_tokens: 5, image_tokens: 2 }, output_tokens: 19, total_tokens: 26 },
  };
  recordOpenAIUsage({ kind: "image", response: mockResponse({ status: 200, requestId: "req_synthetic_image" }), body });
  const serialized = readFileSync(join(tmpDir, `usage-${new Date().toISOString().slice(0, 10)}.jsonl`), "utf8");
  const rec = JSON.parse(serialized.trim());
  assert.equal(rec.provider, "openai");
  assert.equal(rec.kind, "image");
  assert.equal(rec.requestId, "req_synthetic_image");
  assert.equal(rec.httpStatus, 200);
  assert.equal(Object.hasOwn(rec, "model"), false);
  assert.equal(Object.hasOwn(rec, "responseId"), false);
  assert.deepEqual(rec.usage, body.usage);
  assert.equal(serialized.includes("SENSITIVE_TEST_IMAGE_BYTES_SENTINEL"), false);
  assert.equal(serialized.includes("SENSITIVE_TEST_IMAGE_PROMPT_SENTINEL"), false);
});

test("awaitBatch: one provider response receipt is recorded per output line without persisting line content or custom IDs", async () => {
  const batchLine = {
    id: "batch_req_synthetic_01",
    custom_id: "SENSITIVE_TEST_CUSTOM_ID_SENTINEL",
    response: {
      status_code: 200,
      request_id: "req_synthetic_batch_01",
      body: {
        id: "chatcmpl_synthetic_batch_01",
        model: "gpt-5.6-terra",
        choices: [{ message: { content: "SENSITIVE_TEST_BATCH_OUTPUT_SENTINEL" } }],
        usage: { prompt_tokens: 22, completion_tokens: 8, total_tokens: 30 },
      },
    },
    error: null,
  };
  const fetchImpl = async (url) => {
    if (url.endsWith("/batches/batch_synthetic_01")) {
      return { ok: true, status: 200, json: async () => ({ status: "completed", output_file_id: "file_synthetic_output" }) };
    }
    if (url.endsWith("/files/file_synthetic_output/content")) {
      return { ok: true, status: 200, text: async () => `${JSON.stringify(batchLine)}\n` };
    }
    throw new Error(`unexpected mocked URL: ${url}`);
  };

  const { results } = await awaitBatch("batch_synthetic_01", {
    apiKey: "unit-test-key",
    timeoutMs: 1_000,
    pollIntervalMs: 0,
    sleepFn: async () => {},
    fetchImpl,
  });

  assert.equal(results.get(batchLine.custom_id).content, "SENSITIVE_TEST_BATCH_OUTPUT_SENTINEL");
  assert.equal(_bufferLengthForTests(), 1);
  const rec = _peekBufferForTests()[0];
  assert.equal(rec.kind, "batch");
  assert.equal(rec.model, "gpt-5.6-terra");
  assert.equal(rec.responseId, "chatcmpl_synthetic_batch_01");
  assert.equal(rec.requestId, "req_synthetic_batch_01");
  assert.equal(rec.httpStatus, 200);
  assert.deepEqual(rec.usage, { prompt_tokens: 22, completion_tokens: 8, total_tokens: 30 });
  const serialized = readFileSync(join(tmpDir, `usage-${new Date().toISOString().slice(0, 10)}.jsonl`), "utf8");
  assert.equal(serialized.includes("SENSITIVE_TEST_BATCH_OUTPUT_SENTINEL"), false);
  assert.equal(serialized.includes("SENSITIVE_TEST_CUSTOM_ID_SENTINEL"), false);
});

test("recordOpenAIUsage: a missing local ledger directory is created on demand", () => {
  const nested = join(tmpDir, "does", "not", "exist", "yet");
  _setLedgerDirForTests(nested);
  assert.doesNotThrow(() => recordUsage({ model: "gpt-4o", usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  assert.equal(existsSync(join(nested, `usage-${new Date().toISOString().slice(0, 10)}.jsonl`)), true);
});

// ============================== flush() (Datadog emission, ddMetric injected) ==============================

test("flush(): aggregates provider usage counts by provider/model/kind and emits no dollar estimate", async () => {
  const calls = [];
  _setDdMetricForTests(async (name, value, opts) => {
    calls.push({ name, value, ...opts });
    return { ok: true };
  });

  recordUsage({ model: "gpt-4o", usage: { prompt_tokens: 100, completion_tokens: 50 } });
  recordUsage({ model: "gpt-4o", usage: { prompt_tokens: 200, completion_tokens: 75 } });
  recordUsage({ kind: "embedding", model: "text-embedding-3-large", usage: { prompt_tokens: 1000, total_tokens: 1000 } });

  const result = await flush();
  assert.equal(result.ok, true);
  assert.equal(result.flushed, 2, "two distinct tag-tuples should aggregate to two points");
  assert.equal(_bufferLengthForTests(), 0, "flush must drain the buffer");

  const tokenCalls = calls.filter((c) => c.name === "otc.fleet.openai.tokens");
  const chat = tokenCalls.filter((c) => c.tags.includes("kind:chat"));
  const inputPoint = chat.find((c) => c.tags.includes("direction:input"));
  const outputPoint = chat.find((c) => c.tags.includes("direction:output"));
  assert.equal(inputPoint.value, 300, "100+200 prompt tokens from provider responses");
  assert.equal(outputPoint.value, 125, "50+75 completion tokens from provider responses");
  assert.ok(inputPoint.tags.includes("provider:openai"));
  assert.ok(inputPoint.tags.includes("model:gpt-4o"));
  assert.equal(inputPoint.tags.some((tag) => tag.startsWith("caller:") || tag.startsWith("repo:")), false);

  const requestCalls = calls.filter((c) => c.name === "otc.fleet.openai.requests");
  const chatRequests = requestCalls.find((c) => c.tags.includes("kind:chat"));
  assert.equal(chatRequests.value, 2);

  const costCalls = calls.filter((c) => c.name === "otc.fleet.openai.cost_usd_est");
  assert.equal(costCalls.length, 0, "estimated dollars are not emitted");
});

test("flush(): missing output usage does not emit a fabricated direction:output zero", async () => {
  const calls = [];
  _setDdMetricForTests(async (name, value, opts) => {
    calls.push({ name, ...opts });
    return { ok: true };
  });
  recordUsage({ kind: "embedding", model: "text-embedding-3-large", usage: { prompt_tokens: 500, total_tokens: 500 } });
  await flush();
  const outputPoints = calls.filter((c) => c.name === "otc.fleet.openai.tokens" && c.tags.includes("direction:output"));
  assert.equal(outputPoints.length, 0);
});

test("flush(): a failed Datadog emit is counted in `failures` but does not throw and does not lose other points", async () => {
  _setDdMetricForTests(async () => ({ ok: false, error: "simulated Datadog outage" }));
  recordUsage({ model: "gpt-4o", usage: { prompt_tokens: 10, completion_tokens: 5 } });
  const result = await flush();
  assert.equal(result.ok, false);
  assert.ok(result.failures > 0);
});

test("flush(): on an empty buffer, is a no-op that reports flushed:0 and never calls ddMetric", async () => {
  let called = false;
  _setDdMetricForTests(async () => {
    called = true;
    return { ok: true };
  });
  const result = await flush();
  assert.equal(result.ok, true);
  assert.equal(result.flushed, 0);
  assert.equal(called, false);
});

test("recordOpenAIUsage: crossing OPENAI_USAGE_FLUSH_THRESHOLD auto-drains the buffer for a long-lived process", async () => {
  process.env.OPENAI_USAGE_FLUSH_THRESHOLD = "3";
  let emitCount = 0;
  _setDdMetricForTests(async () => {
    emitCount++;
    return { ok: true };
  });
  try {
    for (let i = 0; i < 3; i++) {
      recordUsage({ model: "gpt-4o", usage: { prompt_tokens: 1, completion_tokens: 1 } });
    }
    // The threshold-triggered flush is fire-and-forget (not awaited by recordOpenAIUsage itself);
    // give its microtask/promise chain a tick to complete before asserting.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
  } finally {
    delete process.env.OPENAI_USAGE_FLUSH_THRESHOLD;
  }
  assert.equal(_bufferLengthForTests(), 0, "the buffer should have been auto-flushed once it hit the threshold");
  assert.ok(emitCount > 0, "the auto-flush should have actually called the (mocked) Datadog emitter");
});

test("installAutoFlushOnExit(): idempotent -- calling it repeatedly installs at most one NEW beforeExit listener", () => {
  const before = process.listenerCount("beforeExit");
  installAutoFlushOnExit();
  installAutoFlushOnExit();
  installAutoFlushOnExit();
  const after = process.listenerCount("beforeExit");
  assert.ok(after - before <= 1, "at most one new beforeExit listener, regardless of call count");
});
