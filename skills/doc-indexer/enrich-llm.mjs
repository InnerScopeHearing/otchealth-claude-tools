// enrich-llm.mjs — provider/model/rate/JSON-extraction helpers factored out of enrich.mjs so they
// are unit-testable without importing the whole CLI script. enrich.mjs (like indexer.mjs/
// deep-pass.mjs) parses process.argv and dispatches a command at import time, which makes a bare
// `import` from a test its own hazard -- see pipeline-paths.mjs's own header for the same reasoning,
// and tests/storage-backend-default.test.mjs's header for why a CLI-entrypoint guard alone does not
// fix it (top-level consts still run on import regardless of the guard). Everything in this file is
// pure or, for the one function that talks to the network, dependency-injectable -- no argv, no
// top-level side effects, no process.exit().
//
// SCOPE: this file owns PROVIDER-SHAPE logic only (which provider/model/rate applies, how to turn a
// Bedrock Converse result into the same shape the OpenAI/Azure chat-completions lanes already
// return, and the shared JSON-extraction fallback every lane's text response goes through). It has
// no knowledge of catalog rows, blob storage, the review queue, or the enrichment schema itself --
// see enrich.mjs's own header for the surrounding pipeline this plugs into.

import { converseJson } from "./bedrock-client.mjs";

// ============================ provider / model selection ============================
export const VALID_PROVIDERS = Object.freeze(["openai", "azure", "bedrock"]);
export const DEFAULT_PROVIDER = "openai"; // UNCHANGED default -- today's behavior stays byte-identical.

// Bedrock Converse, AWS account 900915535335, region us-east-1: live-verified 2026-08-29 with a real
// 1-token-class Converse call (a forced tool-use round trip completed with stopReason "tool_use" and
// a populated tool input) before this file was written. Still training-data knowledge of Bedrock's
// on-demand catalog for the PRICE below, not a live probe of pricing -- re-verify against
// `aws bedrock list-inference-profiles --region us-east-1` + the live Bedrock pricing page before
// trusting a large real backfill's cost estimate (bedrock-client.mjs's own header carries the
// identical caveat for deep-pass.mjs's port of the same model). Matches deep-pass.mjs's
// BEDROCK_DEFAULT_MODEL for the finance profile on purpose, so the two pipelines never quietly
// disagree about which Haiku snapshot "the enrich Bedrock lane" means.
export const BEDROCK_DEFAULT_MODEL = "us.anthropic.claude-haiku-4-5-20251001-v1:0";

/**
 * The default MODEL for a given provider. Callers still apply their own --model / env override
 * chain FIRST (enrich.mjs: --model, then a generic ENRICH_MODEL, then this) -- this function only
 * supplies the final fallback, so openai/azure's pre-existing defaults are reproduced byte-for-byte
 * and bedrock slots into the exact same precedence chain rather than getting a parallel one.
 * `envBedrockModel` is the ENRICH_BEDROCK_MODEL env var, passed in rather than read here so this
 * function stays a pure function of its arguments (see extractJsonObject's own note on why that
 * matters for testability).
 */
export function defaultModelFor(provider, envBedrockModel) {
  if (provider === "openai") return "gpt-4o-mini";
  if (provider === "bedrock") return envBedrockModel || BEDROCK_DEFAULT_MODEL;
  return "gpt-4.1-mini"; // azure (history/rollback path, unchanged)
}

// ============================ per-provider $/1M-token rates (env-overridable) ============================
// Bedrock's default pair (1.00 / 5.00) matches deep-pass.mjs's own RATES table entry for the SAME
// model id (us.anthropic.claude-haiku-4-5-20251001-v1:0) -- see that file's RATES constant -- so the
// two independently-built Bedrock ports never quietly report two different prices for one model.
export function ratesFor(provider, env = process.env) {
  if (provider === "openai") {
    return [parseFloat(env.ENRICH_OPENAI_RATE_IN || "0.15"), parseFloat(env.ENRICH_OPENAI_RATE_OUT || "0.60")];
  }
  if (provider === "bedrock") {
    return [parseFloat(env.ENRICH_BEDROCK_RATE_IN || "1.00"), parseFloat(env.ENRICH_BEDROCK_RATE_OUT || "5.00")];
  }
  return [parseFloat(env.ENRICH_AZURE_RATE_IN || "0.4"), parseFloat(env.ENRICH_AZURE_RATE_OUT || "1.6")];
}

/** $ estimate for tin/tout tokens under `provider`'s current rate pair. Pure aside from reading
 *  `env` (defaults to process.env; a test passes a plain object instead). */
export function estCostFor(provider, tin, tout, env = process.env) {
  const [rin, rout] = ratesFor(provider, env);
  return (tin / 1e6) * rin + (tout / 1e6) * rout;
}

