---
name: agent-evals
description: Golden-task evaluation harness for the agent fleet. For each golden task it runs an agent persona (Azure OpenAI gpt-4o, credit-funded) to produce an answer, scores it with an LLM-as-judge against an explicit rubric, prints a scorecard, and (with --emit) sends eval_result events to the PostHog Fleet Agents project. Use to measure agent quality, gate it in CI, and catch quality regressions across roles (CTO/CFO/CLO). Part of Fleet Intelligence #1. Non-PHI ring; tasks and outputs carry no PHI/MNPI.
---

# agent-evals — golden-task eval harness for the agent fleet

Measures agent quality and catches regressions. For each golden task: run the agent's persona on
the task (Azure OpenAI gpt-4o, credit-funded) to produce an answer, then score it with an
LLM-as-judge against an explicit rubric. Outputs a scorecard and (with `--emit`) sends
`eval_result` events to the PostHog Fleet Agents project, so eval scores sit next to fleet-telemetry.

## Run
- `node run-evals.mjs` (all) | `--agent cto` | `--task <id>` | `--emit` (to PostHog) | `--json <path>`
  (write a structured scorecard, used by the CI prompt-regression gate)
- Exit code is non-zero if any task fails -> CI-gateable.

## Tasks
`evals/<agent>.json` = array of `{id, agent, task, rubric:[criteria...], callsite_id?, prompt_file?}`.
Pass threshold 0.7. `callsite_id` identifies which real prompt surface the task exercises (defaults to
`agent` when untagged); it is the join key a later quality-per-dollar router would use against
fleet-telemetry's `$ai_generation`/`agent_session` events (also callsite_id-tagged). Tasks mirror REAL
fleet decisions (CTO OOM diagnosis + PHI wall; CFO entity scoping; CLO privilege + securities firewall;
company-brain citation/abstention; kb-memory reflect distillation; focus-group-loop persona honesty).
Add a task whenever a new failure mode or rule appears.

## CI prompt-regression gate (report-only, phase 1)
`.github/workflows/promptcheck.yml` runs this suite twice on a PR that touches a prompt-bearing file
(a SKILL.md, `evals/**`, or a Dream Team governance charter), once at the PR base and once at the PR
head, same judge model, and posts a scorecard-diff PR comment via `promptcheck.mjs`. REPORT-ONLY BY
DESIGN: it comments, never blocks merge, is never a required check, and does not auto-promote or
auto-roll-back a prompt. Covers 6 surfaces today: company-brain synthesis, kb-memory reflect
distillation, and the CTO/CFO/CLO personas, plus focus-group-loop. PHI/MNPI/clo-personal lanes are
out of scope (no MedReview, no INND/Xero/Plaid, no clo-personal golden tasks).

## Self-repair (north-star loop items #1 REVERT + #3 REWRITE, report-only phase 1)
`selfrepair.mjs` closes the detect->fix->verify loop on top of the gate above. Item #1's revert path
adds NO new store, field, or model call; it reuses `promptcheck.mjs`'s exported `diffScorecards()` so
its proposal and the gate's own comment can never disagree about what regressed.
- `node selfrepair.mjs plan --base <base.json> --head <head.json> [--base-sha <sha>] [--out md] [--json plan.json]`
  computes the AUTO-REPAIRABLE regressions (a regressed golden task whose `prompt_file` is known),
  groups them by file (one revert fixes every task sharing that file), picks the biggest-drop
  `primary`, and renders a "Proposed self-repair" block (the exact `git checkout <base-sha> -- <file>`
  revert + a re-run command). Report-only: touches no git, opens no PR, ALWAYS exits 0. It is wired
  into `promptcheck.yml` to append its proposal to the PR comment.
