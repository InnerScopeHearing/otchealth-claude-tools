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
//   node run-evals.mjs                       # run the whole golden set against keyword recall
//   node run-evals.mjs --engine semantic      # use semantic.mjs recall instead of mem.mjs recall
//   node run-evals.mjs --k 5                  # precision@k cutoff (default 5)
//   node run-evals.mjs --set /path/other.json # use a different golden-set file
//   node run-evals.mjs --json                 # also print the raw scorecard as JSON (for CI logs)
//
// Requires: GCP_CLAUDE_DRIVER_SA_JSON in env (kb-memory self-resolves from ~/.gcp_claude_driver_sa.json
// too) -- run via `bash skills/kb-memory/run.sh node skills/recall-evals/run-evals.mjs`.
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { aggregate, precisionAtK, hitAtK, reciprocalRank } from "./scoring.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const MEM_MJS = join(HERE, "..", "kb-memory", "mem.mjs");
const SEMANTIC_MJS = join(HERE, "..", "kb-memory", "semantic.mjs");

const argv = process.argv.slice(2);
const takeVal = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const ENGINE = (takeVal("--engine", "keyword") || "keyword").toLowerCase(); // keyword | semantic
const K = parseInt(takeVal("--k", "5"), 10) || 5;
const SET_PATH = takeVal("--set", join(HERE, "golden-set.json"));
const PRINT_JSON = argv.includes("--json");
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

function main() {
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

  if (PRINT_JSON) {
    console.log("\n## JSON");
    console.log(JSON.stringify({ engine: ENGINE, k: K, n: agg.n, meanPrecisionAtK: agg.meanPrecisionAtK, hitRate: agg.hitRate, mrr: agg.mrr, latencyMeanMs: meanLat, latencyP50Ms: p50, latencyP95Ms: p95, runErrors, items: perItem.map((r) => ({ id: r.id, query: r.query, ok: r.ok, hit: r.hit, precisionAtK: r.precisionAtK, rr: r.rr, latencyMs: r.latencyMs })) }, null, 2));
  }

  // ALWAYS exit 0 -- report-mode, never gates CI or blocks anything on a low score.
  process.exit(0);
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) main();
