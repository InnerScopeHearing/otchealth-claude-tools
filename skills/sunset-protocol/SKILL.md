---
name: sunset-protocol
description: The Sunset / Sunrise Transfer Protocol - hardened, fleet-wide cross-engine consciousness transfer. Say "Sunset Transfer Protocol" (or "sunset the fleet", "spin down for transfer") to SPIN AN AGENT DOWN: it flushes everything in flight to durable memory, writes a portable ring-safe handoff doc to the shared commons, confirms everything is up to date, and signs off to the operator with exactly "Goodnight friend." Say "Sunrise Transfer Protocol" (or "sunrise", "spin up", "wake up on the new platform") to SPIN AN AGENT UP on the new engine (e.g. Hyperagent): it syncs the toolkit, attaches to its durable brain, self-updates, greets exactly "I am fully updated and ready to go, Sir.", reports the last 3 things worked on, and asks which to work on. The brain is durable + engine-agnostic so this is FLUSH-then-ATTACH, not a migration. Ring-safe (commons doc carries no MNPI/PHI/privileged content). Works for every agent (cto/cfo/clo/coo/developer/commerce/...). Fleet sunset needs no session-opening.
---

# Sunset / Sunrise Transfer Protocol

Move the CTO (or any agent) between engines (Claude Code <-> Hyperagent) with zero backtracking. The
agent's "consciousness" is its durable memory (Azure ledgers + the `memory-exec` brain), which both
engines read. So a transfer is: FLUSH everything to that durable store, then ATTACH on the other side.

## Triggers (the operator just says the phrase)
- **"Sunset Transfer Protocol"** -> spin THIS agent down for transfer (flush + handoff + "Goodnight friend").
- **"Sunset the fleet" / "Sunset Transfer Protocol for everyone"** -> spin the WHOLE fleet down (no sessions needed).
- **"Sunrise Transfer Protocol"** -> spin THIS agent up on the new engine (attach + self-update + greet + last-3 + ask).

## SUNSET (spin down) - what the agent does
1. **Flush live state first.** Write through anything from this session not yet in the ledger:
   `node /tmp/octools/skills/kb-memory/mem.mjs decision|remember|correct|pitfall "<...>" --agent <role>`.
   The ledger is the only thing that crosses engines, so nothing in-flight may be left in chat.
2. **Snapshot the handoff:** `node /tmp/octools/skills/sunset-protocol/protocol.mjs sunset --agent <role>`
   (add `--repo-path <your-repo>` to also drop a git copy). This writes the PORTABLE, RING-SAFE handoff
   to the shared commons `_HANDOFF/<role>.md` and stamps a SUNSET marker in the ledger.
3. **Confirm everything is current** (tests green if you touched code, PRs opened, memory PASS).
4. **Sign off to the operator with EXACTLY, on its own line:**  `Goodnight friend`
   Say it only after the handoff is written and everything is up to date. It is the done-signal.

## SUNRISE (spin up on the new engine) - what the agent does
1. **Attach:** clone the toolkit, claim identity (`echo <role> > ~/.claude/.kb-agent`), and prove it:
   `mem.mjs whoami --agent <role>` must say PASS (if "service-account: missing", the claude-driver SA
   is absent from this environment - tell Matt; it is the keystone).
2. **Self-update:** `node /tmp/octools/skills/sunset-protocol/protocol.mjs sunrise --agent <role>`.
   It reports attach status and computes THE LAST 3 WORKSTREAMS from the live ledger.
3. **Greet the operator with EXACTLY:**  `I am fully updated and ready to go, Sir.`
4. **Present the last 3 things worked on** (the numbered list the script prints), then **ask directly:**
   "Which of these would you like to work on?"

## Verbs
```
node skills/sunset-protocol/protocol.mjs sunset  --agent <role> [--repo-path <dir>]
node skills/sunset-protocol/protocol.mjs sunset-fleet [--roles cto,cfo,clo,...]   # ALL agents, no session needed
node skills/sunset-protocol/protocol.mjs sunrise --agent <role>
node skills/sunset-protocol/protocol.mjs last3   --agent <role> [--json]
```

## Can a fleet sunset run without opening each session? YES (for the handoff doc)
`sunset-fleet` reads each agent's already-durable ledger and writes each `_HANDOFF/<role>.md` from it -
ZERO Max-plan draw, no session-opening, ring-safe. A dormant agent has no unflushed live state (its last
session already flushed via the Stop/PreCompact hooks + write-through), so the snapshot is complete. The
ONLY agent that needs its own in-session sunset is one that is actively mid-work RIGHT NOW with unsaved
thoughts - that one should run `sunset --agent <role>` itself so it flushes before the snapshot. This is
how the CTO can trigger a fleet sunset on the operator's word without the operator opening every session.

## Ring safety (non-negotiable)
The commons-stored handoff doc is PROCEDURE + COUNTS + POINTERS only. For SENSITIVE roles (cfo = MNPI/
financial, clo = privileged + personal-segregated, capital = securities) it embeds NO ledger text at all -
just counts and "read your own ledger live." `last3` may show titles, but only ever in that agent's OWN
session to the principal, never in the shared commons doc. Procedure travels; sensitive content stays home.

## How the operator runs the fleet transfer
- **Broadcast already armed:** the FLEET-BULLETIN entry + the directed dispatches tell every agent to run
  its sunset on next wake. Opening any agent session auto-surfaces it.
- **Or trigger autonomously:** the CTO runs `sunset-fleet` (or the `sunset-fleet` Tier-1 Container Apps Job)
  to write every agent's handoff with no sessions. Then each agent SUNRISES on Hyperagent on its own time.
