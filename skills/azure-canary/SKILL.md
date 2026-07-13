---
name: azure-canary
description: The fleet FRESHNESS + dead-job CANARY. Two checks. (1) DEAD-JOB PAGER, every scheduled Container Apps Job's latest run must be Succeeded (via the gateway's azure_jobs_list / azure_job_executions on the cto lane, the exact failure family that let daily-digest fail silently for 9 days). (2) PER-INDEX FRESHNESS, for every LIVE index in setup/expected-indexes.json the newest document's timestamp (indexed_at for the room indexes, ts for memory-exec) must be younger than that index's max_age_h SLO. This REPLACES the old single-index doc-count floor, the exact blind spot that let otchealth-brain sit frozen for ~12 days (a frozen index never drops below a floor, it stays identical forever, so only AGE catches it). It reads only the newest timestamp + doc count, never document content, so it does not breach the privileged rings. It always emits the PostHog azure_canary event + ::warning:: lines (the durable trend), and with --strict (how the nightly workflow runs it) a real anomaly (any index STALE/NO_DATE/QUERY_ERROR or any scheduled job not Succeeded) is a NON-ZERO exit so the run goes RED and pages; it also goes red if it cannot run at all (dark sensor lane). Without --strict it is report-only (safe for manual/local runs). This closes the gap where a frozen index emitted only to a dashboard nobody watched. Runs nightly. Non-PHI. Creds via the shared kvSecret (cto lane for the job sweep; azure-sp -> ARM listQueryKeys -> a read-only AI Search query key for the freshness probe), never a local AZURE_SP-only reader.
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
3. **Per-index freshness** -- for every LIVE index in `setup/expected-indexes.json`, reads the newest
   document's timestamp (`indexed_at` for the room indexes, `ts` for memory-exec) and flags any index
   whose newest doc is older than its `max_age_h` SLO, or that has no dateable document (NO_DATE). This
   replaces the old doc-count floor (a frozen index never trips a floor; only AGE catches it, which is how
   `otchealth-brain` sat frozen ~12 days). Reads only the timestamp, never document content.

## Run
```
node skills/azure-canary/canary.mjs [--json] [--strict]
```
`--strict` (or `AZURE_CANARY_STRICT=1`) makes any anomaly a non-zero exit (the nightly workflow uses it so
a stale index / dead job turns the run RED and pages). Omit it for a report-only manual/local run.
Emits an `azure_canary` event to the PostHog Fleet Agents project on every run (the durable trend). Auth
is the cto lane (`oauth-lane-cto-id` / `-secret` from Key Vault). Non-PHI; no secret value is ever printed.
