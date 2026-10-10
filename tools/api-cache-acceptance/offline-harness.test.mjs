import assert from "node:assert/strict";
import { test } from "node:test";
import {
  OfflineExactResponseCache,
  assessExactResponseEligibility,
  buildExactCacheKey,
  buildPromptCacheShape,
  measureOpenAIPromptCacheUsage,
  runOfflineAcceptance,
} from "./harness.mjs";

const safePolicy = Object.freeze({
  dataClass: "synthetic",
  sourceClass: "immutable_synthetic_fixture",
  immutable: true,
  versioned: true,
  deterministic: true,
  authorizationVerified: true,
  mutableBrain: false,
  graphRagRelationshipAnswer: false,
  userSpecific: false,
  permissionDependent: false,
  write: false,
  phi: false,
  privilegedLegal: false,
  mnpi: false,
});

function keyParts() {
  return {
    tenantId: "fixture-tenant-a",
    seatId: "fixture-seat-cto",
    roleId: "fixture-role-reader",
    authorizationScope: "fixture-scope-read-only",
    authorizationVersion: "fixture-authz-v1",
    sourceVersions: [
      { sourceId: "fixture-source-alpha", sourceVersion: "fixture-source-v1" },
      { sourceId: "fixture-source-beta", sourceVersion: "fixture-source-v4" },
    ],
    query: "What does the synthetic fixture say?",
    model: "synthetic-openai-model",
    modelVersion: "synthetic-model-v1",
    promptVersion: "fixture-prompt-v1",
    toolSchemaVersion: "fixture-tool-schema-v1",
    responseConfig: { temperature: 0, maxCompletionTokens: 32 },
  };
}

function syntheticResult(response = { answer: "Synthetic answer alpha" }) {
  return { response, usage: { promptTokens: 180, completionTokens: 32 } };
}

test("provider prompt-cache shape puts a stable static prefix first and variable input last", () => {
  const system = "Synthetic stable prompt instructions. ".repeat(130);
  const first = buildPromptCacheShape({ model: "synthetic-openai-model", system, variable: "synthetic question one" });
  const second = buildPromptCacheShape({ model: "synthetic-openai-model", system, variable: "synthetic question two" });

  assert.equal(first.cacheable, true);
  assert.equal(second.cacheable, true);
  assert.equal(first.messages[0].role, "system");
  assert.equal(first.messages[0].content, second.messages[0].content);
  assert.equal(first.messages.at(-1).role, "user");
  assert.notEqual(first.messages.at(-1).content, second.messages.at(-1).content);
});

test("provider prompt-cache receipt counts cached input separately from avoided input and calls", () => {
  const measured = measureOpenAIPromptCacheUsage({
    prompt_tokens: 1500,
    completion_tokens: 28,
    prompt_tokens_details: { cached_tokens: 1200 },
  });

  assert.deepEqual(measured, {
    promptTokens: 1500,
    completionTokens: 28,
    cachedInputTokens: 1200,
    providerCallsAvoided: 0,
    inputTokensAvoided: 0,
    outputTokensAvoided: 0,
  });
  assert.equal(measureOpenAIPromptCacheUsage({
    prompt_tokens: 40,
    prompt_tokens_details: { cached_tokens: 90 },
  }).cachedInputTokens, 40);
});

test("exact-cache key canonicalizes object field order and requires every response dimension", () => {
  const base = keyParts();
  const reordered = { ...base, responseConfig: { maxCompletionTokens: 32, temperature: 0 } };
  assert.equal(buildExactCacheKey(base), buildExactCacheKey(reordered));

  const missingAuthorization = { ...base };
  delete missingAuthorization.authorizationVersion;
  assert.throws(() => buildExactCacheKey(missingAuthorization), /exactly the documented cache dimensions/);
  assert.throws(() => buildExactCacheKey({ ...base, extra: "unmodeled response dimension" }), /exactly the documented cache dimensions/);
  assert.throws(() => buildExactCacheKey({ ...base, sourceVersions: [] }), /at least one source id and version/);
  assert.throws(() => buildExactCacheKey({ ...base, responseConfig: { temperature: 0, Authorization: "synthetic-placeholder" } }), /credential-shaped field/);
});

