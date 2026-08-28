#!/usr/bin/env node
// embedding-drift-monitor — lightweight recall-quality monitor over the fleet's memory indexes (Azure
// GenAIOps #13 "Phoenix" pattern, done cost-neutrally on our existing stack: no new vendor, no new
// spend, reuses the same search + embeddings + PostHog + credential-resolution primitives every other
// memory skill already uses).
//
// BACKEND (CORRECTED 2026-08-28 — see FND-20260819-c9bb): Azure AI Search + Azure OpenAI died with
// subscription 55c84f6b (permanently deleted 2026-08-13); this file's `initClients()` used to throw
// unconditionally on missing azure-search-endpoint/-admin-key, regardless of what the caller actually
// wanted, which left the whole recall-drift monitor dark. SEARCH_BACKEND=azure|opensearch (env, default
// now OPENSEARCH) and EMBEDDINGS_PROVIDER=foundry|openai (env, default now OPENAI) — the SAME env var
// names/values/semantics as skills/kb-memory/semantic.mjs's own dispatcher (INDEPENDENT switches, since
// a genuine Azure outage takes Foundry down too and SEARCH_BACKEND=opensearch alone would still reach
// Azure via embed() otherwise). The port mirrors semantic.mjs exactly: same config resolution
// (opensearch-write.mjs's resolveOpenSearchConfig/resolveOpenAIKey), same AWS SigV4 `es`-service
// signing, same embedding model/dimension (text-embedding-3-large, 3072 dims) — a drop-in for the
// already-live OpenSearch memory-exec/ring indexes, not a re-embed. The azure/foundry branches remain
// as dead code behind an explicit, non-default override (SEARCH_BACKEND=azure /
// EMBEDDINGS_PROVIDER=foundry) for anyone who still needs them; see semantic.mjs's own header for the
// full credential-resolution rationale.
//
// WHAT IT DOES: for each memory index (memory-exec, the per-ring private indexes, and any future
// commons-<agent>-memory index), runs a small set of CANNED probe queries (skills/embedding-drift-
// monitor/probes.json), records:
//   - topScore:  the @search.score of the #1 hit (semantic/vector relevance strength)
//   - coverage:  fraction of probes that returned at least one hit at all (is the index "empty" for
//                a query it should know about?)
//   - hitCount:  average hits returned across probes
// then compares those numbers to the LAST recorded run (persisted in drift-baseline.json, mirroring
// agent-evals/baseline.json), flags DRIFT when topScore or coverage drops meaningfully, emits an
// `embedding_drift` event per index to PostHog (so the trend lives next to eval_result and the rest of
// fleet telemetry), and prints Datadog-friendly lines (the gateway already ships APM; this rides the
// same stdout->log pipeline rather than standing up a second observability path).
//
// THIS IS A MONITOR, NOT A GATE, FOR DRIFT — BUT IT FAILS LOUD IF IT CANNOT RUN AT ALL. Once probing
// starts, a drifted index never fails CI (a `::warning::` annotation only) — same report-first posture
// agent-evals uses, same eventual path to alerting on a threshold once trusted. But if the search/
// embeddings backend itself cannot be resolved (initClients() throws: no OpenSearch credentials, no
// OpenAI key, or the equivalent azure-branch failure) the process exits NON-ZERO with a distinct
// "FATAL" message — this is deliberately NOT folded into the same always-exit-0 path a per-probe
// hiccup gets, because a monitor that reports "0 drifted" when it never actually reached the backend is
// a silent-success bug (the exact class documented in claude-tools/CLAUDE.md's "fleet-wide durable
// lessons" section), not a quiet monitor.
//
// Usage:
//   node drift.mjs                      # probe every index in probes.json, print + compare to baseline
//   node drift.mjs --index memory-exec  # probe one index only
//   node drift.mjs --emit               # also emit embedding_drift events to PostHog
//   node drift.mjs --json out.json      # write a structured report (for CI artifact upload)
//   node drift.mjs --write-baseline     # after reviewing, persist this run as the new baseline
//
// Credentials self-resolve (env -> AWS SSM -> Azure Key Vault, cheapest/most Azure-independent first;
// see opensearch-write.mjs's header) — no required env var for the default OpenSearch/OpenAI path in a
// fleet seat/job that already carries ambient AWS credentials. GCP_CLAUDE_DRIVER_SA_JSON is needed only
// for the non-default SEARCH_BACKEND=azure/EMBEDDINGS_PROVIDER=foundry override, or for `--emit`'s
// posthog-fleet-ingest-key lookup, both of which still go through kvSecret()'s own fallback chain.
import crypto from "node:crypto";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { kvSecret } from "../kb-memory/azure-secret.mjs";
import * as OS from "../kb-memory/opensearch-write.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SM = "otchealth-shared-prod";
const AIS_API = "2023-11-01";
const BASELINE_PATH = join(HERE, "drift-baseline.json");

