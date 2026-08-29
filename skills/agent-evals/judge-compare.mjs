// judge-compare.mjs — PURE aggregation for run-evals.mjs's --judge-compare mode: given per-task
// results from TWO judges (the default OpenAI/Foundry judge and judge-bedrock-nova.mjs) scoring the
// SAME agent answer, compute an evidence-based agreement summary so the CTO can decide a judge swap on
// data rather than a guess. No network, no fs, no process.exit -- takes plain judge-result objects in,
// returns plain data out, so it is trivially unit-testable and safe to import anywhere.

/**
 * compareJudgeRow({ id, agent, a, b }, passAt?) -> one comparison row
 * `a`/`b` are {score, met, notes} results (the run-evals.mjs judge()/judgeBedrockNova() return shape)
 * from judge A and judge B scoring the SAME task+answer. `passAt` defaults to run-evals.mjs's own
 * PASS_AT (0.7) so a caller that does not pass it still gets the same pass/fail semantics as the real
 * eval gate.
 */
export function compareJudgeRow({ id, agent, a, b }, passAt = 0.7) {
  const scoreA = typeof a?.score === "number" ? a.score : 0;
  const scoreB = typeof b?.score === "number" ? b.score : 0;
  const scoreDelta = Math.abs(scoreA - scoreB);
  const passA = scoreA >= passAt;
  const passB = scoreB >= passAt;
  const verdictAgree = passA === passB;

  // Per-criterion agreement is only meaningful when both judges scored the SAME rubric (same length
  // `met` array) -- a mismatched length (a malformed judge response, or a future rubric change mid-run)
  // must not silently produce a misleading number, so it reports null (not 0, not a crash) and the
  // caller-facing render treats null distinctly from "0% agreement".
  let criterionAgreementRate = null;
  const metA = Array.isArray(a?.met) ? a.met : null;
  const metB = Array.isArray(b?.met) ? b.met : null;
  if (metA && metB && metA.length === metB.length && metA.length > 0) {
    const agreeCount = metA.filter((v, i) => Boolean(v) === Boolean(metB[i])).length;
    criterionAgreementRate = agreeCount / metA.length;
  }

  return { id, agent, scoreA, scoreB, scoreDelta, passA, passB, verdictAgree, criterionAgreementRate };
}

/**
 * aggregateJudgeComparison(rows) -> summary
 * rows: an array of compareJudgeRow() outputs. Pure reduction; returns null-safe fields for the n=0
 * case (no tasks compared) so a caller never divides by zero or renders NaN.
 */
export function aggregateJudgeComparison(rows) {
  const n = rows.length;
  const meanAbsDelta = n ? rows.reduce((s, r) => s + r.scoreDelta, 0) / n : null;
  const verdictAgreementRate = n ? rows.filter((r) => r.verdictAgree).length / n : null;
  const criterionRows = rows.filter((r) => r.criterionAgreementRate != null);
  const meanCriterionAgreement = criterionRows.length
    ? criterionRows.reduce((s, r) => s + r.criterionAgreementRate, 0) / criterionRows.length
    : null;
  const disagreements = rows.filter((r) => !r.verdictAgree).map((r) => `${r.agent}/${r.id}`);
  const maxDelta = n ? Math.max(...rows.map((r) => r.scoreDelta)) : null;
  return { n, meanAbsDelta, maxDelta, verdictAgreementRate, meanCriterionAgreement, disagreements };
}

/** Human-readable report for stdout. Pure string formatting; the CLI wiring in run-evals.mjs owns
 *  actually printing it and deciding whether to also write it to --json. */
export function renderJudgeComparisonReport(rows, summary, { labelA = "default", labelB = "bedrock-nova" } = {}) {
  const pct = (x, digits = 0) => (x == null ? "n/a" : `${(x * 100).toFixed(digits)}%`);
  const lines = [];
  lines.push(`# Judge comparison: ${labelA} vs ${labelB}  (n=${summary.n})`);
  lines.push("");
  for (const r of rows) {
    lines.push(
      `[${r.verdictAgree ? "AGREE   " : "DISAGREE"}] ${r.agent}/${r.id}  ${labelA}=${pct(r.scoreA)}  ${labelB}=${pct(r.scoreB)}  delta=${(r.scoreDelta * 100).toFixed(0)}pts` +
      (r.criterionAgreementRate != null ? `  per-criterion agreement=${pct(r.criterionAgreementRate)}` : "")
    );
  }
  lines.push("");
  lines.push(
    `SUMMARY: verdict agreement=${pct(summary.verdictAgreementRate)}, ` +
    `mean |score delta|=${summary.meanAbsDelta == null ? "n/a" : (summary.meanAbsDelta * 100).toFixed(1) + "pts"}, ` +
    `max |score delta|=${summary.maxDelta == null ? "n/a" : (summary.maxDelta * 100).toFixed(0) + "pts"}, ` +
    `mean per-criterion agreement=${pct(summary.meanCriterionAgreement)}`
  );
  if (summary.disagreements.length) lines.push(`DISAGREEMENTS (verdict flips): ${summary.disagreements.join(", ")}`);
  return lines.join("\n");
}

export default { compareJudgeRow, aggregateJudgeComparison, renderJudgeComparisonReport };
