---
name: recall-evals
description: Recall-quality eval harness for kb-memory AND the fleet's recall-quality SLO pager. Runs a golden set of known durable, non-PHI facts through the existing recall path (semantic.mjs vector recall), scores precision@k, hit-rate, and MRR, records latency, and prints a scorecard. Measurement-only by default (never writes to any ledger or memory); with --strict / --enforce / RECALL_EVAL_STRICT=1 a hit@K drop past the recorded baseline SLO EXITS NON-ZERO so a real recall-quality regression PAGES instead of sitting in a dashboard nobody watches (same --strict convention as skills/azure-canary). Also includes a DEEP-MODE eval (run-deep-evals.mjs, exercises the gateway's brain_search mode:'deep' agentic path specifically) and a HARD-NEGATIVE / contrastive eval (mine-hard-negatives.mjs + run-hard-negative-evals.mjs, mines real supersedes pairs from the ledger and asserts a retracted/superseded belief does not leak back into results). Use to measure and tune memory/recall changes with data instead of vibes, and as the nightly regression pager. Non-PHI ring; PHI-excluded by a hard guard (refuses to run if the golden set or a target agent lane looks PHI-adjacent); the hard-negative miner is additionally MNPI-excluded (agent allowlist + keyword deny).
---

# recall-evals -- measure recall quality, and PAGE when it regresses

## Why this exists
Every future change to kb-memory recall (ranking, chunking, the semantic ranker, a new store) needs
a before/after number, not a vibe check. This harness gives the fleet that number: a golden set of
QUERY -> EXPECTED-SUBSTRINGS pairs drawn from facts that are ALREADY durably recorded in the shared
ledger, run through the real recall path, scored, and (in `--strict` mode) turned into a PAGE the
moment hit@K drops below the recorded baseline SLO.

**This tool never mutates memory.** It never calls `remember` / `decision` / `correct` / `pitfall` /
`status` / `entity set`. It only calls `recall` (a read verb). A run of this harness writes zero
bytes to any ledger, private lane, or the shared exec feed -- the ONLY file it ever writes is its own
`baseline.json` (and only with `--update-baseline`, an explicit opt-in).

## Files
- `golden-set.json` -- 43 `{id, query, agent, engine, expect, note}` items (11 hand-authored `gs-*` +
  32 mined-and-validated `gm-*`/`gm-cto-*`/`gm-coo-*`). `expect` is a list of substrings; a returned
  hit counts as relevant if it contains ANY of them (case-insensitive). `agent` MUST be the real
  originating lane the fact was written to (`cto`/`coo`/`cco`/`developer`/`commons`/...) -- see the
  2026-07-17 fix below for why this matters more than it sounds like it should.
- `scoring.mjs` -- PURE scoring core, **no IO** (no fetch/fs/network/credentials/env reads):
  `precisionAtK`, `hitAtK`, `reciprocalRank`, `aggregate`, `groupHitLines`. Unit-tested in isolation
  (`tests/recall-evals-scoring.test.mjs`).
- `run-evals.mjs` -- the runner. Shells out to the EXISTING recall verb (`kb-memory/semantic.mjs
  recall`; the keyword engine, `kb-memory/mem.mjs recall`, is HARD-DEPRECATED and always exits 1 as of
  2026-07-10) for each golden item, measures wall-clock latency, groups the CLI output into one entry
  per retrieved memory, feeds it into the scoring core, and prints a scorecard. Exports the pure
  `pageExitCode(regressed, strict)` (tests: `tests/recall-evals-pager.test.mjs`).
- `mine-cases.mjs` -- generates + validates new hard cases from a real agent's ledger (see below).

## Run
Via the kb-memory wrapper, so the claude-driver SA is injected the same way every other octools
skill authenticates (see `skills/kb-memory/run.sh`):
```
bash skills/kb-memory/run.sh node skills/recall-evals/run-evals.mjs                    # semantic recall, k=5, report-only
bash skills/kb-memory/run.sh node skills/recall-evals/run-evals.mjs --k 3 --json        # different cutoff + JSON dump
bash skills/kb-memory/run.sh node skills/recall-evals/run-evals.mjs --set /path/other.json           # a different golden set
bash skills/kb-memory/run.sh node skills/recall-evals/run-evals.mjs --baseline baseline.json --strict # PAGE on a real regression
```
Prints one HIT/MISS/ERR row per query (precision@k, reciprocal rank, latency), then a SUMMARY block
(mean precision@k, hit-rate, MRR, latency mean/p50/p95). `--json` additionally dumps a machine-
readable scorecard for pasting into a PR comment or a dashboard ingestion step.

