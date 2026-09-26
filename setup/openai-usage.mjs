// openai-usage.mjs — the ONE place that turns a real OpenAI API response into a usage receipt.
//
// WHY THIS EXISTS: retain usage values and response identifiers returned by OpenAI calls already
// made by this toolkit. The recorder works from the parsed response at the existing call site and
// does not make provider requests of its own.
//
// Every record is derived from a parsed provider response: returned model and response IDs when
// present, HTTP status when available, and numeric leaves from its `usage` object. Prompts, outputs,
// tool arguments, credentials, user identity, and estimated dollars are never recorded. The same
// receipt goes to the existing local JSONL ledger; only provider usage counts and request totals are
// sent to Datadog.
//
// SAFETY CONTRACT (load-bearing, do not weaken):
//   1. recordOpenAIUsage() NEVER throws and NEVER blocks the caller. It is synchronous, in-memory,
//      fail-open -- a bug in this file must never break a real OpenAI call site it is bolted onto.
//   2. recordOpenAIUsage() performs NO network I/O of its own. It buffers, and best-effort appends one
//      JSONL line to a local ledger file (sync fs, wrapped in try/catch). The only network calls this
//      module ever makes are inside flush() (explicit) or the lazily-installed exit-flush hook
//      (installAutoFlushOnExit(), also only reachable through a REAL, non-disabled recordOpenAIUsage()
//      call -- see OPENAI_USAGE_DISABLE below). This split matters: it means every test file across the
//      toolkit that exercises an instrumented call site (mocking `fetch` for the OpenAI response) can
//      safely call the real recordOpenAIUsage() without ever reaching a real Datadog network call,
//      AS LONG AS OPENAI_USAGE_DISABLE=1 is set for that test run (run-tests.sh sets it fleet-wide --
//      see its own comment). Without that env var, a resolvable datadog-api-key in the ambient
//      environment (e.g. an interactive session with real fleet secrets hydrated) WOULD let a test's
//      exit-flush send real, test-fixture-derived numbers to production Datadog. Do not remove the
//      OPENAI_USAGE_DISABLE short-circuit below, and do not make flush() reachable synchronously from
//      recordOpenAIUsage() without going through that same guard.
//   3. estimateCostUsd() remains a standalone compatibility helper. It is never called by this
//      recorder and its output is never written to the JSONL ledger or sent to Datadog.
//
// Uses the existing fleet Datadog emitter (skills/datadog/dd-emit.mjs's ddMetric()) rather than a new
// one: it already resolves datadog-api-key via the standard kvSecret() chain (AWS SSM by default) and
// is already LOUD on a failed emit instead of silently swallowing it (see that file's own header for
// the "Succeeded job, zero visible telemetry" bug class this toolkit already paid to fix once).

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ddMetric as _realDdMetric } from "../skills/datadog/dd-emit.mjs";

// ============================================================================================
// Price table (USD per 1,000,000 tokens unless noted). This supports only the standalone
// estimateCostUsd() compatibility helper below. The response recorder never emits these estimates.
//
// Deliberately does NOT try to price every model id the fleet might resolve to. The fleet's own
// OPENAI_TIERS (setup/model-routing.mjs) moved to the gpt-5.6-luna/-sol/-terra family on 2026-08-29;
// this table now carries their published per-1M rates (live-verified against
// developers.openai.com/api/docs/pricing on 2026-09-03 -- see the gpt-5.6-* rows in CHAT_PRICES
// below, including each model's long-context tier, which applies once a call's prompt_tokens exceeds
// GPT_5_6_LONG_CONTEXT_THRESHOLD). gpt-5.6-sol's short-context rate is a published OpenAI PROMOTIONAL
// price in effect through 2026-11-21 -- re-verify against the live pricing page after that date
// rather than assuming it still holds. Any OTHER unrecognized model id (a genuinely new or renamed
// model this table has not been updated for yet) still falls through to the UNKNOWN_MODEL bucket:
// priced at the MOST EXPENSIVE rate this table DOES know, across every known model AND context tier
// (so real spend is never under-counted), and tagged unknown:true (so a dashboard can tell
// "confident" apart from "conservative guess" at a glance).
// ============================================================================================
export const PRICE_TABLE_VERSION = "2026-09-03";

