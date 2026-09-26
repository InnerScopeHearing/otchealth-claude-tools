import { createHash } from "node:crypto";
import { staticFirst } from "../../setup/prompt-shape.mjs";

export const EXACT_CACHE_KEY_SCHEMA = "offline-exact-response-v1";
export const DEFAULT_OFFLINE_TTL_MS = 60_000;
export const MAX_OFFLINE_TTL_MS = 24 * 60 * 60 * 1000;

const KEY_FIELDS = Object.freeze([
  "tenantId",
  "seatId",
  "roleId",
  "authorizationScope",
  "authorizationVersion",
  "sourceVersions",
  "query",
  "model",
  "modelVersion",
  "promptVersion",
  "toolSchemaVersion",
  "responseConfig",
]);

const REQUIRED_STRING_FIELDS = Object.freeze([
  "tenantId",
  "seatId",
  "roleId",
  "authorizationScope",
  "authorizationVersion",
  "query",
  "model",
  "modelVersion",
  "promptVersion",
  "toolSchemaVersion",
]);

const BLOCKED_POLICY_FLAGS = Object.freeze({
  mutableBrain: "mutable_brain_fact",
  graphRagRelationshipAnswer: "graphrag_relationship_answer",
  userSpecific: "user_specific_output",
  permissionDependent: "permission_dependent_output",
  write: "write_result",
  phi: "phi",
  privilegedLegal: "privileged_legal",
  mnpi: "mnpi",
});

const REQUIRED_POLICY_FIELDS = Object.freeze([
  "dataClass",
  "sourceClass",
  "immutable",
  "versioned",
  "deterministic",
  "authorizationVerified",
  ...Object.keys(BLOCKED_POLICY_FLAGS),
]);

const SAFE_EVENT_FIELDS = new Set([
  "schemaVersion",
  "feature",
  "outcome",
  "reasonCode",
  "latencyMs",
  "latencySavedMs",
  "providerCallsAvoided",
  "inputTokensAvoided",
  "outputTokensAvoided",
  "entriesAffected",
]);

function requireString(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalJson(value) {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("cache key values must be finite JSON numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!isPlainObject(value)) throw new TypeError("cache key values must be plain JSON data");
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function assertNoSecretLikeConfigKeys(value, path = "responseConfig") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSecretLikeConfigKeys(item, `${path}[${index}]`));
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (/(api[-_]?key|authorization|bearer|secret|(^|[_-])token($|[_-])|access.?token|refresh.?token|password|credential|header)/i.test(key)) {
      throw new TypeError(`${path} contains a credential-shaped field`);
    }
    assertNoSecretLikeConfigKeys(child, `${path}.${key}`);
  }
}

/**
 * Build an exact-response key for synthetic fixtures. All response-affecting identity,
 * authorization, source, prompt, tool, model, query, and generation dimensions are required.
 * The returned digest is for in-memory indexing only and must never be logged or persisted.
 */