## Metrics
- **precision@k** -- of the top-k retrieved memories, what fraction are relevant (contain an expected
  substring). Penalizes noisy results even when a relevant one is present.
- **hit-rate@k** -- did AT LEAST ONE relevant memory appear in the top-k? The blunt "did recall work
  at all" signal, and the ONE the `--strict` pager gates on (the baseline IS the SLO).
- **MRR (mean reciprocal rank)** -- rewards relevant results appearing EARLY (1/rank of the first
  hit, averaged across queries, 0 if never found). Sensitive to ranking quality, not just recall.
- **latency** -- wall-clock per query (mean/p50/p95), including the recall call's own network/auth
  overhead, so this doubles as a coarse regression check for recall-path latency creep.

## THE HARD PAGE (W1-4, 2026-07-17): `--strict` / `RECALL_EVAL_STRICT=1`
`run-evals.mjs --baseline baseline.json --strict` compares this run's hit@K to the recorded
`baseline.json` (the SLO). A drop of more than `--tolerance` (default 0.05 = 5pp) prints `::warning::`
+ emits `recall_eval_regression` to PostHog **and now also exits 1** -- the SAME `--strict` /
`*_STRICT=1` exit-code convention `skills/azure-canary/canary.mjs` uses, via the exported pure
`pageExitCode(regressed, strict)`:
- no `--strict` (default): always exits 0, even on a real regression -- report-only, safe for a manual
  or local run.
- `--strict` (or `--enforce`, kept as a back-compat alias, or `RECALL_EVAL_STRICT=1`): a regression past
  the baseline SLO tolerance exits 1, so the nightly workflow (`.github/workflows/nightly-recall-eval.yml`,
  which now runs WITHOUT `continue-on-error`) goes RED and pages.
- **Dark sensor**: if the check cannot run at all (malformed/PHI-flagged golden set, a required write
  fails), the outer catch handler exits 1 **unconditionally** -- regardless of `--strict` -- mirroring
  azure-canary's fatal handler exactly (a monitor that cannot run cannot certify recall quality, so it
  must not stay quiet just because report-mode was requested).

