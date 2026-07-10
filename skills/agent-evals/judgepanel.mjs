// judgepanel.mjs - north-star self-improving-loop wave, ITEM B: MULTI-JUDGE PANEL + CALIBRATION on
// top of the already-shipped prompt-regression gate (skills/agent-evals/promptcheck.mjs +
// skills/agent-evals/run-evals.mjs). Single-judge scoring (run-evals.mjs's judge()) is a single point
// of failure: one model's idiosyncrasies (harsh, lenient, or just wrong on one criterion) become the
// gate's only signal. This module adds a small panel of 2-3 judges drawn from the fleet's
// setup/model-routing.mjs tiers, aggregates their scores into one more-robust panel_score, reports
// panel AGREEMENT (how much the judges agreed) as a first-class confidence signal, and calibrates that
// panel_score against a human-labeled golden set (skills/agent-evals/golden-set.json) so the reported
// score tracks what a human would actually say, not just what the models say about each other.
//
// REPORT-ONLY / ADDITIVE BY DESIGN, matching the rest of the north-star self-improving-loop wave:
//   - This module NEVER blocks CI. It has no exit-code-affecting side effect of its own; run-evals.mjs's
//     existing pass/fail gate (PASS_AT threshold on the single judge score) is UNCHANGED. The panel
//     result is an ADVISORY field a caller may add to the scorecard (see attachPanelToResult()) or print
//     in a PR comment; it is never wired to `process.exit`.
//   - No new external service. Judges are additional calls to the SAME Azure OpenAI/Foundry chat
//     endpoint run-evals.mjs already calls, just at different model-routing tiers. No new store, no
//     ledger write (this module performs NO I/O of its own beyond the injectable callModel it is given).
//   - No hardcoded model ids. Judge tiers are resolved via setup/model-routing.mjs's TIERS /
//     resolveTier(); callers pick which tiers form the panel (default panel below), never a literal
//     deployment string.
//
// ARCHITECTURE: a PURE core (this file, no network, no fs, no process.exit) + a thin IO shell the
// caller supplies. Every exported function takes plain data in and returns plain data out, so the
// whole aggregation + calibration pipeline is unit-testable with node:test and zero mocks beyond a
// fake callModel function.
//
// PIPELINE:
//   runJudgePanel(judgeFn, task, rubric, answer, { tiers })  - IO shim: calls judgeFn once per tier,
//     tolerating a single judge's failure (drops it, does not throw), returns raw per-judge results.
//   aggregatePanel(judgeResults)                              - PURE: turns [{tier, score, met}, ...]
//     into { panel_score, agreement, judges }. panel_score = mean of per-judge scores (a judge that
//     errored or returned NaN is excluded, not scored as 0 - a transient parse failure should not drag
//     the mean down; if it should count as evidence of a bad answer, the judge's own score already
//     reflects that). agreement = 1 - normalized spread (stdev relative to the 0..1 score range),
//     clamped to [0,1]. A single surviving judge is a degenerate panel: agreement is reported as null
//     (not 1) so callers can tell "judges agreed" apart from "we only heard from one judge".
//   confidenceLabel(agreement, nJudges)                        - PURE: maps agreement (+ judge count)
//     to a human label ("high" / "medium" / "low" / "unscored") for the PR-comment / scorecard field.
//   calibrate(panelScore, calibration)                         - PURE: applies a calibration curve
//     (built from the golden set) to a raw panel_score, producing a `calibrated_score`. Calibration is
//     a monotone piecewise-linear map fit from (panel_score, human_score) pairs via buildCalibration();
//     with no golden-set data it is the identity map (so calibrate() is always safe to call).
//   buildCalibration(goldenPairs)                              - PURE: fits the piecewise-linear
//     calibration curve from golden-set pairs [{panel_score, human_score}, ...]. Sorts by panel_score,
//     de-duplicates, and stores calibration error stats (MAE) so a caller can report how trustworthy
//     the calibration itself is.
//   attachPanelToResult(result, panel)                         - PURE: merges panel fields onto an
//     existing run-evals.mjs result row WITHOUT touching its `score`/`pass` fields (those remain
//     whatever the single-judge gate already computed) - purely additive: `panel_score`,
//     `calibrated_score`, `agreement`, `confidence`, `judge_tiers`.
//
// Non-PHI ring: operates only on the same non-PHI golden-task surfaces the gate already covers. No
// MedReview, no INND/Xero/Plaid, no clo-personal. No dashes other than plain hyphens are used in any
// generated text (fleet convention: no em/en dashes).

import { TIERS } from "../../setup/model-routing.mjs";

