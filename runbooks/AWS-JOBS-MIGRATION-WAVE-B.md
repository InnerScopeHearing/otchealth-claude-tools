# AWS jobs migration — Wave B: the scheduled automation (2026-08-16)

> **STATUS CORRECTION, 2026-08-31 (read before anything below).** This document was written on
> 2026-08-16 and describes Azure as a LIVE system it was reading. **Azure is gone.** Subscription
> `55c84f6b-ef90-4259-a58b-50835cc4cab4` was permanently deleted and every Azure resource named
> below (Container Apps Jobs, Key Vault, AI Search, Blob, Foundry) is unreachable forever. Treat
> every Azure column, cron, and env value here as a **HISTORICAL SNAPSHOT of a deleted estate**,
> useful as the record of what once ran and why each AWS twin exists, and never as current state
> or as something to reconcile a live system against.
>
> The migration this document plans is DONE. Verified live 2026-08-31 against AWS EventBridge
> Scheduler: **33 schedules, 24 ENABLED, 9 DISABLED.** This supersedes the "32 schedules, all
> DISABLED" state described in the body below and in this PR's original description, which was
> accurate on 2026-08-16 and is not now. Reproduce it yourself rather than trusting this line
> (`aws scheduler list-schedules --max-results 100`, paginating on `NextToken`, in account
> `900915535335` / `us-east-1`; the counts below are that response grouped by `State`). Every
> claim in this correction block was taken from that call or from a per-schedule `GetSchedule`,
> not from any document. Note this does NOT reconcile to a tidy
> 22 + 10 = 32: schedules were added by later work after this wave closed (`otchealth-image-canary`
> is one such: its schedule was created 2026-08-28 and is ENABLED, distinct from the 2026-08-21 date
> the canary skill itself landed, since building it and scheduling it were separate gated actions),
> so the 33 is 22 pre-existing plus this wave's
> 10 plus later additions, net of anything retired since. Do not read the 33 as evidence about
> what THIS wave did — for that, the body below is the record. The nine still disabled are
> deliberate, not forgotten:
> `xero-run` (held by FND-20260816-5539 below, enabling it is new financial automation going live,
> not a like-for-like cutover), `deep-legal-personal` (attorney-privileged ring, excluded by
> design), `fleet-secret-custodian` (the skill itself was retired 2026-08-28 as a rewrite-not-port,
> so this schedule should be deleted rather than enabled), `os-healthz-monitor` (watches the
> retired os-chat app, same, delete not enable), plus `growth-room-nightly`, `sentinel-os-eval`,
> `decision-clock`, `agent-memory-worker`, `ledger-compaction`.
>
> **One unresolved discrepancy, flagged rather than silently reconciled:** this wave recorded live
> Azure job executions on 2026-08-14, 08-15 and 08-16 (see the `sentinel-os-eval` evidence and
> FND-20260816-1aa3), which postdates the 2026-08-13 deletion date asserted in the fleet CLAUDE.md
> files. Both cannot be right. The execution records are too specific and internally consistent to
> be fabricated, so the likeliest reading is that 08-13 was the EVACUATION date and final deletion
> landed a few days later. Not resolved here because it changes no current action, and guessing a
> date into the durable record is how the drift starts.

**Status when written (2026-08-16, now superseded by the correction above): matrix complete,
10 missing schedules built and DISABLED, cutover order recommended. Nothing enabled. No Azure
job touched.**

Companion docs: `otchealth-cto/runbooks/AWS-CUTOVER-2026-08-14.md` (the DNS/compute/search cutover
this wave feeds into), `otchealth-cto/runbooks/AZURE-EVACUATION-2026-08-13.md`, the
`otchealth-mcp-server` branch `claude/aws-iac` (unmerged, capture-only Terraform of the pre-existing
22 — read as reference, not touched by this wave), and `skills/cutover-preflight/` (the live GO/NO-GO
gate for the DNS+search+data-plane cutover; its `JOBS` check is generic-count only and does not
replace this matrix). Tooling + structured data: `skills/aws-jobs-migration/`.

## The headline

Azure runs **46 Container Apps Jobs**. Before this session, AWS had 22 EventBridge schedules
(all DISABLED, never executed) covering less than half of them. This session:

1. Built the full **46-row matrix** (live Azure config, live AWS config, a verdict, a blast-radius
   classification, and the evidence behind each) — `skills/aws-jobs-migration/data/matrix.json`.
2. Registered the missing **10 ECS task definitions + 10 EventBridge schedules**, all **DISABLED**,
   for every job confirmed genuinely recurring with no AWS twin.
3. Found and corrected a live, verifiable **fleet-wide credential gap** that would have silently
   broken most of these jobs (old and new alike) the moment they actually ran — see "The Key Vault
   correction" below.
4. Found a **real cron discrepancy on `xero-run`** that makes "enable its AWS twin" NOT a like-for-like
   cutover — see the xero-run row.
