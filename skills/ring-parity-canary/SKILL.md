---
name: ring-parity-canary
description: Read-only evidence tool for EXEC_RING keep-or-cut decisions. Queries each executive-ring agent's (cfo/clo/cpo/cco/exec/clo-personal) Cosmos memory-of-record for real activity (record count, most recent write, status/decision counts) and flags any agent with zero records or no activity in 90+ days as DORMANT -- the same objective test that got coo/cro removed from EXEC_RING. Produces the evidence for Matt's one-sentence keep-or-cut call; never changes ring membership itself.
---

# ring-parity-canary

## What it answers
"Does this EXEC_RING member's Cosmos memory activity justify its standing finance-MNPI +
company-legal read access, or is the grant dormant?" -- the exact question that led to removing
`coo`/`cro` from `EXEC_RING`. This tool makes that check repeatable and objective instead of
ad-hoc.

## Run
```
node skills/ring-parity-canary/canary.mjs        # human-readable table
node skills/ring-parity-canary/canary.mjs --json # machine-readable
```

Requires Cosmos agent-state read creds (`cosmos-agent-state-endpoint` / `-key`) resolvable via
Key Vault or the GCP Secret Manager fallback -- same resolution path as every other kb-memory /
doc-indexer job. Read-only: it queries the `memory` container and writes nothing.

## Output
One row per ring agent: total memory records, `status`-kind count, `decision`-kind count, most
recent `created_at`, and a DORMANT/ACTIVE flag (dormant = zero records, or none in the last 90
days). This is EVIDENCE for a human decision, not the decision -- ring membership changes are a
deliberate code edit to `src/tools/kb/search-privileged.ts` in otchealth-mcp-server, reviewed and
deployed like any other security change.
