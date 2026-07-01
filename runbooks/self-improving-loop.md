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

### Item #2 — Contradiction + staleness scan = Signal Radar detector #6  ✅ SHIPPED 2026-07-01 (PR #268, 6b88ac8)
`skills/signal-radar/detectors/contradiction-staleness.mjs`, report-mode, LIVE in the signal-radar cron
(image rebuilt runId ccm; live job run Succeeded). Simplified from the design to add NO new infra and
never touch the mem.mjs write path: computes a coarse deterministic entity-key AT SCAN TIME (reuses
mem.mjs normKey over a closed ~40-term vocab + secret-id tokens), reads the shared exec feed read-only
(SAS sp=rl). Cost HARD-bounded: 7-day window (CONTRADICTION_WINDOW_DAYS) + same-entity slice capped at
<=20 (MAX_CANDIDATES) + <=40 gpt-5.1 entailment calls/scan (CONTRADICTION_MAX_LLM_CALLS) + a
no-silent-truncation note. Grounding gate discards any verdict citing a row not in the slice; only
"contradict"/"stale-with-material-drift" fire. PHI-excluded + MNPI-routed on BOTH the new row and every
prior row before any text reaches the LLM. EMITS a Signal (suggested_action DRAFTS the exact
`mem.mjs correct ...` for a human) and NEVER writes the ledger. Adversarially verified (SHIP_WITH_NITS;
the one nit - a stray non-object feed line - was fixed with a filter guard + regression test, 21 tests).
First live scan: 0 contradictions across 40 examined of 328 recent claims (fleet memory is consistent).
GRADUATION (per design): watch the cto inbox 1-2 weeks, tune the entity vocab/prompt against real false
positives; only same-STRING entities today (synonym/transitive contradictions are the deferred graph).

### Item #3 — Graduate self-repair to gpt-5.1 rewrite alternatives  ✅ SHIPPED 2026-07-01 (PR #269, 1b118bd)
`skills/agent-evals/selfrepair.mjs` extended: `proposeRewrite()` (pure, injected LLM) + a REPORT-ONLY
`rewrite` CLI that proposes a gpt-5.1 minimal rewrite of the regressed prompt hunk (never edits files,
touches git, or opens a PR). `reRunFullSuiteCmd(agent)` renders the mandatory WHOLE-suite re-run
(shell-injection-safe) that any future draft must pass (no NEW regression) - the overfit guard from the
design's risk #1. The draft path stays hard-gated (--execute + SELFREPAIR_EXECUTE=1) and draft-only;
never auto-merges. Adversarially verified SHIP (12 tests; item #1's 8 still green). gpt-5.1, never mini.

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
