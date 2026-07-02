#!/usr/bin/env node
// eval-gate.mjs — CI eval-gate for deploys (Azure GenAIOps pattern #4/#31: "the eval baseline gates
// the deploy, not just observes it"). REPORT-FIRST with a clear path to ENFORCE.
//
// WHY a separate module from nightly-summary.mjs: nightly-summary applies a fixed FLOOR (report-only,
// human-facing) to a single scorecard. eval-gate compares a fresh scorecard against the last recorded
// BASELINE (the previous accepted scorecard's avg, persisted in baseline.json by the nightly job) and
// flags a REGRESSION when the new avg drops more than a tolerance below that baseline. That is the
// actual "does this deploy make quality worse" question, not "is quality above some arbitrary floor".
//
// Two independently useful primitives, reused by both:
//   compareToBaseline(scorecard, baseline, opts) -> pure, unit-testable, no I/O.
//   CLI: node eval-gate.mjs <scorecard.json> --baseline baseline.json [--tolerance 0.05] [--enforce]
//     - default (report-only): always exits 0, prints ::warning:: + step summary on regression.
//     - --enforce: exits 1 on regression (the future hard gate a deploy workflow can require).
//
// Baseline lifecycle (mirrors nightly-eval.yml): the nightly job runs the golden-task suite, and
// (in a FOLLOW-UP, not this PR) can write scorecard.avg/passed/total to baseline.json and open a
// small PR to update it — the same "durable trend as source of truth" idea PostHog already gives us,
// just also captured as a repo-tracked file so a deploy-time job can read it without hitting PostHog.
// Until that follow-up lands, baseline.json ships with a conservative seed value (see baseline.json)
// and this script degrades cleanly (treats a missing/unreadable baseline as "no gate", never throws).

/**
 * compareToBaseline(scorecard, baseline, opts) ->
 *   { avg, baselineAvg, delta, regressed, blocked, line, markdown }
 * - scorecard: { avg, passed, total, results[] } as written by run-evals.mjs --json.
 * - baseline: { avg, passed, total, recordedAt } as written to baseline.json, or null/malformed.
 * - opts.tolerance: allowed drop (absolute, in [0,1]) before flagging a regression. Default 0.05 (5pp).
 * - opts.enforce: when true, `blocked` mirrors `regressed` (the future hard-gate exit code driver).
 *   When false (default), `blocked` is always false (report-only), matching the rest of the eval CI.
 * Defensive: missing baseline (first run, or baseline.json absent/corrupt) never regresses — there is
 * nothing to compare against, so "no baseline" is reported distinctly from "no regression".
 */
