# Claude Chat Turn-Based Autonomy Doctrine

**Status:** Active fleet doctrine
**Author:** CTO (Claude Chat), directed by Matt
**Date:** 2026-07-16
**Applies to:** All Executive-side agents (CTO, CFO, CLO, COO, CRO) — per Matt's 2026-07-12 directive, all exec agents run exclusively on Claude Chat.

---

## The problem this solves

Observed failure (CFO seat, 2026-07-16, reported by Matt): agent operating in "autonomous mode" says *"I'll continue working on this"* at the end of a turn, then produces nothing for 10+ minutes. When prompted ("are you still working?"), it admits it was not working.

This is **not** an agent defect or a prompt-tuning issue. It is a platform constraint being papered over with a confabulated promise.

## The platform reality

A Claude Chat agent only computes **while generating a response to a message**. When the response ends:

- Execution stops completely. There is no background process, no timer, no queue it services.
- Nothing happens until the next user message (or scheduled external trigger) starts a new turn.
- Any statement of the form "I'll keep working," "I'll continue in the background," or "check back with me later" is structurally impossible to fulfill on Claude Chat. It is a hallucinated capability.

A single turn, however, **can** be long and genuinely agentic — dozens of tool calls, real infrastructure changes, verified results. Autonomy on Claude Chat means *autonomy within the turn*, never between turns.

## The fix: standard instruction block for every exec seat

Add the following verbatim to each exec agent's Project instructions:

> **Turn-based execution (platform constraint — do not violate):**
> You cannot work between messages. You have no background execution. Never say you will "continue working," "keep going in the background," or ask the operator to "check back later" — that is impossible on this platform and claiming it is dishonest. Complete the work **now, in this turn**, using as many tool calls as needed. If the task is too large for one turn, finish a discrete, verifiable unit of it, report exactly what is done and what remains, and stop cleanly. Each new message from the operator is your only opportunity to do more work — treat "continue" as the trigger for the next unit.

## Operator guidance (how Matt drives multi-turn work)

1. **Each message buys one turn of work.** "Continue" is a legitimate, cheap driver — it triggers a full new working turn. Use it as a throttle.
2. **Expect a unit-of-work report every turn:** what was completed (verified), what remains, what the next turn will do. An agent that ends a turn without that report, or with a promise of future background work, is violating this doctrine.
3. **Anything that must run unattended does not belong in Chat.** Route it to the real autonomy lanes below.

## The real autonomy lanes (for unattended work)

| Lane | What it is | Status |
|---|---|---|
| **Tier-1: Azure Container Apps Jobs** | Cron/manual jobs (daily-digest, librarians, brain-reindex, monitors). Runs on Azure credits, zero Chat involvement. | **Live** — the default for anything scheduled or unattended. |
| **Task ledger + agent_dispatch** | Durable cross-session handoff. A Chat agent creates a ledger task and dispatches to a target agent's inbox; work waits until that agent's next session wakes and claims it. | **Live** via gateway (`task_create`, `agent_dispatch`, `wake`). |
| **GitHub coding agents** | Assign an issue to anthropic-code-agent / openai-code-agent; the agent works it autonomously on GitHub's runtime and opens a PR. | **Live** (proven 2026-06-26). |
| **Tier-2: headless `claude -p`** | Timed headless Claude Code runs on the Max subscription. | Built; blocked on interactive `CLAUDE_CODE_OAUTH_TOKEN` mint. Exec seats are Chat-only regardless. |

**The pattern:** Chat agents do supervised bursts; scheduled jobs and dispatch lanes do the unattended loop.

## Regression note

If any exec agent is again observed promising background work, treat it as a doctrine regression (instruction block missing or drifted from that seat's Project), not a new finding. Check the seat's Project instructions first.
