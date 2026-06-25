---
name: fleet-dispatch
description: Directed agent-to-agent hand-off so a human never relays between agents. Any agent DISPATCHES a message or task straight to another agent's durable INBOX, and the target agent auto-surfaces it at its next SessionStart (the proven fleet-medic delivery pattern), so a hand-off lands with ZERO copy-paste from the operator. Two modes - ASYNC (default, zero Max-plan draw): the message queues and the target reads it next time it runs; --spawn (opt-in, draws the shared Max weekly limit): also triggers the Tier-2 autonomous runner to spin up a headless target session NOW to execute the task. Non-PHI coordination channel only; never dispatch MNPI/PHI/privileged content. Fail-open on read paths.
---

# fleet-dispatch — stop being the relay between your agents

The answer to "I shouldn't have to copy the CTO's answer over to the developer." Agents run as separate
sessions, so there is no live channel between them; this gives them a durable, auto-delivered one.

## How it works
- `send` writes a directed entry to the target agent's inbox `otchealthcommons/company-journal/_DISPATCH/<to>.jsonl`.
- The target agent's **SessionStart hook** (`kb-inject.sh` -> `dispatch.mjs check`) surfaces every pending
  message ONCE at the top of its next session, then clears the inbox (ack). That is how the hand-off
  reaches the agent with no operator relay.
- Delivery modes:
  - **ASYNC (default):** zero Max-plan draw. The message waits in the inbox; the target reads it the next
    time it runs. This is what removes the relay.
  - **`--spawn` (opt-in):** ALSO triggers the Tier-2 autonomous runner (`autonomous-run.yml`, authed by
    the live `CLAUDE_CODE_OAUTH_TOKEN`) to spin up a headless target session NOW that executes the task.
    Draws the shared Max WEEKLY limit, so it is per-dispatch opt-in, never the default. The task text
    rides as the workflow input (the least-privilege runner has no Secret Manager, so it never reads the
    inbox). To spawn an agent that works on a specific APP, that app repo must carry `autonomous-run.yml`
    (`--repo <app>`); otherwise the spawn runs in claude-tools (repo-scoped, least privilege).

## Verbs
```
node skills/fleet-dispatch/dispatch.mjs send <to> "<message/task>" [--from <a>] [--task] [--spawn [--repo <app>] [--minutes N]]
node skills/fleet-dispatch/dispatch.mjs check --agent <self>     # surface + ACK this agent's inbox (wired into SessionStart)
node skills/fleet-dispatch/dispatch.mjs list [--agent <a>]       # operator view of pending dispatches
```

## Guardrails
Non-PHI coordination channel. Do NOT dispatch MNPI (INND securities), PHI, or clo-personal/privileged
content; route those in their own rings. The inbox is delete-after-read (low-volume hand-offs); a sender
re-dispatches if needed. Fail-open: `check` never blocks or breaks a session.
