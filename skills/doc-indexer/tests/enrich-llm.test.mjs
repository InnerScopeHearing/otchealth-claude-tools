// Tests for skills/doc-indexer/enrich-llm.mjs (2026-08-29, the enrich.mjs Bedrock provider lane)
// plus integration-level proof of enrich.mjs's own `_callFailed` contract under that provider.
//
// THREE layers, matching this repo's own established convention for a hard-to-mock CLI script (see
// tests/push-search-opensearch.test.mjs's header, and tests/storage-backend-default.test.mjs's):
//   1. PURE FUNCTION tests on enrich-llm.mjs's exports -- fast, hermetic, no subprocess, no network.
//      enrich-llm.mjs has NO argv parsing and NO top-level side effects (unlike enrich.mjs itself),
//      so it is safe to import directly in this same process.
//   2. Subprocess tests on enrich.mjs's CLI-level provider VALIDATION (no network reached, deterministic
//      before any credential/storage resolution) -- mirrors storage-backend-default.test.mjs.
//   3. A full subprocess integration test using the `--import` global-fetch-stub technique
//      tests/push-search-opensearch.test.mjs already proved out for this exact directory, extended
//      here to stub the Bedrock Converse endpoint alongside the S3 storage layer. This is the layer
//      that actually proves enrich.mjs's `_callFailed` contract end to end: a transport failure from
//      Bedrock must withhold the enriched marker and, when every call in the run fails, exit non-zero
//      -- the exact "a thrown LLM call must never mark a row enriched" rule this file's own header
//      calls the repo's most-taught lesson (PR #462).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  VALID_PROVIDERS, DEFAULT_PROVIDER, BEDROCK_DEFAULT_MODEL,
  defaultModelFor, ratesFor, estCostFor, extractJsonObject,
  BEDROCK_TOOL_NAME, BEDROCK_TOOL_SCHEMA, callBedrockChat,
  buildConverseBatchLine, parseBedrockBatchModelOutput,
  BEDROCK_BATCH_DISCOUNT_DEFAULT, bedrockBatchDiscount, estBedrockBatchCostFor,
} from "../enrich-llm.mjs";

const execFileP = promisify(execFile);
const HERE = fileURLToPath(new URL(".", import.meta.url));
const ENRICH_MJS = join(HERE, "..", "enrich.mjs");

// =========================================================================================
// Layer 1: pure function tests (no subprocess, no network)
// =========================================================================================

test("VALID_PROVIDERS / DEFAULT_PROVIDER: openai|azure|bedrock, default unchanged at openai", () => {
  assert.deepEqual(VALID_PROVIDERS, ["openai", "azure", "bedrock"]);
  assert.equal(DEFAULT_PROVIDER, "openai");
});

test("BEDROCK_DEFAULT_MODEL: the exact Claude Haiku 4.5 inference profile, live-verified", () => {
  assert.equal(BEDROCK_DEFAULT_MODEL, "us.anthropic.claude-haiku-4-5-20251001-v1:0");
});

test("defaultModelFor: openai/azure defaults are UNCHANGED from before this file existed", () => {
  assert.equal(defaultModelFor("openai"), "gpt-4o-mini");
  assert.equal(defaultModelFor("azure"), "gpt-4.1-mini");
});

test("defaultModelFor: bedrock defaults to BEDROCK_DEFAULT_MODEL when no env override is given", () => {
  assert.equal(defaultModelFor("bedrock", undefined), BEDROCK_DEFAULT_MODEL);
  assert.equal(defaultModelFor("bedrock", ""), BEDROCK_DEFAULT_MODEL);
});

test("defaultModelFor: an ENRICH_BEDROCK_MODEL-shaped override wins over the hardcoded default", () => {
  assert.equal(defaultModelFor("bedrock", "us.anthropic.claude-sonnet-4-5-20250929-v1:0"), "us.anthropic.claude-sonnet-4-5-20250929-v1:0");
});

test("ratesFor / estCostFor: openai/azure rates are UNCHANGED from enrich.mjs's pre-Bedrock estCost()", () => {
  assert.deepEqual(ratesFor("openai", {}), [0.15, 0.60]);
  assert.deepEqual(ratesFor("azure", {}), [0.4, 1.6]);
  assert.equal(estCostFor("openai", 1_000_000, 1_000_000, {}), 0.15 + 0.60);
});

test("ratesFor: bedrock defaults match deep-pass.mjs's own RATES entry for the same model (1.00 / 5.00), so the two ports never quietly disagree", () => {
  assert.deepEqual(ratesFor("bedrock", {}), [1.00, 5.00]);
});

