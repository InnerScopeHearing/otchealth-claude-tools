# The Billion Dollar Shared Super-Brain protocol

The canonical, copy-paste protocol every fleet agent follows to USE and FEED the company's shared
intelligence. Send the block at the bottom to each agent (one at a time). Companion to
`dream-team/MEMORY-SOP.md` (the deeper kb-memory how-to) and `dream-team/MODEL-ROUTING.md`.

## Purpose
OTCHealth + InnerScope run ONE compounding, company-wide intelligence: a shared "super-brain" that
every agent both **draws from** and **feeds**. Every fact learned, decision made, mistake corrected,
and review run becomes permanently searchable by every other agent and by Matt. The more each agent
writes, the smarter the whole fleet gets, every day. The chat window is disposable; the shared ledger
is the company's memory and the source of truth, when the ledger and an agent's memory disagree, the
ledger wins.

## How it compounds (the machinery behind the protocol)
- **kb-memory** is the append-only ledger. Per-agent lanes + a shared exec feed; verbs
  `remember | decision | correct | pitfall | status | recall | team`.
- **company-brain** (`skills/company-brain/brain.mjs ask`) federates every Azure AI Search room
  (agent `memory-exec`, `legal-company`, `finance`, `commerce`, `journal`) into one cited answer.
- **brain-reindex** (Container Apps Job, every 6h) embeds new shared-memory entries into `memory-exec`,
  so within hours any new fact/decision/review is brain-answerable.
- **librarians** keep the legal/finance/commerce rooms fresh; **reflect** (Stop hook) and the
  focus-group/shark `--catalog` auto-feed memory; the **daily-digest** journals merged work nightly.
- So: write to memory -> reindexed -> federated -> cited for everyone. Every contribution makes every
  future answer better.

## The protocol (what each agent does)
0. **Stay current.** `bash /tmp/octools/setup/octools-version.sh`; if STALE, refresh (a session that
   began before a fix merged silently runs old code).
1. **Draw first.** Before researching or asserting, ask `company-brain`, `semantic recall`, and
   `mem team`. Recall before you assert.
2. **Feed always.** Write-through every durable fact/decision/correction/pitfall the instant it
   happens; publish `status`; `--share` non-sensitive cross-team facts.
3. **Save the protocol** to memory (so it survives compaction).

## Rings (hard, never cross)
- Only `status` + `--share` leave a lane; keep shared items non-sensitive.
- PHI / MedReview patient data is NEVER written to the brain (non-PHI ring only).
- INND / securities content is MNPI: internal-only, never `--share`d outward, attorney + Matt gated.
  Query the legal/finance rooms only if your role covers them; treat every brain answer as INTERNAL.
- The `clo-personal` lane (Matt's personal legal) is privileged and is NEVER shared.

---

## THE PASTE-READY PROMPT (send to each agent, one at a time)

```
=== FLEET PROTOCOL: The Billion Dollar Shared Super-Brain ===
Read this in full, follow it every session, and SAVE IT to your memory now (Step 3).

PURPOSE (why this exists)
OTCHealth + InnerScope run ONE compounding, company-wide intelligence: a shared "super-brain" that
every agent both DRAWS FROM and FEEDS. Every fact you learn, decision you make, mistake you correct,
and review you run becomes permanently searchable by every other agent and by Matt. The more each of
us writes to it, the smarter the whole fleet gets, every single day. Your chat window is disposable;
the shared ledger is the company's memory and is the source of truth. When the ledger and your memory
disagree, the LEDGER WINS.

IDENTIFY YOURSELF (once, at the top of every session)
Set your agent id (your role: cfo, clo, cto, cpo, commerce, capital, growth, lifecycle, switchboard,
or an app name like plantid / flatstick / aware / companion / iheartest, etc.):
    export KB_AGENT=<YOUR_AGENT_ID>

STEP 0 - STAY CURRENT (first thing, every session)
A session that started before a fix was merged silently runs OLD code (this cost us real work). Check:
    bash /tmp/octools/setup/octools-version.sh
If it says STALE, run the refresh command it prints (bash /tmp/octools/setup/session-start.sh) or
restart your session. Never trust a skill result from a stale session.

STEP 1 - DRAW FROM THE BRAIN (before you research or assert anything)
Do not answer from memory or re-research what the company already knows. Ask the brain first:
  - Ask the whole company one cited question (scope --rooms to what your role needs):
        node ~/.claude/skills/company-brain/brain.mjs ask "<your question>" --rooms memory,journal
  - Recall the shared agent ledger by meaning:
        node ~/.claude/skills/kb-memory/semantic.mjs recall "<your question>"
  - See the whole exec team's live status + shared facts:
        node ~/.claude/skills/kb-memory/mem.mjs team
RECALL BEFORE YOU ASSERT.

STEP 2 - FEED THE BRAIN (write-through, the instant something happens, not at the end)
    node ~/.claude/skills/kb-memory/mem.mjs remember "<a stable fact>"               --agent $KB_AGENT
    node ~/.claude/skills/kb-memory/mem.mjs decision "<a standing choice + why>"     --agent $KB_AGENT
    node ~/.claude/skills/kb-memory/mem.mjs correct  "<right fact replacing a wrong belief>" --agent $KB_AGENT
    node ~/.claude/skills/kb-memory/mem.mjs pitfall  "<a recurring trap + the fix>"  --agent $KB_AGENT
Publish what you are working on (auto-shared so the team has the live picture):
    node ~/.claude/skills/kb-memory/mem.mjs status "<what I'm doing right now>"       --agent $KB_AGENT
Add --share to any NON-SENSITIVE, cross-team-useful entry so it reaches the shared brain:
    ... pitfall "<cross-app lesson>" --agent $KB_AGENT --share
Write generously. A fact only you hold is a fact the company loses. With KB_AGENT set, the session
hooks also auto-capture lessons at session end.

STEP 3 - SAVE THIS PROTOCOL (do it now)
    node ~/.claude/skills/kb-memory/mem.mjs decision "Adopted the Fleet Super-Brain protocol: stay current (octools-version) -> DRAW from company-brain + kb-memory recall before asserting -> FEED write-through every fact/decision/correction/pitfall + status -> --share non-sensitive cross-team facts -> respect the rings. The shared ledger is the source of truth." --agent $KB_AGENT --share

THE RINGS (hard, never cross)
  - Only status + --share leave your lane; keep anything you --share NON-sensitive.
  - PHI / MedReview patient data is NEVER written to the brain (non-PHI ring only).
  - INND / securities content is MNPI: internal-only, never --shared outward, attorney + Matt gated.
    The legal and finance rooms carry MNPI/privileged material, query them only if your role covers
    them, and treat every brain answer as INTERNAL.
  - The clo-personal (Matt's personal legal) lane is privileged and is NEVER shared.

WHY IT COMPOUNDS (the payoff)
Everything you write to memory is auto-embedded into the shared brain every 6 hours, so within hours
your fix, decision, or review becomes a cited answer for every agent and for Matt. The data-room
librarians keep legal/finance/commerce fresh; reflect + focus-group reviews feed memory; the brain
federates it all. Every contribution makes every future answer better. That is the Billion Dollar
Shared Super-Brain, and you are both a user and an author of it. Use it first. Feed it always.
=== END PROTOCOL ===
```
