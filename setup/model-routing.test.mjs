// Tests for setup/model-routing.mjs. Covers the OPENAI_TIERS lane added 2026-08-27 (the Azure Foundry
// retirement port: critic-pass, agent-evals, focus-group-loop, recall-evals all resolve their OpenAI
// model id through resolveTier(tier, "openai") instead of a hardcoded literal), the 2026-08-29 gpt-5.6
// refresh (cheap/standard/quality -> luna/terra/sol, live-verified against a real OpenAI account -- see
// model-routing.mjs's own header for the exact verification evidence), and the accompanying
// env-override + sanity-check + opt-in live-verify additions. Pure module, no real network, no
// secrets -- every assertion here is a plain function call or a mocked fetch.
import { test } from "node:test";
import assert from "node:assert/strict";

async function freshImport() {
  // Bust the ESM module cache with a cache-busting query string so tests that mutate
  // process.env.OPENAI_TIER_* (read at module-evaluation time) actually see a fresh evaluation
  // instead of Node's cached first import.
  return import(`./model-routing.mjs?t=${Date.now()}-${Math.random()}`);
}

test("resolveTier default (no provider arg) is byte-for-byte unchanged: azure/Foundry tiers", async () => {
  const { TIERS, resolveTier } = await freshImport();
  assert.equal(resolveTier("standard").deployment, TIERS.standard.deployment);
  assert.equal(resolveTier("quality").deployment, TIERS.quality.deployment);
  assert.equal(resolveTier("cheap").deployment, TIERS.cheap.deployment);
});

test("resolveTier('azure'/'foundry') explicitly matches the implicit default", async () => {
  const { TIERS, resolveTier } = await freshImport();
  assert.equal(resolveTier("standard", "azure").deployment, TIERS.standard.deployment);
  assert.equal(resolveTier("standard", "foundry").deployment, TIERS.standard.deployment);
});

test("TIERS (the Azure/Foundry table) is untouched by the 2026-08-29 OpenAI refresh", async () => {
  const { TIERS } = await freshImport();
  assert.equal(TIERS.quality.deployment, "gpt-5.1");
  assert.equal(TIERS.standard.deployment, "gpt-4.1");
  assert.equal(TIERS.cheap.deployment, "gpt-4.1-mini");
});

test("resolveTier(tier, 'openai') resolves against OPENAI_TIERS, not TIERS, and matches the live-verified gpt-5.6 family (2026-08-29)", async () => {
  const { OPENAI_TIERS, resolveTier } = await freshImport();
  const cheap = resolveTier("cheap", "openai");
  assert.equal(cheap.deployment, OPENAI_TIERS.cheap.deployment);
  assert.equal(cheap.deployment, "gpt-5.6-luna");
  const std = resolveTier("standard", "openai");
  assert.equal(std.deployment, OPENAI_TIERS.standard.deployment);
  assert.equal(std.deployment, "gpt-5.6-terra");
  const q = resolveTier("quality", "openai");
  assert.equal(q.deployment, OPENAI_TIERS.quality.deployment);
  assert.equal(q.deployment, "gpt-5.6-sol");
});

test("all three OpenAI tiers are now REASONING-family (the 2026-08-29 family change: cheap/standard moved off chat-family)", async () => {
  const { OPENAI_TIERS } = await freshImport();
  assert.equal(OPENAI_TIERS.cheap.modelFamily, "reasoning");
  assert.equal(OPENAI_TIERS.standard.modelFamily, "reasoning");
  assert.equal(OPENAI_TIERS.quality.modelFamily, "reasoning");
});

test("neither quality/standard/cheap OpenAI tier is the banned gpt-4.1-mini or its Azure name", async () => {
  const { OPENAI_TIERS, TIERS } = await freshImport();
  for (const t of ["cheap", "standard", "quality"]) {
    assert.notEqual(OPENAI_TIERS[t].deployment, "gpt-4.1-mini");
    assert.notEqual(OPENAI_TIERS[t].deployment, TIERS.cheap.deployment);
  }
});

test("an explicit deployment override still passes through untouched for either provider", async () => {
  const { resolveTier } = await freshImport();
  assert.equal(resolveTier("some-custom-deployment").deployment, "some-custom-deployment");
  assert.equal(resolveTier("some-custom-deployment", "openai").deployment, "some-custom-deployment");
});

