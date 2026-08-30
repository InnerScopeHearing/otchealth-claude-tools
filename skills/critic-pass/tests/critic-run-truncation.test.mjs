// Tests for critic-pass/run.mjs's reasoning-family truncation handling (2026-08-30, FND-20260830-e7c1).
//
// ROOT CAUSE: OPENAI_TIERS.standard moved to a REASONING-family model (gpt-5.6-terra,
// model-routing.mjs's 2026-08-29 refresh). A reasoning model's hidden "thinking" tokens count against
// max_completion_tokens and are spent BEFORE any visible output. The old 700-token default (tuned for
// the prior CHAT-family gpt-4.1, which had no hidden token cost) let the model burn its entire budget
// on reasoning and return finish_reason:"length" with an EMPTY content string -- reproduced live
// against the actual diff that triggered the finding (claude-tools PR #499, commit b0ee6a9: 700
// tokens -> 700 reasoning_tokens -> "" content). parseCriticVerdict("") then fails safe to
// malformed:true, which is how every claude/* PR's auto critic silently stopped reviewing anything.
//
// FAIL-ON-OLD-CODE: every test below fails against the pre-2026-08-30 run.mjs (a hardcoded 700-token
// default, no truncation-retry logic) and passes against the fix. Same withEnv/withStubbedFetch
// convention as critic-run-flex.test.mjs; fully offline (fetch is stubbed, no real network or creds).
import { test } from "node:test";
import assert from "node:assert/strict";

async function freshRunModule() {
  return import(`../run.mjs?t=${Date.now()}-${Math.random()}`);
}
function withEnvVars(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  return (async () => { try { return await fn(); } finally { for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } } })();
}
function withStubbedFetch(stub, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  return (async () => { try { return await fn(); } finally { globalThis.fetch = original; } })();
}
const BASE_ENV = {
  OPENAI_API_KEY: "sk-test-fake-not-real",
  OPENAI_SERVICE_TIER: undefined,
  OPENAI_SERVICE_TIER_CRITIC_PASS: undefined,
  LLM_PROVIDER: undefined, // defaults to openai
  CRITIC_MODEL: undefined,
  CRITIC_FALLBACK_MODEL: undefined,
  CRITIC_MAX_TOKENS: undefined,
};
const approveJson = '{"verdict":"approve","issues":[],"confidence":0.9}';

// The EXACT response shape captured live from the real OpenAI API during this incident (model
// gpt-5.6-terra): finish_reason "length", empty visible content, reasoning tokens consuming the
// whole budget.
function truncatedEmptyResponse() {
  return {
    ok: true,
    status: 200,
    headers: new Map(),
    json: async () => ({
      choices: [{ message: { role: "assistant", content: "", refusal: null }, finish_reason: "length" }],
      usage: { completion_tokens: 700, completion_tokens_details: { reasoning_tokens: 700 } },
    }),
  };
}
function okResponse(content) {
  return { ok: true, status: 200, headers: new Map(), json: async () => ({ choices: [{ message: { content }, finish_reason: "stop" }] }) };
}

test("the default token budget is well above the historical 700 that truncated real diffs to empty output", async () =>
  withEnvVars(BASE_ENV, async () => {
    const { runCriticPass } = await freshRunModule();
    let sentBody = null;
    await withStubbedFetch(async (url, init) => {
      sentBody = JSON.parse(init.body);
      return okResponse(approveJson);
    }, () => runCriticPass({ task: "t", draft: "d" }));
    assert.equal(
      sentBody.max_completion_tokens,
      3000,
      "must not regress to the historical 700-token budget that caused FND-20260830-e7c1",
    );
  }));

test("CRITIC_MAX_TOKENS input validation: unset/zero/negative/fractional/non-finite overrides all fall back to the safe default rather than reaching the API as-is", async () => {
  for (const bad of ["0", "-1", "Infinity", "not-a-number", ""]) {
    await withEnvVars({ ...BASE_ENV, CRITIC_MAX_TOKENS: bad }, async () => {
      const { runCriticPass } = await freshRunModule();
      let sentBody = null;
      await withStubbedFetch(async (url, init) => {
        sentBody = JSON.parse(init.body);
        return okResponse(approveJson);
      }, () => runCriticPass({ task: "t", draft: "d" }));
      assert.equal(sentBody.max_completion_tokens, 3000, `CRITIC_MAX_TOKENS=${JSON.stringify(bad)} must fall back to the default, not reach the API as-is`);
    });
  }
  // a genuinely valid override is still honored, and non-integer values are floored (max_completion_tokens must be a whole number).
  await withEnvVars({ ...BASE_ENV, CRITIC_MAX_TOKENS: "1500.7" }, async () => {
    const { runCriticPass } = await freshRunModule();
    let sentBody = null;
    await withStubbedFetch(async (url, init) => {
      sentBody = JSON.parse(init.body);
      return okResponse(approveJson);
    }, () => runCriticPass({ task: "t", draft: "d" }));
    assert.equal(sentBody.max_completion_tokens, 1500, "a valid fractional override is floored to a whole number, not passed through raw");
  });
});

