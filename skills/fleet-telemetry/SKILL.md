---
name: fleet-telemetry
description: Agent LLM observability into PostHog. Parses a Claude Code session transcript and emits per-session telemetry (cost, tokens, model, tool usage, errors, duration per agent) plus $ai_generation events to the PostHog Fleet Agents project (479484), the $50k-credit observability lane (not Datadog). Turns the agent fleet from a black box into a measurable system. Wire it as an auto Stop hook. Part of Fleet Intelligence #1. Non-PHI ring; metadata only, never prompt/response contents or PHI/MNPI.
---

# fleet-telemetry — agent LLM observability into PostHog

Emits per-session agent telemetry to the **PostHog "Fleet Agents" project (479484)** , the
$50k-credit observability lane (not Datadog). Turns the agent fleet from a black box into a
measurable system: cost, tokens, model, tool usage, errors, and duration per agent per session.

## What it sends (metadata only — no prompts, outputs, file contents, PHI or MNPI)
- `$ai_generation` (PostHog **LLM Observability** product): model, input/output tokens, latency, est cost.
- `agent_session` (custom analytics): agent, turns, tool_calls, tools_used, tool_errors, tokens, est_cost_usd, duration_s, outcome.

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