test("modelFamilyOf and chatBody are provider-agnostic (OpenAI shares the Azure request-body shape)", async () => {
  const { OPENAI_TIERS, modelFamilyOf, chatBody } = await freshImport();
  assert.equal(modelFamilyOf(OPENAI_TIERS.quality.deployment), "reasoning"); // gpt-5.6-sol
  assert.equal(modelFamilyOf(OPENAI_TIERS.cheap.deployment), "reasoning");   // gpt-5.6-luna (family change)
  const body = chatBody(OPENAI_TIERS.standard.deployment, { messages: [{ role: "user", content: "hi" }], maxTokens: 10, jsonMode: true });
  assert.equal(body.max_completion_tokens, 10, "gpt-5.6-terra is reasoning-family -> max_completion_tokens, not max_tokens");
  assert.equal("max_tokens" in body, false);
  assert.equal("temperature" in body, false, "reasoning-family models reject a temperature override");
  assert.deepEqual(body.response_format, { type: "json_object" });
});

test("LEGACY_STANDARD is untouched by the OpenAI lane", async () => {
  const { LEGACY_STANDARD } = await freshImport();
  assert.equal(LEGACY_STANDARD.deployment, "gpt-4o");
});

// ---------------------------- OPENAI_TIER_CHEAP / _MID / _TOP env overrides ----------------------------

test("OPENAI_TIER_CHEAP/_MID/_TOP override the cheap/standard/quality OpenAI tier defaults", async () => {
  const saved = { c: process.env.OPENAI_TIER_CHEAP, m: process.env.OPENAI_TIER_MID, t: process.env.OPENAI_TIER_TOP };
  try {
    process.env.OPENAI_TIER_CHEAP = "gpt-test-cheap";
    process.env.OPENAI_TIER_MID = "gpt-test-mid";
    process.env.OPENAI_TIER_TOP = "gpt-test-top";
    const { OPENAI_TIERS, resolveTier } = await freshImport();
    assert.equal(OPENAI_TIERS.cheap.deployment, "gpt-test-cheap");
    assert.equal(OPENAI_TIERS.standard.deployment, "gpt-test-mid");
    assert.equal(OPENAI_TIERS.quality.deployment, "gpt-test-top");
    assert.equal(resolveTier("cheap", "openai").deployment, "gpt-test-cheap");
  } finally {
    for (const [k, v] of [["OPENAI_TIER_CHEAP", saved.c], ["OPENAI_TIER_MID", saved.m], ["OPENAI_TIER_TOP", saved.t]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

test("OPENAI_TIER_ENV_VARS names the env var for each tier key (cheap/standard/quality -> CHEAP/MID/TOP)", async () => {
  const { OPENAI_TIER_ENV_VARS } = await freshImport();
  assert.deepEqual(OPENAI_TIER_ENV_VARS, { cheap: "OPENAI_TIER_CHEAP", standard: "OPENAI_TIER_MID", quality: "OPENAI_TIER_TOP" });
});

// ---------------------------- warnIfImplausibleOpenAIModel (network-free sanity check) ----------------------------

test("warnIfImplausibleOpenAIModel is silent for every real shipped default (no false positives)", async () => {
  const { OPENAI_TIERS, TIERS, LEGACY_STANDARD, warnIfImplausibleOpenAIModel } = await freshImport();
  const savedError = console.error;
  const calls = [];
  console.error = (...args) => calls.push(args);
  try {
    for (const t of Object.values(OPENAI_TIERS)) assert.equal(warnIfImplausibleOpenAIModel(t.deployment), false);
    for (const t of Object.values(TIERS)) assert.equal(warnIfImplausibleOpenAIModel(t.deployment), false);
    assert.equal(warnIfImplausibleOpenAIModel(LEGACY_STANDARD.deployment), false);
  } finally {
    console.error = savedError;
  }
  assert.equal(calls.length, 0, "no real model id should ever trip the sanity check");
});

test("warnIfImplausibleOpenAIModel fires loudly (once) for a value that does not look like an OpenAI model id", async () => {
  const { warnIfImplausibleOpenAIModel } = await freshImport();
  const savedError = console.error;
  const calls = [];
  console.error = (...args) => calls.push(args.join(" "));
  try {
    const fired1 = warnIfImplausibleOpenAIModel("totally-bogus-typo", "TEST_TIER");
    const fired2 = warnIfImplausibleOpenAIModel("totally-bogus-typo", "TEST_TIER"); // same value again
    assert.equal(fired1, true);
    assert.equal(fired2, false, "must not spam stderr for a value it already warned about");
  } finally {
    console.error = savedError;
  }
  assert.equal(calls.length, 1);
  assert.match(calls[0], /totally-bogus-typo/);
  assert.match(calls[0], /TEST_TIER/);
});

test("warnIfImplausibleOpenAIModel never throws on empty/null input", async () => {
  const { warnIfImplausibleOpenAIModel } = await freshImport();
  assert.equal(warnIfImplausibleOpenAIModel(""), false);
  assert.equal(warnIfImplausibleOpenAIModel(null), false);
  assert.equal(warnIfImplausibleOpenAIModel(undefined), false);
});

// ---------------------------- verifyOpenAITiers (opt-in, network-mocked) ----------------------------

test("verifyOpenAITiers reports ok:true when every configured deployment is present in the live catalog", async () => {
  const { OPENAI_TIERS, verifyOpenAITiers } = await freshImport();
  const wanted = new Set(Object.values(OPENAI_TIERS).map((t) => t.deployment));
  const fetchImpl = async (url, opts) => {
    assert.equal(url, "https://api.openai.com/v1/models");
    assert.equal(opts.headers.Authorization, "Bearer sk-test-fake");
    return { ok: true, status: 200, json: async () => ({ data: [...wanted, "some-other-model"].map((id) => ({ id })) }) };
  };
  const result = await verifyOpenAITiers({ apiKey: "sk-test-fake", fetchImpl });
  assert.equal(result.ok, true);
  assert.deepEqual(result.missing, []);
  assert.equal(result.checked.length, wanted.size);
});

test("verifyOpenAITiers reports the exact missing deployment(s) and logs loudly, without throwing", async () => {
  const { verifyOpenAITiers } = await freshImport();
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ data: [{ id: "gpt-5.6-terra" }, { id: "gpt-5.6-sol" }] }) });
  const savedError = console.error;
  const calls = [];
  console.error = (...args) => calls.push(args.join(" "));
  let result;
  try {
    result = await verifyOpenAITiers({ apiKey: "sk-test-fake", fetchImpl, tiers: { cheap: { deployment: "gpt-5.6-luna" }, standard: { deployment: "gpt-5.6-terra" } } });
  } finally {
    console.error = savedError;
  }
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, ["gpt-5.6-luna"]);
  assert.ok(calls.some((c) => c.includes("gpt-5.6-luna")), "must log the missing model loudly");
});

