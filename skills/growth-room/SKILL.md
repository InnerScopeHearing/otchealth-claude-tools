---
name: growth-room
description: The fleet's nightly cross-app GROWTH digest. Pulls read-only signal from Capgo OTA statistics (bundle rollout health per app), RevenueCat (subscription/MRR metrics), and PostHog (per-app funnel: active devices, top events), composes ONE dated Markdown "growth room" digest, and stages it into the Azure commons brain the same way daily-digest stages its own digest, so every exec agent (CRO/CFO/COO/CTO) can `brain_search` "what did installs/OTA rollout/MRR/funnel look like this week" across the whole app portfolio in one place. Non-PHI ring; MedReview's PHI-hardened PostHog project is deliberately excluded from the app registry. Run nightly as a Container Apps Job (see job/growth-room-nightly.sh); the CTO owns the deploy.
---

# growth-room — the fleet's cross-app growth digest

Closes the growth-visibility gap the way `daily-digest` closes the shipped-work gap: every night, a
digest of installs/active devices, OTA rollout concentration, subscription/MRR signal, and top funnel
events across every consumer app is generated, staged into the knowledge base, and becomes permanently
searchable. An agent tomorrow can ask "how is Flatstick's OTA rollout going" or "what's the MRR trend
across the portfolio" and get a cited, grounded answer via `company-brain`/`brain_search` instead of
manually re-pulling three different dashboards.

## Generate
```
node skills/growth-room/growth-room.mjs sweep [--days N] [--dry-run] [--json] [--out path]
node skills/growth-room/growth-room.mjs status   # print the app registry, no network calls
```
`sweep` pulls all three sources for every app in the registry, composes the digest, writes it locally
(`/tmp/growth-room-<date>.md` by default), and STAGES it into the commons data room
(`otchealthcommons/company-journal/_DOCS/growth-room/<date>.md`) unless `--dry-run` is passed. Staging
is on by default (no `--commit` gate) — the same posture `nightly.sh`/`librarian.sh`/
`cfo-reconstruction`'s `reconstruct.mjs sweep` take: a read-only digest landing in the shared,
non-sensitive commons room has no human-facing cost if wrong.

