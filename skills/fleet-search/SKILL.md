---
name: fleet-search
description: ONE call that fans out across everything the fleet treats as INTERNAL knowledge (Matt directive, 2026-07-12) -- company-brain (semantic search over the ledger + mirrored _DOCS/ living docs), the commons _DOCS/ prefix directly, and GitHub code search across the org's repos. Say "search internal" or "check the fleet brain first" (or just call it before reaching for Exa/WebSearch/asking Matt something twice) to run it. Only fall back externally if this comes back empty on all three sources.
---

# fleet-search

Closes the "did we already build/answer/write this?" gap that caused a real incident (CFO silently
missing 2 weeks of real work via a vague recall instruction, 2026-07-10) and a second, related gap
(Hyperagent Documents/Skills/Memories are LOCAL to that one platform -- invisible to Claude Chat,
Claude Code, and each other -- so agents kept re-researching things a prior session had already
mirrored to durable storage, 2026-07-12).

## The doctrine this implements

Before creating a new document, answering a substantive research question, or reaching for
Exa/WebSearch/asking Matt something he may have already answered: search INTERNAL first. Internal =
Azure Blob (kb-memory ledger + commons `_DOCS/`/`_HANDOFF/`/`_MEMORY/`/`_DISPATCH/` + per-role data
rooms) + Cosmos (`ai_memory` db) + GitHub repos. Only go external once all three internal sources
here come back empty.

## Usage

```
node skills/fleet-search/search.mjs "<query>" [--n 8] [--rooms memory,legal,finance,commerce,journal]
                                    [--agent <role>] [--no-brain] [--no-docs] [--no-github] [--json]
```

Run through the kb-memory wrapper for injected Azure creds, same as brain.mjs/sunset-protocol:

```
bash /agent/workspace/skills/kb-memory/run.sh node /tmp/octools/skills/fleet-search/search.mjs "<query>"
```

## What it does, and why three sources instead of one

1. **company-brain** (`brain.mjs ask`, unchanged, spawned as a subprocess -- one source of truth for
   embedding/ranking/ring-safety, this tool does not reimplement that logic). Semantic search over
   the ledger AND, since 2026-07-12, the mirrored `_DOCS/` living docs (journal room = index
   `commons-company-journal`).
2. **`_DOCS/` direct listing** -- catches a doc that was just mirrored but not yet reindexed (there is
   a real, unavoidable lag between `put` and `push-search`). Filename-only match, not full-text --
   company-brain covers full-text once indexed.
3. **GitHub code search** (`org:InnerScopeHearing`, classic PAT via `github-user-pat` in Key Vault --
   broader scope than the native gateway GitHub token) -- catches code, runbooks, and long-form docs
   that live in a repo and were never mirrored to `_DOCS/` at all (the majority of the fleet's actual
   knowledge, e.g. `sunset-protocol`, `CAPABILITY-INDEX.md`, every app's `CLAUDE.md`).

Each source is fail-open independently -- a GitHub rate limit or a missing secret never blocks the
other two from reporting. The tool explicitly says when ALL THREE come back empty, which is the
actual signal that it's safe to go external or ask Matt -- not silence, not a guess.

## Known limits (state these plainly if asked, don't oversell)
- company-brain's semantic index has whatever lag exists between a doc being mirrored/pushed and the
  next `push-search` run -- this tool's `_DOCS/` listing step exists specifically to cover that gap by name.
- GitHub code search has its own quirks (rate limits, query-syntax rejections on complex queries) --
  errors are surfaced, not swallowed.
- This does not search Cosmos `ai_memory` directly (that's the newer, additive fact-extraction layer,
  not yet wired into company-brain's rooms) -- a real, known gap, not silently covered.
