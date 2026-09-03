// llmobs-emit.mjs — Datadog LLM Observability span emission for the toolkit's Bedrock Converse
// caller (skills/doc-indexer/bedrock-client.mjs). A DELIBERATE, DOCUMENTED PORT of the gateway's
// otchealth-mcp-server/src/telemetry/llmobs.ts -- the same reasoning setup/openai-usage.mjs's own
// header already gives for NOT sharing code with the gateway's openai-cost.ts (a Node-ESM toolkit
// repo and the gateway's TypeScript build cannot share a module directly) applies identically
// here. Keep the two files' PAYLOAD SHAPE and SAFETY CONTRACT in sync when either is revised;
// they are independently reviewable/testable on purpose.
//
// RESEARCH (T-5, 2026-09-03) -- see the gateway's llmobs.ts for the full writeup + every URL
// fetched. Summary: POST https://api.<DD_SITE>/api/intake/llm-obs/v1/trace/spans, header
// DD-API-KEY only, no dd-trace SDK and no Datadog Agent required. Supported on every Datadog site
// except the two FED sites (app.ddog-gov.com, us2.ddog-gov.com) per the docs' own unsupported
// list -- us3.datadoghq.com (this fleet's site) is not on that list. start_ns/duration are
// NANOSECONDS. meta.kind is one of agent|workflow|llm|tool|task|embedding|retrieval.
//
// SAFETY CONTRACT (mirrors the gateway's llmobs.ts + this toolkit's own dd-emit.mjs precedent for
// "check the flag before touching a secret store or the network"):
//   - INERT BY DEFAULT: emitLlmObsSpan() reads nothing but the DD_LLMOBS_ENABLED env var and
//     returns immediately (no kvSecret/SSM round trip, no crypto, no fetch) unless it is truthy.
//   - NEVER sends prompt/completion/document TEXT unless DD_LLMOBS_CAPTURE_CONTENT is ALSO
//     truthy (default off). Even then, only whatever inputText/outputText a CALLER explicitly
//     supplies is ever forwarded -- this file never reaches into a request/response object on its
//     own. bedrock-client.mjs's converseJson wrapper (this file's only caller today) deliberately
//     never populates those two fields AT ALL, regardless of the flag: Converse is invoked by
//     deep-pass.mjs and enrich.mjs against document text that can be MNPI/attorney-privileged
//     (finance-cfo-source-docs, legal-company) -- sending that to a third-party observability
//     vendor would defeat the entire reason those rooms moved to in-account Bedrock instead of
//     OpenAI-direct in the first place (see otchealth-cto/CLAUDE.md's 2026-08-29 Bedrock
//     enrichment-lane entry). Only categorical/boolean/numeric signals (token counts, latency,
//     stop_reason, model id) are ever sent from that call site.
//   - Fire-and-forget: emitLlmObsSpan() is synchronous from the caller's point of view (never
//     awaited, never throws); the actual kvSecret lookup + POST happen in an internal, unawaited
//     async chain with every failure swallowed. A bug or Datadog outage here must never affect
//     the real Bedrock call it instruments -- mirrors this toolkit's setup/openai-usage.mjs
//     "recordOpenAIUsage() never throws, never blocks the caller" contract exactly.

import { randomBytes } from "node:crypto";
import { kvSecret } from "../kb-memory/azure-secret.mjs";

const MAX_ERROR_LEN = 500;
const MAX_CONTENT_LEN = 4000;

function envFlag(name) {
  const v = (process.env[name] || "").trim().toLowerCase();
  return v === "1" || v === "true";
}

function isEnabled() {
  return envFlag("DD_LLMOBS_ENABLED");
}

function captureContentEnabled() {
  return envFlag("DD_LLMOBS_CAPTURE_CONTENT");
}

function mlApp() {
  return (process.env.DD_LLMOBS_ML_APP || "").trim() || "otchealth-toolkit";
}

/** Nanoseconds since epoch (Date.now() * 1e6 -- an approximation, see the gateway llmobs.ts's
 *  identical note; this toolkit has no higher-resolution wall clock need here either). */
export function nowNs() {
  return Date.now() * 1e6;
}

/** 16 lowercase hex characters (64 bits) -- a standalone reporting span/trace id, not correlated
 *  with any distributed trace. */
export function generateSpanId() {
  return randomBytes(8).toString("hex");
}

/**
 * Pure: build one wire-format span object. `ids` is externally supplied so tests can assert on
 * deterministic output without depending on crypto randomness. Never throws on malformed numeric
 * fields (non-finite values are simply omitted from `metrics`). Mirrors the gateway llmobs.ts's
 * buildLlmObsSpan() field-for-field.
 */
