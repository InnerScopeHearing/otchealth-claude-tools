// Tests for skills/recall-evals/mine-cases.mjs's FLEX PROCESSING adoption (2026-08-29, see
// setup/model-routing.mjs's own header for the full OpenAI service_tier contract) and its companion
// test-safety refactor (main() is now guarded by isMain, mirroring mine-hard-negatives.mjs's existing
// pattern in this same directory, purely so this file can be safely `import()`-ed without executing a
// real corpus scan or real API calls).
//
// mine-cases.mjs had NO retry-on-429 at all before this change (a bare `if (!r.ok) throw`) -- the
// "default behavior lock" here is therefore that a single 429 (or any other non-2xx) throws
// IMMEDIATELY with the exact original `chat <status>: <body>` message shape, never retried, unless
// OPENAI_SERVICE_TIER(_RECALL_EVALS_MINE_CASES) is set.
import { test } from "node:test";
import assert from "node:assert/strict";

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
const NO_CREDS_ENV = {
  OPENAI_API_KEY: undefined, MINE_MODEL: undefined,
  OPENAI_SERVICE_TIER: undefined, OPENAI_SERVICE_TIER_RECALL_EVALS_MINE_CASES: undefined,
};

test("importing mine-cases.mjs has NO side effects (no corpus scan, no process.exit, no network) -- the isMain guard actually guards", async () => {
  const mod = await freshMineCases();
  assert.equal(typeof mod.callChat, "function");
});

test("DEFAULT (OPENAI_SERVICE_TIER* unset): a single attempt, no service_tier, no AbortSignal -- byte-identical to the pre-existing zero-retry behavior", async () =>
  withEnv({ ...NO_CREDS_ENV, OPENAI_API_KEY: "sk-test-fake-not-real" }, async () => {
    const { callChat } = await freshMineCases();
    let calls = 0, captured = null;
    const content = await withStubbedFetch(async (url, init) => {
      calls++; captured = { url: String(url), body: JSON.parse(init.body), signal: init.signal };
      return { ok: true, status: 200, headers: new Map(), json: async () => ({ choices: [{ message: { content: "{}" } }] }) };
    }, () => callChat("sys", "usr"));
    assert.equal(content, "{}");
    assert.equal(calls, 1);
    assert.equal(captured.url, "https://api.openai.com/v1/chat/completions");
    assert.equal("service_tier" in captured.body, false);
    assert.equal(captured.signal, undefined);
    // resolveTier("standard", "openai") resolves to gpt-5.6-terra (reasoning-family, 2026-08-29
    // refresh), so chatBody() uses max_completion_tokens, not max_tokens -- see model-routing.mjs.
    // 1500 -> 4000 (2026-08-30, FND-20260830-e927): see MINE_CASES_MAX_TOKENS's own comment in
    // mine-cases.mjs and tests/recall-evals-mine-cases-truncation.test.mjs for the reasoning-
    // truncation fix this budget bump is part of.
    assert.equal(captured.body.max_completion_tokens, 4000);
  }));

test("DEFAULT: a 429 throws IMMEDIATELY (no retry) with the exact pre-existing 'chat <status>: <body>' message shape", async () =>
  withEnv({ ...NO_CREDS_ENV, OPENAI_API_KEY: "sk-test-fake-not-real" }, async () => {
    const { callChat } = await freshMineCases();
    let calls = 0;
    await assert.rejects(
      () => withStubbedFetch(async () => { calls++; return { ok: false, status: 429, headers: new Map(), text: async () => "rate limited" }; },
        () => callChat("sys", "usr")),
      (e) => { assert.equal(e.message, "chat 429: rate limited"); return true; }
    );
    assert.equal(calls, 1, "must not retry a 429 when the tier is not flex (this miner never retried before this change)");
  }));

test("OPENAI_SERVICE_TIER_RECALL_EVALS_MINE_CASES=flex: adds service_tier, an AbortSignal, and retries a 429 with backoff", async () =>
  withEnv({ ...NO_CREDS_ENV, OPENAI_API_KEY: "sk-test-fake-not-real", OPENAI_SERVICE_TIER_RECALL_EVALS_MINE_CASES: "flex" }, async () => {
    const { callChat } = await freshMineCases();
    let calls = 0, lastBody = null, sawSignal = false;
    const content = await withStubbedFetch(async (url, init) => {
      calls++; lastBody = JSON.parse(init.body); sawSignal = init.signal instanceof AbortSignal;
      if (calls < 3) return { ok: false, status: 429, headers: new Map([["retry-after", "0.01"]]), text: async () => "no capacity" };
      return { ok: true, status: 200, headers: new Map(), json: async () => ({ choices: [{ message: { content: "flex result" } }] }) };
    }, () => callChat("sys", "usr"));
    assert.equal(content, "flex result");
    assert.equal(calls, 3, "must actually retry through the 429s under flex");
    assert.equal(lastBody.service_tier, "flex");
    assert.equal(sawSignal, true);
  }));

test("a genuine non-429 failure still fails LOUD immediately, any tier -- never masquerades as a completed mine", async () =>
  withEnv({ ...NO_CREDS_ENV, OPENAI_API_KEY: "sk-test-fake-not-real", OPENAI_SERVICE_TIER: "flex" }, async () => {
    const { callChat } = await freshMineCases();
    let calls = 0;
    await assert.rejects(
      () => withStubbedFetch(async () => { calls++; return { ok: false, status: 500, headers: new Map(), text: async () => "server error" }; },
        () => callChat("sys", "usr")),
      (e) => { assert.equal(e.message, "chat 500: server error"); return true; }
    );
    assert.equal(calls, 1, "a non-429 failure must never be retried, even under flex");
  }));

test("MINE_MODEL still overrides the resolved deployment verbatim under the flex lane", async () =>
  withEnv({ ...NO_CREDS_ENV, OPENAI_API_KEY: "sk-test-fake-not-real", OPENAI_SERVICE_TIER: "flex", MINE_MODEL: "gpt-4o" }, async () => {
    const { callChat } = await freshMineCases();
    let captured = null;
    await withStubbedFetch(async (url, init) => {
      captured = JSON.parse(init.body);
      return { ok: true, status: 200, headers: new Map(), json: async () => ({ choices: [{ message: { content: "ok" } }] }) };
    }, () => callChat("sys", "usr"));
    assert.equal(captured.model, "gpt-4o");
    assert.equal(captured.service_tier, "flex");
  }));