export function buildExactCacheKey(keyParts) {
  if (!isPlainObject(keyParts)) throw new TypeError("keyParts must be a plain object");
  const received = Object.keys(keyParts).sort();
  const expected = [...KEY_FIELDS].sort();
  if (received.length !== expected.length || received.some((key, index) => key !== expected[index])) {
    throw new TypeError("keyParts must contain exactly the documented cache dimensions");
  }

  for (const field of REQUIRED_STRING_FIELDS) requireString(keyParts[field], field);

  if (!Array.isArray(keyParts.sourceVersions) || keyParts.sourceVersions.length === 0) {
    throw new TypeError("sourceVersions must contain at least one source id and version");
  }
  const sourceVersions = keyParts.sourceVersions.map((source, index) => {
    if (!isPlainObject(source)) throw new TypeError(`sourceVersions[${index}] must be a plain object`);
    const keys = Object.keys(source).sort();
    if (keys.length !== 2 || keys[0] !== "sourceId" || keys[1] !== "sourceVersion") {
      throw new TypeError(`sourceVersions[${index}] must contain only sourceId and sourceVersion`);
    }
    requireString(source.sourceId, `sourceVersions[${index}].sourceId`);
    requireString(source.sourceVersion, `sourceVersions[${index}].sourceVersion`);
    return { sourceId: source.sourceId, sourceVersion: source.sourceVersion };
  });

  if (!isPlainObject(keyParts.responseConfig)) {
    throw new TypeError("responseConfig must be a plain JSON object");
  }
  assertNoSecretLikeConfigKeys(keyParts.responseConfig);

  const dimensions = {
    schema: EXACT_CACHE_KEY_SCHEMA,
    tenantId: keyParts.tenantId,
    seatId: keyParts.seatId,
    roleId: keyParts.roleId,
    authorizationScope: keyParts.authorizationScope,
    authorizationVersion: keyParts.authorizationVersion,
    sourceVersions,
    query: keyParts.query,
    model: keyParts.model,
    modelVersion: keyParts.modelVersion,
    promptVersion: keyParts.promptVersion,
    toolSchemaVersion: keyParts.toolSchemaVersion,
    responseConfig: keyParts.responseConfig,
  };
  return `${EXACT_CACHE_KEY_SCHEMA}:${createHash("sha256").update(canonicalJson(dimensions)).digest("hex")}`;
}

/**
 * This offline harness intentionally admits synthetic immutable fixtures only. It is not a
 * production admission policy and must not be widened without a separate reviewed design.
 */
export function assessExactResponseEligibility(policy = {}) {
  if (!isPlainObject(policy)) return { eligible: false, reasonCode: "missing_policy" };
  const policyFields = Object.keys(policy).sort();
  const requiredFields = [...REQUIRED_POLICY_FIELDS].sort();
  if (policyFields.length !== requiredFields.length || policyFields.some((field, index) => field !== requiredFields[index])) {
    return { eligible: false, reasonCode: "incomplete_or_unknown_policy" };
  }
  for (const [flag, reasonCode] of Object.entries(BLOCKED_POLICY_FLAGS)) {
    if (typeof policy[flag] !== "boolean") return { eligible: false, reasonCode: "unverified_exclusion_flag" };
    if (policy[flag] === true) return { eligible: false, reasonCode };
  }
  if (policy.dataClass !== "synthetic") return { eligible: false, reasonCode: "non_synthetic_data" };
  if (policy.sourceClass !== "immutable_synthetic_fixture") {
    return { eligible: false, reasonCode: "source_not_immutable_fixture" };
  }
  if (policy.immutable !== true) return { eligible: false, reasonCode: "source_not_immutable" };
  if (policy.versioned !== true) return { eligible: false, reasonCode: "source_not_versioned" };
  if (policy.deterministic !== true) return { eligible: false, reasonCode: "output_not_deterministic" };
  if (policy.authorizationVerified !== true) return { eligible: false, reasonCode: "authorization_unverified" };
  return { eligible: true, reasonCode: "synthetic_fixture_allowed" };
}

function safeCount(value, name) {
  const number = value == null ? 0 : Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  return number;
}

function safeMillis(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new TypeError(`${name} must be a finite non-negative number`);
  return number;
}

function elapsed(start, end) {
  return Math.max(0, Math.round(safeMillis(end, "clock value") - safeMillis(start, "clock value")));
}

function cloneJson(value) {
  return JSON.parse(canonicalJson(value));
}

function normalizeExactUsage(usage = {}) {
  if (!isPlainObject(usage)) throw new TypeError("synthetic usage must be a plain object");
  return {
    promptTokens: safeCount(usage.promptTokens, "usage.promptTokens"),
    completionTokens: safeCount(usage.completionTokens, "usage.completionTokens"),
  };
}

function normalizeCacheMetrics({ latencyMs = 0, latencySavedMs = 0, providerCallsAvoided = 0, inputTokensAvoided = 0, outputTokensAvoided = 0 }) {
  return Object.freeze({
    latencyMs: safeCount(Math.round(Math.max(0, latencyMs)), "latencyMs"),
    latencySavedMs: safeCount(Math.round(Math.max(0, latencySavedMs)), "latencySavedMs"),
    providerCallsAvoided: safeCount(providerCallsAvoided, "providerCallsAvoided"),
    inputTokensAvoided: safeCount(inputTokensAvoided, "inputTokensAvoided"),
    outputTokensAvoided: safeCount(outputTokensAvoided, "outputTokensAvoided"),
  });
}

