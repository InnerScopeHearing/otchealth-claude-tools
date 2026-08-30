// Tests for skills/agent-evals/run-evals.mjs's reasoning-truncation handling (2026-08-30,
// FND-20260830-e927 -- the sibling sweep following critic-pass's own fix for the SAME failure shape,
// FND-20260830-e7c1).
//
// CONTEXT: this file's persona-answer chat() maxTokens (1200 -> 4000) and judge maxTokens (400 -> 800)
// were ALREADY bumped in the same 2026-08-29 commit that shipped the OPENAI_TIERS gpt-5.6 refresh,
// with the bump itself live-verified against the real API (see that commit's own comment, preserved in
// this file). What was MISSING, and what this fix + these tests cover, is any DETECTION of a truncated-
// empty response at all: callChat()/callChatOpenAI() returned `choices[0].message.content` verbatim
// regardless of finish_reason, so a rare truncation on judgeDefault() specifically produced a FAKE
// 0%/FAIL score (JSON.parse("") throws, caught, degrades to met:[false,...], score:0) that was
// INDISTINGUISHABLE from a genuine rubric failure in the console PASS/FAIL line, the JSON scorecard,
// and the PostHog eval_result payload (whose properties never included the one honest `notes` field
// that already said "judge parse failed"). The fix: escalate-then-throw on truncation (mirroring
// critic-pass/run.mjs's own pattern), so the throw is caught by main()'s ALREADY-EXISTING per-task
// `try { ... } catch (e) { console.error(...); continue; }` -- the task is skipped and logged instead
// of silently scored 0%.
//
// callChatOpenAI/callChat take every value as a plain argument with no dependency on module-level
// state set by initModel(), so both are directly testable with a mocked global.fetch -- same
// established convention as this directory's own run-evals-flex.test.mjs (which this file's fixtures
// deliberately mirror for consistency).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

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

function truncatedEmptyResponse() {
  return { ok: true, status: 200, headers: new Map(), json: async () => ({ choices: [{ message: { content: "", refusal: null }, finish_reason: "length" }], usage: { completion_tokens: 4000, completion_tokens_details: { reasoning_tokens: 4000 } } }) };
}
function okResponse(content) {
  return { ok: true, status: 200, headers: new Map(), json: async () => ({ choices: [{ message: { content }, finish_reason: "stop" }] }) };
}

test("callChatOpenAI: TRUNCATED-EMPTY auto-escalates the budget ONCE and still returns the real content", async () =>
  withEnv(CLEAR_TIER_ENV, async () => {
    const { callChatOpenAI } = await freshRunEvals();
    const bodies = [];
    const content = await withStubbedFetch(async (url, init) => {
      bodies.push(JSON.parse(init.body));
      return bodies.length === 1 ? truncatedEmptyResponse() : okResponse("a real judge verdict or persona answer");
    }, () => callChatOpenAI("sk-test", "gpt-5.6-terra", "sys", "usr", 1000, 4));
    assert.equal(bodies.length, 2, "must retry exactly once on a truncated-empty response");
    assert.equal(bodies[0].max_completion_tokens, 1000);
    assert.equal(bodies[1].max_completion_tokens, 2000, "the retry must double the budget, not repeat the same one");
    assert.equal(content, "a real judge verdict or persona answer");
  }));

test("callChatOpenAI: TRUNCATED-EMPTY that never recovers THROWS a distinct, tagged error -- never silently returns '' as a real (blank) verdict/answer", async () =>
  withEnv(CLEAR_TIER_ENV, async () => {
    const { callChatOpenAI } = await freshRunEvals();
    const bodies = [];
    await withStubbedFetch(async (url, init) => { bodies.push(JSON.parse(init.body)); return truncatedEmptyResponse(); },
      async () => {
        await assert.rejects(() => callChatOpenAI("sk-test", "gpt-5.6-terra", "sys", "usr", 1000, 4), (e) => {
          assert.match(e.message, /^chat: reasoning model "gpt-5\.6-terra" exhausted its token budget \(2000\) on hidden reasoning with no visible output \(finish_reason=length\) even after retry\+escalation/);
          assert.equal(e.reasoningExhausted, true);
          return true;
        });
      });
    assert.equal(bodies.length, 4, "the normal 4-try loop bounds this -- it must not retry forever");
    assert.equal(bodies[1].max_completion_tokens, 2000);
    assert.equal(bodies[2].max_completion_tokens, 2000);
    assert.equal(bodies[3].max_completion_tokens, 2000);
  }));

