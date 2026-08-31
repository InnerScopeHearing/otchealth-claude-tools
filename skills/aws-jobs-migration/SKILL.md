---
name: aws-jobs-migration
description: HISTORICAL (Wave B of the Azure-exit emergency, 2026-08-16; migration COMPLETE, Azure permanently deleted). The Azure Container Apps Jobs <-> AWS EventBridge Scheduler matrix, the tooling that built it, and the 10 ECS task definitions + DISABLED schedules it registered for every recurring job that had no AWS twin. Use inventory-aws-jobs.mjs to enumerate the live AWS estate and build-missing-schedules.mjs (idempotent, --dry-run supported) to close any new gap the same way; data/matrix.json is a historical snapshot of a deleted estate, cited as evidence by open findings, NOT current state. inventory-azure-jobs.mjs is SUPERSEDED and must not be run — Azure is gone and it fails on auth. Every schedule this tooling creates is born DISABLED; nothing here ever enables one — cutover is a deliberate, per-job, human-gated action.
---

# aws-jobs-migration

> **HISTORICAL, 2026-08-31.** The migration this skill was built to drive is COMPLETE and Azure is
> permanently deleted. Live AWS state as of 2026-08-31: 33 EventBridge schedules, 24 ENABLED, 9
> deliberately DISABLED. `data/matrix.json` and the runbook are a snapshot of a deleted estate, kept
> because open findings cite them as evidence; they are not current state and nothing should be
> reconciled against them. `inventory-azure-jobs.mjs` is SUPERSEDED and fails on auth — see the
> STATUS CORRECTION at the top of `runbooks/AWS-JOBS-MIGRATION-WAVE-B.md`, including one unresolved
> date discrepancy flagged there rather than silently reconciled. `inventory-aws-jobs.mjs` and
> `build-missing-schedules.mjs` remain useful and correct.
>
> **Why the two AWS scripts still work although they import `kvSecret` from
> `../kb-memory/azure-secret.mjs` (a reasonable thing to misread, so stating it):** that module is
> named for its origin, not its current behavior. It imports `ssmSecret` from `./aws-secret.mjs` and
> resolves from AWS SSM Parameter Store under `SECRET_BACKEND=ssm`, which is the fleet default and is
> pinned by `setup/session-start.sh`. The Azure half is dead and unused. Verified by execution rather
> than by reading the import graph: `node inventory-aws-jobs.mjs` returns the live task-definition
> inventory today, with Azure permanently deleted. Under an explicit `SECRET_BACKEND=keyvault` they
> WOULD fail, which is the only configuration in which the import path means what it looks like.

Wave B answer to "does every Azure Container Apps Job that keeps the company running have a
working AWS twin, ready to flip on the moment Azure is billing-blocked." Read
`runbooks/AWS-JOBS-MIGRATION-WAVE-B.md` for the full narrative (verdict per job, blast-radius
classification, the recommended cutover order, and every gap found). This directory is the
tooling + data behind that report.

## Scripts

```bash
# SUPERSEDED -- DO NOT RUN. Azure is permanently deleted; this fails on auth. Kept only as the
# provenance of data/matrix.json's Azure half.
node inventory-azure-jobs.mjs [--out data/azure-jobs.json]

# Live pull of every AWS EventBridge schedule + ECS task-definition family.
node inventory-aws-jobs.mjs [--out data/aws-jobs.json]

# Idempotent builder: registers a task definition + a DISABLED schedule for any job in its JOBS[]
# list that does not already have one. Re-run any time; existing schedules are left untouched.
node build-missing-schedules.mjs --dry-run       # see what would be created, touch nothing
node build-missing-schedules.mjs                 # actually create the missing ones
node build-missing-schedules.mjs --only <name>   # build a single job
```

All three are dependency-free (hand-rolled SigV4, no aws-cli/AWS SDK — matches the convention in
`skills/kb-memory/aws-secret.mjs`) and read `aws-cto-access-key-id` / `aws-cto-secret-access-key`
plus the `azure-sp-*` credentials via `skills/kb-memory/azure-secret.mjs`'s `kvSecret()`.

## data/matrix.json

The structured, machine-readable version of the full 46-job matrix: one row per Azure job with its
live config, its AWS verdict (`HAS-AWS-TWIN` / `NO-AWS-TWIN-BUILT` / `ONE-SHOT-DELETE` /
`MANUAL-UTILITY-NO-SCHEDULE-NEEDED` / `PHI-WALL-NEVER-MIRROR`), its blast-radius classification for
a double-run, and a `notes` field documenting the evidence behind that classification (a script
actually read, a name-based inference, or an explicit call-out from the dispatch that opened this
wave). `fleet_kv_note` at the top of the file documents the Key-Vault-to-SSM credential fallback
finding (see the runbook) that applies fleet-wide, not per-row.

## The one hard rule

**Never flip a `State` to `ENABLED` from this tooling, ever.** Cutover is per-job, ordered, and
gated on disabling the Azure twin in the same action (never both running at once) — see the
runbook's recommended order before enabling anything by hand either.
