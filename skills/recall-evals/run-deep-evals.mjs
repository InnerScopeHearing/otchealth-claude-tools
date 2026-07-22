#!/usr/bin/env node
// run-deep-evals.mjs -- DEEP-MODE-SPECIFIC recall-quality eval harness. REPORT-MODE / MEASUREMENT ONLY
// by default, a PAGER with --strict (same convention as run-evals.mjs / azure-canary.mjs).
//
// WHY THIS EXISTS AS ITS OWN HARNESS (not folded into run-evals.mjs): the existing recall-evals suite
// (run-evals.mjs) exercises ONLY the local, non-deep `semantic.mjs recall` path -- the gateway's
// brain_search tool ALSO supports `mode:'deep'` (an LLM-planned, multi-round agentic retrieval that
// plans sub-queries, does one bounded refine round if results look thin, and synthesizes a cited
// answer -- see otchealth-mcp-server src/memory/deep-retrieval.ts). A regression specific to that
// planner/refine/synthesize pipeline (a broken plan-JSON parse, a refine round that never fires, a
// synthesis prompt that stops citing) would be COMPLETELY INVISIBLE to run-evals.mjs, because that
// harness never calls the gateway or ever passes mode:'deep'. This file closes that blind spot by
// calling the REAL, LIVE gateway (mcp.otchealth.app) with mode:'deep' for a subset of the same golden
// queries recall-evals already trusts, and scoring hit@K / precision@K / MRR on the returned matches
// (reusing scoring.mjs's pure functions unchanged) PLUS one deep-mode-specific quality signal:
// "answer groundedness" -- did the LLM-synthesized answer text actually contain the grounded fact, not
// just retrieve it. A fast-mode-only regression (e.g. index staleness) would still show up in both
// suites; a deep-mode-ONLY regression (planner/synthesis) shows up ONLY here.
//
// COST / LATENCY: unlike the local recall path, EVERY query here spends one or more Foundry LLM calls
// (plan, possibly refine, synthesize) and a live gateway round trip (observed ~5-11s/query during
// development). --limit bounds how many golden-set items are actually run through deep mode (default
// 15) so a nightly run stays fast and cheap; --all runs the whole golden set. Items are sampled at
// EVENLY SPACED indices across the golden set (not just the first N) so the subset stays representative
// as the golden set grows, and the SAME indices are chosen for a given (limit, total) pair every run
// (deterministic, not random) so baseline comparisons are apples-to-apples.
//
// Usage (creds via kvSecret / AZURE_SP, or run.sh):
//   node run-deep-evals.mjs                              # deep-mode eval, --limit 15, cto lane, report-only
//   node run-deep-evals.mjs --limit 30 --lane cto         # bigger subset / a different gateway lane
//   node run-deep-evals.mjs --all                         # every item in the golden set (cost warning: see above)
//   node run-deep-evals.mjs --set golden-set.json --top 8 --k 5
//   node run-deep-evals.mjs --baseline baseline-deep.json --tolerance 0.05 --strict --json --emit
//   node run-deep-evals.mjs --update-baseline --baseline baseline-deep.json
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { aggregate, hitAtK } from "./scoring.mjs";
import { answerMatches } from "./hard-negative-scoring.mjs";
import { callDeepBrainSearch, mintToken } from "./gateway-deep-client.mjs";
import { kvSecret } from "../kb-memory/azure-secret.mjs";
import { pageExitCode } from "./run-evals.mjs"; // reuse the SAME strict/report-mode exit-code policy, unit-tested there

const HERE = dirname(fileURLToPath(import.meta.url));

const argv = process.argv.slice(2);
const takeVal = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const K = parseInt(takeVal("--k", "5"), 10) || 5;
const TOP = parseInt(takeVal("--top", "8"), 10) || 8;
const SET_PATH = takeVal("--set", join(HERE, "golden-set.json"));
const LIMIT = parseInt(takeVal("--limit", "15"), 10) || 15;
const RUN_ALL = argv.includes("--all");
const LANE = takeVal("--lane", "cto");
const CONCURRENCY = parseInt(takeVal("--concurrency", "3"), 10) || 3;
const PRINT_JSON = argv.includes("--json");
const EMIT = argv.includes("--emit");
const BASELINE_PATH = takeVal("--baseline", "");
const UPDATE_BASELINE = argv.includes("--update-baseline");
const TOLERANCE = parseFloat(takeVal("--tolerance", "0.05")) || 0.05;
const STRICT = argv.includes("--strict") || argv.includes("--enforce") || process.env.RECALL_EVAL_STRICT === "1";

// Same PHI-exclusion guard as run-evals.mjs / mine-cases.mjs (defense in depth; golden-set.json is
// already PHI-excluded at the source, but this harness sends the query text to a LIVE external
// gateway + an LLM, so it re-checks independently rather than trusting the file never changes).
const PHI_DENY = /\b(medreview|phi\b|patient|diagnos|medication|prescrib|hipaa|audiogram|hearing\s*number)\b/i;

