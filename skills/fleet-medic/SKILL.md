---
name: fleet-medic
description: The auto-dispatch MEDIC for the agent fleet's working memory (superbrain Wave 4). A standing monitor that watches every exec agent's memory health (the deterministic team-health shared-feed spine + the sharp PostHog memory_beacon "active-but-broken" signal) and, the moment an agent is running with its memory OFF, auto-leaves a targeted self-heal directive the agent picks up on its very next prompt, plus a medic_dispatch alert so the operator has visibility without watching. Runs on cron as a Container Apps Job AND on demand. Never cries wolf on a merely-idle agent; cools down; escalates persistent failures to the human. Non-PHI ring; reads only health metadata, never a private/clo-personal lane's content. Fail-open.
---

# fleet-medic — auto-dispatch the medic before the operator notices

The answer to Matt's ask: "before I even notice, the medic is auto-dispatched to fix an agent going
off the rails." It closes the loop on the superbrain memory program: Wave 1b made each agent's memory
health OBSERVABLE (the `memory_beacon` to PostHog + `team-health`); this wave ACTS on it automatically.

## What it does
A standing monitor scans every exec agent's memory health and auto-remediates the ones that are broken:

1. **Two health signals, each catching a different failure:**
   - **PostHog `memory_beacon`** (Fleet Agents project) = the SHARP signal. A FRESH beacon (the agent is
     active right now) with `status=DARK` / `hooks_wired=false` / `ledger_size=0` means the agent is
     running with memory OFF. That is the real "off the rails" fire -> DISPATCH.
   - **`mem.mjs team-health`** (the shared exec feed) = the DETERMINISTIC spine for all agents. Catches
     "never initialized" (NO-DATA) and long silence. Staleness alone is only a WATCH (an idle agent is
     not a broken one), so the medic NEVER cries wolf on a merely-quiet agent.
   - Degrades gracefully: if PostHog is unreadable, it still runs on the deterministic team-health spine.
2. **Auto-dispatch:** for an agent that is DARK / NO-MEMORY (past its cooldown), it writes a targeted
   self-heal directive to `otchealthcommons/company-journal/_MEDIC/<agent>.md` (generic activation
   steps, no secrets) and emits a `medic_dispatch` PostHog event.
3. **Self-heal on wake:** the agent's SessionStart hook (`kb-inject.sh` -> `medic.mjs check`) surfaces
   the pending directive ONCE, then auto-clears it. THIS is how the auto-dispatched fix reaches the
   agent (agents run in separate sessions, so the fix is left where the agent self-applies it).
4. **No spam, then escalate:** a per-agent cooldown stops re-dispatching the same agent every run; an
   agent that stays DARK across N consecutive scans ESCALATES to a single operator-facing alert
   (`_MEDIC/_ESCALATIONS.md` + a `medic_dispatch` escalation event) for a human / medic-session look.

## Verbs
```
node skills/fleet-medic/medic.mjs scan [--dispatch] [--json]   # classify every agent; --dispatch leaves directives + alerts
node skills/fleet-medic/medic.mjs check --agent <a>            # print THIS agent's pending directive (then ack/clear). Wired into kb-inject.sh
node skills/fleet-medic/medic.mjs clear --agent <a>            # manually clear an agent's directive
```

## How it runs
- **Cron (Tier-1 autonomy, zero Max-plan draw):** Container Apps Job `fleet-medic` on
  `otchealth-automation-rg`, entrypoint `skills/doc-indexer/job/fleet-medic.sh` -> `medic.mjs scan
  --dispatch`, every ~30 min. One secret: the claude-driver SA self-resolves every Azure/PostHog key.
- **On demand:** run `scan` for a live health table of the whole fleet.

## Thresholds (env-overridable on the job)
`MEDIC_BEACON_FRESH_MIN` (120) a beacon counts as "active now" only if this fresh; `MEDIC_STALE_WATCH_MIN`
(10080 = 7d) below this, silence is just "idle"; `MEDIC_COOLDOWN_MIN` (360) no re-dispatch within;
`MEDIC_ESCALATE_AFTER` (3) consecutive DARK dispatches before escalating to the human.

## Escalation posture: ALERT-ONLY (Matt decision 2026-06-25)
On escalation the medic leaves the self-heal directive + emits the `medic_dispatch` / `_ESCALATIONS`
alert. It DELIBERATELY does NOT auto-spawn a Claude (`claude -p`) session. The `CLAUDE_CODE_OAUTH_TOKEN`
is live (so a Tier-2 medic-session spawn is technically possible), but Matt chose alert-only because
auto-spawning would draw the shared Max WEEKLY limit unpredictably. DO NOT wire `scan` escalation ->
`autonomous-run.yml` dispatch; that contradicts the standing decision. A human triggers a medic-session
run on demand if a persistent escalation warrants it.

## Guardrails
Non-PHI ring. Reads only health METADATA (agent id, status, age, hook/ledger counts) + the shared feed,
never a private/clo-personal lane's content. The directive carries only generic activation steps, no
secrets. Fail-open: a medic that crashes must never be worse than no medic (every path exits 0).
