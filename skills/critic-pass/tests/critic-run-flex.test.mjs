// Tests for critic-pass/run.mjs's FLEX PROCESSING adoption (2026-08-29, see setup/model-routing.mjs's
// own header for the full OpenAI service_tier contract). Unlike critic-run.test.mjs (which injects a
// fake chatFn and never touches network), these tests exercise the REAL defaultChat -> defaultOpenAIChat
// -> callChatOpenAI path with a mocked global.fetch, the same withEnv/withStubbedFetch convention as
// skills/signal-radar/groundedness-openai-port.test.mjs.
//
// run.mjs resolves CRITIC_TIER = serviceTierFor("critic-pass") ONCE at module-load time (mirroring the
// file's existing LLM_PROVIDER/TIER_PROVIDER module-level consts), so every test here uses a
// cache-busting dynamic import (a fresh module instance per test) to see the env it set BEFORE import.
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
};
const approveJson = '{"verdict":"approve","issues":[],"confidence":0.9}';

test("DEFAULT (OPENAI_SERVICE_TIER unset): the real network path sends no service_tier and no AbortSignal -- byte-identical to before the flex lane existed", async () =>
  withEnvVars(BASE_ENV, async () => {
    const { runCriticPass } = await freshRunModule();
    let captured = null;
    const r = await withStubbedFetch(async (url, init) => {
      captured = { url: String(url), init, body: JSON.parse(init.body) };
      return { ok: true, status: 200, headers: new Map(), json: async () => ({ choices: [{ message: { content: approveJson } }] }) };
    }, () => runCriticPass({ task: "t", draft: "d" }));
    assert.equal(r.verdict, "approve");
    assert.equal(captured.url, "https://api.openai.com/v1/chat/completions");
    assert.equal("service_tier" in captured.body, false);
    assert.equal(captured.init.signal, undefined);
  }));

test("OPENAI_SERVICE_TIER_CRITIC_PASS=flex: the real network path adds service_tier:flex and an AbortSignal, and retries a 429 with backoff", async () =>
  withEnvVars({ ...BASE_ENV, OPENAI_SERVICE_TIER_CRITIC_PASS: "flex" }, async () => {
    const { runCriticPass } = await freshRunModule();
    let calls = 0, lastBody = null, sawSignal = false;
    const r = await withStubbedFetch(async (url, init) => {
      calls++; lastBody = JSON.parse(init.body); sawSignal = init.signal instanceof AbortSignal;
      if (calls < 2) return { ok: false, status: 429, headers: new Map([["retry-after", "0.01"]]), text: async () => "no capacity" };
      return { ok: true, status: 200, headers: new Map(), json: async () => ({ choices: [{ message: { content: approveJson } }] }) };
    }, () => runCriticPass({ task: "t", draft: "d" }));
    assert.equal(r.verdict, "approve");
    assert.equal(calls, 2, "must have retried through the first 429");
    assert.equal(lastBody.service_tier, "flex");
    assert.equal(sawSignal, true);
  }));

test("the fleet-wide OPENAI_SERVICE_TIER=flex default also arms critic-pass (not just the per-caller var)", async () =>
  withEnvVars({ ...BASE_ENV, OPENAI_SERVICE_TIER: "flex" }, async () => {
    const { runCriticPass } = await freshRunModule();
    let captured = null;
    await withStubbedFetch(async (url, init) => {
      captured = JSON.parse(init.body);
      return { ok: true, status: 200, headers: new Map(), json: async () => ({ choices: [{ message: { content: approveJson } }] }) };
    }, () => runCriticPass({ task: "t", draft: "d" }));
    assert.equal(captured.service_tier, "flex");
  }));

test("a genuine non-429 failure is UNREACHABLE (fail-loud, distinct from a fabricated approve), any tier -- never retried under flex either", async () =>
  withEnvVars({ ...BASE_ENV, OPENAI_SERVICE_TIER: "flex" }, async () => {
    const { runCriticPass } = await freshRunModule();
    let calls = 0;
    const r = await withStubbedFetch(async () => { calls++; return { ok: false, status: 500, headers: new Map(), text: async () => "server error" }; },
      () => runCriticPass({ task: "t", draft: "d" }));
    assert.equal(r.unreachable, true);
    assert.equal(r.verdict, null, "must never fabricate an approve verdict from a real provider outage");
    assert.equal(calls, 1, "a non-429 failure must not be retried, even under flex");
  }));