test("ratesFor: every provider's rate pair is env-overridable, independently of the others", () => {
  const env = { ENRICH_BEDROCK_RATE_IN: "2.5", ENRICH_BEDROCK_RATE_OUT: "12", ENRICH_OPENAI_RATE_IN: "0.01" };
  assert.deepEqual(ratesFor("bedrock", env), [2.5, 12]);
  assert.deepEqual(ratesFor("openai", env), [0.01, 0.60], "overriding bedrock's rate must not affect openai's");
  assert.deepEqual(ratesFor("azure", env), [0.4, 1.6], "overriding bedrock's/openai's rate must not affect azure's");
});

test("estCostFor: zero tokens costs exactly $0 regardless of provider", () => {
  for (const p of VALID_PROVIDERS) assert.equal(estCostFor(p, 0, 0, {}), 0);
});

test("extractJsonObject: plain JSON parses directly", () => {
  assert.deepEqual(extractJsonObject('{"doc_title":"x","keywords":["a","b"]}'), { doc_title: "x", keywords: ["a", "b"] });
});

test("extractJsonObject: a markdown-fenced ```json block salvages to the enclosed object", () => {
  const text = "```json\n{\"doc_title\":\"fenced\",\"confidence\":\"high\"}\n```";
  assert.deepEqual(extractJsonObject(text), { doc_title: "fenced", confidence: "high" });
});

test("extractJsonObject: a prose-prefixed response (\"Here is the JSON:\") salvages to the enclosed object", () => {
  const text = "Here is the JSON you requested:\n{\"doc_title\":\"prefixed\"}\nLet me know if you need anything else.";
  assert.deepEqual(extractJsonObject(text), { doc_title: "prefixed" });
});

test("extractJsonObject: genuinely malformed JSON (unbalanced braces, truncated mid-value) returns null, never throws", () => {
  assert.equal(extractJsonObject('{"doc_title": "truncated mid-str'), null);
  assert.equal(extractJsonObject("not json at all, no braces here"), null);
  assert.equal(extractJsonObject(""), null);
  assert.equal(extractJsonObject(null), null);
  assert.equal(extractJsonObject(undefined), null);
});

test("extractJsonObject: slicing first-'{' to last-'}' across TWO separate top-level objects produces invalid JSON and returns null (a known shape of this salvage strategy, not a claim of multi-object robustness)", () => {
  // The salvage pass slices from the FIRST "{" to the LAST "}" in the whole string. With two
  // separate objects and prose between them, that slice is '{"a":1} more prose {"b":2}' -- not
  // valid JSON (two top-level values, not one) -- so this correctly returns null rather than
  // silently merging or picking one. Documented here so a future change to the extraction strategy
  // is a deliberate decision, not a surprise.
  const text = 'prose {"a":1} more prose {"b":2} trailing';
  assert.equal(extractJsonObject(text), null);
});

test("BEDROCK_TOOL_NAME / BEDROCK_TOOL_SCHEMA: a stable tool name and a loosely-typed, additionalProperties:true object schema (no per-domain field duplication)", () => {
  assert.equal(BEDROCK_TOOL_NAME, "emit_metadata");
  assert.equal(BEDROCK_TOOL_SCHEMA.type, "object");
  assert.equal(BEDROCK_TOOL_SCHEMA.additionalProperties, true);
  assert.equal(BEDROCK_TOOL_SCHEMA.properties, undefined, "deliberately no declared properties -- see this file's own doc comment on why duplicating enrich.mjs's per-domain schema here would be a drift risk");
});

