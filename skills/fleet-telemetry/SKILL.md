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

Seat attribution follows the trusted `setup/session-start.sh` contract: a per-session `KB_AGENT` pin
wins over stale company markers; without a pin, the session marker is checked before the project
marker. If a company pin conflicts with a durable marker for `clo-personal`, `medreview`, or
`companion`, telemetry fails closed before reading the transcript, resolving the SSM key, or posting
to PostHog. The hook ignores CLI seat overrides. A normal company pin and company marker continue to
use the configured per-session lane.

## What it sends (metadata only — no prompts, outputs, file contents, PHI or MNPI)
- `agent_session` (custom analytics): agent, callsite_id, assistant turns, tool calls, tools used,
  tool errors, per-model call counts, input/output tokens, cache read/write tokens, total tokens,
  duration, and outcome.
- No `$ai_generation` is emitted from this session-level source. A per-generation trace requires
  provider/API instrumentation where each real model response and its usage are available.
- No dollar-cost field is emitted. Claude Code may use a flat subscription or API billing, and public
  API price estimates are not invoices. Join session tokens/outcomes to provider billing artifacts
  for actual spend and keep subscription usage limits as a separate measure.

## Query/filter contract v1 (event schema v2)
For current session, routing-context, and cache analyses, use the exact HogQL `WHERE` expression in
`query-contract-v1.json`: `event = 'agent_session' AND properties.telemetry_schema_version = 2 AND
properties.cost_basis = 'not_observed' AND properties.agent IN ('cto', 'cfo', 'clo', 'coo', 'cpo',
'cro', 'cco', 'developer')`. This positive event/version/seat filter excludes historical
`$ai_generation` rows that represented the same whole-session transcript as a pseudo-generation.
Do not add that legacy event with an `OR` condition.

`model_counts` counts assistant transcript entries with a model label, grouped by model, including
entries without a usage object. `model_call_count` counts assistant transcript entries with a usage
object. The latter is a schema-v2 field name, not a verified provider API-call count. The measures
have different denominators and must not be substituted for each other.

`callsite_id` accepts a lowercase identifier of up to 64 letters, digits, dots, underscores, or
hyphens; an invalid value falls back to the company-seat role. `session_id` accepts only a UUID;
missing or invalid values are replaced with a generated UUID. Free-form values are not exported as
identifiers.

This event is not a cost source. `cost_basis` is `not_observed`, which does not mean zero cost.
Ignore historical `est_cost_usd`, `$ai_total_cost_usd`, and similar estimates. Actual cost must come
from provider billing artifacts. Routing analysis may use schema-v2 session tokens, model labels,
outcome, and `callsite_id` as descriptive signals, with quality results joined by `callsite_id`.
Cache analysis may sum only `cache_read_tokens` and `cache_write_tokens` from the filtered
`agent_session` cohort. Do not use legacy pseudo-generation rows or transcript-derived dollar
estimates for current routing, cache, or cost decisions.

## Cost per quality-passing task report

`cost-quality-report.mjs` is a pure adapter for already-normalized, content-free billing receipts and
fixed quality-holdout summaries. It makes no account, provider, telemetry, filesystem, or network
calls. Each subscription, API, AWS gross, Make, GitHub Actions, Depot, Copilot, Greptile, and
observability lane stays separate. AWS credit offsets are reported separately and are excluded from
gross cost. Only a dated USD `actual_charge` receipt can become a dollar cost. Token counts, platform
usage units, credits, estimates, missing receipts, duplicate receipts, and unmatched periods remain
unknown. Before/after deltas require the same holdout ID, evaluator identity and version, completed
task denominator, holdout task count, and equal-length windows. The normalized input rejects fields
outside its evidence contract, and report output omits run, holdout, evaluator, receipt, and source
identifiers. Missing lanes keep the overall cost per quality-passing task unknown. Synthetic fixtures
test these rules. Each completed-task count must equal its run's holdout task count. Overall savings
are withheld when candidate quality pass rate falls below baseline. This report does not claim a live
vendor delta until accepted account receipts and quality results are supplied.

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
