#!/usr/bin/env node
// run-hard-negative-evals.mjs -- HARD-NEGATIVE (contrastive) recall-quality eval harness. REPORT-MODE
// / MEASUREMENT ONLY by default, a PAGER with --strict (same convention as run-evals.mjs).
//
// WHY THIS IS A DIFFERENT DIMENSION FROM run-evals.mjs's golden set: the existing suite only ever
// asks "does a relevant memory show up in the top-k." It never asks the mirror-image question: "does
// a SUPERSEDED, semantically-similar-but-now-WRONG memory on the exact same topic stay correctly
// suppressed." recall's retraction filter (semantic.mjs's computeRetractedIds/filterHygiene; the
// gateway's filterRetracted()) is exactly what is supposed to guarantee that -- but it is code, and
// code regresses. A future reindex bug that forgets to (re)compute `retracted:true`, or a gateway
// change that drops the filterRetracted() step, would leave the STANDARD golden set looking perfectly
// healthy (the current fact is usually still findable on its own merits) while silently letting a
// retracted, wrong belief leak back into results -- exactly the failure mode this harness pages on.
//
// Cases come from hard-negative-set.json, mined + validated from REAL `supersedes` links in the
// shared exec feed by mine-hard-negatives.mjs (never hand-invented) -- see that file's header for the
// full mining methodology and safety filters (agent allowlist, PHI/MNPI deny, exhaust-type and
// progress-log exclusion, jaccard-similarity band).
//
// Cheap + fast: this runs entirely against the LOCAL semantic.mjs recall path (no LLM calls at eval
// time -- the LLM cost was already spent once, at mining time). Safe to run as an extra step inside
// the existing nightly-recall-eval.yml job rather than needing its own workflow.
//
// Usage (creds via kvSecret / AZURE_SP, or run.sh):
//   node run-hard-negative-evals.mjs
//   node run-hard-negative-evals.mjs --k 5 --json
//   node run-hard-negative-evals.mjs --set hard-negative-set.json
//   node run-hard-negative-evals.mjs --baseline baseline-hardneg.json --tolerance 0.05 --strict --emit
//   node run-hard-negative-evals.mjs --update-baseline --baseline baseline-hardneg.json
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { groupHitLines } from "./scoring.mjs";
import { hardNegItemResult, aggregateHardNeg } from "./hard-negative-scoring.mjs";
import { kvSecret } from "../kb-memory/azure-secret.mjs";
import { pageExitCode } from "./run-evals.mjs"; // reuse the SAME strict/report-mode exit-code policy, unit-tested there

const HERE = dirname(fileURLToPath(import.meta.url));
const SEMANTIC_MJS = join(HERE, "..", "kb-memory", "semantic.mjs");

const argv = process.argv.slice(2);
const takeVal = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const K = parseInt(takeVal("--k", "5"), 10) || 5;
const SET_PATH = takeVal("--set", join(HERE, "hard-negative-set.json"));
const PRINT_JSON = argv.includes("--json");
const EMIT = argv.includes("--emit");
const BASELINE_PATH = takeVal("--baseline", "");
const UPDATE_BASELINE = argv.includes("--update-baseline");
const TOLERANCE = parseFloat(takeVal("--tolerance", "0.05")) || 0.05;
const STRICT = argv.includes("--strict") || argv.includes("--enforce") || process.env.RECALL_EVAL_STRICT === "1";
const N_RECALL = 10;

// Same PHI-exclusion guard as run-evals.mjs / mine-hard-negatives.mjs (defense in depth; the file is
// already PHI/MNPI-excluded at mining time by mine-hard-negatives.mjs's isContentSafe, but a monitor
// that reads a JSON file off disk should never trust it blindly).
const PHI_DENY = /\b(medreview|phi\b|patient|diagnos|medication|prescrib|hipaa|audiogram|hearing\s*number)\b/i;
const MNPI_DENY = /\b(mnpi|innd\b|inner\s?scope|hearingassist|series\s*[abc]\b|10-k|10-q|sec\s+filing|securities|derivative|capital\s+raise|convertible\s+note|reg[\s-]?d\b|reg[\s-]?a\b|gs\s+capital|valuation\s+model|investor\b|ipo\b)\b/i;

