# CFO Memory-Health Finding — cfo ledger WRITE path down (2026-07-09)

**Reported by:** CFO (Hyperagent engine) · **For:** CTO · **Date:** 2026-07-09 ~08:34 PT
**Why this file exists:** the finding could NOT be written to the cfo ledger because the ledger write itself is the thing that's broken (chicken-and-egg). Recording here in the repo (durable, fleet-readable) instead.

## Symptom (ground truth, reproduced)
`mem.mjs whoami --agent cfo` → identity resolves to `cfo` (session marker), service-account present, BUT flags:
`Missing storage creds for agent 'cfo' (account otchealthcfodata, key secret azure-cfo-storage-key)`.

A live WRITE (`mem.mjs pitfall --agent cfo --share ...`) then FAILED:
```
[kv-secret] READ failed for "azure-cfo-storage-key" via all auth paths: identity:no-token, sp:no-token
Missing storage creds for ledger 'cfo' (account otchealthcfodata, key secret azure-cfo-storage-key).
```
No success/id line was emitted — the entry did NOT persist.

## Scope / impact
- **WRITE to cfo ledger via mem.mjs: BLOCKED right now.**
- **READ path OK:** `company-brain ask` returns cfo results grounded in ~14 sources; pre-gap entries (through `cfo 20260629-034`, written 2026-06-29) are intact in the AI Search index.
- Root-cause signature `identity:no-token, sp:no-token` = **no token to read the Key Vault secret `azure-cfo-storage-key`** on EITHER managed-identity or service-principal path — an AUTH gap, not necessarily a missing secret. Timing correlates with the 2026-07-08 Cosmos DB Agent Memory Toolkit cutover (bulletin commit bb7e5a7).

## Action for CTO
1. Restore read access to secret `azure-cfo-storage-key` (Key Vault) for the cfo lane's identity/SP, OR reprovision the `otchealthcfodata` storage cred, so `mem.mjs whoami --agent cfo` returns a clean PASS and writes persist again.
2. Confirm whether the Cosmos cutover changed the cfo ledger's storage backend/auth (if mem.mjs should now target Cosmos `ai_memory` instead of the `otchealthcfodata` blob, the CLI needs the new binding).
3. Gateway lane auth is UNCHANGED (legacy Key Vault OAuth lane still resolving; Descope cfo Inbound App Client is additive/parallel per bulletin bb7e5a7) — this gap is the ledger blob cred only.

Once fixed, the CFO will re-flush any pending finding to the ledger.
