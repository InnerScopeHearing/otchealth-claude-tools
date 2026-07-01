---
name: company-brain
description: Ask the whole company one question and get a cited gpt-4o answer federated across every Azure AI Search room the fleet builds, agent lessons and decisions (memory-exec), the legal data room, the CFO finance room, the commerce room, and the company journal. The Billion Dollar Brain query layer, grounded across everything OTCHealth and InnerScope know. Also has a DIFF mode (brain.mjs diff "<topic>" --since <date>) that walks the memory-of-record and renders a structured added/changed/retired/still-true delta with full supersedes chains, so "what changed on X since Y" is answerable directly instead of re-reading the whole ledger. legal-personal (attorney-privileged) is EXCLUDED unless --include-personal --agent clo; non-PHI ring only; INND/securities content is MNPI and internal (diff mode further restricts MNPI-flagged rows to clo/cfo/capital/cto). Run it as a CLI script (node skills/company-brain/brain.mjs ask "<question>" | diff "<topic>" --since <date>). Use when you need an answer grounded in the company's own data rather than the open web. Wielded by every agent and by Matt.
---

# company-brain — ask the whole company one question, get a cited answer

The Billion Dollar Brain query layer. Federates every Azure AI Search index the fleet builds, agent
lessons/decisions (`memory-exec`), the legal data room, the CFO finance room, the commerce room, and
the company journal, then synthesizes a cited answer with gpt-4o. One question, grounded across
everything OTCHealth + InnerScope know.

## Use
```
node brain.mjs ask "<question>" [--rooms memory,legal,finance,commerce,journal] [--n 6]
node brain.mjs diff "<topic>" --since <date> [--n 8] [--agent clo --include-personal] [--summarize] [--json]
node brain.mjs rooms        # list the indexes it searches
```
Default: searches all non-privileged rooms. `--rooms` to scope. Returns the answer + the rooms it
was grounded in (with [n] citations to the source snippets).

## Diff mode: "what changed on X since Y"
`diff` resolves the topic via the same `memory-exec` semantic index `ask` uses, then walks the WARM
memory-of-record (the raw per-agent exec-feed ledgers kb-memory writes, which carry `{ts, supersedes,
was}`, fields the search index itself does not store) for rows touching that topic whose timestamp OR
whose supersedes-transition falls in the `--since` window. It renders a structured delta:
- **added** - a new statement inside the window, nothing later supersedes it yet.
- **changed** - a correction/re-set inside the window; shown as the full WAS -> ... -> NOW chain (walks
  every hop, not just one step).
- **retired** - an older statement that pre-dates the window but got superseded INSIDE the window (it
  is now retired as of this window even though it was originally stated earlier).
- **still-true** - unrelated to the window; context only, never treated as a delta claim.

`--summarize` hands the structured delta (not raw ledger text) to the quality tier for a one-paragraph
plain-language summary; formatting only, the delta itself is computed deterministically with no LLM.
This ships the MINIMAL version over the existing `{ts, supersedes}` fields; a real bi-temporal model
(valid-time vs transaction-time) is north-star, not this PR.

## What makes it compound
- The data-room **librarians** (doc-indexer) keep legal/finance/commerce indexes fresh.
- **kb-memory semantic** (`memory-exec`) holds the agent lessons; **reflect** + the focus-group/shark
  `--catalog` feed it new lessons; **auto-reindex** keeps it searchable.
- So every shipped fix, every focus-group review (customer + pro + investor), every decision becomes
  answerable by THIS query, for every agent and for you. The brain gets smarter every day.

## RING SAFETY (hard)
- `legal-personal` (attorney-privileged personal matters) is EXCLUDED by default. Only included with
  `--include-personal --agent clo`. Never cross that wall otherwise. Diff mode applies the identical
  gate to the `clo-personal` exec-feed lane (`selectLanes()`, same shape as `selectRooms()`).
- MedReview / PHI is never indexed into these rooms (non-PHI ring only). INND/securities content in
  the legal room is MNPI, treat answers as internal. Diff mode additionally drops any MNPI/PHI-flagged
  ledger row from the delta unless the caller passes `--agent clo|cfo|capital|cto` (`ringSafeForDiff()`).

## Model
Embeddings: text-embedding-3-large. Answer synthesis: Azure OpenAI gpt-4o (credit-funded). Set
`BRAIN_MODEL` to override.
