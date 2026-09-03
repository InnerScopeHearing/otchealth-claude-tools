---
name: decision-clock
description: Tracks every OPEN gate the fleet is waiting on (rotate-a-secret, a Matt-only gate, a pending review, a security finding) with an owner and an expected-by SLA, so nothing quietly ages past its deadline. One doc per gate in the decisions_pending container, served by the fleet's RDS Postgres agent-state store (skills/kb-memory/pg-state.mjs). A daily Tier-1 sweep computes overdue/near-due items and sends ONE batched per-owner nudge via fleet-dispatch (never one-per-item spam), reusing the fleet-medic cooldown/escalate discipline; the sweep FAILS LOUD (non-zero exit) rather than silently succeeding if the store is unconfigured or unreachable. Non-PHI; INND-gated rows are CFO/CLO-visible only. Use to open a gate (`decision.mjs open --category ... --owner ... --expected-by ...`), list what is open/overdue, or ack/close a gate once resolved.
---

# decision-clock — a clock on every open gate

Answers "what are we waiting on, from whom, and is it late" without anyone having to remember to
check. One document per open gate lives in the `decisions_pending` container, partitioned by `/owner`.

## Backend: RDS Postgres via pg-state.mjs (ported 2026-09-03)

`skills/decision-clock/cosmos-client.mjs` (kept under its old name for every existing importer, see
below) used to be a raw Azure Cosmos DB for NoSQL REST client. Azure subscription `55c84f6b` was
permanently deleted 2026-08-13, so it now delegates its whole exported surface to
`skills/kb-memory/pg-state.mjs`, the fleet's RDS Postgres agent-state backend (built 2026-08-16 in PR
#437, wired into this and `signal-radar/common.mjs` -- its only two intended callers -- on 2026-09-03).
There is no Cosmos fallback and no `STATE_BACKEND` switch: Postgres is the only backend now, on
purpose, because a default-to-Cosmos branch could only ever reproduce the exact silent-no-op bug this
port fixes.

**Connection**: `pg-state.mjs` resolves `aws-pg-host` / `aws-pg-master-user` /
`aws-pg-master-password` / `aws-pg-port` via `kvSecret()` -- under the fleet default
`SECRET_BACKEND=ssm` that means AWS SSM `/otchealth/aws-pg-host` etc. Both this skill's ECS task
definition (`otchealth-job-decision-clock`) and its EventBridge schedule (`otchealth-decision-clock`,
currently DISABLED pending this port's own verification) already run under the shared
`otchealthTaskRole`, which already holds `ssm:GetParameter*` on `/otchealth/*` and network access to
the RDS security group -- **no task-definition or IAM change is needed** to make this work; enabling
the schedule is the only remaining step, and that is a deliberate human/CTO action, not part of this
skill's code.

**Callers unaffected**: every exported function name and call shape (`isConfigured`/`createDoc`/
`readDoc`/`replaceDoc`/`upsertDoc`/`queryDocs`/`newId`) is unchanged, so `decision.mjs`,
`digest-section.mjs`, and `skills/legal-deadline-pager/pager.mjs` (which syncs company-namespace
deadlines into this same `decisions_pending` container) needed no changes.

**Testing without a real Postgres connection**: `cosmos-client.mjs` exports a test-only
`_setBackendForTests(fake)` / `_resetBackendForTests()` seam (mirroring `pg-state.mjs`'s own
`_resetForTests()`), and `decision.mjs` exports `runSweep({ io, dispatch, dispatching, asJson })` with
both `io` and `dispatch` injectable. `node:test`'s `mock.module()` is not an option here (it needs
`--experimental-test-module-mocks`, which `run-tests.sh`'s `node --test` invocation does not pass);
see `tests/decision-clock-pg-state.test.mjs` for the working pattern.

## FAIL LOUD, not silent-success

`sweep --dispatch` (the ONLY thing the scheduled job runs, `job/decision-clock-sweep.sh`) now refuses
to report success while doing nothing: if the agent-state store is not configured, it prints a clear
`[decision-clock] sweep: agent-state store not configured (...)` line to stderr AND sets a non-zero
exit code, instead of the old "DRY-RUN; nothing to sweep" message that exited 0 either way. If the
store answers "configured" but a real query throws (host unreachable, bad credential), that exception
now propagates all the way out and the CLI's own top-level catch exits 1 -- it was never swallowed,
but this is worth stating explicitly since the sibling job (signal-radar) had exactly this class of bug
persisting silently in production for days before it was caught (see `cosmos-client.mjs`'s header for
that incident).

## Use
```
node skills/decision-clock/decision.mjs open --category rotate-secret --owner cto \
  --expected-by 2026-08-01 --evidence "https://..." --text "Rotate the github-app private key"

node skills/decision-clock/decision.mjs list [--owner cto] [--overdue] [--json]
node skills/decision-clock/decision.mjs ack   <id> --owner cto
node skills/decision-clock/decision.mjs close <id> --owner cto
node skills/decision-clock/decision.mjs sweep [--dispatch] [--json]   # the daily job entrypoint
```
`--category` picks a default SLA if `--expected-by` is omitted: `rotate-secret` 14d, `matt-gate` 3d,
`review` 7d, `security-finding` 5d, else 7d (`DEFAULT_SLA_DAYS` in `decision.mjs`).

Pass `--innd` on `open` to flag a row as INND/MNPI-gated (CFO/CLO visibility only by convention; the
sweep only ever nudges the row's own owner, never a cross-owner listing).

## What the sweep does
`sweep --dispatch` (the scheduled job entrypoint, `job/decision-clock-sweep.sh`) queries every open
row, classifies it overdue / near-due (default: due within 2 days) / open, groups by owner, and sends
**one** fleet-dispatch message per owner listing every item that needs attention (never a separate
dispatch per row). This reuses the exact cooldown/escalate discipline fleet-medic pioneered so a stuck
gate cannot spam an owner's inbox every run; run cadence itself is the throttle (daily).

## Where it runs
AWS ECS task definition `otchealth-job-decision-clock` (image `doc-indexer:latest`, command
`/app/skills/decision-clock/job/decision-clock-sweep.sh`), fired by EventBridge Scheduler
`otchealth-decision-clock` (`cron(15 23 * * ? *)`, daily). The schedule is currently DISABLED pending
this port's own operational verification; enabling it is a deliberate human/CTO action outside this
skill's code, not something to flip automatically. `job/decision-clock-job.md` documents the historical
Azure Container Apps provisioning path (dead: that subscription no longer exists) and is kept only as a
record of the job's shape; the live infrastructure is the AWS task definition + schedule named above.

## Data model
```
{ id, owner, category, text, opened_at, expected_by, status: open|ack|closed,
  evidence_link, innd?: true }
```
Append-only in spirit: `close` sets `status:"closed"` + `closed_at` rather than deleting, so a closed
gate stays as an audit record (queryable, just excluded from `sweep`/default overdue views).

## Non-goals (this PR ships the minimal version)
Auto-opening rows from ROTATE-BEFORE-LAUNCH lists or fleet-medic conditions is a documented follow-up,
not wired here; today every row is opened explicitly via `decision.mjs open`.

## Ring safety
Non-PHI. INND/MNPI-flagged rows (`--innd`) are a convention for CFO/CLO-only visibility; do not
`--include-personal`-style widen this without a legal-firewall review. Never store secret VALUES here,
only an `evidence_link` pointer.