5. Produced a full **cutover order**, tiered by blast radius, extending the partial order already in
   `AWS-CUTOVER-2026-08-14.md`.

AWS now has **32 EventBridge schedules, all still DISABLED**, plus **38 ECS task-definition
families**. Verified live twice: once immediately after building, once again independently while
writing this report (`node skills/aws-jobs-migration/inventory-aws-jobs.mjs`).

## Verdict summary

| Verdict | Count | Meaning |
|---|---|---|
| `HAS-AWS-TWIN` | 22 | Already built before this session; cross-checked live, one real bug found (xero-run cron) |
| `NO-AWS-TWIN-BUILT` | 10 | Built this session — task def + DISABLED schedule now exist |
| `ONE-SHOT-DELETE` | 11 | One-off Neon→Azure migration/provisioning helpers, verified by reading every script, not assumed |
| `MANUAL-UTILITY-NO-SCHEDULE-NEEDED` | 2 | On-demand DR-dump utilities, Manual trigger on Azure too — not "recurring automation," need no schedule |
| `PHI-WALL-NEVER-MIRROR` | 1 | Deliberately excluded — PHI must never touch this non-BAA AWS account |
| **Total** | **46** | |

**Reconciling against the dispatch's own estimate:** the dispatch guessed "~13 recurring jobs likely
have no AWS equivalent," from `46 − 11 (one-shot) − 22 (built) = 13`. The actual number is **10**.
The gap is explained, not hand-waved: **3 jobs (`pg-dr-dump`, `pg-dump-nonphi`, `pg-phi-dr-dump`) are
Manual-trigger on Azure too** — they have no cron there either, so they were never "recurring
scheduled automation" in the EventBridge sense to begin with. `13 − 3 = 10`, which is exactly what
was built. One of those three (`pg-phi-dr-dump`) is the PHI-wall exclusion above.

## Methodology — read this before trusting any row

Every fact in the matrix was pulled **live** this session (2026-08-16), not copied from a prior
document:

- **Azure**: `skills/aws-jobs-migration/inventory-azure-jobs.mjs` — direct ARM REST calls
  (`azure-sp` client_credentials, no `az` CLI) against `Microsoft.App/jobs` across both
  `rg-otchealth-apps-prod` and `otchealth-automation-rg`, plus each job's last 5 executions.
- **AWS**: `skills/aws-jobs-migration/inventory-aws-jobs.mjs` — direct signed REST calls (hand-rolled
  SigV4, no aws-cli/SDK) against EventBridge Scheduler and ECS.
