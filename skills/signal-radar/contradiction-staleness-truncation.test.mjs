// Tests for skills/signal-radar/detectors/contradiction-staleness.mjs's reasoning-truncation handling
// (2026-08-30, FND-20260830-e927 -- the sibling sweep following critic-pass's own fix for the SAME
// failure shape, FND-20260830-e7c1).
//
// ROOT CAUSE: this detector's entailment call resolves the 'quality' tier via resolveTier(...,
// 'openai'), a REASONING-family model (gpt-5.6-sol as of the 2026-08-29 refresh; gpt-5.1 before it --
// already reasoning-family either way). A reasoning model's hidden "thinking" tokens count against
// max_completion_tokens and are spent BEFORE any visible output. Live-reproduced during the sibling
// sweep: 1 of 4 initial live calls at the old 400-token budget came back finish_reason:"length" with
// EMPTY content -- an HTTP 200, not an error. Before this fix, that empty content hit
// `JSON.parse(raw)` inside a try/catch that treats ANY parse failure identically to a genuinely
// malformed (non-empty) response: fail-quiet to a fabricated "agree" verdict with only a buried
// `reason` string that gateVerdict() never surfaces (the FIRING_LABELS set only fires on
// contradict/stale-with-material-drift, so an "agree" verdict produces no signal AND no note at all) --
// a real contradiction could be silently missed and look identical to "nothing wrong here."
//
// FAIL-ON-OLD-CODE: every test below fails against the pre-2026-08-30 contradiction-staleness.mjs (a
// hardcoded 400-token budget, no truncation-retry logic, no truncatedEmpty()/positiveIntEnv() import)
// and passes against the fix. Same makeEntailer()/entail() invocation convention as the existing
// contradiction-staleness-openai-port.test.mjs (entail() must be called INSIDE the stubbed-fetch scope).
// IMPORTANT: CONTRADICTION_MAX_TOKENS is resolved at MODULE-TOP-LEVEL (matching this file's other
// tunables -- WINDOW_DAYS, MAX_CANDIDATES, MAX_LLM_CALLS, STALE_MIN_AGE_DAYS -- all of which already
// follow this same pattern), NOT per-call like CONTRADICTION_MODEL is. A static top-of-file import
// would freeze that constant at whatever the ambient environment was the FIRST time this test file's
// module graph loaded, making every env-override test below silently test nothing (or pass for the
// wrong reason). Every test therefore imports the module FRESH with a cache-busting query string,
// exactly like critic-run-truncation.test.mjs's freshRunModule() -- this file's own template.
import { test } from "node:test";
import assert from "node:assert/strict";

async function freshDetector() {
  return import(`../signal-radar/detectors/contradiction-staleness.mjs?t=${Date.now()}-${Math.random()}`);
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
  OPENAI_API_KEY: undefined, CONTRADICTION_MODEL: undefined, CONTRADICTION_MAX_TOKENS: undefined,
  OPENAI_SERVICE_TIER: undefined, OPENAI_SERVICE_TIER_SIGNAL_RADAR_CONTRADICTION_STALENESS: undefined,
  AWS_ACCESS_KEY_ID: undefined, AWS_SECRET_ACCESS_KEY: undefined, AWS_SESSION_TOKEN: undefined,
  OTC_AWS_ACCESS_KEY_ID: undefined, OTC_AWS_SECRET_ACCESS_KEY: undefined, OTC_AWS_SESSION_TOKEN: undefined,
  AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: undefined, AWS_CONTAINER_CREDENTIALS_FULL_URI: undefined,
  AZURE_SP_TENANT_ID: undefined, AZURE_SP_CLIENT_ID: undefined, AZURE_SP_CLIENT_SECRET: undefined,
  IDENTITY_ENDPOINT: undefined, IDENTITY_HEADER: undefined,
};
const NEW_ROW = { id: "20260830-002", type: "fact", ts: "2026-08-30T00:00:00Z", text: "flatstick build is CFBundleVersion 25", ekeys: ["flatstick"] };
const SLICE = [{ id: "20260601-001", type: "fact", ts: "2026-06-01T00:00:00Z", text: "flatstick build is CFBundleVersion 20" }];

function truncatedEmptyResponse() {
  return { ok: true, status: 200, headers: new Map(), json: async () => ({ choices: [{ message: { content: "", refusal: null }, finish_reason: "length" }], usage: { completion_tokens: 400, completion_tokens_details: { reasoning_tokens: 400 } } }) };
}
function okResponse(verdict) {
  return { ok: true, status: 200, headers: new Map(), json: async () => ({ choices: [{ message: { content: JSON.stringify(verdict) }, finish_reason: "stop" }] }) };
}

