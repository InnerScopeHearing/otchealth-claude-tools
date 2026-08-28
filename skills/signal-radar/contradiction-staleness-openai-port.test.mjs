// Tests for skills/signal-radar/detectors/contradiction-staleness.mjs's OpenAI-direct port
// (2026-08-28). Azure Foundry (the whole estate makeEntailer() used exclusively) is permanently
// deleted -- verified HTTP 401 forever, not a transient outage (see FND-20260819-c9bb, which named
// this detector as one of six fleet skills still hard-dependent on it, and the fleet's established
// port pattern in skills/critic-pass/run.mjs / skills/kb-memory/memory-librarian.mjs).
//
// This file exercises the REAL network call makeEntailer() returns (mocking global.fetch, in-process
// -- the same withStubbedFetch/withEnv convention as skills/kb-memory/tests/s3-blob-write-path.test.mjs
// and skills/signal-radar/groundedness-openai-port.test.mjs), which is what the existing
// contradiction-staleness.test.mjs deliberately does NOT cover (it injects a fake entail() to test the
// pure scanRows/gateVerdict/candidateSlice core).
//
// IMPORTANT test-harness note: makeEntailer() returns a CLOSURE (the real entail(newRow, slice)
// function), and that closure must be INVOKED while global.fetch is still stubbed, not after
// withStubbedFetch has already restored the real fetch -- calling it afterward would silently hit the
// real api.openai.com with a fake key and get a real 401, which can accidentally still satisfy a loose
// assertion (this exact mistake was caught and fixed while writing this file's sibling for
// groundedness.mjs). Every test below therefore calls makeEntailer() AND entail(...) inside the SAME
// withStubbedFetch scope.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { makeEntailer } from "../signal-radar/detectors/contradiction-staleness.mjs";

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

// Cleared on every test so a real sandbox credential never leaks in and every scenario is fully
// deterministic -- kvSecret()'s SSM/Key-Vault legs must never actually be reachable from these tests.
const NO_CREDS_ENV = {
  OPENAI_API_KEY: undefined, CONTRADICTION_MODEL: undefined,
  AWS_ACCESS_KEY_ID: undefined, AWS_SECRET_ACCESS_KEY: undefined, AWS_SESSION_TOKEN: undefined,
  OTC_AWS_ACCESS_KEY_ID: undefined, OTC_AWS_SECRET_ACCESS_KEY: undefined, OTC_AWS_SESSION_TOKEN: undefined,
  AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: undefined, AWS_CONTAINER_CREDENTIALS_FULL_URI: undefined,
  AZURE_SP_TENANT_ID: undefined, AZURE_SP_CLIENT_ID: undefined, AZURE_SP_CLIENT_SECRET: undefined,
  IDENTITY_ENDPOINT: undefined, IDENTITY_HEADER: undefined,
};

const NEW_ROW = { id: "20260828-002", type: "fact", ts: "2026-08-28T00:00:00Z", text: "flatstick build is CFBundleVersion 25", ekeys: ["flatstick"] };
const SLICE = [{ id: "20260601-001", type: "fact", ts: "2026-06-01T00:00:00Z", text: "flatstick build is CFBundleVersion 20" }];

test("makeEntailer() with no OPENAI_API_KEY and no resolvable fleet secret returns null (the caller reports 'detector idle', never a false pass)", async () => {
  let fetchCalled = false;
  const entailer = await withEnv(NO_CREDS_ENV, () =>
    withStubbedFetch(async () => { fetchCalled = true; throw new Error("must not call fetch with zero resolvable AWS/Azure credentials"); },
      () => makeEntailer()));
  assert.equal(entailer, null, "no usable provider -> makeEntailer must return null, not an entailer that would throw later");
  assert.equal(fetchCalled, false, "with no AWS/Azure credentials resolvable at all, kvSecret's SSM/KeyVault legs must short-circuit without ever calling fetch");
});

test("THE OPENAI PATH WORKS: makeEntailer() with OPENAI_API_KEY set calls api.openai.com with the quality-tier model and Bearer auth, and parses a real verdict", async () => {
  let captured = null;
  const verdict = await withEnv({ ...NO_CREDS_ENV, OPENAI_API_KEY: "sk-test-fake-not-real" }, () =>
    withStubbedFetch(async (url, opts) => {
      captured = { url: String(url), headers: opts.headers, body: JSON.parse(opts.body) };
      return { ok: true, status: 200, headers: new Map(), json: async () => ({ choices: [{ message: { content: JSON.stringify({ label: "contradict", citedId: SLICE[0].id, reason: "flip" }) } }] }) };
    }, async () => {
      const entailer = await makeEntailer();
      assert.ok(entailer, "a resolvable OpenAI key must yield a working entailer");
      return entailer(NEW_ROW, SLICE); // invoked INSIDE the stub scope -- see the file-header note
    }));
  assert.equal(captured.url, "https://api.openai.com/v1/chat/completions");
  assert.equal(captured.headers.Authorization, "Bearer sk-test-fake-not-real");
  assert.equal(captured.body.model, "gpt-5.1", "default CONTRADICTION_MODEL resolves to the OpenAI quality/reasoning tier (gpt-5.1), NOT gpt-4.1-mini (banned for judgment work)");
  assert.equal(captured.body.response_format.type, "json_object");
  // gpt-5.1 is reasoning-family: chatBody() must use max_completion_tokens with NO temperature override
  // (the API rejects a non-default temperature for reasoning models) -- proves the OpenAI port correctly
  // reuses chatBody()'s existing modelFamilyOf() branch rather than hardcoding the chat-family shape.
  assert.equal("max_completion_tokens" in captured.body, true, "reasoning-family (gpt-5.1) must use max_completion_tokens");
  assert.equal("max_tokens" in captured.body, false);
  assert.equal("temperature" in captured.body, false, "reasoning-family models reject a temperature override");
  assert.deepEqual(verdict, { label: "contradict", citedId: SLICE[0].id, reason: "flip" });
});