## TWO MISCALIBRATIONS FOUND + FIXED (2026-07-17) -- read this before trusting an old baseline number
Before wiring the pager, the existing "0.333 hit@5 baseline" (quoted verbatim in
`dream-team/AI-OS-OPERATING-SOP.md` as if it were a real health number) was investigated and found to
be an artifact of two bugs, NOT a real recall-quality measurement. Both are now fixed; the corrected,
freshly-mined 43-item set scores **hit@5 = 100%, MRR = 0.753, precision@5(mean) = 37.1%** (see
`baseline.json`), and now has real room to regress and page.
1. **The `agent` filter mismatch.** 12 of the original 18 golden items were tagged `"agent": "commons"`
   and `run-evals.mjs` passes that straight through as a hard Azure AI Search filter
   (`semantic.mjs recall ... --agent commons`). But `commons.jsonl` (the shared exec-feed file
   `_MEMORY/_exec/commons.jsonl`) holds only **3 rows** (all FourVault build-status chatter from
   2026-06-25) -- the CTO/COO/CCO facts those 12 items actually quoted live in `cto.jsonl` (679 rows),
   `coo.jsonl` (121 rows), and `cco.jsonl` (31 rows). Filtering to `commons` searched almost nothing, so
   those 12 items MISSED permanently regardless of actual recall quality (verified live: every one of
   them HITS once retagged to its real originating lane). This also means the earlier `gm-013..096`
   mined cases -- despite being auto-validated at mine time -- were ALSO mined entirely from that same
   3-line commons.jsonl corpus (`mine-cases.mjs --agent commons`'s corpus source), so they only ever
   tested recall of 2-3 sentences, not a representative sample of the fleet's memory. FIX: retagged each
   `gs-*` item to its real agent (verified live per item, see golden-set.json notes), dropped `gs-10`
   (below), and mined 26 NEW cases directly against the real `cto`/`coo` lanes (`gm-cto-*`/`gm-coo-*`).
   **When mining or hand-authoring a new case, always target the fact's REAL originating agent lane, not
   `commons`** -- `commons` is a real but nearly-empty pseudo-lane, not "the shared view of everything."
2. **Line-based scoring vs. hit-based scoring.** `semantic.mjs recall()` renders each hit as 2-3 stdout
   lines (a `[agent] [type] date (score ...)` header, the text, and an optional `tags:` line).
   `run-evals.mjs` fed every raw stdout line into `precisionAtK`/`hitAtK` with a line-based cutoff `k` --
   so "top-5" silently meant "the first ~2 retrieved memories" (5 lines / ~2.5 lines-per-hit), not the 5
   documents the search actually returned. A memory genuinely retrieved at rank 3-5 would MISS purely
   because of text density, not recall quality. FIX: `scoring.mjs`'s new `groupHitLines()` groups raw
   output into one array entry per retrieved memory before scoring (used by both `run-evals.mjs` and
   `mine-cases.mjs`'s `validate()`, so mining and evaluation agree on what "top-K" means).
3. **`gs-10` ("GitHub is the wrong substrate...") was DROPPED in #369, then FIXED + RESTORED 2026-07-17.**
   Its source fact (`cto` id `20260701-044`, present in `cto.jsonl` verbatim) was provably absent from
   the `memory-exec` index: a direct lookup on its expected doc id (`cto__20260701-044`) returned a
   DIFFERENT row (an unrelated `20260701-044`-id AWS-access decision), because two distinct ledger
   entries collided on the same generated id and `semantic.mjs reindex()`'s skip-if-already-indexed
   upsert silently kept only the first (18 such suppressed facts measured fleet-wide). ROOT CAUSE:
   `nextId()` historically produced un-salted 2-segment ids, so different entries could share one; it
   now appends a random salt. THE FIX (`semantic.mjs assignDocIds()`): entries whose base key
   `agent__id` collides get a `__<contentHash>` suffix so each distinct fact is indexed separately (the
   unique common case keeps its bare key, so the ~4.7k healthy docs are untouched), and reindex prunes
   the now-duplicate bare key AFTER upserting the replacements. Live reindex re-indexed both facts and
   the gs-10 pitfall is now recallable at rank 1, so the case was restored to the golden set as a
   regression guard. See `tests/semantic-docid.test.mjs` (`assignDocIds` cases).

## Extending the golden set
Prefer `mine-cases.mjs` (below) over hand-authoring: it generates a paraphrased query (tests semantic
recall, not keyword overlap) AND validates the candidate HITS against the live recall path before
keeping it, so a mined case can never be dead weight the way the pre-fix `gs-*` items were. If hand-
authoring, add an item with a `query`, the fact's REAL originating `agent` lane (verify with
`node skills/kb-memory/semantic.mjs recall "<near-verbatim query>" --agent <lane>` that it actually
comes back), and `expect` substrings taken verbatim from that real, already-shared, non-PHI ledger
entry. Never add a query or expected substring that touches PHI/patient/diagnosis/medication/audiogram/
hearing-number/medreview content -- the runner hard-refuses (throws before making any call) if it
detects one, as a defense-in-depth backstop on top of kb-memory's own `RING_DENY` regex.

### `mine-cases.mjs` -- generate + VALIDATE hard cases from a real agent's ledger
For each real fact it asks Azure OpenAI (credit-funded gpt-4o) for a PARAPHRASED query (low lexical
overlap -> tests SEMANTIC recall, not keyword) plus verbatim `expect` substrings, then keeps ONLY cases
the current `semantic.mjs recall` HITS@5 (via the same `groupHitLines`-corrected scoring) -- so every
committed case is answerable-by-current-recall and a future recall regression MISSES it (a meaningful
tripwire, not noise). Re-runnable to grow the set; merges with (never drops) the existing set.
```
node mine-cases.mjs --agent cto --target 20 --out golden-set.json    # mine against a REAL, populous lane
node mine-cases.mjs --agent coo --target 10 --out golden-set.json
```
`--agent commons` is the CLI default for back-compat but is a POOR mining target (see miscalibration #1
above -- only 3 rows). Target a real, populous exec lane (`cto`, `coo`, `cco`, `developer`, ...) instead.
IDs are namespaced by lane to avoid collisions across separate mining runs (`gm-cto-NNN`, `gm-coo-NNN`);
the original undifferentiated `gm-NNN` ids predate this convention and were mined against `commons`.
`--corpus-file <facts.json>` feeds a big pre-dumped corpus (the tail view is capped) --
`node mine-cases.mjs --agent cto --target 90 --corpus-file corpus.json`.

## `.github/workflows/nightly-recall-eval.yml`
Nightly 06:45 UTC, secretless OIDC (same pattern as nightly-eval.yml / nightly-azure-canary.yml), runs
`run-evals.mjs --emit --baseline baseline.json --tolerance 0.05 --strict`. No `continue-on-error`: a
real regression (or a dark-sensor fatal) now makes the job RED, so the PostHog trend + the `::warning::`
+ the CI failure ARE the alert -- not a dashboard nobody watches.

## ITEM 5.3 (Wave 5, AI-OS recall-quality pass, 2026-07-21/22): TWO NEW, INDEPENDENT eval dimensions
The suite above (the golden set + `run-evals.mjs`) tests exactly ONE thing: the local, non-deep
`semantic.mjs recall` path's hit@5. Two real blind spots existed alongside it, closed by this item.

### (a) DEEP-MODE eval -- `run-deep-evals.mjs` + `gateway-deep-client.mjs` + `baseline-deep.json`
The gateway's `brain_search` tool also supports `mode:'deep'`: an LLM-planned, multi-round agentic
retrieval (plan sub-queries -> search -> one bounded refine round if thin -> synthesize a cited
answer; see `otchealth-mcp-server` `src/memory/deep-retrieval.ts`). The existing suite NEVER calls the
gateway and NEVER passes `mode:'deep'`, so a regression specific to that pipeline (a broken plan-JSON
parse, a refine round that never fires, a synthesis prompt that stops citing, or -- as measured below
-- the planner narrowing to the WRONG room) would be entirely invisible to it.
- `gateway-deep-client.mjs` -- `callDeepBrainSearch(token, query, opts)` calls the LIVE gateway
  (`mcp.otchealth.app`) via the SAME lane-token mint every other gateway-calling skill in this repo
  uses (`skills/gateway-connect/connect.mjs`'s `mintToken(lane)`, default lane `cto`). Its pure half,
  `parseDeepToolResponse()`, guards a real, ledger-documented pitfall: a gateway MCP tool's actual
  structured result lives at `result.structuredContent.result`, NOT `result.content[0].text` (that
  text field is `JSON.stringify(data) + "\n\n" + a human summary sentence` -- NOT valid JSON on its
  own). Fixture-tested in `tests/recall-evals-deep-client.test.mjs` against the real observed shape.
- `run-deep-evals.mjs` -- runs a deterministic, evenly-spaced SUBSET of the same golden-set queries
  (`--limit 15` default; `sampleEvenly()` is pure + unit-tested) through `mode:'deep'`, scores
  hit@K/precision@K/MRR on the returned `matches` (reusing `scoring.mjs`'s pure functions unchanged
  against `matches[].text`), PLUS one deep-mode-only signal: **answer-grounded rate** -- does the
  LLM-SYNTHESIZED `answer` text itself contain the grounded fact (`hard-negative-scoring.mjs`'s
  `answerMatches()`), not just retrieve it. Same `--baseline`/`--strict`/`--tolerance`/`--emit`/`--json`
  flags and the exact same `pageExitCode()` exit policy as `run-evals.mjs` (imported, not
  reimplemented). Cost-bounded by `--limit` + `--concurrency` (default 3) because EVERY query spends
  one or more Foundry calls + a live gateway round trip (~5-11s/query observed).
- **A GENUINE FINDING from the first live measurement (baseline-deep.json, 2026-07-22, n=15,
  lane=cto):** hit@5 = **26.7%**, precision@5 = 14.7%, MRR = 0.200, answer-grounded rate = 13.3% --
  dramatically lower than the fast-path baseline's ~97.7%. Root-caused live (not guessed): on the MISS
  for `gs-03` ("contradiction staleness signal radar detector"), deep mode's PLANNER narrowed
  `rooms_searched` down to `['commons-company-journal']` ONLY, silently dropping `memory-exec` (where
  the actual golden fact lives) even though the cto lane is permitted to search it. This is NOT a bug
  in this eval; it is deep mode's planner room-narrowing feature (`deep-retrieval.ts`'s `planQuery()`)
  confidently excluding the room that had the ground truth -- a real, reportable characteristic of the
  current implementation, not something this eval quietly patched over. `baseline-deep.json` was
  seeded from this real, live-measured run (not invented), so it becomes the honest starting SLO: a
  FUTURE drop below it now has real room to page, and a future fix to the planner's room-selection
  heuristic should show up here as a genuine improvement.
- Wired into `.github/workflows/nightly-recall-eval-deep.yml` (its own schedule, `05 07 * * *` UTC,
  right after the fast/hard-negative job) rather than folded into `nightly-recall-eval.yml`, because
  its LLM-cost/latency profile does not belong sharing that job's tight timeout with two cheap,
  local-only checks. Same `--strict` pager convention, `page-on-failure.mjs`, PostHog `recall_eval_deep`
  emit, and schedule-liveness heartbeat (`nightly-recall-eval-deep` in `setup/heartbeat-registry.json`).

### (b) HARD-NEGATIVE (contrastive) eval -- `mine-hard-negatives.mjs` + `hard-negative-scoring.mjs` + `hard-negative-set.json` + `run-hard-negative-evals.mjs` + `baseline-hardneg.json`
The golden set only ever asks "did a relevant memory show up." It never asks the mirror-image
question: "did a SUPERSEDED, semantically-similar-but-now-WRONG memory on the exact same topic stay
correctly SUPPRESSED." `semantic.mjs`'s retraction filter (`computeRetractedIds`/`filterHygiene`; the
gateway's `filterRetracted()`) is what is supposed to guarantee that -- but a future reindex bug or a
dropped `filterRetracted()` call would leave the golden set looking perfectly healthy (the current
fact is usually still findable on its own merits) while a retracted, wrong belief silently leaks back
into results. That is exactly the failure mode this eval pages on.
- **Mining methodology (real pairs, never hand-invented):** `mine-hard-negatives.mjs` reads the WHOLE
  shared exec feed (`otchealthcommons/company-journal/_MEMORY/_exec/*.jsonl` -- the EXACT corpus
  `semantic.mjs` indexes into `memory-exec`), pure-resolves every row whose `supersedes` points at
  another row in that same corpus (`resolveSupersedePairs()`), then applies a chain of pure safety +
  quality filters (`isEligiblePair()`): an AGENT ALLOWLIST (never mines from `cfo`/`clo`/
  `clo-personal`/`exec`/`capital`/`commerce`/`cro`/`compliance`/`rainmaker` -- this file is committed
  to the repo, so finance/legal/MNPI-adjacent content is excluded by construction, not just by
  keyword), an `MNPI_DENY` keyword deny (defense in depth on top of the allowlist) plus the existing
  `PHI_DENY` vocabulary, an exhaust-type check (the NEW fact must not be a `status`/`episode`/
  `heartbeat`/`digest` row recall already excludes by default), and a jaccard-similarity BAND
  (`dedupe.mjs`'s existing `tokenize`/`jaccard`, reused not reimplemented) that rejects both
  near-duplicate maintenance-log chatter (a real corpus pattern found: "Batch tagging progress: N of
  853 memories tagged..." scored jaccard 0.83 between consecutive entries) and likely-unrelated
  cross-topic id collisions (one found at jaccard 0.000). Each eligible pair is then sent to Azure
  OpenAI (the fleet's `TIERS.standard` model-routing tier, see `setup/model-routing.mjs`) for a
  paraphrased query + verbatim `expect_new`/`expect_old` substrings, and VALIDATED against the LIVE
  `semantic.mjs recall` path before being kept -- exactly `mine-cases.mjs`'s "every committed case is
  answerable-by-current-recall" discipline, extended with the negative half a hard-negative case needs
  (the old/retracted substrings must NOT appear).
- **Why only `supersedes` pairs, not the `correction`-type `was` field:** a `correct --was "<wrong>"`
  entry stores the wrong belief as an inline STRING on ONE row; `semantic.mjs`'s `reindex()` only
  embeds/selects each row's `text` field, never `was` -- so a `was` string can never itself leak back
  as a competing retrieved document. Only a resolvable `supersedes` link creates TWO independently
  retrievable documents, which is what a genuine "old vs new, which one surfaces" test needs.
- **Real yield (2026-07-22 mining run, `hard-negative-set.json`):** of 39 resolvable `supersedes`
  pairs in the live corpus, 4 passed every safety + quality filter, and 3 validated end-to-end
  (`hn-001` iHEARtest Build 47 shipped-vs-not-shipped; `hn-002`/`hn-003` a 3-generation fleet-backup
  correction chain and the iHEARtest release-state staleness case). The 4th eligible pair was tried and
  REJECTED (the LLM's chosen `expect_new` substring did not hit live recall) -- proof the
  validate-before-keep step is a real filter, not a rubber stamp. Re-runnable
  (`node mine-hard-negatives.mjs --target N --out hard-negative-set.json`) to grow the set as the
  ledger accumulates more corrections; it merges with (never drops) the existing file.
- `run-hard-negative-evals.mjs` runs entirely against the LOCAL `semantic.mjs recall` path (no LLM
  calls at eval time -- that cost was already spent once, at mining time), scoring three numbers per
  run (`hard-negative-scoring.mjs`, pure, mirrors `scoring.mjs`'s style): **correct-rate** (the current
  fact found), **leak-rate** (the retracted fact reappeared -- want this near 0), and **PASS-rate**
  (found AND leak-free -- the SLO this harness pages on). `baseline-hardneg.json` was seeded from a
  real live run (n=3, 100% correct-rate / 0% leak-rate / 100% PASS-rate -- expected, since every kept
  case was already proven to pass at mining time; the value is as a FUTURE regression tripwire, not as
  evidence about today).
- Cheap (no LLM calls at eval time), so it runs as an EXTRA STEP inside the existing
  `nightly-recall-eval.yml` job/schedule (same `--strict` pager convention, same `page-on-failure.mjs`
  call now attaching both logs, PostHog `recall_eval_hardneg` emit) rather than a separate workflow.

## Guardrails
- **No ledger writes, ever.** Only mutates its own `baseline*.json` files, and only with
  `--update-baseline`. `mine-hard-negatives.mjs` reads the shared exec feed with a **READ-ONLY** SAS
  (`sp=rl`) -- it can never write to the ledger it mines from.
- **Report-only by default; a pager with `--strict`.** Pair with `agent-evals` (the task-quality judge
  harness) for a broader quality signal; this harness is specifically about RETRIEVAL, not answer quality.
- **PHI-excluded** (all four eval scripts + both miners). The hard-negative mining path is ALSO
  MNPI-excluded (agent allowlist + `MNPI_DENY` keyword deny), because it reads a broader,
  cross-agent corpus than `mine-cases.mjs`'s single-named-agent tail and that corpus includes
  finance/legal/securities-adjacent lanes this file must never touch.
- **No new infra for the golden-set/hard-negative paths.** They reuse the existing `semantic.mjs
  recall` transport and the kb-memory SA-injection wrapper. The deep-mode path is the one deliberate
  exception: it calls the LIVE gateway over its existing OAuth `client_credentials` lane-token flow
  (`gateway-connect/connect.mjs`, already used elsewhere in this repo) -- no new credential path, but a
  new network dependency (the gateway itself), which is why it is gated behind its own `--limit` /
  separate workflow rather than folded into the always-cheap local checks.