function loadGoldenSet(path) {
  const raw = readFileSync(path, "utf8");
  const items = JSON.parse(raw);
  if (!Array.isArray(items) || items.length === 0) throw new Error(`golden set ${path} is empty or not an array`);
  for (const it of items) {
    if (PHI_DENY.test(`${it.query} ${(it.expect || []).join(" ")} ${it.agent || ""}`)) {
      throw new Error(`PHI-EXCLUDED: golden-set item ${it.id} looks PHI-adjacent; refusing to run deep mode against it.`);
    }
  }
  return items;
}

/**
 * Deterministically select `limit` items from `items`, evenly spaced by index, so the sampled subset
 * stays representative across the whole file (not just its front) and is STABLE run-to-run for a
 * given (limit, items.length) pair (no randomness -- baseline comparisons must compare the same
 * queries each time). Pure. Returns the full list unchanged when limit >= items.length.
 * @param {Array} items
 * @param {number} limit
 * @returns {Array}
 */
export function sampleEvenly(items, limit) {
  const list = Array.isArray(items) ? items : [];
  if (!Number.isFinite(limit) || limit <= 0) return [];
  if (limit >= list.length) return list.slice();
  const out = [];
  const seen = new Set();
  for (let i = 0; i < limit; i++) {
    const idx = Math.min(list.length - 1, Math.floor((i * list.length) / limit));
    if (seen.has(idx)) continue; // defensive: avoid an accidental duplicate on a tiny list/limit combo
    seen.add(idx);
    out.push(list[idx]);
  }
  return out;
}

function fmtPct(x) { return `${(x * 100).toFixed(1)}%`; }
function fmtMs(x) { return `${Math.round(x)}ms`; }

async function emitPosthog(event, props) {
  try {
    const key = await kvSecret("posthog-fleet-ingest-key");
    if (!key) return false;
    const r = await fetch("https://us.i.posthog.com/capture/", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: key, event, distinct_id: "recall-evals-deep", timestamp: new Date().toISOString(), properties: props }),
    });
    return r.ok;
  } catch { return false; }
}

/** Bounded-concurrency worker pool (mirrors mine-cases.mjs's validateConcurrent), so a --limit 30 run
 *  does not serialize 30 x ~8s gateway round trips (~4 minutes) into a single-file queue. */
async function runConcurrent(items, worker, concurrency) {
  const results = new Array(items.length);
  let idx = 0;
  async function run() { while (idx < items.length) { const i = idx++; results[i] = await worker(items[i], i); } }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return results;
}

