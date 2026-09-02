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

// ============================================================================================
// FLEX PROCESSING (2026-08-29) -- serviceTierEnvVar / serviceTierFor / isFlexTier / flexRetryPolicy /
// chatBody's serviceTier option / fetchOpenAIWithFlexRetry. Every "default" assertion below proves
// the fleet-wide byte-identical-until-opted-in contract: with OPENAI_SERVICE_TIER* completely unset
// (the state of every real deployment today), nothing here changes shape, timing, or retry count.
// ============================================================================================

function withEnvVars(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  return (async () => {
    try { return await fn(); }
    finally { for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
  })();
}
function withStubbedFetch(stub, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  return (async () => { try { return await fn(); } finally { globalThis.fetch = original; } })();
}
const CLEAR_TIER_ENV = {
  OPENAI_SERVICE_TIER: undefined,
  OPENAI_SERVICE_TIER_AGENT_EVALS: undefined,
  OPENAI_SERVICE_TIER_TEST_CALLER: undefined,
  OPENAI_FLEX_TIMEOUT_MS: undefined,
  OPENAI_FLEX_MIN_RETRIES: undefined,
};

// ---- serviceTierEnvVar ----------------------------------------------------------------------

test("serviceTierEnvVar slugifies a caller name into OPENAI_SERVICE_TIER_<CALLER>", async () => {
  const { serviceTierEnvVar } = await freshImport();
  assert.equal(serviceTierEnvVar("agent-evals"), "OPENAI_SERVICE_TIER_AGENT_EVALS");
  assert.equal(serviceTierEnvVar("recall-evals-mine-hard-negatives"), "OPENAI_SERVICE_TIER_RECALL_EVALS_MINE_HARD_NEGATIVES");
  assert.equal(serviceTierEnvVar("signal-radar-groundedness"), "OPENAI_SERVICE_TIER_SIGNAL_RADAR_GROUNDEDNESS");
});

test("serviceTierEnvVar returns null for an empty/missing caller name", async () => {
  const { serviceTierEnvVar } = await freshImport();
  assert.equal(serviceTierEnvVar(""), null);
  assert.equal(serviceTierEnvVar(undefined), null);
  assert.equal(serviceTierEnvVar(null), null);
});

// ---- serviceTierFor: THE byte-identical-by-default lock --------------------------------------

test("serviceTierFor resolves undefined (never an empty string) when nothing is set -- today's behavior everywhere", async () =>
  withEnvVars(CLEAR_TIER_ENV, async () => {
    const { serviceTierFor } = await freshImport();
    assert.equal(serviceTierFor("agent-evals"), undefined);
    assert.equal(serviceTierFor(), undefined);
  }));

test("serviceTierFor: the global OPENAI_SERVICE_TIER applies to any caller (or none)", async () =>
  withEnvVars({ ...CLEAR_TIER_ENV, OPENAI_SERVICE_TIER: "flex" }, async () => {
    const { serviceTierFor } = await freshImport();
    assert.equal(serviceTierFor("agent-evals"), "flex");
    assert.equal(serviceTierFor("some-other-caller"), "flex");
    assert.equal(serviceTierFor(), "flex");
  }));

test("serviceTierFor: a per-caller override wins over the global default", async () =>
  withEnvVars({ ...CLEAR_TIER_ENV, OPENAI_SERVICE_TIER: "flex", OPENAI_SERVICE_TIER_AGENT_EVALS: "auto" }, async () => {
    const { serviceTierFor } = await freshImport();
    assert.equal(serviceTierFor("agent-evals"), "auto", "the per-caller var must win over the global one");
    assert.equal(serviceTierFor("some-other-caller"), "flex", "an unrelated caller still gets the global default");
  }));

test("serviceTierFor: a per-caller override works even with no global default set", async () =>
  withEnvVars({ ...CLEAR_TIER_ENV, OPENAI_SERVICE_TIER_AGENT_EVALS: "flex" }, async () => {
    const { serviceTierFor } = await freshImport();
    assert.equal(serviceTierFor("agent-evals"), "flex");
    assert.equal(serviceTierFor("some-other-caller"), undefined);
  }));

test("serviceTierFor trims and lowercases the resolved value", async () =>
  withEnvVars({ ...CLEAR_TIER_ENV, OPENAI_SERVICE_TIER: " FLEX  " }, async () => {
    const { serviceTierFor } = await freshImport();
    assert.equal(serviceTierFor("agent-evals"), "flex");
  }));

// ---- isFlexTier -------------------------------------------------------------------------------

test("isFlexTier is true only for the flex lane, case/whitespace-insensitive", async () => {
  const { isFlexTier } = await freshImport();
  assert.equal(isFlexTier("flex"), true);
  assert.equal(isFlexTier("Flex"), true);
  assert.equal(isFlexTier("  FLEX "), true);
  assert.equal(isFlexTier("auto"), false);
  assert.equal(isFlexTier(""), false);
  assert.equal(isFlexTier(undefined), false);
  assert.equal(isFlexTier(null), false);
});

// ---- chatBody's serviceTier option --------------------------------------------------------------

test("chatBody omits service_tier entirely when serviceTier is not passed (byte-identical to every pre-existing call site)", async () => {
  const { chatBody } = await freshImport();
  const body = chatBody("gpt-4.1", { messages: [{ role: "user", content: "hi" }] });
  assert.equal("service_tier" in body, false);
});

test("chatBody omits service_tier for a falsy value (undefined/empty string), never emits the literal 'undefined'", async () => {
  const { chatBody } = await freshImport();
  assert.equal("service_tier" in chatBody("gpt-4.1", { messages: [], serviceTier: undefined }), false);
  assert.equal("service_tier" in chatBody("gpt-4.1", { messages: [], serviceTier: "" }), false);
});

test("chatBody adds service_tier verbatim when passed, on both chat-family and reasoning-family deployments", async () => {
  const { chatBody } = await freshImport();
  const chatFamily = chatBody("gpt-4.1", { messages: [], serviceTier: "flex" });
  assert.equal(chatFamily.service_tier, "flex");
  assert.equal(chatFamily.max_tokens, 900); // unaffected by serviceTier
  const reasoningFamily = chatBody("gpt-5.6-terra", { messages: [], maxTokens: 50, serviceTier: "flex" });
  assert.equal(reasoningFamily.service_tier, "flex");
  assert.equal(reasoningFamily.max_completion_tokens, 50);
  assert.equal("temperature" in reasoningFamily, false, "serviceTier must not resurrect a temperature key on a reasoning-family body");
});

// ---- flexRetryPolicy ----------------------------------------------------------------------------

test("flexRetryPolicy is a pure passthrough for any non-flex tier -- byte-identical to the caller's own values", async () => {
  const { flexRetryPolicy } = await freshImport();
  for (const tier of [undefined, "", "auto", "standard"]) {
    assert.deepEqual(flexRetryPolicy(tier, { tries: 4 }), { tries: 4, timeoutMs: undefined });
    assert.deepEqual(flexRetryPolicy(tier, { tries: 4, timeoutMs: 12345 }), { tries: 4, timeoutMs: 12345 });
    assert.deepEqual(flexRetryPolicy(tier, {}), { tries: undefined, timeoutMs: undefined });
  }
});

test("flexRetryPolicy floors tries to OPENAI_FLEX_MIN_RETRIES under flex, but never lowers a higher caller value", async () =>
  withEnvVars(CLEAR_TIER_ENV, async () => {
    const { flexRetryPolicy, OPENAI_FLEX_MIN_RETRIES, OPENAI_FLEX_TIMEOUT_MS } = await freshImport();
    assert.equal(flexRetryPolicy("flex", { tries: 1 }).tries, OPENAI_FLEX_MIN_RETRIES);
    assert.equal(flexRetryPolicy("flex", { tries: 4 }).tries, OPENAI_FLEX_MIN_RETRIES, "4 < the floor -> raised");
    const higher = OPENAI_FLEX_MIN_RETRIES + 10;
    assert.equal(flexRetryPolicy("flex", { tries: higher }).tries, higher, "a caller value ABOVE the floor is never lowered");
    assert.equal(flexRetryPolicy("flex", {}).timeoutMs, OPENAI_FLEX_TIMEOUT_MS, "defaults the timeout when the caller does not supply one");
  }));

test("flexRetryPolicy respects an explicit timeoutMs override under flex instead of the default floor", async () =>
  withEnvVars(CLEAR_TIER_ENV, async () => {
    const { flexRetryPolicy } = await freshImport();
    assert.equal(flexRetryPolicy("flex", { timeoutMs: 42000 }).timeoutMs, 42000);
  }));

test("OPENAI_FLEX_TIMEOUT_MS / OPENAI_FLEX_MIN_RETRIES are env-overridable fleet-wide", async () =>
  withEnvVars({ ...CLEAR_TIER_ENV, OPENAI_FLEX_TIMEOUT_MS: "60000", OPENAI_FLEX_MIN_RETRIES: "9" }, async () => {
    const { OPENAI_FLEX_TIMEOUT_MS, OPENAI_FLEX_MIN_RETRIES, flexRetryPolicy } = await freshImport();
    assert.equal(OPENAI_FLEX_TIMEOUT_MS, 60000);
    assert.equal(OPENAI_FLEX_MIN_RETRIES, 9);
    assert.equal(flexRetryPolicy("flex", { tries: 1 }).tries, 9);
    assert.equal(flexRetryPolicy("flex", {}).timeoutMs, 60000);
  }));

// ---- fetchOpenAIWithFlexRetry -------------------------------------------------------------------

test("fetchOpenAIWithFlexRetry DEFAULT (no tier/caller, no env set): a single attempt, no service_tier, no AbortSignal -- byte-identical to a plain fetch", async () =>
  withEnvVars(CLEAR_TIER_ENV, async () => {
    const { fetchOpenAIWithFlexRetry } = await freshImport();
    let calls = 0, captured = null;
    const result = await withStubbedFetch(async (url, init) => {
      calls++; captured = { url: String(url), init };
      return { ok: true, status: 200, headers: new Map(), json: async () => ({ choices: [{ message: { content: "hello" } }] }) };
    }, () => fetchOpenAIWithFlexRetry({ apiKey: "sk-test", deployment: "gpt-4.1", messages: [{ role: "user", content: "hi" }] }));
    assert.equal(result, "hello");
    assert.equal(calls, 1);
    assert.equal(captured.url, "https://api.openai.com/v1/chat/completions");
    const body = JSON.parse(captured.init.body);
    assert.equal("service_tier" in body, false);
    assert.equal(captured.init.signal, undefined, "no AbortSignal must be attached for a non-flex call");
  }));

test("fetchOpenAIWithFlexRetry DEFAULT: a 429 with no flex tier throws IMMEDIATELY (no retry) with the exact pre-existing 'chat <status>: <body>' shape and no .throttled tag", async () =>
  withEnvVars(CLEAR_TIER_ENV, async () => {
    const { fetchOpenAIWithFlexRetry } = await freshImport();
    let calls = 0;
    await assert.rejects(
      () => withStubbedFetch(async () => { calls++; return { ok: false, status: 429, headers: new Map(), text: async () => "rate limited" }; },
        () => fetchOpenAIWithFlexRetry({ apiKey: "sk-test", deployment: "gpt-4.1", messages: [] })),
      (e) => { assert.match(e.message, /^chat 429: rate limited$/); assert.equal(e.throttled, undefined); return true; }
    );
    assert.equal(calls, 1, "must not retry a 429 when the tier is not flex (byte-identical to the pre-existing miner behavior)");
  }));

test("fetchOpenAIWithFlexRetry DEFAULT: a non-429 failure also throws immediately, any tier", async () =>
  withEnvVars(CLEAR_TIER_ENV, async () => {
    const { fetchOpenAIWithFlexRetry } = await freshImport();
    let calls = 0;
    await assert.rejects(
      () => withStubbedFetch(async () => { calls++; return { ok: false, status: 500, headers: new Map(), text: async () => "server error" }; },
        () => fetchOpenAIWithFlexRetry({ apiKey: "sk-test", deployment: "gpt-4.1", messages: [], tier: "flex" })),
      (e) => { assert.equal(e.message, "chat 500: server error"); return true; }
    );
    assert.equal(calls, 1, "a genuine non-429 failure must never be retried, even under flex -- fail loud, never masquerade as a completed judgement");
  }));

test("fetchOpenAIWithFlexRetry FLEX (explicit tier param): adds service_tier, attaches an AbortSignal, and retries 429 with backoff until it succeeds", async () =>
  withEnvVars(CLEAR_TIER_ENV, async () => {
    const { fetchOpenAIWithFlexRetry } = await freshImport();
    let calls = 0, lastBody = null, sawSignal = false;
    const result = await withStubbedFetch(async (url, init) => {
      calls++; lastBody = JSON.parse(init.body); sawSignal = init.signal instanceof AbortSignal;
      if (calls < 3) return { ok: false, status: 429, headers: new Map([["retry-after", "0.01"]]), text: async () => "no capacity" };
      return { ok: true, status: 200, headers: new Map(), json: async () => ({ choices: [{ message: { content: "flex answer" } }] }) };
    }, () => fetchOpenAIWithFlexRetry({ apiKey: "sk-test", deployment: "gpt-4.1", messages: [{ role: "user", content: "hi" }], tier: "flex" }));
    assert.equal(result, "flex answer");
    assert.equal(calls, 3, "must actually retry through the 429s before succeeding");
    assert.equal(lastBody.service_tier, "flex");
    assert.equal(sawSignal, true, "a flex attempt must carry an AbortSignal (the native-fetch equivalent of the SDK timeout override)");
  }));

test("fetchOpenAIWithFlexRetry FLEX via caller + per-caller env var (not just the explicit tier param)", async () =>
  withEnvVars({ ...CLEAR_TIER_ENV, OPENAI_SERVICE_TIER_TEST_CALLER: "flex" }, async () => {
    const { fetchOpenAIWithFlexRetry } = await freshImport();
    const result = await withStubbedFetch(async (url, init) => {
      assert.equal(JSON.parse(init.body).service_tier, "flex");
      return { ok: true, status: 200, headers: new Map(), json: async () => ({ choices: [{ message: { content: "ok" } }] }) };
    }, () => fetchOpenAIWithFlexRetry({ apiKey: "sk-test", deployment: "gpt-4.1", messages: [], caller: "test-caller" }));
    assert.equal(result, "ok");
  }));

test("fetchOpenAIWithFlexRetry FLEX exhaustion: throws .throttled=true after the floored retry count, never masquerading as a completed judgement", async () =>
  withEnvVars({ ...CLEAR_TIER_ENV, OPENAI_FLEX_MIN_RETRIES: "3" }, async () => {
    const { fetchOpenAIWithFlexRetry } = await freshImport();
    let calls = 0;
    await assert.rejects(
      () => withStubbedFetch(async () => { calls++; return { ok: false, status: 429, headers: new Map([["retry-after", "0.01"]]), text: async () => "no capacity" }; },
        () => fetchOpenAIWithFlexRetry({ apiKey: "sk-test", deployment: "gpt-4.1", messages: [], tier: "flex" })),
      (e) => { assert.match(e.message, /^chat 429:/); assert.equal(e.throttled, true); return true; }
    );
    assert.equal(calls, 3, "must exhaust the floored retry count, not just one attempt");
  }));

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

// ---- truncatedEmpty / positiveIntEnv (2026-08-30, FND-20260830-e927 sibling sweep) ------------------
// Shared helpers factored out of critic-pass/run.mjs's fix for the SAME failure shape
// (FND-20260830-e7c1) so every OTHER reasoning-budget sibling in the sweep (company-brain,
// signal-radar's two detectors, agent-evals/run-evals, the recall-evals miners, agent-evals/selfrepair)
// reuses one already-correct implementation instead of each re-deriving it.

test("truncatedEmpty: true only for finish_reason:length WITH empty/whitespace content, never for a normal stop or a genuinely empty-but-not-length case", async () => {
  const { truncatedEmpty } = await freshImport();
  assert.equal(truncatedEmpty({ finish_reason: "length", message: { content: "" } }), true);
  assert.equal(truncatedEmpty({ finish_reason: "length", message: { content: "   " } }), true, "whitespace-only content is still truncated-empty");
  assert.equal(truncatedEmpty({ finish_reason: "length", message: {} }), true, "a missing content field entirely is still truncated-empty");
  assert.equal(truncatedEmpty({ finish_reason: "stop", message: { content: "" } }), false, "an empty stop (not length) is a different, ungoverned condition");
  assert.equal(truncatedEmpty({ finish_reason: "length", message: { content: "real answer" } }), false, "non-empty content at finish_reason:length is a normal (if tight) completion, not this failure shape");
  assert.equal(truncatedEmpty(undefined), false, "must not throw on a missing/undefined choice");
  assert.equal(truncatedEmpty(null), false);
});

test("positiveIntEnv: floors BEFORE the positivity check, so a sub-1 fractional override never floors to a zero-token budget", async () => {
  const { positiveIntEnv } = await freshImport();
  const saved = process.env.PROBE_TEST_VAR;
  try {
    for (const bad of ["0", "-1", "0.7", "0.001", "Infinity", "-Infinity", "NaN", "not-a-number", ""]) {
      process.env.PROBE_TEST_VAR = bad;
      assert.equal(positiveIntEnv("PROBE_TEST_VAR", 3000), 3000, `override ${JSON.stringify(bad)} must fall back to the default, not reach a caller as a zero/negative/non-finite budget`);
    }
    delete process.env.PROBE_TEST_VAR;
    assert.equal(positiveIntEnv("PROBE_TEST_VAR", 3000), 3000, "an unset var falls back to the default");
    process.env.PROBE_TEST_VAR = "1500.7";
    assert.equal(positiveIntEnv("PROBE_TEST_VAR", 3000), 1500, "a valid fractional override is floored to a whole number, not passed through raw");
    process.env.PROBE_TEST_VAR = "42";
    assert.equal(positiveIntEnv("PROBE_TEST_VAR", 3000), 42, "a genuinely valid override is honored verbatim");
  } finally {
    if (saved === undefined) delete process.env.PROBE_TEST_VAR; else process.env.PROBE_TEST_VAR = saved;
  }
});

// ---- fetchOpenAIWithFlexRetry: reasoning-truncation (2026-08-30, FND-20260830-e927) ------------------
// This is the ONE shared network caller in this module (used by recall-evals/mine-hard-negatives.mjs
// and recall-evals/mine-cases.mjs); see its own doc comment for why the fix here is narrower than
// critic-pass's inline escalate-then-retry loop (no change to the tries/retry contract, only: never
// silently RETURN a truncated-empty response as if it were real content).

test("fetchOpenAIWithFlexRetry: a truncated-empty (finish_reason:length, empty content) response on the FINAL attempt throws .reasoningExhausted instead of returning ''", async () =>
  withEnvVars(CLEAR_TIER_ENV, async () => {
    const { fetchOpenAIWithFlexRetry } = await freshImport();
    let calls = 0;
    await assert.rejects(
      () => withStubbedFetch(async () => { calls++; return { ok: true, status: 200, headers: new Map(), json: async () => ({ choices: [{ message: { content: "", refusal: null }, finish_reason: "length" }], usage: { completion_tokens: 500, completion_tokens_details: { reasoning_tokens: 500 } } }) }; },
        () => fetchOpenAIWithFlexRetry({ apiKey: "sk-test", deployment: "gpt-5.6-terra", messages: [{ role: "user", content: "hi" }], maxTokens: 500 })),
      (e) => {
        assert.match(e.message, /reasoning model "gpt-5\.6-terra" exhausted its token budget \(500\)/);
        assert.equal(e.reasoningExhausted, true);
        return true;
      }
    );
    assert.equal(calls, 1, "default tries:1 means this is the FINAL (only) attempt -- the throw must fire immediately, not after a retry that never happens here");
  }));

test("fetchOpenAIWithFlexRetry: a truncated-empty response RETRIES while attempts remain and succeeds on a later one -- reasoning spend is non-deterministic, so the same budget often works on retry", async () =>
  withEnvVars(CLEAR_TIER_ENV, async () => {
    const { fetchOpenAIWithFlexRetry } = await freshImport();
    let calls = 0;
    const result = await withStubbedFetch(async () => {
      calls++;
      // First attempt burns the whole budget on hidden reasoning; the second returns real content at
      // the SAME budget. That is the observed real-world shape (339-1657 reasoning tokens across
      // repeat calls on identical input), and it is why throwing on the first occurrence is wrong.
      if (calls === 1) return { ok: true, status: 200, headers: new Map(), json: async () => ({ choices: [{ message: { content: "", refusal: null }, finish_reason: "length" }], usage: { completion_tokens: 500, completion_tokens_details: { reasoning_tokens: 500 } } }) };
      return { ok: true, status: 200, headers: new Map(), json: async () => ({ choices: [{ message: { content: "real verdict" }, finish_reason: "stop" }] }) };
    }, () => fetchOpenAIWithFlexRetry({ apiKey: "sk-test", deployment: "gpt-5.6-terra", messages: [{ role: "user", content: "hi" }], maxTokens: 500, tries: 3 }));
    assert.equal(result, "real verdict", "a later attempt's real answer must be returned, not discarded by a first-occurrence throw");
    assert.equal(calls, 2, "must retry after a truncated-empty while attempts remain, mirroring the 429 branch");
  }));

test("fetchOpenAIWithFlexRetry: truncated-empty on EVERY attempt still throws .reasoningExhausted once the allowance is spent", async () =>
  withEnvVars(CLEAR_TIER_ENV, async () => {
    const { fetchOpenAIWithFlexRetry } = await freshImport();
    let calls = 0;
    await assert.rejects(
      () => withStubbedFetch(async () => { calls++; return { ok: true, status: 200, headers: new Map(), json: async () => ({ choices: [{ message: { content: "", refusal: null }, finish_reason: "length" }], usage: { completion_tokens: 500, completion_tokens_details: { reasoning_tokens: 500 } } }) }; },
        () => fetchOpenAIWithFlexRetry({ apiKey: "sk-test", deployment: "gpt-5.6-terra", messages: [{ role: "user", content: "hi" }], maxTokens: 500, tries: 3 })),
      (e) => { assert.equal(e.reasoningExhausted, true); return true; }
    );
    assert.equal(calls, 3, "exhausting the allowance must consume every attempt before throwing");
  }));

test("fetchOpenAIWithFlexRetry: a normal (non-truncated) empty string is still returned as before -- the fix is scoped to finish_reason:length specifically", async () =>
  withEnvVars(CLEAR_TIER_ENV, async () => {
    const { fetchOpenAIWithFlexRetry } = await freshImport();
    const result = await withStubbedFetch(async () => ({ ok: true, status: 200, headers: new Map(), json: async () => ({ choices: [{ message: { content: "" }, finish_reason: "stop" }] }) }),
      () => fetchOpenAIWithFlexRetry({ apiKey: "sk-test", deployment: "gpt-4.1", messages: [] }));
    assert.equal(result, "", "an ordinary stop with empty content is not the reasoning-truncation shape and must not be reclassified as an error");
  }));

test("fetchOpenAIWithFlexRetry: a non-empty response at finish_reason:length is returned normally, not treated as truncated-empty", async () =>
  withEnvVars(CLEAR_TIER_ENV, async () => {
    const { fetchOpenAIWithFlexRetry } = await freshImport();
    const result = await withStubbedFetch(async () => ({ ok: true, status: 200, headers: new Map(), json: async () => ({ choices: [{ message: { content: "a real, if truncated, answer" }, finish_reason: "length" }] }) }),
      () => fetchOpenAIWithFlexRetry({ apiKey: "sk-test", deployment: "gpt-5.6-terra", messages: [] }));
    assert.equal(result, "a real, if truncated, answer");
  }));

test("fetchOpenAIWithFlexRetry: under flex, a truncated-empty 2xx RETRIES through the tries the flex policy granted and returns a later attempt's real answer", async () =>
  withEnvVars(CLEAR_TIER_ENV, async () => {
    const { fetchOpenAIWithFlexRetry } = await freshImport();
    let calls = 0;
    // This test previously asserted the OPPOSITE (throw on the first truncated-empty, calls === 1),
    // framed as a deliberate scope limit on the grounds that a caller wanting retry-on-truncation
    // should raise its own maxTokens or catch .reasoningExhausted itself. That reasoning does not
    // survive contact with flexRetryPolicy(): under flex it FLOORS tries to OPENAI_FLEX_MIN_RETRIES
    // (6), so the caller never asked for those attempts and has no way to know they exist -- the old
    // behavior silently discarded five granted attempts at exactly the moment retrying works, since
    // reasoning spend is non-deterministic on identical input. The old test's own assertion message
    // ("never reaching the later calls that would have recovered") named the harm it was pinning.
    // Changed deliberately, which is precisely what that counterfactual existed to force.
    const result = await withStubbedFetch(async () => {
      calls++;
      if (calls < 3) return { ok: true, status: 200, headers: new Map(), json: async () => ({ choices: [{ message: { content: "" }, finish_reason: "length" }] }) };
      return { ok: true, status: 200, headers: new Map(), json: async () => ({ choices: [{ message: { content: "recovered" }, finish_reason: "stop" }] }) };
    }, () => fetchOpenAIWithFlexRetry({ apiKey: "sk-test", deployment: "gpt-5.6-terra", messages: [], tier: "flex", tries: 5 }));
    assert.equal(result, "recovered", "the third attempt's real answer must be returned, not thrown away by a first-occurrence throw");
    assert.equal(calls, 3, "retries through truncated-empty responses while the flex-granted allowance remains");
  }));

// ============================================================================================
// BATCH API (2026-09-02) -- batchEnvVar / isBatchEnabled / buildBatchLine / submitBatch /
// awaitBatch / assertAllBatchResultsPresent. Every "default" assertion proves the same
// byte-identical-until-opted-in contract as the flex-processing suite above: with OPENAI_BATCH*
// unset (the state of every real job today), isBatchEnabled() is false and nothing else in this
// section runs unless a test calls it directly.
// ============================================================================================

const CLEAR_BATCH_ENV = {
  OPENAI_BATCH: undefined,
  OPENAI_BATCH_TEST_CALLER: undefined,
  OPENAI_BATCH_POLL_MS: undefined,
  OPENAI_BATCH_TIMEOUT_MS: undefined,
};

// ---- batchEnvVar / isBatchEnabled --------------------------------------------------------------

test("batchEnvVar slugifies a caller name into OPENAI_BATCH_<CALLER>, same convention as serviceTierEnvVar", async () => {
  const { batchEnvVar } = await freshImport();
  assert.equal(batchEnvVar("doc-indexer-enrich"), "OPENAI_BATCH_DOC_INDEXER_ENRICH");
  assert.equal(batchEnvVar(""), null);
  assert.equal(batchEnvVar(undefined), null);
});

test("isBatchEnabled: both unset (every job today) is false", async () =>
  withEnvVars(CLEAR_BATCH_ENV, async () => {
    const { isBatchEnabled } = await freshImport();
    assert.equal(isBatchEnabled("agent-evals"), false);
    assert.equal(isBatchEnabled(), false);
  }));

test("isBatchEnabled: OPENAI_BATCH=1 enables every caller with no per-caller override", async () =>
  withEnvVars({ ...CLEAR_BATCH_ENV, OPENAI_BATCH: "1" }, async () => {
    const { isBatchEnabled } = await freshImport();
    assert.equal(isBatchEnabled("agent-evals"), true);
    assert.equal(isBatchEnabled("anything-else"), true);
  }));

test("isBatchEnabled: a per-caller override wins even when it turns batch OFF while the fleet-wide flag is on", async () =>
  withEnvVars({ ...CLEAR_BATCH_ENV, OPENAI_BATCH: "1", OPENAI_BATCH_TEST_CALLER: "0" }, async () => {
    const { isBatchEnabled } = await freshImport();
    assert.equal(isBatchEnabled("test-caller"), false, "explicit per-caller '0' must override the global '1'");
    assert.equal(isBatchEnabled("other-caller"), true, "an unrelated caller still gets the fleet-wide default");
  }));

test("isBatchEnabled: a per-caller override wins even when it turns batch ON while the fleet-wide flag is unset", async () =>
  withEnvVars({ ...CLEAR_BATCH_ENV, OPENAI_BATCH_TEST_CALLER: "true" }, async () => {
    const { isBatchEnabled } = await freshImport();
    assert.equal(isBatchEnabled("test-caller"), true);
    assert.equal(isBatchEnabled("other-caller"), false);
  }));

// ---- buildBatchLine -----------------------------------------------------------------------------

test("buildBatchLine: builds a custom_id/method/url/body envelope via chatBody(), model set on the body", async () => {
  const { buildBatchLine } = await freshImport();
  const line = buildBatchLine({ customId: "task-1", deployment: "gpt-4.1", messages: [{ role: "user", content: "hi" }], maxTokens: 500 });
  assert.equal(line.custom_id, "task-1");
  assert.equal(line.method, "POST");
  assert.equal(line.url, "/v1/chat/completions");
  assert.equal(line.body.model, "gpt-4.1");
  assert.equal(line.body.max_tokens, 500);
  assert.deepEqual(line.body.messages, [{ role: "user", content: "hi" }]);
});

test("buildBatchLine: a reasoning-family deployment gets max_completion_tokens via chatBody, not max_tokens", async () => {
  const { buildBatchLine } = await freshImport();
  const line = buildBatchLine({ customId: "t", deployment: "gpt-5.6-terra", messages: [], maxTokens: 900, jsonMode: true });
  assert.equal(line.body.max_completion_tokens, 900);
  assert.equal("max_tokens" in line.body, false);
  assert.deepEqual(line.body.response_format, { type: "json_object" });
});

test("buildBatchLine: coerces a non-string customId and rejects an empty one", async () => {
  const { buildBatchLine } = await freshImport();
  assert.equal(buildBatchLine({ customId: 42, deployment: "gpt-4.1", messages: [] }).custom_id, "42");
  assert.throws(() => buildBatchLine({ customId: "", deployment: "gpt-4.1", messages: [] }), /customId is required/);
  assert.throws(() => buildBatchLine({ deployment: "gpt-4.1", messages: [] }), /customId is required/);
});

// ---- submitBatch: validation (no network reached) ------------------------------------------------

test("submitBatch: throws without ever calling fetch when apiKey is missing", async () => {
  const { submitBatch } = await freshImport();
  let called = false;
  await assert.rejects(
    () => withStubbedFetch(async () => { called = true; return { ok: true }; }, () => submitBatch([{ custom_id: "a", body: { model: "gpt-4.1" } }], {})),
    /missing apiKey/
  );
  assert.equal(called, false);
});

test("submitBatch: throws on an empty lines array", async () => {
  const { submitBatch } = await freshImport();
  await assert.rejects(() => submitBatch([], { apiKey: "sk-test" }), /no requests supplied/);
});

test("submitBatch: throws on a line with no custom_id", async () => {
  const { submitBatch } = await freshImport();
  await assert.rejects(() => submitBatch([{ body: { model: "gpt-4.1" } }], { apiKey: "sk-test" }), /non-empty custom_id/);
});

test("submitBatch: throws on a duplicate custom_id across lines", async () => {
  const { submitBatch } = await freshImport();
  const lines = [
    { custom_id: "dup", method: "POST", url: "/v1/chat/completions", body: { model: "gpt-4.1" } },
    { custom_id: "dup", method: "POST", url: "/v1/chat/completions", body: { model: "gpt-4.1" } },
  ];
  await assert.rejects(() => submitBatch(lines, { apiKey: "sk-test" }), /duplicate custom_id "dup"/);
});

test("submitBatch: throws when lines target more than one model (OpenAI's single-model-per-file rule)", async () => {
  const { submitBatch } = await freshImport();
  const lines = [
    { custom_id: "a", method: "POST", url: "/v1/chat/completions", body: { model: "gpt-4.1" } },
    { custom_id: "b", method: "POST", url: "/v1/chat/completions", body: { model: "gpt-5.6-terra" } },
  ];
  await assert.rejects(() => submitBatch(lines, { apiKey: "sk-test" }), /single model per file/);
});

// ---- submitBatch: happy path + upload/create failure handling -----------------------------------

function makeBatchLines(n = 2) {
  return Array.from({ length: n }, (_, i) => ({ custom_id: `req-${i}`, method: "POST", url: "/v1/chat/completions", body: { model: "gpt-4.1", messages: [{ role: "user", content: `hi ${i}` }] } }));
}

test("submitBatch: uploads a purpose=batch JSONL file, then creates a batch against that file id, and returns the batch id", async () => {
  const { submitBatch } = await freshImport();
  const calls = [];
  const result = await submitBatch(makeBatchLines(2), {
    apiKey: "sk-test",
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url) === "https://api.openai.com/v1/files") {
        assert.ok(init.body instanceof FormData, "the file upload must be a multipart FormData body");
        return { ok: true, status: 200, json: async () => ({ id: "file-abc123" }) };
      }
      if (String(url) === "https://api.openai.com/v1/batches") {
        const body = JSON.parse(init.body);
        assert.equal(body.input_file_id, "file-abc123");
        assert.equal(body.endpoint, "/v1/chat/completions");
        assert.equal(body.completion_window, "24h");
        return { ok: true, status: 200, json: async () => ({ id: "batch_abc123" }) };
      }
      throw new Error("unexpected url " + url);
    },
  });
  assert.equal(result, "batch_abc123");
  assert.equal(calls.length, 2);
});

