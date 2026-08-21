---
name: aws-image-canary
description: Catches a scheduled ECS task whose pinned container image tag has aged out of its ECR repository's lifecycle policy -- the failure class where EventBridge Scheduler fires correctly and ecs:RunTask returns SUCCESS in CloudTrail (the API call genuinely succeeds), but the task then fails at image pull before the container ever starts, writing ZERO lines to CloudWatch. This already happened live: otchealth-job-otchealth-mcp-eval pinned otchealth-mcp-gateway:28f3d25, that repo's lifecycle policy expires TAGGED images too (tagStatus:"any", keep last 10), and the job ran silently broken for at least 3 days (see FND-20260821-29e2 in FINDINGS-LEDGER.md). Neither nightly-schedule-canary (proves the schedule's own cron fired, via a self-beat the dead job never reaches) nor azure-canary's dead-job pager (proves the RunTask API call succeeded, which it did) can see this -- only asking ECR directly "does the image this task definition references still exist" can. Enumerates every ECS RunTask target of every active EventBridge Scheduler schedule (never hardcoded), resolves each container's image against ecr:DescribeImages, and also flags (lower severity, informational) any currently-live image that is close to falling out of its repo's "keep last N" window -- the leading indicator that would have caught the incident BEFORE it happened. Report-only by default; --strict pages on any unresolvable image. Read-only: makes no AWS mutation and is not wired into any scheduled job.
---

# aws-image-canary -- did a scheduled ECS job's pinned image quietly stop existing

## Why this exists

`otchealth-job-otchealth-mcp-eval` (an EventBridge Scheduler -> ECS RunTask job) pinned
`otchealth-mcp-gateway:28f3d25` in its task definition. The `otchealth-mcp-gateway` ECR repository
carries the lifecycle policy

```json
{"rulePriority":1,"selection":{"tagStatus":"any","countType":"imageCountMoreThan","countNumber":10},"action":{"type":"expire"}}
```

`tagStatus:"any"` expires TAGGED images too, not only untagged ones -- so every pinned tag anywhere in
the fleet that points at that repo is on a **10-deploy fuse**. Live-verified 2026-08-21: the repo held
exactly 10 images spanning ~28.5 hours of pushes, roughly one every ~2.85 hours -- a tag that stops
being the newest can fall out of the window in well under a day.

Once the pinned tag no longer existed in ECR, every scheduled firing still looked completely healthy
from the outside: EventBridge Scheduler dispatched on schedule, and `ecs:RunTask` returned SUCCESS in
CloudTrail (the API call genuinely succeeds -- ECS accepted the request and tried to start the task).
The task then failed at IMAGE PULL, before the container process ever started, so it wrote ZERO lines to
its own CloudWatch log group. Schedule healthy, API call healthy; only the absence of new log lines
(easy to miss) showed anything was wrong. This ran silently broken for at least 3 days before anyone
caught it. See `FND-20260821-29e2` in `../../FINDINGS-LEDGER.md` and this repo's `CLAUDE.md` "Fleet-wide
durable lessons from the Azure retirement + AWS migration" entry.

**Neither sibling canary catches this, and that is not a gap in either of them -- they are answering a
genuinely different question:**

- `skills/nightly-schedule-canary/schedule-canary.mjs` proves "did this workflow's own schedule fire at
  all", via a self-beat heartbeat written FROM INSIDE the job. A task that dies at image pull never
  starts running its own code, so it never gets the chance to write that heartbeat -- but the schedule
  itself fired exactly as expected, so schedule-liveness monitoring is not the gap here.
- `skills/azure-canary/canary.mjs`'s dead-job pager asks whether the LATEST ECS RunTask *execution*
  succeeded via the ECS API -- but RunTask's own API response IS a success in this failure mode. There is
  nothing for it to see go red.

The only way to see this failure class is to independently ask ECR "does the image this task definition
actually references still exist". That is the entire job of this file.

## How it works

1. **Enumerate every scheduled job, never a hardcoded list.** Lists every EventBridge Scheduler
   schedule in the account/region (`scheduler:ListSchedules`, paginated) and keeps the ones with
   `State:"ENABLED"`. This stays correct as jobs are added or removed with zero code change.
2. **Resolve each one's real target.** `scheduler:GetSchedule` per schedule (its full detail, including
   `Target.EcsParameters`, is not in the list summary). Schedules whose target is not ECS RunTask (no
   `EcsParameters.TaskDefinitionArn`) are reported separately and are out of scope for this canary.
