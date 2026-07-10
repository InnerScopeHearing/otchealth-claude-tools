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

const MODEL_RANK = { haiku: 0, sonnet: 1, opus: 2 };
function higherOf(a, b) {
  const ra = MODEL_RANK[a] ?? 1, rb = MODEL_RANK[b] ?? 1;
  return ra >= rb ? a : b;
}

/**
 * classifyTaskWithHistory(text, hints?) -> { model, maxTokens, reason }
 *
 * Thin wrapper around classifyTask() that adds the ONE piece classifyTask cannot see on its own:
 * this callsite's OWN recent track record. classifyTask is pure text-classification (what does the
 * WORDING imply); this adds "but has this exact prompt surface actually been failing lately," which
 * is the missing half of a cost/quality router (per the FinOps research note: cascade routing needs
 * an escalation path on observed failure, not just a static text-based tier pick).
 *
 * hints (all optional, all just plain data the CALLER supplies — this function does no I/O, no
 * PostHog query, no network, same fail-open/pure discipline as compute-allocator/allocate.mjs):
 *   - priorFailureRate: number in [0,1], e.g. 1 - (passed/total) for this callsite_id from an
 *     agent-evals scorecard (run-evals.mjs --json output) or from eval-gate.mjs's baseline.json.
 *     >= FAIL_RATE_ESCALATE (default 0.4) escalates one tier above whatever classifyTask picked.
 *   - lastRunFailed: boolean, e.g. the most recent eval_result.pass for this callsite_id was false,
 *     or fleet-telemetry's own agent_session.outcome was "had_tool_errors". Also escalates one tier,
 *     independent of priorFailureRate (a single recent failure is worth acting on even if the
 *     rolling rate is still fine) — this is the same "escalate on prior failure" a RouteLLM/FrugalGPT
 *     cascade needs: try cheap, on failure retry with a stronger model, remember that for next time.
 *   - failRateThreshold: override for the 0.4 default.
 * All are optional; passing neither returns exactly what classifyTask(text, hints) would return
 * (this function is a strict superset, never a behavior change when history is absent/unknown).
 *
 * Escalation NEVER downgrades (an inferred haiku task with a bad history goes to sonnet, not lower);
 * it also composes with `forceModel`/DEEP_SIGNALS/QUALITY_SIGNALS exactly as classifyTask itself does
 * (escalating opus stays opus). This keeps the function a single small step up from classifyTask
 * rather than a second competing classifier.
 */
export function classifyTaskWithHistory(text, hints = {}) {
  const base = classifyTask(text, hints);
  if (hints.forceModel) return base; // explicit override always wins, no history second-guessing.

  const threshold = Number.isFinite(hints.failRateThreshold) ? hints.failRateThreshold : 0.4;
  const badRate = Number.isFinite(hints.priorFailureRate) && hints.priorFailureRate >= threshold;
  const badLast = hints.lastRunFailed === true;

  if (!badRate && !badLast) return base;

  const escalated = base.model === "opus" ? "opus" : base.model === "sonnet" ? "opus" : "sonnet";
  const model = higherOf(base.model, escalated);
  if (model === base.model) return base; // already at/above the escalation target, nothing to add.

  const why = badRate && badLast
    ? `prior failure rate ${hints.priorFailureRate.toFixed(2)} >= ${threshold} AND last run failed`
    : badRate
    ? `prior failure rate ${hints.priorFailureRate.toFixed(2)} >= ${threshold}`
    : "last run at this callsite failed";
  return { model, maxTokens: Math.max(base.maxTokens, 8000), reason: `${base.reason}; escalated ${base.model} -> ${model} (${why})` };
}

export { PRICE };

// ---------------------------------------------------------------------------
// Self-test / example invocations. No network, no LLM calls, no live PostHog query — just the pure
// decision logic above, run against a few illustrative (task, history) pairs so the escalation
// behavior is visible without needing to wire a real eval-gate scorecard first.
//   node skills/fleet-telemetry/task-router.mjs --test
// ---------------------------------------------------------------------------
function runSelfTest() {
  const cases = [
    {
      label: "mechanical+short, clean history -> stays haiku (no escalation when history is fine)",
      text: "list the files in the skills directory",
      hints: { priorFailureRate: 0.05, lastRunFailed: false },
      expect: "haiku",
    },
    {
      label: "mechanical+short, BAD prior failure rate -> escalates haiku to sonnet",
      text: "list the files in the skills directory",
      hints: { priorFailureRate: 0.6 },
      expect: "sonnet",
    },
    {
      label: "mechanical+short, last run failed (rate unknown) -> escalates haiku to sonnet",
      text: "extract the title field from this record",
      hints: { lastRunFailed: true },
      expect: "sonnet",
    },
    {
      label: "default sonnet task, BAD history -> escalates sonnet to opus",
      text: "do the thing we discussed",
      hints: { priorFailureRate: 0.5 },
      expect: "opus",
    },
    {
      label: "deep-reasoning task already at opus, BAD history -> stays opus (never above ceiling)",
      text: "reverse-engineer the competitor architecture and prove the bound",
      hints: { priorFailureRate: 0.9, lastRunFailed: true },
      expect: "opus",
    },
    {
      label: "forceModel always wins, even with a terrible history",
      text: "list the files",
      hints: { forceModel: "haiku", priorFailureRate: 0.99, lastRunFailed: true },
      expect: "haiku",
    },
    {
      label: "no history supplied -> identical to classifyTask (strict superset, no behavior change)",
      text: "compare Postgres vs DynamoDB for the ledger",
      hints: {},
      expect: classifyTask("compare Postgres vs DynamoDB for the ledger", {}).model,
    },
  ];

  let pass = 0;
  for (const c of cases) {
    const r = classifyTaskWithHistory(c.text, c.hints);
    const ok = r.model === c.expect;
    pass += ok ? 1 : 0;
    console.log(`${ok ? "PASS" : "FAIL"}  ${c.label}`);
    console.log(`      -> model=${r.model} reason="${r.reason}"`);
  }
  console.log(`\n${pass}/${cases.length} self-test cases passed.`);
  if (pass !== cases.length) process.exit(1);
}

const __isMain = (() => {
  try { return process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]; } catch { return false; }
})();
if (__isMain && process.argv.includes("--test")) runSelfTest();