test("tenant, seat, role, authorization, source-version, and exact-query changes isolate cache keys", () => {
  const base = keyParts();
  const variants = [
    ["tenant", (value) => ({ ...value, tenantId: "fixture-tenant-b" })],
    ["seat", (value) => ({ ...value, seatId: "fixture-seat-cfo" })],
    ["role", (value) => ({ ...value, roleId: "fixture-role-analyst" })],
    ["authorization scope", (value) => ({ ...value, authorizationScope: "fixture-scope-other" })],
    ["authorization version", (value) => ({ ...value, authorizationVersion: "fixture-authz-v2" })],
    ["source version", (value) => ({ ...value, sourceVersions: [{ ...value.sourceVersions[0], sourceVersion: "fixture-source-v2" }, value.sourceVersions[1]] })],
    ["query", (value) => ({ ...value, query: "what does the synthetic fixture say?" })],
  ];

  for (const [dimension, mutate] of variants) {
    assert.notEqual(buildExactCacheKey(base), buildExactCacheKey(mutate(base)), `${dimension} must partition the exact-response cache`);
  }
});

test("a changed tenant, seat, role, authorization, source version, or query runs fresh compute", async () => {
  const base = keyParts();
  const variants = [
    ["tenant", (value) => ({ ...value, tenantId: "fixture-tenant-b" })],
    ["seat", (value) => ({ ...value, seatId: "fixture-seat-cfo" })],
    ["role", (value) => ({ ...value, roleId: "fixture-role-analyst" })],
    ["authorization scope", (value) => ({ ...value, authorizationScope: "fixture-scope-other" })],
    ["authorization version", (value) => ({ ...value, authorizationVersion: "fixture-authz-v2" })],
    ["source version", (value) => ({ ...value, sourceVersions: [{ ...value.sourceVersions[0], sourceVersion: "fixture-source-v2" }, value.sourceVersions[1]] })],
    ["query", (value) => ({ ...value, query: "What does the synthetic fixture say today?" })],
  ];

  for (const [dimension, mutate] of variants) {
    const cache = new OfflineExactResponseCache({ enabled: true, ttlMs: 100, clock: () => 1 });
    let calls = 0;
    const compute = async () => syntheticResult({ answer: `synthetic response ${++calls}` });
    const first = await cache.getOrCompute({ keyParts: base, policy: safePolicy, compute });
    const changed = await cache.getOrCompute({ keyParts: mutate(base), policy: safePolicy, compute });
    assert.equal(first.outcome, "miss", `${dimension}: first request should miss`);
    assert.equal(changed.outcome, "miss", `${dimension}: changed dimension should miss`);
    assert.equal(calls, 2, `${dimension}: response must not cross the changed scope`);
  }
});

test("exact-response hit preserves synthetic golden answer and reports avoided call, tokens, and latency", async () => {
  let now = 0;
  let calls = 0;
  const events = [];
  const golden = {
    answer: "Synthetic answer alpha",
    citations: [{ sourceId: "fixture-source-alpha", sourceVersion: "fixture-source-v1" }],
  };
  const cache = new OfflineExactResponseCache({
    enabled: true,
    ttlMs: 100,
    clock: () => now,
    onEvent: (event) => events.push(event),
  });
  const compute = async () => {
    calls += 1;
    now += 42;
    return { response: golden, usage: { promptTokens: 180, completionTokens: 32 } };
  };

  const first = await cache.getOrCompute({ keyParts: keyParts(), policy: safePolicy, compute });
  first.response.answer = "caller changed its returned clone";
  const second = await cache.getOrCompute({ keyParts: keyParts(), policy: safePolicy, compute });

  assert.equal(first.outcome, "miss");
  assert.equal(second.outcome, "hit");
  assert.deepEqual(second.response, golden);
  assert.equal(calls, 1);
  assert.deepEqual(second.metrics, {
    latencyMs: 0,
    latencySavedMs: 42,
    providerCallsAvoided: 1,
    inputTokensAvoided: 180,
    outputTokensAvoided: 32,
  });
  assert.equal(events.at(-1).outcome, "hit");
});

test("entry expires at its TTL boundary and is recomputed", async () => {
  let now = 0;
  let calls = 0;
  const events = [];
  const cache = new OfflineExactResponseCache({ enabled: true, ttlMs: 10, clock: () => now, onEvent: (event) => events.push(event) });
  const compute = async () => {
    calls += 1;
    now += 1;
    return syntheticResult({ answer: `synthetic response ${calls}` });
  };

  await cache.getOrCompute({ keyParts: keyParts(), policy: safePolicy, compute });
  now = 11;
  const expired = await cache.getOrCompute({ keyParts: keyParts(), policy: safePolicy, compute });

  assert.equal(expired.outcome, "miss");
  assert.equal(expired.response.answer, "synthetic response 2");
  assert.equal(calls, 2);
  assert.equal(events.at(-1).reasonCode, "entry_expired");
});

