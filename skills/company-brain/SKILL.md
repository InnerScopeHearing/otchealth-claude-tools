---
name: company-brain
description: Ask the whole company one question and get a cited answer federated across every search room the fleet builds (Amazon OpenSearch by default, Azure AI Search still selectable), agent lessons and decisions (memory-exec), the legal data room, the CFO finance room, the commerce room, and the company journal. The Billion Dollar Brain query layer, grounded across everything OTCHealth and InnerScope know. Also has a DIFF mode (brain.mjs diff "<topic>" --since <date>) that walks the memory-of-record and renders a structured added/changed/retired/still-true delta with full supersedes chains, so "what changed on X since Y" is answerable directly instead of re-reading the whole ledger. legal-personal (attorney-privileged) is EXCLUDED unless --include-personal --agent clo; non-PHI ring only; INND/securities content is MNPI and internal (diff mode further restricts MNPI-flagged rows to clo/cfo/capital/cto). Run it as a CLI script (node skills/company-brain/brain.mjs ask "<question>" | diff "<topic>" --since <date>). Use when you need an answer grounded in the company's own data rather than the open web. Wielded by every agent and by Matt.
---

# company-brain — ask the whole company one question, get a cited answer

The Billion Dollar Brain query layer. Federates every room index the fleet builds, agent
lessons/decisions (`memory-exec`), the legal data room, the CFO finance room, the commerce room, and
the company journal, then synthesizes a cited answer. One question, grounded across everything
OTCHealth + InnerScope know.

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

## Backends (Azure exit, 2026-08-18)
Three INDEPENDENT selectors, the same names/values the rest of the fleet uses
(`skills/kb-memory/semantic.mjs`, the gateway's `src/search/index.ts` and `src/azure/foundry.ts`):

| env | default | other value |
| --- | --- | --- |
| `SEARCH_BACKEND` | `opensearch` | `azure` |
| `EMBEDDINGS_PROVIDER` | `openai` | `foundry` |
| `LLM_PROVIDER` | `openai` | `foundry` |

**The defaults are the LIVE options, not azure/foundry.** Azure subscription 55c84f6b is permanently
gone; this file was 100% hardcoded to it and threw on every invocation. Defaulting the fleet's
most-invoked tool at a deleted subscription is not conservative, it is a guaranteed outage for every
seat (none of these variables are set anywhere in the fleet). The Azure code paths are kept, just not
default: set the three vars back the day a search service and a vault exist again.

## Model
Embeddings: **text-embedding-3-large @ 3072 dims, pinned and not configurable.** The ~492,557 live
room documents are embedded in that exact space and OpenAI serves the identical model (verified live
2026-08-15 at cosine similarity 0.99999791 vs Azure Foundry), so `EMBEDDINGS_PROVIDER=openai` needs
NO reindex. NEVER point embeddings at Bedrock Titan/Cohere, and never pass OpenAI's `dimensions`
truncation parameter: a different space still yields plausible-looking cosine scores, so retrieval
would silently rank garbage while every health check stayed green. `assertEmbeddingSpace()` in
`opensearch-rooms.mjs` enforces the dimension at query time.

Answer synthesis: the shared `standard` tier with the `quality` tier as fallback
(`setup/model-routing.mjs`; gpt-4.1-mini stays banned for synthesis). Override with `BRAIN_MODEL` /
`BRAIN_FALLBACK_MODEL`.

## Failure posture (why this tool now exits non-zero)
A ground-first tool that prints "No grounded results" when its backend was unreachable manufactures a
false negative finding, and every CLAUDE.md tells agents to trust this output over their own
knowledge. So: a room that cannot be searched is never reported as a room that held nothing.
- all rooms failed, or some failed and the rest returned nothing -> loud error, **exit 1**.
- some failed but there are hits -> the answer prints with a `!!! PARTIAL ANSWER` banner on stdout.
- nothing failed and there are no hits -> a real negative finding, exit 0.
`diff` mode still reads the warm ledger from Azure Blob (a documented remaining dependency, `ask` does
not touch Azure); it now throws instead of rendering an empty delta off an unreadable ledger.