// The gpt-5.6 family's long-context threshold: OpenAI applies each model's higher long-context rate
// once a request's prompt_tokens exceeds this figure (live-verified against
// developers.openai.com/api/docs/pricing, 2026-09-03). Shared by all three gpt-5.6-* rows below so
// the boundary value is defined exactly once.
const GPT_5_6_LONG_CONTEXT_THRESHOLD = 272_000;

// Ordered rules, first regex match wins. `re` matches a bare model id or one with an OpenAI-style
// dated snapshot suffix (e.g. "gpt-4o-2024-08-06"); it does NOT loosely prefix-match, so a genuinely
// different/newer model (gpt-4.15, gpt-4o-turbo, gpt-5.7-luna, ...) falls through to UNKNOWN_MODEL_CHAT
// instead of silently absorbing a family's pricing it was never confirmed to share.
//
// An entry MAY carry an optional `longContext: { threshold, input, output, cachedInput }` -- when
// present, matchChatPrice() uses those rates instead of the entry's own short-context ones once the
// call's prompt_tokens exceeds `threshold`. Only the gpt-5.6-* family has this two-tier shape today;
// every other entry is priced flat regardless of prompt length, unchanged from before this shape existed.
const CHAT_PRICES = [
  { re: /^gpt-4o-mini(-\d{4}-\d{2}-\d{2})?$/i, input: 0.15, output: 0.6, cachedInput: 0.075 },
  { re: /^gpt-4o(-\d{4}-\d{2}-\d{2})?$/i, input: 2.5, output: 10.0, cachedInput: 1.25 },
  { re: /^gpt-4\.1-nano(-\d{4}-\d{2}-\d{2})?$/i, input: 0.1, output: 0.4, cachedInput: 0.025 },
  { re: /^gpt-4\.1-mini(-\d{4}-\d{2}-\d{2})?$/i, input: 0.4, output: 1.6, cachedInput: 0.1 },
  { re: /^gpt-4\.1(-\d{4}-\d{2}-\d{2})?$/i, input: 2.0, output: 8.0, cachedInput: 0.5 },
  { re: /^gpt-3\.5-turbo(-\d{4})?$/i, input: 0.5, output: 1.5, cachedInput: 0.25 },
  // gpt-5.6 family (2026-08-29 OPENAI_TIERS cutover; rates live-verified against
  // developers.openai.com/api/docs/pricing on 2026-09-03). sol's short-context rate is a published
  // OpenAI PROMOTIONAL price in effect through 2026-11-21 -- see PRICE_TABLE_VERSION's header note.
  { re: /^gpt-5\.6-sol(-\d{4}-\d{2}-\d{2})?$/i, input: 4.0, output: 20.0, cachedInput: 0.4, longContext: { threshold: GPT_5_6_LONG_CONTEXT_THRESHOLD, input: 8.0, output: 30.0, cachedInput: 0.8 } },
  { re: /^gpt-5\.6-terra(-\d{4}-\d{2}-\d{2})?$/i, input: 2.0, output: 12.0, cachedInput: 0.2, longContext: { threshold: GPT_5_6_LONG_CONTEXT_THRESHOLD, input: 4.0, output: 18.0, cachedInput: 0.4 } },
  { re: /^gpt-5\.6-luna(-\d{4}-\d{2}-\d{2})?$/i, input: 0.2, output: 1.2, cachedInput: 0.02, longContext: { threshold: GPT_5_6_LONG_CONTEXT_THRESHOLD, input: 0.4, output: 1.8, cachedInput: 0.04 } },
];

const EMBEDDING_PRICES = [
  { re: /^text-embedding-3-large$/i, input: 0.13 },
  { re: /^text-embedding-3-small$/i, input: 0.02 },
  { re: /^text-embedding-ada-002$/i, input: 0.1 },
];

// The following image estimate is retained only for the standalone estimateCostUsd() compatibility
// helper. recordOpenAIUsage() never calls the helper or emits this estimate.
const IMAGE_FLAT_FALLBACK_USD = 0.04;
const KNOWN_IMAGE_MODEL_RE = /^gpt-image(-1)?(-mini)?$/i;

