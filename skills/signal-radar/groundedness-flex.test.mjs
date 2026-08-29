// Tests for skills/signal-radar/detectors/groundedness.mjs's FLEX PROCESSING adoption (2026-08-29,
// see setup/model-routing.mjs's own header for the full OpenAI service_tier contract). Mirrors the
// withStubbedFetch/withEnv convention of the sibling groundedness-openai-port.test.mjs.
//
// GROUNDEDNESS_TIER is resolved ONCE at module-load time (a top-level const), so every test here uses
// a cache-busting dynamic import to get a fresh module instance that sees the env set BEFORE import,
// exactly like setup/model-routing.test.mjs's freshImport() pattern.
import { test } from "node:test";
import assert from "node:assert/strict";

async function freshGroundedness() {
  return import(`../signal-radar/detectors/groundedness.mjs?t=${Date.now()}-${Math.random()}`);
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
  OPENAI_API_KEY: undefined, GROUNDEDNESS_MODEL: undefined,
  OPENAI_SERVICE_TIER: undefined, OPENAI_SERVICE_TIER_SIGNAL_RADAR_GROUNDEDNESS: undefined,
  AWS_ACCESS_KEY_ID: undefined, AWS_SECRET_ACCESS_KEY: undefined, AWS_SESSION_TOKEN: undefined,
  OTC_AWS_ACCESS_KEY_ID: undefined, OTC_AWS_SECRET_ACCESS_KEY: undefined, OTC_AWS_SESSION_TOKEN: undefined,
  AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: undefined, AWS_CONTAINER_CREDENTIALS_FULL_URI: undefined,
  AZURE_SP_TENANT_ID: undefined, AZURE_SP_CLIENT_ID: undefined, AZURE_SP_CLIENT_SECRET: undefined,
  IDENTITY_ENDPOINT: undefined, IDENTITY_HEADER: undefined,
};
const ROW = { id: "20260829-001", type: "fact", ts: "2026-08-29T00:00:00Z", text: "flex lane shipped dark", source: "vendor pricing page: flex is opt-in" };

test("DEFAULT (OPENAI_SERVICE_TIER* unset): no service_tier, no AbortSignal, single attempt -- byte-identical to before the flex lane existed", async () =>
  withEnv(NO_CREDS_ENV, async () => {
    const { makeChecker } = await freshGroundedness();
    let calls = 0, captured = null;
    const verdict = await withEnv({ OPENAI_API_KEY: "sk-test-fake-not-real" }, () =>
      withStubbedFetch(async (url, opts) => {
        calls++; captured = { body: JSON.parse(opts.body), signal: opts.signal };
        return { ok: true, status: 200, headers: new Map(), json: async () => ({ choices: [{ message: { content: JSON.stringify({ rowId: ROW.id, label: "supported" }) } }] }) };
      }, async () => { const checker = await makeChecker(); return checker(ROW); }));
    assert.equal(verdict.label, "supported");
    assert.equal(calls, 1);
    assert.equal("service_tier" in captured.body, false);
    assert.equal(captured.signal, undefined);
  }));

test("OPENAI_SERVICE_TIER_SIGNAL_RADAR_GROUNDEDNESS=flex: adds service_tier, an AbortSignal, and retries a 429 with backoff", async () =>
  withEnv({ ...NO_CREDS_ENV, OPENAI_SERVICE_TIER_SIGNAL_RADAR_GROUNDEDNESS: "flex" }, async () => {
    const { makeChecker } = await freshGroundedness();
    let calls = 0, lastBody = null, sawSignal = false;
    const verdict = await withEnv({ OPENAI_API_KEY: "sk-test-fake-not-real" }, () =>
      withStubbedFetch(async (url, opts) => {
        calls++; lastBody = JSON.parse(opts.body); sawSignal = opts.signal instanceof AbortSignal;
        if (calls < 2) return { ok: false, status: 429, headers: new Map([["retry-after", "0.01"]]), json: async () => ({}) };
        return { ok: true, status: 200, headers: new Map(), json: async () => ({ choices: [{ message: { content: JSON.stringify({ rowId: ROW.id, label: "supported" }) } }] }) };
      }, async () => { const checker = await makeChecker(); return checker(ROW); }));
    assert.equal(verdict.label, "supported");
    assert.equal(calls, 2, "must have retried through the 429 under flex");
    assert.equal(lastBody.service_tier, "flex");
    assert.equal(sawSignal, true);
  }));

test("the fleet-wide OPENAI_SERVICE_TIER=flex default also arms this detector", async () =>
  withEnv({ ...NO_CREDS_ENV, OPENAI_SERVICE_TIER: "flex" }, async () => {
    const { makeChecker } = await freshGroundedness();
    let captured = null;
    await withEnv({ OPENAI_API_KEY: "sk-test-fake-not-real" }, () =>
      withStubbedFetch(async (url, opts) => {
        captured = JSON.parse(opts.body);
        return { ok: true, status: 200, headers: new Map(), json: async () => ({ choices: [{ message: { content: JSON.stringify({ rowId: ROW.id, label: "supported" }) } }] }) };
      }, async () => { const checker = await makeChecker(); return checker(ROW); }));
    assert.equal(captured.service_tier, "flex");
  }));

test("a genuine non-429 failure still fails LOUD under flex too (never retried, never masquerades as a clean verdict)", async () =>
  withEnv({ ...NO_CREDS_ENV, OPENAI_SERVICE_TIER: "flex" }, async () => {
    const { makeChecker } = await freshGroundedness();
    let calls = 0;
    await withEnv({ OPENAI_API_KEY: "sk-test-fake-not-real" }, () =>
      withStubbedFetch(async () => { calls++; return { ok: false, status: 500, headers: new Map(), json: async () => ({}) }; },
        async () => {
          const checker = await makeChecker();
          await assert.rejects(() => checker(ROW), (e) => { assert.equal(e.message, "detector ERROR: OpenAI faithfulness call failed: chat 500"); return true; });
        }));
    assert.equal(calls, 1, "a non-429 failure must not be retried, even under flex");
  }));