test("submitBatch: a failed file upload throws with the response body surfaced, and never calls /v1/batches", async () => {
  const { submitBatch } = await freshImport();
  let batchCreateCalled = false;
  await assert.rejects(
    () => submitBatch(makeBatchLines(1), {
      apiKey: "sk-test",
      fetchImpl: async (url) => {
        if (String(url).includes("/v1/files")) return { ok: false, status: 500, text: async () => "upload broke" };
        batchCreateCalled = true;
        return { ok: true, status: 200, json: async () => ({ id: "batch_x" }) };
      },
    }),
    /file upload failed, HTTP 500: upload broke/
  );
  assert.equal(batchCreateCalled, false);
});

test("submitBatch: a failed batch-create call throws with the response body surfaced", async () => {
  const { submitBatch } = await freshImport();
  await assert.rejects(
    () => submitBatch(makeBatchLines(1), {
      apiKey: "sk-test",
      fetchImpl: async (url) => {
        if (String(url).includes("/v1/files")) return { ok: true, status: 200, json: async () => ({ id: "file-1" }) };
        return { ok: false, status: 400, text: async () => "bad request" };
      },
    }),
    /batch create failed, HTTP 400: bad request/
  );
});

// ---- awaitBatch ----------------------------------------------------------------------------------

function fakeBatchObject(overrides = {}) {
  return { id: "batch_abc123", status: "in_progress", output_file_id: null, error_file_id: null, errors: null, ...overrides };
}

