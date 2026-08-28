---
name: azure-canary
description: "SUPERSEDED 2026-08-28 -- do not run or port. Was the fleet's Azure control-plane CANARY: a dead-job pager for Container Apps Jobs, per-index Azure AI Search freshness, per-PostHog-stream freshness, and a per-lane gateway synthetic probe. The Azure estate it watched (Container Apps, Azure AI Search, Key Vault) was permanently deleted 2026-08-13; its own nightly workflow has been schedule-disarmed since 2026-08-27 and is now deleted outright, alongside the related azure-watchdog.yml. Its successors on the AWS estate are aws-dr-canary (backup/snapshot freshness + n8n reachability), aws-image-canary (scheduled-ECS image-tag freshness, the dead-job-pager analog), and nightly-schedule-canary (cron-liveness heartbeats for the nightly workflow fleet). See the Status note at the bottom of this file for the two capabilities NOT yet ported anywhere (the per-lane synthetic gateway probe, and the PostHog stream-freshness checks) and what to reuse if they are ever rebuilt for AWS."
---

# azure-canary -- make the fleet's sensors' silence page us

> **SUPERSEDED (2026-08-28) -- read this before touching this skill.** This directory is kept for
> HISTORY only. Do not run `canary.mjs` and do not port it wholesale. Reasons:
> 1. **Its entire subject matter is permanently gone.** Every one of the four checks this canary ran
>    (dead-job pager, per-index AI Search freshness, per-PostHog-stream freshness, per-lane gateway
>    probe) authenticated against Azure control-plane resources -- Container Apps Jobs, Azure AI
>    Search, Key Vault -- on subscription `55c84f6b`, permanently deleted 2026-08-13. Every run since
>    then would fail or produce noise against dead resources, which is exactly why its own workflow
>    (`.github/workflows/nightly-azure-canary.yml`) was schedule-disarmed on 2026-08-27 (see that
>    file's own former header) and has now been **deleted outright**, alongside the related
>    `.github/workflows/azure-watchdog.yml` (the outside-Azure self-trigger for detecting Azure's own
>    death -- also fully disarmed, also moot once Azure is gone rather than merely unreachable;
>    `skills/fleet-backup/azure-watchdog.mjs`'s script is kept, tagged SUPERSEDED, not deleted).
> 2. **Three of its four checks already have live AWS-era successors, covering the same failure
>    CLASSES on the new estate:**
>    - `skills/aws-dr-canary/` -- backup/snapshot freshness (SSM secrets export, OpenSearch
>      snapshots, RDS, n8n Lightsail AutoSnapshot) + n8n reachability, using the identical
>      AGE-not-FLOOR discipline this file pioneered (a frozen backup never drops below a doc-count
>      floor; only AGE catches a silently-stalled artifact).
>    - `skills/aws-image-canary/` -- the direct analog of this file's "dead-job pager": instead of a
>      Container Apps Job's latest execution status, it catches a scheduled ECS task whose pinned ECR
>      image tag has aged out of its repo's lifecycle policy (the exact failure class that killed
>      `otchealth-job-otchealth-mcp-eval` silently for 3+ days, see `FND-20260821-29e2`).
>    - `skills/nightly-schedule-canary/` -- cron-liveness heartbeats for the nightly workflow fleet
>      (did the workflow's OWN schedule fire at all), the same schedule-liveness discipline this
>      file's own nightly workflow depended on (its `nightly-azure-canary` registry entry is removed
>      from `setup/heartbeat-registry.json` in the same change that deletes the workflow -- a deleted
>      workflow can never beat again, so leaving the entry would page forever on a corpse).
> 3. **Two capabilities have NOT been ported anywhere yet and are worth reusing directly if ever
>    rebuilt for AWS:**
>    - **The per-lane synthetic gateway probe** (`probeLane()` in `canary.mjs`) -- mints EACH gateway
>      lane's own OAuth `client_credentials` token (`cto`/`cfo`/`clo`/`developer`) and runs one real
>      `brain_search` end to end, so a lane OTHER than `cto` (the only lane every other check in the
>      fleet authenticates as) silently rotting -- an expired/rotated OAuth secret, a client dropped
>      from the gateway's `oauth-clients` registry, a ring-gating change that empties a lane's rooms
>      -- is no longer sensor-blind. No AWS-era canary carries this check today; the gateway itself is
>      now on ECS with an OpenSearch brain, but the lane-rot failure mode this guards against is
>      backend-agnostic and would port cleanly to a new or existing AWS-era canary.
>    - **The PostHog per-stream freshness checks (W1-5)** (`stream-freshness.mjs`, checking
>      `eval_result` / `$ai_generation` / `agent_session` / `medic_dispatch` against
>      `setup/expected-streams.json`) -- the same AGE-not-FLOOR discipline applied to the fleet's OWN
>      telemetry rather than its backups; this caught `$ai_generation`/`agent_session` sitting silent
>      ~367h and `medic_dispatch` ~331h, live, the day it was built. PostHog itself did not move with
>      the Azure retirement, so this check's *targets* are still live even though its *runner* (this
>      canary) is not -- a clean, standalone port candidate.
>
> **If either capability is ever genuinely needed again**, port `probeLane()` and
> `stream-freshness.mjs` as small, focused additions to an existing AWS-era canary (or a new one)
> rather than reviving this whole file -- the dead-job pager and per-index-freshness logic around
> them is not worth carrying forward; see point 2 above for what already replaces it.
>
> Everything below this note is the ORIGINAL skill documentation, preserved as-is for history; treat
> every Azure reference in it (Container Apps Jobs, Azure AI Search, Key Vault, `azure-sp`) as
> describing a dead target, not a live one.

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
5. **Per-lane synthetic probe** -- for each gateway lane in `cto`/`cfo`/`clo`/`developer`, mints that
   lane's own OAuth client_credentials token (`oauth-lane-<lane>-id`/`-secret`) and runs one real
   `brain_search` end to end, asserting HTTP 200, no JSON-RPC `isError`, and a non-empty
   `rooms_searched`. Every OTHER check in this file authenticates as `cto` only, so a different lane's
   client rotting (expired/rotated secret, dropped from the gateway's `oauth-clients` registry, a
   ring-gating change that empties its rooms) had zero coverage before this. A lane with no creds
   provisioned yet SKIPs with a warning (not an anomaly); a real failure is one. See `probeLane()` in
   `canary.mjs`.

## Run
```
node skills/azure-canary/canary.mjs [--json] [--strict]
```
`--strict` (or `AZURE_CANARY_STRICT=1`) makes any anomaly a non-zero exit (the nightly workflow uses it so
a stale index/stream / dead job / broken lane turns the run RED and pages). Omit it for a report-only
manual/local run. Emits an `azure_canary` event to the PostHog Fleet Agents project on every run (the
durable trend). Auth is the cto lane (`oauth-lane-cto-id` / `-secret` from Key Vault) for the job sweep +
`azure-sp` -> ARM `listQueryKeys` for the index-freshness probe; `posthog-personal-api-key` /
`posthog-fleet-project-id` (the same creds `fleet-medic` already reads) for the stream-freshness probe;
`oauth-lane-<lane>-id`/`-secret` per lane for the lane probe. Non-PHI; no secret value is ever printed.
