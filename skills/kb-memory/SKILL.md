---
name: kb-memory
description: Durable, append-only WORKING MEMORY for agents that defeats context-window compaction. Captures facts, decisions, corrections, and PITFALLS (the recurring wrong beliefs the AI keeps forming) the instant they are stated, into a per-agent, ring-correct ledger (co-located in the agent's own store, so its access control applies), and reads them back on wake. The ledger is the SOURCE OF TRUTH; the chat window is disposable. Use whenever a fact/decision/correction is established, and before asserting any fact. Wielded by every agent; the CFO and CLO are the reference users. Non-PHI ring; CFO ledger is MNPI/private, the legal personal ledger is privileged + segregated.
---

# kb-memory — the agent working-memory ledger

## Why this exists
In a long Claude Code session the context window fills and older turns get summarized (compacted).
Summaries keep the gist and DROP exact facts (a date, a number, a decision, a correction). That is
why an agent "forgets" or silently CHANGES a fact established earlier in the same chat. The fix is to
stop relying on in-session memory: externalize every fact the moment it is stated, and read it back on
demand. Then compaction cannot hurt you, the corpus grows unbounded (cheap, searchable), and only the
relevant slice is ever pulled into context. Retrieval, not retention.

## The model
- The **ledger is the source of truth.** Reconstruct facts by READING it (`tail` / `recall`), never by
  trusting recall. If memory and the ledger disagree, **the ledger wins.**
- **Append-only + temporal supersession.** Corrections never delete the old fact; they record
  `WAS x -> NOW y`, so the history is intact and you can see how a fact changed. Nothing is thrown away.
- **PITFALLS are first-class.** Knowing the *incorrect* facts the AI keeps forming is as important as the
  facts. A pitfall records "the AI keeps believing X; the truth is Y; the rule is Z" so the recurring
  error is corrected at the source. Pitfalls are ALWAYS surfaced on wake.

## Verbs
```
node skills/kb-memory/mem.mjs remember "<fact>"            --agent cfo [--tags a,b] [--source "Matt 2026-06-19"]
node skills/kb-memory/mem.mjs decision "<decision + why>"  --agent cfo [...]
node skills/kb-memory/mem.mjs correct  "<the CORRECT fact>" --agent cfo --was "<the wrong belief>" [--supersedes <id>]
node skills/kb-memory/mem.mjs pitfall  "<recurring mistake + truth + rule>" --agent cfo
node skills/kb-memory/mem.mjs recall   "<query>"           --agent cfo [--n 25]
node skills/kb-memory/mem.mjs tail     --agent cfo [--n 40]     # ALL pitfalls + recent entries (wake read)
node skills/kb-memory/mem.mjs render   --agent cfo             # re-render the human ledger .md
node skills/kb-memory/mem.mjs list-agents
```

## Agents + rings (the ledger co-locates in the agent's own store)
| `--agent` | store / container | ring |
|---|---|---|
| `cfo` | `otchealthcfodata/cfo-source-docs` | finance, MNPI/private |
| `clo` | `otchealthlegalstore/company` | legal company, privileged |
| `clo-personal` | `otchealthlegalstore/personal` | legal PERSONAL, privileged + confidential, segregated (never co-mingle) |
| `commons` (and any other name) | `otchealthcommons/company-journal` | fleet commons, shared |

Artifacts: `_MEMORY/<agent>.jsonl` (append-only record) + `_MEMORY/<agent>.md` (human-readable ledger,
pitfalls first). Dependency-free Node; self-resolves storage creds from Secret Manager via the
claude-driver SA, exactly like doc-indexer. The owning room's librarian also indexes the `.md` so the
ledger is cloud-searchable.

## Session integration (hooks — see .claude/settings.json + kb-inject.sh)
Set `KB_AGENT=<agent>` in the session/repo, then:
- **SessionStart** injects the agent's `tail` (pitfalls + recent facts) so the session wakes holding the truth.
- **PreCompact** fires right before the window compacts and reminds the agent to persist any unsaved facts NOW (the precise anti-truncation backstop).
- **Stop** reminds to flush before ending.
The hooks are fail-safe: with no `KB_AGENT` they no-op (PreCompact prints a generic reminder).

## The discipline (the SOP, enforced by the hooks + each agent's CLAUDE.md)
1. **Wake:** read `tail`, then `recall` the topic. Reconstruct, don't recall.
2. **Write-through:** the instant a fact/decision/correction happens, append it BEFORE continuing.
3. **Corrections:** when a fact changes, `correct ... --was "<old>"`. Old retained, new supersedes.
4. **Verify-before-assert:** check the ledger before stating any fact; the ledger wins.
5. **Stop:** flush; the nightly digest folds it into the commons for the whole fleet.

## Guardrails
- Non-PHI ring only. The `clo-personal` ledger is privileged + confidential: never co-mingle with
  `clo` (company), never share to other agents, never commit to git.
- CFO ledger is MNPI (INND material): it lives in the private finance store, not the shared commons.
- Secrets never go in a ledger entry.