test("awaitBatch: polls until status=completed, then downloads output_file_id and returns a custom_id-keyed Map", async () => {
  const { awaitBatch } = await freshImport();
  let getCalls = 0;
  const onPollLog = [];
  const { batch, results } = await awaitBatch("batch_abc123", {
    apiKey: "sk-test",
    pollIntervalMs: 1,
    sleepFn: () => Promise.resolve(),
    onPoll: (info) => onPollLog.push(info),
    fetchImpl: async (url) => {
      const u = String(url);
      if (u === "https://api.openai.com/v1/batches/batch_abc123") {
        getCalls++;
        return { ok: true, status: 200, json: async () => fakeBatchObject(getCalls < 3 ? { status: "in_progress" } : { status: "completed", output_file_id: "file-out-1" }) };
      }
      if (u === "https://api.openai.com/v1/files/file-out-1/content") {
        return {
          ok: true,
          status: 200,
          text: async () => [
            JSON.stringify({ custom_id: "req-0", response: { status_code: 200, body: { choices: [{ message: { content: "answer zero" } }] } }, error: null }),
            JSON.stringify({ custom_id: "req-1", response: { status_code: 200, body: { choices: [{ message: { content: "answer one" } }] } }, error: null }),
          ].join("\n"),
        };
      }
      throw new Error("unexpected url " + u);
    },
  });
  assert.equal(getCalls, 3, "must actually poll until the terminal status, not assume the first response is final");
  assert.equal(batch.status, "completed");
  assert.equal(results.get("req-0").content, "answer zero");
  assert.equal(results.get("req-0").error, null);
  assert.equal(results.get("req-1").content, "answer one");
  assert.equal(onPollLog.length, 3, "onPoll fires once per poll iteration, including the terminal one");
  assert.equal(onPollLog[2].status, "completed");
});