- **Every `ONE-SHOT-DELETE` verdict is backed by actually reading that job's full shell script**
  (via the ARM API's `args` field, which for these jobs is the literal inline script), not by pattern-
  matching the job's name. Two, `pg-migrate-flatstick` and `pg-migrate-fourvault`, contain a real
  `DROP DATABASE IF EXISTS` — flagged explicitly in the matrix notes as "confirm before deleting,"
  not silently marked safe.
- A prior, unmerged capture exists at `otchealth-mcp-server` branch `claude/aws-iac`
  (Terraform, adopt-only, built ~14 hours before this session by a concurrent effort on the same
  emergency). It was used as a **cross-check and pattern reference** — four of its existing-22 task
  definitions were spot-read to derive the exact Azure→AWS translation rules below
  (`otchealth-job-brain-reindex`, `otchealth-daily-digest`, `otchealth-innd-stock-daily`,
  `otchealth-os-anomaly-watch` — the same four named under "Methodology" below), plus one schedule
  (`GetSchedule` on `otchealth-librarian-commerce`) for the schedule shape. An earlier revision of this
  line said "five task definitions", which overcounted by folding that schedule read into the
  task-definition count — but every number
  in this report was independently re-verified live, not copied from it. One live drift was found in
  that window: a 27th task-definition family (`otchealth-agentstate-verify`) had been added by another
  concurrent session since that capture; it is a one-shot utility, outside this wave's recurring-job
  scope, and untouched.

### The exact translation rule (derived, not invented)

Spot-checking `otchealth-job-brain-reindex`, `otchealth-daily-digest`, `otchealth-innd-stock-daily`,
and `otchealth-os-anomaly-watch` against their Azure originals gives a mechanical, byte-for-byte rule,
<!-- QUALIFIED 2026-08-31: "byte-for-byte" describes the FIELD-MAPPING rule below (cron syntax,
image, command, cpu/memory shape), not the full job definition, and the unqualified phrasing
overstated it. Two categories are deliberately NOT carried across and were not called out:
(1) Azure env/secret inputs judged vestigial on AWS -- e.g. `agent-state-janitor` carries
`GCP_CLAUDE_DRIVER_SA_JSON_B64` plus a `sab64` secretRef in the matrix, and its row's
`classification_basis` is `inferred`, not `task-explicit`; (2) `replica_timeout_s`, see the
execution-time gap noted below. Rows whose `classification_basis` is `inferred` are reasoned, not
verified, and a cutover decision that depends on one should verify that job's script first. -->

applied uniformly to build the 10 new jobs:

| Azure Container App field | → | AWS ECS field |
|---|---|---|
| `template.containers[0].command` | → | `containerDefinitions[0].entryPoint` |
| `template.containers[0].args` | → | `containerDefinitions[0].command` |
| `family` name | → | `otchealth-job-<azure-job-name>` |
| schedule name | → | `otchealth-<azure-job-name>` |
| 5-field cron `m h dom mon dow` (dow=`*`) | → | `cron(m h dom mon ? *)` |
| Fargate cpu/memory | → | nearest valid Fargate combo to the Azure vCPU/Gi request, matched to the same tier an existing sibling job already uses |
| every schedule | → | `group=default`, `flexibleTimeWindow OFF`, `launchType FARGATE`, `assignPublicIp ENABLED`, subnets `subnet-0a94aaba3ce6e2623,subnet-0e39a2049aa73ab50,subnet-09695b3527b656f4a`, security group `sg-0a5d44b67befc3bbe`, role `otchealthSchedulerRole`, retry `maxAttempts=1 maxEventAge=3600s`, **`State: DISABLED`** |

Public Docker Hub images (the `node@sha256:...`-pinned jobs) carry the identical digest across both
clouds — content-addressable, no ECR mirror needed. `doc-indexer`-based jobs use
`900915535335.dkr.ecr.us-east-1.amazonaws.com/doc-indexer:latest`, matching what the existing 22
already settled on (Azure pins some of these to a specific sha256 digest; the AWS twins uniformly use
`:latest` — an existing precedent this wave followed rather than re-litigated).

## Two known equivalence gaps (added 2026-08-31, unresolved by design)

Both were unstated assumptions in the original write-up, surfaced by review. Neither is live
exposure today, because all ten schedules this wave created remain DISABLED — but both must be
answered per-job BEFORE any of them is enabled, and neither is answered here.

**1. Azure `replica_timeout_s` is not carried into any AWS-side execution limit.** The matrix records
Azure timeouts from 60 to 14,400 seconds. Azure Container Apps Jobs enforce that as a hard replica
timeout; an ECS scheduled task has no direct equivalent, so a hung or runaway job has no
platform-level bound and can run until it is noticed. The builder does not set one and does not
mention the omission. In practice the doc-indexer-family jobs impose their OWN soft budget
(`--max-minutes`, which is why the finance backfill exits cleanly at its limit rather than being
killed), so for those the gap is covered at the application layer — but that is a property of those
scripts, not of the migration, and it does not hold for the rest. Before enabling any job whose
Azure `replica_timeout_s` was meaningful, decide where its bound now lives.

**2. `build-missing-schedules.mjs` is not idempotent across a CreateSchedule failure.** It registers
the ECS task definition BEFORE creating the schedule (it needs the ARN), so if CreateSchedule
definitively fails, a re-run finds no schedule, proceeds, and registers a SECOND task-definition
revision. Registration is additive rather than destructive, so the consequence is silent revision
churn rather than damage — but the script's own docs advertise re-run safety without this caveat.
The 2026-08-31 fail-closed fix addresses a different case (an INCONCLUSIVE existence check no longer
authorizes any mutation); this one is a genuine create-failure path and is documented rather than
fixed, because deduplicating by task-definition content is a larger change than this near-dormant
script warrants.

## The Key Vault correction (found, then found already fixed, mid-session)

Reading the pre-existing 22 twins' actual deployed environment variables turned up what looked like a
serious, wide gap: **11 of the 22** (`brain-reindex`, `daily-digest`, `deep-finance`,
`deep-legal-company`, `deep-legal-personal`, `fleet-backup`, `fleet-secret-custodian`,
`librarian-commerce`, `librarian-finance`, `librarian-legal-company`, `librarian-legal-personal`)
carry `AZURE_KEYVAULT_NAME` and/or a stale `AZURE_UAMI_CLIENT_ID` forward from Azure, but **neither
is functional on ECS Fargate** — there is no Azure managed identity there, and no
`AZURE_SP_CLIENT_ID`/`SECRET` fallback is wired into their task definitions. Every doc-indexer-based
job calls `kvSecret()` internally for its real work; on AWS, that call would fail on all three of its
Azure auth paths (identity / SP / az-CLI) before doing anything useful. The same shape applies to
**9 of the 10 jobs built this session** (everything except `agent-memory-worker`, whose gap is
different — see below).

This matches the dispatch's own warning almost exactly ("Note `kvSecret()` currently reads ONLY from
Azure Key Vault, and 16 of the 22 Fargate jobs resolve their credentials through it... a separate
agent is landing the AWS/SSM secret fallback"). *(The dispatch's "16 of the 22" is quoted verbatim
and does not match this report's own count of 11 pre-existing twins plus 9 of the 10 new jobs. The
quote is retained as written because it is someone else's text and is the reason this was
investigated; where the two disagree, this report's enumerated list above is the measured number and
the dispatch's figure is an estimate that prompted the check.)* **That separate fix has already landed** —
`skills/kb-memory/aws-secret.mjs` merged to `main` in commit `6dee16d`, the same commit that shipped
`skills/cutover-preflight/`, evidently a concurrent sibling wave working this exact emergency in
parallel. It adds an automatic Key-Vault-then-SSM cross-cloud fallback **inside `kvSecret()` itself**
— every job script that already calls `kvSecret(name)` gets the fallback for free, no task-definition
change required.

> **RUNTIME EVIDENCE ADDED 2026-08-31.** As written above, this section proved the fix from a SOURCE
> COMMIT plus SSM reads made with the authoring session's own credentials. Neither establishes what
> actually matters: that the **deployed** `doc-indexer:latest` image (a mutable tag) contains
> `aws-secret.mjs`, or that it resolves secrets at runtime under the **ECS task role** rather than
> under a human's credentials. Those are different claims, and the gap between them is the same
> "source commit is not a deployed artifact" shape this fleet has been bitten by repeatedly.
>
> That gap is now closed by execution, not inference. ECS task `b3a8f859` ran
> `otchealth-job-librarian-finance:6` on image `doc-indexer:latest` on 2026-08-30/31 and completed
> **16,145 documents with 16,043/16,043 LLM calls succeeding**, writing to both Amazon Bedrock and
> the OpenSearch brain. Every one of those calls required credentials resolved through `kvSecret()`
> inside the container, with no Azure reachable anywhere. The mechanism therefore works in the
> deployed image, under the task role, at scale.
>
> **What this does NOT prove, stated plainly:** it is evidence for the pre-existing definitions that
> share this image and role, not per-definition proof for the **nine new ones**, which have never
> executed because they were created DISABLED by design and remain so. They inherit the same image
> and the same task-role pattern, which is a strong prior, but "inherits the pattern" is an argument
> and the 16,043 calls are an observation. Enabling any of the nine is still a per-job gated action
> whose first run is its own first proof.

**This was verified live, not merely read from the code**, before writing this note: a real
SigV4-signed `GetParameter` call against AWS SSM, using the `aws-cto-*` credential path, successfully
resolved `azure-foundry-key`, `azure-openai-key`, and `posthog-fleet-ingest-key` — three real fleet
secrets the doc-indexer jobs actually depend on. `otchealthTaskRole` (the task role every job
definition uses, old and new) already carries `ssm:GetParameter{,s,ByPath}` plus a scoped
`kms:Decrypt` on `arn:aws:ssm:*:*:parameter/otchealth/*`, and `aws-secret.mjs`'s credential resolver
prefers the ECS task-role metadata endpoint before any static key — exactly the grant and the
resolution order needed for this to work unattended on a real Fargate task, not just from this
session's sandbox.

**Net effect:** the Key Vault gap is **closed for the 20 jobs it affected**, fleet-wide, as of today.
No task-definition changes were made or are needed — the fix lives entirely in the shared
`kvSecret()` code path every one of these jobs already calls. This is documented in full inside
`fleet_kv_note` at the top of `data/matrix.json` so it travels with the data, not just this prose.

## The xero-run cron discrepancy — do not enable as a "twin"

`xero-run`'s own Azure schedule is `0 0 30 2 *` — **February 30th, a date that never occurs.** This
job is **de facto disabled on Azure today**, confirmed live (not inferred from a doc), and matches
the CTO CLAUDE.md's own 2026-08-01 flag ("`xero-run`'s schedule trigger also looks empty/disabled").

Its AWS twin instead carries a real, live daily cron: `cron(0 7 * * ? *)`. **These are not
equivalent.** Enabling the AWS schedule as it stands would make `xero-run` — a job that **posts to a
real accounting ledger** — start running on a daily cron.

> **CORRECTION 2026-08-31 (raises the risk, does not lower it).** This paragraph originally said the
> job "currently never runs on Azure at all." That is contradicted by this report's own matrix row,
> which records `xero-run` `last_execution_status: Succeeded` at `2026-08-14T07:00:00Z`. A Feb-30 cron
> proves the SCHEDULE never fires; it does not prove the JOB never runs. Something invoked it — manual
> dispatch, an external trigger, or another orchestrator — and note the recorded execution time
> (07:00Z) is exactly the AWS twin's `cron(0 7 * * ? *)`, which is worth explaining before anyone
> enables anything.
>
> This makes the double-post exposure WORSE than the original text implied, not better: if some other
> path already runs this job daily at 07:00, enabling the AWS cron does not start a dormant job, it
> adds a SECOND daily run against a real accounting ledger — the exact incident the notes warn about.
> The question below is therefore not "is the daily cron intended" alone, but "what already invokes
> this job, and would the AWS cron duplicate it."
That is not a cutover, it is new financial automation going live for the first time, and per the
standing accounting-objects rule (**reverse, never void, with readback on every object**), this needs
a CFO/Matt decision before it is ever enabled on either cloud: is the daily 7am cron the intended
behavior (Azure's Feb-30 cron is the bug), or does `xero-run` intentionally run some other way (manual
dispatch, an external trigger) and neither cron should be enabled? **Flagged, not decided, not
touched.** Logged as `FND-20260816-5539` in the findings-ledger so it cannot silently vanish.

## Full matrix

RG column: `automation` = `otchealth-automation-rg`, `apps-prod` = `rg-otchealth-apps-prod`.
Full detail (image, command, env, secrets, evidence basis per verdict) lives in
`skills/aws-jobs-migration/data/matrix.json`; this table is the at-a-glance view.

| Azure job | RG | Azure cron | Verdict | AWS schedule | AWS cron | Blast radius | Last exec |
|---|---|---|---|---|---|---|---|
| `agent-memory-worker` | automation | `*/15 * * * *` | **NO-AWS-TWIN-BUILT** | `otchealth-agent-memory-worker` | `cron(*/15 * * * ? *)` | WRITES-DUPLICATE | Succeeded 2026-08-16 |
| `agent-state-janitor` | automation | `30 */6 * * *` | **NO-AWS-TWIN-BUILT** | `otchealth-agent-state-janitor` | `cron(30 */6 * * ? *)` | IDEMPOTENT-SAFE | Succeeded 2026-08-16 |
| `brain-reindex` | automation | `50 */6 * * *` | **HAS-AWS-TWIN** | `otchealth-brain-reindex` | `cron(50 */6 * * ? *)` | IDEMPOTENT-SAFE | Succeeded 2026-08-16 |
| `cfo-reconstruction-nightly` | automation | `10 8 * * *` | **NO-AWS-TWIN-BUILT** | `otchealth-cfo-reconstruction-nightly` | `cron(10 8 * * ? *)` | IDEMPOTENT-SAFE | Succeeded 2026-08-16 |
| `daily-digest` | automation | `59 23 * * *` | **HAS-AWS-TWIN** | `otchealth-daily-digest` | `cron(59 23 * * ? *)` | IDEMPOTENT-SAFE | Succeeded 2026-08-15 |
| `decision-clock` | automation | `15 23 * * *` | **NO-AWS-TWIN-BUILT** | `otchealth-decision-clock` | `cron(15 23 * * ? *)` | WRITES-DUPLICATE | Succeeded 2026-08-15 |
| `deep-finance` | automation | `0 5 1 1 *` | **HAS-AWS-TWIN** | `otchealth-deep-finance` | `cron(0 5 1 1 ? *)` | IDEMPOTENT-SAFE | Succeeded 2026-08-16 |
| `deep-legal-company` | automation | `0 5 1 1 *` | **HAS-AWS-TWIN** | `otchealth-deep-legal-company` | `cron(0 5 1 1 ? *)` | IDEMPOTENT-SAFE | Succeeded 2026-08-16 |
| `deep-legal-personal` | automation | `0 5 1 1 *` | **HAS-AWS-TWIN** | `otchealth-deep-legal-personal` | `cron(0 5 1 1 ? *)` | IDEMPOTENT-SAFE | Succeeded 2026-08-16 |
| `docintel-ocr-sweep` | apps-prod | `0 */2 * * *` | **HAS-AWS-TWIN** | `otchealth-docintel-ocr-sweep` | `cron(0 */2 * * ? *)` | IDEMPOTENT-SAFE | Succeeded 2026-08-16 |
| `fleet-backup` | apps-prod | `0 6 * * *` | **HAS-AWS-TWIN** | `otchealth-fleet-backup` | `cron(0 6 * * ? *)` | WRITES-DUPLICATE | Succeeded 2026-08-16 |
| `fleet-medic` | automation | `*/30 * * * *` | **NO-AWS-TWIN-BUILT** | `otchealth-fleet-medic` | `cron(*/30 * * * ? *)` | WRITES-DUPLICATE | Succeeded 2026-08-16 |
| `fleet-secret-custodian` | apps-prod | `0 7 * * 1` | **HAS-AWS-TWIN** | `otchealth-fleet-secret-custodian` | `cron(0 7 ? * MON *)` | IDEMPOTENT-SAFE | Succeeded 2026-08-10 |
| `fv-migrate` | apps-prod | Manual | **ONE-SHOT-DELETE** | — | — | N/A | Succeeded 2026-07-18 |
| `growth-room-nightly` | automation | `50 8 * * *` | **NO-AWS-TWIN-BUILT** | `otchealth-growth-room-nightly` | `cron(50 8 * * ? *)` | WRITES-DUPLICATE | Succeeded 2026-08-16 |
| `innd-stock-daily` | automation | `30 22 * * 1-5` | **HAS-AWS-TWIN** | `otchealth-innd-stock-daily` | `cron(30 22 ? * MON-FRI *)` | WRITES-DUPLICATE | Succeeded 2026-08-14 |
| `ledger-compaction` | automation | `0 8 * * *` | **NO-AWS-TWIN-BUILT** | `otchealth-ledger-compaction` | `cron(0 8 * * ? *)` | **HIGH-RISK-CORRUPTION** | Succeeded 2026-08-16 |
| `librarian-commerce` | automation | `15 * * * *` | **HAS-AWS-TWIN** | `otchealth-librarian-commerce` | `cron(15 * * * ? *)` | IDEMPOTENT-SAFE | Succeeded 2026-08-16 |
| `librarian-finance` | automation | `0 */6 * * *` | **HAS-AWS-TWIN** | `otchealth-librarian-finance` | `cron(0 */6 * * ? *)` | IDEMPOTENT-SAFE | Succeeded 2026-08-16 |
| `librarian-legal-company` | automation | `20 */6 * * *` | **HAS-AWS-TWIN** | `otchealth-librarian-legal-company` | `cron(20 */6 * * ? *)` | IDEMPOTENT-SAFE | Succeeded 2026-08-16 |
| `librarian-legal-personal` | automation | `40 */6 * * *` | **HAS-AWS-TWIN** | `otchealth-librarian-legal-personal` | `cron(40 */6 * * ? *)` | IDEMPOTENT-SAFE | Succeeded 2026-08-16 |
| `memory-librarian` | automation | `0 8 * * *` | **NO-AWS-TWIN-BUILT** | `otchealth-memory-librarian` | `cron(0 8 * * ? *)` | IDEMPOTENT-SAFE | Succeeded 2026-08-16 |
| `os-anomaly-watch` | apps-prod | `0 */6 * * *` | **HAS-AWS-TWIN** | `otchealth-os-anomaly-watch` | `cron(0 */6 * * ? *)` | IDEMPOTENT-SAFE | Succeeded 2026-08-16 |
| `os-healthz-monitor` | apps-prod | `*/5 * * * *` | **HAS-AWS-TWIN** | `otchealth-os-healthz-monitor` | `cron(*/5 * * * ? *)` | IDEMPOTENT-SAFE | Succeeded 2026-08-16 |
| `os-morning-brief` | apps-prod | `0 12 * * *` | **HAS-AWS-TWIN** | `otchealth-os-morning-brief` | `cron(0 12 * * ? *)` | WRITES-DUPLICATE | Succeeded 2026-08-16 |
| `os-reflective-memory` | apps-prod | `30 13 * * *` | **HAS-AWS-TWIN** | `otchealth-os-reflective-memory` | `cron(30 13 * * ? *)` | WRITES-DUPLICATE | Succeeded 2026-08-16 |
| `otchealth-mcp-eval` | apps-prod | `0 7 * * *` | **HAS-AWS-TWIN** | `otchealth-otchealth-mcp-eval` | `cron(0 7 * * ? *)` | IDEMPOTENT-SAFE | Succeeded 2026-08-16 |
| `pg-dr-dump` | automation | Manual | **MANUAL-UTILITY-NO-SCHEDULE-NEEDED** | — | — | WRITES-DUPLICATE | Succeeded 2026-08-13 |
| `pg-dump-nonphi` | automation | Manual | **MANUAL-UTILITY-NO-SCHEDULE-NEEDED** | — | — | WRITES-DUPLICATE | Succeeded 2026-08-04 |
| `pg-listdb` | automation | Manual | **ONE-SHOT-DELETE** | — | — | N/A | never run |
| `pg-migrate-flatstick` | automation | Manual | **ONE-SHOT-DELETE**⚠ | — | — | N/A | never run |
| `pg-migrate-fourvault` | automation | Manual | **ONE-SHOT-DELETE**⚠ | — | — | N/A | never run |
| `pg-newdb-companion` | automation | Manual | **ONE-SHOT-DELETE** | — | — | N/A | never run |
| `pg-newdb-fourvault` | automation | Manual | **ONE-SHOT-DELETE** | — | — | N/A | never run |
| `pg-newdb-medreview` | automation | Manual | **ONE-SHOT-DELETE** | — | — | N/A | never run |
| `pg-phi-dr-dump` | automation | Manual | **PHI-WALL-NEVER-MIRROR** | — | — | N/A | Succeeded 2026-08-13 |
| `pg-phidblist` | automation | Manual | **ONE-SHOT-DELETE** | — | — | N/A | never run |
| `pg-phiext` | automation | Manual | **ONE-SHOT-DELETE** | — | — | N/A | never run |
| `pg-provdb-fourvault` | automation | Manual | **ONE-SHOT-DELETE** | — | — | N/A | Succeeded 2026-07-18 |
| `pg-role-flatstick-app` | automation | Manual | **ONE-SHOT-DELETE** | — | — | N/A | never run |
| `ring-memory-index-daily` | automation | `40 23 * * *` | **NO-AWS-TWIN-BUILT** | `otchealth-ring-memory-index-daily` | `cron(40 23 * * ? *)` | IDEMPOTENT-SAFE | Succeeded 2026-08-15 |
| `sentinel-os-eval` | apps-prod | `0 6 * * *` | **HAS-AWS-TWIN** | `otchealth-sentinel-os-eval` | `cron(0 6 * * ? *)` | IDEMPOTENT-SAFE | **Failed** 2026-08-16 ⚠ |
| `signal-radar` | automation | `*/30 * * * *` | **NO-AWS-TWIN-BUILT** | `otchealth-signal-radar` | `cron(*/30 * * * ? *)` | WRITES-DUPLICATE | Succeeded 2026-08-16 |
| `token-keeper` | apps-prod | `0 9 * * *` | **HAS-AWS-TWIN** | `otchealth-token-keeper` | `cron(0 9 * * ? *)` | WRITES-DUPLICATE | Succeeded 2026-08-16 |
| `xero-health` | apps-prod | `0 * * * *` | **HAS-AWS-TWIN** | `otchealth-xero-health` | `cron(0 * * * ? *)` | IDEMPOTENT-SAFE | Succeeded 2026-08-16 |
| `xero-run` | apps-prod | `0 0 30 2 *` ⚠ | **HAS-AWS-TWIN** | `otchealth-xero-run` | `cron(0 7 * * ? *)` ⚠ | **WRITES-DUPLICATE-HIGH** | Succeeded 2026-08-14 |

⚠ = see the dedicated write-ups above/below; do not treat the bare table row as the full story for
these five.

## Blast-radius classification (the cutover-order input)

Two-level scale, per the dispatch's own framing plus one addition (`HIGH-RISK-CORRUPTION`, for the
one job — `ledger-compaction` — where the danger is not duplication but in-place data corruption from
a concurrent second writer):