test("source-version invalidation evicts entries that used the exact source version", async () => {
  const cache = new OfflineExactResponseCache({ enabled: true, ttlMs: 100, clock: () => 1 });
  let calls = 0;
  const compute = async () => syntheticResult({ answer: `synthetic response ${++calls}` });
  await cache.getOrCompute({ keyParts: keyParts(), policy: safePolicy, compute });
  assert.equal(cache.size, 1);
  assert.equal(cache.invalidateSourceVersion("fixture-source-alpha", "fixture-source-v1"), 1);
  assert.equal(cache.size, 0);
  assert.equal((await cache.getOrCompute({ keyParts: keyParts(), policy: safePolicy, compute })).outcome, "miss");
  assert.equal(calls, 2);
});

test("rollback disables the cache, clears entries, and makes the next request compute fresh", async () => {
  const cache = new OfflineExactResponseCache({ enabled: true, ttlMs: 100, clock: () => 1 });
  let calls = 0;
  const compute = async () => syntheticResult({ answer: `synthetic response ${++calls}` });
  await cache.getOrCompute({ keyParts: keyParts(), policy: safePolicy, compute });
  assert.equal(cache.size, 1);
  assert.equal(cache.disable(), 1);
  assert.equal(cache.size, 0);

  const afterRollback = await cache.getOrCompute({ keyParts: keyParts(), policy: safePolicy, compute });
  assert.equal(afterRollback.outcome, "bypass");
  assert.equal(afterRollback.reasonCode, "cache_disabled");
  assert.equal(afterRollback.response.answer, "synthetic response 2");
});

test("exact-response cache is disabled by default and never stores bypassed responses", async () => {
  const cache = new OfflineExactResponseCache({ clock: () => 1 });
  let calls = 0;
  const compute = async () => syntheticResult({ answer: `synthetic response ${++calls}` });
  const first = await cache.getOrCompute({ keyParts: keyParts(), policy: safePolicy, compute });
  const second = await cache.getOrCompute({ keyParts: keyParts(), policy: safePolicy, compute });

  assert.equal(first.outcome, "bypass");
  assert.equal(second.outcome, "bypass");
  assert.equal(cache.size, 0);
  assert.equal(calls, 2);
});

test("mutable Brain, GraphRAG, user or permission-specific, write, PHI, privileged legal, and MNPI outputs are denied", () => {
  const deniedFlags = [
    "mutableBrain",
    "graphRagRelationshipAnswer",
    "userSpecific",
    "permissionDependent",
    "write",
    "phi",
    "privilegedLegal",
    "mnpi",
  ];
  for (const flag of deniedFlags) {
    const decision = assessExactResponseEligibility({ ...safePolicy, [flag]: true });
    assert.equal(decision.eligible, false, `${flag} must be denied`);
  }
});

test("only immutable, versioned, deterministic, authorized synthetic fixtures pass eligibility", () => {
  assert.deepEqual(assessExactResponseEligibility(safePolicy), { eligible: true, reasonCode: "synthetic_fixture_allowed" });
  const missingExclusionFlag = { ...safePolicy };
  delete missingExclusionFlag.mnpi;
  assert.equal(assessExactResponseEligibility(missingExclusionFlag).reasonCode, "incomplete_or_unknown_policy");
  assert.equal(assessExactResponseEligibility({ ...safePolicy, unreviewedFlag: true }).eligible, false);
  assert.equal(assessExactResponseEligibility({ ...safePolicy, mnpi: "false" }).reasonCode, "unverified_exclusion_flag");
  assert.equal(assessExactResponseEligibility({ ...safePolicy, dataClass: "company" }).eligible, false);
  assert.equal(assessExactResponseEligibility({ ...safePolicy, sourceClass: "mutable_brain" }).eligible, false);
  assert.equal(assessExactResponseEligibility({ ...safePolicy, immutable: false }).eligible, false);
  assert.equal(assessExactResponseEligibility({ ...safePolicy, versioned: false }).eligible, false);
  assert.equal(assessExactResponseEligibility({ ...safePolicy, deterministic: false }).eligible, false);
  assert.equal(assessExactResponseEligibility({ ...safePolicy, authorizationVerified: false }).eligible, false);
});