test("awaitBatch: the output line order need not match input order -- results are keyed by custom_id, never position", async () => {
  const { awaitBatch } = await freshImport();
  const { results } = await awaitBatch("b1", {
    apiKey: "sk-test",
    fetchImpl: async (url) => {
      const u = String(url);
      if (u.endsWith("/batches/b1")) return { ok: true, status: 200, json: async () => fakeBatchObject({ status: "completed", output_file_id: "f1" }) };
      if (u.endsWith("/files/f1/content")) {
        // req-1 listed BEFORE req-0 in the output file, deliberately out of input order
        return { ok: true, status: 200, text: async () => [
          JSON.stringify({ custom_id: "req-1", response: { body: { choices: [{ message: { content: "one" } }] } }, error: null }),
          JSON.stringify({ custom_id: "req-0", response: { body: { choices: [{ message: { content: "zero" } }] } }, error: null }),
        ].join("\n") };
      }
      throw new Error("unexpected url " + u);
    },
  });
  assert.equal(results.get("req-0").content, "zero");
  assert.equal(results.get("req-1").content, "one");
});

test("awaitBatch: a reasoning-truncated output line (finish_reason:length, empty content) is recorded as an error, not a real blank answer", async () => {
  const { awaitBatch } = await freshImport();
  const { results } = await awaitBatch("b1", {
    apiKey: "sk-test",
    fetchImpl: async (url) => {
      const u = String(url);
      if (u.endsWith("/batches/b1")) return { ok: true, status: 200, json: async () => fakeBatchObject({ status: "completed", output_file_id: "f1" }) };
      if (u.endsWith("/files/f1/content")) return { ok: true, status: 200, text: async () => JSON.stringify({ custom_id: "req-0", response: { body: { choices: [{ message: { content: "" }, finish_reason: "length" }] } }, error: null }) };
      throw new Error("unexpected url " + u);
    },
  });
  assert.equal(results.get("req-0").content, null);
  assert.match(results.get("req-0").error, /finish_reason=length/);
});