test("callBedrockChat: success path (mocked converse) returns { text, usage } with obj re-serialized to a JSON string enrich.mjs's J()/extractJsonObject can parse back", async () => {
  let seenArgs = null;
  const fakeConverse = async (args) => {
    seenArgs = args;
    return { obj: { doc_title: "Test Doc", keywords: ["a", "b"], confidence: "high" }, usage: { prompt_tokens: 500, completion_tokens: 40 }, stopReason: "tool_use" };
  };
  const res = await callBedrockChat({
    modelId: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    region: "us-east-1",
    system: "the system prompt",
    user: "the user context, document text last",
    maxTokens: 1200,
    converse: fakeConverse,
  });
  assert.deepEqual(res.usage, { prompt_tokens: 500, completion_tokens: 40 });
  assert.deepEqual(extractJsonObject(res.text), { doc_title: "Test Doc", keywords: ["a", "b"], confidence: "high" }, "the text must round-trip back to the exact object converse() returned");
  // The call shape enrich.mjs's chatJson() relies on: forced tool-use, system/user preserved verbatim.
  assert.equal(seenArgs.modelId, "us.anthropic.claude-haiku-4-5-20251001-v1:0");
  assert.equal(seenArgs.region, "us-east-1");
  assert.equal(seenArgs.system, "the system prompt");
  assert.deepEqual(seenArgs.userContent, [{ text: "the user context, document text last" }], "document text must arrive as the LAST thing in the single user content block -- see enrich.mjs's own header on prompt-prefix ordering");
  assert.equal(seenArgs.toolName, BEDROCK_TOOL_NAME);
  assert.deepEqual(seenArgs.toolSchema, BEDROCK_TOOL_SCHEMA);
  assert.equal(seenArgs.maxTokens, 1200);
});

test("callBedrockChat: a CONTENT failure (converse resolves obj:null -- forced-tool refusal or max_tokens truncation) maps to text:'' , NOT a throw", async () => {
  const fakeConverse = async () => ({ obj: null, usage: { prompt_tokens: 300, completion_tokens: 16 }, stopReason: "max_tokens" });
  const res = await callBedrockChat({ modelId: "m", region: "us-east-1", system: "s", user: "u", converse: fakeConverse });
  assert.equal(res.text, "");
  assert.deepEqual(res.usage, { prompt_tokens: 300, completion_tokens: 16 }, "usage must still be reported even on a content failure -- tokens were spent either way");
  // The load-bearing downstream property: extractJsonObject("") -> null -> enrich.mjs's callEnrichLLM
  // treats this exactly like the OpenAI/Azure lanes' own "model answered with non-JSON text" case
  // (_parseFailed), NOT like a transport failure.
  assert.equal(extractJsonObject(res.text), null);
});

test("callBedrockChat: a THROW from converse (network/auth/non-retryable-status/retries-exhausted) propagates UNCHANGED -- it is NOT caught or converted to a quiet empty result", async () => {
  const fakeConverse = async () => { throw new Error("bedrock converse 403: access denied"); };
  await assert.rejects(
    () => callBedrockChat({ modelId: "m", region: "us-east-1", system: "s", user: "u", converse: fakeConverse }),
    /bedrock converse 403: access denied/,
    "swallowing this throw here would reintroduce the exact silent-poisoning bug class enrich.mjs's PR #462 already fixed once for openai/azure",
  );
});

test("callBedrockChat: missing usage fields on the converse result default to 0, never NaN/undefined leaking into the accumulator", async () => {
  const fakeConverse = async () => ({ obj: {}, usage: {}, stopReason: "tool_use" });
  const res = await callBedrockChat({ modelId: "m", region: "us-east-1", system: "s", user: "u", converse: fakeConverse });
  assert.deepEqual(res.usage, { prompt_tokens: 0, completion_tokens: 0 });
});

test("callBedrockChat: defaults `converse` to the real bedrock-client.mjs converseJson when not overridden (production never passes it explicitly)", async () => {
  // Proves the parameter is genuinely optional (no "converse is not a function") by exercising the
  // REAL converseJson's fail-closed credential check, which throws IMMEDIATELY, before any fetch --
  // NOT by relying on a network timeout, which converseJson's retry loop treats as a RETRYABLE
  // condition and would burn through the real ~2s/4s/8s/16s/32s backoff schedule (this failure mode
  // was caught live: an earlier version of this test used timeoutMs:1 and took ~65 real seconds).
  // Env is saved/restored so this does not affect any other test sharing this process.
  const ENV_KEYS = ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "OTC_AWS_ACCESS_KEY_ID", "OTC_AWS_SECRET_ACCESS_KEY", "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", "AWS_CONTAINER_CREDENTIALS_FULL_URI"];
  const saved = {};
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  try {
    await assert.rejects(
      () => callBedrockChat({ modelId: "not-a-real-model", region: "us-east-1", system: "s", user: "u" }),
      /AWS credentials unavailable/,
    );
  } finally {
    for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
});

// =========================================================================================
// Bedrock BATCH adapter (2026-09-03): buildConverseBatchLine / parseBedrockBatchModelOutput /
// the batch cost model. Pure functions, no network -- proves the "no forced tool-use, plain-text
// JSON prompt, Converse-format record shape" contract this file's own header documents against
// the live AWS batch-inference documentation cited there.
// =========================================================================================

