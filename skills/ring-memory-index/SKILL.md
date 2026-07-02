---
name: ring-memory-index
description: Keeps each ring-isolated agent's PRIVATE memory ledger semantically recallable by embedding it into a per-ring Azure AI Search index (BM25 + text-embedding-3-large vector + semantic ranker). The shared exec brain (memory-exec) already covers shared memory; this is the equivalent for ring-private ledgers (CLO legal, CFO finance) that the shared reindex never touches. Idempotent, ring-safe, fail-safe per ring; safe to schedule.
---

# ring-memory-index — semantic recall for ring-private agent memory

## The gap this closes
The shared exec feed (`_MEMORY/_exec/*`) is embedded into Azure AI Search `memory-exec`, so agents recall SHARED memory by meaning. But ring-isolated agents keep their real work in a PRIVATE ledger in their own ring store, which the shared reindex never sees:

- **CLO (legal ring):** `otchealthlegalstore / personal / _MEMORY/clo-personal.jsonl` → index `legal-personal-memory`
- **CFO (finance ring):** `otchealthcfodata / cfo-source-docs / _MEMORY/cfo.jsonl` → index `finance-cfo-memory`

Those ledgers were only FLAT-readable — a slow keyword scan over a large, growing jsonl (CFO's is ~800 entries / 758 KB). This embeds each ring ledger into its own index so the agent recalls its OWN decisions/status/facts by meaning, fast — the same upgrade `memory-exec` gave the shared brain, applied per ring. (The DOCUMENT corpora `legal-personal` and `finance-cfo-source-docs` are indexed separately by doc-indexer; this is specifically the agent's memory ledger.)

## Ring safety
Each ring's ledger is embedded ONLY into that ring's own index (legal→legal-*, finance→finance-*). Content never crosses rings and is never printed. Creds self-resolve per ring from Secret Manager via the claude-driver SA. **Idempotent** (mergeOrUpload by stable id — re-runs update, never duplicate) and **fail-safe PER RING** (one ring's failure never blocks the others).

## Run
```
node skills/ring-memory-index/index-ring-memory.mjs [clo-personal | cfo | all]
```
Needs `GCP_CLAUDE_DRIVER_SA_JSON` (the claude-driver SA); everything else self-resolves from Secret Manager. Prints `RING <label>: indexed <n>/<total> -> <index>` per ring.

## Onboarding a new ring
Add a row to the `RINGS` array: `{ label, storeAcctSecret, storeKeySecret, container, ledger, index, idPrefix }`. No other change needed.

## Scheduled
Runs from the doc-indexer job image (which carries the SA + resolves each ring store's creds). Wire on a daily cron alongside the memory-exec reindex so each ring's memory index stays fresh as the agent writes. Until scheduled, the CTO re-runs it after a big CLO/CFO session.

## API
```js
import { RINGS, indexRing, run } from "./index-ring-memory.mjs";
const results = await run("all"); // [{label, index, indexed, total} | {label, error}]
```
