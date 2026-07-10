---
name: cfo-gateway
description: Gives the CFO agent its OWN cfo ring on the OTCHealth MCP gateway, so ring-gated finance/MNPI indexes (finance-cfo-source-docs, finance-otchealth-cfo-source-docs) resolve instead of returning forbidden_ring. The Hyperagent MCP UI connection authenticates as the shared cto lane (gateway OAUTH_DEFAULT_AGENT=cto), so ExecuteIntegration from the CFO is refused on finance; this skill mints a cfo-lane bearer via the client_credentials (M2M) grant using the vaulted oc_cfo creds and calls the gateway /mcp as the cfo lane. No gateway change required. cfo ring only; oc_cfo secret read from GCP Secret Manager, never printed. Run via the kb-memory credential wrapper (GCP SA): bash skills/kb-memory/run.sh node skills/cfo-gateway/cli.mjs <whoami|search|call>.
---

# cfo-gateway — the CFO's privileged lane to the gateway

## When to use
Any time the CFO needs ring-gated finance data the open `kb_search`/`memory_recall` tools won't serve:
`kb_search_privileged` over `finance-cfo-source-docs` / `finance-otchealth-cfo-source-docs`, or any other
cfo-ring tool. Open (non-privileged) work still goes through the normal gateway integration.

## How it works
1. Reads the `oc_cfo` client creds from GCP SM (`oauth-clients` registry; values never logged).
2. `POST https://mcp.otchealth.app/oauth/token` `grant_type=client_credentials` `scope=cfo` → cfo-lane bearer.
3. `POST https://mcp.otchealth.app/mcp` (JSON-RPC `tools/call`) with that bearer → served as the cfo lane.

## Commands (run via the kb-memory wrapper so the GCP SA is injected)
- `bash skills/kb-memory/run.sh node skills/cfo-gateway/cli.mjs whoami`
  → proves the cfo lane is ACTIVE (finance index accepted, not forbidden_ring).
- `bash skills/kb-memory/run.sh node skills/cfo-gateway/cli.mjs search finance-cfo-source-docs "<query>" --top 6 [--ack]`
  → privileged hybrid search. `--ack` passes `acknowledge_warning=true` to render MNPI/investor-sensitive
    payloads (cfo lane only; never echo MNPI to a non-cfo context).
- `bash skills/kb-memory/run.sh node skills/cfo-gateway/cli.mjs call <toolName> '<jsonArgs>'`
  → generic cfo-lane gateway tool call.

## Guardrails
- cfo ring ONLY. Do not use from other agents. Never expose MNPI to external clients or non-cfo lanes.
- Read-only finance retrieval; financial WRITES remain gated to Matt.
- If the grant ever fails (HTTP 401/invalid_client), the oc_cfo secret may have rotated — flag the CTO.
