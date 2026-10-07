---
name: nightly-schedule-canary
description: The fleet silence monitor. Reads setup/heartbeat-registry.json and, for every registered unattended job, judges the AGE of its last proof of life against its own cadence (max_age_min, else 3x interval_min with a 6h floor), with two witnesses, the S3 heartbeat store and the GitHub Actions scheduled-run history, so a job that stopped running pages instead of sitting green. Runs from nightly-fleet-sentinels.yml with --strict and pages Matt through a GitHub issue (setup/page-on-failure.mjs, the mention defaults to the owner). Needs no new long-lived token. Statuses are LIVE, PENDING, STALE, NO-DATA, FAILING, UNWITNESSED, UNREADABLE, UNREGISTERED, UNREGISTERED-STALE and RETIRED-BEATING. A second workflow, sentinel-watchdog.yml, pages when the monitor itself has not completed a run for 26h, and the monitor watches the watchdog. Use it to answer which jobs are silent, to register or retire a job, or to read a FLEET-ALERT issue. Non-PHI, it reads job names, beat timestamps and workflow run metadata only.
---

# nightly-schedule-canary: the silence monitor and its watchdog

## Why this exists

A content check can only go red if it runs. A job whose cron stopped (GitHub disables a schedule after 60 days
without repo activity, a deleted or malformed workflow file, a cron typo, Actions switched off) never gets the
chance to fail, so nothing pages. The July 2026 family of silent monitors (registered, trusted, never scheduled)
was exactly that. "Silence = failure": this monitor judges how long ago each job last proved it was alive, not
what the job last said about itself.

## The model: age of the last proof of life against the cadence

Per registered job the limit is `max_age_min` if the row sets it, else `max(360, 3 x interval_min)` minutes.
Proof of life older than the limit is silence. GitHub starts scheduled runs hours late (5-9h is normal, gaps up
to 27h45m were observed), so daily workflow rows use `interval_min` 1560 with `max_age_min` 2160 (36h); a weekly
row uses 10080 / 15840; the hourly aws-health-monitor row uses 360 / 1080 because GitHub throttles it to a few
real runs a day.

## The two witnesses (the beat decides first)

1. **Beat.** `setup/heartbeat.mjs check --json` reads `_HEARTBEAT/<job>.json` under
   `otchealthcommons/company-journal/` in bucket `otchealth-brain-dr-55c84f6b`. A job writes it with
   `node setup/heartbeat.mjs beat <job> ok` (or `fail`), which needs `s3:PutObject` on its own object. A fresh ok
   beat is LIVE (FAILING when `consecutive_fail` is above 0); a beat that has only ever failed is FAILING.
2. **GitHub Actions history,** for rows that carry `gh_workflow` ("owner/repo/file.yml") and whose beat cannot
   vouch for them. The last 10 `schedule` runs of that workflow: none inside the limit is STALE (the cron is not
   firing), a last run that failed or timed out is FAILING, anything else is LIVE. A healthy beat costs no API call.

**No new token, ever.** The own repo is read with the job's `GITHUB_TOKEN` (`actions: read`). Another repo is read
with the optional secret `FLEET_WATCH_GH_TOKEN` if one is set, else with `GITHUB_TOKEN`, and a 401/403/404 is retried
anonymously, so a PUBLIC repo (otchealth-mcp-server) answers with no credential at all. A PRIVATE other repo
(otchealth-cto) cannot be read that way: that row is witnessed by its own beat instead, and until the beat lands it
reports UNWITNESSED, which pages and names the fix. `FLEET_WATCH_GH_TOKEN` is an optional fallback, never required.

## Statuses, exactly as implemented

