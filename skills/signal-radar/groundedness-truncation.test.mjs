// Tests for skills/signal-radar/detectors/groundedness.mjs's reasoning-truncation handling
// (2026-08-30, FND-20260830-e927 -- the sibling sweep following critic-pass's own fix for the SAME
// failure shape, FND-20260830-e7c1).
//
// ROOT CAUSE, and why this file is a NEW risk the OPENAI_TIERS refresh specifically introduced (unlike
// contradiction-staleness.mjs, whose 'quality' tier was already reasoning-family before that refresh):
// this detector's faithfulness call resolves the 'cheap' tier, which the 2026-08-29 refresh moved from
// gpt-4o-mini (CHAT-family, zero hidden-token cost) to gpt-5.6-luna (REASONING-family). At the smallest
// budget of any caller found in the FND-20260830-e927 sweep (250 tokens), a reasoning model's hidden
// "thinking" tokens count against max_completion_tokens and are spent BEFORE any visible output, which
// can come back finish_reason:"length" with EMPTY content -- an HTTP 200, not an error.
//
// FAIL-ON-OLD-CODE: every test below fails against the pre-2026-08-30 groundedness.mjs (a hardcoded
// 250-token budget, no truncation-retry logic, no truncatedEmpty()/positiveIntEnv() import) and passes
// against the fix. Same makeChecker()/check() invocation convention as the existing
// groundedness-openai-port.test.mjs (check() must be called INSIDE the stubbed-fetch scope).
// IMPORTANT: GROUNDEDNESS_MAX_TOKENS is resolved at MODULE-TOP-LEVEL (matching this file's other
// tunables -- WINDOW_DAYS, MAX_LLM_CALLS -- which already follow this same pattern), NOT per-call
// like GROUNDEDNESS_MODEL is. A static top-of-file import would freeze that constant at whatever the
// ambient environment was the FIRST time this test file's module graph loaded, making every
// env-override test below silently test nothing (or pass for the wrong reason). Every test therefore
// imports the module FRESH with a cache-busting query string, exactly like
// critic-run-truncation.test.mjs's freshRunModule() -- this file's own template.
import { test } from "node:test";
import assert from "node:assert/strict";

