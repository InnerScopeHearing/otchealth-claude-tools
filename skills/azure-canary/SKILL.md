---
name: azure-canary
description: The Azure control-plane freshness + dead-job CANARY for the fleet (ITEM #2 Phase A monitor). Calls the gateway's Azure read tools (azure_jobs_list / azure_job_executions / azure_search_index_stats) the way the Chat CTO does -- a cto-lane client_credentials bearer against the live gateway /mcp over public HTTPS -- and raises a page-worthy signal if the tools are unreachable / erroring (gateway down or the managed identity lost its RBAC), if any scheduled Container Apps Job's latest run != Succeeded (the dead-job pager, the exact failure family that let daily-digest fail silently for 9 days), or if the otchealth-brain AI Search index doc count fell below a floor (broken reindex / emptied index). REPORT-ONLY (the PostHog azure_canary event + a ::warning:: line are the alert; exits non-zero only when it cannot run at all, which is itself the signal that the sensor lane is dark). Runs nightly as .github/workflows/nightly-azure-canary.yml. Non-PHI; reads only control-plane metadata, never secret values. Creds via kvSecret (never a local AZURE_SP-only reader).
---

# azure-canary -- make the Azure sensors' silence page us

## Why this exists
ITEM #2 Phase A shipped six read-only Azure control-plane tools into the gateway. Those tools are the
SENSORS. A sensor with no monitor is just a tool nobody looks at. This is the MONITOR: it exercises the
sensors on a schedule and alerts when Azure control-plane visibility, the cron fleet, or the brain index
goes dark. It is the freshness canary + dead-job pager the ITEM #2 work order calls for.

## What it checks (all read-only)
1. **Reachability / RBAC** -- mints a cto-lane bearer and calls the tools; a failure means the gateway is
   down or the gateway managed identity lost its least-privilege roles.
2. **Dead-job pager** -- for every `Schedule`-triggered Container Apps Job, reads the latest execution and
   flags anything not `Succeeded` (or with no executions).
3. **Freshness canary** -- reads the `otchealth-brain` index doc count and flags a drop below the floor
   (`AZURE_CANARY_BRAIN_FLOOR`, default 60000; brain sits ~67.6k).

## Run
```
node skills/azure-canary/canary.mjs [--json]
```
Emits an `azure_canary` event to the PostHog Fleet Agents project on every run (the durable trend). Auth
is the cto lane (`oauth-lane-cto-id` / `-secret` from Key Vault). Non-PHI; no secret value is ever printed.