| Status | Pages | Meaning |
|---|---|---|
| LIVE | no | proof of life inside the limit |
| PENDING | no | the row has `armed: "YYYY-MM-DD"`, no proof yet, and is still inside armed date + its own limit (grace for a brand new job). It never hides UNREADABLE or UNWITNESSED |
| STALE | yes | no ok beat and no scheduled run inside the limit: the job or its cron is silent |
| NO-DATA | yes | a beat-only row that has never beaten ok (after any armed grace) |
| FAILING | yes | the job runs but reports failure: fresh beat with `consecutive_fail` above 0, a beat that never reported ok, or the last scheduled run failed or timed out |
| UNWITNESSED | yes | a `gh_workflow` row with no usable beat whose GitHub read failed (private repo, no such file, rate limit). The line names the fix |
| UNREADABLE | yes | a beat-only row and the checker's AWS role cannot read the beat store. One grouped line carries the exact missing permission |
| UNREGISTERED | no | a recent beat file with no registry row: add the row |
| UNREGISTERED-STALE | yes | a beat file with no row and no ok beat for 3 days |
| RETIRED-BEATING | yes | a `_retired_` job is beating again: un-retire it or stop whatever still runs it |

`--strict` exits 1 on any paging status. UNWITNESSED replaced the old UNVERIFIABLE: a row the monitor cannot see
is never silent. A row without `max_age_min` never gets a limit below 6h, however short its interval.

## Registry rows (`setup/heartbeat-registry.json`)

`interval_min` (required), `max_age_min` (optional limit override), `owner` (the lane), `kind`
(`"nightly-workflow"` for GitHub cron workflows), `gh_workflow` (the GitHub witness), `armed` (grace date),
`note` (why the numbers are what they are). Keys starting with `_` are not watched. A `_retired_<name>` row
retires a job and may list further `beats` names; a leftover stale beat file of a retired job is then ignored.
`setup/heartbeat.mjs` reads the same file, so every watched row is also a `heartbeat.mjs check` row.

As of 2026-10-07: 32 watched rows (23 beat-only ECS-era agents, 9 `nightly-workflow` rows) and 11 retired.
The nightly-workflow rows are nightly-aws-dr-canary, nightly-eval, nightly-secrets-dr-export,
nightly-token-age-metrics, nightly-fleet-medic (otchealth-mcp-server, public), aws-health-monitor (otchealth-cto,
private, so beat-witnessed), stale-pr-closer, sentinel-watchdog and codex-continuity-lane (weekly).

## Paging

`.github/workflows/nightly-fleet-sentinels.yml` (cron `20 5 * * *`, OIDC role from `vars.AWS_FLEET_SENTINELS_ROLE_ARN`
else `otchealth-aws-dr-canary`) runs the monitor with `--strict` and, on failure, runs
`setup/page-on-failure.mjs --github-issue "[FLEET-ALERT] nightly-fleet-sentinels"`. The issue channel needs only the job's
`GITHUB_TOKEN` and `permissions: issues: write`, which is why it is the guaranteed one (email and PostHog read their
credentials from SSM, which a least-privilege role cannot). One open issue per title: the first page opens it, every
later page is a NEW comment, and closing the issue acknowledges it.

**The mention.** Every pager step sets `PAGE_GITHUB_MENTION: ${{ vars.FLEET_ALERT_MENTION || '@GBGolfMatt' }}`.
`setup/alert-issue.mjs` writes `cc @GBGolfMatt` into the new issue body or the new comment, and GitHub notifies on
a mention in new content (never on an edit, so the pager never edits). **The default needs its leading at sign**:
`parseMentions` drops a bare login, so `'GBGolfMatt'` mentions nobody. If the value parses to nothing the issue says so
(a note with no handle in it). The repo variable `FLEET_ALERT_MENTION` overrides the default (an at sign again).

**Wording rules for check lines** (the issue body redacts): no `token`, `secret` or `password` directly before a colon
or equals sign, no 40+ character run of letters, digits and `_ - + /` containing a capital, `_` or `.`, no github.com
URL with the org name (print `run <id>` and the workflow name instead), and one line is capped at 500 characters.
`tests/nightly-schedule-canary.test.mjs` enforces all of that for every message this script can produce.

## Who watches the watcher