// Default panel: 3 tiers spanning the fleet's quality ladder. 'cheap' (gpt-4.1-mini) is BANNED for
// quality SYNTHESIS work (see model-routing.mjs), but a judge only classifies pass/fail per rubric
// criterion (closer to extraction/classification than synthesis), and INCLUDING a cheap, fast judge
// alongside two stronger ones is exactly what makes a panel useful: it surfaces disagreement between a
// cheap judge and quality judges rather than hiding it. Callers may override via the `tiers` option.
export const DEFAULT_PANEL_TIERS = ["quality", "standard", "cheap"];

/**
 * Resolve a list of tier names (or explicit deployment strings) to their model-routing descriptors.
 * Pure passthrough over model-routing's TIERS map; never invents a deployment id.
 */
export function resolvePanelTiers(tierNames = DEFAULT_PANEL_TIERS) {
  return tierNames.map((name) => {
    const known = TIERS[name];
    return known ? { tier: name, deployment: known.deployment } : { tier: name, deployment: name };
  });
}

/**
 * IO shim: run a panel of judges over one task/rubric/answer. `judgeFn(tier, task, rubric, answer)`
 * is caller-supplied (in run-evals.mjs this wraps its existing judge()/chat() against a specific
 * model-routing tier); this function itself does no network I/O, only orchestration + fault-tolerance.
 * A judge that throws or returns a non-finite score is dropped from the panel (logged via `onError`,
 * if supplied) rather than failing the whole panel - one flaky judge should not take down the signal.
 * Returns the raw per-judge rows; call aggregatePanel() on the result for the pure summary.
 */
export async function runJudgePanel(judgeFn, task, rubric, answer, { tiers = DEFAULT_PANEL_TIERS, onError } = {}) {
  const panelTiers = resolvePanelTiers(tiers);
  const settled = await Promise.allSettled(panelTiers.map((t) => judgeFn(t.tier, task, rubric, answer)));
  const rows = [];
  settled.forEach((res, i) => {
    const { tier, deployment } = panelTiers[i];
    if (res.status === "fulfilled" && res.value && Number.isFinite(res.value.score)) {
      rows.push({ tier, deployment, score: res.value.score, met: res.value.met || null, notes: res.value.notes || "" });
    } else {
      const reason = res.status === "rejected" ? res.reason?.message || String(res.reason) : "invalid judge result (non-finite score)";
      if (onError) onError(tier, reason);
      rows.push({ tier, deployment, score: null, met: null, notes: "", error: reason });
    }
  });
  return rows;
}

function mean(nums) { return nums.reduce((s, n) => s + n, 0) / nums.length; }
function stdev(nums) {
  if (nums.length < 2) return 0;
  const m = mean(nums);
  return Math.sqrt(mean(nums.map((n) => (n - m) ** 2)));
}

/**
 * PURE: aggregate raw per-judge rows (as produced by runJudgePanel, or built by hand in tests) into
 * one panel summary. Judges with a null/non-finite score (errored) are excluded from the mean and the
 * agreement computation, but are still counted in `judges` / `n_judges_attempted` so a caller can see
 * a judge dropped out. Scores are expected in [0, 1] (run-evals.mjs's judge() convention).
 *
 * agreement: 1 - (stdev of surviving scores / MAX_SPREAD), clamped to [0, 1], where MAX_SPREAD = 0.5 is
 * the largest stdev two extreme scores (0 and 1) can produce for a two-point panel - using a fixed
 * denominator (rather than the observed range) keeps agreement comparable across panels of different
 * size. agreement is null when fewer than 2 judges survived (nothing to agree ON).
 */
export function aggregatePanel(judgeRows) {
  const attempted = judgeRows.length;
  const surviving = judgeRows.filter((r) => Number.isFinite(r.score));
  const scores = surviving.map((r) => r.score);
  const panel_score = scores.length ? mean(scores) : null;
  const MAX_SPREAD = 0.5;
  const agreement = scores.length >= 2 ? Math.max(0, Math.min(1, 1 - stdev(scores) / MAX_SPREAD)) : null;
  return {
    panel_score,
    agreement,
    n_judges_attempted: attempted,
    n_judges_surviving: scores.length,
    judges: judgeRows,
  };
}

/**
 * PURE: map an agreement value (+ how many judges actually scored) to a human-facing confidence label.
 * "unscored" when no judge survived (panel_score is null). "low" whenever fewer than 2 judges survived
 * even if the lone score looks fine - a single opinion is never "high confidence" by definition of a
 * panel. Otherwise: >=0.8 high, >=0.5 medium, else low. Thresholds are deliberately coarse (a
 * PR-comment label, not a precision metric); callers needing the raw number should read `agreement`.
 */
export function confidenceLabel(agreement, nJudgesSurviving) {
  if (agreement === null || nJudgesSurviving == null) return nJudgesSurviving === 0 ? "unscored" : "low";
  if (nJudgesSurviving < 2) return "low";
  if (agreement >= 0.8) return "high";
  if (agreement >= 0.5) return "medium";
  return "low";
}