async function freshDetector() {
  return import(`../signal-radar/detectors/groundedness.mjs?t=${Date.now()}-${Math.random()}`);
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
const NO_CREDS_ENV = {
  OPENAI_API_KEY: undefined, GROUNDEDNESS_MODEL: undefined, GROUNDEDNESS_MAX_TOKENS: undefined,
  OPENAI_SERVICE_TIER: undefined, OPENAI_SERVICE_TIER_SIGNAL_RADAR_GROUNDEDNESS: undefined,
  AWS_ACCESS_KEY_ID: undefined, AWS_SECRET_ACCESS_KEY: undefined, AWS_SESSION_TOKEN: undefined,
  OTC_AWS_ACCESS_KEY_ID: undefined, OTC_AWS_SECRET_ACCESS_KEY: undefined, OTC_AWS_SESSION_TOKEN: undefined,
  AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: undefined, AWS_CONTAINER_CREDENTIALS_FULL_URI: undefined,
  AZURE_SP_TENANT_ID: undefined, AZURE_SP_CLIENT_ID: undefined, AZURE_SP_CLIENT_SECRET: undefined,
  IDENTITY_ENDPOINT: undefined, IDENTITY_HEADER: undefined,
};
const ROW = { id: "20260830-001", type: "fact", ts: "2026-08-30T00:00:00Z", text: "PlantID's Lambda backend went live behind CloudFront", source: "PR #60/#61 stood up a CloudFront front door over six Lambda Function URLs; /v1/health returned 200" };

function truncatedEmptyResponse() {
  return { ok: true, status: 200, headers: new Map(), json: async () => ({ choices: [{ message: { content: "", refusal: null }, finish_reason: "length" }], usage: { completion_tokens: 250, completion_tokens_details: { reasoning_tokens: 250 } } }) };
}
function okResponse(verdict) {
  return { ok: true, status: 200, headers: new Map(), json: async () => ({ choices: [{ message: { content: JSON.stringify(verdict) }, finish_reason: "stop" }] }) };
}

test("the default token budget is well above the historical 250 (the smallest budget in the whole sweep)", async () =>
  withEnv({ ...NO_CREDS_ENV, OPENAI_API_KEY: "sk-test-fake-not-real" }, async () => {
    let sentBody = null;
    await withStubbedFetch(async (url, init) => { sentBody = JSON.parse(init.body); return okResponse({ rowId: ROW.id, label: "supported" }); },
      async () => { const { makeChecker } = await freshDetector(); const checker = await makeChecker(); return checker(ROW); });
    assert.equal(sentBody.max_completion_tokens, 1500, "must not regress to the historical 250-token budget");
  }));

test("GROUNDEDNESS_MAX_TOKENS is honored as an override", async () =>
  withEnv({ ...NO_CREDS_ENV, OPENAI_API_KEY: "sk-test-fake-not-real", GROUNDEDNESS_MAX_TOKENS: "3000" }, async () => {
    let sentBody = null;
    await withStubbedFetch(async (url, init) => { sentBody = JSON.parse(init.body); return okResponse({ rowId: ROW.id, label: "supported" }); },
      async () => { const { makeChecker } = await freshDetector(); const checker = await makeChecker(); return checker(ROW); });
    assert.equal(sentBody.max_completion_tokens, 3000);
  }));

test("a bad GROUNDEDNESS_MAX_TOKENS override (sub-1 fractional) falls back to the safe default, not a zero-token budget", async () =>
  withEnv({ ...NO_CREDS_ENV, OPENAI_API_KEY: "sk-test-fake-not-real", GROUNDEDNESS_MAX_TOKENS: "0.001" }, async () => {
    let sentBody = null;
    await withStubbedFetch(async (url, init) => { sentBody = JSON.parse(init.body); return okResponse({ rowId: ROW.id, label: "supported" }); },
      async () => { const { makeChecker } = await freshDetector(); const checker = await makeChecker(); return checker(ROW); });
    assert.equal(sentBody.max_completion_tokens, 1500, "a sub-1 fractional override must never floor to 0 and reach the API");
  }));

test("TRUNCATED-EMPTY (finish_reason:length, empty content): auto-escalates the budget ONCE and still produces a real verdict", async () =>
  withEnv({ ...NO_CREDS_ENV, OPENAI_API_KEY: "sk-test-fake-not-real", GROUNDEDNESS_MAX_TOKENS: "500" }, async () => {
    const bodies = [];
    const verdict = await withStubbedFetch(async (url, init) => {
      bodies.push(JSON.parse(init.body));
      return bodies.length === 1 ? truncatedEmptyResponse() : okResponse({ rowId: ROW.id, label: "unsupported", reason: "goes beyond the source" });
    }, async () => { const { makeChecker } = await freshDetector(); const checker = await makeChecker(); return checker(ROW); });

    assert.equal(bodies.length, 2, "must retry exactly once on a truncated-empty response");
    assert.equal(bodies[0].max_completion_tokens, 500);
    assert.equal(bodies[1].max_completion_tokens, 1000, "the retry must double the budget, not repeat the same one");
    assert.deepEqual(verdict, { rowId: ROW.id, label: "unsupported", reason: "goes beyond the source" }, "a real second response must produce the real verdict, not a fail-quiet fabrication");
  }));

test("TRUNCATED-EMPTY that never recovers REJECTS with a distinct, unmistakable error -- never silently fabricates 'supported'", async () =>
  withEnv({ ...NO_CREDS_ENV, OPENAI_API_KEY: "sk-test-fake-not-real", GROUNDEDNESS_MAX_TOKENS: "500" }, async () => {
    const bodies = [];
    await withStubbedFetch(async (url, init) => { bodies.push(JSON.parse(init.body)); return truncatedEmptyResponse(); },
      async () => {
        const { makeChecker } = await freshDetector(); const checker = await makeChecker();
        await assert.rejects(() => checker(ROW), (e) => {
          assert.match(e.message, /^detector ERROR: OpenAI faithfulness call failed: reasoning model exhausted its token budget \(1000\)/,
            "must be unmistakably distinct from a real 'supported' verdict, and must name the actual reasoning-exhaustion cause");
          return true;
        });
      });
    assert.equal(bodies.length, 4, "the normal 4-try loop bounds this -- it must not retry forever");
    assert.equal(bodies[0].max_completion_tokens, 500);
    assert.equal(bodies[1].max_completion_tokens, 1000);
    assert.equal(bodies[2].max_completion_tokens, 1000);
    assert.equal(bodies[3].max_completion_tokens, 1000);
  }));

test("a genuinely malformed (non-empty) response still fail-quiets to 'supported' -- the new truncation handling does not change that established, deliberate posture", async () =>
  withEnv({ ...NO_CREDS_ENV, OPENAI_API_KEY: "sk-test-fake-not-real" }, async () => {
    const verdict = await withStubbedFetch(async () => ({ ok: true, status: 200, headers: new Map(), json: async () => ({ choices: [{ message: { content: "the model rambled, not json" }, finish_reason: "stop" }] }) }),
      async () => { const { makeChecker } = await freshDetector(); const checker = await makeChecker(); return checker(ROW); });
    assert.equal(verdict.label, "supported");
    assert.match(verdict.reason, /malformed model output, fail-quiet/);
  }));
