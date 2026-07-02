#!/usr/bin/env node
// nightly-summary.mjs — render a human-readable summary of an agent-evals scorecard and apply a
// report-only FLOOR guard, for the scheduled nightly eval baseline (.github/workflows/nightly-eval.yml).
//
// run-evals.mjs already (a) emits eval_result to PostHog (the durable trend = the regression baseline)
// and (b) writes a --json scorecard. This module turns that scorecard into a GitHub Step Summary + a
// ::warning:: annotation when the average drops below a floor. It NEVER fails the build: the nightly is
// report-only (a baseline that blocked CI would be a foot-gun, and run-evals already exits 1 whenever any
// single task fails, which is normal signal, not a workflow error). Pure summarize() is unit-testable.

/**
 * summarize(scorecard, floor) -> { markdown, line, belowFloor, avg, passed, total }
 * scorecard: the object run-evals.mjs writes ({ model, passAt, avg, passed, total, results[] }).
 * floor: pass-rate/avg floor in [0,1]; belowFloor is true when avg < floor. Defensive against missing
 * fields (treats them as 0 / empty) so a malformed scorecard degrades to a clear "no data" summary
 * rather than throwing.
 */
export function summarize(scorecard, floor = 0.6) {
  const sc = scorecard && typeof scorecard === "object" ? scorecard : {};
  const results = Array.isArray(sc.results) ? sc.results : [];
  const total = Number.isFinite(sc.total) ? sc.total : results.length;
  const passed = Number.isFinite(sc.passed) ? sc.passed : results.filter((r) => r && r.pass).length;
  const avg = Number.isFinite(sc.avg) ? sc.avg : (results.length ? results.reduce((s, r) => s + (Number(r && r.score) || 0), 0) / results.length : 0);
  const model = typeof sc.model === "string" ? sc.model : "unknown";
  const f = Number.isFinite(floor) ? floor : 0.6;
  const belowFloor = total > 0 && avg < f;

  const rows = results
    .map((r) => `| ${r && r.agent ? r.agent : "?"}/${r && r.id ? r.id : "?"} | ${r && r.pass ? "✅" : "❌"} | ${Math.round((Number(r && r.score) || 0) * 100)}% | ${(r && r.notes ? String(r.notes) : "").slice(0, 80)} |`)
    .join("\n");

  const line = `nightly eval: ${passed}/${total} passed, avg ${Math.round(avg * 100)}% (judge ${model}, floor ${Math.round(f * 100)}%)${belowFloor ? " — BELOW FLOOR" : ""}`;
  const markdown = [
    `## 🧪 Nightly Eval Baseline`,
    ``,
    `**${passed}/${total} passed · avg ${Math.round(avg * 100)}% · judge \`${model}\` · floor ${Math.round(f * 100)}%**`,
    belowFloor ? `\n> ⚠️ **Average is below the ${Math.round(f * 100)}% floor** — investigate a possible regression (prompt/model/skill change). Report-only; nothing was blocked.\n` : ``,
    total > 0 ? `| task | pass | score | notes |\n|---|---|---|---|\n${rows}` : `_No scorecard data (the eval run may have failed to produce results — check the run log)._`,
    ``,
    `<sub>Durable trend lives in PostHog (\`eval_result\`); this run's scorecard is attached as an artifact.</sub>`,
  ].filter((s) => s !== ``).join("\n");

  return { markdown, line, belowFloor, avg, passed, total };
}

// ---- CLI: node nightly-summary.mjs <scorecard.json> [--floor 0.6] ----
// Reads the scorecard, prints the one-line summary to stdout, appends the markdown to
// $GITHUB_STEP_SUMMARY when present, and emits a ::warning:: when below floor. ALWAYS exits 0
// (report-only). A missing/unreadable scorecard is reported, not thrown.
const isMain = (() => {
  try { return process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]; } catch { return false; }
})();

if (isMain) {
  const { readFileSync, appendFileSync } = await import("node:fs");
  const args = process.argv.slice(2);
  const path = args.find((a) => !a.startsWith("--"));
  const fi = args.indexOf("--floor");
  const floor = fi >= 0 && args[fi + 1] ? Number(args[fi + 1]) : Number(process.env.EVAL_FLOOR) || 0.6;

  let scorecard = null;
  try { scorecard = JSON.parse(readFileSync(path, "utf8")); }
  catch (e) { console.log(`nightly eval: no readable scorecard at ${path} (${e.message}); the eval run likely failed — see the run log.`); process.exit(0); }

  const { markdown, line, belowFloor } = summarize(scorecard, floor);
  console.log(line);
  if (process.env.GITHUB_STEP_SUMMARY) { try { appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown + "\n"); } catch { /* non-fatal */ } }
  if (belowFloor) console.log(`::warning::${line}`);
  process.exit(0);
}

export default { summarize };
