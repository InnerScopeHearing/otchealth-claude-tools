---
name: ring-memory-index
description: Keeps EVERY agent's PRIVATE memory ledger semantically recallable by embedding it into a per-agent Azure AI Search index (BM25 + text-embedding-3-large vector + semantic ranker). The shared exec brain (memory-exec) already covers shared memory; this is the equivalent for private ledgers — both ring-isolated (CLO legal, CFO finance) and non-privileged commons agents (COO, CCO, CRO, CPO, developer) — that the shared reindex never touches. Idempotent, ring-safe (each agent's own index only), fail-safe per row; safe to schedule.
---

# ring-memory-index — semantic recall for every agent's private memory

## The gap this closes
The shared exec feed (`_MEMORY/_exec/*`) is embedded into Azure AI Search `memory-exec`, so agents recall SHARED memory by meaning. But every agent also keeps its real work in a PRIVATE ledger, which the shared reindex never sees:

- **CLO (legal ring):** `otchealthlegalstore / personal / _MEMORY/clo-personal.jsonl` → index `legal-personal-memory`
- **CFO (finance ring):** `otchealthcfodata / cfo-source-docs / _MEMORY/cfo.jsonl` → index `finance-cfo-memory`
- **COO, CCO, CRO, CPO, developer (non-privileged, commons store):** `otchealthcommons / company-journal / _MEMORY/<agent>.jsonl` → index `commons-<agent>-memory` (one index per agent, even though they share a store)

Those ledgers were only FLAT-readable — a slow keyword scan over a large, growing jsonl (CFO's is ~800 entries / 758 KB). This embeds each agent's ledger into its own index so the agent recalls its OWN decisions/status/facts by meaning, fast — the same upgrade `memory-exec` gave the shared brain, applied per agent. (The DOCUMENT corpora `legal-personal` and `finance-cfo-source-docs` are indexed separately by doc-indexer; this is specifically the agent's memory ledger.)

## Ring safety
Each row is embedded ONLY into its own index (legal→legal-*, finance→finance-*, commons agents→commons-<agent>-*). Content never crosses agents and is never printed. This holds even where several rows share a STORE: the commons agents (COO/CCO/CRO/CPO/developer) all read from `otchealthcommons/company-journal`, but each still gets its own distinct `commons-<agent>-memory` index — no agent's ledger is ever embedded alongside another's. Creds self-resolve per row from Secret Manager via the claude-driver SA. **Idempotent** (mergeOrUpload by stable id — re-runs update, never duplicate) and **fail-safe PER ROW** (one row's failure never blocks the others).

## Run
```
node skills/ring-memory-index/index-ring-memory.mjs [clo-personal | cfo | coo | cco | cro | cpo | developer | all]
```
Needs `GCP_CLAUDE_DRIVER_SA_JSON` (the claude-driver SA); everything else self-resolves from Secret Manager. Prints `RING <label>: indexed <n>/<total> -> <index>` per row.

## Onboarding a new agent
Add a row to the `RINGS` array: `{ label, storeAcctSecret, storeKeySecret, container, ledger, index, idPrefix }`. Give it a distinct `index` — never reuse another agent's index, even if it shares a store (e.g. commons). No other change needed.

## Scheduled
Runs from the doc-indexer job image (which carries the SA + resolves each store's creds). Wire on a daily cron alongside the memory-exec reindex so every agent's memory index stays fresh as it writes. Until scheduled, the CTO re-runs it after a big session for any of these agents.

## API
```js
import { RINGS, indexRing, run } from "./index-ring-memory.mjs";
const results = await run("all"); // [{label, index, indexed, total} | {label, error}]
```