const argv = process.argv.slice(2);
const takeVal = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const ONLY_INDEX = takeVal("--index", "");
const EMIT = argv.includes("--emit");
const JSON_OUT = takeVal("--json", "");
const WRITE_BASELINE = argv.includes("--write-baseline");
// Drift thresholds: a topScore drop > TOPSCORE_DROP or a coverage drop > COVERAGE_DROP vs baseline
// flags that index as drifted. Conservative defaults tuned to be a real signal, not noise (AI Search
// relevance scores fluctuate run-to-run; these are absolute, not percentage, deltas).
const TOPSCORE_DROP = Number(takeVal("--topscore-drop", "")) || 0.15;
const COVERAGE_DROP = Number(takeVal("--coverage-drop", "")) || 0.2;
// Read ONCE at module load (matches semantic.mjs's own SEARCH_BACKEND/EMBEDDINGS_PROVIDER convention,
// and this file's own TOPSCORE_DROP/COVERAGE_DROP pattern above).
const SEARCH_BACKEND = (process.env.SEARCH_BACKEND || "opensearch").toLowerCase(); // 'opensearch' (default since 2026-08-28; Azure AI Search died with sub 55c84f6b) | 'azure'
const EMBEDDINGS_PROVIDER = (process.env.EMBEDDINGS_PROVIDER || "openai").toLowerCase(); // 'openai' (default since 2026-08-28; Azure Foundry died with sub 55c84f6b) | 'foundry'

function saRaw() {
  if (process.env.GCP_CLAUDE_DRIVER_SA_JSON) return process.env.GCP_CLAUDE_DRIVER_SA_JSON;
  try { return readFileSync(`${homedir()}/.gcp_claude_driver_sa.json`, "utf8"); } catch { return null; }
}
function saJwt(scope) {
  const __r=saRaw();if(!__r){return null;}let sa;try{sa=JSON.parse(__r);}catch{return null;}if(!sa||!sa.private_key){return null;}
  const now = Math.floor(Date.now() / 1000);
  const e = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const i = `${e({ alg: "RS256", typ: "JWT" })}.${e({ iss: sa.client_email, scope, aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 })}`;
  return i + "." + crypto.createSign("RSA-SHA256").update(i).sign(sa.private_key, "base64url");
}
async function sm(id) { const _kv = await kvSecret(id); if (_kv != null) return _kv;
  const r0 = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${encodeURIComponent(saJwt("https://www.googleapis.com/auth/cloud-platform"))}` });
  const t = (await r0.json()).access_token;
  const r = await fetch(`https://secretmanager.googleapis.com/v1/projects/${SM}/secrets/${id}/versions/latest:access`, { headers: { Authorization: `Bearer ${t}` } });
  if (!r.ok) return null;
  return Buffer.from((await r.json()).payload.data, "base64").toString("utf8").trim();
}

