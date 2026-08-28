// Tests for skills/doc-indexer/bedrock-client.mjs (2026-08-28 port of deep-pass.mjs's LLM step off
// dead Azure Foundry onto AWS Bedrock's Converse API).
//
// TESTING STRATEGY, and why this does NOT use the repo's subprocess + `--import` global-fetch-stub
// technique (skills/doc-indexer/tests/push-search-opensearch.test.mjs): that technique exists
// specifically for a script like indexer.mjs/deep-pass.mjs that parses `process.argv` at MODULE LOAD
// TIME to compute top-level constants (PROFILE, ACCT, CONTAINER, ...) and dispatches a CLI command --
// importing such a script twice with different simulated argv within one process is impossible
// (Node's ES module cache returns the SAME instance), so each differently-configured scenario needs a
// fresh subprocess. bedrock-client.mjs has NO such coupling: converseJson() takes every input as an
// explicit function argument, and its only ambient dependency (AWS credentials, via awsCreds()) reads
// `process.env` FRESH on every call rather than once at import time. That means this module can be
// imported ONCE and exercised repeatedly, in-process, with a stubbed `globalThis.fetch` per test and
// `process.env` saved/restored per test -- the exact pattern tests/cosmos-auth.test.mjs's
// `withStubbedFetch` helper already establishes in this same repo for an equally network-calling,
// equally argv-decoupled module. This is not a lighter substitute for the subprocess technique; it is
// the same rigor (a real stubbed network round trip through the real signing/fetch code), via the
// simpler mechanism the codebase already uses whenever a module's own shape permits it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { converseJson, _internal } from "../bedrock-client.mjs";

const FAKE_ENV = {
  AWS_ACCESS_KEY_ID: "AKIAUNITTESTFAKE0000",
  AWS_SECRET_ACCESS_KEY: "unit-test-fake-secret-access-key-not-real",
  AWS_SESSION_TOKEN: "",
};
const ENV_KEYS = ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "OTC_AWS_ACCESS_KEY_ID", "OTC_AWS_SECRET_ACCESS_KEY", "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", "AWS_CONTAINER_CREDENTIALS_FULL_URI"];

/** Runs `fn` with globalThis.fetch replaced by `stub` and the given env overlaid on process.env,
 *  restoring both afterward regardless of outcome -- mirrors tests/cosmos-auth.test.mjs's
 *  withStubbedFetch, extended to also cover env since awsCreds() (unlike that file's cosmos-auth.mjs)
 *  has no injectable-env seam and reads process.env directly. */
async function withStubbedFetch(stub, env, fn) {
  const originalFetch = globalThis.fetch;
  const originalEnv = {};
  for (const k of ENV_KEYS) originalEnv[k] = process.env[k];
  globalThis.fetch = stub;
  for (const k of ENV_KEYS) {
    if (env && Object.prototype.hasOwnProperty.call(env, k)) process.env[k] = env[k];
    else delete process.env[k];
  }
  try {
    return await fn();
  } finally {
    globalThis.fetch = originalFetch;
    for (const k of ENV_KEYS) {
      if (originalEnv[k] === undefined) delete process.env[k];
      else process.env[k] = originalEnv[k];
    }
  }
}

const TOOL_SCHEMA = { type: "object", properties: { foo: { type: "string" } }, required: ["foo"] };
const BASE_ARGS = { modelId: "us.anthropic.claude-sonnet-4-5-20250929-v1:0", system: "sys", userContent: [{ text: "hi" }], toolName: "emit_analysis", toolSchema: TOOL_SCHEMA };

function bedrockResponse({ toolUse = true, stopReason = "tool_use", input = { foo: "bar" }, inputTokens = 100, outputTokens = 20 } = {}) {
  const content = toolUse ? [{ toolUse: { toolUseId: "t1", name: "emit_analysis", input } }] : [{ text: "sorry, I cannot help with that" }];
  return new Response(JSON.stringify({ output: { message: { role: "assistant", content } }, stopReason, usage: { inputTokens, outputTokens } }), { status: 200 });
}

