// Tests for skills/company-brain/brain.mjs's reasoning-truncation handling (2026-08-30,
// FND-20260830-e927 -- the sibling sweep following critic-pass's own fix for the SAME failure shape,
// FND-20260830-e7c1).
//
// ROOT CAUSE, and why this is the HIGHEST-SEVERITY finding in the whole sweep: company-brain is the
// fleet's GROUND-FIRST tool -- every repo's CLAUDE.md instructs every agent to answer any company
// question ONLY from this tool's output, with citations, never a generic disclaimer. Its chat()
// synthesis call resolves the 'standard' tier via resolveTier(..., 'openai'), a REASONING-family model
// since the 2026-08-29 refresh (gpt-5.6-terra; was gpt-4.1, chat-family). Live-reproduced during the
// sibling sweep against this tool's OWN realistic prompt shape (14 sources, a genuinely demanding
// cross-source synthesis question): the OLD 900-token budget truncated 6 of 6 live calls, and even
// 2000 tokens truncated 3 of 3 -- every single time finish_reason:"length" with ZERO visible content,
// an HTTP 200, not an error. Before this fix, callChat() returned that empty string as if it were a
// real (if blank) answer, and ask() printed it between a correct header and a correct "grounded in N
// sources" footer -- a silently blank "answer" from the tool every agent is told to treat as
// authoritative ground truth, not a search-failure (the file's own assessSearchOutcome() correctly
// distinguishes a genuinely empty search result from a broken search, but had no equivalent guard for
// a broken SYNTHESIS step).
//
// FAIL-ON-OLD-CODE: every test below fails against the pre-2026-08-30 brain.mjs (a hardcoded 900-token
// budget baked directly into the fetch body, no truncation-retry logic, no truncatedEmpty()/
// positiveIntEnv() import, callChat() not exported) and passes against the fix.
//
// IMPORTANT: BRAIN_MAX_TOKENS is resolved at MODULE-TOP-LEVEL, so a static top-of-file import would
// freeze it at whatever the ambient environment was the first time this test file's module graph
// loaded. Every test imports the module fresh with a cache-busting query string, exactly like
// critic-run-truncation.test.mjs's freshRunModule() -- this file's own template.
import { test } from "node:test";
import assert from "node:assert/strict";

