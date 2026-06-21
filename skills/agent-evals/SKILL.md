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
- `node run-evals.mjs` (all) | `--agent cto` | `--task <id>` | `--emit` (to PostHog)
- Exit code is non-zero if any task fails -> CI-gateable.

## Tasks
`evals/<agent>.json` = array of `{id, agent, task, rubric:[criteria...]}`. Pass threshold 0.7.
Tasks mirror REAL fleet decisions (CTO OOM diagnosis + PHI wall; CFO entity scoping; CLO privilege
+ securities firewall). Add a task whenever a new failure mode or rule appears.

## The eval -> improve loop (proven 2026-06-21)
First run surfaced the CTO persona as too thin (0% on OOM-diagnosis + PHI-wall). Enriching the
persona brief with those behaviors took CTO from 1/3 to 3/3. That is the flywheel: measure, find
the gap, fix the instructions, re-measure.

## Fidelity upgrade (when ready)
v1 runs the persona on gpt-4o (credits) so it measures the INSTRUCTIONS. For true model-fidelity
(measure the actual Claude agent), add an `anthropic-api-key` and set `AGENT_MODEL`, and load the
real dream-team agent definitions instead of the short persona briefs.
