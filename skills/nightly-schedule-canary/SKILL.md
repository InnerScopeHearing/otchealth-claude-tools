---
name: nightly-schedule-canary
description: Checks whether every fleet nightly GitHub Actions workflow's OWN cron schedule is still firing, not whether that workflow's internal content check passed. Reads setup/heartbeat-registry.json entries tagged "kind":"nightly-workflow" (currently the 7 nightly monitors -- nightly-azure-canary, nightly-continuity-canary, nightly-embedding-drift, nightly-eval, nightly-fleet-sentinels, nightly-recall-eval, oauth-clients-canary), each of which self-beats via setup/heartbeat.mjs on every execution regardless of its own check's verdict, and flags any whose beat has gone stale relative to its own expected cadence (daily workflows get a ~26h SLO to tolerate occasional runner delay, the 6-hourly oauth-clients-canary gets ~8h). Catches the failure class a content check can never see on its own: a workflow that stopped running entirely (GitHub disables a schedule after 60 days of repo inactivity, a deleted/malformed workflow YAML, a cron typo) never gets the chance to go red, so only schedule-liveness monitoring catches it. Run from .github/workflows/nightly-fleet-sentinels.yml as a third sentinel alongside gateway-canary and drift-sentinel, and pages via setup/page-on-failure.mjs on the same terms. Report-only by default (safe for a manual/local run); --strict makes any stale schedule a non-zero exit so a scheduled caller can page on it. Deliberately kept separate from drift-sentinel.mjs's own --strict, since drift-sentinel's other two sub-checks (image-drift, drift-recon) can carry real, unrelated findings that would otherwise cause false paging on schedule staleness. Non-PHI; reads only job names and beat timestamps, never document or event-property content.
---

# nightly-schedule-canary -- did every nightly workflow's own cron actually fire

## Why this exists

`gateway-canary` and `drift-sentinel` used to be the only two monitors in `setup/heartbeat-registry.json`
that tracked "did this thing's own schedule ever run at all" (see those two entries' notes: both were
registered for weeks with **zero** backing workflow, so their heartbeats read `last-ok: never, literally`).
ITEM 2.3 (Wave 2, AI-OS research-pass 2026-07-21) generalizes that same idea to the fleet's other nightly
workflows: `nightly-azure-canary`, `nightly-continuity-canary`, `nightly-embedding-drift`, `nightly-eval`,
`nightly-fleet-sentinels`, `nightly-recall-eval`, and `oauth-clients-canary`.

This closes a **different** failure class than each workflow's own `--strict` content check. A content
check (azure-canary.mjs, continuity-canary.mjs, run-evals.mjs, ...) can only go red if it actually runs.
If the workflow's own GitHub Actions cron silently stops firing entirely (a 60-day repo-inactivity
schedule disable, a deleted or malformed workflow YAML, a cron-expression typo that never matches), the
content check never gets the chance to go red, and nothing pages. "Silence = failure" is exactly the
dead-man's-switch idea `setup/heartbeat.mjs` already applies to Container Apps Jobs; this applies the
same idea to plain GitHub Actions cron workflows, which have no ARM job to poll, so they self-beat
instead.

## How it works

1. Each of the 7 tracked nightly workflows carries a `setup/heartbeat.mjs beat <job> ok` step that fires
   **unconditionally** (`if: always()`) near the end of its job, regardless of whether that workflow's own
   check passed or failed. That beat represents "the schedule fired today", not "the content was
   healthy" -- the two are deliberately decoupled.
2. `setup/heartbeat-registry.json` tags each of those 7 job entries `"kind": "nightly-workflow"` with an
   `interval_min` matched to its own cadence (see each entry's `note` for the exact SLO and reasoning).
3. This script reads the registry for that tag (never a hardcoded list), shells out to the existing
   `node setup/heartbeat.mjs check --json` (reused, not reimplemented), and reports any tracked job whose
   status is not `LIVE` as an anomaly.
4. `.github/workflows/nightly-fleet-sentinels.yml` runs this as a third sentinel step (alongside
   `gateway-canary` and `drift-sentinel`) and pages via `setup/page-on-failure.mjs` on the same terms as
   every other nightly monitor if any tracked schedule has gone stale.

## Run

```
node skills/nightly-schedule-canary/schedule-canary.mjs [--json] [--strict]
```

`--strict` (or `NIGHTLY_SCHEDULE_CANARY_STRICT=1`) makes any stale/dead/missing tracked schedule a
non-zero exit, so the caller's job goes red and pages. Omit it for a report-only manual/local run.

Adding an 8th nightly workflow later is a one-line registry edit (add `"kind": "nightly-workflow"` to its
entry) plus wiring its own self-beat step, not a code change here.
