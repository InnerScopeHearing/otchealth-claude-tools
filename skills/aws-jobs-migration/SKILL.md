---
name: aws-jobs-migration
description: Wave B of the Azure-exit emergency (2026-08-16) — the authoritative Azure Container Apps Jobs <-> AWS EventBridge Scheduler matrix, the tooling that built it, and the 10 ECS task definitions + DISABLED schedules it registered for every recurring job that had no AWS twin. Use inventory-azure-jobs.mjs / inventory-aws-jobs.mjs to re-pull live state, build-missing-schedules.mjs (idempotent, --dry-run supported) to close any new gap the same way, and data/matrix.json as the structured source of truth behind runbooks/AWS-JOBS-MIGRATION-WAVE-B.md. Every schedule this tooling creates is born DISABLED; nothing here ever enables one — cutover is a deliberate, per-job, human-gated action documented in the runbook's recommended order.
---

# aws-jobs-migration

Wave B answer to "does every Azure Container Apps Job that keeps the company running have a
working AWS twin, ready to flip on the moment Azure is billing-blocked." Read
`runbooks/AWS-JOBS-MIGRATION-WAVE-B.md` for the full narrative (verdict per job, blast-radius
classification, the recommended cutover order, and every gap found). This directory is the
re-runnable tooling + data behind that report.

## Scripts

```bash
# Live, authoritative pull of every Azure Container Apps Job (both prod resource groups):
# name, cron, image, command/args, env, secretRefs, identity, last 5 executions.
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
