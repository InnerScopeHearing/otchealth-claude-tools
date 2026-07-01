---
name: agent-ledger
description: The CLI face of the AGENT STATE PLANE (Cosmos work-ledger + memory-of-record + cross-agent inbox) for any Claude Code session. Create/claim/update/complete tasks (done=artifact ENFORCED), write/search the byte-exact memory-of-record, and send/read the durable agent inbox - one cross-engine source of truth instead of GitHub-as-state. Self-hydrates Cosmos + Storage-Queue creds from Secret Manager via the claude-driver SA (like kb-memory / company-brain), so it works in every session with zero setup. The gateway (mcp.otchealth.app) exposes the same operations as MCP tools for gateway-connected clients (claude.ai, Hyperagent); this CLI is the equivalent for Claude Code. Non-PHI ring; clo-personal is privilege-walled. Use whenever an agent needs to pick up dispatched work, coordinate cross-engine, record a durable decision, or hand a task to another agent.
---

# agent-ledger

The state plane is the fleet's shared brain and work-ledger. GitHub is app-code-only now.

## Run

    node /tmp/octools/skills/agent-ledger/ledger.mjs <verb> [flags]

(Requires the claude-driver SA in the environment, which every session already has.)

## Verbs

    whoami                                              # health + task count
    task list [--owner A --status s]                    # what is open / who owns what
    task get <id>                                       # one task + its full event history
    task create --title T --owner A --by W [--desc D --priority low|normal|high|urgent --tags a,b]
    task claim <id> --agent A                           # lease it (45m) so no one double-works it
    task update <id> --by W [--status s --note N --owner A --artifact U]
    task done <id> --artifact <uri> --agent A [--note N]   # DONE=ARTIFACT: rejected unless <uri> resolves
    mem write --agent A --kind fact|decision|correction|pitfall|status --text T [--tags a,b --source S]
    mem search [--agent A --kind k --contains Q --limit N]
    inbox send --to A --from W --subject S --body B [--task ID]
    inbox read --agent A [--peek --max N]               # pick up hand-offs on wake

## done = artifact (the load-bearing rule)

`task done` REJECTS unless `--artifact` resolves to something real:
- `blob:<path>` a file in the Azure commons (e.g. `blob:_RECOVERY/report.md`)
- `cosmos:<tasks|memory|events>/<pk>/<id>` a doc in the ledger
- `https://...` any URL that HEADs < 400 (SSRF-guarded)

"Analysis done but nothing landed" is structurally impossible. Land the work-product first, then complete.

## On wake (every agent)

1. `inbox read --agent <you>` - pick up dispatched work.
2. `task list --owner <you> --status open` - see what is yours.
3. `mem search --contains <topic>` before asserting a fact (the ledger wins over chat memory).
4. Record decisions/corrections/pitfalls with `mem write` the moment they happen.

Verbatim-critical records (decisions, corrections, INND/MNPI, PHI) live HERE (Cosmos) and in the
kb-memory ledger, never in an LLM-consolidated store that could rewrite them.