test("denied policy bypasses before key construction and performs a fresh synthetic compute", async () => {
  const cache = new OfflineExactResponseCache({ enabled: true, ttlMs: 100, clock: () => 1 });
  let calls = 0;
  const result = await cache.getOrCompute({
    keyParts: {},
    policy: { ...safePolicy, mutableBrain: true },
    compute: async () => syntheticResult({ answer: `fresh synthetic answer ${++calls}` }),
  });
  assert.equal(result.outcome, "bypass");
  assert.equal(result.reasonCode, "mutable_brain_fact");
  assert.equal(result.response.answer, "fresh synthetic answer 1");
  assert.equal(cache.size, 0);
});

test("privacy-safe events omit identifiers, keys, queries, and response content", async () => {
  const markers = [
    "tenant-marker-4bb3",
    "seat-marker-5cc4",
    "role-marker-6dd5",
    "auth-marker-7ee6",
    "source-marker-8ff7",
    "query-marker-9aa8",
    "response-marker-0bb9",
  ];
  const parts = keyParts();
  parts.tenantId = markers[0];
  parts.seatId = markers[1];
  parts.roleId = markers[2];
  parts.authorizationScope = markers[3];
  parts.sourceVersions = [{ sourceId: markers[4], sourceVersion: "fixture-v1" }];
  parts.query = markers[5];
  const events = [];
  const cache = new OfflineExactResponseCache({ enabled: true, ttlMs: 100, clock: () => 1, onEvent: (event) => events.push(event) });
  const compute = async () => syntheticResult({ answer: markers[6] });
  await cache.getOrCompute({ keyParts: parts, policy: safePolicy, compute });
  await cache.getOrCompute({ keyParts: parts, policy: safePolicy, compute });

  const serialized = JSON.stringify(events);
  for (const marker of markers) assert.equal(serialized.includes(marker), false, `${marker} must not appear in telemetry`);
  for (const event of events) {
    assert.deepEqual(Object.keys(event).sort(), [
      "entriesAffected", "feature", "inputTokensAvoided", "latencyMs", "latencySavedMs",
      "outcome", "outputTokensAvoided", "providerCallsAvoided", "reasonCode", "schemaVersion",
    ].sort());
    assert.equal(Object.hasOwn(event, "cacheKey"), false);
  }
});

test("offline runner succeeds when fetch is replaced by a network-denying stub", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("network is disabled for this test"); };
  try {
    const result = await runOfflineAcceptance();
    assert.equal(result.mode, "offline_synthetic_only");
    assert.equal(result.networkCalls, 0);
    assert.equal(result.networkGuard.enforced, true);
    assert.deepEqual(result.networkGuard.blockedTransportProbes, []);
    assert.equal(result.providerPromptCache.providerCallsAvoided, 0);
    assert.equal(result.providerPromptCache.inputTokensAvoided, 0);
    assert.equal(result.exactResponseCache.providerCallsAvoided, 1);
    assert.equal(result.exactResponseCache.inputTokensAvoided, 180);
    assert.equal(result.exactResponseCache.syntheticAnswerParity, "pass");
    assert.equal(result.cloudflareAIGateway, "not_evaluated_no_verified_company_route_or_configuration");
    assert.equal(result.costEvidence, "not_measured_no_live_usage_or_rate_receipt");
    assert.equal(result.liveAnswerQuality, "not_measured");
    assert.equal(result.productionGate, "not_met");
    assert.equal(result.productionTrafficShift, false);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("public offline runner rejects outbound Node built-in transports before socket access", async () => {
  const result = await runOfflineAcceptance({ probeBuiltinTransports: true });
  const expectedProbes = [
    "fetch",
    "http.request", "http.get", "http.Agent.createConnection",
    "https.request", "https.get", "https.Agent.createConnection",
    "net.connect", "net.createConnection", "net.Socket.connect",
    "tls.connect", "http2.connect",
    "dgram.createSocket", "dgram.Socket.connect", "dgram.Socket.send",
    "dns.lookup", "dns.resolve4", "dns.promises.lookup",
    "dns.Resolver.resolve4", "dns.promises.Resolver.resolve4",
  ];
  if (typeof globalThis.WebSocket === "function") expectedProbes.push("WebSocket");

  assert.deepEqual(result.networkGuard, {
    enforced: true,
    blockedTransportProbes: expectedProbes,
    networkAccesses: 0,
  });
  assert.equal(result.networkCalls, 0);
  assert.equal(result.mode, "offline_synthetic_only");
});