test("the default token budget is well above the historical 400 that truncated a real live call to empty output", async () =>
  withEnv({ ...NO_CREDS_ENV, OPENAI_API_KEY: "sk-test-fake-not-real" }, async () => {
    let sentBody = null;
    await withStubbedFetch(async (url, init) => { sentBody = JSON.parse(init.body); return okResponse({ label: "agree", citedId: null }); },
      async () => { const { makeEntailer } = await freshDetector(); const entailer = await makeEntailer(); return entailer(NEW_ROW, SLICE); });
    assert.equal(sentBody.max_completion_tokens, 3000, "must not regress to the historical 400-token budget that let a real live call come back empty");
  }));

test("CONTRADICTION_MAX_TOKENS is honored as an override", async () =>
  withEnv({ ...NO_CREDS_ENV, OPENAI_API_KEY: "sk-test-fake-not-real", CONTRADICTION_MAX_TOKENS: "5000" }, async () => {
    let sentBody = null;
    await withStubbedFetch(async (url, init) => { sentBody = JSON.parse(init.body); return okResponse({ label: "agree", citedId: null }); },
      async () => { const { makeEntailer } = await freshDetector(); const entailer = await makeEntailer(); return entailer(NEW_ROW, SLICE); });
    assert.equal(sentBody.max_completion_tokens, 5000);
  }));

test("a bad CONTRADICTION_MAX_TOKENS override (sub-1 fractional) falls back to the safe default, not a zero-token budget", async () =>
  withEnv({ ...NO_CREDS_ENV, OPENAI_API_KEY: "sk-test-fake-not-real", CONTRADICTION_MAX_TOKENS: "0.7" }, async () => {
    let sentBody = null;
    await withStubbedFetch(async (url, init) => { sentBody = JSON.parse(init.body); return okResponse({ label: "agree", citedId: null }); },
      async () => { const { makeEntailer } = await freshDetector(); const entailer = await makeEntailer(); return entailer(NEW_ROW, SLICE); });
    assert.equal(sentBody.max_completion_tokens, 3000, "a sub-1 fractional override must never floor to 0 and reach the API");
  }));

test("TRUNCATED-EMPTY (finish_reason:length, empty content): auto-escalates the budget ONCE and still produces a real verdict", async () =>
  withEnv({ ...NO_CREDS_ENV, OPENAI_API_KEY: "sk-test-fake-not-real", CONTRADICTION_MAX_TOKENS: "1000" }, async () => {
    const bodies = [];
    const verdict = await withStubbedFetch(async (url, init) => {
      bodies.push(JSON.parse(init.body));
      return bodies.length === 1 ? truncatedEmptyResponse() : okResponse({ label: "contradict", citedId: SLICE[0].id, reason: "flip" });
    }, async () => { const { makeEntailer } = await freshDetector(); const entailer = await makeEntailer(); return entailer(NEW_ROW, SLICE); });

    assert.equal(bodies.length, 2, "must retry exactly once on a truncated-empty response");
    assert.equal(bodies[0].max_completion_tokens, 1000);
    assert.equal(bodies[1].max_completion_tokens, 2000, "the retry must double the budget, not repeat the same one");
    assert.deepEqual(verdict, { label: "contradict", citedId: SLICE[0].id, reason: "flip" }, "a real second response must produce the real verdict, not a fail-quiet fabrication");
  }));

test("TRUNCATED-EMPTY that never recovers REJECTS with a distinct, unmistakable error -- never silently fabricates 'agree'", async () =>
  withEnv({ ...NO_CREDS_ENV, OPENAI_API_KEY: "sk-test-fake-not-real", CONTRADICTION_MAX_TOKENS: "1000" }, async () => {
    const bodies = [];
    await withStubbedFetch(async (url, init) => { bodies.push(JSON.parse(init.body)); return truncatedEmptyResponse(); },
      async () => {
        const { makeEntailer } = await freshDetector(); const entailer = await makeEntailer();
        await assert.rejects(() => entailer(NEW_ROW, SLICE), (e) => {
          assert.match(e.message, /^detector ERROR: OpenAI entailment call failed: reasoning model exhausted its token budget \(2000\)/,
            "must be unmistakably distinct from a real 'agree' verdict, and must name the actual reasoning-exhaustion cause");
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

test("a genuinely malformed (non-empty) response still fail-quiets to 'agree' -- the new truncation handling does not change that established, deliberate posture", async () =>
  withEnv({ ...NO_CREDS_ENV, OPENAI_API_KEY: "sk-test-fake-not-real" }, async () => {
    const verdict = await withStubbedFetch(async () => ({ ok: true, status: 200, headers: new Map(), json: async () => ({ choices: [{ message: { content: "the model rambled, not json" }, finish_reason: "stop" }] }) }),
      async () => { const { makeEntailer } = await freshDetector(); const entailer = await makeEntailer(); return entailer(NEW_ROW, SLICE); });
    assert.equal(verdict.label, "agree");
    assert.match(verdict.reason, /malformed model output, fail-quiet/);
  }));
