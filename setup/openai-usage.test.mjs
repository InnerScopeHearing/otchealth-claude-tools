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

delete process.env.OPENAI_USAGE_DISABLE;

let tmpDir;
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

// ============================== recordOpenAIUsage (buffering + ledger) ==============================

test("recordOpenAIUsage: NEVER throws, even with garbage/missing input", () => {
  assert.doesNotThrow(() => recordOpenAIUsage());
  assert.doesNotThrow(() => recordOpenAIUsage(null));
  assert.doesNotThrow(() => recordOpenAIUsage({ model: null, kind: "not-a-real-kind", promptTokens: "NaN", completionTokens: -5 }));
});

test("recordOpenAIUsage: OPENAI_USAGE_DISABLE=1 is a hard kill-switch -- nothing is buffered or written", () => {
  process.env.OPENAI_USAGE_DISABLE = "1";
  try {
    recordOpenAIUsage({ model: "gpt-4o", kind: "chat", promptTokens: 100, completionTokens: 50, caller: "test" });
  } finally {
    delete process.env.OPENAI_USAGE_DISABLE;
  }
  assert.equal(_bufferLengthForTests(), 0);
  assert.equal(existsSync(join(tmpDir, `usage-${new Date().toISOString().slice(0, 10)}.jsonl`)), false);
});

test("recordOpenAIUsage: a normal call buffers exactly one record and appends exactly one JSONL line locally", () => {
  recordOpenAIUsage({ model: "gpt-4o", kind: "chat", promptTokens: 1000, completionTokens: 500, caller: "unit-test" });
  assert.equal(_bufferLengthForTests(), 1);
  const rec = _peekBufferForTests()[0];
  assert.equal(rec.model, "gpt-4o");
  assert.equal(rec.kind, "chat");
  assert.equal(rec.caller, "unit-test");
  assert.equal(rec.promptTokens, 1000);
  assert.equal(rec.completionTokens, 500);
  assert.ok(rec.costUsd > 0);

  const ledgerPath = join(tmpDir, `usage-${new Date().toISOString().slice(0, 10)}.jsonl`);
  assert.equal(existsSync(ledgerPath), true);
  const lines = readFileSync(ledgerPath, "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.model, "gpt-4o");
  assert.equal(parsed.caller, "unit-test");
});

test("recordOpenAIUsage: costUsdOverride wins outright over the price-table estimate and forces unknown:false", () => {
  recordOpenAIUsage({ model: "gpt-image-1", kind: "image", images: 1, caller: "designer", costUsdOverride: 0.167 });
  const rec = _peekBufferForTests()[0];
  assert.ok(Math.abs(rec.costUsd - 0.167) < 1e-9);
  assert.equal(rec.unknown, false);
});

test("recordOpenAIUsage: an unrecognized model name is tagged unknown:true when no override is given", () => {
  // NOT gpt-5.6-terra: it is now a KNOWN row in CHAT_PRICES (see openai-usage.mjs's price table).
  recordOpenAIUsage({ model: "gpt-9.9-nova", kind: "chat", promptTokens: 100, completionTokens: 50, caller: "company-brain" });
  assert.equal(_peekBufferForTests()[0].unknown, true);
});

test("recordOpenAIUsage: gpt-5.6-terra (a KNOWN model since the 2026-09-03 price-table addition) is tagged unknown:false", () => {
  recordOpenAIUsage({ model: "gpt-5.6-terra", kind: "chat", promptTokens: 100, completionTokens: 50, caller: "company-brain" });
  assert.equal(_peekBufferForTests()[0].unknown, false);
});

test("recordOpenAIUsage: a missing local ledger directory is created on demand (mkdirSync recursive)", () => {
  const nested = join(tmpDir, "does", "not", "exist", "yet");
  _setLedgerDirForTests(nested);
  assert.doesNotThrow(() => recordOpenAIUsage({ model: "gpt-4o", kind: "chat", promptTokens: 1, completionTokens: 1, caller: "test" }));
  assert.equal(existsSync(join(nested, `usage-${new Date().toISOString().slice(0, 10)}.jsonl`)), true);
});

// ============================== flush() (Datadog emission, ddMetric injected) ==============================

test("flush(): aggregates same (model,kind,caller,repo,unknown) records into ONE point per metric, summing tokens/cost/requests", async () => {
  const calls = [];
  _setDdMetricForTests(async (name, value, opts) => {
    calls.push({ name, value, ...opts });
    return { ok: true };
  });

  recordOpenAIUsage({ model: "gpt-4o", kind: "chat", promptTokens: 100, completionTokens: 50, caller: "shark-tank" });
  recordOpenAIUsage({ model: "gpt-4o", kind: "chat", promptTokens: 200, completionTokens: 75, caller: "shark-tank" });
  recordOpenAIUsage({ model: "text-embedding-3-large", kind: "embedding", promptTokens: 1000, caller: "kb-memory-embed" });

  const result = await flush();
  assert.equal(result.ok, true);
  assert.equal(result.flushed, 2, "two distinct tag-tuples should aggregate to two points");
  assert.equal(_bufferLengthForTests(), 0, "flush must drain the buffer");

  const tokenCalls = calls.filter((c) => c.name === "otc.fleet.openai.tokens");
  const shark = tokenCalls.filter((c) => c.tags.includes("caller:shark-tank"));
  const inputPoint = shark.find((c) => c.tags.includes("direction:input"));
  const outputPoint = shark.find((c) => c.tags.includes("direction:output"));
  assert.equal(inputPoint.value, 300, "100+200 prompt tokens across the two shark-tank chat calls");
  assert.equal(outputPoint.value, 125, "50+75 completion tokens across the two shark-tank chat calls");

  const requestCalls = calls.filter((c) => c.name === "otc.fleet.openai.requests");
  const sharkRequests = requestCalls.find((c) => c.tags.includes("caller:shark-tank"));
  assert.equal(sharkRequests.value, 2);

  const costCalls = calls.filter((c) => c.name === "otc.fleet.openai.cost_usd_est");
  assert.equal(costCalls.length, 2, "one cost point per aggregated tag-tuple");
  for (const c of costCalls) assert.equal(c.type, "count");
});

test("flush(): embedding-only records (completionTokens=0) do not emit a spurious direction:output tokens point", async () => {
  const calls = [];
  _setDdMetricForTests(async (name, value, opts) => {
    calls.push({ name, ...opts });
    return { ok: true };
  });
  recordOpenAIUsage({ model: "text-embedding-3-large", kind: "embedding", promptTokens: 500, caller: "doc-indexer" });
  await flush();
  const outputPoints = calls.filter((c) => c.name === "otc.fleet.openai.tokens" && c.tags.includes("direction:output"));
  assert.equal(outputPoints.length, 0);
});

test("flush(): a failed Datadog emit is counted in `failures` but does not throw and does not lose other points", async () => {
  _setDdMetricForTests(async () => ({ ok: false, error: "simulated Datadog outage" }));
  recordOpenAIUsage({ model: "gpt-4o", kind: "chat", promptTokens: 10, completionTokens: 5, caller: "test" });
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
      recordOpenAIUsage({ model: "gpt-4o", kind: "chat", promptTokens: 1, completionTokens: 1, caller: `caller-${i}` });
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
