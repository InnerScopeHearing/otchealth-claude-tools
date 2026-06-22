---
name: company-brain
description: Ask the whole company one question and get a cited gpt-4o answer federated across every Azure AI Search room the fleet builds, agent lessons and decisions (memory-exec), the legal data room, the CFO finance room, the commerce room, and the company journal. The Billion Dollar Brain query layer, grounded across everything OTCHealth and InnerScope know. legal-personal (attorney-privileged) is EXCLUDED unless --include-personal --agent clo; non-PHI ring only; INND/securities content is MNPI and internal. Run it as a CLI script (node skills/company-brain/brain.mjs ask "<question>"). Use when you need an answer grounded in the company's own data rather than the open web. Wielded by every agent and by Matt.
---

# company-brain — ask the whole company one question, get a cited answer

The Billion Dollar Brain query layer. Federates every Azure AI Search index the fleet builds, agent
lessons/decisions (`memory-exec`), the legal data room, the CFO finance room, the commerce room, and
the company journal, then synthesizes a cited answer with gpt-4o. One question, grounded across
everything OTCHealth + InnerScope know.

## Use
```
node brain.mjs ask "<question>" [--rooms memory,legal,finance,commerce,journal] [--n 6]
node brain.mjs rooms        # list the indexes it searches
```
Default: searches all non-privileged rooms. `--rooms` to scope. Returns the answer + the rooms it
was grounded in (with [n] citations to the source snippets).

## What makes it compound
- The data-room **librarians** (doc-indexer) keep legal/finance/commerce indexes fresh.
- **kb-memory semantic** (`memory-exec`) holds the agent lessons; **reflect** + the focus-group/shark
  `--catalog` feed it new lessons; **auto-reindex** keeps it searchable.
- So every shipped fix, every focus-group review (customer + pro + investor), every decision becomes
  answerable by THIS query, for every agent and for you. The brain gets smarter every day.

## RING SAFETY (hard)
- `legal-personal` (attorney-privileged personal matters) is EXCLUDED by default. Only included with
  `--include-personal --agent clo`. Never cross that wall otherwise.
- MedReview / PHI is never indexed into these rooms (non-PHI ring only). INND/securities content in
  the legal room is MNPI, treat answers as internal.

## Model
Embeddings: text-embedding-3-large. Answer synthesis: Azure OpenAI gpt-4o (credit-funded). Set
`BRAIN_MODEL` to override.