function loadHardNegSet(path) {
  const raw = readFileSync(path, "utf8");
  const items = JSON.parse(raw);
  if (!Array.isArray(items) || items.length === 0) throw new Error(`hard-negative set ${path} is empty or not an array`);
  for (const it of items) {
    const blob = `${it.query} ${(it.expect_new || []).join(" ")} ${(it.expect_old || []).join(" ")} ${it.agent || ""}`;
    if (PHI_DENY.test(blob)) throw new Error(`PHI-EXCLUDED: hard-negative item ${it.id} looks PHI-adjacent; refusing to run.`);
    if (MNPI_DENY.test(blob)) throw new Error(`MNPI-EXCLUDED: hard-negative item ${it.id} looks finance/securities-adjacent; refusing to run.`);
  }
  return items;
}

// Runs one query through the EXISTING recall path (semantic.mjs recall), identically to
// run-evals.mjs's runRecall (including the groupHitLines fix -- top-k must mean top-k RETRIEVED
// MEMORIES, not raw stdout lines). READ-ONLY.
function runRecall(query) {
  const start = Date.now();
  const args = [SEMANTIC_MJS, "recall", query, "--n", String(N_RECALL)];
  const child = spawnSync("node", args, { encoding: "utf8", timeout: 30000 });
  const latencyMs = Date.now() - start;
  if (child.error) return { lines: [], latencyMs, ok: false, error: String(child.error.message || child.error) };
  if (child.status !== 0) return { lines: [], latencyMs, ok: false, error: (child.stderr || "").trim().slice(0, 300) || `exit ${child.status}` };
  const rawLines = (child.stdout || "").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#") && !l.startsWith("##"));
  return { lines: groupHitLines(rawLines), latencyMs, ok: true, error: null };
}

function fmtPct(x) { return `${(x * 100).toFixed(1)}%`; }
function fmtMs(x) { return `${Math.round(x)}ms`; }

async function emitPosthog(event, props) {
  try {
    const key = await kvSecret("posthog-fleet-ingest-key");
    if (!key) return false;
    const r = await fetch("https://us.i.posthog.com/capture/", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: key, event, distinct_id: "recall-evals-hardneg", timestamp: new Date().toISOString(), properties: props }),
    });
    return r.ok;
  } catch { return false; }
}