// Flattens each entry's short-context rates AND (when present) its long-context rates into one list
// of plain {input,output,cachedInput} points, so the "most expensive known" fallback below reflects
// the worst-case published rate across every known model/context-tier combination -- not just each
// model's short-context row -- keeping the "never under-counts an unrecognized model" guarantee true
// now that a single model id can carry two different rates depending on prompt length.
const CHAT_PRICE_POINTS = CHAT_PRICES.flatMap((p) => {
  const points = [{ input: p.input, output: p.output, cachedInput: p.cachedInput }];
  if (p.longContext) points.push({ input: p.longContext.input, output: p.longContext.output, cachedInput: p.longContext.cachedInput });
  return points;
});
const MOST_EXPENSIVE_CHAT = CHAT_PRICE_POINTS.reduce((a, b) => (b.output > a.output ? b : a));
const MOST_EXPENSIVE_EMBEDDING = EMBEDDING_PRICES.reduce((a, b) => (b.input > a.input ? b : a));

/** `promptTokens` picks between an entry's short- and long-context rates (see CHAT_PRICES' own doc
 *  comment) -- STRICTLY greater than the threshold selects long-context, matching the fleet's stated
 *  "apply the long-context rate when prompt_tokens exceed 272,000" rule (a call AT exactly the
 *  threshold still prices at the short-context rate). Defaults to 0 so every pre-existing call site
 *  that does not pass promptTokens keeps resolving the short-context rate, unchanged. */
function matchChatPrice(model, promptTokens = 0) {
  const m = String(model || "");
  for (const p of CHAT_PRICES) {
    if (!p.re.test(m)) continue;
    if (p.longContext && Number(promptTokens) > p.longContext.threshold) {
      return { input: p.longContext.input, output: p.longContext.output, cachedInput: p.longContext.cachedInput, unknown: false };
    }
    return { input: p.input, output: p.output, cachedInput: p.cachedInput, unknown: false };
  }
  return { input: MOST_EXPENSIVE_CHAT.input, output: MOST_EXPENSIVE_CHAT.output, cachedInput: MOST_EXPENSIVE_CHAT.cachedInput, unknown: true };
}

function matchEmbeddingPrice(model) {
  const m = String(model || "");
  for (const p of EMBEDDING_PRICES) if (p.re.test(m)) return { input: p.input, unknown: false };
  return { input: MOST_EXPENSIVE_EMBEDDING.input, unknown: true };
}

/** PURE compatibility helper. Its result is an estimate, not provider usage, and is never included in
 *  response receipts or Datadog metrics. Exported for direct unit testing. */
export function estimateCostUsd({ model, kind, promptTokens = 0, completionTokens = 0, cachedTokens = 0, images = 0 } = {}) {
  if (kind === "embedding") {
    const price = matchEmbeddingPrice(model);
    return { costUsd: (Math.max(0, promptTokens) / 1e6) * price.input, unknown: price.unknown };
  }
  if (kind === "image") {
    const known = KNOWN_IMAGE_MODEL_RE.test(String(model || ""));
    const n = images > 0 ? images : 1;
    return { costUsd: n * IMAGE_FLAT_FALLBACK_USD, unknown: !known };
  }
  // 'chat' and 'other' (moderation, unclassified) priced as chat-shaped token usage. `pt` is computed
  // BEFORE matchChatPrice() so a gpt-5.6-* call whose prompt_tokens exceeds
  // GPT_5_6_LONG_CONTEXT_THRESHOLD is priced at that model's long-context rate, not its short one.
  const pt = Math.max(0, promptTokens);
  const price = matchChatPrice(model, pt);
  const cached = Math.max(0, Math.min(cachedTokens, pt));
  const fresh = Math.max(0, pt - cached);
  const inputCost = (fresh / 1e6) * price.input + (cached / 1e6) * (price.cachedInput ?? price.input);
  const outputCost = (Math.max(0, completionTokens) / 1e6) * price.output;
  return { costUsd: inputCost + outputCost, unknown: price.unknown };
}

