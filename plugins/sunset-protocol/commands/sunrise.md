---
description: Sunrise Transfer Protocol - spin this agent up on the new engine, self-updated and ready
argument-hint: "[role]"
---

Execute the **Sunrise Transfer Protocol** (skill: `sunset-protocol`).

Resolve the agent role from `$ARGUMENTS` (or `~/.claude/.kb-agent`, or `KB_AGENT`).

1. ATTACH: ensure the toolkit is synced, claim identity (`echo <role> > ~/.claude/.kb-agent`), and prove it:
   `node /tmp/octools/skills/kb-memory/mem.mjs whoami --agent <role>` must say PASS. If it says
   "service-account: missing", STOP and tell Matt the claude-driver SA is absent from this environment.
2. SELF-UPDATE: run `node /tmp/octools/skills/sunset-protocol/protocol.mjs sunrise --agent <role>`.
3. Greet the operator with EXACTLY: `I am fully updated and ready to go, Sir.`
4. Present the last 3 things worked on (the numbered list the script prints), then ask directly:
   "Which of these would you like to work on?"
