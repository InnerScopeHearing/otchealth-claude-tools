// fleet-telemetry / task-router.mjs, pure dependency-free task -> model/budget classifier.
//
// The fleet defaults every Claude subagent to Sonnet. That is right for judgment work but 3.75x-4x
// too expensive for genuinely mechanical fan-out (file listing, single-field extraction, strict-format
// transforms), and it under-powers the rare task that truly needs Opus-grade reasoning. This is a
// QUALITY-GATED recommender: signals that imply real judgment (synthesis, architecture, security,
// PHI/securities, money-logic) always keep Sonnet or higher; only clearly trivial/bulk/short tasks
// are recommended down to Haiku. Advisory only, the orchestrator makes the final call.
//
// Pure + IO-free so it is trivially testable and safe to import anywhere.

// $/Mtok [input, output, cache-write, cache-read] - mirrors fleet-telemetry/telemetry.mjs PRICE.
const PRICE = { opus: [15, 75, 18.75, 1.5], sonnet: [3, 15, 3.75, 0.3], haiku: [0.8, 4, 1.0, 0.08] };

// Signals that must NEVER be downgraded below Sonnet (real judgment / high stakes).
const QUALITY_SIGNALS = /\b(synthes|analy[sz]|architect|design|strateg|decision|trade.?off|review|audit|verify|reason|plan|security|secure|threat|inject|vulnerab|phi|hipaa|securities|mnpi|reg\s*fd|clinical|fda|money|payment|refund|migrat|schema|legal|complianc|judg|evaluat)\b/i;
// Signals that a task needs Opus-grade deep reasoning.
const DEEP_SIGNALS = /\b(prove|derive|multi.?step reasoning|deep(ly)? reason|complex trade.?off|novel|research the best|reverse.?engineer|red.?team|orchestrat|root.?cause)\b/i;
// Signals of genuinely mechanical/bulk work safe to route to Haiku.
const MECHANICAL_SIGNALS = /\b(list|enumerate|extract|grep|find|count|rename|reformat|convert|transform|parse|dedupe|sort|split|join|lookup|fetch the|copy|strip|lowercase|uppercase|boilerplate)\b/i;

/**
 * classifyTask(text, hints?) -> { model, maxTokens, reason }
 * hints: { fanout?:number (parallel siblings), lengthChars?:number, forceModel?:string }
 * Quality gate wins over the cheap path; deep-reasoning gate wins over everything.
 */
export function classifyTask(text, hints = {}) {
  const t = String(text || "");
  if (hints.forceModel) return { model: hints.forceModel, maxTokens: hints.maxTokens || 8000, reason: "forced by caller" };

  if (DEEP_SIGNALS.test(t)) return { model: "opus", maxTokens: 16000, reason: "deep-reasoning signal" };
  if (QUALITY_SIGNALS.test(t)) return { model: "sonnet", maxTokens: 8000, reason: "judgment/high-stakes signal, held at Sonnet+" };

  const short = (hints.lengthChars ?? t.length) < 600;
  const bulk = (hints.fanout ?? 1) >= 5;
  if (MECHANICAL_SIGNALS.test(t) && (short || bulk)) {
    return { model: "haiku", maxTokens: 2000, reason: bulk ? "mechanical + high-fanout" : "mechanical + short" };
  }
  // Default stays Sonnet: when unsure, do not sacrifice quality to save pennies.
  return { model: "sonnet", maxTokens: 8000, reason: "default (no clear downgrade signal)" };
}

/**
 * estimateSavings(fromModel, toModel, inTok, outTok) -> { fromUsd, toUsd, savedUsd, savedPct }
 * Rough per-call cost delta using the shared PRICE table (input+output only).
 */
export function estimateSavings(fromModel, toModel, inTok = 0, outTok = 0) {
  const p = (m) => PRICE[Object.keys(PRICE).find((k) => (m || "").toLowerCase().includes(k)) || "sonnet"];
  const cost = (m) => (inTok / 1e6) * p(m)[0] + (outTok / 1e6) * p(m)[1];
  const fromUsd = cost(fromModel), toUsd = cost(toModel);
  const savedUsd = fromUsd - toUsd;
  return { fromUsd, toUsd, savedUsd, savedPct: fromUsd > 0 ? (savedUsd / fromUsd) * 100 : 0 };
}

export { PRICE };
