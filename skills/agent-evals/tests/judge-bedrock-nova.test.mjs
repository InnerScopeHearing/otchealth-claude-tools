// Tests for skills/agent-evals/judge-bedrock-nova.mjs, the opt-in Bedrock Nova judge lane
// (JUDGE_PROVIDER=bedrock-nova / --judge-compare in run-evals.mjs).
//
// Same testing strategy as skills/doc-indexer/tests/bedrock-client.test.mjs (which this module wraps):
// converseJson()'s only ambient dependency is AWS credentials via awsCreds(), which reads process.env
// fresh on every call, so this module can be imported once and exercised repeatedly in-process with a
// stubbed globalThis.fetch per test. This is the SAME rigor as that file's own suite (a real stubbed
// network round trip through the real SigV4-signing + fetch code, including the double-encoded-path
// mechanics), via the same mechanism.
import { test } from "node:test";
import assert from "node:assert/strict";
import { judgeBedrockNova, BEDROCK_NOVA_JUDGE_MODEL, BEDROCK_NOVA_MICRO_JUDGE_MODEL, BEDROCK_NOVA_MODELS } from "../judge-bedrock-nova.mjs";

const FAKE_ENV = {
  AWS_ACCESS_KEY_ID: "AKIAUNITTESTFAKE0000",
  AWS_SECRET_ACCESS_KEY: "unit-test-fake-secret-access-key-not-real",
  AWS_SESSION_TOKEN: "",
};
const ENV_KEYS = ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "OTC_AWS_ACCESS_KEY_ID", "OTC_AWS_SECRET_ACCESS_KEY", "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", "AWS_CONTAINER_CREDENTIALS_FULL_URI"];

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

function bedrockToolResponse(input) {
  return new Response(JSON.stringify({
    output: { message: { role: "assistant", content: [{ toolUse: { toolUseId: "t1", name: "record_verdict", input } }] } },
    stopReason: "tool_use",
    usage: { inputTokens: 100, outputTokens: 20 },
  }), { status: 200 });
}

const RUBRIC = ["mentions the root cause", "gives a concrete fix"];

test("BEDROCK_NOVA_JUDGE_MODEL defaults to the exact live-verified inference profile id", () => {
  assert.equal(BEDROCK_NOVA_JUDGE_MODEL, "us.amazon.nova-lite-v1:0");
});

test("BEDROCK_NOVA_MICRO_JUDGE_MODEL (2026-09-02, the third cost-lever option) defaults to the Nova Micro inference profile id", () => {
  assert.equal(BEDROCK_NOVA_MICRO_JUDGE_MODEL, "us.amazon.nova-micro-v1:0");
});

test("BEDROCK_NOVA_MODELS maps run-evals.mjs's EVAL_JUDGE friendly names to the two live model ids", () => {
  assert.deepEqual(BEDROCK_NOVA_MODELS, { "nova-micro": "us.amazon.nova-micro-v1:0", "nova-lite": "us.amazon.nova-lite-v1:0" });
});

test("judgeBedrockNova against the Nova Micro model id (via BEDROCK_NOVA_MODELS['nova-micro']) uses the same Converse call shape as nova-lite", async () => {
  let captured = null;
  const result = await withStubbedFetch(async (url, opts) => {
    captured = { url: String(url), body: JSON.parse(opts.body) };
    return bedrockToolResponse({ met: [true, true], notes: "cheap judge agrees" });
  }, FAKE_ENV, () => judgeBedrockNova("diagnose the OOM", RUBRIC, "answer text", { model: BEDROCK_NOVA_MODELS["nova-micro"] }));
  assert.equal(captured.url, "https://bedrock-runtime.us-east-1.amazonaws.com/model/us.amazon.nova-micro-v1%3A0/converse");
  assert.equal(captured.body.toolConfig.toolChoice.tool.name, "record_verdict");
  assert.deepEqual(result.met, [true, true]);
  assert.equal(result.score, 1);
});