- `node selfrepair.mjs rewrite --base <base.json> --head <head.json> [--base-sha <sha>] [--head-sha <sha>] [--offline] [--out md] [--json proposal.json]`
  (north-star loop item #3) graduates the FIX side from a blunt revert to a **gpt-5.1 REWRITE proposal**:
  for the primary regressed prompt file it reads the base + head prompt text and the SPECIFIC failed
  rubric criteria and proposes a MINIMAL rewrite of the regressed hunk that recovers those criteria WHILE
  KEEPING the improvement the PR intended (it does not throw away the PR's change like a revert does).
  REPORT-ONLY: it prints a clearly DRAFT-ONLY proposal, edits no file, touches no git, opens no PR, and
  ALWAYS exits 0. The gpt-5.1 call is behind an injectable function so the pure core `proposeRewrite()` is
  unit-testable offline; `--offline` (or no SA in env) skips the network and emits a well-formed abstaining
  proposal. The pure exports are `proposeRewrite({regression, basePromptText, headPromptText, failedRubric})`,
  `buildRewritePrompt(...)`, and `reRunFullSuiteCmd(agent)`. gpt-4.1-mini is BANNED for this synthesis; the
  rewrite uses the fleet `quality` tier (gpt-5.1) via `setup/model-routing.mjs`.
- `node selfrepair.mjs draft ... --execute` is HARD-GATED (also needs env `SELFREPAIR_EXECUTE=1`):
  only then does it create a fix branch off the PR head, restore the regressed prompt file(s) to their
  base content (revert mode, item #1), and open a **DRAFT** PR via the fleet-bot GitHub App. It NEVER
  marks ready and NEVER merges; a human always acks. Dormant (not wired into any workflow) until a
  graduation step, tested against a real live regression, turns it on. Without both gates it is a dry-run.
  `draft --mode rewrite` is graduation-gated further: per the design's risk #1 (a rewrite can overfit the
  one regressed task while silently breaking a DIFFERENT, untested rubric criterion), the draft path MUST
  first re-run the FULL agent eval suite (`reRunFullSuiteCmd(agent)` = `node run-evals.mjs --agent <a>
  --json <out>`, never a single `--task`) and confirm NO NEW regression before opening the draft PR. In
  v1 `draft --mode rewrite` prints that mandatory sequence rather than auto-applying an unverified edit.
- Regressions with no `prompt_file` are reported as SKIPPED with a reason (tag the task to enable),
  never silently dropped. A rewrite with no `prompt_file` or no failed rubric ABSTAINS (a first-class safe
  outcome, never a fabricated hunk). Tests: `selfrepair.test.mjs` (revert), `selfrepair-rewrite.test.mjs`
  (rewrite; all model calls are injected fakes, no live network).

## The eval -> improve loop (proven 2026-06-21)
First run surfaced the CTO persona as too thin (0% on OOM-diagnosis + PHI-wall). Enriching the
persona brief with those behaviors took CTO from 1/3 to 3/3. That is the flywheel: measure, find
the gap, fix the instructions, re-measure.

## Fidelity upgrade (when ready)
v1 runs the persona on gpt-4o (credits) so it measures the INSTRUCTIONS. For true model-fidelity
(measure the actual Claude agent), add an `anthropic-api-key` and set `AGENT_MODEL`, and load the
real dream-team agent definitions instead of the short persona briefs.

## Multi-judge panel + calibration (north-star self-improving-loop wave, item B, report-only)
`judgepanel.mjs` closes a gap in the single-judge gate above: run-evals.mjs's `judge()` asks ONE model
to score a rubric, so that model's idiosyncrasies (harsh, lenient, or flat wrong on one criterion)
become the gate's only signal. `judgepanel.mjs` adds a small PANEL of 2-3 judges drawn from
`setup/model-routing.mjs` TIERS (default: quality + standard + cheap - never a hardcoded deployment
id), aggregates their scores into one more-robust `panel_score`, and reports panel AGREEMENT (a
confidence signal: "high"/"medium"/"low"/"unscored") so a reader can tell a well-agreed score apart
from a coin-flip. It also CALIBRATES that panel_score against a human-labeled golden set
(`golden-set.json`: `{id, panel_score, human_score, note}` pairs) via a monotone piecewise-linear
curve, so the reported score tracks what a human reviewer would actually say.
- PURE core (unit-testable, no network/fs): `aggregatePanel(judgeRows)`, `confidenceLabel(agreement,
  nJudgesSurviving)`, `buildCalibration(goldenPairs)`, `calibrate(panelScore, calibration)`,
  `attachPanelToResult(result, panel, calibration)`. `resolvePanelTiers(tierNames)` resolves tier names
  via model-routing (never invents a deployment id).
- IO shim: `runJudgePanel(judgeFn, task, rubric, answer, {tiers})` calls a caller-supplied judge
  function once per tier and tolerates a single judge erroring out (drops it, does not fail the whole
  panel) - `judgeFn` is where a caller (e.g. a future small patch to run-evals.mjs) would wire in its
  existing Azure OpenAI `chat()`/`judge()` helpers per tier; this module performs no network I/O itself.
- `attachPanelToResult` is PURELY ADDITIVE: it never overwrites `score`/`pass` (the existing
  single-judge gate's verdict, unchanged); it only adds `panel_score`, `calibrated_score`, `agreement`,
  `confidence`, `judge_tiers` fields a caller may fold into the scorecard or a PR comment.
- REPORT-ONLY / advisory by design, same as the rest of this wave: no exit-code effect, not wired into
  `promptcheck.yml`'s gate, no new external service (same Azure OpenAI/Foundry endpoint, different
  tiers), NO ledger writes.
- `node judgepanel-cli.mjs calibration-report [--golden golden-set.json] [--out report.md]` is a
  pure-data (no network) CLI that prints the fitted calibration curve + its mean absolute error against
  the golden set, so the calibration's own trustworthiness can be reviewed before it is ever applied to
  a live scorecard.
- Tests: `judgepanel.test.mjs` covers panel aggregation (mean, agreement math, errored-judge exclusion),
  confidence labeling, calibration fitting (monotonicity under noisy labels, duplicate-bucket
  averaging, identity curve with no data), and the additive-only invariant on `attachPanelToResult`.
