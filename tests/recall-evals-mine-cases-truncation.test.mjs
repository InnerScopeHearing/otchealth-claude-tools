// Tests for skills/recall-evals/mine-cases.mjs's reasoning-truncation handling (2026-08-30,
// FND-20260830-e927 -- the sibling sweep following critic-pass's own fix for the SAME failure shape,
// FND-20260830-e7c1).
//
// This miner's OpenAI branch delegates to the SHARED setup/model-routing.mjs#fetchOpenAIWithFlexRetry,
// which now throws (tagged `.reasoningExhausted`) instead of silently returning '' on a truncated-
// empty response (fully unit-tested in setup/model-routing.test.mjs). What this file proves is the
// WIRING: (a) MINE_CASES_MAX_TOKENS (1500 -> 4000) actually reaches the API call, is env-overridable,
// and rejects a bad override; (b) main()'s existing per-batch `catch (e) { console.error(...);
// continue; }` (unchanged by this fix) already converts that thrown error into an honest, precise
// skip of the whole batch, instead of a silently-empty `cases` array (which previously happened via
// `JSON.parse('').cases` throwing on the empty string, caught by the SAME catch but with a generic,
// unhelpful error message).
//
// MINE_CASES_MAX_TOKENS is resolved at MODULE-TOP-LEVEL, so every test uses a cache-busting dynamic
// import, exactly like this directory's own recall-evals-mine-cases-flex.test.mjs.
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
  OPENAI_API_KEY: undefined, MINE_MODEL: undefined, MINE_CASES_MAX_TOKENS: undefined,
  OPENAI_SERVICE_TIER: undefined, OPENAI_SERVICE_TIER_RECALL_EVALS_MINE_CASES: undefined,
};

test("MINE_CASES_MAX_TOKENS is honored as an override", async () =>
  withEnv({ ...NO_CREDS_ENV, OPENAI_API_KEY: "sk-test-fake-not-real", MINE_CASES_MAX_TOKENS: "6000" }, async () => {
    const { callChat } = await freshMineCases();
    let sentBody = null;
    await withStubbedFetch(async (url, init) => { sentBody = JSON.parse(init.body); return { ok: true, status: 200, headers: new Map(), json: async () => ({ choices: [{ message: { content: "{}" } }] }) }; },
      () => callChat("sys", "usr"));
    assert.equal(sentBody.max_completion_tokens, 6000);
  }));

test("a bad MINE_CASES_MAX_TOKENS override (sub-1 fractional) falls back to the safe default, not a zero-token budget", async () =>
  withEnv({ ...NO_CREDS_ENV, OPENAI_API_KEY: "sk-test-fake-not-real", MINE_CASES_MAX_TOKENS: "0.7" }, async () => {
    const { callChat } = await freshMineCases();
    let sentBody = null;
    await withStubbedFetch(async (url, init) => { sentBody = JSON.parse(init.body); return { ok: true, status: 200, headers: new Map(), json: async () => ({ choices: [{ message: { content: "{}" } }] }) }; },
      () => callChat("sys", "usr"));
    assert.equal(sentBody.max_completion_tokens, 4000, "a sub-1 fractional override must never floor to 0 and reach the API");
  }));

test("TRUNCATED-EMPTY on the (default tries:1) single attempt REJECTS with a distinct, tagged error -- never resolves to '' as if it were a batch of cases to parse", async () =>
  withEnv({ ...NO_CREDS_ENV, OPENAI_API_KEY: "sk-test-fake-not-real" }, async () => {
    const { callChat } = await freshMineCases();
    await withStubbedFetch(async () => ({ ok: true, status: 200, headers: new Map(), json: async () => ({ choices: [{ message: { content: "", refusal: null }, finish_reason: "length" }], usage: { completion_tokens: 4000, completion_tokens_details: { reasoning_tokens: 4000 } } }) }),
      async () => {
        await assert.rejects(() => callChat("sys", "usr"), (e) => {
          assert.match(e.message, /reasoning model "gpt-5\.6-terra" exhausted its token budget \(4000\)/);
          assert.equal(e.reasoningExhausted, true);
          return true;
        });
      });
  }));

test("a normal (non-truncated) response is still returned unchanged", async () =>
  withEnv({ ...NO_CREDS_ENV, OPENAI_API_KEY: "sk-test-fake-not-real" }, async () => {
    const { callChat } = await freshMineCases();
    const content = await withStubbedFetch(async () => ({ ok: true, status: 200, headers: new Map(), json: async () => ({ choices: [{ message: { content: '{"cases":[{"i":1,"query":"q","expect":["a"]}]}' }, finish_reason: "stop" }] }) }),
      () => callChat("sys", "usr"));
    assert.match(content, /"query":"q"/);
  }));

// ---- counterfactual: main()'s existing per-batch catch already handles the new throw honestly ----
test("counterfactual: the mining loop's existing per-batch catch logs 'batch <n> gen error: <message>' and continues -- unchanged by this fix, which is exactly why the throw needed no new plumbing here", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../skills/recall-evals/mine-cases.mjs", import.meta.url), "utf8");
  assert.match(src, /console\.error\(`\[mine\] batch \$\{batchesTried\} gen error: \$\{e\.message\}`\)/, "a thrown callChat() error must still land here, not require new error-handling plumbing");
});