let AIS_EP, AIS_KEY, AOAI_EP, AOAI_KEY, AOAI_DEP;
// Exported so a test can exercise the backend dispatch directly (mirrors semantic.mjs's own exported
// init(), same rationale: a test proves the OpenSearch/OpenAI path is genuinely reachable with ZERO
// Azure calls, not merely that a branch exists in the source).
export async function initClients() {
  if (SEARCH_BACKEND === "opensearch") {
    await OS.resolveOpenSearchConfig(); // throws a clear, distinct message if truly unresolvable; never touches azure-search-*
  } else {
    AIS_EP = (await sm("azure-search-endpoint") || "").replace(/\/$/, "");
    AIS_KEY = await sm("azure-search-admin-key");
    if (!AIS_EP || !AIS_KEY) throw new Error("missing azure-search-endpoint/admin-key");
  }
  if (EMBEDDINGS_PROVIDER === "openai") {
    await OS.resolveOpenAIKey(); // throws a clear, distinct message if truly unresolvable; never touches azure-openai-*
  } else {
    AOAI_EP = ((await sm("azure-foundry-openai-endpoint")) || (await sm("azure-openai-endpoint")) || "").replace(/\/$/, "");
    AOAI_KEY = (await sm("azure-foundry-key")) || (await sm("azure-openai-key"));
    AOAI_DEP = (await sm("azure-openai-embedding-deployment")) || "text-embedding-3-large";
    if (!AOAI_EP || !AOAI_KEY) throw new Error("missing azure-openai endpoint/key");
  }
}
// Exported alongside initClients (same rationale). Single-string-in, single-flat-vector-out — the exact
// contract probeIndex() already relies on; only the OpenAI-direct call is new, the azure fallback branch
// is byte-identical to before.
export async function embed(text) {
  if (EMBEDDINGS_PROVIDER === "openai") { const [vec] = await OS.embedOpenAI([text]); return vec; }
  for (let a = 0; a < 6; a++) {
    const r = await fetch(`${AOAI_EP}/openai/deployments/${AOAI_DEP}/embeddings?api-version=2024-02-01`, { method: "POST", headers: { "api-key": AOAI_KEY, "Content-Type": "application/json" }, body: JSON.stringify({ input: [text] }) });
    if (r.status === 429) { await new Promise(s => setTimeout(s, 1500 * (a + 1))); continue; }
    if (!r.ok) throw new Error("embed " + r.status + " " + (await r.text()).slice(0, 120));
    return (await r.json()).data[0].embedding;
  }
  throw new Error("embed 429 exhausted");
}
// Exported alongside initClients/embed. OS.hybridSearch() already returns hits shaped exactly like the
// azure branch's `.value` array (agent/type/ts/text/tags/retracted/"@search.score" — see
// opensearch-write.mjs's hybridSearch() doc comment), so probeIndex() needs no branching on which
// backend produced them.
export async function searchIndex(index, query, vec) {
  if (SEARCH_BACKEND === "opensearch") return OS.hybridSearch(index, { queryText: query, vector: vec, top: 5 });
  const body = { search: query, top: 5, vectorQueries: [{ kind: "vector", vector: vec, fields: "contentVector", k: 5 }] };
  const r = await fetch(`${AIS_EP}/indexes/${index}/docs/search?api-version=${AIS_API}`, { method: "POST", headers: { "api-key": AIS_KEY, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`search ${index} ${r.status} ${(await r.text()).slice(0, 160)}`);
  return (await r.json()).value || [];
}

/**
 * probeIndex(index, queries, { embed, search }) -> { index, probes, topScore, coverage, hitCount }
 * Pure-ish: takes injected embed/search fns so it's unit-testable without live Azure calls.
 * - topScore: average of each probe's #1 hit @search.score (0 when a probe returns no hits).
 * - coverage: fraction of probes that returned >=1 hit.
 * - hitCount: average number of hits per probe.
 * Fail-safe per probe: a single probe's error is recorded (score 0, hits 0) and does not abort the index.
 */
export async function probeIndex(index, queries, { embed: embedFn, search: searchFn }) {
  const probes = [];
  for (const q of queries) {
    try {
      const vec = await embedFn(q);
      const hits = await searchFn(index, q, vec);
      const top = hits[0] ? (Number(hits[0]["@search.score"]) || 0) : 0;
      probes.push({ query: q, topScore: top, hitCount: hits.length, ok: true });
    } catch (e) {
      probes.push({ query: q, topScore: 0, hitCount: 0, ok: false, error: e.message });
    }
  }
  const n = probes.length || 1;
  const topScore = probes.reduce((s, p) => s + p.topScore, 0) / n;
  const coverage = probes.filter((p) => p.hitCount > 0).length / n;
  const hitCount = probes.reduce((s, p) => s + p.hitCount, 0) / n;
  return { index, probes, topScore, coverage, hitCount, probedAt: new Date().toISOString() };
}

/**
 * compareDrift(current, baseline, opts) -> { index, drifted, reasons[], line }
 * current/baseline: { topScore, coverage } shaped objects (as probeIndex / drift-baseline.json produce).
 * A missing baseline for this index is reported as "no baseline" (never flagged as drift).
 */
export function compareDrift(current, baseline, opts = {}) {
  const topscoreDrop = Number.isFinite(opts.topscoreDrop) ? opts.topscoreDrop : 0.15;
  const coverageDrop = Number.isFinite(opts.coverageDrop) ? opts.coverageDrop : 0.2;
  const reasons = [];
  if (!baseline) {
    return { index: current.index, drifted: false, hasBaseline: false, reasons, line: `${current.index}: no baseline yet (topScore ${current.topScore.toFixed(3)}, coverage ${(current.coverage * 100).toFixed(0)}%) — seeding` };
  }
  const dScore = current.topScore - baseline.topScore;
  const dCov = current.coverage - baseline.coverage;
  if (dScore < -topscoreDrop) reasons.push(`topScore dropped ${(-dScore).toFixed(3)} (>${topscoreDrop})`);
  if (dCov < -coverageDrop) reasons.push(`coverage dropped ${(-dCov * 100).toFixed(0)}pp (>${(coverageDrop * 100).toFixed(0)}pp)`);
  const drifted = reasons.length > 0;
  const line = `${current.index}: topScore ${current.topScore.toFixed(3)} (Δ${dScore >= 0 ? "+" : ""}${dScore.toFixed(3)}), coverage ${(current.coverage * 100).toFixed(0)}% (Δ${dCov >= 0 ? "+" : ""}${(dCov * 100).toFixed(0)}pp)` + (drifted ? ` — DRIFT: ${reasons.join("; ")}` : " — OK");
  return { index: current.index, drifted, hasBaseline: true, reasons, line };
}

async function emitToPostHog(reports) {
  const key = await sm("posthog-fleet-ingest-key");
  if (!key) { console.error("embedding-drift-monitor: no posthog-fleet-ingest-key, skipping emit"); return; }
  for (const r of reports) {
    await fetch("https://us.i.posthog.com/capture/", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: key, event: "embedding_drift", distinct_id: r.index, timestamp: new Date().toISOString(),
        properties: { index: r.index, top_score: r.topScore, coverage: r.coverage, hit_count: r.hitCount, drifted: !!r.drift?.drifted, drift_reasons: r.drift?.reasons || [] },
      }),
    });
  }
}