test("judgeBedrockNova: happy path -- signs the Converse call to the DOUBLE-encoded canonical / SINGLE-encoded wire path, and returns the SAME {met,score,notes} shape as the default judge", async () => {
  let captured = null;
  const result = await withStubbedFetch(async (url, opts) => {
    captured = { url: String(url), method: opts.method, body: JSON.parse(opts.body) };
    return bedrockToolResponse({ met: [true, false], notes: "root cause named, no concrete fix given" });
  }, FAKE_ENV, () => judgeBedrockNova("diagnose the OOM", RUBRIC, "the container ran out of memory"));

  // The wire path must be SINGLY percent-encoded (the ':' in the model id -> %3A, not %253A) -- this
  // is the exact regression this whole file exists to prevent; asserting on the literal URL is the
  // only way to catch a signer that sends one path while signing a different one.
  assert.equal(captured.url, "https://bedrock-runtime.us-east-1.amazonaws.com/model/us.amazon.nova-lite-v1%3A0/converse");
  assert.equal(captured.method, "POST");
  assert.equal(captured.body.toolConfig.toolChoice.tool.name, "record_verdict");
  assert.match(JSON.stringify(captured.body.messages), /diagnose the OOM/);
  assert.match(JSON.stringify(captured.body.messages), /mentions the root cause/);

  assert.deepEqual(result.met, [true, false]);
  assert.equal(result.score, 0.5);
  assert.equal(result.notes, "root cause named, no concrete fix given");
});

test("judgeBedrockNova pads/truncates a short or long `met` array to rubric.length, exactly like the default judge's own defensiveness", async () => {
  const short = await withStubbedFetch(async () => bedrockToolResponse({ met: [true], notes: "x" }), FAKE_ENV, () => judgeBedrockNova("t", RUBRIC, "a"));
  assert.deepEqual(short.met, [true, false]);
  assert.equal(short.score, 0.5);

  const long = await withStubbedFetch(async () => bedrockToolResponse({ met: [true, true, true], notes: "x" }), FAKE_ENV, () => judgeBedrockNova("t", RUBRIC, "a"));
  assert.deepEqual(long.met, [true, true]);
  assert.equal(long.score, 1);
});

test("judgeBedrockNova degrades safely (all-false, distinguishing note) on a CONTENT failure (no tool call in the response), never throwing", async () => {
  const noToolResponse = new Response(JSON.stringify({
    output: { message: { role: "assistant", content: [{ text: "sorry, I cannot help with that" }] } },
    stopReason: "end_turn",
    usage: { inputTokens: 10, outputTokens: 5 },
  }), { status: 200 });
  const result = await withStubbedFetch(async () => noToolResponse, FAKE_ENV, () => judgeBedrockNova("t", RUBRIC, "a"));
  assert.deepEqual(result.met, [false, false]);
  assert.equal(result.score, 0);
  assert.match(result.notes, /no usable tool call/);
});

test("judgeBedrockNova PROPAGATES a transport failure (non-retryable HTTP status) as a throw, never masking it as a low score -- the fail-loud contract", async () => {
  await assert.rejects(
    () => withStubbedFetch(async () => new Response("access denied", { status: 403 }), FAKE_ENV, () => judgeBedrockNova("t", RUBRIC, "a")),
    /bedrock converse 403/,
  );
});

test("judgeBedrockNova PROPAGATES a missing-AWS-credentials failure as a throw (never silently proceeds with an empty/fake signature)", async () => {
  let fetchCalled = false;
  await assert.rejects(
    () => withStubbedFetch(async () => { fetchCalled = true; throw new Error("must not call fetch with zero resolvable AWS credentials"); }, {}, () => judgeBedrockNova("t", RUBRIC, "a")),
    /AWS credentials unavailable/,
  );
  assert.equal(fetchCalled, false);
});

test("an explicit model/region override is honored (used by --judge-compare and any future caller pinning a specific profile)", async () => {
  let capturedUrl = null;
  await withStubbedFetch(async (url) => { capturedUrl = String(url); return bedrockToolResponse({ met: [true, true], notes: "ok" }); }, FAKE_ENV,
    () => judgeBedrockNova("t", RUBRIC, "a", { model: "us.amazon.nova-micro-v1:0", region: "us-west-2" }));
  assert.equal(capturedUrl, "https://bedrock-runtime.us-west-2.amazonaws.com/model/us.amazon.nova-micro-v1%3A0/converse");
});

test("zero-criterion rubric never divides by zero (score is 0, not NaN)", async () => {
  const result = await withStubbedFetch(async () => bedrockToolResponse({ met: [], notes: "no criteria" }), FAKE_ENV, () => judgeBedrockNova("t", [], "a"));
  assert.equal(result.score, 0);
  assert.deepEqual(result.met, []);
});
