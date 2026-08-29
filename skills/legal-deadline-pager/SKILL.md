---
name: legal-deadline-pager
description: Reads the CLO's legal docket (skills/legal, docket due) and pages a human on tight-window, VERIFIED deadlines. Ships DISARMED by default (dry-run/report only, sends nothing); actual email requires both --commit on the CLI and the environment variable LEGAL_PAGER_ENABLED=1. Company-namespace deadlines may sync into decision-clock storage (Cosmos, shared with the rest of the fleet) so they also ride decision-clock's own owner-batched nudge; PERSONAL-namespace deadlines (Matt's confidential CA matters) NEVER touch decision-clock, fleet-dispatch, commons-journal, or memory-exec, they page only through a direct graph_send_email call with cooldown state kept inside the CLO's own access-controlled personal S3 container (writes LIVE since the owner-approved 2026-08-29 IAM grant; a 403 now signals a policy regression, see below). Use to check what would page (`sweep`), arm it, or check the last-run heartbeat. Wielded by the CLO / CTO. Non-PHI ring; personal-matter content is privileged and confidential.
---

# legal-deadline-pager — a disarmed pager for the legal docket

Closes the gap between "the deadline is in the docket" and "a human actually got told in time."
`skills/legal`'s `docket due` command already lists what is due or overdue; this skill watches that
list for anything inside a tight window and pages Matt directly, on top of (not instead of)
decision-clock's own slower, digest-batched visibility for company matters.

## Ships disarmed (read this before deploying it)
`sweep` with no flags is a pure read and report: it fetches the docket, classifies every row, and
prints exactly what it WOULD page, writing nothing anywhere and sending nothing. Two independent gates
must both be set before anything actually happens:

1. **`--commit`** (CLI flag) arms the tracking side: the company-namespace decision-clock sync, the
   personal cooldown store, and the heartbeat marker.
2. **`LEGAL_PAGER_ENABLED=1`** (environment variable, checked in addition to `--commit`) arms the actual
   `graph_send_email` call.

Merging this skill and deploying its job therefore pages nobody: the job's own wrapper
(`job/legal-deadline-pager-sweep.sh`) passes `--commit` so the tracking mechanics are live and
inspectable, but it deliberately never sets `LEGAL_PAGER_ENABLED`. Arming email is a separate, explicit
step a human takes on the deployed job (see `job/legal-deadline-pager-job.md`).

## Use
```
node skills/legal-deadline-pager/pager.mjs sweep                                  # dry-run report
node skills/legal-deadline-pager/pager.mjs sweep --json                           # same, machine-readable
node skills/legal-deadline-pager/pager.mjs sweep --commit                         # tracking live, email still disarmed
LEGAL_PAGER_ENABLED=1 node skills/legal-deadline-pager/pager.mjs sweep --commit    # fully armed

node skills/legal-deadline-pager/pager.mjs heartbeat [--json]                     # last run + staleness (read-only)
```
Flags: `--window-days N` (default 7, the "tight window" a deadline must fall inside to page),
`--due-days N` (default 30, how far out to ask `legal.mjs docket due` for rows), `--cooldown-hours N`
(default 24, minimum time between two pages of the same deadline), `--recipient <email>` (default
`matthew@innd.com`, the legal-entity address per `dream-team/clo/CLO-BOOTSTRAP.md`; also settable via
`LEGAL_PAGER_RECIPIENT`).

## What counts as pageable
A docket row pages only when BOTH are true:
- **`verified === true`.** `legal.mjs docket due --json` defaults a row with neither `source` nor
  `verified` to `source:"manual", verified:true` (a human typed it in via `docket add`, so it is
  trusted). A future extraction pipeline (CourtListener / document parsing) is expected to write
  `source:"courtlistener"|"extracted"` with `verified:false` until a human confirms it; this pager will
  never page an unconfirmed, machine-extracted deadline.
- **Inside the tight window** (`--window-days`, default 7): due within that many days, OR already
  overdue (no lower bound; a missed deadline stays urgent the longer it is ignored).

Rows failing either test are never dropped silently, they land in the sweep's `skipped` list with a
reason (`unverified` or `out-of-window`), visible in `--json` output.

## Company vs personal: the ring split (hard rule, never relax)
- **Company-namespace rows** may sync into decision-clock's `decisions_pending` Cosmos storage
  (`category:"legal-deadline", owner:"clo"`, keyed by a stable hash so repeat sweeps upsert the same
  row instead of duplicating it). That storage is shared with the rest of the fleet, which is fine for
  company legal matters, decision-clock's own daily sweep also picks these rows up and fleet-dispatches
  them to the CLO inbox on its normal cadence (see `skills/decision-clock`), on top of this pager's own
  direct, immediate email for anything inside the tight window.
- **Personal-namespace rows** (Matt's confidential CA divorce/custody/criminal/civil matters) NEVER
  touch decision-clock, fleet-dispatch, commons-journal, or memory-exec. They page ONLY through a direct
  `graph_send_email` call, and their cooldown state lives ONLY inside
  `skills/legal-deadline-pager/personal-store.mjs`, a small independent client scoped to the `personal`
  container of the CLO's own access-controlled legal store (mirror account name `otchealthlegalstore`),
  keyed by an opaque sha256 hash so not even that private cooldown object carries cleartext case detail.

### Storage: AWS S3, with a deliberate read/write asymmetry on the personal container
`personal-store.mjs` was ported 2026-08-28 off Azure Blob (permanently dead, subscription 55c84f6b
deleted 2026-08-13) onto AWS S3, via `skills/kb-memory/s3-blob.mjs`'s MIRROR table -- the SAME
(account, container) -> (bucket, keyPrefix) allow-list `otchealth-mcp-server`'s
`src/legal/s3-blob-store.ts` uses in production. `otchealthlegalstore/personal` resolves to its OWN
dedicated bucket `otchealth-legal-personal-dr-55c84f6b`, never the shared finance-legal bucket
company matters live in.

**Reads work normally** (`getPersonalCooldown`): the personal-legal DR bucket grants
GetObject/ListBucket to every toolkit/job identity, so a cooldown read just succeeds; on any
failure it fails OPEN (returns `{}`, logs a line, never throws), matching every other
credential-touching module in this fleet -- a store outage must never crash the sweep.

**Writes are LIVE (owner-approved 2026-08-29)** (`putPersonalCooldown`): the IAM statement on the
personal bucket is now `PersonalLegalRingReadWrite` (GetObject+PutObject+ListBucket -- exact parity
with the company grant; deletes remain ungranted on BOTH rings on purpose). The grant was applied
via `PutRolePolicy` on `otchealthTaskRole`'s `runtime-access` policy and live-verified the same day
with a content-neutral read-then-write-back through this module. WRITES STILL DO NOT FAIL OPEN: a
403 now means the grant has REGRESSED (a policy edit, a role swap), so it rejects with the exact,
exported `PERSONAL_WRITE_IAM_GATE_MESSAGE` naming that regression, and logs via `console.error`
before throwing so it is visible even to a caller that discards the rejection. A write failure for
any OTHER reason (network, missing credentials, an unexpected 5xx) still rejects loud, with its own
honest cause, rather than being mislabeled as an IAM problem. `runSweep` in `pager.mjs` wraps both
calls in its own `.catch()` for the sweep's documented fail-open semantics, so a thrown error never
crashes the sweep -- a personal deadline just misses one cooldown persist and may re-page next run.

This split is enforced in code (`pager.mjs`'s `runSweep`, tested in `tests/pager.test.mjs`), not just
documented: a personal row is structurally routed to a different function than a company row, there is
no shared code path that could accidentally cross-write one into the other's store.

## Why a direct email, not just decision-clock's own nudge
decision-clock's sweep already fleet-dispatches near-due/overdue rows to their owner, but its tier
system exists specifically to keep routine backlog out of a human's live channel by batching it into
the daily digest instead (see `TIER_BY_CATEGORY` in `skills/decision-clock/decision.mjs`). A legal
deadline inside the tight window is urgent enough to warrant an immediate page, not a batched digest
line days later, so this pager sends its own direct `graph_send_email`, independent of decision-clock's
tiering, for anything inside the window.

## Why graph_send_email is called on the CTO lane
`graph_send_email` is a gateway `write_orchestrated` tool with no explicit governance rule
(`otchealth-mcp-server/src/catalog/governance.ts`), so it falls to the write_orchestrated default:
CTO-lane only. This pager mints its bearer via `skills/gateway-connect`'s `mintToken("cto")`, the same
lane/credential path already used by `skills/azure-canary`. Sending "as the CLO lane" is not currently
possible for this specific tool; the email itself is still the CLO's direct-to-Matt channel by content
and intent, it is simply dispatched through the one lane the gateway actually allows to execute it.

## Cooldown
Each docket row has a stable, opaque key (`rowKey()`, a sha256 hash of namespace + matter id + date +
description). A row that already paged within `--cooldown-hours` (default 24) is excluded from the next
page, so the same deadline cannot spam an inbox every sweep run. Company cooldown state rides the same
decision-clock doc as the tracking sync (`last_paged_at`); personal cooldown state lives in the private
Blob store described above.

## Heartbeat
Every `--commit` run (armed or not) writes a heartbeat marker (`id:"legal-pager-heartbeat"`,
`status:"closed"` so it never shows up in decision-clock's own nudge/metrics output) with the run
timestamp, mode, and row counts, no case content. `node pager.mjs heartbeat` reads it back and reports
`stale:true` once the last run is older than 48 hours, the signal a scheduled sweep has silently stopped
running. Dry-run invocations (no `--commit`) do not update the heartbeat; the deployed job always passes
`--commit`, so the heartbeat reflects real cron health.

## Deploy
See `job/legal-deadline-pager-sweep.sh` (the Container Apps Job entrypoint) and
`job/legal-deadline-pager-job.md` (the `az containerapp job create` copy-paste, mirroring
`skills/decision-clock/job/`). Arming email on a deployed job is a separate, explicit
`az containerapp job update --set-env-vars LEGAL_PAGER_ENABLED=1` step, never a side effect of deploying
the code.

## Ring safety
Non-PHI. Never store a secret VALUE here. Personal-matter content (privileged, confidential) never
leaves the direct email channel and the private cooldown store; it is never logged in a shared store,
never included in the heartbeat marker (counts only), and never included in a company-namespace email.
