#!/usr/bin/env node
// recall-evals — RECALL-QUALITY EVAL HARNESS. REPORT-MODE / MEASUREMENT ONLY.
//
// Measures the fleet's memory-recall precision + latency against a golden set of known durable,
// non-PHI facts, so future memory/recall changes are tuned with DATA rather than vibes. This tool
// is PURE MEASUREMENT: it issues read-only `recall` calls against the existing kb-memory path
// (skills/kb-memory/mem.mjs) and prints a scorecard. It writes NOTHING to the ledger or memory
// (no remember/decision/correct/pitfall/status/entity-set calls, ever) and NEVER exits non-zero on
// a low score -- a bad score is a finding to report, not a reason to fail a CI gate. Run it via the
// kb-memory wrapper (skills/kb-memory/run.sh) so the claude-driver SA is injected the same way every
// other octools skill authenticates.
//
// PHI-EXCLUDED: golden-set.json carries only non-PHI, non-MNPI durable facts (kb-memory's own
// RING_DENY regex already blocks PHI/MNPI terms from ever reaching a SHARED ledger entry; this
// harness additionally never targets a PHI project, container, or agent lane, and never queries for
// patient/diagnosis/medication/audiogram/hearing-number terms).
//
// Usage:
//   node run-evals.mjs                       # run the whole golden set against semantic.mjs recall (default, 2026-07-10)
//   node run-evals.mjs --engine keyword       # use mem.mjs recall instead -- HARD-DEPRECATED as of 2026-07-10,
//                                              # this will now fail loudly (mem.mjs recall exits 1 on every call,
//                                              # see skills/kb-memory/mem.mjs) -- kept only so this harness can still
//                                              # measure/document the deprecated path's failure if ever needed, not
//                                              # as a real eval option going forward.
//   node run-evals.mjs --k 5                  # precision@k cutoff (default 5)
//   node run-evals.mjs --set /path/other.json # use a different golden-set file
//   node run-evals.mjs --json                 # also print the raw scorecard as JSON (for CI logs)
//
// Requires: GCP_CLAUDE_DRIVER_SA_JSON in env (kb-memory self-resolves from ~/.gcp_claude_driver_sa.json
// too) -- run via `bash skills/kb-memory/run.sh node skills/recall-evals/run-evals.mjs`.
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { aggregate, precisionAtK, hitAtK, reciprocalRank } from "./scoring.mjs";
import { kvSecret } from "../kb-memory/azure-secret.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const MEM_MJS = join(HERE, "..", "kb-memory", "mem.mjs");
const SEMANTIC_MJS = join(HERE, "..", "kb-memory", "semantic.mjs");

const argv = process.argv.slice(2);
const takeVal = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const ENGINE = (takeVal("--engine", "semantic") || "semantic").toLowerCase(); // keyword | semantic -- default flipped 2026-07-10, mem.mjs recall (keyword) is now hard-deprecated and exits 1
const K = parseInt(takeVal("--k", "5"), 10) || 5;
const SET_PATH = takeVal("--set", join(HERE, "golden-set.json"));
const PRINT_JSON = argv.includes("--json");
const EMIT = argv.includes("--emit");                       // emit recall_eval to PostHog Fleet Agents
const BASELINE_PATH = takeVal("--baseline", "");            // compare hit@K to a stored baseline
const UPDATE_BASELINE = argv.includes("--update-baseline"); // overwrite the baseline with this run (nightly seeds/rolls it)
const TOLERANCE = parseFloat(takeVal("--tolerance", "0.05")) || 0.05; // allowed hit@K drop (5pp) before flagging a regression
const ENFORCE = argv.includes("--enforce");                 // exit 1 on regression (report-mode default = exit 0)
const N_RECALL = 10; // how many rows to ask the underlying recall verb for, per query

// PHI-exclusion guard: hard-fail loudly (not a ledger write, just a refusal to run) if the golden
// set or the CLI ever names a PHI-adjacent target. Defensive; the golden set should never need this.
const PHI_DENY = /\b(medreview|phi\b|patient|diagnos|medication|prescrib|hipaa|audiogram|hearing\s*number)\b/i;