## The app registry (`APPS` in growth-room.mjs)
One row per fleet consumer app: `bundleId` (the real Capacitor `appId`, verified against each repo's
own `capacitor.config.*` on 2026-07-21 — used as both the Capgo `app_id` and the RevenueCat
app-matching key, since Capgo's `app_id` is the same reverse-domain identifier by design) and
`posthogProjectId` (per `otchealth-cto/CLAUDE.md`'s PostHog Project Registry). Covers iHEARtest,
AWARE, OTCHealth Companion, InnerEase, Flatstick, FourVault, Fictionary, PlantID, plus the two
non-Capacitor web properties (INND Website, OTCHealthMart — PostHog funnel only, no Capgo/RevenueCat
row). **MedReview (PostHog project 468398) is deliberately absent and must never be added** — it is
PHI-hardened (replay/console/autocapture off, anonymize_ips on) and this job runs on the non-BAA,
non-PHI runtime. A test (`tests/growth-room.test.mjs`) pins this invariant.

## Sources and what each pull returns

### Capgo (`api.capgo.app/statistics/...`)
Confirmed endpoints (`capgo.app/docs/public-api/statistics/`): `GET /statistics/app/:app_id/?from=&to=`
(daily `{date, mau, storage, bandwidth}`) and `GET /statistics/app/:app_id/bundle_usage` (chart-ready
per-bundle-version device-share time series). The digest reports the latest-day MAU, the window's peak
MAU, and the current top bundle version's device share (a rollout-concentration proxy — "how much of
the fleet is on the newest OTA push"). **Flagged gap**: the public Statistics API does not expose an
explicit fail/revert counter (only MAU/storage/bandwidth and version-adoption %), so "OTA health" here
reads as rollout concentration, not a literal Capgo-side failure count. **Flagged gap**: only iHEARtest
is confirmed end-to-end wired to Capgo as of 2026-07-21 (`research/capgo-2026-07-21/05-fleet-adoption-
architecture.md`) — a 404 from an app not yet onboarded is treated as `notWired`, not an error, so the
digest degrades gracefully as the rest of the fleet's Capgo rollout (Task #31) lands. Auth:
`x-api-key: <capgo-token>` header (the public-API overview page documents this as current/recommended;
the statistics doc's own examples show a bare `authorization` header instead — worth re-confirming
against a live 401 if this job ever fails auth, see `research/capgo-2026-07-21/04-capgo-cloud-docs.md`
§7 and §12.5).

### RevenueCat (`api.revenuecat.com/v2`)
Confirmed endpoints (fetched from `revenuecat.com/docs/api-v2`, 2026-07-21): `GET /projects`,
`GET /projects/{id}/apps`, `GET /projects/{id}/metrics/overview` (MRR, active subscriptions, active
trials). Auth: `Authorization: Bearer <revenuecat-secret-key>` (v2 requires the Bearer form). The
sweep lists every project the key can see, matches apps by `bundleId`, and reports per-app MRR /
active subscriptions / active trials. **Flagged gap**: `revenuecat-secret-key` in Key Vault is
confirmed working against PlantID's project (`proj8d70e817`, per `otchealth-cto/CLAUDE.md`) but NOT
confirmed as a fleet-wide/organization-level key — RevenueCat v2 secret keys are commonly
project-scoped. If the key only resolves one project, the digest prints a `revenuecatGap` note
("the RevenueCat key visible to this job maps to N project(s)") rather than silently under-reporting.
Getting a fleet-wide key (or one key per monetized app, matching the pattern the fleet already uses
for per-app ASC/PostHog credentials) is a follow-up, not a blocker — the digest is honest about the
gap either way.

### PostHog (`us.posthog.com/api/projects/:id/query/`)
Reuses the EXACT HogQL query pattern already proven live in this repo
(`skills/azure-canary/stream-freshness.mjs`'s `newestStreamEventTs()` — same endpoint, same auth, same
DateTime64-string normalization concern), not a new integration guess. Per app: total event count +
distinct active `person_id`s in the trailing window, plus the top 8 events by count (a generic
top-events query, not a hardcoded per-app event vocabulary — this naturally surfaces `app_open`,
`subscribe`, `trial_started`, `flow_complete`, etc. for whichever app fired them, without the digest
needing to know each app's exact categorical-event names). Auth: `posthog-personal-api-key`.

## Where it runs
`job/growth-room-nightly.sh` mirrors every other Tier-1 job in this fleet (`nightly.sh`,
`librarian.sh`, `cfo-reconstruction/job/cfo-nightly.sh`): sweep, then a scoped
`doc-indexer index --prefix _DOCS/growth-room/` pass so the digest's `_TEXT/` sidecar exists for the
S1 `ixr-commons-docs` pull-indexer to pick up on its own schedule (the commons room is S1 pull-indexer
fed, per `setup/expected-indexes.json`'s `commons-company-journal` entry — no `push-search` step is
needed or run, matching the `SKIP_PUSH_SEARCH=1` posture already set on `daily-digest`'s own job).

### Deploy (Azure Cloud Shell or any az-authenticated shell; NOT applied by this PR — a separate,
explicit CTO step, same posture as `runbooks/cfo-reconstruction-job.md`)
This job needs `skills/growth-room/` baked into the shared `doc-indexer:latest` image (one new `COPY`
line in `skills/doc-indexer/job/Dockerfile`, already added by this PR) — **rebuild the image before
creating or trusting the job**, same requirement `cfo-reconstruction`'s runbook calls out:
```bash
cd otchealth-claude-tools && git pull
az acr build -r otchealthacr -t doc-indexer:latest -f skills/doc-indexer/job/Dockerfile .
```
Then create the job (identifiers per `setup/expected-resources.json`, matching every other job in
`otchealth-automation-rg` / `otchealth-jobs-env`):
```bash
IDENTITY_ID="/subscriptions/55c84f6b-ef90-4259-a58b-50835cc4cab4/resourceGroups/otchealth-automation-rg/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-otc-jobs-kv"

az containerapp job create \
  --name growth-room-nightly \
  --resource-group otchealth-automation-rg \
  --environment otchealth-jobs-env \
  --trigger-type Schedule \
  --cron-expression "50 8 * * *" \
  --replica-timeout 1200 \
  --replica-retry-limit 1 \
  --parallelism 1 \
  --image otchealthacr.azurecr.io/doc-indexer:latest \
  --registry-server otchealthacr.azurecr.io \
  --registry-identity "$IDENTITY_ID" \
  --mi-user-assigned "$IDENTITY_ID" \
  --cpu 1 --memory 2Gi \
  --command "/bin/sh" \
  --args "/app/skills/growth-room/job/growth-room-nightly.sh"
```
- **`50 8 * * *`** (08:50 UTC daily) is staggered against the fleet's existing `otchealth-automation-rg`
  crons (`daily-digest` 59 23, `librarian-*` 0/15/20/40-past-the-hour on 6h/hourly cycles,
  `ledger-compaction` 0 8, `cfo-reconstruction-nightly` 10 8) — ten minutes after `cfo-reconstruction-
  nightly`, not the same minute, so the two never collide in a shared log view.
- **No `--secrets` / `--env-vars`.** Auth is entirely `id-otc-jobs-kv` managed identity, same as
  `cfo-reconstruction-nightly` — no stored secret on the job spec at all.
- **`--replica-timeout 1200`** (20 min) gives headroom for up to 10 apps × 3 sources with the 250ms
  inter-call throttle on RevenueCat/rate-limited endpoints; well under the 1-hour ceiling of any single
  API's rate limit window.
- Smoke test before trusting the cron: `az containerapp job start -n growth-room-nightly -g
  otchealth-automation-rg --command "/bin/sh" --args "/app/skills/growth-room/job/growth-room-nightly.sh" "--dry-run"`.
- After deploying, add `growth-room-nightly` to `setup/expected-resources.json` (type
  `containerAppJob`) — only once the resource actually exists, so `resource-reconcile.mjs` never
  reports a false "expected but absent" drift.

## Credentials
Self-resolved from Azure Key Vault via `skills/kb-memory/azure-secret.mjs`'s `kvSecret()` (managed
identity first, no stored job secret needed): `capgo-token`, `posthog-personal-api-key`,
`revenuecat-secret-key`, `azure-commons-storage-key` (via `cfo-store`). Any one missing degrades that
source's section to "NOT CONFIGURED this run" rather than failing the whole sweep.

## Guardrails
- Read-only against all three sources. Never posts/writes to Capgo, RevenueCat, or PostHog.
- Non-PHI ring. MedReview's PHI-hardened PostHog project (468398) is never in the registry — pinned by
  `tests/growth-room.test.mjs`.
- INND/company financials (revenue recognition, cap table, fundraising) are OUT OF SCOPE — this is
  app-growth/funnel telemetry only. The CFO's own financial reconstruction is a separate lane
  (`skills/cfo-reconstruction/`).
- No em dashes or en dashes in the digest copy.