async function freshBrain() {
  return import(`./brain.mjs?t=${Date.now()}-${Math.random()}`);
}
async function withStubbedFetch(stub, run) {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try { return await run(); } finally { globalThis.fetch = original; }
}
async function withEnv(vars, run) {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  try { return await run(); } finally { for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
}
const CLEAR_ENV = { BRAIN_MAX_TOKENS: undefined };
const OPENAI_PROVIDER = { kind: "openai", key: "sk-test-fake-not-real", dep: "gpt-5.6-terra", label: "openai/gpt-5.6-terra" };

function truncatedEmptyResponse(reasoningTokens) {
  return { ok: true, status: 200, headers: new Map(), json: async () => ({ choices: [{ message: { content: "", refusal: null }, finish_reason: "length" }], usage: { completion_tokens: reasoningTokens, completion_tokens_details: { reasoning_tokens: reasoningTokens } } }) };
}
function okResponse(content) {
  return { ok: true, status: 200, headers: new Map(), json: async () => ({ choices: [{ message: { content }, finish_reason: "stop" }] }) };
}

test("the default token budget is well above the historical 900 (and even the once-also-tried 2000) that truncated a real, realistic synthesis question to empty output", async () =>
  withEnv(CLEAR_ENV, async () => {
    let sentBody = null;
    await withStubbedFetch(async (url, init) => { sentBody = JSON.parse(init.body); return okResponse("a real cited answer"); },
      async () => { const { callChat } = await freshBrain(); return callChat(OPENAI_PROVIDER, "sys", "user", 4); });
    assert.equal(sentBody.max_completion_tokens, 6000, "must not regress to the historical 900 (or the also-truncating 2000) that produced zero visible content on a real question");
  }));

test("BRAIN_MAX_TOKENS is honored as an override", async () =>
  withEnv({ ...CLEAR_ENV, BRAIN_MAX_TOKENS: "8000" }, async () => {
    let sentBody = null;
    await withStubbedFetch(async (url, init) => { sentBody = JSON.parse(init.body); return okResponse("answer"); },
      async () => { const { callChat } = await freshBrain(); return callChat(OPENAI_PROVIDER, "sys", "user", 4); });
    assert.equal(sentBody.max_completion_tokens, 8000);
  }));

test("a bad BRAIN_MAX_TOKENS override (sub-1 fractional) falls back to the safe default, not a zero-token budget", async () =>
  withEnv({ ...CLEAR_ENV, BRAIN_MAX_TOKENS: "0.7" }, async () => {
    let sentBody = null;
    await withStubbedFetch(async (url, init) => { sentBody = JSON.parse(init.body); return okResponse("answer"); },
      async () => { const { callChat } = await freshBrain(); return callChat(OPENAI_PROVIDER, "sys", "user", 4); });
    assert.equal(sentBody.max_completion_tokens, 6000, "a sub-1 fractional override must never floor to 0 and reach the API");
  }));

test("TRUNCATED-EMPTY (finish_reason:length, empty content): auto-escalates the budget ONCE and still returns the real, non-empty answer -- never a silent blank string", async () =>
  withEnv({ ...CLEAR_ENV, BRAIN_MAX_TOKENS: "1000" }, async () => {
    const bodies = [];
    const answer = await withStubbedFetch(async (url, init) => {
      bodies.push(JSON.parse(init.body));
      return bodies.length === 1 ? truncatedEmptyResponse(1000) : okResponse("Flatstick's production backend runs on AWS account 301001539500 [1].");
    }, async () => { const { callChat } = await freshBrain(); return callChat(OPENAI_PROVIDER, "sys", "user", 4); });

    assert.equal(bodies.length, 2, "must retry exactly once on a truncated-empty response");
    assert.equal(bodies[0].max_completion_tokens, 1000);
    assert.equal(bodies[1].max_completion_tokens, 2000, "the retry must double the budget, not repeat the same one");
    assert.equal(answer, "Flatstick's production backend runs on AWS account 301001539500 [1].", "a real second response must be returned verbatim, not a fail-quiet blank");
  }));

test("TRUNCATED-EMPTY that never recovers THROWS a distinct, unmistakable error -- never silently returns '' as a real (blank) answer", async () =>
  withEnv({ ...CLEAR_ENV, BRAIN_MAX_TOKENS: "1000" }, async () => {
    const bodies = [];
    await withStubbedFetch(async (url, init) => { bodies.push(JSON.parse(init.body)); return truncatedEmptyResponse(1000); },
      async () => {
        const { callChat } = await freshBrain();
        await assert.rejects(() => callChat(OPENAI_PROVIDER, "sys", "user", 4), (e) => {
          assert.match(e.message, /^chat openai\/gpt-5\.6-terra: reasoning model exhausted its token budget \(2000\) on hidden reasoning with no visible output \(finish_reason=length\) even after retry\+escalation/,
            "must be unmistakably distinct from a real (even blank) answer, and must name the actual reasoning-exhaustion cause");
          assert.equal(e.reasoningExhausted, true);
          return true;
        });
      });
    assert.equal(bodies.length, 4, "the normal 4-try loop bounds this -- it must not retry forever");
    assert.equal(bodies[0].max_completion_tokens, 1000);
    // Escalates exactly once (call 2), then STAYS at the escalated value for calls 3-4.
    assert.equal(bodies[1].max_completion_tokens, 2000);
    assert.equal(bodies[2].max_completion_tokens, 2000);
    assert.equal(bodies[3].max_completion_tokens, 2000);
  }));

test("a genuine (non-truncation) HTTP failure still throws exactly as before -- the new truncation handling does not change that established behavior", async () =>
  withEnv(CLEAR_ENV, async () => {
    await withStubbedFetch(async () => ({ ok: false, status: 500, headers: new Map(), text: async () => "server error" }),
      async () => {
        const { callChat } = await freshBrain();
        await assert.rejects(() => callChat(OPENAI_PROVIDER, "sys", "user", 1), (e) => { assert.match(e.message, /^chat openai\/gpt-5\.6-terra 500/); return true; });
      });
  }));

test("a 429 retried into a truncated-empty response still escalates correctly (the two retry mechanisms compose, do not conflict)", async () =>
  withEnv({ ...CLEAR_ENV, BRAIN_MAX_TOKENS: "1000" }, async () => {
    const bodies = [];
    let call = 0;
    const answer = await withStubbedFetch(async (url, init) => {
      call++;
      bodies.push(JSON.parse(init.body));
      if (call === 1) return { ok: false, status: 429, headers: new Map([["retry-after", "0.01"]]) };
      if (call === 2) return truncatedEmptyResponse(1000);
      return okResponse("recovered answer");
    }, async () => { const { callChat } = await freshBrain(); return callChat(OPENAI_PROVIDER, "sys", "user", 4); });
    assert.equal(bodies.length, 3);
    assert.equal(bodies[0].max_completion_tokens, 1000);
    assert.equal(bodies[1].max_completion_tokens, 1000, "the 429 retry reuses the same (not-yet-escalated) budget");
    assert.equal(bodies[2].max_completion_tokens, 2000, "escalates only after the truncation is observed, independent of the earlier 429");
    assert.equal(answer, "recovered answer");
  }));