// _maxRetries:1 on every test below that expects a SINGLE clean fetch call (no throttle/retry
// scenario intended): a bug inside the stubbed fetch callback itself (e.g. a broken assertion) throws
// out of that callback, which converseJson's retry loop would otherwise treat as an ordinary network
// error and retry up to the real production default (6 attempts, ~62s of real backoff) before ever
// surfacing the actual bug -- exactly what happened when this file's happy-path test below first used
// `assert.equal` (reference equality) against a JSON.parse'd copy of TOOL_SCHEMA: the assertion threw
// inside the mock, and the resulting failure took over 60 real seconds to report instead of failing
// instantly. `_maxRetries:1` makes any such bug fail fast; it changes nothing about a test that
// genuinely never hits the retry path (a first-try 200 response).
const NO_RETRY = { _maxRetries: 1 };

test("converseJson: happy path returns the parsed tool input, mapped usage, and stopReason -- exactly one fetch call", async () => {
  let calls = 0;
  await withStubbedFetch(async (url, opts) => {
    calls++;
    assert.equal(opts.method, "POST");
    assert.match(String(url), /^https:\/\/bedrock-runtime\.us-east-1\.amazonaws\.com\/model\/us\.anthropic\.claude-sonnet-4-5-20250929-v1%3A0\/converse$/, "the colon in the model id must be percent-encoded exactly once on the WIRE url");
    assert.ok(opts.headers.Authorization.startsWith("AWS4-HMAC-SHA256 "));
    const body = JSON.parse(opts.body);
    assert.deepEqual(body.toolConfig.toolChoice, { tool: { name: "emit_analysis" } }, "must force the tool, never leave tool choice to the model");
    // deepEqual, not equal: `body` came through JSON.stringify/JSON.parse, so it can never be the
    // SAME object reference as TOOL_SCHEMA even when the request was built correctly -- structural
    // equality is the right check here, reference equality is not.
    assert.deepEqual(body.toolConfig.tools[0].toolSpec.inputSchema.json, TOOL_SCHEMA);
    return bedrockResponse();
  }, FAKE_ENV, async () => {
    const res = await converseJson({ ...BASE_ARGS, ...NO_RETRY });
    assert.deepEqual(res.obj, { foo: "bar" });
    assert.deepEqual(res.usage, { prompt_tokens: 100, completion_tokens: 20 });
    assert.equal(res.stopReason, "tool_use");
  });
  assert.equal(calls, 1);
});

test("converseJson: no toolUse block in the response is a CONTENT failure -- returns obj:null, does NOT throw", async () => {
  await withStubbedFetch(async () => bedrockResponse({ toolUse: false, stopReason: "end_turn" }), FAKE_ENV, async () => {
    const res = await converseJson({ ...BASE_ARGS, ...NO_RETRY });
    assert.equal(res.obj, null);
    assert.equal(res.stopReason, "end_turn");
    assert.deepEqual(res.usage, { prompt_tokens: 100, completion_tokens: 20 }, "usage must still be reported even on a content failure -- callers account tokens spent either way");
  });
});

test("converseJson: max_tokens truncation before a tool call closes is ALSO a content failure (obj:null), not a throw", async () => {
  await withStubbedFetch(async () => bedrockResponse({ toolUse: false, stopReason: "max_tokens" }), FAKE_ENV, async () => {
    const res = await converseJson({ ...BASE_ARGS, ...NO_RETRY });
    assert.equal(res.obj, null);
    assert.equal(res.stopReason, "max_tokens");
  });
});

test("converseJson: a non-retryable HTTP status (403) throws IMMEDIATELY -- exactly one fetch call, no retry burned on an unfixable request", async () => {
  let calls = 0;
  await withStubbedFetch(async () => { calls++; return new Response("access denied", { status: 403 }); }, FAKE_ENV, async () => {
    await assert.rejects(() => converseJson(BASE_ARGS), /bedrock converse 403/);
  });
  assert.equal(calls, 1);
});

test("converseJson: a 429 (ThrottlingException) followed by a 200 succeeds after exactly one retry", async () => {
  let calls = 0;
  await withStubbedFetch(async () => {
    calls++;
    if (calls === 1) return new Response("throttled", { status: 429, headers: { "retry-after": "0" } });
    return bedrockResponse();
  }, FAKE_ENV, async () => {
    // Tiny retry timing so this test does not wait out the real ~2s production backoff.
    const res = await converseJson({ ...BASE_ARGS, _retryBaseMs: 5, _retryMaxMs: 20 });
    assert.deepEqual(res.obj, { foo: "bar" });
  });
  assert.equal(calls, 2, "must have retried exactly once after the 429");
});

