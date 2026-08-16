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

## Backend (2026-08-16): SEARCH_BACKEND=azure|opensearch
`SEARCH_BACKEND` (env, default `azure`) selects the search destination — the SAME env var name/values as `kb-memory/semantic.mjs`, the gateway's `src/search/index.ts` dispatcher, and doc-indexer's `enrich.mjs --search-backend` flag, so it means the identical thing everywhere in the fleet. `azure` is byte-identical to every prior run. `opensearch` routes `ensureIndex`/`ensureFleetIndex`/every bulk push/`reconcileFleetDupes` through `kb-memory/opensearch-write.mjs` instead — the fix for the defect where an Azure outage (or a deliberate billing block) silently froze all 7 of these ring indexes (measured 2026-08-16: every one stuck at its 2026-08-13 doc count while the Azure-side equivalents kept growing).

`EMBEDDINGS_PROVIDER=foundry|openai` (default `foundry`) is an **independent** switch (mirrors `kb-memory/semantic.mjs` and `otchealth-mcp-server/src/azure/foundry.ts`): a genuine Azure outage takes Azure Foundry down too, so `EMBEDDINGS_PROVIDER=openai` is also needed for a run with zero Azure dependency. Both flags are read once at module load.

```
SEARCH_BACKEND=opensearch EMBEDDINGS_PROVIDER=openai node skills/ring-memory-index/index-ring-memory.mjs all
```

`run()` skips resolving Azure Search/Foundry secrets entirely when both flags are set this way — avoids 7 pointless Key Vault round trips (each a potential timeout) during exactly the run where an outage makes each one costly.

For a one-shot catch-up of `memory-exec` (kb-memory's own index) together with all 7 ring indexes, use `skills/kb-memory/backfill-frozen-rooms.mjs` instead of calling this file directly — see its own header for the exact command.

## Onboarding a new agent
Add a row to the `RINGS` array: `{ label, storeAcctSecret, storeKeySecret, container, ledger, index, idPrefix }`. Give it a distinct `index` — never reuse another agent's index, even if it shares a store (e.g. commons). No other change needed.

## Scheduled
Runs from the doc-indexer job image (which carries the SA + resolves each store's creds). Wire on a daily cron alongside the memory-exec reindex so every agent's memory index stays fresh as it writes. Until scheduled, the CTO re-runs it after a big session for any of these agents.

## API
```js
import { RINGS, indexRing, run } from "./index-ring-memory.mjs";
const results = await run("all"); // [{label, index, indexed, total} | {label, error}]
```

## Fleet-learning layer (agents learn from each other)
Beyond each agent's own index, every NON-PRIVILEGED agent's ledger is ALSO aggregated into the shared, agent-faceted index **`memory-exec`** (`FLEET_INDEX` — reused rather than a dedicated `fleet-learning-memory` index because the AI Search service was at its index quota, and `memory-exec` is already the cross-read layer every agent queries; same embeddings, no extra cost). Any agent can semantically recall what any other non-privileged agent learned (COO/CCO/CRO/CPO/developer + future), with an `agent` field showing/filtering who. This is the "learn from each other" layer, complementing the shared exec brain that `kb-memory/semantic.mjs` also writes into `memory-exec` from the curated `_MEMORY/_exec/*` feed.

**Privileged rings are NEVER aggregated:** rows marked `private: true` (clo-personal legal, cfo finance-sensitive/MNPI) write ONLY to their own walled index — never to fleet-learning. So the fleet compounds off non-privileged detail while attorney-privileged / MNPI / PHI stay isolated by law. Enforced in code (indexRing skips fleet for private rings) and pinned by tests.

**Dual-writer convergence (2026-07-21):** `memory-exec` has TWO writers — this file's fleet push (the FULL private ledger of each non-privileged ring) and `kb-memory/semantic.mjs`'s `reindex()` (the curated, `--share`d-only exec feed). When the SAME entry is `--share`d, it exists in both source ledgers under the SAME `id` (mem.mjs's `append()` writes one entry object to both places), so both writers now target the IDENTICAL AI Search key (`sharedDocId(ring.label, eR.id)`, i.e. semantic.mjs's own `docId(agent,id)`) and store the SAME raw-text convention — a shared fact converges onto one row instead of two, from either writer, in either order. Entries that were never shared keep a unique key under the same scheme, so no ring's fleet-learning coverage is lost.

### Cleaning the pre-fix duplicates
Before the convergence fix, the fleet push used a different id scheme (`fleet__<label>__<...>`), so every already-shared entry has a stale duplicate row sitting in `memory-exec` today (measured ~882/6176 docs, ~14%, diluting recall). One-shot cleanup, dry-run by default:
```
node skills/ring-memory-index/index-ring-memory.mjs reconcile-fleet-dupes            # dry run: reports what WOULD be deleted
node skills/ring-memory-index/index-ring-memory.mjs reconcile-fleet-dupes --apply    # actually deletes
```
It only ever deletes a `fleet__*` doc that already has a converged (non-`fleet__`) twin holding the same fact (joined on exact `agent`+`ts`, which is stamped once on the source entry and copied everywhere it is written) — a `fleet__*` doc with no twin yet (never shared, or this ring hasn't been re-indexed under the converged scheme since the fix shipped) is always KEPT, never deleted. Safe to run before or after a fresh `run all`; running `run all` first (or waiting for the next scheduled run) migrates the never-shared entries onto the converged scheme too, so a second reconcile pass afterward can clean those up as well.