test("awaitBatch: a non-truncated, genuinely short/blank-looking completion (finish_reason:stop) is still returned as a real answer", async () => {
  const { awaitBatch } = await freshImport();
  const { results } = await awaitBatch("b1", {
    apiKey: "sk-test",
    fetchImpl: async (url) => {
      const u = String(url);
      if (u.endsWith("/batches/b1")) return { ok: true, status: 200, json: async () => fakeBatchObject({ status: "completed", output_file_id: "f1" }) };
      if (u.endsWith("/files/f1/content")) return { ok: true, status: 200, text: async () => JSON.stringify({ custom_id: "req-0", response: { body: { choices: [{ message: { content: "ok" }, finish_reason: "stop" }] } }, error: null }) };
      throw new Error("unexpected url " + u);
    },
  });
  assert.equal(results.get("req-0").content, "ok");
  assert.equal(results.get("req-0").error, null);
});

test("awaitBatch: a per-line error in the output file is recorded as {error, content:null}, not thrown", async () => {
  const { awaitBatch } = await freshImport();
  const { results } = await awaitBatch("b1", {
    apiKey: "sk-test",
    fetchImpl: async (url) => {
      const u = String(url);
      if (u.endsWith("/batches/b1")) return { ok: true, status: 200, json: async () => fakeBatchObject({ status: "completed", output_file_id: "f1" }) };
      if (u.endsWith("/files/f1/content")) return { ok: true, status: 200, text: async () => JSON.stringify({ custom_id: "req-0", response: null, error: { message: "content policy violation" } }) };
      throw new Error("unexpected url " + u);
    },
  });
  assert.equal(results.get("req-0").error, "content policy violation");
  assert.equal(results.get("req-0").content, null);
});