// ============================================================================================
// Local JSONL ledger -- so provider-returned usage is retained even when Datadog is
// unreachable (network blip, a not-yet-resolved datadog-api-key, a disabled test run, ...). No prior
// "toolkit state directory" convention existed to reuse (checked: the toolkit's other local-state
// touchpoints are ad hoc credential-cache file paths, not a shared directory) -- this establishes one,
// documented in docs/OPENAI-COST-VISIBILITY.md, under the same homedir-dotfile convention the fleet
// already uses for credential caches (e.g. ~/.gcp_claude_driver_sa.json).
// ============================================================================================
let _ledgerDirOverride = null;
function ledgerDir() {
  return _ledgerDirOverride || process.env.OPENAI_USAGE_LEDGER_DIR || join(homedir(), ".otchealth", "openai-usage");
}
function ledgerPathForToday() {
  const day = new Date().toISOString().slice(0, 10);
  return join(ledgerDir(), `usage-${day}.jsonl`);
}
function appendLedgerLine(record) {
  try {
    const dir = ledgerDir();
    mkdirSync(dir, { recursive: true });
    appendFileSync(ledgerPathForToday(), JSON.stringify(record) + "\n");
  } catch (e) {
    // Best-effort only -- a read-only filesystem or a missing HOME must never break the real caller
    // this function is bolted onto (see the SAFETY CONTRACT in this file's header).
    try {
      console.error(`[openai-usage] local ledger append failed (non-fatal, Datadog emission is unaffected): ${(e && e.message) || e}`);
    } catch {
      /* even console.error can theoretically throw on a broken stderr; never let that escape either */
    }
  }
}

// ============================================================================================
// Buffering + Datadog emission
// ============================================================================================
const VALID_KINDS = new Set(["chat", "embedding", "batch", "image", "other"]);
const _buffer = [];
let _ddMetricImpl = _realDdMetric;
let _autoFlushInstalled = false;

function flushThreshold() {
  const n = Math.floor(Number(process.env.OPENAI_USAGE_FLUSH_THRESHOLD));
  return Number.isFinite(n) && n > 0 ? n : 200;
}

function safeIdentifier(value, maxLength = 128) {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!text || text.length > maxLength || !/^[A-Za-z0-9][A-Za-z0-9._:/_-]*$/.test(text)) return undefined;
  return text;
}

function responseHeader(response, name) {
  try {
    return response?.headers?.get?.(name) || undefined;
  } catch {
    return undefined;
  }
}

const USAGE_COUNT_FIELDS = new Set([
  "prompt_tokens", "completion_tokens", "total_tokens", "input_tokens", "output_tokens",
  "cached_tokens", "cache_write_tokens", "reasoning_tokens", "audio_tokens", "text_tokens", "image_tokens",
  "accepted_prediction_tokens", "rejected_prediction_tokens",
]);
const USAGE_DETAIL_FIELDS = new Set([
  "prompt_tokens_details", "completion_tokens_details", "input_tokens_details", "output_tokens_details",
]);

function sanitizeUsage(value, depth = 0) {
  if (!value || typeof value !== "object" || Array.isArray(value) || depth > 5) return undefined;
  const safe = {};
  for (const [key, child] of Object.entries(value)) {
    if (USAGE_COUNT_FIELDS.has(key) && typeof child === "number" && Number.isFinite(child) && child >= 0) {
      safe[key] = child;
    } else if (USAGE_DETAIL_FIELDS.has(key) && child && typeof child === "object" && !Array.isArray(child)) {
      const nested = sanitizeUsage(child, depth + 1);
      if (nested && Object.keys(nested).length > 0) safe[key] = nested;
    }
  }
  return Object.keys(safe).length ? safe : undefined;
}

function responseStatus(response) {
  const status = response?.status ?? response?.status_code;
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined;
}

/**
 * recordOpenAIUsage({ kind, response, body })
 * Keep one allowlisted receipt for a real OpenAI response that contains numeric usage data. For a
 * synchronous Fetch response, pass its Response plus the parsed JSON body. For a Batch result, pass
 * the row's `response` object plus its parsed `body`. The recorder projects only response metadata
 * and numeric `usage` leaves; it never serializes the supplied body.
 *
 * If the response contains no numeric usage fields, nothing is recorded. Missing metadata and usage
 * fields stay absent rather than being fabricated as `unknown` or zero. `kind` is controlled by the
 * call site and is limited to chat, embedding, batch, image, or other.
 *
 * NEVER throws. Returns undefined always -- this is intentionally not a Promise (see the SAFETY
 * CONTRACT in this file's header for why no network I/O happens synchronously here).
 */
