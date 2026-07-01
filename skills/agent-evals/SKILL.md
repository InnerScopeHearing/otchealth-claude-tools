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

## The eval -> improve loop (proven 2026-06-21)
First run surfaced the CTO persona as too thin (0% on OOM-diagnosis + PHI-wall). Enriching the
persona brief with those behaviors took CTO from 1/3 to 3/3. That is the flywheel: measure, find
the gap, fix the instructions, re-measure.

## Fidelity upgrade (when ready)
v1 runs the persona on gpt-4o (credits) so it measures the INSTRUCTIONS. For true model-fidelity
(measure the actual Claude agent), add an `anthropic-api-key` and set `AGENT_MODEL`, and load the
real dream-team agent definitions instead of the short persona briefs.