test("buildConverseBatchLine: {recordId, modelInput} shape matches AWS's documented Converse batch input record exactly -- system/messages/inferenceConfig, NO toolConfig, NO modelId", () => {
  const line = buildConverseBatchLine({ recordId: "shopify-library/00-index.md", system: "the system prompt", user: "the document text", maxTokens: 1200, temperature: 0 });
  assert.deepEqual(line, {
    recordId: "shopify-library/00-index.md",
    modelInput: {
      system: [{ text: "the system prompt" }],
      messages: [{ role: "user", content: [{ text: "the document text" }] }],
      inferenceConfig: { maxTokens: 1200, temperature: 0 },
    },
  });
  assert.equal(line.modelInput.toolConfig, undefined, "batch inference does not support tool calling -- a toolConfig here would be silently ignored at best, so it must never be built");
  assert.equal(line.modelInput.modelId, undefined, "modelId is a JOB-LEVEL field on CreateModelInvocationJob, never per-record");
});

test("buildConverseBatchLine: recordId is coerced to a string (a catalog path with '/' is a plain JSON string value here, never part of a URL/path)", () => {
  const line = buildConverseBatchLine({ recordId: 12345, system: "s", user: "u" });
  assert.equal(line.recordId, "12345");
  assert.equal(typeof line.recordId, "string");
  const withSlashes = buildConverseBatchLine({ recordId: "a/b/c d.md", system: "s", user: "u" });
  assert.equal(withSlashes.recordId, "a/b/c d.md");
});

test("buildConverseBatchLine: requires a non-empty recordId", () => {
  assert.throws(() => buildConverseBatchLine({ system: "s", user: "u" }), /recordId is required/);
  assert.throws(() => buildConverseBatchLine({ recordId: "", system: "s", user: "u" }), /recordId is required/);
});

test("buildConverseBatchLine: defaults maxTokens 1200 / temperature 0, matching every other lane's deterministic-extraction posture", () => {
  const line = buildConverseBatchLine({ recordId: "x", system: "s", user: "u" });
  assert.deepEqual(line.modelInput.inferenceConfig, { maxTokens: 1200, temperature: 0 });
});

test("buildConverseBatchLine: missing system/user default to empty strings, never throw / never leak 'undefined' into the wire body", () => {
  const line = buildConverseBatchLine({ recordId: "x" });
  assert.deepEqual(line.modelInput.system, [{ text: "" }]);
  assert.deepEqual(line.modelInput.messages, [{ role: "user", content: [{ text: "" }] }]);
});

test("parseBedrockBatchModelOutput: extracts the plain TEXT content block (never a toolUse block -- batch responses never contain one) and Converse usage field names", () => {
  const modelOutput = { output: { message: { role: "assistant", content: [{ text: '{"doc_title":"Batch Fixture","confidence":"high"}' }] } }, stopReason: "end_turn", usage: { inputTokens: 900, outputTokens: 45 } };
  const res = parseBedrockBatchModelOutput(modelOutput);
  assert.equal(res.text, '{"doc_title":"Batch Fixture","confidence":"high"}');
  assert.deepEqual(res.usage, { prompt_tokens: 900, completion_tokens: 45 });
  // The load-bearing downstream property: this text round-trips through the SAME
  // extractJsonObject() every other lane already uses -- no batch-specific parser exists.
  assert.deepEqual(extractJsonObject(res.text), { doc_title: "Batch Fixture", confidence: "high" });
});

test("parseBedrockBatchModelOutput: a markdown-fenced or prose-prefixed reply still salvages via the SAME extractJsonObject() fallback every other lane uses -- no new parsing strategy exists for batch", () => {
  const modelOutput = { output: { message: { content: [{ text: 'Here is the JSON:\n{"doc_title":"fenced"}\nDone.' }] } }, usage: { inputTokens: 10, outputTokens: 5 } };
  assert.deepEqual(extractJsonObject(parseBedrockBatchModelOutput(modelOutput).text), { doc_title: "fenced" });
});

test("parseBedrockBatchModelOutput: missing/malformed modelOutput resolves to text:'' (a CONTENT question, handled by the caller's existing _parseFailed path) -- never throws", () => {
  assert.deepEqual(parseBedrockBatchModelOutput(undefined), { text: "", usage: { prompt_tokens: 0, completion_tokens: 0 } });
  assert.deepEqual(parseBedrockBatchModelOutput({}), { text: "", usage: { prompt_tokens: 0, completion_tokens: 0 } });
  assert.deepEqual(parseBedrockBatchModelOutput({ output: { message: { content: [] } } }), { text: "", usage: { prompt_tokens: 0, completion_tokens: 0 } });
  assert.equal(extractJsonObject(parseBedrockBatchModelOutput(undefined).text), null, "downstream, this becomes _parseFailed exactly like an empty interactive response already does");
});

