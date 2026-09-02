// openai-usage.mjs — the ONE place that turns a real OpenAI API response into fleet cost visibility.
//
// WHY THIS EXISTS: the fleet spends real money on OpenAI (chat via the gpt-4o/gpt-4.1/gpt-5.x
// families, text-embedding-3-large for the brain, gpt-image-* for designer output) and has ZERO
// provider-side visibility into it. The only credential is a project key (sk-proj-...); the OpenAI
// Admin/Usage APIs 403 on a project key (no api.usage.read scope) and the legacy GET /v1/usage
// endpoint returns empty data for project keys (verified live, 6 dates, all empty). There is no
// admin key anywhere in the vault, and getting one is a Matt-gated account action, not a code fix.
//
// So this measures at the SOURCE instead of the provider: every OpenAI response carries a `usage`
// object (prompt/completion/total tokens for chat and embeddings; a costUsdOverride path for
// per-image/per-second products that bill outside the token model). Call recordOpenAIUsage() once per
// real network response, from inside the code that already has that response in hand. This module
// turns that into Datadog metrics (otc.fleet.openai.*) plus a local JSONL ledger, so a session is
// reconcilable even when Datadog itself is unreachable.
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
//   3. estimateCostUsd() is a DOCUMENTED ESTIMATE, not a provider-reconciled figure -- see
//      docs/OPENAI-COST-VISIBILITY.md for what this can and cannot prove.
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
// Price table (USD per 1,000,000 tokens unless noted). Snapshot as of PRICE_TABLE_VERSION --
// OpenAI revises pricing without notice, so treat this as a planning estimate and reconcile it
// against https://openai.com/api/pricing/ periodically (see docs/OPENAI-COST-VISIBILITY.md).
//
// Deliberately does NOT try to price every model id the fleet might resolve to. In particular the
// fleet's own OPENAI_TIERS (setup/model-routing.mjs) moved to the gpt-5.6-luna/-sol/-terra family on
// 2026-08-29 with no published per-model pricing available at the time this table was written --
// rather than guess a number and assert it with false confidence, those (and any other unrecognized
// model id) fall through to the UNKNOWN_MODEL bucket below: priced at the MOST EXPENSIVE family this
// table DOES know (so real spend is never under-counted) and tagged unknown:true (so a dashboard can
// tell "confident" apart from "conservative guess" at a glance).
// ============================================================================================
export const PRICE_TABLE_VERSION = "2026-09-02";

// Ordered rules, first regex match wins. `re` matches a bare model id or one with an OpenAI-style
// dated snapshot suffix (e.g. "gpt-4o-2024-08-06"); it does NOT loosely prefix-match, so a genuinely
// different/newer model (gpt-4.15, gpt-4o-turbo, gpt-5.6-luna, ...) falls through to UNKNOWN_MODEL_CHAT
// instead of silently absorbing a family's pricing it was never confirmed to share.
const CHAT_PRICES = [
  { re: /^gpt-4o-mini(-\d{4}-\d{2}-\d{2})?$/i, input: 0.15, output: 0.6, cachedInput: 0.075 },
  { re: /^gpt-4o(-\d{4}-\d{2}-\d{2})?$/i, input: 2.5, output: 10.0, cachedInput: 1.25 },
  { re: /^gpt-4\.1-nano(-\d{4}-\d{2}-\d{2})?$/i, input: 0.1, output: 0.4, cachedInput: 0.025 },
  { re: /^gpt-4\.1-mini(-\d{4}-\d{2}-\d{2})?$/i, input: 0.4, output: 1.6, cachedInput: 0.1 },
  { re: /^gpt-4\.1(-\d{4}-\d{2}-\d{2})?$/i, input: 2.0, output: 8.0, cachedInput: 0.5 },
  { re: /^gpt-3\.5-turbo(-\d{4})?$/i, input: 0.5, output: 1.5, cachedInput: 0.25 },
];

const EMBEDDING_PRICES = [
  { re: /^text-embedding-3-large$/i, input: 0.13 },
  { re: /^text-embedding-3-small$/i, input: 0.02 },
  { re: /^text-embedding-ada-002$/i, input: 0.1 },
];