/**
 * Read the OpenAI Chat Completions usage fields already consumed by company-brain. Provider prompt
 * caching can discount cached input tokens, but it still sends the request and generates a fresh
 * response, so it avoids zero provider calls and zero input tokens.
 */
export function measureOpenAIPromptCacheUsage(usage = {}) {
  if (!isPlainObject(usage)) throw new TypeError("usage must be a plain object");
  const promptTokens = safeCount(usage.prompt_tokens, "usage.prompt_tokens");
  const completionTokens = safeCount(usage.completion_tokens, "usage.completion_tokens");
  const reportedCachedTokens = safeCount(usage.prompt_tokens_details?.cached_tokens, "usage.prompt_tokens_details.cached_tokens");
  return Object.freeze({
    promptTokens,
    completionTokens,
    cachedInputTokens: Math.min(promptTokens, reportedCachedTokens),
    providerCallsAvoided: 0,
    inputTokensAvoided: 0,
    outputTokensAvoided: 0,
  });
}

/** Build the existing static-first shape without making a provider call. */
export function buildPromptCacheShape({ model, system, rubric, examples, variable } = {}) {
  requireString(model, "model");
  const shaped = staticFirst({ system, rubric, examples, variable });
  return Object.freeze({
    model,
    messages: shaped.messages,
    prefixTokensEstimate: shaped.prefixTokensEstimate,
    cacheable: shaped.cacheable,
  });
}

/**
 * In-memory, disabled-by-default cache used only by this offline acceptance harness. The callback
 * passed to getOrCompute must return a synthetic response and synthetic usage counters.
 */
export class OfflineExactResponseCache {
  #entries = new Map();
  #enabled;
  #ttlMs;
  #clock;
  #onEvent;