test("parseBedrockBatchModelOutput: usage defaults to 0/0 when the field is absent, never NaN/undefined", () => {
  const res = parseBedrockBatchModelOutput({ output: { message: { content: [{ text: "{}" }] } } });
  assert.deepEqual(res.usage, { prompt_tokens: 0, completion_tokens: 0 });
});

test("bedrockBatchDiscount: defaults to 50% (BEDROCK_BATCH_DISCOUNT_DEFAULT), the documented Bedrock batch discount", () => {
  assert.equal(BEDROCK_BATCH_DISCOUNT_DEFAULT, 0.5);
  assert.equal(bedrockBatchDiscount({}), 0.5);
});

test("bedrockBatchDiscount: env-overridable via ENRICH_BEDROCK_BATCH_DISCOUNT, clamped-sane (an invalid value falls back to the default rather than corrupting the cost estimate)", () => {
  assert.equal(bedrockBatchDiscount({ ENRICH_BEDROCK_BATCH_DISCOUNT: "0.3" }), 0.3);
  assert.equal(bedrockBatchDiscount({ ENRICH_BEDROCK_BATCH_DISCOUNT: "not-a-number" }), 0.5);
  assert.equal(bedrockBatchDiscount({ ENRICH_BEDROCK_BATCH_DISCOUNT: "-1" }), 0.5, "an out-of-[0,1]-range value falls back to the default, never silently applied");
  assert.equal(bedrockBatchDiscount({ ENRICH_BEDROCK_BATCH_DISCOUNT: "1.5" }), 0.5);
});

test("estBedrockBatchCostFor: applies the discount ON TOP of ratesFor('bedrock'), never a second independent rate table -- an on-demand rate override is automatically reflected", () => {
  // 1,000,000 in + 1,000,000 out at the default $1.00/$5.00 bedrock rate = $6.00 on-demand;
  // 50% batch discount -> $3.00.
  assert.equal(estBedrockBatchCostFor(1_000_000, 1_000_000, {}), 3.0);
  // Overriding the ON-DEMAND rate changes the batch estimate too (same base, still discounted).
  const overridden = estBedrockBatchCostFor(1_000_000, 1_000_000, { ENRICH_BEDROCK_RATE_IN: "2", ENRICH_BEDROCK_RATE_OUT: "10" });
  assert.equal(overridden, 6.0, "(2+10) on-demand * 0.5 discount = 6.0");
});

test("estBedrockBatchCostFor: a custom discount env var changes the estimate, independent of the base rate", () => {
  assert.equal(estBedrockBatchCostFor(1_000_000, 1_000_000, { ENRICH_BEDROCK_BATCH_DISCOUNT: "0.25" }), 4.5, "(1+5) on-demand * (1-0.25) = 4.5");
});

test("estBedrockBatchCostFor: zero tokens costs exactly $0", () => {
  assert.equal(estBedrockBatchCostFor(0, 0, {}), 0);
});

// =========================================================================================
// Layer 2: enrich.mjs CLI-level provider validation (subprocess, no network reached)
// =========================================================================================

function run(args, envExtra = {}) {
  try {
    const stdout = execFileSync("node", [ENRICH_MJS, ...args], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...envExtra },
    });
    return { status: 0, stdout, stderr: "" };
  } catch (e) {
    return { status: e.status, stdout: e.stdout || "", stderr: e.stderr || "" };
  }
}

test("--llm-provider bedrock is ACCEPTED (does not hit the 'must be one of' validation error)", () => {
  // A deliberately-unmapped room fails LATER (the S3 mirror check), never at provider validation --
  // proving `bedrock` took the same path `openai`/`azure` already do, not a shortcut refusal.
  const r = run(["run", "--llm-provider", "bedrock", "--profile", "finance", "--azure-account", "otchealthcfodata", "--container", "no-such-room-fixture-bedrock"]);
  assert.notEqual(r.status, 0);
  assert.doesNotMatch(r.stderr, /--llm-provider must be one of/, "bedrock must not be rejected by the provider validation gate");
  assert.match(r.stderr, /no S3 mirror mapping/, "must fail at the SAME later gate an unmapped room hits under any other provider");
});

