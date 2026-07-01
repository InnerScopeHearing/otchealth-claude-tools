---
name: recall-evals
description: Recall-quality eval harness for kb-memory. REPORT-MODE / MEASUREMENT ONLY -- runs a golden set of known durable, non-PHI facts through the existing recall path (mem.mjs keyword recall or semantic.mjs vector recall), scores precision@k, hit-rate, and MRR, records latency, and prints a scorecard. Never writes to any ledger or memory, never exits non-zero on a low score. Use to measure and tune memory/recall changes with data instead of vibes. Non-PHI ring; PHI-excluded by a hard guard (refuses to run if the golden set or a target agent lane looks PHI-adjacent).
---

# recall-evals -- measure recall quality, change nothing

## Why this exists
Every future change to kb-memory recall (ranking, chunking, the semantic ranker, a new store) needs
a before/after number, not a vibe check. This harness gives the fleet that number: a small golden set
of QUERY -> EXPECTED-SUBSTRINGS pairs drawn from facts that are ALREADY durably recorded in the
shared ledger, run through the real recall path, and scored.

**This tool is pure measurement.** It never calls `remember` / `decision` / `correct` / `pitfall` /
`status` / `entity set`. It only calls `recall` (a read verb). A run of this harness writes zero
bytes to any ledger, private lane, or the shared exec feed.

## Files
- `golden-set.json` -- ~12 `{id, query, agent, engine, expect, note}` items. `expect` is a list of
  substrings; a returned recall line counts as relevant if it contains ANY of them (case-insensitive).
  Facts are drawn from real, already-shared, non-PHI exec-feed entries (decisions/facts/pitfalls
  visible via `mem.mjs team`), so every item is independently verifiable against the live ledger.
- `scoring.mjs` -- PURE scoring core, **no IO** (no fetch/fs/network/credentials/env reads):
  `precisionAtK`, `hitAtK`, `reciprocalRank`, `aggregate`. Unit-tested in isolation
  (`tests/recall-evals-scoring.test.mjs`).
- `run-evals.mjs` -- the runner. Shells out to the EXISTING recall verb (`kb-memory/mem.mjs recall`
  by default, or `kb-memory/semantic.mjs recall` with `--engine semantic`) for each golden item,
  measures wall-clock latency, feeds the returned lines into the scoring core, and prints a
  scorecard. **Always exits 0** -- a low score is a finding to report, never a reason to fail a gate.

## Run
Via the kb-memory wrapper, so the claude-driver SA is injected the same way every other octools
skill authenticates (see `skills/kb-memory/run.sh`):
```
bash skills/kb-memory/run.sh node skills/recall-evals/run-evals.mjs                    # keyword recall, k=5
bash skills/kb-memory/run.sh node skills/recall-evals/run-evals.mjs --engine semantic   # vector recall
bash skills/kb-memory/run.sh node skills/recall-evals/run-evals.mjs --k 3 --json        # different cutoff + JSON dump
bash skills/kb-memory/run.sh node skills/recall-evals/run-evals.mjs --set /path/other.json  # a different golden set
```
Prints one HIT/MISS/ERR row per query (precision@k, reciprocal rank, latency), then a SUMMARY block
(mean precision@k, hit-rate, MRR, latency mean/p50/p95). `--json` additionally dumps a machine-
readable scorecard for pasting into a PR comment or a dashboard ingestion step.

## Metrics
- **precision@k** -- of the top-k lines a query returns, what fraction are relevant (contain an
  expected substring). Penalizes noisy results even when a relevant one is present.
- **hit-rate@k** -- did AT LEAST ONE relevant line appear in the top-k? The blunt "did recall work
  at all" signal.
- **MRR (mean reciprocal rank)** -- rewards relevant results appearing EARLY (1/rank of the first
  hit, averaged across queries, 0 if never found). Sensitive to ranking quality, not just recall.
- **latency** -- wall-clock per query (mean/p50/p95), including the recall call's own network/auth
  overhead, so this doubles as a coarse regression check for recall-path latency creep.

## Extending the golden set
Add an item with a `query`, the `agent` lane it should be run against, and `expect` substrings taken
verbatim (or near-verbatim) from a real, already-shared, non-PHI ledger entry. Prefer facts you can
re-verify with `node skills/kb-memory/mem.mjs team --n 60` or `recall` right now, so a golden item
never silently goes stale against a fact that was superseded. Never add a query or expected substring
that touches PHI/patient/diagnosis/medication/audiogram/hearing-number/medreview content -- the runner
hard-refuses (throws before making any call) if it detects one, as a defense-in-depth backstop on top
of kb-memory's own `RING_DENY` regex.

## Guardrails
- **Report-mode only.** No ledger writes, ever. No exit-code gating on score. This is a dashboard,
  not a gate (pair it with `agent-evals` -- the task-quality judge harness -- if a hard CI gate is
  wanted later).
- **PHI-excluded.** Hard guard refuses to run against a PHI-adjacent golden item or agent lane.
- **No new infra.** Reuses the existing `mem.mjs recall` / `semantic.mjs recall` transport and the
  kb-memory SA-injection wrapper; this skill adds no new store, index, or credential path.