async function main() {
  const all = loadGoldenSet(SET_PATH);
  const items = RUN_ALL ? all : sampleEvenly(all, LIMIT);
  console.log(`# DEEP-MODE RECALL SCORECARD (gateway brain_search mode:'deep', report-mode / measurement only)`);
  console.log(`lane=${LANE} k=${K} top=${TOP} golden-set=${SET_PATH} (${items.length}/${all.length} queries${RUN_ALL ? " -- ALL" : " -- evenly-sampled subset"})\n`);

  const { token } = await mintToken(LANE);

  const perItem = await runConcurrent(items, async (item) => {
    const started = Date.now();
    const res = await callDeepBrainSearch(token, item.query, { top: TOP });
    const latencyMs = Date.now() - started;
    if (!res.ok) {
      return { id: item.id, query: item.query, expect: item.expect, ok: false, error: res.reason, latencyMs: res.latencyMs || latencyMs, results: [], answer: "", roundsUsed: 0, subQueries: 0, roomsSearched: [] };
    }
    const s = res.structured;
    const matchTexts = Array.isArray(s.matches) ? s.matches.map((m) => String((m && m.text) || "")) : [];
    return {
      id: item.id, query: item.query, expect: item.expect, ok: true, error: null, latencyMs: res.latencyMs,
      results: matchTexts, answer: String(s.answer || ""), roundsUsed: s.rounds_used || 0,
      subQueries: Array.isArray(s.sub_queries) ? s.sub_queries.length : 0, roomsSearched: Array.isArray(s.rooms_searched) ? s.rooms_searched : [],
    };
  }, CONCURRENCY);

  let runErrors = 0;
  const latencies = [];
  let answerGroundedHits = 0, answerGroundedEligible = 0;
  for (const r of perItem) {
    latencies.push(r.latencyMs);
    if (!r.ok) runErrors++;
    const hit = r.ok && hitAtK(r.results, r.expect, K) === 1;
    if (r.ok) {
      answerGroundedEligible++;
      if (answerMatches(r.answer, r.expect)) answerGroundedHits++;
    }
    const status = r.ok ? (hit ? "HIT " : "MISS") : "ERR ";
    console.log(`[${status}] ${r.id.padEnd(8)} rounds=${r.roundsUsed} sub_qs=${r.subQueries} ${fmtMs(r.latencyMs).padStart(7)}  "${r.query}"${r.error ? `  (${r.error})` : ""}`);
  }

  const agg = aggregate(perItem.map((r) => ({ results: r.results, expect: r.expect })), K);
  const sortedLat = [...latencies].sort((a, b) => a - b);
  const p50 = sortedLat[Math.floor(sortedLat.length * 0.5)] || 0;
  const p95 = sortedLat[Math.min(sortedLat.length - 1, Math.floor(sortedLat.length * 0.95))] || 0;
  const meanLat = latencies.reduce((a, b) => a + b, 0) / (latencies.length || 1);
  const answerGroundedRate = answerGroundedEligible ? answerGroundedHits / answerGroundedEligible : 0;

  console.log(`\n## SUMMARY (n=${agg.n})`);
  console.log(`  hit-rate@${K}:              ${fmtPct(agg.hitRate)}`);
  console.log(`  precision@${K} (mean):      ${fmtPct(agg.meanPrecisionAtK)}`);
  console.log(`  MRR:                       ${agg.mrr.toFixed(3)}`);
  console.log(`  answer-grounded rate:      ${fmtPct(answerGroundedRate)}  (the SYNTHESIZED answer itself cites the retrieved fact; deep-mode-specific -- fast mode has no synthesized answer to check)`);
  console.log(`  latency mean/p50/p95:      ${fmtMs(meanLat)} / ${fmtMs(p50)} / ${fmtMs(p95)}`);
  if (runErrors) console.log(`  runner errors:              ${runErrors}/${agg.n} queries errored (see ERR rows above)`);
  console.log(STRICT
    ? `\nSTRICT MODE: a hit@${K} drop past the baseline SLO tolerance will page (non-zero exit).`
    : `\nREPORT-MODE: measurement only. Never exits non-zero on a low score (pass --strict to page).`);

  const scorecard = { engine: "gateway-deep", lane: LANE, k: K, top: TOP, n: agg.n, hitRate: agg.hitRate, mrr: agg.mrr, meanPrecisionAtK: agg.meanPrecisionAtK, answerGroundedRate, latencyMeanMs: Math.round(meanLat), runErrors, recordedAt: new Date().toISOString() };

  let regressed = false;
  if (BASELINE_PATH) {
    let baseline = null;
    try { baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8")); } catch { /* missing/malformed -> no gate */ }
    if (baseline && typeof baseline.hitRate === "number" && (baseline.n || 0) > 0) {
      const delta = agg.hitRate - baseline.hitRate;
      regressed = delta < -TOLERANCE;
      console.log(`\n## BASELINE SLO (${BASELINE_PATH}): hit@${K} ${fmtPct(baseline.hitRate)} -> ${fmtPct(agg.hitRate)} (delta ${(delta * 100).toFixed(1)}pp; tolerance ${(TOLERANCE * 100).toFixed(0)}pp)`);
      if (regressed) console.log(`  ::warning:: DEEP-MODE RECALL REGRESSION: hit@${K} dropped ${(-delta * 100).toFixed(1)}pp below the baseline SLO.${STRICT ? " STRICT: this run will exit non-zero (paging)." : ""}`);
      else console.log(`  OK: within tolerance.`);
    } else {
      console.log(`\n## BASELINE SLO (${BASELINE_PATH}): no usable baseline yet (n=0) -- seed it with --update-baseline.`);
    }
  }

  if (EMIT) {
    const ok1 = await emitPosthog("recall_eval_deep", scorecard);
    if (regressed) await emitPosthog("recall_eval_deep_regression", { ...scorecard, baseline_path: BASELINE_PATH });
    console.log(ok1 ? `emitted recall_eval_deep -> PostHog Fleet Agents${regressed ? " (+ recall_eval_deep_regression ALERT)" : ""}` : `(PostHog emit skipped: no ingest key)`);
  }

  if (UPDATE_BASELINE && BASELINE_PATH) {
    writeFileSync(BASELINE_PATH, JSON.stringify(scorecard, null, 2) + "\n");
    console.log(`updated baseline -> ${BASELINE_PATH}`);
  }

  if (PRINT_JSON) {
    console.log("\n## JSON");
    console.log(JSON.stringify({ ...scorecard, latencyP50Ms: p50, latencyP95Ms: p95, regressed, items: perItem.map((r) => ({ id: r.id, query: r.query, ok: r.ok, roundsUsed: r.roundsUsed, subQueries: r.subQueries, latencyMs: r.latencyMs, error: r.error })) }, null, 2));
  }

  process.exit(pageExitCode(regressed, STRICT));
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) main().catch(async (e) => {
  // DARK SENSOR: mirrors run-evals.mjs's fatal handler -- a check that cannot run at all (mint
  // failure, malformed golden set, an unreachable gateway) must page UNCONDITIONALLY, regardless of
  // --strict, rather than silently reporting nothing.
  try { await emitPosthog("recall_eval_deep_fatal", { error: e.message, strict: STRICT }); } catch { /* best-effort */ }
  console.error(`::error::[run-deep-evals] FATAL (dark sensor): ${e.message}`);
  process.exit(1);
});
