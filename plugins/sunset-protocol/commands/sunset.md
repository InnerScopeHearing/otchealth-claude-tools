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


## CROSS-ENGINE REACHABILITY (required) — added 2026-06-29 (CTO)
Learned the hard way on the CRO Hyperagent->Claude transfer (2026-06-29): **Hyperagent global docs / any single-engine doc-store are NOT readable from Claude Code.** The ONLY cross-engine-durable channels are (a) the kb-memory ledger and (b) repo files on **origin/main**.
RULES for every master handoff:
1. **Commit the master-handoff doc to origin/main** (or merge the PR immediately). Do NOT leave it as a draft PR on a claude/* branch — the receiving engine clones main and will not see a branch.
2. **Always write the handoff to the kb-memory ledger too** (a titled `decision`). The ledger is the cross-engine source of truth; it carried the CRO handoff when the doc-store could not.
3. Treat any Hyperagent global doc / doc-store copy as a **convenience copy only**, never the primary cross-engine artifact.
4. Sensitive content still follows ring rules (private lane only; counts+pointers in commons/repo).