// gpt-image-1 is genuinely token-billed (text + image input/output tokens), but every current caller
// in this fleet reports a flat, size/quality-derived per-call dollar figure it already computed itself
// (skills/designer/scripts/_lib.mjs's reportCost -> costUsdOverride below), so this flat fallback is
// used ONLY when a kind:'image' record arrives with no override -- a coarse, clearly-labeled guess,
// not a reconciled price. Matches the designer skill's own long-standing $0.04 "1024x1024 high"
// estimate (gen-app-icon-family.mjs) so the two numbers do not quietly disagree.
const IMAGE_FLAT_FALLBACK_USD = 0.04;
const KNOWN_IMAGE_MODEL_RE = /^gpt-image(-1)?(-mini)?$/i;

const MOST_EXPENSIVE_CHAT = CHAT_PRICES.reduce((a, b) => (b.output > a.output ? b : a));
const MOST_EXPENSIVE_EMBEDDING = EMBEDDING_PRICES.reduce((a, b) => (b.input > a.input ? b : a));

function matchChatPrice(model) {
  const m = String(model || "");
  for (const p of CHAT_PRICES) if (p.re.test(m)) return { input: p.input, output: p.output, cachedInput: p.cachedInput, unknown: false };
  return { input: MOST_EXPENSIVE_CHAT.input, output: MOST_EXPENSIVE_CHAT.output, cachedInput: MOST_EXPENSIVE_CHAT.cachedInput, unknown: true };
}

function matchEmbeddingPrice(model) {
  const m = String(model || "");
  for (const p of EMBEDDING_PRICES) if (p.re.test(m)) return { input: p.input, unknown: false };
  return { input: MOST_EXPENSIVE_EMBEDDING.input, unknown: true };
}

/** PURE. Estimate USD cost for one usage record. Never called when the caller already supplies
 *  costUsdOverride (recordOpenAIUsage short-circuits before this). Exported for direct unit testing. */
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
  // 'chat' and 'other' (moderation, unclassified) priced as chat-shaped token usage.
  const price = matchChatPrice(model);
  const pt = Math.max(0, promptTokens);
  const cached = Math.max(0, Math.min(cachedTokens, pt));
  const fresh = Math.max(0, pt - cached);
  const inputCost = (fresh / 1e6) * price.input + (cached / 1e6) * (price.cachedInput ?? price.input);
  const outputCost = (Math.max(0, completionTokens) / 1e6) * price.output;
  return { costUsd: inputCost + outputCost, unknown: price.unknown };
}

// ============================================================================================
// Local JSONL ledger -- so a session's real OpenAI spend is reconstructable even when Datadog is
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
const VALID_KINDS = new Set(["chat", "embedding", "image", "other"]);
const _buffer = [];
let _ddMetricImpl = _realDdMetric;
let _autoFlushInstalled = false;

function flushThreshold() {
  const n = Math.floor(Number(process.env.OPENAI_USAGE_FLUSH_THRESHOLD));
  return Number.isFinite(n) && n > 0 ? n : 200;
}