3. **Read the task definition EXACTLY as the schedule names it.** `ecs:DescribeTaskDefinition` on the
   literal `TaskDefinitionArn` string the schedule carries -- a fully qualified `family:revision` ARN if
   the schedule pins an exact revision, or a bare family reference if it does not. This canary never
   assumes `:$LATEST`; it reads what the schedule literally targets, the same way `ecs:RunTask` itself
   would resolve it, and reports which shape each schedule used (`PINNED_REVISION` vs
   `FLOATING_LATEST` -- a floating reference is a materially different risk shape, since it can start
   pointing at a brand-new image with no schedule edit at all).
4. **Check every container's image against ECR.** For each container's `image` field that is a private
   ECR reference (repo + tag, or repo + digest -- Docker Hub and the public ECR gallery are out of
   scope, since this account's lifecycle policies cannot expire them), `ecr:DescribeImages` for that
   EXACT image. A 200 with a populated `imageDetails` means it exists (`RESOLVED`). An
   `ImageNotFoundException` means **this job's next scheduled firing will dispatch, RunTask will report
   SUCCESS, and the task will then fail at image pull with zero log output** -- this is the live,
   `--strict`-paging finding.
5. **Leading indicator (informational, lower severity).** For every repository with a "keep last N"
   lifecycle rule that is precisely modelable (`tagStatus:"any"`, no `tagPrefixList` narrowing it --
   the exact shape that caused the real incident), ranks the in-use image among every image in the repo
   by push time and reports how many more pushes to that SAME repo would expire it. This is the signal
   that would have caught the incident BEFORE it happened, not just after. A lifecycle rule scoped
   narrower than that (a `tagPrefixList`, or `tagStatus:"tagged"`) is reported as present, with no
   numeric claim attached -- ranking it correctly would require modeling that subset, which this canary
   deliberately does not attempt (see `isPreciselyModelable()`'s own comment for why guessing there
   would be worse than not claiming a number at all).

## Run

```
node skills/aws-image-canary/image-canary.mjs [--json] [--strict] [--warn-slots=N]
```

`--strict` (or `AWS_IMAGE_CANARY_STRICT=1`) makes any unresolvable image, or any check this script could
not complete at all (an unverifiable dependency is treated the same as a broken one, matching
`skills/cutover-preflight/preflight.mjs`'s own stated philosophy), a non-zero exit so a scheduled caller
can page on it. Omit it for a report-only manual/local run. The leading-indicator findings never affect
the exit code -- they are advance warning, not a live break -- but are always printed and always in the
`--json` output. `--warn-slots=N` (default 3, or `AWS_IMAGE_CANARY_WARN_SLOTS`) sets how many pushes-
from-expiry counts as "close" for the leading indicator.

**This script makes no AWS mutation.** Every call is a read (`List`/`Get`/`Describe`). It is not wired
into any scheduled job -- see the CTO's own report for the deploy recommendation, left for a human to
action deliberately.

## Auth

`resolveAwsCreds()` tries, in order: (1) the ECS task role / env-credential chain
`../kb-memory/aws-secret.mjs` already implements for every other AWS-touching skill in this repo, so
this script needs zero changes on the day it is actually wired into a scheduled ECS job and starts
running under a task role; (2) the same broad, read-heavy operator key
(`aws-cto-access-key-id`/`aws-cto-secret-access-key`) `skills/cutover-preflight/preflight.mjs` already
reads from Key Vault for exactly this shape of interactive, cross-service, read-only AWS check from an
agent seat. No secret value is ever printed.