export function buildLlmObsSpan(input, ids) {
  const meta = { kind: input.kind };
  if (input.model) meta.model_name = input.model;
  if (input.provider) meta.model_provider = input.provider;
  if (input.metadata && Object.keys(input.metadata).length > 0) meta.metadata = input.metadata;
  if (!input.ok) {
    meta.error = { message: String(input.errorMessage || "unknown error").slice(0, MAX_ERROR_LEN) };
  }
  if (captureContentEnabled()) {
    if (typeof input.inputText === "string" && input.inputText.length > 0) {
      meta.input = { value: input.inputText.slice(0, MAX_CONTENT_LEN) };
    }
    if (typeof input.outputText === "string" && input.outputText.length > 0) {
      meta.output = { value: input.outputText.slice(0, MAX_CONTENT_LEN) };
    }
  }

  const metrics = {};
  const finite = (n) => typeof n === "number" && Number.isFinite(n);
  if (finite(input.inputTokens)) metrics.input_tokens = input.inputTokens;
  if (finite(input.outputTokens)) metrics.output_tokens = input.outputTokens;
  if (finite(input.totalTokens)) {
    metrics.total_tokens = input.totalTokens;
  } else if (metrics.input_tokens !== undefined || metrics.output_tokens !== undefined) {
    metrics.total_tokens = (metrics.input_tokens || 0) + (metrics.output_tokens || 0);
  }

  const span = {
    span_id: ids.spanId,
    trace_id: ids.traceId,
    parent_id: "undefined", // literal string -- Datadog's own convention for a span with no parent
    name: input.name,
    start_ns: Math.round(input.startNs),
    duration: Math.max(0, Math.round(input.durationNs)),
    status: input.ok ? "ok" : "error",
    meta,
  };
  if (Object.keys(metrics).length > 0) span.metrics = metrics;
  return span;
}

/** Pure: wrap spans in the LLM Observability Spans API's top-level envelope. Returns null when
 *  there is nothing to send. */
export function buildLlmObsPayload(spans, appName = mlApp(), tags) {
  if (!spans.length) return null;
  const attributes = { ml_app: appName, spans };
  if (tags && tags.length > 0) attributes.tags = tags;
  return { data: { type: "span", attributes } };
}

// Test-only indirection, mirroring this exact directory's dd-emit.mjs precedent (see that file's
// own comment): kvSecret() reaches AWS SSM with whatever ambient credentials the process has, and
// this repo's test runner is plain `node --test` (node:test's mock.module needs
// --experimental-test-module-mocks, unavailable here) -- so a test that wants to force the
// "no key resolves" or "the lookup throws" path swaps this in instead of relying on env-clearing,
// which is not reliable proof of "unreachable" on a seat that carries real AWS credentials (an
// agent/CI seat commonly does). Defaults to the real kvSecret; _resetForTests() restores it.
let _secretGetter = kvSecret;

/** Async credential resolution: env first (so a job can override without touching SSM), then
 *  kvSecret() -- the fleet secret helper, which defaults to AWS SSM (see azure-secret.mjs's own
 *  header) -- reading ONLY the secret NAMES `datadog-api-key`/`datadog-site`, matching this
 *  toolkit's existing skills/datadog/dd-emit.mjs convention exactly (that file's own `creds()`).
 *  Deliberately NOT reusing dd-emit.mjs's private creds() by import: this file stays a small,
 *  independently reviewable/testable module with no coupling to that file's internals, the same
 *  isolation choice openai-cost.ts documents for its own price table vs. the toolkit's. Never
 *  throws -- a rejected _secretGetter() resolves to {key:"", site:"datadoghq.com"}, which the
 *  caller already treats as "no key resolved -> inert". */
async function resolveDdCreds() {
  try {
    const key = process.env.DD_API_KEY || (await _secretGetter("datadog-api-key")) || "";
    const site = process.env.DD_SITE || (await _secretGetter("datadog-site")) || "datadoghq.com";
    return { key, site };
  } catch {
    return { key: "", site: "datadoghq.com" };
  }
}

/** Test-only: restore the real kvSecret after a test substitutes it, so a stub can never leak
 *  into a later test (mirrors dd-emit.mjs's _resetForTests exactly). */
export function _resetForTests() {
  _secretGetter = kvSecret;
}

/** Test-only: substitute the secret lookup (see _secretGetter above). Pass nothing to restore. */
export function _setSecretGetterForTests(fn) {
  _secretGetter = fn || kvSecret;
}

async function emitLlmObsSpanAsync(input) {
  try {
    const ids = { spanId: generateSpanId(), traceId: generateSpanId() };
    const span = buildLlmObsSpan(input, ids);
    const payload = buildLlmObsPayload([span], mlApp(), input.tags);
    if (!payload) return;
    const { key, site } = await resolveDdCreds();
    if (!key) return;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1500);
    try {
      await fetch(`https://api.${site}/api/intake/llm-obs/v1/trace/spans`, {
        method: "POST",
        headers: { "DD-API-KEY": key, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
    } catch {
      // Fire-and-forget: a network/HTTP failure here must never surface to the Bedrock call site.
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // Never let a bug in telemetry break the real call site it is bolted onto.
  }
}

/**
 * Emit one LLM Observability span for a single Bedrock Converse (or future LLM-shaped) call.
 * Synchronous from the caller's point of view -- checks DD_LLMOBS_ENABLED FIRST, before any
 * kvSecret lookup or network I/O (see this file's SAFETY CONTRACT doc comment), then fires the
 * real work in an unawaited, fully-guarded async chain. Never throws, never returns a promise the
 * caller is expected to handle.
 */
export function emitLlmObsSpan(input) {
  if (!isEnabled()) return;
  void emitLlmObsSpanAsync(input).catch(() => {});
}