test("CONTRADICTION_MODEL overrides the default deployment verbatim (an explicit raw model id, not tier-resolved)", async () => {
  let captured = null;
  await withEnv({ ...NO_CREDS_ENV, OPENAI_API_KEY: "sk-test-fake-not-real", CONTRADICTION_MODEL: "gpt-4.1" }, () =>
    withStubbedFetch(async (url, opts) => {
      captured = JSON.parse(opts.body);
      return { ok: true, status: 200, headers: new Map(), json: async () => ({ choices: [{ message: { content: JSON.stringify({ label: "agree", citedId: null }) } }] }) };
    }, async () => { const entailer = await makeEntailer(); return entailer(NEW_ROW, SLICE); }));
  assert.equal(captured.model, "gpt-4.1");
  // gpt-4.1 is chat-family, unlike the reasoning-family default -- confirms the body shape tracks the
  // ACTUAL model in use, not a hardcoded reasoning assumption baked in for the default case only.
  assert.equal("max_tokens" in captured, true);
  assert.equal("temperature" in captured, true);
});

test("THE FAIL-LOUD FIX: a genuine (non-throttled) OpenAI failure REJECTS with a distinct 'detector ERROR:' message, never a silent fail-quiet pass", async () => {
  await withEnv({ ...NO_CREDS_ENV, OPENAI_API_KEY: "sk-test-fake-not-real" }, () =>
    withStubbedFetch(async () => ({ ok: false, status: 500, headers: new Map(), json: async () => ({}) }), async () => {
      const entailer = await makeEntailer();
      await assert.rejects(() => entailer(NEW_ROW, SLICE), (e) => {
        assert.match(e.message, /^detector ERROR: OpenAI entailment call failed: chat 500$/, "must be unmistakably distinct from a real 'agree'/'no issues found' verdict, and must actually be a synthetic 500, not a real network 401");
        return true;
      });
    }));
});

test("a throttled (429, retries exhausted) OpenAI call still fail-quiets to 'agree' (preserves the pre-port never-fabricate-a-verdict posture)", async () => {
  let calls = 0;
  const verdict = await withEnv({ ...NO_CREDS_ENV, OPENAI_API_KEY: "sk-test-fake-not-real" }, () =>
    withStubbedFetch(async () => { calls++; return { ok: false, status: 429, headers: new Map([["retry-after", "0.01"]]), json: async () => ({}) }; },
      async () => { const entailer = await makeEntailer(); return entailer(NEW_ROW, SLICE); }));
  assert.equal(verdict.label, "agree");
  assert.equal(verdict.citedId, null);
  assert.match(verdict.reason, /throttled, fail-quiet/);
  assert.ok(calls >= 2, "must actually retry on 429 before fail-quieting");
});

test("malformed (non-JSON) OpenAI content still fail-quiets to 'agree' distinctly from an unreachable provider", async () => {
  const verdict = await withEnv({ ...NO_CREDS_ENV, OPENAI_API_KEY: "sk-test-fake-not-real" }, () =>
    withStubbedFetch(async () => ({ ok: true, status: 200, headers: new Map(), json: async () => ({ choices: [{ message: { content: "the model rambled, not json" } }] }) }),
      async () => { const entailer = await makeEntailer(); return entailer(NEW_ROW, SLICE); }));
  assert.equal(verdict.label, "agree");
  assert.equal(verdict.citedId, null);
  assert.match(verdict.reason, /malformed model output, fail-quiet/);
});

// ---- counterfactual: the ported file still calls OpenAI direct and keeps the Foundry path as a kept opt-in ----
test("contradiction-staleness.mjs calls OpenAI direct by default and keeps the Foundry path only behind LLM_PROVIDER=foundry/azure (not deleted)", () => {
  const src = readFileSync(new URL("../signal-radar/detectors/contradiction-staleness.mjs", import.meta.url), "utf8");
  assert.match(src, /api\.openai\.com\/v1\/chat\/completions/, "must call OpenAI direct");
  assert.match(src, /LLM_PROVIDER.*openai/i, "must default to the openai provider");
  assert.match(src, /azure-foundry-openai-endpoint/, "the Foundry opt-in path must still exist, not be deleted");
  assert.match(src, /detector ERROR:/, "the fail-loud marker must be present in source");
});
