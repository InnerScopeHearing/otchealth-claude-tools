#!/usr/bin/env node
// judgepanel-cli.mjs - thin IO shell around the pure core in judgepanel.mjs. NOT wired into
// promptcheck.yml or run-evals.mjs's exit code; this is an advisory, standalone report generator for
// the north-star self-improving-loop wave, item B (multi-judge panel + calibration). It never blocks
// CI, never writes to any ledger, and does no network I/O of its own beyond the model-routing chat
// calls it is explicitly asked to make (same Azure OpenAI/Foundry endpoint run-evals.mjs already uses).
//
// Usage:
//   node judgepanel-cli.mjs calibration-report [--golden golden-set.json] [--out report.md]
//     PURE-DATA MODE (no network): builds the calibration curve from the golden set and prints a
//     report-only markdown summary (n pairs, MAE, curve points). Useful for reviewing how trustworthy
//     the calibration is before it is ever applied to a live scorecard.
//
// A live "score a real answer with the panel" mode intentionally is NOT wired here in v1 - that needs
// the same GCP-Secret-Manager-backed Azure OpenAI credentials run-evals.mjs resolves via its own
// initModel()/chat() helpers. run-evals.mjs (or a future small patch to it) is the natural IO caller of
// runJudgePanel(); this CLI only exercises the calibration-report path so the pure core has a real,
// runnable entry point without duplicating run-evals.mjs's credential plumbing.
import { readFileSync, writeFileSync } from "node:fs";
import { buildCalibration } from "./judgepanel.mjs";

const argv = process.argv.slice(2);
const cmd = argv[0];
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

function loadGolden(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch (e) { console.error(`could not read/parse ${path}: ${e.message}`); return []; }
}

function renderCalibrationReport(golden, calibration) {
  const lines = [];
  lines.push("### Judge-panel calibration report (report-only, advisory)");
  lines.push("");
  lines.push(`Golden-set pairs used: ${calibration.n}. Mean absolute calibration error (MAE): ${calibration.mae === null ? "n/a (no data)" : calibration.mae.toFixed(3)}.`);
  lines.push("");
  lines.push("This report is informational only. It never blocks CI and is not consulted by run-evals.mjs's pass/fail gate.");
  lines.push("");
  lines.push("| golden task id | panel score | human score |");
  lines.push("|---|---|---|");
  for (const g of golden) lines.push(`| ${g.id} | ${g.panel_score} | ${g.human_score} |`);
  lines.push("");
  lines.push("Calibration curve points (panel_score -> calibrated_score):");
  lines.push("");
  lines.push("| x (raw panel score) | y (calibrated score) |");
  lines.push("|---|---|");
  for (const p of calibration.points) lines.push(`| ${p.x.toFixed(3)} | ${p.y.toFixed(3)} |`);
  lines.push("");
  return lines.join("\n");
}

function calibrationReportCmd() {
  const goldenPath = val("--golden", new URL("./golden-set.json", import.meta.url).pathname);
  const outPath = val("--out", "");
  const golden = loadGolden(goldenPath);
  const pairs = golden.map((g) => ({ panel_score: g.panel_score, human_score: g.human_score }));
  const calibration = buildCalibration(pairs);
  const md = renderCalibrationReport(golden, calibration);
  if (outPath) writeFileSync(outPath, md);
  console.log(md);
  // report-only: ALWAYS exit 0. This tool never fails a build.
  process.exit(0);
}

import { pathToFileURL } from "node:url";
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  if (cmd === "calibration-report") calibrationReportCmd();
  else { console.error("usage: judgepanel-cli.mjs calibration-report [--golden golden-set.json] [--out report.md]"); process.exit(0); }
}