test("awaitBatch: entries present ONLY in error_file_id are still returned, and the output file wins on a conflicting custom_id", async () => {
  const { awaitBatch } = await freshImport();
  const { results } = await awaitBatch("b1", {
    apiKey: "sk-test",
    fetchImpl: async (url) => {
      const u = String(url);
      if (u.endsWith("/batches/b1")) return { ok: true, status: 200, json: async () => fakeBatchObject({ status: "completed", output_file_id: "f-out", error_file_id: "f-err" }) };
      if (u.endsWith("/files/f-out/content")) return { ok: true, status: 200, text: async () => JSON.stringify({ custom_id: "req-0", response: { body: { choices: [{ message: { content: "ok" } }] } }, error: null }) };
      if (u.endsWith("/files/f-err/content")) return { ok: true, status: 200, text: async () => [
        JSON.stringify({ custom_id: "req-1", error: { message: "request-level failure" } }),
        JSON.stringify({ custom_id: "req-0", error: { message: "should be ignored, output file already has req-0" } }),
      ].join("\n") };
      throw new Error("unexpected url " + u);
    },
  });
  assert.equal(results.get("req-0").content, "ok", "the output file is authoritative when a custom_id appears in both files");
  assert.equal(results.get("req-1").error, "request-level failure");
});