test("converseJson: retries exhausted on a persistent 500 throws a diagnosable 'retries exhausted' error, having tried the bounded attempt count", async () => {
  let calls = 0;
  await withStubbedFetch(async () => { calls++; return new Response("internal error", { status: 500 }); }, FAKE_ENV, async () => {
    await assert.rejects(
      () => converseJson({ ...BASE_ARGS, _maxRetries: 3, _retryBaseMs: 5, _retryMaxMs: 20 }),
      /bedrock converse: retries exhausted after 3 attempts/,
    );
  });
  assert.equal(calls, 3, "must attempt exactly _maxRetries times, no more");
});

test("converseJson: a network-level throw from fetch itself is retried with the same bounded policy as an HTTP throttle, then surfaces as a transport failure", async () => {
  let calls = 0;
  await withStubbedFetch(async () => { calls++; throw new Error("ECONNRESET"); }, FAKE_ENV, async () => {
    await assert.rejects(
      () => converseJson({ ...BASE_ARGS, _maxRetries: 2, _retryBaseMs: 5, _retryMaxMs: 20 }),
      /bedrock converse: retries exhausted after 2 attempts.*ECONNRESET/,
    );
  });
  assert.equal(calls, 2);
});

test("converseJson: missing AWS credentials throws BEFORE any fetch call is attempted (fail-closed, not a confusing signed request with an undefined key)", async () => {
  let calls = 0;
  await withStubbedFetch(async () => { calls++; return bedrockResponse(); }, {}, async () => {
    await assert.rejects(() => converseJson(BASE_ARGS), /AWS credentials unavailable/);
  });
  assert.equal(calls, 0, "must never reach the network with no credentials to sign the request");
});

test("converseJson: requires modelId and toolName/toolSchema -- refuses to build a request without them, never silently omits tool-forcing", async () => {
  await assert.rejects(() => converseJson({ ...BASE_ARGS, modelId: undefined }), /requires modelId/);
  await assert.rejects(() => converseJson({ ...BASE_ARGS, toolName: undefined }), /requires toolName \+ toolSchema/);
  await assert.rejects(() => converseJson({ ...BASE_ARGS, toolSchema: undefined }), /requires toolName \+ toolSchema/);
});

test("_internal.isRetryableStatus: exactly 429/500/503, nothing else (401/403/404/400 must not silently retry an unfixable request)", () => {
  assert.equal(_internal.isRetryableStatus(429), true);
  assert.equal(_internal.isRetryableStatus(500), true);
  assert.equal(_internal.isRetryableStatus(503), true);
  for (const s of [200, 400, 401, 403, 404, 502, 504]) assert.equal(_internal.isRetryableStatus(s), false, `status ${s} must not be retryable`);
});

test("_internal.backoffMs: escalates exponentially and is capped at retryMaxMs (bounded, per the design doc's fixed no-attempt-cap bug in the old Azure chat())", () => {
  const b0 = _internal.backoffMs(0, null, 1000, 60000);
  const b1 = _internal.backoffMs(1, null, 1000, 60000);
  const b5 = _internal.backoffMs(5, null, 1000, 60000);
  const b6 = _internal.backoffMs(6, null, 1000, 60000);
  assert.ok(b0 >= 1000 && b0 < 2000, `expected ~1000-2000ms jitter window, got ${b0}`);
  assert.ok(b1 >= 2000 && b1 < 3000, `expected ~2000-3000ms jitter window, got ${b1}`);
  // 1000*2^5 = 32000, still below the 60000 cap -- attempt 5 has not yet hit it.
  assert.ok(b5 >= 32000 && b5 < 33000, `expected ~32000-33000ms (not yet capped), got ${b5}`);
  // 1000*2^6 = 64000 > 60000 -- this is the first attempt where the cap actually binds.
  assert.ok(b6 >= 60000 && b6 < 61000, `expected the cap to bind by attempt 6, got ${b6}`);
});

test("_internal.backoffMs: honors an explicit Retry-After header over the exponential schedule", () => {
  const withHeader = _internal.backoffMs(0, "3", 1000, 60000);
  assert.ok(withHeader >= 3000 && withHeader < 4000, `expected ~3000-4000ms (3s + jitter), got ${withHeader}`);
});
