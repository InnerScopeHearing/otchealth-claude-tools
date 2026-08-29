// Tests for skills/kb-memory/reflect.mjs's model resolution + request-body shape (2026-08-29 fix).
// Before this fix, initModel() hardcoded OAI_DEP/OAI_FB_DEP as literal strings ("gpt-4.1"/"gpt-4o")
// instead of resolving them through setup/model-routing.mjs's OPENAI_TIERS, and callChat()/
// callChatOpenAI() hardcoded a {max_tokens, temperature} request body regardless of which model was
// actually being called. Both were latent bugs: they happened to work only because gpt-4.1/gpt-4o are
// chat-family. The 2026-08-29 OPENAI_TIERS refresh moved 'standard' (and 'cheap') to a REASONING-family
// model, which would have made every reflect call 400 with "Unsupported parameter: max_tokens" had this
// file not been fixed alongside the tier update. This suite pins the fix, mirroring the exact
// withStubbedFetch/withEnv convention skills/shark-tank/shark-round-openai-port.test.mjs and the
// signal-radar *-openai-port.test.mjs files already use.
import { test } from "node:test";
import assert from "node:assert/strict";
import { initModel, ask } from "../reflect.mjs";

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
  OPENAI_API_KEY: undefined, REFLECT_MODEL: undefined, REFLECT_FALLBACK_MODEL: undefined,
  AWS_ACCESS_KEY_ID: undefined, AWS_SECRET_ACCESS_KEY: undefined, AWS_SESSION_TOKEN: undefined,
  OTC_AWS_ACCESS_KEY_ID: undefined, OTC_AWS_SECRET_ACCESS_KEY: undefined, OTC_AWS_SESSION_TOKEN: undefined,
  AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: undefined, AWS_CONTAINER_CREDENTIALS_FULL_URI: undefined,
  AZURE_SP_TENANT_ID: undefined, AZURE_SP_CLIENT_ID: undefined, AZURE_SP_CLIENT_SECRET: undefined,
  IDENTITY_ENDPOINT: undefined, IDENTITY_HEADER: undefined,
};

test("THE FIX: initModel() + ask() resolve the default (standard/mid) tier via OPENAI_TIERS and shape the request for its ACTUAL family (reasoning), never a hardcoded chat-family body", async () => {
  let captured = null;
  await withEnv({ ...NO_CREDS_ENV, OPENAI_API_KEY: "sk-test-fake-not-real" }, async () => {
    await initModel();
    await withStubbedFetch(async (url, opts) => {
      captured = { url: String(url), headers: opts.headers, body: JSON.parse(opts.body) };
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "[]" } }] }) };
    }, () => ask("sys", "user"));
  });
  assert.equal(captured.url, "https://api.openai.com/v1/chat/completions");
  assert.equal(captured.headers.Authorization, "Bearer sk-test-fake-not-real");
  assert.equal(captured.body.model, "gpt-5.6-terra", "default REFLECT_MODEL resolves to the OpenAI standard/mid tier (gpt-5.6-terra, 2026-08-29 refresh), never a frozen hardcoded literal");
  // The regression this file's header describes: reasoning-family MUST use max_completion_tokens and
  // MUST NOT carry a temperature override, or the API 400s. The pre-fix code always sent
  // {max_tokens, temperature: 0.3} regardless of model -- this would have failed outright.
  assert.equal("max_completion_tokens" in captured.body, true, "reasoning-family (gpt-5.6-terra) must use max_completion_tokens");
  assert.equal("max_tokens" in captured.body, false);
  assert.equal("temperature" in captured.body, false, "reasoning-family models reject a temperature override");
});

test("REFLECT_MODEL overrides the default deployment verbatim, and a chat-family override keeps the 0.3 temperature (family-aware, not hardcoded)", async () => {
  let captured = null;
  await withEnv({ ...NO_CREDS_ENV, OPENAI_API_KEY: "sk-test-fake-not-real", REFLECT_MODEL: "gpt-4o" }, async () => {
    await initModel();
    await withStubbedFetch(async (url, opts) => {
      captured = JSON.parse(opts.body);
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "[]" } }] }) };
    }, () => ask("sys", "user"));
  });
  assert.equal(captured.model, "gpt-4o");
  assert.equal(captured.temperature, 0.3, "a chat-family override still carries reflect's 0.3 temperature");
  assert.equal("max_tokens" in captured, true);
});

test("a sustained throttle (primary's internal retry budget exhausted) falls back to the quality/top tier (gpt-5.6-sol), not a hardcoded gpt-4o literal", async () => {
  let calls = 0;
  const seenModels = [];
  const content = await withEnv({ ...NO_CREDS_ENV, OPENAI_API_KEY: "sk-test-fake-not-real" }, async () => {
    await initModel();
    return withStubbedFetch(async (url, opts) => {
      calls++;
      const body = JSON.parse(opts.body);
      seenModels.push(body.model);
      // The primary call (askOpenAI -> callChatOpenAI(OAI_DEP, ..., tries=4)) must 429 on ALL 4 of its
      // own internal retry attempts before askOpenAI gives up and tries the fallback model -- a single
      // 429 is absorbed inside that same retry loop and never reaches the fallback at all.
      if (calls <= 4) return { ok: false, status: 429, headers: new Map([["retry-after", "0.001"]]), text: async () => "" };
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '[{"type":"remember","text":"ok","share":false}]' } }] }) };
    }, () => ask("sys", "user"));
  });
  assert.ok(seenModels.slice(0, 4).every((m) => m === "gpt-5.6-terra"), "all 4 primary retry attempts must target the standard/mid tier");
  assert.equal(seenModels[4], "gpt-5.6-sol", "the fallback (5th call overall) must resolve via OPENAI_TIERS' quality tier, not a frozen literal");
  assert.match(content, /ok/);
});

test("importing reflect.mjs does not auto-execute main() against this test runner's own stdin/process.argv (the isMain guard)", () => {
  assert.equal(typeof initModel, "function");
  assert.equal(typeof ask, "function");
});