function loadGoldenSet(path) {
  const raw = readFileSync(path, "utf8");
  const items = JSON.parse(raw);
  if (!Array.isArray(items) || items.length === 0) throw new Error(`golden set ${path} is empty or not an array`);
  for (const it of items) {
    if (PHI_DENY.test(`${it.query} ${(it.expect || []).join(" ")} ${it.agent || ""}`)) {
      throw new Error(`PHI-EXCLUDED: golden-set item ${it.id} looks PHI-adjacent; refusing to run. Remove it.`);
    }
    if ((it.agent || "").toLowerCase().includes("medreview")) {
      throw new Error(`PHI-EXCLUDED: golden-set item ${it.id} targets a medreview/PHI agent lane; refusing to run.`);
    }
  }
  return items;
}

// Runs one recall query through the EXISTING recall path (never re-implements retrieval) and
// returns { lines, latencyMs, ok, error }. READ-ONLY: `recall` is a query verb, it never writes.
function runRecall(item) {
  const start = Date.now();
  let child;
  if (ENGINE === "semantic") {
    const args = [SEMANTIC_MJS, "recall", item.query, "--n", String(N_RECALL)];
    if (item.agent) args.push("--agent", item.agent);
    child = spawnSync("node", args, { encoding: "utf8", timeout: 30000 });
  } else {
    const args = [MEM_MJS, "recall", item.query, "--agent", item.agent || "commons", "--n", String(N_RECALL)];
    child = spawnSync("node", args, { encoding: "utf8", timeout: 30000 });
  }
  const latencyMs = Date.now() - start;
  if (child.error) return { lines: [], latencyMs, ok: false, error: String(child.error.message || child.error) };
  if (child.status !== 0) return { lines: [], latencyMs, ok: false, error: (child.stderr || "").trim().slice(0, 300) || `exit ${child.status}` };
  const lines = (child.stdout || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && !l.startsWith("##"));
  return { lines, latencyMs, ok: true, error: null };
}

function fmtPct(x) { return `${(x * 100).toFixed(1)}%`; }
function fmtMs(x) { return `${Math.round(x)}ms`; }

// Emit one event to the PostHog Fleet Agents project (same sink + key as agent-evals). Best-effort:
// a missing key or a network error never fails the run (this stays report-mode).
async function emitPosthog(event, props) {
  try {
    const key = await kvSecret("posthog-fleet-ingest-key");
    if (!key) return false;
    const r = await fetch("https://us.i.posthog.com/capture/", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: key, event, distinct_id: "recall-evals", timestamp: new Date().toISOString(), properties: props }),
    });
    return r.ok;
  } catch { return false; }
}