- **IDEMPOTENT-SAFE** — re-running converges: upsert-by-key indexers (all 6 librarians +
  `memory-librarian` + `ring-memory-index-daily` + `brain-reindex` + the `deep-*` annual passes +
  `docintel-ocr-sweep`), pure read/report jobs (`fleet-secret-custodian`, `xero-health`,
  `os-healthz-monitor`, `os-anomaly-watch`, `cfo-reconstruction-nightly` — confirmed **read-only,
  analysis-only** by its own skill description, never touches the Xero ledger), eval runners
  (`otchealth-mcp-eval`, `sentinel-os-eval` — each run is meant to produce a new result, not corrupt
  a prior one), and `agent-state-janitor` (TTL-based cleanup; re-finding nothing to clean is a no-op).
- **WRITES-DUPLICATE** — re-running creates a second independent record or outbound side effect:
  `xero-run` (the dispatch's own headline example — **posts to a real accounting ledger**),
  `decision-clock` and `signal-radar` (named explicitly — write straight to Cosmos), `fleet-backup`
  (named explicitly — writes DR artifacts), `innd-stock-daily` (appends a dated market-data snapshot),
  `os-morning-brief` (sends Matt a real email — a double-run means a double email, low severity but
  real), `os-reflective-memory` (writes reflective-memory entries), `token-keeper` (**forced** OAuth
  refreshes can race and invalidate each other's freshly-fetched token on the SAME upstream
  provider), `agent-memory-worker` (a Cosmos change-feed processor with no confirmed shared
  checkpoint across two independent workers), `fleet-medic` (dispatches alert events; some informal
  anti-duplicate suppression exists but is not verified as a hard guarantee), and
  `growth-room-nightly` (writes staged content, not yet fully script-reviewed).
- **HIGH-RISK-CORRUPTION** — `ledger-compaction` alone. Compaction mutates a store in place; two
  compactors racing against the same store is a classically dangerous pattern independent of which
  cloud either one runs on. **Never run both. Supervise the first AWS run individually.**

## Recommended cutover order

Extends the partial order already published in `AWS-CUTOVER-2026-08-14.md` (which only covered 15 of
the 22 pre-existing twins) to all 32 built schedules. **The rule that makes this safe, restated:
enabling a job's AWS schedule and disabling its Azure twin is one atomic action, one owner, watched
through a full cycle before moving to the next tier.** Never both enabled at once.

**Tier 0 — do not enable, blocked or undecided (2 jobs):**
- `agent-memory-worker` — task def + schedule exist and are correct, but its image
  (`agent-memory-worker:v2`) has no AWS ECR repository yet. Will fail on `RunTask` image pull until
  one is created and the image is pushed (source: `otchealth-cto` PRs #35/#38).
- `xero-run` — cron discrepancy unresolved (see above). Needs a CFO/Matt decision on intended
  behavior before either cron is ever enabled.

**Tier 1 — read-only / self-contained, lowest possible risk (8 jobs):**
`xero-health`, `fleet-secret-custodian`, `os-healthz-monitor`, `os-anomaly-watch`,
`otchealth-mcp-eval`, `sentinel-os-eval` (note: currently **failing on Azure itself** — a pre-existing
issue unrelated to this migration; fix or accept before or independent of enabling the AWS twin),
`cfo-reconstruction-nightly`, `agent-state-janitor`.

**Tier 2 — indexers, upsert-safe but real compute/API cost on overlap (9 jobs):**
`librarian-commerce` (smallest, go first), `librarian-finance`, `librarian-legal-company`,
`librarian-legal-personal`, `memory-librarian`, `ring-memory-index-daily`, `brain-reindex`,
`daily-digest`, `docintel-ocr-sweep`.

**Tier 3 — outward-facing / append-style, real but bounded duplication risk (7 jobs):**
`os-morning-brief` (sends email), `innd-stock-daily`, `token-keeper` (stagger carefully — do not
enable within the same refresh window as any other credential-refresh activity), `os-reflective-memory`,
`decision-clock`, `signal-radar`, `growth-room-nightly`.

**Tier 4 — genuinely risky, one at a time, individually supervised (3 jobs):**
`fleet-backup` (confirm it targets S3 not Azure Blob before flipping — the two clouds should not both
be writing DR copies of each other in a way that could confuse a real restore), `fleet-medic` (watch
its first few cycles for duplicate `medic_dispatch` events), **`ledger-compaction` last of all, and
only after `fleet-backup` and every indexer tier is confirmed stable on AWS** — a compaction job is
the worst possible one to have two clouds racing on.

**Tier 5 — expensive/annual, effectively manual regardless of "enabled" (3 jobs):**
`deep-finance`, `deep-legal-company`, `deep-legal-personal` — `cron(0 5 1 1 ? *)` fires once a year;
enabling these is low-urgency either way.

## What was built vs. what still needs a human or another wave

**Built and live (DISABLED) this session:**
- 10 ECS task definitions (`otchealth-job-agent-memory-worker`, `-agent-state-janitor`,
  `-cfo-reconstruction-nightly`, `-decision-clock`, `-fleet-medic`, `-growth-room-nightly`,
  `-ledger-compaction`, `-memory-librarian`, `-ring-memory-index-daily`, `-signal-radar`), each
  revision `:1`.
- 10 EventBridge schedules (`otchealth-<name>`), state `DISABLED`, targeting the task defs above.
- The reusable, idempotent tooling to re-run this (`skills/aws-jobs-migration/`), verified via
  `--dry-run` to correctly detect all 10 as already existing.

**Flagged, not fixed (real, separate follow-ups):**
- `agent-memory-worker`'s missing ECR repo + image push.
- `xero-run`'s cron discrepancy (CFO/Matt decision).
- 11 `ONE-SHOT-DELETE` jobs recommended for deletion (2 — `pg-migrate-flatstick`,
  `pg-migrate-fourvault` — carry a real `DROP DATABASE IF EXISTS`; confirm the target DB is not live
  before deleting the safety net, not because the DROP itself is a migration risk, but because
  deleting a "just in case" tool without checking what it was insurance against is its own kind of
  mistake).
- `sentinel-os-eval` is not just failing right now — its last 5 Azure executions are Failed, Failed,
  Failed, Succeeded (08-15, but took 1h28m, unusually long), Failed (08-16). A real, recurring problem
  over multiple days, pre-existing and unrelated to this migration; owned by whoever owns that eval
  harness, flagged here because it surfaced while cross-checking the matrix. Logged as
  `FND-20260816-1aa3`.
- `pg-dr-dump` / `pg-dump-nonphi` recommended to stay as manual, on-demand, run-right-before-a-real-
  cutover-step utilities on both clouds rather than becoming scheduled automation — that is what they
  already are on Azure, and duplicating that shape on AWS (rather than inventing a cron for them) is
  the point of "follow the exact pattern," extended to the absence of a pattern where none exists.

## Access used

Azure: `azure-sp` client_credentials (`azure-sp-client-id/-secret/-tenant-id`, `azure-subscription-id`)
via Key Vault, ARM REST, read-only. AWS: `aws-cto-access-key-id` / `aws-cto-secret-access-key` via Key
Vault, hand-rolled SigV4 (no aws-cli, no AWS SDK), read for the matrix + write for
`RegisterTaskDefinition` / `CreateSchedule` only — no `UpdateSchedule` to `ENABLED` anywhere in any
script this session wrote or ran.