test("awaitBatch: throws on a terminal 'failed' status, tagging .batchStatus and .batch", async () => {
  const { awaitBatch } = await freshImport();
  await assert.rejects(
    () => awaitBatch("b1", { apiKey: "sk-test", fetchImpl: async () => ({ ok: true, status: 200, json: async () => fakeBatchObject({ status: "failed", errors: { data: [{ message: "quota exceeded" }] } }) }) }),
    (e) => { assert.match(e.message, /terminal status "failed"/); assert.match(e.message, /quota exceeded/); assert.equal(e.batchStatus, "failed"); assert.ok(e.batch); return true; }
  );
});

test("awaitBatch: throws on 'expired' and on 'cancelled', the other two documented terminal-failure statuses", async () => {
  const { awaitBatch } = await freshImport();
  for (const status of ["expired", "cancelled"]) {
    await assert.rejects(
      () => awaitBatch("b1", { apiKey: "sk-test", fetchImpl: async () => ({ ok: true, status: 200, json: async () => fakeBatchObject({ status }) }) }),
      new RegExp(`terminal status "${status}"`)
    );
  }
});

test("awaitBatch: 'cancelling' (in-flight, not yet terminal) is polled through rather than thrown on immediately", async () => {
  const { awaitBatch } = await freshImport();
  let calls = 0;
  const { batch } = await awaitBatch("b1", {
    apiKey: "sk-test", pollIntervalMs: 1, sleepFn: () => Promise.resolve(),
    fetchImpl: async () => { calls++; return { ok: true, status: 200, json: async () => fakeBatchObject(calls < 2 ? { status: "cancelling" } : { status: "cancelled" }) }; },
  }).catch((e) => ({ batch: e.batch, threw: true }));
  assert.equal(calls, 2, "cancelling must be polled again, not treated as terminal");
  assert.equal(batch.status, "cancelled");
});

