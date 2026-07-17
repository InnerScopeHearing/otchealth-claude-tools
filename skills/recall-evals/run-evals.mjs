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
//   node run-evals.mjs --baseline baseline.json --strict   # PAGE (exit 1) if hit@K drops past the
//                                              # baseline SLO by more than --tolerance. Same --strict /
//                                              # *_STRICT=1 exit-code convention as azure-canary.mjs:
//                                              # report-only by default (always emits + ::warning::),
//                                              # --strict or RECALL_EVAL_STRICT=1 turns a real regression
//                                              # into a non-zero exit so the nightly run goes RED and
//                                              # pages instead of writing to a dashboard nobody watches.
//                                              # --enforce is a back-compat alias for --strict.
//
// Requires: GCP_CLAUDE_DRIVER_SA_JSON in env (kb-memory self-resolves from ~/.gcp_claude_driver_sa.json
// too) -- run via `bash skills/kb-memory/run.sh node skills/recall-evals/run-evals.mjs`.
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { aggregate, precisionAtK, hitAtK, reciprocalRank, groupHitLines } from "./scoring.mjs";
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
const BASELINE_PATH = takeVal("--baseline", "");            // compare hit@K to a stored baseline (the SLO)
const UPDATE_BASELINE = argv.includes("--update-baseline"); // overwrite the baseline with this run (nightly seeds/rolls it)
const TOLERANCE = parseFloat(takeVal("--tolerance", "0.05")) || 0.05; // allowed hit@K drop (5pp) before flagging a regression
// STRICT: page (non-zero exit) on a regression past the baseline SLO, the SAME --strict / *_STRICT=1
// exit-code convention azure-canary.mjs uses (report-only PostHog+::warning:: always; --strict makes an
// anomaly RED so the nightly run pages instead of writing to a dashboard nobody watches). --enforce is
// kept as a back-compat alias (recall-evals shipped it first); either flag/env sets strict mode.
const STRICT = argv.includes("--strict") || argv.includes("--enforce") || process.env.RECALL_EVAL_STRICT === "1";
const N_RECALL = 10; // how many rows to ask the underlying recall verb for, per query

// PHI-exclusion guard: hard-fail loudly (not a ledger write, just a refusal to run) if the golden
// set or the CLI ever names a PHI-adjacent target. Defensive; the golden set should never need this.
const PHI_DENY = /\b(medreview|phi\b|patient|diagnos|medication|prescrib|hipaa|audiogram|hearing\s*number)\b/i;

/** Exit-code policy (pure, unit-tested): mirrors azure-canary.mjs's pageExitCode(summaryOk, strict)
 *  EXACTLY -- strict mode pages (exit 1) only on a real regression past the baseline SLO; report-only
 *  mode (no --strict/RECALL_EVAL_STRICT) never pages on a regression, it only ever writes the
 *  ::warning:: + PostHog event (the durable trend). A genuine can't-run failure (the golden set is
 *  missing/malformed, or a required write fails) is a SEPARATE class handled by the outer catch
 *  handler below, which -- like azure-canary's -- pages UNCONDITIONALLY (a dark sensor cannot certify
 *  anything, so it must not stay quiet just because --strict was omitted from a manual run). */
export function pageExitCode(regressed, strict) { return strict && regressed ? 1 : 0; }

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
  const rawLines = (child.stdout || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && !l.startsWith("##"));
  // GROUP raw stdout lines into one entry per retrieved memory (semantic.mjs renders each hit as 2-3
  // lines: header/text/tags). Without this, a line-based --k cutoff silently evaluates only the first
  // ~k/2.5 hits instead of the top-k retrieved memories (see scoring.mjs's groupHitLines doc comment
  // for the full story -- this was a real miscalibration found 2026-07-17 that made ~40% of the
  // original golden set MISS regardless of actual recall quality). The keyword engine is hard-
  // deprecated (mem.mjs recall always exits 1), so grouping only matters for the semantic path today;
  // applying it unconditionally is harmless for keyword's (currently unreachable) output too.
  const lines = groupHitLines(rawLines);
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
  console.log(STRICT
    ? `\nSTRICT MODE: a hit@${K} drop past the baseline SLO tolerance will page (non-zero exit).`
    : `\nREPORT-MODE: measurement only. No ledger writes. Never exits non-zero on a low score (pass --strict to page).`);

  const scorecard = { engine: ENGINE, k: K, n: agg.n, hitRate: agg.hitRate, mrr: agg.mrr, meanPrecisionAtK: agg.meanPrecisionAtK, latencyMeanMs: Math.round(meanLat), runErrors, recordedAt: new Date().toISOString() };

  // BASELINE regression check on hit@K (the blunt "did recall get worse" signal) -- the baseline IS the
  // SLO: this run's hit@K must not drop more than --tolerance below the last recorded baseline. Always
  // prints an ::warning:: on regression (the durable trend); exits non-zero ONLY with --strict/--enforce
  // (see pageExitCode below) -- the SAME convention azure-canary.mjs uses so a real regression makes the
  // nightly run RED instead of writing to a dashboard nobody watches.
  let regressed = false;
  if (BASELINE_PATH) {
    let baseline = null;
    try { baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8")); } catch { /* missing/malformed -> no gate */ }
    if (baseline && typeof baseline.hitRate === "number" && (baseline.n || 0) > 0) {
      const delta = agg.hitRate - baseline.hitRate;
      regressed = delta < -TOLERANCE;
      console.log(`\n## BASELINE SLO (${BASELINE_PATH}): hit@${K} ${fmtPct(baseline.hitRate)} -> ${fmtPct(agg.hitRate)} (delta ${(delta * 100).toFixed(1)}pp; tolerance ${(TOLERANCE * 100).toFixed(0)}pp)`);
      if (regressed) console.log(`  ::warning:: RECALL REGRESSION: hit@${K} dropped ${(-delta * 100).toFixed(1)}pp below the baseline SLO.${STRICT ? " STRICT: this run will exit non-zero (paging)." : ""}`);
      else console.log(`  OK: within tolerance.`);
    } else {
      console.log(`\n## BASELINE SLO (${BASELINE_PATH}): no usable baseline yet (n=0) -- seed it with --update-baseline.`);
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

  // Report-mode default: exit 0 even on a low score / regression. --strict (or --enforce, or
  // RECALL_EVAL_STRICT=1) turns a regression PAST THE BASELINE SLO into a non-zero exit -- the pager.
  process.exit(pageExitCode(regressed, STRICT));
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) main().catch(async (e) => {
  // DARK SENSOR: the check could not run at all (malformed/PHI-flagged golden set, a required write
  // failed, etc). Mirrors azure-canary.mjs's fatal handler EXACTLY: exit 1 UNCONDITIONALLY, regardless
  // of --strict, with a clear ::error:: message -- a monitor that cannot run cannot certify recall
  // quality, so it must not stay quiet just because report-mode was requested. Best-effort PostHog emit
  // so the outage itself is in the same durable trend as a real regression.
  try { await emitPosthog("recall_eval_fatal", { error: e.message, strict: STRICT }); } catch { /* best-effort */ }
  console.error(`::error::[recall-evals] FATAL (dark sensor): ${e.message}`);
  process.exit(1);
});