test("verifyOpenAITiers never throws on a network failure or a non-2xx response -- returns a distinct error field", async () => {
  const { verifyOpenAITiers } = await freshImport();
  const netErr = await verifyOpenAITiers({ apiKey: "sk-test-fake", fetchImpl: async () => { throw new Error("ECONNRESET"); } });
  assert.equal(netErr.ok, false);
  assert.match(netErr.error, /network error/);

  const http500 = await verifyOpenAITiers({ apiKey: "sk-test-fake", fetchImpl: async () => ({ ok: false, status: 500 }) });
  assert.equal(http500.ok, false);
  assert.match(http500.error, /HTTP 500/);
});

test("verifyOpenAITiers refuses cleanly (no network call) when no API key is resolvable", async () => {
  // Explicitly clear OPENAI_API_KEY for this one assertion regardless of the ambient environment
  // (a real key may be present in a dev sandbox or CI) -- apiKey:"" alone would otherwise silently
  // fall through to a real env key via `apiKey || process.env.OPENAI_API_KEY` and this test would
  // pass for the wrong reason (or flake) depending on where it runs.
  const saved = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  let fetchCalled = false;
  try {
    const { verifyOpenAITiers } = await freshImport();
    const result = await verifyOpenAITiers({ apiKey: "", fetchImpl: async () => { fetchCalled = true; return { ok: true, json: async () => ({ data: [] }) }; } });
    assert.equal(result.ok, false);
    assert.match(result.error, /no OpenAI API key/);
    assert.equal(fetchCalled, false);
  } finally {
    if (saved === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = saved;
  }
});