test("--llm-provider must be one of openai|azure|bedrock -- an invalid value is refused before any other work", () => {
  const r = run(["run", "--llm-provider", "not-a-real-provider"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--llm-provider must be one of openai\|azure\|bedrock \(got "not-a-real-provider"\)/);
});

test("ENRICH_PROVIDER env var is accepted as an alias for --llm-provider / ENRICH_LLM_PROVIDER", () => {
  const r = run(["run", "--profile", "finance", "--azure-account", "otchealthcfodata", "--container", "no-such-room-fixture-envalias"], { ENRICH_PROVIDER: "bedrock" });
  assert.doesNotMatch(r.stderr, /--llm-provider must be one of/);
  assert.match(r.stderr, /no S3 mirror mapping/);
});

test("legal/personal is refused before provider validation even matters -- openai (the default provider) included", () => {
  const r = run(["run", "--profile", "legal", "--container", "personal"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /REFUSED.*legal.*personal.*attorney-client-privileged/i);
});

test("legal/personal is refused under --llm-provider bedrock specifically (the provider this PR adds)", () => {
  const r = run(["run", "--profile", "legal", "--container", "personal", "--llm-provider", "bedrock"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /REFUSED.*legal.*personal/i);
});

test("source-level regression lock: the default provider is still openai, expressed via DEFAULT_PROVIDER, not a hardcoded second literal", () => {
  const src = readFileSync(ENRICH_MJS, "utf8");
  assert.match(src, /process\.env\.ENRICH_PROVIDER \|\| process\.env\.ENRICH_LLM_PROVIDER \|\| DEFAULT_PROVIDER/, "provider resolution must check ENRICH_PROVIDER, then ENRICH_LLM_PROVIDER, then fall back to the shared DEFAULT_PROVIDER constant");
  assert.match(src, /VALID_PROVIDERS\.includes\(LLM_PROVIDER\)/, "provider validation must use the shared VALID_PROVIDERS list, not a hand-maintained duplicate");
});

// =========================================================================================
// Layer 3: full subprocess integration -- proves enrich.mjs's `_callFailed` contract under
// --llm-provider bedrock end to end (S3 storage + Bedrock Converse, both stubbed).
// =========================================================================================

// Reuses the EXACT same verified S3 mirror row tests/push-search-opensearch.test.mjs already
// established for --profile finance --s3 (otchealthcfodata/cfo-source-docs is a real MIRROR table
// entry), so this resolves past the fail-closed "no S3 mirror mapping" guard with no fabricated
// mapping needed.
const S3_BUCKET = "otchealth-finance-legal-dr-55c84f6b";
const S3_KEY_PREFIX = "otchealthcfodata/cfo-source-docs/";
const S3_HOST = `${S3_BUCKET}.s3.us-east-1.amazonaws.com`;
const BEDROCK_HOST = "bedrock-runtime.us-east-1.amazonaws.com";
const CATALOG_ROW = { path: "test/bedrock-fixture.md", sidecar: true, title: "Bedrock Fixture", entity: "OTCHealth", category: "testing", sha256: "fixturesha256bedrock" };
const DOC_TEXT = "This is the full extracted text of the Bedrock-lane fixture document.";

function isHost(u, host) { try { return new URL(u).host === host; } catch { return false; } }
function pathOf(u) { try { return new URL(u).pathname; } catch { return ""; } }

/**
 * Preload module (the same `--import`-before-the-script's-own-top-level-code technique
 * tests/push-search-opensearch.test.mjs established): stubs S3 (catalog + text sidecar + lock +
 * review-queue writes) and the Bedrock Converse endpoint. `bedrockBehavior` selects what the
 * Converse endpoint does: 'success' (a valid tool-use response), 'transport-fail' (a non-retryable
 * 403, proving `_callFailed`), or 'content-fail' (a response with no toolUse block, proving the
 * `_parseFailed`-equivalent path -- content failure, NOT a thrown transport failure).
 */
function preloadSource(logPath, catalogFlushPath, { bedrockBehavior = "success" } = {}) {
  return `
import { appendFileSync, writeFileSync } from "node:fs";
function isHost(u, host) { try { return new URL(u).host === host; } catch { return false; } }
function pathOf(u) { try { return new URL(u).pathname; } catch { return ""; } }
const CATALOG_ROW = ${JSON.stringify(CATALOG_ROW)};
globalThis.fetch = async (url, opts) => {
  const u = String(typeof url === "string" ? url : url?.url || url);
  const method = (opts && opts.method) || "GET";
  appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ method, url: u, body: opts && opts.body ? String(opts.body).slice(0, 4000) : null }) + "\\n");

  // ---- S3 (storage layer) ----
  if (isHost(u, ${JSON.stringify(S3_HOST)})) {
    const p = pathOf(u);
    if (method === "GET" && p === ${JSON.stringify("/" + S3_KEY_PREFIX + "_CATALOG/catalog.jsonl")}) {
      return new Response(JSON.stringify(CATALOG_ROW) + "\\n", { status: 200 });
    }
    if (method === "GET" && p === ${JSON.stringify("/" + S3_KEY_PREFIX + "_TEXT/test/bedrock-fixture.md.txt")}) {
      return new Response(${JSON.stringify(DOC_TEXT)}, { status: 200 });
    }
    if (method === "GET" && p === ${JSON.stringify("/" + S3_KEY_PREFIX + "_CATALOG/.enrich.lock")}) {
      return new Response("not found", { status: 404 }); // no pre-existing lock
    }
    if (method === "PUT" && p === ${JSON.stringify("/" + S3_KEY_PREFIX + "_CATALOG/catalog.jsonl")}) {
      // The FINAL flushed catalog state -- this is the actual assertion surface for whether the row
      // ended up enriched:true/false. Written to a separate file (not just the call log) so the test
      // can read the LAST flush cleanly regardless of how many intermediate flushes happen.
      writeFileSync(${JSON.stringify(catalogFlushPath)}, String(opts.body));
      return new Response("", { status: 200 });
    }
    // Lock PUT/DELETE, review-queue PUT, and anything else S3-shaped: accept generically.
    if (method === "PUT" || method === "DELETE") return new Response("", { status: 200 });
    return new Response("not found", { status: 404 });
  }

  // ---- Bedrock Converse ----
  if (isHost(u, ${JSON.stringify(BEDROCK_HOST)})) {
    const behavior = ${JSON.stringify(bedrockBehavior)};
    if (behavior === "transport-fail") {
      return new Response("access denied", { status: 403 }); // non-retryable -- converseJson throws immediately
    }
    if (behavior === "content-fail") {
      const body = JSON.stringify({ output: { message: { role: "assistant", content: [{ text: "sorry, I cannot help with that" }] } }, stopReason: "end_turn", usage: { inputTokens: 400, outputTokens: 12 } });
      return new Response(body, { status: 200 });
    }
    // success: a valid forced tool-use response.
    const body = JSON.stringify({
      output: { message: { role: "assistant", content: [{ toolUse: { toolUseId: "t1", name: "emit_metadata", input: { doc_title: "Bedrock Fixture", doc_type: "other", keywords: ["fixture"], confidence: "high" } } }] } },
      stopReason: "tool_use", usage: { inputTokens: 500, outputTokens: 60 },
    });
    return new Response(body, { status: 200 });
  }

  return new Response("not found", { status: 404 });
};
`;
}

function runEnrichBedrock(args, { bedrockBehavior = "success", envExtra = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "enrich-bedrock-test-"));
  const logPath = join(dir, "calls.log");
  const catalogFlushPath = join(dir, "catalog-flush.jsonl");
  writeFileSync(logPath, "");
  writeFileSync(catalogFlushPath, "");
  const preload = join(dir, "preload.mjs");
  writeFileSync(preload, preloadSource(logPath, catalogFlushPath, { bedrockBehavior }));
  const env = {
    PATH: process.env.PATH,
    AWS_ACCESS_KEY_ID: "AKIAUNITTESTFAKE0000",
    AWS_SECRET_ACCESS_KEY: "unit-test-fake-secret-access-key-not-real",
    ...envExtra,
  };
  return execFileP(process.execPath, ["--import", preload, ENRICH_MJS, "run", "--profile", "finance", "--s3", "--llm-provider", "bedrock", ...args], { env, timeout: 30000 })
    .then((r) => ({ status: 0, stdout: r.stdout, stderr: r.stderr, calls: readCalls(logPath), catalogFlush: readCatalogFlush(catalogFlushPath) }))
    .catch((e) => ({ status: e.code ?? 1, stdout: e.stdout || "", stderr: e.stderr || "", calls: readCalls(logPath), catalogFlush: readCatalogFlush(catalogFlushPath) }));
}
function readCalls(logPath) { return readFileSync(logPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); }
function readCatalogFlush(p) {
  const raw = readFileSync(p, "utf8").trim();
  if (!raw) return null;
  return raw.split("\n").filter(Boolean).map((l) => JSON.parse(l))[0];
}

test("integration/bedrock SUCCESS: reaches the Bedrock Converse endpoint with a forced tool call, and the catalog row ends up enriched:true", async () => {
  const r = await runEnrichBedrock([]);
  assert.equal(r.status, 0, `expected a clean exit; stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  const bedrockCall = r.calls.find((c) => isHost(c.url, BEDROCK_HOST));
  assert.ok(bedrockCall, "must have reached the Bedrock Converse endpoint");
  assert.match(pathOf(bedrockCall.url), /^\/model\/us\.anthropic\.claude-haiku-4-5-20251001-v1%3A0\/converse$/, "must call the exact BEDROCK_DEFAULT_MODEL, with the colon percent-encoded exactly once on the wire");
  const body = JSON.parse(bedrockCall.body);
  assert.deepEqual(body.toolConfig.toolChoice, { tool: { name: "emit_metadata" } });
  assert.ok(body.messages[0].content.some((b) => b.text && b.text.includes(DOC_TEXT)), "the document text must actually reach the model");
  assert.ok(r.catalogFlush, "the catalog must have been flushed at least once");
  assert.equal(r.catalogFlush.enriched, true, "a successful Bedrock call must mark the row enriched");
  assert.equal(r.catalogFlush.enriched_sha256, "fixturesha256bedrock", "the enriched sha256 must be recorded so a re-run at the same content is skipped");
  assert.match(r.stdout, /llm: 1\/1 calls ok/);
  assert.match(r.stdout, /provider=bedrock model=us\.anthropic\.claude-haiku-4-5-20251001-v1:0/);
});

test("integration/bedrock TRANSPORT FAILURE (_callFailed): a non-retryable 403 from Bedrock withholds the enriched marker, blanks enriched_sha256, and exits non-zero", async () => {
  const r = await runEnrichBedrock([], { bedrockBehavior: "transport-fail" });
  assert.notEqual(r.status, 0, "a run where every LLM call failed must exit non-zero -- a green tick here would be the exact silent-outage class PR #462 fixed once already");
  assert.match(r.stderr, /FATAL: all 1 LLM call\(s\) failed/);
  assert.match(r.stderr, /provider=bedrock model=us\.anthropic\.claude-haiku-4-5-20251001-v1:0/);
  assert.ok(r.catalogFlush, "the catalog must still be flushed (the row's OTHER fields, and the fact that it was attempted, must be recorded) even though the call failed");
  assert.equal(r.catalogFlush.enriched, false, "a THROW from Bedrock must NOT mark the row enriched -- this is the load-bearing rule this whole PR was told to preserve and extend");
  assert.equal(r.catalogFlush.enriched_sha256, "", "sha256 must be blanked so the row is retried on the next run, not permanently skipped");
  assert.ok(r.catalogFlush.enrich_reasons?.[0]?.includes("LLM call failed"), `expected an 'LLM call failed' reason, got: ${JSON.stringify(r.catalogFlush.enrich_reasons)}`);
});

test("integration/bedrock CONTENT FAILURE (forced-tool refusal, no throw): the row IS marked enriched (not retried forever) but flagged for review -- distinct from the transport-failure case above", async () => {
  const r = await runEnrichBedrock([], { bedrockBehavior: "content-fail" });
  assert.equal(r.status, 0, "a content failure (the model answered, just uselessly) must NOT fail the run the way a transport failure does");
  assert.ok(r.catalogFlush, "the catalog must have been flushed");
  assert.equal(r.catalogFlush.enriched, true, "a content failure still marks the row enriched (it is not retried forever on a model that keeps answering the same useless way)");
  assert.equal(r.catalogFlush.enrich_review, true, "a content failure must be flagged into the review queue");
  assert.doesNotMatch(r.stdout, /FATAL: all \d+ LLM call\(s\) failed/, "a content failure must never look like the total-outage FATAL case");
});

test("integration: --llm-provider bedrock never reaches an OpenAI or Azure OpenAI host", async () => {
  const r = await runEnrichBedrock([]);
  const stray = r.calls.filter((c) => /api\.openai\.com|openai\.azure\.com|cognitiveservices\.azure\.com/i.test(c.url));
  assert.deepEqual(stray, [], "the bedrock lane must never fall through to a different provider's endpoint");
});
