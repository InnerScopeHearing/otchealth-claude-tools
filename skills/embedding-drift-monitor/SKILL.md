---
name: embedding-drift-monitor
description: Lightweight recall-quality monitor over the fleet's Azure AI Search memory indexes (memory-exec + the per-ring private indexes + any commons-<agent>-memory index). Samples canned probe queries on a schedule, records top-score/coverage per index, compares to a recorded baseline, and emits embedding_drift events to PostHog. Report-only monitor (never blocks CI); mirrors agent-evals' nightly baseline pattern for a different question ("is memory recall silently degrading" vs "is answer quality regressing").
---

# embedding-drift-monitor — recall-quality drift monitor for the memory indexes

## The gap this closes
Azure GenAIOps pattern #13 (the "Phoenix" observability pattern: continuously sample retrieval quality so embedding/index drift is caught before it silently degrades every agent that recalls through it) applied cost-neutrally on our own stack — no new vendor, no new spend. We already run 14+ Azure AI Search indexes feeding `company-brain`, `kb-memory`/`semantic.mjs`, and `ring-memory-index` (memory-exec, legal-personal-memory, finance-cfo-memory, and any newer `commons-<agent>-memory` per-agent index). None of those had a quality trend line: if an index goes stale (bad reindex, embedding model swap, an empty container after a bug), the only symptom is agents quietly recalling nothing useful — no alert, no signal.

This adds a thin **read-only** monitor: canned probe queries per index, sampled on a schedule, scored by two cheap-but-real recall proxies (top hit's `@search.score`, and coverage = fraction of probes that returned any hit at all), trended against a recorded baseline.

## Run
```
node skills/embedding-drift-monitor/drift.mjs                       # probe every index in probes.json
node skills/embedding-drift-monitor/drift.mjs --index memory-exec   # one index only
node skills/embedding-drift-monitor/drift.mjs --emit                # also emit embedding_drift -> PostHog
node skills/embedding-drift-monitor/drift.mjs --json out.json       # structured report (CI artifact)
node skills/embedding-drift-monitor/drift.mjs --write-baseline      # persist this run as the new baseline (review first)
```
Needs `GCP_CLAUDE_DRIVER_SA_JSON` (the claude-driver SA every memory skill uses); everything else self-resolves from Secret Manager (`azure-search-endpoint`, `azure-search-admin-key`, `azure-(foundry-)openai-endpoint/-key`, `posthog-fleet-ingest-key` for `--emit`).

## Onboarding a new index
Add a key + 3-8 representative probe queries to `probes.json`. That's the whole integration — `drift.mjs` discovers indexes from that file's keys, so a new `commons-<agent>-memory` index (or any future ring index) is onboarded with a one-line JSON addition, no code change. Keep probes topic-level/generic (never real PHI/PII/MNPI content) since they live in the repo and their scores get logged.

## What it measures (and what it deliberately does NOT do)
- **topScore**: average `@search.score` of each probe's #1 hit. A sustained drop suggests the index's embeddings/content no longer match what agents are actually asking — worth investigating (stale reindex? embedding model changed? content moved?).
- **coverage**: fraction of probes returning *any* hit. A drop toward 0 usually means the index emptied out or a reindex job silently failed.
- Deliberately NOT a judge-based groundedness/precision score (that's what agent-evals' LLM-judge harness already does for *answer* quality) — this is a cheap, fast, non-LLM proxy purely for *retrieval* health, so it can run far more often without burning judge-model budget.

## Drift thresholds (tunable, conservative by default)
`--topscore-drop 0.15` (absolute) and `--coverage-drop 0.2` (20 percentage points) vs the recorded baseline. AI Search relevance scores are noisy run-to-run; these are set to catch real degradation, not sampling jitter. Flip with flags per-run if a specific index needs a tighter/looser bar.

## Report-only by design (mirrors nightly-eval.yml)
`drift.mjs` **always exits 0**, even when every index drifted — this is a monitor, not a gate (unlike `agent-evals/eval-gate.mjs`, which is designed to optionally block). It prints a `::warning::` annotation and a Step Summary table on drift so a human sees it, and (with `--emit`) writes `embedding_drift` events to PostHog next to `eval_result`, so both trend lines live in the same dashboard. If retrieval-quality gating is ever wanted, layer it the same way `eval-gate.mjs` layers onto `nightly-summary.mjs` — this module's `compareDrift()` is already the pure, unit-tested primitive a future gate would call.

## Scheduling
Wired via `.github/workflows/nightly-embedding-drift.yml`, mirroring `nightly-eval.yml` exactly: daily cron (06:45 UTC, just after the eval baseline's 06:30 UTC run), `workflow_dispatch` for manual testing, `continue-on-error: true` on the probe step, and a scorecard/log artifact upload. No merge-blocking, no required status check. Before relying on it, run `node skills/embedding-drift-monitor/drift.mjs --write-baseline` once by hand (or let the first scheduled run seed `drift-baseline.json` — a missing/empty baseline is never flagged as drift, only reported as "seeding") so the first real comparison has something to compare against.

## API
```js
import { probeIndex, compareDrift } from "./drift.mjs";
const report = await probeIndex("memory-exec", ["query 1", "query 2"], { embed, search }); // injected fns, testable offline
const drift = compareDrift(report, baseline.memory-exec, { topscoreDrop: 0.15, coverageDrop: 0.2 });
```
