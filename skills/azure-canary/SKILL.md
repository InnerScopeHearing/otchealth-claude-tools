---
name: azure-canary
description: The fleet FRESHNESS + dead-job + telemetry-stream CANARY. Three checks. (1) DEAD-JOB PAGER, every scheduled Container Apps Job's latest run must be Succeeded (via the gateway's azure_jobs_list / azure_job_executions on the cto lane, the exact failure family that let daily-digest fail silently for 9 days). (2) PER-INDEX FRESHNESS, for every LIVE index in setup/expected-indexes.json the newest document's timestamp (indexed_at for the room indexes, ts for memory-exec) must be younger than that index's max_age_h SLO. This REPLACES the old single-index doc-count floor, the exact blind spot that let otchealth-brain sit frozen for ~12 days (a frozen index never drops below a floor, it stays identical forever, so only AGE catches it). (3) PER-STREAM FRESHNESS (W1-5), for every PostHog stream in setup/expected-streams.json (eval_result, $ai_generation, agent_session, medic_dispatch) the newest event's timestamp must be younger than that stream's max_age_h SLO -- the same AGE-not-FLOOR lesson applied to telemetry: this caught $ai_generation/agent_session sitting silent ~367h (~15 days) and medic_dispatch ~331h (~14 days), live, the day this check was built. All three read only timestamps/doc-counts/event-counts, never document or event-property content, so none of them breach the privileged rings. It always emits the PostHog azure_canary event + ::warning:: lines (the durable trend), and with --strict (how the nightly workflow runs it) a real anomaly (any index/stream STALE/NO_DATE/QUERY_ERROR or any scheduled job not Succeeded) is a NON-ZERO exit so the run goes RED and pages; it also goes red if it cannot run at all (dark sensor lane). Without --strict it is report-only (safe for manual/local runs). Runs nightly. Non-PHI. Creds via the shared kvSecret (cto lane for the job sweep; azure-sp -> ARM listQueryKeys -> a read-only AI Search query key for the index freshness probe; posthog-personal-api-key / posthog-fleet-project-id, the same creds fleet-medic already reads, for the stream freshness probe), never a local AZURE_SP-only reader.
---

# azure-canary -- make the fleet's sensors' silence page us

## Why this exists
ITEM #2 Phase A shipped six read-only Azure control-plane tools into the gateway. Those tools are the
SENSORS. A sensor with no monitor is just a tool nobody looks at. This is the MONITOR: it exercises the
sensors on a schedule and alerts when Azure control-plane visibility, the cron fleet, the brain index, or
the fleet's own telemetry/eval/medic streams go dark. It is the freshness canary + dead-job pager the
ITEM #2 work order calls for, extended (W1-5) to cover the self-improving loop's own PostHog streams.

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
4. **Per-stream freshness (W1-5)** -- for every stream in `setup/expected-streams.json`, reads the newest
   PostHog event's timestamp (via `skills/azure-canary/stream-freshness.mjs`, a HogQL `max(timestamp)`
   query) and flags any stream whose newest event is older than its `max_age_h` SLO, or that has never
   fired (NO_DATA). `medic_dispatch`'s SLO is deliberately much looser (168h vs 30h) than the other three
   -- it only fires on an actual dispatch/escalation, so zero events is healthy, not stale; see
   `stream-freshness.mjs`'s header for the full reasoning.

## Run
```
node skills/azure-canary/canary.mjs [--json] [--strict]
```
`--strict` (or `AZURE_CANARY_STRICT=1`) makes any anomaly a non-zero exit (the nightly workflow uses it so
a stale index/stream / dead job turns the run RED and pages). Omit it for a report-only manual/local run.
Emits an `azure_canary` event to the PostHog Fleet Agents project on every run (the durable trend). Auth
is the cto lane (`oauth-lane-cto-id` / `-secret` from Key Vault) for the job sweep + `azure-sp` -> ARM
`listQueryKeys` for the index-freshness probe; `posthog-personal-api-key` / `posthog-fleet-project-id`
(the same creds `fleet-medic` already reads) for the stream-freshness probe. Non-PHI; no secret value is
ever printed.
