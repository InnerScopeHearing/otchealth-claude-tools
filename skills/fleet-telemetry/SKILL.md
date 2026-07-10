---
name: fleet-telemetry
description: Agent LLM observability into PostHog. Parses a Claude Code session transcript and emits per-session telemetry (cost, tokens, model, tool usage, errors, duration per agent) plus $ai_generation events to the PostHog Fleet Agents project (479484), the $50k-credit observability lane (not Datadog). Turns the agent fleet from a black box into a measurable system. Wire it as an auto Stop hook. Part of Fleet Intelligence #1. Non-PHI ring; metadata only, never prompt/response contents or PHI/MNPI.
---

# fleet-telemetry — agent LLM observability into PostHog

Emits per-session agent telemetry to the **PostHog "Fleet Agents" project (479484)** , the
$50k-credit observability lane (not Datadog). Turns the agent fleet from a black box into a
measurable system: cost, tokens, model, tool usage, errors, and duration per agent per session.

## What it sends (metadata only — no prompts, outputs, file contents, PHI or MNPI)
- `$ai_generation` (PostHog **LLM Observability** product): model, input/output tokens, latency, est cost,
  `callsite_id` (defaults to the agent role; `--callsite <id>` overrides).
- `agent_session` (custom analytics): agent, callsite_id, turns, tool_calls, tools_used, tool_errors, tokens, est_cost_usd, duration_s, outcome.

`callsite_id` is the join key against `agent-evals`' `eval_result.callsite_id` (same default: the agent
role). It is substrate for a future quality-per-dollar router that would join eval scores to real
production model/cost by callsite; that full router (a live PostHog query wired into dispatch) is NOT
built here.

## Model routing: `task-router.mjs`
`classifyTask(text, hints?)` is the pure text-based model/budget classifier (opus/sonnet/haiku) that
`compute-allocator` already calls on every fan-out dispatch. `classifyTaskWithHistory(text, hints?)`
is a small superset that adds the ONE thing pure text can't see: this callsite's own recent track
record. Pass `hints.priorFailureRate` (e.g. `1 - passed/total` for this `callsite_id` from an
agent-evals scorecard or `eval-gate.mjs`'s `baseline.json`) and/or `hints.lastRunFailed` (bool); a bad
rate or a failed last run escalates one tier above whatever `classifyTask` picked (never downgrades,
never exceeds opus, `forceModel` still wins). No network, no PostHog query — the caller supplies the
history as plain data, same fail-open/pure discipline `compute-allocator` uses for `recentSignals`.
Self-test: `node skills/fleet-telemetry/task-router.mjs --test` (7 example (task, history) pairs, no
live LLM calls). Unit tests: `tests/task-router.test.mjs`.

## Automatic
Wired as a **Stop hook** (`.claude/settings.json`) so every agent session auto-reports on end.
Reads `KB_AGENT` for attribution. Exits 0 always (never blocks a session). The skill installs to
`~/.claude/skills` via session-start.sh, so to roll out to another agent repo, add this one line to
that repo's `.claude/settings.json` Stop hook:
`node "$CLAUDE_PROJECT_DIR/skills/fleet-telemetry/telemetry.mjs" session-end`

## Manual / backfill
`echo '{"transcript_path":"<x.jsonl>","session_id":"..."}' | KB_AGENT=cto node telemetry.mjs session-end`

## Where to look
PostHog -> Fleet Agents project -> **LLM Observability** (traces + spend) and Insights on the
`agent_session` event (cost-per-agent, tool-failure rate, sessions over time). Keys in Secret
Manager: `posthog-fleet-project-id`, `posthog-fleet-ingest-key` (phc_, publishable).