export function recordOpenAIUsage(opts) {
  // Hard kill-switch. run-tests.sh sets this fleet-wide so the toolkit test gate can exercise every
  // instrumented call site (via a mocked `fetch`) with zero risk of a real Datadog network call at
  // process exit -- see this file's header SAFETY CONTRACT, point 2.
  if (process.env.OPENAI_USAGE_DISABLE === "1") return;
  try {
    // Destructured INSIDE the try, deliberately not in the function signature: a signature-level
    // default (`{ model } = {}`) only applies when the caller passes `undefined`, NOT `null` --
    // `recordOpenAIUsage(null)` would throw a TypeError while destructuring the parameter itself,
    // before this function body (and its own try/catch) ever runs. `opts || {}` here covers every
    // falsy input (null, undefined, 0, "", false) the same way, so the "NEVER throws" contract in
    // this file's header holds for a genuinely careless caller too, not just a well-formed one.
    const { kind, response, body } = opts || {};
    const safeKind = VALID_KINDS.has(kind) ? kind : undefined;
    const providerBody = body ?? response?.body;
    const usage = sanitizeUsage(providerBody?.usage);
    if (!safeKind || !usage) return;

    const record = {
      ts: new Date().toISOString(),
      provider: "openai",
      kind: safeKind,
    };
    const model = safeIdentifier(providerBody?.model);
    const responseId = safeIdentifier(providerBody?.id);
    const requestId = safeIdentifier(responseHeader(response, "x-request-id") || response?.request_id);
    const httpStatus = responseStatus(response);
    if (model) record.model = model;
    if (requestId) record.requestId = requestId;
    if (responseId) record.responseId = responseId;
    if (httpStatus !== undefined) record.httpStatus = httpStatus;
    record.usage = usage;
    _buffer.push(record);
    appendLedgerLine(record);

    if (_buffer.length >= flushThreshold()) {
      // Fire-and-forget: a long-lived process (a librarian job, a batch backfill) drains periodically
      // instead of buffering every record for the life of the process. flush()'s own ddMetric calls
      // are already fail-open/logged-on-failure, so a rejection here is only possible from a bug in
      // this module itself -- still caught so it can never surface as an unhandled rejection in the
      // caller's process.
      flush().catch((e) => {
        try {
          console.error(`[openai-usage] threshold auto-flush failed (non-fatal): ${(e && e.message) || e}`);
        } catch {
          /* ignore */
        }
      });
    }
    installAutoFlushOnExit();
  } catch (e) {
    // Never let a bug in this module break the real OpenAI call site it is bolted onto.
    try {
      console.error(`[openai-usage] recordOpenAIUsage FAILED (non-fatal, this usage event was not recorded): ${(e && e.message) || e}`);
    } catch {
      /* ignore */
    }
  }
}