// ============================ shared JSON extraction ============================
/**
 * Parse `text` as JSON; on failure, fall back to slicing the substring from the first "{" to the
 * last "}" and parsing THAT (handles a markdown-fenced ```json block or a "Here is the JSON:"
 * prefix, since neither adds a brace before the real opening one or after the real closing one).
 * Returns null, never throws, when both attempts fail. This IS the "existing parse-failure path"
 * every provider lane shares -- enrich.mjs's own `J` is this same function, not a second
 * implementation, so a fix or a new edge case here benefits openai/azure/bedrock identically.
 */
export function extractJsonObject(text) {
  try {
    return JSON.parse(text);
  } catch {
    /* fall through to the salvage attempt below */
  }
  try {
    const s = String(text == null ? "" : text);
    const start = s.indexOf("{");
    const end = s.lastIndexOf("}");
    if (start === -1 || end === -1 || end < start) return null;
    return JSON.parse(s.slice(start, end + 1));
  } catch {
    return null;
  }
}

// ============================ Bedrock Converse adapter ============================
export const BEDROCK_TOOL_NAME = "emit_metadata";
// Loosely typed on purpose. enrich.mjs's enrichSystemPrompt() already documents the exact
// field-by-field schema for the active domain/profile as prose+JSON-in-a-string in the system
// message (it varies per --domain-pack: commerce adds channel/brand/... , finance/legal add the
// segment-confidentiality fields). Mirroring that same per-domain shape a SECOND time as a formal
// JSON Schema here would create two sources of truth for one contract, with no way to keep them in
// sync automatically -- exactly the kind of drift risk this fleet keeps rediscovering the hard way
// (see e.g. FND-20260828-5ca1 on divergent SigV4 encodings). Bedrock's forced tool-use only needs an
// object-shaped tool to guarantee SYNTACTICALLY VALID JSON out of the model; it does not need every
// field pre-declared in the schema for the model to populate them, since `additionalProperties:true`
// leaves the model free to emit whatever fields the system prompt actually asked for.
export const BEDROCK_TOOL_SCHEMA = Object.freeze({
  type: "object",
  description: "Document metadata matching exactly the schema described in the system prompt.",
  additionalProperties: true,
});

/**
 * One Bedrock Converse call for enrich.mjs, returning the SAME `{ text, usage }` shape
 * enrich.mjs's chatJson()/callEnrichLLM() already use for the OpenAI/Azure lanes -- so no
 * downstream code (extractJsonObject, `_parseFailed`, `_callFailed`, the enriched-marker/patch
 * logic) needs a Bedrock-specific branch; it already handles "the model responded with text that
 * may or may not be JSON" uniformly across all three providers.
 *
 * `obj === null` in converseJson's result (bedrock-client.mjs's own documented CONTENT failure: a
 * forced-tool refusal, or maxTokens truncation before the tool call closed -- see its own doc
 * comment) becomes `text: ""` here, which extractJsonObject turns into `null`, which
 * enrich.mjs's callEnrichLLM turns into `{ _parseFailed: true }` -- EXACTLY mirroring what a
 * non-JSON free-text response already does on the OpenAI/Azure lanes today (flagged low-confidence
 * for human review, but the row IS still marked enriched so it is not retried forever on a model
 * that answered, just answered uselessly).
 *
 * A THROW from `converse` (network error, a non-retryable HTTP status, retries exhausted, or the
 * "AWS credentials unavailable" configuration error -- see bedrock-client.mjs's own converseJson
 * doc comment for the full list) is NOT caught here; it propagates to the caller UNCHANGED. That is
 * deliberate and load-bearing: enrich.mjs's callEnrichLLM() wraps its LLM call in a try/catch that
 * exists PRECISELY to catch a throw like this and set `_callFailed` (which withholds the enriched
 * marker and, if every call in a run fails, exits the run non-zero) -- swallowing or converting the
 * throw into a quiet `{ text: "" }` here would reintroduce the exact silent-poisoning bug class
 * enrich.mjs's PR #462 already fixed once for the OpenAI/Azure lanes (a dead model looking like a
 * mild quality problem instead of a broken dependency). See this repo's fleet-wide lesson on never
 * letting "the call finished" and "the call succeeded" collapse into one signal.
 *
 * `converse` defaults to the real bedrock-client.mjs converseJson and is dependency-injectable
 * purely so tests can substitute a fake without touching global fetch/env/AWS credentials;
 * production code never passes it explicitly.
 */
export async function callBedrockChat({ modelId, region, system, user, maxTokens, temperature = 0, timeoutMs, converse = converseJson } = {}) {
  const res = await converse({
    modelId,
    region,
    system,
    userContent: [{ text: user }],
    toolName: BEDROCK_TOOL_NAME,
    toolSchema: BEDROCK_TOOL_SCHEMA,
    maxTokens,
    temperature,
    timeoutMs,
  });
  const text = res.obj != null ? JSON.stringify(res.obj) : "";
  return {
    text,
    usage: {
      prompt_tokens: res.usage?.prompt_tokens || 0,
      completion_tokens: res.usage?.completion_tokens || 0,
    },
  };
}