async function main() {
  const items = loadHardNegSet(SET_PATH);
  console.log(`# HARD-NEGATIVE (CONTRASTIVE) RECALL SCORECARD (report-mode / measurement only, writes nothing)`);
  console.log(`k=${K} hard-negative-set=${SET_PATH} (${items.length} pairs)\n`);

  const perItem = [];
  const latencies = [];
  let runErrors = 0;

  for (const item of items) {
    const { lines, latencyMs, ok, error } = runRecall(item.query);
    latencies.push(latencyMs);
    if (!ok) runErrors++;
    const r = hardNegItemResult(lines, item.expect_new, item.expect_old, K);
    perItem.push({ id: item.id, query: item.query, expectNew: item.expect_new, expectOld: item.expect_old, results: lines, latencyMs, ok, error, ...r });
    const status = !ok ? "ERR " : r.passed ? "PASS" : r.oldLeak ? "LEAK" : "MISS";
    console.log(`[${status}] ${item.id.padEnd(8)} newHit=${r.newHit} oldLeak=${r.oldLeak}  ${fmtMs(latencyMs).padStart(6)}  "${item.query}"${error ? `  (${error})` : ""}`);
  }

  const agg = aggregateHardNeg(perItem.map((r) => ({ results: r.results, expectNew: r.expectNew, expectOld: r.expectOld })), K);
  const sortedLat = [...latencies].sort((a, b) => a - b);
  const p50 = sortedLat[Math.floor(sortedLat.length * 0.5)] || 0;
  const p95 = sortedLat[Math.min(sortedLat.length - 1, Math.floor(sortedLat.length * 0.95))] || 0;
  const meanLat = latencies.reduce((a, b) => a + b, 0) / (latencies.length || 1);

  console.log(`\n## SUMMARY (n=${agg.n})`);
  console.log(`  correct-rate@${K} (current fact found): ${fmtPct(agg.correctRate)}`);
  console.log(`  leak-rate@${K} (retracted fact leaked): ${fmtPct(agg.leakRate)}  (want this near 0)`);
  console.log(`  PASS-rate@${K} (found + leak-free):      ${fmtPct(agg.passRate)}  <- the SLO this harness pages on`);
  console.log(`  latency mean/p50/p95:                   ${fmtMs(meanLat)} / ${fmtMs(p50)} / ${fmtMs(p95)}`);
  if (runErrors) console.log(`  runner errors:                          ${runErrors}/${agg.n} queries errored (see ERR rows above)`);
  console.log(STRICT
    ? `\nSTRICT MODE: a PASS-rate@${K} drop past the baseline SLO tolerance will page (non-zero exit).`
    : `\nREPORT-MODE: measurement only. Never exits non-zero on a low score (pass --strict to page).`);

  const scorecard = { engine: "hard-negative", k: K, n: agg.n, correctRate: agg.correctRate, leakRate: agg.leakRate, passRate: agg.passRate, latencyMeanMs: Math.round(meanLat), runErrors, recordedAt: new Date().toISOString() };

  let regressed = false;
  if (BASELINE_PATH) {
    let baseline = null;
    try { baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8")); } catch { /* missing/malformed -> no gate */ }
    if (baseline && typeof baseline.passRate === "number" && (baseline.n || 0) > 0) {
      const delta = agg.passRate - baseline.passRate;
      regressed = delta < -TOLERANCE;
      console.log(`\n## BASELINE SLO (${BASELINE_PATH}): PASS-rate@${K} ${fmtPct(baseline.passRate)} -> ${fmtPct(agg.passRate)} (delta ${(delta * 100).toFixed(1)}pp; tolerance ${(TOLERANCE * 100).toFixed(0)}pp)`);
      if (regressed) console.log(`  ::warning:: HARD-NEGATIVE REGRESSION: PASS-rate@${K} dropped ${(-delta * 100).toFixed(1)}pp below the baseline SLO (a retracted/superseded belief may be leaking back into recall).${STRICT ? " STRICT: this run will exit non-zero (paging)." : ""}`);
      else console.log(`  OK: within tolerance.`);
    } else {
      console.log(`\n## BASELINE SLO (${BASELINE_PATH}): no usable baseline yet (n=0) -- seed it with --update-baseline.`);
    }
  }

  if (EMIT) {
    const ok1 = await emitPosthog("recall_eval_hardneg", scorecard);
    if (regressed) await emitPosthog("recall_eval_hardneg_regression", { ...scorecard, baseline_path: BASELINE_PATH });
    console.log(ok1 ? `emitted recall_eval_hardneg -> PostHog Fleet Agents${regressed ? " (+ recall_eval_hardneg_regression ALERT)" : ""}` : `(PostHog emit skipped: no ingest key)`);
  }

  if (UPDATE_BASELINE && BASELINE_PATH) {
    writeFileSync(BASELINE_PATH, JSON.stringify(scorecard, null, 2) + "\n");
    console.log(`updated baseline -> ${BASELINE_PATH}`);
  }

  if (PRINT_JSON) {
    console.log("\n## JSON");
    console.log(JSON.stringify({ ...scorecard, latencyP50Ms: p50, latencyP95Ms: p95, regressed, items: perItem.map((r) => ({ id: r.id, query: r.query, ok: r.ok, newHit: r.newHit, oldLeak: r.oldLeak, passed: r.passed, latencyMs: r.latencyMs })) }, null, 2));
  }

  process.exit(pageExitCode(regressed, STRICT));
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) main().catch(async (e) => {
  // DARK SENSOR: mirrors run-evals.mjs's fatal handler -- a check that cannot run at all pages
  // UNCONDITIONALLY, regardless of --strict.
  try { await emitPosthog("recall_eval_hardneg_fatal", { error: e.message, strict: STRICT }); } catch { /* best-effort */ }
  console.error(`::error::[run-hard-negative-evals] FATAL (dark sensor): ${e.message}`);
  process.exit(1);
});
