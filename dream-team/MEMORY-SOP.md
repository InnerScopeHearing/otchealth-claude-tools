# Agent Working-Memory SOP (how every agent keeps facts straight across a long session)

> Owner: CTO. Companion to `DOCUMENT-KNOWLEDGE-STANDARD.md` (which covers documents + the company
> journal). This covers the OTHER half: the running facts, decisions, and corrections of a working
> conversation, so an agent stops forgetting or silently changing things it established earlier.

## The problem this solves
Claude Code sessions have a finite context window. When it fills, older turns are summarized
(compacted). Summaries keep the gist and **drop exact facts** (a date, a number, a decision, a
correction). That is why an agent in the SAME chat "forgets" or contradicts a fact from two days ago.
It is expected, not carelessness. The fix is to treat the window as disposable and the **ledger as the
source of truth.**

## The system (one engine, three tiers)
- **Engine:** the `kb-memory` skill (`remember | decision | correct | pitfall | recall | tail`). Per-agent,
  ring-correct, append-only, never deletes.
- **Tier 1 - Standing facts:** rarely change -> the agent's `CLAUDE.md` (always in context).
- **Tier 2 - The running ledger (this SOP):** facts/decisions/corrections/pitfalls -> `kb-memory` (the
  agent's `_MEMORY/<agent>` ledger).
- **Tier 3 - Documents + the daily journal:** the librarian data rooms -> `doc-indexer cloud-search`.

## Knowing the FACTS and the INCORRECT facts (equally important)
Recording the right answer is only half the job. The recurring failure is the AI re-forming a WRONG
belief it was already corrected on. So every agent maintains **pitfalls**: the mistakes the AI keeps
making, each written as *"the AI keeps believing X; the truth is Y; the rule is Z."* Pitfalls are
surfaced FIRST on every wake. A correction (`correct ... --was "<old>"`) keeps the old wrong fact on
record next to the right one, on purpose, so it is never silently resurrected.

## Connected executive memory (the team shares; each agent keeps its lane)
The exec team (coo, cfo, clo, cto, capital, commerce, compliance, rainmaker, growth) is connected so
everyone has the company-wide picture without breaking the rings:
- Each agent keeps its **private lane** (full detail, including sensitive).
- **`status "<what I'm working on>"`** (always) and any **`--share`** entry ALSO publish a copy to a
  shared EXEC feed (one file per agent in the commons, no clobber).
- Every agent's **`tail` / `recall` / `team`** automatically reads the whole feed, so each exec agent
  sees its own lane PLUS every other agent's project status + shared facts.
- **Rings hold:** only what you explicitly `status` / `--share` leaves your lane - keep it NON-sensitive
  (no MNPI specifics, no privilege). Detailed/sensitive facts stay private by default. The CLO PERSONAL
  lane is hard-excluded from sharing.
- **Publish a `status` whenever your project state changes** (started X, shipped Y, blocked on Z), and
  run `team` (or read the TEAM section of `tail`) on wake so you know what the rest of the company is doing.

## DO
- **Write-through.** The instant a fact is established, a decision made, or Matt corrects something,
  append it to the ledger BEFORE continuing. Do not batch to end-of-session; compaction happens mid-session.
- **Recall before you assert.** Before stating any fact, number, date, or entity, `recall` it. If your
  memory and the ledger disagree, **the ledger wins.**
- **Log corrections as corrections.** Use `correct ... --was "<the wrong belief>"` so the mistake is
  captured, not just overwritten.
- **Capture pitfalls.** When you catch yourself (or Matt catches you) repeating an error, write a `pitfall`.
- **Read on wake.** Start every session (and after any compaction) by reading the ledger `tail`.
- **Keep entries atomic + dated + sourced.** One fact per entry; cite who/when (`--source "Matt 2026-06-19"`).

## DON'T
- **Don't trust in-session recall for anything load-bearing.** If it matters, it's in the ledger or it
  doesn't exist.
- **Don't overwrite or delete old facts.** Supersede them (correction). History is the point.
- **Don't co-mingle rings.** CFO ledger = MNPI/private (never the shared commons). CLO `personal` ledger
  = privileged + confidential, segregated from `company`, never shared to other agents, never in git.
- **Don't put secrets in a ledger entry.**
- **Don't wait until "Stop" to persist.** By then the window may have already compacted away the detail.

## Enforcement (so it is not willpower)
Set `KB_AGENT=<agent>` in the session. The hooks (`.claude/settings.json` + `skills/kb-memory/kb-inject.sh`):
- **SessionStart** injects the ledger `tail` (pitfalls + recent facts) into the session.
- **PreCompact** fires right before compaction and reminds the agent to persist unsaved facts NOW. This
  is the precise anti-truncation backstop.
- **Stop** reminds to flush before ending.
The nightly `daily-digest` promotes the day's entries into the commons so the whole fleet inherits them.

## Onboard an agent (2 minutes)
1. Pick the agent id + ring (`mem.mjs list-agents`). 2. `export KB_AGENT=<agent>` in its session/repo.
3. Seed its first pitfalls + standing facts (the things it keeps getting wrong). 4. Add the wake/
write-through/recall lines to the agent's `CLAUDE.md`. 5. Done - it now learns continuously and never
silently changes a fact.

## Reference users
**CFO** (`--agent cfo`) and **CLO** (`--agent clo`, plus `clo-personal` for privileged matters) are
seeded and live. Every other agent onboards by the checklist above.
