// Tests for skills/agent-evals/run-evals.mjs's FLEX PROCESSING adoption (2026-08-29, see
// setup/model-routing.mjs's own header for the full OpenAI service_tier contract) and its companion
// test-safety refactor (the CLI driver is now wrapped in main() behind an isMain guard, mirroring
// critic-pass/run.mjs and mine-hard-negatives.mjs elsewhere in this toolkit, purely so this file
// itself can be safely `import()`-ed in a test without executing real API calls or process.exit()).
//
// callChatOpenAI takes every value as a plain argument (key/dep/system/user/maxTokens/tries) with no
// dependency on module-level state set by initModel(), so it is directly testable with a mocked
// global.fetch -- no need to run the CLI or resolve real credentials.
//
// AGENT_EVALS_TIER is resolved ONCE at module-load time (a top-level const), so every test here uses
// a cache-busting dynamic import to get a fresh module instance that sees the env set BEFORE import,
// exactly like setup/model-routing.test.mjs's freshImport() pattern.
import { test } from "node:test";
import assert from "node:assert/strict";
import { OPENAI_FLEX_MIN_RETRIES } from "../../../setup/model-routing.mjs";

async function freshRunEvals() {
  return import(`../run-evals.mjs?t=${Date.now()}-${Math.random()}`);
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
const CLEAR_TIER_ENV = { OPENAI_SERVICE_TIER: undefined, OPENAI_SERVICE_TIER_AGENT_EVALS: undefined };

test("importing run-evals.mjs has NO side effects (no directory read, no process.exit, no network) -- the isMain guard actually guards", async () => {
  // A bare import must not throw, hang, or exit the test process. If the guard regressed, this test
  // itself would never finish (main() would try readdirSync + a real network call).
  const mod = await freshRunEvals();
  assert.equal(typeof mod.callChatOpenAI, "function");
});

test("DEFAULT (OPENAI_SERVICE_TIER* unset): a single attempt, no service_tier, no AbortSignal -- byte-identical to before the flex lane existed", async () =>
  withEnv(CLEAR_TIER_ENV, async () => {
    const { callChatOpenAI } = await freshRunEvals();
    let calls = 0, captured = null;
    const content = await withStubbedFetch(async (url, init) => {
      calls++; captured = { url: String(url), body: JSON.parse(init.body), signal: init.signal };
      return { ok: true, status: 200, headers: new Map(), json: async () => ({ choices: [{ message: { content: "the answer" } }] }) };
    }, () => callChatOpenAI("sk-test", "gpt-5.6-terra", "sys", "usr", 4000, 4));
    assert.equal(content, "the answer");
    assert.equal(calls, 1);
    assert.equal(captured.url, "https://api.openai.com/v1/chat/completions");
    assert.equal("service_tier" in captured.body, false);
    assert.equal(captured.signal, undefined);
  }));

test("DEFAULT: a 429 still retries up to the CALLER's own `tries` (unchanged pre-existing behavior; flex only affects the FLOOR, never removes an existing retry)", async () =>
  withEnv(CLEAR_TIER_ENV, async () => {
    const { callChatOpenAI } = await freshRunEvals();
    let calls = 0;
    const content = await withStubbedFetch(async () => {
      calls++;
      if (calls < 2) return { ok: false, status: 429, headers: new Map([["retry-after", "0.01"]]), text: async () => "rate limited" };
      return { ok: true, status: 200, headers: new Map(), json: async () => ({ choices: [{ message: { content: "ok after retry" } }] }) };
    }, () => callChatOpenAI("sk-test", "gpt-5.6-terra", "sys", "usr", 4000, 4));
    assert.equal(content, "ok after retry");
    assert.equal(calls, 2, "the pre-existing per-call `tries` retry loop is untouched by this change");
  }));

test("OPENAI_SERVICE_TIER_AGENT_EVALS=flex: adds service_tier, an AbortSignal, and floors the retry count", async () =>
  withEnv({ ...CLEAR_TIER_ENV, OPENAI_SERVICE_TIER_AGENT_EVALS: "flex" }, async () => {
    const { callChatOpenAI } = await freshRunEvals();
    let calls = 0, lastBody = null, sawSignal = false;
    const content = await withStubbedFetch(async (url, init) => {
      calls++; lastBody = JSON.parse(init.body); sawSignal = init.signal instanceof AbortSignal;
      if (calls < OPENAI_FLEX_MIN_RETRIES) return { ok: false, status: 429, headers: new Map([["retry-after", "0.01"]]), text: async () => "no capacity" };
      return { ok: true, status: 200, headers: new Map(), json: async () => ({ choices: [{ message: { content: "flex answer" } }] }) };
    }, () => callChatOpenAI("sk-test", "gpt-5.6-terra", "sys", "usr", 4000, 4));
    assert.equal(content, "flex answer");
    assert.equal(calls, OPENAI_FLEX_MIN_RETRIES, "a `tries:4` caller value below the flex floor must be raised to the floor");
    assert.equal(lastBody.service_tier, "flex");
    assert.equal(sawSignal, true);
  }));

test("a genuine non-429 failure still fails LOUD immediately, any tier -- never masquerades as a completed judgement", async () =>
  withEnv({ ...CLEAR_TIER_ENV, OPENAI_SERVICE_TIER: "flex" }, async () => {
    const { callChatOpenAI } = await freshRunEvals();
    let calls = 0;
    await assert.rejects(
      () => withStubbedFetch(async () => { calls++; return { ok: false, status: 500, headers: new Map(), text: async () => "server error" }; },
        () => callChatOpenAI("sk-test", "gpt-5.6-terra", "sys", "usr", 4000, 4)),
      (e) => { assert.equal(e.message, "chat 500 server error"); return true; }
    );
    assert.equal(calls, 1, "a non-429 failure must never be retried, even under flex");
  }));