/**
 * recordOpenAIUsage({ model, kind, promptTokens, completionTokens, cachedTokens, images, caller,
 *                      repo, costUsdOverride })
 * Record ONE real OpenAI API response. Call this once per successful HTTP response, from inside the
 * code that already parsed that response's `usage` object (or, for a per-image/per-second product
 * with no token-shaped usage, pass costUsdOverride with a figure the caller already computed).
 *
 * - model:            the model/deployment name actually used (falls back to "unknown").
 * - kind:             'chat' | 'embedding' | 'image' | 'other' (falls back to 'other').
 * - promptTokens:     input/prompt tokens (chat), or total input tokens (embedding). Default 0.
 * - completionTokens: output/completion tokens (chat only). Default 0.
 * - cachedTokens:     prompt tokens served from OpenAI's prompt cache, if usage.prompt_tokens_details
 *                      .cached_tokens was present. Priced at the cheaper cached-input rate when known.
 * - images:           count of images generated (kind:'image'). Default 0 (treated as 1 for pricing).
 * - caller:           the skill/script recording this (falls back to "unknown"). Free text, becomes a
 *                      Datadog tag -- keep it a short, stable slug (e.g. "company-brain", "doc-indexer-
 *                      enrich"), not a full sentence.
 * - repo:             defaults to "otchealth-claude-tools" (this repo). Present for callers that want
 *                      to override it and for parity with the gateway's own separate implementation.
 * - costUsdOverride:  when the caller already knows the exact billed cost (e.g. designer's per-image
 *                      cost table), pass it here instead of letting this module re-derive one. Wins
 *                      outright over the price-table estimate; also implies unknown:false.
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
    const { model, kind = "other", promptTokens = 0, completionTokens = 0, cachedTokens = 0, images = 0, caller = "unknown", repo = "otchealth-claude-tools", costUsdOverride } = opts || {};
    const safeModel = String(model || "unknown").trim() || "unknown";
    const safeKind = VALID_KINDS.has(kind) ? kind : "other";
    const safeCaller = String(caller || "unknown").trim() || "unknown";
    const safeRepo = String(repo || "otchealth-claude-tools").trim() || "otchealth-claude-tools";
    const pt = Math.max(0, Number(promptTokens) || 0);
    const ct = Math.max(0, Number(completionTokens) || 0);
    const cachedT = Math.max(0, Math.min(Number(cachedTokens) || 0, pt));
    const imgs = Math.max(0, Number(images) || 0);

    let costUsd, unknown;
    if (typeof costUsdOverride === "number" && Number.isFinite(costUsdOverride)) {
      costUsd = Math.max(0, costUsdOverride);
      unknown = false;
    } else {
      const est = estimateCostUsd({ model: safeModel, kind: safeKind, promptTokens: pt, completionTokens: ct, cachedTokens: cachedT, images: imgs });
      costUsd = est.costUsd;
      unknown = est.unknown;
    }

    const record = {
      ts: new Date().toISOString(),
      model: safeModel,
      kind: safeKind,
      caller: safeCaller,
      repo: safeRepo,
      promptTokens: pt,
      completionTokens: ct,
      cachedTokens: cachedT,
      images: imgs,
      costUsd,
      unknown,
    };
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

function aggregate(records) {
  const byKey = new Map();
  for (const r of records) {
    const key = [r.model, r.kind, r.caller, r.repo, r.unknown ? "1" : "0"].join("\u0000"); // NUL-separated: a bare concatenation could alias fields (model "a"+kind "bc" vs "ab"+"c")
    let agg = byKey.get(key);
    if (!agg) {
      agg = {
        tags: [`model:${r.model}`, `kind:${r.kind}`, `caller:${r.caller}`, `repo:${r.repo}`, `unknown:${r.unknown}`],
        tokensIn: 0,
        tokensOut: 0,
        requests: 0,
        costUsd: 0,
      };
      byKey.set(key, agg);
    }
    agg.tokensIn += r.promptTokens;
    agg.tokensOut += r.completionTokens;
    agg.requests += 1;
    agg.costUsd += r.costUsd;
  }
  return [...byKey.values()];
}

/**
 * flush() -> Promise<{ ok, flushed, failures }>
 * Drain everything currently buffered, aggregate it by (model, kind, caller, repo, unknown), and emit
 * it to Datadog as otc.fleet.openai.{tokens,requests,cost_usd_est}. Never throws (each ddMetric() call
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
    if (p.tokensIn > 0) calls.push(_ddMetricImpl("otc.fleet.openai.tokens", p.tokensIn, { tags: [...p.tags, "direction:input"], type: "count" }));
    if (p.tokensOut > 0) calls.push(_ddMetricImpl("otc.fleet.openai.tokens", p.tokensOut, { tags: [...p.tags, "direction:output"], type: "count" }));
    calls.push(_ddMetricImpl("otc.fleet.openai.requests", p.requests, { tags: p.tags, type: "count" }));
    calls.push(_ddMetricImpl("otc.fleet.openai.cost_usd_est", p.costUsd, { tags: p.tags, type: "count" }));
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