test("callChatOpenAI: a 429 in between does not consume or repeat the truncation-escalation (the two retry mechanisms are independent)", async () =>
  withEnv(CLEAR_TIER_ENV, async () => {
    const { callChatOpenAI } = await freshRunEvals();
    const bodies = [];
    let call = 0;
    const content = await withStubbedFetch(async (url, init) => {
      call++; bodies.push(JSON.parse(init.body));
      if (call === 1) return truncatedEmptyResponse();
      if (call === 2) return { ok: false, status: 429, headers: new Map([["retry-after", "0.01"]]), text: async () => "no capacity" };
      return okResponse("real content");
    }, () => callChatOpenAI("sk-test", "gpt-5.6-terra", "sys", "usr", 1000, 4));
    assert.equal(bodies.length, 3);
    assert.equal(bodies[0].max_completion_tokens, 1000);
    assert.equal(bodies[1].max_completion_tokens, 2000, "escalated after the truncation, independent of the later 429");
    assert.equal(bodies[2].max_completion_tokens, 2000, "a 429 retry reuses the already-escalated budget, does not re-escalate");
    assert.equal(content, "real content");
  }));

test("callChatOpenAI: a normal (non-truncated) response is returned unchanged -- the fix is scoped to finish_reason:length with empty content specifically", async () =>
  withEnv(CLEAR_TIER_ENV, async () => {
    const { callChatOpenAI } = await freshRunEvals();
    const content = await withStubbedFetch(async () => okResponse("ordinary answer"), () => callChatOpenAI("sk-test", "gpt-5.6-terra", "sys", "usr", 4000, 4));
    assert.equal(content, "ordinary answer");
  }));

test("callChat (Azure path): TRUNCATED-EMPTY auto-escalates the budget ONCE, and never recovering throws a distinct tagged error, mirroring callChatOpenAI exactly", async () =>
  withEnv(CLEAR_TIER_ENV, async () => {
    const { callChat } = await freshRunEvals();
    const bodies = [];
    await withStubbedFetch(async (url, init) => { bodies.push(JSON.parse(init.body)); return truncatedEmptyResponse(); },
      async () => {
        await assert.rejects(() => callChat("https://fake.openai.azure.com", "az-key", "gpt-5.1", "sys", "usr", 1000, 4), (e) => {
          assert.match(e.message, /^chat: reasoning model "gpt-5\.1" exhausted its token budget \(2000\)/);
          assert.equal(e.reasoningExhausted, true);
          return true;
        });
      });
    assert.equal(bodies.length, 4);
    assert.equal(bodies[0].max_completion_tokens, 1000);
    assert.equal(bodies[1].max_completion_tokens, 2000);
  }));

// ---- counterfactual: the specific literal values this fix's own comment documents are still present ----
test("counterfactual: judgeDefault resolves its budget through the env-overridable JUDGE_MAX_TOKENS (>= the historical 800), not a re-hardcoded literal", () => {
  const src = readFileSync(new URL("../run-evals.mjs", import.meta.url), "utf8");
  assert.match(src, /const JUDGE_MAX_TOKENS = positiveIntEnv\("AGENT_EVALS_JUDGE_MAX_TOKENS",\s*1500\)/, "must be env-overridable via positiveIntEnv, not a bare literal");
  assert.match(src, /const out = await chat\(sys, user, JUDGE_MAX_TOKENS\);/, "judgeDefault must call chat() with the named constant, not a re-hardcoded 800");
  assert.doesNotMatch(src, /await chat\(sys, user, 800\)/, "must not regress to the old hardcoded 800");
});

test("counterfactual: main()'s per-task loop still has a catch that skips+logs rather than scoring a thrown chat()/judge() error as 0%/FAIL", () => {
  const src = readFileSync(new URL("../run-evals.mjs", import.meta.url), "utf8");
  assert.match(src, /catch \(e\) \{ console\.error\(` ERROR \$\{e\.message\}`\); continue; \}/, "this existing catch is exactly what makes the escalate-then-throw fix work: a thrown reasoningExhausted error is skipped and logged, never silently scored");
});
