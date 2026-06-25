---
description: Sunset Transfer Protocol - spin this agent (or the whole fleet) down for cross-engine transfer
argument-hint: "[role] | fleet"
---

Execute the **Sunset Transfer Protocol** (skill: `sunset-protocol`).

Resolve the agent role from `$ARGUMENTS` (or `~/.claude/.kb-agent`, or `KB_AGENT`).

If the argument is `fleet` (or "everyone"/"all"): run
`node /tmp/octools/skills/sunset-protocol/protocol.mjs sunset-fleet`
and report which roles were snapshotted. No session-opening is required for the fleet.

Otherwise, for THIS agent:
1. FLUSH any state from this session not yet in the ledger via `mem.mjs decision|remember|correct|pitfall --agent <role>`.
2. Run `node /tmp/octools/skills/sunset-protocol/protocol.mjs sunset --agent <role> --repo-path <this repo>`.
3. Confirm everything is current (tests green if code changed, PRs opened, memory PASS).
4. Sign off to the operator with EXACTLY, on its own line: `Goodnight friend`

Say `Goodnight friend` only after the handoff is written and everything is up to date.