test("TRUNCATED-EMPTY (finish_reason:length, empty content): auto-escalates the budget ONCE and still returns a real, non-malformed verdict", async () =>
  withEnvVars({ ...BASE_ENV, CRITIC_MAX_TOKENS: "1000" }, async () => {
    const { runCriticPass } = await freshRunModule();
    const bodies = [];
    const r = await withStubbedFetch(async (url, init) => {
      bodies.push(JSON.parse(init.body));
      return bodies.length === 1 ? truncatedEmptyResponse() : okResponse(approveJson);
    }, () => runCriticPass({ task: "t", draft: "d" }));

    assert.equal(bodies.length, 2, "must retry exactly once on a truncated-empty response");
    assert.equal(bodies[0].max_completion_tokens, 1000);
    assert.equal(bodies[1].max_completion_tokens, 2000, "the retry must double the budget, not repeat the same one");

    assert.equal(r.malformed, false, "a real second response must produce a real verdict, not a fail-safe");
    assert.equal(r.unreachable, false);
    assert.equal(r.verdict, "approve");
  }));

test("TRUNCATED-EMPTY that never recovers still terminates within the normal retry budget (no infinite loop) and reports malformed, not a fabricated verdict", async () =>
  withEnvVars({ ...BASE_ENV, CRITIC_MAX_TOKENS: "1000" }, async () => {
    const { runCriticPass } = await freshRunModule();
    const bodies = [];
    const r = await withStubbedFetch(async (url, init) => {
      bodies.push(JSON.parse(init.body));
      return truncatedEmptyResponse(); // every single call truncates, forever
    }, () => runCriticPass({ task: "t", draft: "d" }));

    assert.equal(bodies.length, 4, "the normal 4-try loop bounds this -- it must not retry forever");
    assert.equal(bodies[0].max_completion_tokens, 1000);
    // Escalates exactly once (call 2), then STAYS at the escalated value for calls 3-4 -- it must not
    // keep doubling on every attempt (that would be an unbounded-cost runaway, not a bounded retry).
    assert.equal(bodies[1].max_completion_tokens, 2000);
    assert.equal(bodies[2].max_completion_tokens, 2000);
    assert.equal(bodies[3].max_completion_tokens, 2000);

    assert.equal(r.malformed, true, "still-empty content correctly fails safe to malformed, not a fabricated verdict");
    assert.equal(r.unreachable, false, "the model DID answer (200 OK) every time -- this is not the same failure as unreachable");
  }));

test("a 429 in between does not consume or repeat the truncation-escalation (the two retry mechanisms are independent)", async () =>
  withEnvVars({ ...BASE_ENV, CRITIC_MAX_TOKENS: "1000" }, async () => {
    const { runCriticPass } = await freshRunModule();
    const bodies = [];
    let call = 0;
    const r = await withStubbedFetch(async (url, init) => {
      call++;
      bodies.push(JSON.parse(init.body));
      if (call === 1) return truncatedEmptyResponse();
      if (call === 2) return { ok: false, status: 429, headers: new Map([["retry-after", "0.01"]]), text: async () => "no capacity" };
      return okResponse(approveJson);
    }, () => runCriticPass({ task: "t", draft: "d" }));

    assert.equal(bodies.length, 3);
    assert.equal(bodies[0].max_completion_tokens, 1000);
    assert.equal(bodies[1].max_completion_tokens, 2000, "escalated after the truncation, independent of the later 429");
    assert.equal(bodies[2].max_completion_tokens, 2000, "a 429 retry reuses the already-escalated budget, does not re-escalate");
    assert.equal(r.malformed, false);
    assert.equal(r.verdict, "approve");
  }));
