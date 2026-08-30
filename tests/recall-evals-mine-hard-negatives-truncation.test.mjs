// Tests for skills/recall-evals/mine-hard-negatives.mjs's reasoning-truncation handling (2026-08-30,
// FND-20260830-e927 -- the sibling sweep following critic-pass's own fix for the SAME failure shape,
// FND-20260830-e7c1).
//
// This miner's OpenAI branch delegates to the SHARED setup/model-routing.mjs#fetchOpenAIWithFlexRetry,
// which now throws (tagged `.reasoningExhausted`) instead of silently returning '' on a truncated-
// empty response (fully unit-tested in setup/model-routing.test.mjs). What this file proves is the
// WIRING: (a) MINE_HARDNEG_MAX_TOKENS (500 -> 2000) actually reaches the API call, is env-overridable,
// and rejects a bad override; (b) main()'s existing per-candidate `catch (e) { console.error(...);
// continue; }` (unchanged by this fix) already converts that thrown error into an honest, precise
// skip -- BEFORE this fix, a truncated-empty response returned '' successfully, and
// parseHardNegCandidate('') degraded to the GENERIC "unparseable/incomplete candidate" message,
// indistinguishable from the model genuinely answering with broken JSON.
//
// MINE_HARDNEG_MAX_TOKENS is resolved at MODULE-TOP-LEVEL, so every test uses a cache-busting dynamic
// import, exactly like this directory's own recall-evals-mine-hard-negatives-flex.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";

async function freshMineHardNeg() {
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
const NO_CREDS_ENV = {
  OPENAI_API_KEY: undefined, MINE_MODEL: undefined, MINE_HARDNEG_MAX_TOKENS: undefined,
  OPENAI_SERVICE_TIER: undefined, OPENAI_SERVICE_TIER_RECALL_EVALS_MINE_HARD_NEGATIVES: undefined,
};

test("MINE_HARDNEG_MAX_TOKENS is honored as an override", async () =>
  withEnv({ ...NO_CREDS_ENV, OPENAI_API_KEY: "sk-test-fake-not-real", MINE_HARDNEG_MAX_TOKENS: "3500" }, async () => {
    const { callChat } = await freshMineHardNeg();
    let sentBody = null;
    await withStubbedFetch(async (url, init) => { sentBody = JSON.parse(init.body); return { ok: true, status: 200, headers: new Map(), json: async () => ({ choices: [{ message: { content: "{}" } }] }) }; },
      () => callChat("sys", "usr"));
    assert.equal(sentBody.max_completion_tokens, 3500);
  }));

test("a bad MINE_HARDNEG_MAX_TOKENS override (sub-1 fractional) falls back to the safe default, not a zero-token budget", async () =>
  withEnv({ ...NO_CREDS_ENV, OPENAI_API_KEY: "sk-test-fake-not-real", MINE_HARDNEG_MAX_TOKENS: "0.001" }, async () => {
    const { callChat } = await freshMineHardNeg();
    let sentBody = null;
    await withStubbedFetch(async (url, init) => { sentBody = JSON.parse(init.body); return { ok: true, status: 200, headers: new Map(), json: async () => ({ choices: [{ message: { content: "{}" } }] }) }; },
      () => callChat("sys", "usr"));
    assert.equal(sentBody.max_completion_tokens, 2000, "a sub-1 fractional override must never floor to 0 and reach the API");
  }));

test("TRUNCATED-EMPTY on the (default tries:1) single attempt REJECTS with a distinct, tagged error -- never resolves to '' as if it were a candidate to parse", async () =>
  withEnv({ ...NO_CREDS_ENV, OPENAI_API_KEY: "sk-test-fake-not-real" }, async () => {
    const { callChat } = await freshMineHardNeg();
    await withStubbedFetch(async () => ({ ok: true, status: 200, headers: new Map(), json: async () => ({ choices: [{ message: { content: "", refusal: null }, finish_reason: "length" }], usage: { completion_tokens: 2000, completion_tokens_details: { reasoning_tokens: 2000 } } }) }),
      async () => {
        await assert.rejects(() => callChat("sys", "usr"), (e) => {
          assert.match(e.message, /reasoning model "gpt-5\.6-terra" exhausted its token budget \(2000\)/);
          assert.equal(e.reasoningExhausted, true);
          return true;
        });
      });
  }));

test("a normal (non-truncated) response is still returned unchanged", async () =>
  withEnv({ ...NO_CREDS_ENV, OPENAI_API_KEY: "sk-test-fake-not-real" }, async () => {
    const { callChat } = await freshMineHardNeg();
    const content = await withStubbedFetch(async () => ({ ok: true, status: 200, headers: new Map(), json: async () => ({ choices: [{ message: { content: '{"query":"q","expect_new":["a"],"expect_old":["b"]}' }, finish_reason: "stop" }] }) }),
      () => callChat("sys", "usr"));
    assert.match(content, /"query":"q"/);
  }));

// ---- counterfactual: main()'s existing per-candidate catch already handles the new throw honestly ----
test("counterfactual: the mining loop's existing per-candidate catch logs 'LLM error for <key>: <message>' and continues -- unchanged by this fix, which is exactly why the throw needed no new plumbing here", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../skills/recall-evals/mine-hard-negatives.mjs", import.meta.url), "utf8");
  assert.match(src, /console\.error\(`\[mine-hardneg\] LLM error for \$\{key\}: \$\{e\.message\}`\)/, "a thrown callChat() error must still land here, not require new error-handling plumbing");
});
