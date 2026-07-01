# Self-improving loop (the north-star) — plan + living status

The "endgame" past the 6-phase Azure AI Operating System: the fleet detects its own quality
regressions and staleness, and proposes the fix, with a human always in the loop. Designed by a
5-architect + 4-verifier Ultracode workshop (2026-07-01); the sequence below is the verified
consensus. Discipline: every item ships REPORT/DRAFT-mode first and graduates to act only after it
proves near-zero false positives.

## Substrate it builds on (already live — do NOT re-propose)
- **prompt-regression gate**: `.github/workflows/promptcheck.yml` + `skills/agent-evals/promptcheck.mjs`
  (`diffScorecards()` exported), `run-evals.mjs` golden-task harness (scorecard carries
  `results[].prompt_file` + `callsite_id`). 6 covered non-PHI surfaces: company-brain synthesis,
  kb-memory reflect, CTO/CFO/CLO personas, focus-group-loop.
- **Signal Radar** (`skills/signal-radar/`): detector framework + Cosmos `signals` + `shouldFire`
  cooldown/escalate + `isMnpiSubject`/PHI-exclude + fleet-dispatch to owner inbox. Now a live cron.
- **Decision Clock** (`skills/decision-clock/`), **fleet-dispatch**, **fleet-bot** (15k/hr draft PRs),
  **model-routing.mjs** (`TIERS.quality`=gpt-5.1), **company-brain** diff mode, Cosmos `agent-state`.

## Sequence

### Item #1 — Prompt-regression SELF-REPAIR (DRAFT mode)  ✅ SHIPPED 2026-07-01 (PR #266, 62a850c)
`skills/agent-evals/selfrepair.mjs`. Closes detect -> fix -> verify with NO new store/field/model.
- `plan` (report-only, wired into promptcheck.yml): reuses `diffScorecards()`, computes the
  auto-repairable regressions (regressed task with a known `prompt_file`), groups by file, picks the
  biggest-drop primary, appends a "Proposed self-repair" block (exact `git checkout <base-sha> -- <file>`
  revert + re-run) to the PR comment. Regressions with no `prompt_file` are SKIPPED with a reason.
- `draft` (HARD-GATED: `--execute` AND `SELFREPAIR_EXECUTE=1`): fix branch off PR head, restore prompt
  file(s) to base, open a DRAFT PR via fleet-bot. Never ready/merge. Dormant until a graduation step
  tested against a real live regression turns it on.
- 8 unit tests (`selfrepair.test.mjs`); toolkit gate 240 green.

### Item #2 — Contradiction + staleness scan = Signal Radar detector #6  (weeks 2-3, report-mode)
Verified SOUND/BUILDABLE/SAFE. Add a deterministic entity-key field on memory rows (write-time tagger)
+ backfill; a per-agent Cosmos checkpoint (change-feed high-water-mark); ONE bounded gpt-5.1 call per
new row over a slice of at most ~20 same-entity rows (O(new facts), not O(n^2)). Inherits cooldown,
MNPI route, PHI exclusion, dispatch. Grounding gate: discard verdicts citing a row not in the slice;
only "contradict" and "stale-with-material-drift" fire; emits a Signal, NEVER writes the ledger.
Shares company-brain's primary-then-foundry-fallback throttle (contends for the same Azure OpenAI quota).

### Item #3 — Graduate self-repair to gpt-5.1 rewrite alternatives  (week 4+, still draft-only)
Beyond a plain revert: propose a rewritten prompt hunk, re-run the FULL eval suite for that agent (not
just the new task) before opening the draft PR; promptcheck.yml re-runs on the PR as a second check.

### DEFERRED — bi-temporal entity graph (valid_from/valid_to over entities/edges)
Verifier verdict sound=false: a prior superbrain panel already KILLED a standalone knowledge-graph
backend, and Wave 3 shipped the typed/keyed current-value view. Reopen ONLY with a named recurring
short-hop query justification to the panel; instrument the scan + brain diff to log question shapes first.

## Recovery note
The design workflow (`wf_21ef01f6-e86`) FAILED on the StructuredOutput 5-retry cap in its FINAL
synthesis agent (the recurring loose-schema lesson: a strict synthesis schema blows the cap). The
5 architect + 4 verifier + sequencer StructuredOutputs were salvaged from the subagent transcripts and
are the basis for this plan. Lesson reinforced: keep workflow SYNTHESIS schemas loose (few required
string fields) or make the CTO synthesize directly from the persona outputs.
