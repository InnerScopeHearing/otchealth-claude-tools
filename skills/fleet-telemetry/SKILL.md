---
name: fleet-telemetry
description: Metadata-only Claude Code session usage for explicitly allowlisted company seats in PostHog Fleet Agents (project 479484). Emits token/cache totals, model mix, tool usage, errors, duration, and outcome, but no estimated or inferred dollar cost. Protected personal-legal, PHI/service, and unknown lanes are skipped before transcript or secret access. Never sends prompt/response contents.
---

# fleet-telemetry — agent LLM observability into PostHog

Emits per-session metadata to the **PostHog "Fleet Agents" project (479484)** only for the explicit
company-seat allowlist in `telemetry.mjs` (`cto`, `cfo`, `clo`, `coo`, `cpo`, `cro`, `cco`, and
`developer`). Personal-legal, PHI/service, and unknown lanes are denied before transcript or secret
access. Keep the allowlist aligned with `setup/session-start.sh`; new lanes are not opted in automatically.
A transcript is a session aggregate, not a provider generation. One event per session avoids duplicate
event volume and false generation counts.

## What it sends (metadata only — no prompts, outputs, file contents, PHI or MNPI)
- `agent_session` (custom analytics): agent, callsite_id, assistant turns, tool calls, tools used,
  tool errors, per-model call counts, input/output tokens, cache read/write tokens, total tokens,
  duration, and outcome.
- No `$ai_generation` is emitted from this session-level source. A per-generation trace requires
  provider/API instrumentation where each real model response and its usage are available.
- No dollar-cost field is emitted. Claude Code may use a flat subscription or API billing, and public
  API price estimates are not invoices. Join session tokens/outcomes to provider billing artifacts
  for actual spend and keep subscription usage limits as a separate measure.

`callsite_id` is the join key against `agent-evals`' `eval_result.callsite_id` (same default: the agent
role). It supports quality-versus-token analysis by callsite. Actual dollar cost must come from the
provider's billing artifact, not be inferred from subscription transcript tokens.

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
PostHog -> Fleet Agents project -> Insights on the `agent_session` event (token/cache use, model
mix, tool-failure rate, duration, and sessions over time). The ingest key name is
`posthog-fleet-ingest-key`, resolved from AWS SSM Parameter Store `/otchealth/*` by the current
secret adapter.
