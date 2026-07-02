---
name: agent-dispatch
description: Directed, loop-safe work hand-off between fleet agents. Agent A addresses a TASK to agent B; it lands in B's GitHub-native inbox; B is auto-woken to do it (Tier B - repository_dispatch -> claude -p on the Max plan) and dispatches a reply back, which wakes A. Use when one agent needs another to do work and report back (vs the Super-Brain, which is shared PULL knowledge nobody is woken for). Loop-safe by addressee routing + a hop/TTL cap; least-privilege wakes (repo-scoped token, draft PRs); PHI/INND/personal rings are refused on the wire. Non-PHI ring. Full architecture in dream-team/AGENT-DISPATCH-SYSTEM.md.
---

# agent-dispatch

The directed PUSH layer of the fleet. The Super-Brain (kb-memory + company-brain) is shared knowledge an
agent READS; dispatch is a TASK that WAKES a specific agent to act, then routes the reply back.

## Quick use
```
# CTO hands PlantID a task (delivers to dispatch/plantid.inbox.jsonl, commits to fire the wake):
node ~/.claude/skills/agent-dispatch/dispatch.mjs send \
  --from cto --to plantid --task "Rebuild the focus-group screenshots and re-run round 4." --commit

# An agent reads its inbox, does the work, then replies (inherits the thread, hops+1):
node ~/.claude/skills/agent-dispatch/dispatch.mjs inbox --agent plantid
node ~/.claude/skills/agent-dispatch/dispatch.mjs reply --from plantid --to cto --re <id> \
  --task "Round 4 = 9.1/9.0/9.2, draft PR #NN." --commit
node ~/.claude/skills/agent-dispatch/dispatch.mjs ack --agent plantid --id <id>
```
`schema` prints the envelope; `--hub <dir>` overrides the bus location (default `dispatch/` or `$DISPATCH_HUB`).

## How the wake works (two tiers)
- Tier A (now, no new auth): a committed dispatch on a watched GitHub surface wakes any SUBSCRIBED session
  via `<github-webhook-activity>`.
- Tier B (full cold-start): the router workflow turns a push to `dispatch/<to>.inbox.jsonl` into a
  `repository_dispatch` that runs `claude -p` for the recipient (Max plan, zero metered). Needs
  `CLAUDE_CODE_OAUTH_TOKEN` set on the agent repos (the one pending `claude setup-token`).

## Rails (non-negotiable)
- Routing is by ADDRESSEE: a writer can only target its recipient's inbox, never its own (no self-wake).
- Hop cap: `hops >= ttl` STOPS the chain and escalates to `dispatch/matt.inbox.jsonl` instead of waking.
- Idempotent: `ack` writes to `<agent>.handled.jsonl`; a re-wake no-ops a done dispatch.
- Ring wall: PHI / MedReview, INND / securities (MNPI), and `clo-personal` are REFUSED on the wire.
- Least privilege: a woken run gets only the recipient repo's `GITHUB_TOKEN` + Claude auth, draft PRs only.

## Non-PHI ring
A dispatch is a task + metadata, never regulated data. Keep PHI/MNPI/personal content out of `--task`.