/**
 * PURE: fit a monotone piecewise-linear calibration curve from human-labeled golden pairs
 * [{panel_score, human_score}, ...] (both in [0, 1]). This is deliberately simple (no external ML
 * dependency, matching the toolkit's dependency-free-Node convention): sort by panel_score, average
 * human_score for duplicate/near-duplicate panel_score buckets, and enforce monotonicity by a running
 * max so the fitted curve never decreases as panel_score increases (a calibration curve that says "a
 * higher raw score maps to a lower calibrated score" would be worse than not calibrating at all).
 * Anchors the curve at (0,0) and (1,1) so calibrate() always has endpoints to interpolate between, even
 * with sparse golden data. Returns { points: [{x,y}, ...], mae, n } where mae is the mean absolute
 * calibration error (|predicted - human| under leave-one-in fit, a caller-facing trust signal for the
 * calibration itself) and n is the number of golden pairs used. With zero pairs, returns the identity
 * curve (points: [{x:0,y:0},{x:1,y:1}], mae: null, n: 0) so calibrate() is always safe to call.
 */
export function buildCalibration(goldenPairs = []) {
  const valid = goldenPairs.filter((p) => Number.isFinite(p.panel_score) && Number.isFinite(p.human_score));
  if (!valid.length) return { points: [{ x: 0, y: 0 }, { x: 1, y: 1 }], mae: null, n: 0 };

  // Bucket by panel_score (rounded to avoid float-noise duplicates), average human_score per bucket.
  const buckets = new Map();
  for (const p of valid) {
    const x = Math.round(p.panel_score * 1000) / 1000;
    if (!buckets.has(x)) buckets.set(x, []);
    buckets.get(x).push(p.human_score);
  }
  const sortedX = [...buckets.keys()].sort((a, b) => a - b);
  let points = sortedX.map((x) => ({ x, y: mean(buckets.get(x)) }));

  // Enforce monotone non-decreasing y via running max (isotonic-regression-lite).
  let runningMax = -Infinity;
  points = points.map((p) => { runningMax = Math.max(runningMax, p.y); return { x: p.x, y: runningMax }; });

  // Anchor endpoints so interpolation is always defined over the full [0,1] domain.
  if (points[0].x > 0) points = [{ x: 0, y: 0 }, ...points];
  if (points[points.length - 1].x < 1) points = [...points, { x: 1, y: Math.max(points[points.length - 1].y, points[points.length - 1].y) }];
  // If the anchored top point would violate monotonicity (e.g. last real point y > 1), clamp to 1.
  points = points.map((p) => ({ x: p.x, y: Math.min(1, Math.max(0, p.y)) }));

  const fitted = { points, mae: null, n: valid.length };
  const errs = valid.map((p) => Math.abs(calibrate(p.panel_score, fitted) - p.human_score));
  fitted.mae = mean(errs);
  return fitted;
}

/**
 * PURE: apply a calibration curve (as built by buildCalibration) to a single raw panel_score, via
 * linear interpolation between the two bracketing points. Returns the raw score unchanged when
 * calibration is missing/empty or panelScore is not a finite number (never throws on bad input, since
 * this sits on the report-only advisory path, never a gate).
 */
export function calibrate(panelScore, calibration) {
  if (!Number.isFinite(panelScore)) return panelScore;
  const points = calibration?.points;
  if (!points || points.length < 2) return panelScore;
  const x = Math.max(0, Math.min(1, panelScore));
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1];
    if (x >= a.x && x <= b.x) {
      if (b.x === a.x) return a.y;
      const t = (x - a.x) / (b.x - a.x);
      return a.y + t * (b.y - a.y);
    }
  }
  return points[points.length - 1].y;
}

/**
 * PURE: merge panel + calibration fields onto an existing run-evals.mjs result row. Additive only -
 * never overwrites `score`/`pass` (the single-judge gate's own verdict, unchanged) or any other
 * existing field. `panel` is an aggregatePanel() output; `calibration` is an optional buildCalibration()
 * output (identity used when omitted).
 */
export function attachPanelToResult(result, panel, calibration) {
  const cal = calibration || { points: [{ x: 0, y: 0 }, { x: 1, y: 1 }], mae: null, n: 0 };
  const calibrated_score = panel.panel_score === null ? null : calibrate(panel.panel_score, cal);
  return {
    ...result,
    panel_score: panel.panel_score,
    calibrated_score,
    agreement: panel.agreement,
    confidence: confidenceLabel(panel.agreement, panel.n_judges_surviving),
    judge_tiers: panel.judges.map((j) => j.tier),
    n_judges_surviving: panel.n_judges_surviving,
    calibration_n: cal.n,
    calibration_mae: cal.mae,
  };
}

export default {
  DEFAULT_PANEL_TIERS,
  resolvePanelTiers,
  runJudgePanel,
  aggregatePanel,
  confidenceLabel,
  buildCalibration,
  calibrate,
  attachPanelToResult,
};