  constructor({ enabled = false, ttlMs = DEFAULT_OFFLINE_TTL_MS, clock = () => performance.now(), onEvent = () => {} } = {}) {
    if (typeof enabled !== "boolean") throw new TypeError("enabled must be boolean");
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > MAX_OFFLINE_TTL_MS) {
      throw new TypeError("ttlMs must be a positive integer no greater than one day");
    }
    if (typeof clock !== "function") throw new TypeError("clock must be a function");
    if (typeof onEvent !== "function") throw new TypeError("onEvent must be a function");
    this.#enabled = enabled;
    this.#ttlMs = ttlMs;
    this.#clock = clock;
    this.#onEvent = onEvent;
  }

  get size() {
    return this.#entries.size;
  }

  enable() {
    this.#enabled = true;
  }

  disable() {
    const entriesAffected = this.#entries.size;
    this.#entries.clear();
    this.#enabled = false;
    this.#emit("disabled", "rollback", { entriesAffected });
    return entriesAffected;
  }

  invalidateSourceVersion(sourceId, sourceVersion) {
    requireString(sourceId, "sourceId");
    requireString(sourceVersion, "sourceVersion");
    let entriesAffected = 0;
    for (const [key, entry] of this.#entries) {
      if (entry.sourceVersions.some((source) => source.sourceId === sourceId && source.sourceVersion === sourceVersion)) {
        this.#entries.delete(key);
        entriesAffected += 1;
      }
    }
    this.#emit("invalidated", "source_version_changed", { entriesAffected });
    return entriesAffected;
  }

  async getOrCompute({ keyParts, policy, compute } = {}) {
    if (typeof compute !== "function") throw new TypeError("compute must be a function");

    if (!this.#enabled) return this.#computeBypass(compute, "cache_disabled");

    const eligibility = assessExactResponseEligibility(policy);
    if (!eligibility.eligible) return this.#computeBypass(compute, eligibility.reasonCode);

    let key;
    try {
      key = buildExactCacheKey(keyParts);
    } catch {
      return this.#computeBypass(compute, "invalid_key_dimensions");
    }

    const startedAt = safeMillis(this.#clock(), "clock value");
    const existing = this.#entries.get(key);
    let expired = false;
    if (existing) {
      if (existing.expiresAt > startedAt) {
        const response = cloneJson(existing.response);
        const latencyMs = elapsed(startedAt, this.#clock());
        const metrics = normalizeCacheMetrics({
          latencyMs,
          latencySavedMs: Math.max(0, existing.providerLatencyMs - latencyMs),
          providerCallsAvoided: 1,
          inputTokensAvoided: existing.usage.promptTokens,
          outputTokensAvoided: existing.usage.completionTokens,
        });
        this.#emit("hit", "exact_key_match", metrics);
        return { response, outcome: "hit", metrics };
      }
      this.#entries.delete(key);
      expired = true;
    }

    const computeStartedAt = safeMillis(this.#clock(), "clock value");
    const computed = await compute();
    const computeEndedAt = safeMillis(this.#clock(), "clock value");
    if (!isPlainObject(computed) || !Object.hasOwn(computed, "response")) {
      throw new TypeError("compute must return { response, usage }");
    }
    const response = cloneJson(computed.response);
    const usage = normalizeExactUsage(computed.usage);
    const providerLatencyMs = elapsed(computeStartedAt, computeEndedAt);

    if (this.#enabled) {
      const sourceVersions = keyParts.sourceVersions.map(({ sourceId, sourceVersion }) => ({ sourceId, sourceVersion }));
      this.#entries.set(key, {
        response,
        usage,
        providerLatencyMs,
        expiresAt: safeMillis(this.#clock(), "clock value") + this.#ttlMs,
        sourceVersions,
      });
    }

    const metrics = normalizeCacheMetrics({ latencyMs: providerLatencyMs });
    this.#emit("miss", expired ? "entry_expired" : "entry_missing", metrics);
    return { response: cloneJson(response), outcome: "miss", metrics };
  }

  async #computeBypass(compute, reasonCode) {
    const startedAt = safeMillis(this.#clock(), "clock value");
    const computed = await compute();
    const latencyMs = elapsed(startedAt, this.#clock());
    if (!isPlainObject(computed) || !Object.hasOwn(computed, "response")) {
      throw new TypeError("compute must return { response, usage }");
    }
    const response = cloneJson(computed.response);
    normalizeExactUsage(computed.usage);
    const metrics = normalizeCacheMetrics({ latencyMs });
    this.#emit("bypass", reasonCode, metrics);
    return { response, outcome: "bypass", reasonCode, metrics };
  }

  #emit(outcome, reasonCode, metrics = {}) {
    const details = {
      schemaVersion: 1,
      feature: "exact_response_cache",
      outcome,
      reasonCode,
      latencyMs: metrics.latencyMs ?? 0,
      latencySavedMs: metrics.latencySavedMs ?? 0,
      providerCallsAvoided: metrics.providerCallsAvoided ?? 0,
      inputTokensAvoided: metrics.inputTokensAvoided ?? 0,
      outputTokensAvoided: metrics.outputTokensAvoided ?? 0,
      entriesAffected: metrics.entriesAffected ?? 0,
    };
    const safeEvent = Object.fromEntries(Object.entries(details).filter(([key]) => SAFE_EVENT_FIELDS.has(key)));
    try {
      this.#onEvent(Object.freeze(safeEvent));
    } catch {
      // Telemetry must not change the cache result or affect the synthetic provider callback.
    }
  }
}

const SYNTHETIC_POLICY = Object.freeze({
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

const SYNTHETIC_KEY_PARTS = Object.freeze({
  tenantId: "fixture-tenant-a",
  seatId: "fixture-seat-reader",
  roleId: "fixture-role-reader",
  authorizationScope: "fixture-scope-read-only",
  authorizationVersion: "fixture-authz-v1",
  sourceVersions: Object.freeze([{ sourceId: "fixture-source-alpha", sourceVersion: "fixture-source-v1" }]),
  query: "What does the synthetic fixture say?",
  model: "synthetic-openai-model",
  modelVersion: "synthetic-model-v1",
  promptVersion: "fixture-prompt-v1",
  toolSchemaVersion: "fixture-tool-schema-v1",
  responseConfig: Object.freeze({ temperature: 0, maxCompletionTokens: 32 }),
});

/** Execute a deterministic two-request demonstration. It makes no network or provider calls. */
export async function runOfflineAcceptance() {
  const system = "Synthetic stable instructions for provider prompt-cache shaping. ".repeat(100);
  const firstPrompt = buildPromptCacheShape({ model: "synthetic-openai-model", system, variable: "synthetic question one" });
  const secondPrompt = buildPromptCacheShape({ model: "synthetic-openai-model", system, variable: "synthetic question two" });
  const sameStablePrefix = firstPrompt.messages[0]?.content === secondPrompt.messages[0]?.content;
  const distinctVariables = firstPrompt.messages.at(-1)?.content !== secondPrompt.messages.at(-1)?.content;
  if (!sameStablePrefix || !distinctVariables || !firstPrompt.cacheable || !secondPrompt.cacheable) {
    throw new Error("synthetic prompt-cache request shape failed");
  }

  const promptUsage = measureOpenAIPromptCacheUsage({
    prompt_tokens: 1500,
    completion_tokens: 28,
    prompt_tokens_details: { cached_tokens: 1200 },
  });

  let now = 0;
  let providerCalls = 0;
  const events = [];
  const cache = new OfflineExactResponseCache({
    enabled: true,
    ttlMs: 500,
    clock: () => now,
    onEvent: (event) => events.push(event),
  });
  const golden = { answer: "Synthetic answer alpha", citations: [{ sourceId: "fixture-source-alpha", sourceVersion: "fixture-source-v1" }] };
  const compute = async () => {
    providerCalls += 1;
    now += 42;
    return { response: golden, usage: { promptTokens: 180, completionTokens: 32 } };
  };
  const first = await cache.getOrCompute({ keyParts: SYNTHETIC_KEY_PARTS, policy: SYNTHETIC_POLICY, compute });
  const second = await cache.getOrCompute({ keyParts: SYNTHETIC_KEY_PARTS, policy: SYNTHETIC_POLICY, compute });
  if (JSON.stringify(first.response) !== JSON.stringify(golden) || JSON.stringify(second.response) !== JSON.stringify(golden)) {
    throw new Error("synthetic exact-response parity failed");
  }

  return Object.freeze({
    mode: "offline_synthetic_only",
    networkCalls: 0,
    providerPromptCache: Object.freeze({
      stablePrefix: sameStablePrefix,
      distinctVariables,
      cacheablePrefix: firstPrompt.cacheable,
      cachedInputTokens: promptUsage.cachedInputTokens,
      providerCallsAvoided: promptUsage.providerCallsAvoided,
      inputTokensAvoided: promptUsage.inputTokensAvoided,
      freshOutputExpected: true,
    }),
    exactResponseCache: Object.freeze({
      firstRequest: first.outcome,
      secondRequest: second.outcome,
      providerCalls: providerCalls,
      providerCallsAvoided: second.metrics.providerCallsAvoided,
      inputTokensAvoided: second.metrics.inputTokensAvoided,
      outputTokensAvoided: second.metrics.outputTokensAvoided,
      missLatencyMs: first.metrics.latencyMs,
      hitLatencyMs: second.metrics.latencyMs,
      latencySavedMs: second.metrics.latencySavedMs,
      syntheticAnswerParity: "pass",
      contentFreeEvents: events.length === 2 && events.every((event) => Object.keys(event).every((key) => SAFE_EVENT_FIELDS.has(key))),
    }),
    cloudflareAIGateway: "not_evaluated_no_verified_company_route_or_configuration",
    costEvidence: "not_measured_no_live_usage_or_rate_receipt",
    liveAnswerQuality: "not_measured",
    productionGate: "not_met",
    productionTrafficShift: false,
  });
}