The monitor cannot report its own silence: a dead cron produces no run to go red. `sentinel-watchdog.yml`
(cron `50 13 * * *`, plus `workflow_dispatch`) runs `skills/nightly-schedule-canary/sentinel-watchdog.mjs`, which
asks the Actions API (job `GITHUB_TOKEN`, `actions: read`; no AWS, no stored secret, imports only `node:` builtins) for
the last 20 runs of `nightly-fleet-sentinels.yml`. Alive means a completed success or failure inside 26h (a red run is
alive: the monitor ran and found something), or a run queued or in progress for no more than an hour; a cancelled,
timed out or skipped run is not proof. Otherwise it exits 1 and pages `[FLEET-ALERT] sentinel-watchdog`. An unreadable
run history is an `[ERROR]` page too, never a silent pass. The cron is offset on purpose: with GitHub's lateness the
monitor normally runs 10:30-14:30 UTC and the watchdog 19:00-23:10 UTC, when the monitor's run is 4-13h old, so 26h pages
on a missed day and not on lateness. The monitor watches the watchdog back through the `sentinel-watchdog` registry row,
which is `armed: "2026-10-09"` (the day after the expected merge; set it to the merge date if that is later) so the first scheduled run has 36h to show up (a manual dispatch is not a scheduled run).
`nightly-fleet-sentinels` is never a watched row (the watchdog covers it); a test rejects one.

## Adding a job

1. Pick the witness. Best is a beat: a final step `node setup/heartbeat.mjs beat <job> ok` with `if: always()` and
   `continue-on-error: true`, using an AWS role that has `s3:PutObject` on `_HEARTBEAT/<job>.json`. For a GitHub cron
   workflow in this repo, `gh_workflow` alone works with no IAM at all.
2. Add the row (`interval_min`, `max_age_min` sized to GitHub's lateness, `owner`, `kind: "nightly-workflow"`,
   `gh_workflow`, a `note`, and `armed` with today's date if the first run is not yet in).
3. `tests/nightly-schedule-canary.test.mjs` has a reverse-coverage check: every workflow in this repo with an
   armed `schedule:` cron must be a registry row or be listed as exempt in the test. A new cron workflow fails CI until
   it is registered. Workflows in other repos are watched only if you add their row.
4. If the job pages, give it the issue channel: `permissions: issues: write`, `GITHUB_TOKEN`, the mention default
   above, and `--github-issue "[FLEET-ALERT] <job>"`; a test scans every pager.

## Retiring a job

Replace its row with `_retired_<name>` (`retired` date and a `note`, plus any `beats` aliases). While it keeps
beating it shows as RETIRED-BEATING, so a job that was "retired" but still runs is caught.

## Known gaps (2026-10-07)

- The 23 ECS-era beat-only rows read UNREADABLE until the checker's role has `s3:ListBucket` on the bucket (with
  `s3:prefix` for `otchealthcommons/company-journal/_HEARTBEAT/`) and `s3:GetObject` on `_HEARTBEAT/*` (a one-time IAM
  grant; an SSE-KMS bucket would also need the key's decrypt). That is deliberate: unreadable is loud, not green.
- aws-health-monitor stays UNWITNESSED until otchealth-cto's workflow beats and its role has `s3:GetObject` and
  `s3:PutObject` on `_HEARTBEAT/aws-health-monitor.json`.
- A scheduled run proves the cron fired and how the job ended; it cannot see inside a job that exits 0 having done nothing.
- Copies of stale.yml and codex-run.yml in otchealth-cto and otchealth-mcp-server, and the other workflows of those
  repos, are not registered. `pager-selftest.yml` is dispatch-only.
- The checker's repo is public, so a [FLEET-ALERT] issue shows bucket and role names (no secrets).

## Run

```
node skills/nightly-schedule-canary/schedule-canary.mjs [--json] [--strict]
GITHUB_TOKEN=... node skills/nightly-schedule-canary/sentinel-watchdog.mjs
```

Report-only by default (safe locally); `--strict` or `NIGHTLY_SCHEDULE_CANARY_STRICT=1` exits 1 on any paging status.
Locally without AWS credentials every beat-only row reads UNREADABLE with the missing-permission sentence, which is the
expected output. Tests: `node --test tests/nightly-schedule-canary.test.mjs tests/sentinel-watchdog.test.mjs tests/alert-issue.test.mjs`.