async function main() {
  const items = loadGoldenSet(SET_PATH);
  console.log(`# RECALL-QUALITY SCORECARD (report-mode / measurement only, writes nothing)`);
  console.log(`engine=${ENGINE} k=${K} golden-set=${SET_PATH} (${items.length} queries)\n`);

  const perItem = [];
  const latencies = [];
  let runErrors = 0;

  for (const item of items) {
    const { lines, latencyMs, ok, error } = runRecall(item);
    latencies.push(latencyMs);
    if (!ok) runErrors++;
    const p = precisionAtK(lines, item.expect, K);
    const hit = hitAtK(lines, item.expect, K);
    const rr = reciprocalRank(lines, item.expect);
    perItem.push({ id: item.id, query: item.query, agent: item.agent, expect: item.expect, results: lines, latencyMs, ok, error, precisionAtK: p, hit, rr });
    const status = ok ? (hit ? "HIT " : "MISS") : "ERR ";
    console.log(`[${status}] ${item.id.padEnd(6)} p@${K}=${fmtPct(p)}  rr=${rr.toFixed(2)}  ${fmtMs(latencyMs).padStart(6)}  "${item.query}"${error ? `  (${error})` : ""}`);
  }

  const agg = aggregate(perItem.map((r) => ({ results: r.results, expect: r.expect })), K);
  const sortedLat = [...latencies].sort((a, b) => a - b);
  const p50 = sortedLat[Math.floor(sortedLat.length * 0.5)] || 0;
  const p95 = sortedLat[Math.min(sortedLat.length - 1, Math.floor(sortedLat.length * 0.95))] || 0;
  const meanLat = latencies.reduce((a, b) => a + b, 0) / (latencies.length || 1);

  console.log(`\n## SUMMARY (n=${agg.n})`);
  console.log(`  precision@${K} (mean): ${fmtPct(agg.meanPrecisionAtK)}`);
  console.log(`  hit-rate@${K}:         ${fmtPct(agg.hitRate)}`);
  console.log(`  MRR:                  ${agg.mrr.toFixed(3)}`);
  console.log(`  latency mean/p50/p95: ${fmtMs(meanLat)} / ${fmtMs(p50)} / ${fmtMs(p95)}`);
  if (runErrors) console.log(`  runner errors:         ${runErrors}/${agg.n} queries errored (see ERR rows above)`);
  console.log(`\nREPORT-MODE: measurement only. No ledger writes. Never exits non-zero on a low score.`);

  const scorecard = { engine: ENGINE, k: K, n: agg.n, hitRate: agg.hitRate, mrr: agg.mrr, meanPrecisionAtK: agg.meanPrecisionAtK, latencyMeanMs: Math.round(meanLat), runErrors, recordedAt: new Date().toISOString() };

  // BASELINE regression check on hit@K (the blunt "did recall get worse" signal). Report-mode:
  // prints an ::warning:: on regression; exits non-zero ONLY with --enforce.
  let regressed = false;
  if (BASELINE_PATH) {
    let baseline = null;
    try { baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8")); } catch { /* missing/malformed -> no gate */ }
    if (baseline && typeof baseline.hitRate === "number" && (baseline.n || 0) > 0) {
      const delta = agg.hitRate - baseline.hitRate;
      regressed = delta < -TOLERANCE;
      console.log(`\n## BASELINE (${BASELINE_PATH}): hit@${K} ${fmtPct(baseline.hitRate)} -> ${fmtPct(agg.hitRate)} (delta ${(delta * 100).toFixed(1)}pp; tolerance ${(TOLERANCE * 100).toFixed(0)}pp)`);
      console.log(regressed ? `  ::warning:: RECALL REGRESSION: hit@${K} dropped ${(-delta * 100).toFixed(1)}pp below baseline.` : `  OK: within tolerance.`);
    } else {
      console.log(`\n## BASELINE (${BASELINE_PATH}): no usable baseline yet (n=0) -- seed it with --update-baseline.`);
    }
  }

  if (EMIT) {
    const ok1 = await emitPosthog("recall_eval", scorecard);
    if (regressed) await emitPosthog("recall_eval_regression", { ...scorecard, baseline_path: BASELINE_PATH });
    console.log(ok1 ? `emitted recall_eval -> PostHog Fleet Agents${regressed ? " (+ recall_eval_regression ALERT)" : ""}` : `(PostHog emit skipped: no ingest key)`);
  }

  if (UPDATE_BASELINE && BASELINE_PATH) {
    writeFileSync(BASELINE_PATH, JSON.stringify(scorecard, null, 2) + "\n");
    console.log(`updated baseline -> ${BASELINE_PATH}`);
  }

  if (PRINT_JSON) {
    console.log("\n## JSON");
    console.log(JSON.stringify({ ...scorecard, latencyP50Ms: p50, latencyP95Ms: p95, regressed, items: perItem.map((r) => ({ id: r.id, query: r.query, ok: r.ok, hit: r.hit, precisionAtK: r.precisionAtK, rr: r.rr, latencyMs: r.latencyMs })) }, null, 2));
  }

  // Report-mode default: exit 0 even on a low score / regression. --enforce turns a regression into a
  // non-zero exit (the future hard gate a deploy/CI workflow can require).
  process.exit(ENFORCE && regressed ? 1 : 0);
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) main().catch((e) => { console.error("recall-evals error:", e.message); process.exit(0); });