function usageCount(usage, keys) {
  for (const key of keys) {
    const value = usage?.[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  }
  return undefined;
}

function aggregate(records) {
  const byKey = new Map();
  for (const r of records) {
    const key = [r.provider, r.model || "", r.kind].join("\u0000");
    let agg = byKey.get(key);
    if (!agg) {
      agg = {
        tags: [`provider:${r.provider}`, `kind:${r.kind}`],
        tokensIn: 0,
        tokensOut: 0,
        hasTokensIn: false,
        hasTokensOut: false,
        requests: 0,
      };
      if (r.model) agg.tags.push(`model:${r.model}`);
      byKey.set(key, agg);
    }
    const tokensIn = usageCount(r.usage, ["prompt_tokens", "input_tokens"]);
    const tokensOut = usageCount(r.usage, ["completion_tokens", "output_tokens"]);
    if (tokensIn !== undefined) {
      agg.tokensIn += tokensIn;
      agg.hasTokensIn = true;
    }
    if (tokensOut !== undefined) {
      agg.tokensOut += tokensOut;
      agg.hasTokensOut = true;
    }
    agg.requests += 1;
  }
  return [...byKey.values()];
}

/**
 * flush() -> Promise<{ ok, flushed, failures }>
 * Drain everything currently buffered, aggregate it by provider/model/kind, and emit provider token
 * counts and response counts to Datadog as otc.fleet.openai.{tokens,requests}. Never throws (each ddMetric() call
 * already returns {ok,error} rather than rejecting; a genuinely unexpected throw is caught here too so
 * a caller that awaits flush() never needs its own try/catch). A failed emit is logged loudly (the
 * dd-emit.mjs convention this module reuses) and counted in the returned `failures`, but the buffered
 * records are still considered drained -- this module does not retry a failed flush indefinitely
 * against an unreachable Datadog; the local JSONL ledger (written synchronously by recordOpenAIUsage,
 * independent of this function) is the durable reconciliation path for that case.
 */
export async function flush() {
  if (_buffer.length === 0) return { ok: true, flushed: 0, failures: 0 };
  const batch = _buffer.splice(0, _buffer.length);
  const points = aggregate(batch);
  let failures = 0;
  for (const p of points) {
    const calls = [];
    if (p.hasTokensIn) calls.push(_ddMetricImpl("otc.fleet.openai.tokens", p.tokensIn, { tags: [...p.tags, "direction:input"], type: "count" }));
    if (p.hasTokensOut) calls.push(_ddMetricImpl("otc.fleet.openai.tokens", p.tokensOut, { tags: [...p.tags, "direction:output"], type: "count" }));
    calls.push(_ddMetricImpl("otc.fleet.openai.requests", p.requests, { tags: p.tags, type: "count" }));
    let results;
    try {
      results = await Promise.all(calls);
    } catch (e) {
      failures++;
      try {
        console.error(`[openai-usage] flush: unexpected error emitting a metric batch (non-fatal): ${(e && e.message) || e}`);
      } catch {
        /* ignore */
      }
      continue;
    }
    for (const r of results) {
      if (r && r.ok === false) {
        failures++;
        try {
          console.error(`[openai-usage] flush: Datadog emit FAILED (non-fatal, local ledger still has this record): ${r.error}`);
        } catch {
          /* ignore */
        }
      }
    }
  }
  return { ok: failures === 0, flushed: points.length, failures };
}

/**
 * installAutoFlushOnExit() -- idempotent. Registers a `process.once('beforeExit', ...)` that drains
 * any still-buffered records via flush(). Safe to call any number of times (only the first call
 * installs anything). Exported for an explicit CLI-script call site, but ALSO called internally by
 * recordOpenAIUsage() on every real (non-disabled) invocation -- see that function's own body. This
 * means a one-shot CLI script gets its final partial batch flushed automatically at process exit with
 * no per-file wiring required, while a test run with OPENAI_USAGE_DISABLE=1 never reaches this at all
 * (recordOpenAIUsage returns before calling it), so no test process ever schedules a real network call.
 */
export function installAutoFlushOnExit() {
  if (_autoFlushInstalled) return;
  _autoFlushInstalled = true;
  process.once("beforeExit", () => {
    flush().catch(() => {
      /* flush() itself never rejects in practice (see its own try/catch); this is belt-and-suspenders */
    });
  });
}

// ============================================================================================
// Test-only hooks. Mirrors skills/datadog/dd-emit.mjs's own _resetForTests/_setSecretGetterForTests
// convention: dependency-injection points, never used by production code.
// ============================================================================================
export function _resetForTests() {
  _buffer.length = 0;
  _ledgerDirOverride = null;
  _ddMetricImpl = _realDdMetric;
  // Deliberately NOT resetting _autoFlushInstalled here. In production this flag is a true
  // process-lifetime singleton (install the exit hook once, ever); a test suite that shares one
  // module instance across many tests (see openai-usage.test.mjs's header) and reset this on every
  // test would otherwise install a NEW `process.once('beforeExit', ...)` listener per test that calls
  // a real recordOpenAIUsage() -- accumulating dozens of listeners over a test file (tripping Node's
  // MaxListenersExceededWarning) instead of the single one a real process would ever install.
}
export function _setLedgerDirForTests(dir) {
  _ledgerDirOverride = dir || null;
}
export function _setDdMetricForTests(fn) {
  _ddMetricImpl = fn || _realDdMetric;
}
export function _bufferLengthForTests() {
  return _buffer.length;
}
export function _peekBufferForTests() {
  return _buffer.slice();
}

export default {
  PRICE_TABLE_VERSION,
  estimateCostUsd,
  recordOpenAIUsage,
  flush,
  installAutoFlushOnExit,
};