export function compareToBaseline(scorecard, baseline, opts = {}) {
  const sc = scorecard && typeof scorecard === "object" ? scorecard : {};
  const results = Array.isArray(sc.results) ? sc.results : [];
  const total = Number.isFinite(sc.total) ? sc.total : results.length;
  const avg = Number.isFinite(sc.avg) ? sc.avg
    : (results.length ? results.reduce((s, r) => s + (Number(r && r.score) || 0), 0) / results.length : 0);

  const tolerance = Number.isFinite(opts.tolerance) ? opts.tolerance : 0.05;
  const enforce = !!opts.enforce;

  const bl = baseline && typeof baseline === "object" && Number.isFinite(baseline.avg) && Number.isFinite(baseline.total) ? baseline : null;
  const hasBaseline = !!bl && bl.total > 0 && total > 0;
  const baselineAvg = hasBaseline ? bl.avg : null;
  const delta = hasBaseline ? avg - baselineAvg : null;
  const regressed = hasBaseline && delta < -tolerance;
  const blocked = enforce && regressed;

  const pct = (x) => `${Math.round(x * 100)}%`;
  let line;
  if (!hasBaseline) {
    line = total > 0
      ? `eval-gate: no baseline on record yet — this run (avg ${pct(avg)}) will seed the next baseline. Not a regression.`
      : `eval-gate: no scorecard data and no baseline — nothing to compare.`;
  } else {
    line = `eval-gate: avg ${pct(avg)} vs baseline ${pct(baselineAvg)} (Δ ${delta >= 0 ? "+" : ""}${pct(delta)}, tolerance -${pct(tolerance)})`
      + (regressed ? " — REGRESSION" : " — OK")
      + (regressed ? (enforce ? " [BLOCKING]" : " [report-only, not blocking]") : "");
  }

  const markdown = [
    `## 🚦 Eval Gate`,
    ``,
    hasBaseline
      ? `**avg ${pct(avg)}** vs baseline **${pct(baselineAvg)}** (recorded ${bl.recordedAt || "unknown"}) — Δ ${delta >= 0 ? "+" : ""}${pct(delta)}, tolerance -${pct(tolerance)}`
      : `_No baseline on record — this run will seed the next one. Nothing to gate against yet._`,
    regressed
      ? `\n> ${enforce ? "🛑 **BLOCKED**" : "⚠️ **Regression detected**"} — golden-task quality dropped more than the ${pct(tolerance)} tolerance vs the last accepted baseline.${enforce ? "" : " Report-only for now; nothing was blocked."}\n`
      : ``,
    `<sub>mode: ${enforce ? "ENFORCE (blocks on regression)" : "REPORT-ONLY (never blocks; flips to enforce via --enforce once trust is established)"}</sub>`,
  ].filter((s) => s !== ``).join("\n");

  return { avg, baselineAvg, delta, regressed, blocked, hasBaseline, line, markdown };
}

/**
 * nextBaseline(scorecard, previous) -> the baseline.json payload to write after an ACCEPTED run
 * (i.e. a run that passed the gate, or a manual override). Never regresses the recorded baseline
 * silently — call sites decide when to invoke this (e.g. nightly, or a maintainer-approved bump).
 */
export function nextBaseline(scorecard, previous = null) {
  const sc = scorecard && typeof scorecard === "object" ? scorecard : {};
  const results = Array.isArray(sc.results) ? sc.results : [];
  const total = Number.isFinite(sc.total) ? sc.total : results.length;
  const passed = Number.isFinite(sc.passed) ? sc.passed : results.filter((r) => r && r.pass).length;
  const avg = Number.isFinite(sc.avg) ? sc.avg
    : (results.length ? results.reduce((s, r) => s + (Number(r && r.score) || 0), 0) / results.length : 0);
  if (total === 0) return previous; // never overwrite a real baseline with an empty/failed run
  return { avg, passed, total, recordedAt: new Date().toISOString(), model: sc.model || "unknown" };
}

// ---- CLI ----
const isMain = (() => {
  try { return process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]; } catch { return false; }
})();

if (isMain) {
  const { readFileSync, appendFileSync } = await import("node:fs");
  const args = process.argv.slice(2);
  const scPath = args.find((a) => !a.startsWith("--"));
  const takeVal = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
  const baselinePath = takeVal("--baseline", "");
  const tolerance = Number(takeVal("--tolerance", "")) || 0.05;
  const enforce = args.includes("--enforce");

  let scorecard = null;
  try { scorecard = JSON.parse(readFileSync(scPath, "utf8")); }
  catch (e) { console.log(`eval-gate: no readable scorecard at ${scPath} (${e.message}); skipping gate.`); process.exit(0); }

  let baseline = null;
  if (baselinePath) {
    try { baseline = JSON.parse(readFileSync(baselinePath, "utf8")); }
    catch { baseline = null; }
  }

  const result = compareToBaseline(scorecard, baseline, { tolerance, enforce });
  console.log(result.line);
  if (process.env.GITHUB_STEP_SUMMARY) {
    try { appendFileSync(process.env.GITHUB_STEP_SUMMARY, result.markdown + "\n"); } catch { /* non-fatal */ }
  }
  if (result.regressed) console.log(`::warning::${result.line}`);
  process.exit(result.blocked ? 1 : 0);
}

export default { compareToBaseline, nextBaseline };