function loadProbes() {
  const raw = JSON.parse(readFileSync(join(HERE, "probes.json"), "utf8"));
  delete raw._comment;
  return raw;
}
function loadBaseline() {
  if (!existsSync(BASELINE_PATH)) return {};
  try { return JSON.parse(readFileSync(BASELINE_PATH, "utf8")); } catch { return {}; }
}

async function main() {
  const probesByIndex = loadProbes();
  const indexes = ONLY_INDEX ? [ONLY_INDEX] : Object.keys(probesByIndex);
  if (!indexes.length) { console.error("no indexes to probe (check probes.json)"); process.exit(2); }

  await initClients();
  const baseline = loadBaseline();
  const reports = [];
  for (const index of indexes) {
    const queries = probesByIndex[index] || [];
    if (!queries.length) { console.error(`  ${index}: no probe queries defined, skipping`); continue; }
    process.stderr.write(`probing ${index} (${queries.length} queries)...`);
    let report;
    try {
      report = await probeIndex(index, queries, { embed, search: searchIndex });
    } catch (e) {
      console.error(` ERROR ${e.message}`);
      reports.push({ index, error: e.message, topScore: 0, coverage: 0, hitCount: 0 });
      continue;
    }
    const drift = compareDrift(report, baseline[index] || null, { topscoreDrop: TOPSCORE_DROP, coverageDrop: COVERAGE_DROP });
    report.drift = drift;
    reports.push(report);
    process.stderr.write(` done\n`);
    console.log(drift.line);
  }

  const drifted = reports.filter((r) => r.drift?.drifted);
  console.log(`\nSUMMARY: ${reports.length} index(es) probed, ${drifted.length} drifted`);
  if (drifted.length) console.log(`::warning::embedding-drift-monitor: ${drifted.map((r) => r.index).join(", ")} flagged for recall-quality drift (report-only)`);

  if (process.env.GITHUB_STEP_SUMMARY) {
    const rows = reports.map((r) => `| ${r.index} | ${r.error ? "ERROR" : r.topScore.toFixed(3)} | ${r.error ? "-" : (r.coverage * 100).toFixed(0) + "%"} | ${r.drift?.drifted ? "⚠️ DRIFT" : (r.error ? "❌" : "✅")} |`).join("\n");
    const md = [`## 🔎 Embedding Drift Monitor`, ``, `| index | topScore | coverage | status |`, `|---|---|---|---|`, rows, ``, `<sub>report-only; never blocks CI.</sub>`].join("\n");
    try { appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + "\n"); } catch { /* non-fatal */ }
  }

  if (EMIT) { await emitToPostHog(reports); console.log("emitted embedding_drift events -> PostHog Fleet Agents"); }
  if (JSON_OUT) { writeFileSync(JSON_OUT, JSON.stringify({ probedAt: new Date().toISOString(), reports }, null, 2)); console.log(`wrote drift report -> ${JSON_OUT}`); }
  if (WRITE_BASELINE) {
    const next = { ...baseline };
    for (const r of reports) { if (!r.error) next[r.index] = { topScore: r.topScore, coverage: r.coverage, hitCount: r.hitCount, recordedAt: r.probedAt }; }
    writeFileSync(BASELINE_PATH, JSON.stringify(next, null, 2));
    console.log(`wrote updated baseline -> ${BASELINE_PATH}`);
  }
  process.exit(0); // MONITOR, not a gate: never fail the run, even on drift.
}

const isMain = (() => {
  try { return process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]; } catch { return false; }
})();
// FAIL LOUD, distinct from the report-only drift path: this catch fires ONLY when the monitor could
// not even START (initClients() threw — no OpenSearch credentials, no OpenAI key, the equivalent azure-
// branch failure, or a probes.json read failure) — never for "some index drifted" or "one probe query
// errored", both of which main() already handles internally and still exits 0 for (see the header
// comment above). Exit code 2 matches this file's OWN existing "no indexes to probe" config-error exit
// inside main() — a distinct, non-zero, greppable signal that the run never produced a real report, so
// a cron/CI job watching the exit code cannot mistake "could not run" for "ran clean, zero drift".
if (isMain) { main().catch((e) => { console.error("embedding-drift-monitor: FATAL (could not run — backend/embeddings config unresolvable): " + e.message); process.exit(2); }); }

export default { probeIndex, compareDrift, initClients, embed, searchIndex };
