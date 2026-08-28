---
name: aws-dr-canary
description: The verification canary for the AWS-native disaster-recovery chain — proves the fleet's three nightly backups (SSM /otchealth/* secrets export to S3, OpenSearch otchealth-brain off-domain snapshots, RDS otchealth-pg automated snapshots) are actually LANDING, using AGE not a doc-count floor (a frozen backup never drops below a floor -- it stays byte-identical forever, exactly the failure class that let otchealth-brain sit frozen for ~12 days on the old Azure estate before anyone caught it). Four checks, all read-only except the weekly drill: (1) SSM archive freshness, S3 HeadObject on today's/yesterday's deterministic key, checked against a 26h SLO and a secretCount metadata floor (~455 params); (2) OpenSearch snapshot freshness, the domain's own _cat/snapshots response filtered to SUCCESS-only (never trusting a newer IN_PROGRESS/FAILED row) against a 26h SLO, plus the snapshot repo itself still being registered (a deleted repo is a distinct silent-failure mode from a stale snapshot); (3) RDS automated-snapshot freshness for otchealth-pg against a 26h SLO; (4) a weekly (gated by day-of-week) restore-PROOF drill that actually restores the smallest non-privileged OpenSearch index into a drill-* index and compares document counts, and decrypts a real SSM archive end to end to prove the DR passphrase still works — "restorable, not merely writable." Report-only by default (prints a plain table + JSON on request); --strict exits non-zero on any anomaly, which is how the nightly workflow runs it, and that non-zero exit is what makes setup/page-on-failure.mjs actually fire. Read-only except the drill's own bounded restore+delete of a throwaway drill-* index (never a live index). Non-PHI; privileged OpenSearch rooms (legal-personal*, finance-cfo-*) are excluded from what this canary drills against by construction (it only ever picks a non-privileged index), and it never reads document CONTENT from any index, only snapshot/index metadata and counts.
---

# aws-dr-canary — does the fleet's own backup silence page us

## Why this exists

Every backup this checks (`skills/fleet-backup/ssm-dr-export.mjs`, `skills/fleet-backup/os-snapshot.mjs`,
RDS's own automated snapshots) can fail SILENTLY in the exact same shape the fleet has already been
burned by twice: a scheduled job's own API call can succeed while the actual artifact it was supposed
to produce never lands (or stops updating), and nothing downstream ever looks hard enough to notice. A
doc-count floor cannot catch this — a frozen backup never drops below a floor, it just sits there,
identical, forever. Only checking AGE (is the newest artifact younger than its own SLO) catches a
silently-stalled backup, which is why every check below is age-based, mirroring `skills/azure-canary`'s
and `skills/aws-image-canary`'s own house convention for the identical class of failure.

## What it checks

1. **SSM secrets archive** (`skills/fleet-backup/ssm-dr-export.mjs`'s output): S3 `HeadObject` on the
   deterministic key `secrets-dr/daily/ssm-otchealth-<today>.json.enc`, falling back to `<yesterday>`
   (no `s3:ListBucket` needed — the keys are deterministic dates, matching `s3-client.mjs`'s
   least-privilege convention). Missing both → STALE. Present → `Last-Modified` age must be under 26h
   AND the `secretCount` custom-metadata value must be at least 400 (ground truth: ~455 params; a
   floor here catches a partial/regressed export that still landed a file).
2. **OpenSearch snapshot** (`skills/fleet-backup/os-snapshot.mjs`'s repo): the newest row with
   `status:"SUCCESS"` from `_cat/snapshots` must be under 26h old — a newer `IN_PROGRESS` or `FAILED`
   row is never mistaken for a live recovery point (see `os-snapshot.mjs`'s `newestSuccessfulSnapshot`,
   reused directly). The repo itself must still answer `GET _snapshot/<repo>` — a deleted/de-registered
   repo is a distinct silent-failure mode from "the last snapshot is old."
3. **RDS automated snapshot** for `otchealth-pg` (env `RDS_DB_INSTANCE_ID` to override): newest
   `SnapshotCreateTime` among `status:"available"` snapshots must be under 26h old.
4. **Weekly restore-proof drill** (gated to one day of the week, `AWS_DR_CANARY_DRILL_DOW`, default
   Sunday = 0): runs `os-snapshot.mjs restore-drill` for real (restores the smallest non-privileged
   index into `drill-<name>`, compares counts, deletes the drill index) and decrypts the current SSM
   archive end to end via `secrets-dr-restore.mjs` using `SECRETS_DR_PASSPHRASE`, so the pipeline is
   proven **restorable**, not merely writable, on a regular cadence without doing it every single night.

## Usage

```
node skills/aws-dr-canary/canary.mjs                 # report-only, human-readable table
node skills/aws-dr-canary/canary.mjs --json           # report-only, machine-readable
node skills/aws-dr-canary/canary.mjs --strict         # non-zero exit on any anomaly (how the nightly workflow runs it)
```

## Credentials

Ambient AWS identity only (an OIDC-assumed IAM role or the ECS task role, via
`skills/kb-memory/aws-secret.mjs`'s `awsCreds()`) — no secret-store lookup for the read-only checks.
The weekly drill's SSM-decrypt leg additionally needs `SECRETS_DR_PASSPHRASE` (a GitHub Actions repo
secret) to actually decrypt; without it that one sub-check reports `SKIPPED`, not a false anomaly.

## Ring safety

This canary never reads document content, secret values, or personal/financial data — only
timestamps, snapshot status strings, and document counts. The weekly drill only ever targets a
**non-privileged** OpenSearch index (via `os-snapshot.mjs`'s `classifyIndexLane`), so it never touches
`legal-personal*` or `finance-cfo-*` content, and privileged-lane OpenSearch snapshot DR is a
deliberately disarmed scaffold this canary does not check at all (see `os-snapshot.mjs`'s header).