test("awaitBatch: exceeding timeoutMs while still non-terminal throws, tagged .timedOut", async () => {
  const { awaitBatch } = await freshImport();
  await assert.rejects(
    () => awaitBatch("b1", {
      apiKey: "sk-test", timeoutMs: 5, pollIntervalMs: 1, sleepFn: () => new Promise((r) => setTimeout(r, 10)),
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => fakeBatchObject({ status: "in_progress" }) }),
    }),
    (e) => { assert.match(e.message, /timed out after 5ms/); assert.equal(e.timedOut, true); return true; }
  );
});

test("awaitBatch: a completed batch with NEITHER output_file_id nor error_file_id throws rather than returning an empty result set silently", async () => {
  const { awaitBatch } = await freshImport();
  await assert.rejects(
    () => awaitBatch("b1", { apiKey: "sk-test", fetchImpl: async () => ({ ok: true, status: 200, json: async () => fakeBatchObject({ status: "completed" }) }) }),
    /neither an output_file_id nor an error_file_id/
  );
});

test("awaitBatch: a non-ok GET /v1/batches/{id} response throws immediately", async () => {
  const { awaitBatch } = await freshImport();
  await assert.rejects(
    () => awaitBatch("b1", { apiKey: "sk-test", fetchImpl: async () => ({ ok: false, status: 401, text: async () => "unauthorized" }) }),
    /HTTP 401: unauthorized/
  );
});

test("awaitBatch: throws without calling fetch when apiKey or batchId is missing", async () => {
  const { awaitBatch } = await freshImport();
  let called = false;
  const fetchImpl = async () => { called = true; return { ok: true, status: 200, json: async () => fakeBatchObject() }; };
  await assert.rejects(() => awaitBatch("b1", { fetchImpl }), /missing apiKey/);
  await assert.rejects(() => awaitBatch("", { apiKey: "sk-test", fetchImpl }), /missing batchId/);
  assert.equal(called, false);
});

test("OPENAI_BATCH_POLL_MS / OPENAI_BATCH_TIMEOUT_MS are env-overridable fleet-wide, defaulting to 30s / 24h", async () =>
  withEnvVars(CLEAR_BATCH_ENV, async () => {
    const { OPENAI_BATCH_POLL_MS, OPENAI_BATCH_TIMEOUT_MS } = await freshImport();
    assert.equal(OPENAI_BATCH_POLL_MS, 30000);
    assert.equal(OPENAI_BATCH_TIMEOUT_MS, 24 * 60 * 60 * 1000);
  }));

test("OPENAI_BATCH_POLL_MS / OPENAI_BATCH_TIMEOUT_MS env overrides take effect", async () =>
  withEnvVars({ ...CLEAR_BATCH_ENV, OPENAI_BATCH_POLL_MS: "5000", OPENAI_BATCH_TIMEOUT_MS: "60000" }, async () => {
    const { OPENAI_BATCH_POLL_MS, OPENAI_BATCH_TIMEOUT_MS } = await freshImport();
    assert.equal(OPENAI_BATCH_POLL_MS, 5000);
    assert.equal(OPENAI_BATCH_TIMEOUT_MS, 60000);
  }));

// ---- assertAllBatchResultsPresent -----------------------------------------------------------------

test("assertAllBatchResultsPresent: passes when every custom_id has an entry, error or not", async () => {
  const { assertAllBatchResultsPresent } = await freshImport();
  const results = new Map([["a", { error: null, content: "x" }], ["b", { error: "boom", content: null }]]);
  assert.doesNotThrow(() => assertAllBatchResultsPresent(["a", "b"], results));
});

test("assertAllBatchResultsPresent: throws naming every custom_id missing from the results Map entirely", async () => {
  const { assertAllBatchResultsPresent } = await freshImport();
  const results = new Map([["a", { error: null, content: "x" }]]);
  assert.throws(() => assertAllBatchResultsPresent(["a", "b", "c"], results), /2 custom_id\(s\) got NO result at all.*b, c/s);
});
