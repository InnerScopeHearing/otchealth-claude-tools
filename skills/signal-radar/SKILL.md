---
name: signal-radar
description: A deterministic, detector-based watcher over the fleet's EXISTING telemetry (Sentry, PostHog, grant-tracker, Secret Manager, iHEARtest's release ledger). Report and observe only, it never acts on production and never mutates another system, it only surfaces high-precision Signals into a Cosmos DB signals container and routes high-severity or escalated ones to the owning agent's fleet-dispatch inbox (cto for infra/security/release, cfo for burn and any MNPI subject, growth for funnel, commerce for inventory). Reuses the fleet-medic classify-cooldown-escalate-fail-open discipline. Use to run a scan on demand or on a Container Apps Job cron.
---

# signal-radar — the fleet's own smoke detector, not a fire truck

Signal Radar answers "is anything quietly going wrong across the fleet that nobody has noticed yet."
It is deliberately narrow and boring: five hand-picked, high-precision detectors, each reusing data the
fleet already collects, each tuned so a healthy system stays SILENT. It never takes action on
production; it only classifies, records, and routes a Signal to the human/agent who owns that lane.

## Detectors (v1, 5 of the 6 candidates in the brief; #2 dropped, see below)

1. **`sentry-error-spike`** — a Sentry project's error count this week is >= 3x the MEDIAN of the prior
   3 weeks, with an absolute floor (5 errors/week) so a low-volume project's noise never fires. MedReview
   projects are hard-excluded (PHI ring).
2. **`eval-regression`** — an `agent-evals` golden task's score dropped >= 0.34 (roughly one whole rubric
   criterion) versus its own immediately-prior run. Same-task, same-rubric, same-judge comparison, so
   there is no cross-task noise; only the two most recent runs are compared.
3. **`grant-burn-expiry`** — an ACTIVE grant in `skills/grant-tracker/grants.json` is within 60 days of
   its term (matches grant-tracker's own "use or lose" flag exactly) or has a term that already lapsed
   while still marked active. Pure date arithmetic; zero measurement noise.
4. **`rotate-secret-age`** — a secret on the explicit ROTATE-BEFORE-LAUNCH list (curated from
   otchealth-cto/CLAUDE.md's dated entries, not a heuristic guess) has a Secret Manager container age
   >= 180 days. Currently silent fleet-wide (oldest tracked secret is ~33 days), which is the correct
   burn-in behavior, not a bug.
5. **`mark-review-overdue`** — an iHEARtest TestFlight build (per `qa/RELEASE-LEDGER.md`, the "sacred"
   Mark-review ritual) shipped >= 7 days ago, is not marked SUPERSEDED, and has no
   `qa/mark-reviews/<version>/mark-completed-<version>.pdf`. Scoped to iHEARtest today (the only repo
   with this convention); written generically so a future app repo can be pointed at the same detector.

**Dropped (from the original 6-candidate brief): PostHog funnel-step week-over-week drop.** Checked
live: every real consumer-app PostHog project (iHEARtest 468379, AWARE 468388, Companion 468389, ...)
currently has ZERO production event volume (pre-launch / dev-instrumented only). A funnel-drop detector
against zero-to-noise data would either never fire (useless) or divide-by-near-zero and fire on garbage
(the opposite of high precision). Revisit once a product project has real weekly funnel volume; the
Fleet Agents PostHog project (479484, agent telemetry) has real volume today and is what `eval-regression`
uses instead.

## Verbs
```
node skills/signal-radar/radar.mjs scan [--emit] [--json] [--only <detector-name>]
```
Without `--emit` this is a pure dry-run: runs every detector against LIVE data sources, prints what
would fire, touches no external state (no Cosmos write, no PostHog emit, no dispatch). `--emit`
persists each firing Signal to the Cosmos `signals` container, emits a `signal_detected` PostHog event
(Fleet Agents project), and routes `high` severity / escalated Signals to the owning agent's
`fleet-dispatch` inbox. `--json` emits a single machine-parseable JSON object on stdout (all narration
goes to stderr in this mode) for a cron wrapper or another tool to consume.

## Signal schema (see `schema.mjs`)
`{ id, detector, owner, subject, severity, why, evidence_link, suggested_action, mnpi, ts }`. `id` is a
stable `detector::subject` key (same finding re-firing reuses the same id, which is what makes cooldown
and consecutive-escalate possible without fuzzy matching). `owner` is the routing key (`cto` | `cfo` |
`growth` | `commerce`); a signal whose subject matches the MNPI test (INND/Xero/Plaid/stock/securities)
is hard-force-routed to `owner=cfo` and flagged `mnpi=true` regardless of which detector produced it,
so it can never leak into a fleet-wide digest.

## Storage: Cosmos DB `signals` container
Lives in the SAME Cosmos account the gateway's agent-state plane uses
(`cosmos-otc-agentstate-55c84`, db `agent-state`), as a sibling container to `tasks`/`memory`/`events`,
partitioned by `/owner` with a 90-day TTL (`defaultTtl: 7776000`, so the container self-prunes and never
grows unbounded). Connection secrets (`cosmos-endpoint`, `cosmos-key`, `cosmos-db`) are in
`otchealth-shared-prod` Secret Manager; the container itself was created via an ARM REST PUT against
the account's `sqlDatabases/agent-state/containers/signals` resource (see "Provisioning" below) -
already done for this PR, so `--emit` works out of the box.

## Provisioning (already done for this repo's Cosmos account; documented for a future account/region)
```
# create the container (idempotent PUT; 202 = accepted async operation)
curl -X PUT "https://management.azure.com/subscriptions/<SUB>/resourceGroups/rg-otchealth-shared-prod/providers/Microsoft.DocumentDB/databaseAccounts/cosmos-otc-agentstate-55c84/sqlDatabases/agent-state/containers/signals?api-version=2023-11-15" \
  -H "Authorization: Bearer <ARM_TOKEN>" -H "Content-Type: application/json" \
  -d '{"properties":{"resource":{"id":"signals","partitionKey":{"paths":["/owner"],"kind":"Hash"},"defaultTtl":7776000},"options":{}}}'
```

## Deploy shape: Container Apps Job (cron, mirrors the doc-indexer job pattern)
Not yet created as a live Azure job in this PR (code + config ship together; creating the actual
scheduled job is a one-command follow-up, same pattern as every other Tier-1 job in
`skills/doc-indexer/job/`):
```
# entrypoint (see skills/signal-radar/job/radar.sh in this PR)
az containerapp job create -n signal-radar -g otchealth-automation-rg \
  --environment otchealth-jobs-env --trigger-type Schedule --cron-expression "*/30 * * * *" \
  --replica-timeout 600 --replica-retry-limit 1 \
  --image otchealthacr.azurecr.io/doc-indexer:latest --registry-server otchealthacr.azurecr.io \
  --cpu 1 --memory 2Gi \
  --secrets "gcpsa=<ONE_LINE_CLAUDE_DRIVER_SA_JSON>" \
  --env-vars "GCP_CLAUDE_DRIVER_SA_JSON=secretref:gcpsa" \
  --command "/bin/sh" --args "/app/skills/signal-radar/job/radar.sh"
```
Reuses the existing `doc-indexer` image (same repo, same one-secret self-resolving pattern) rather than
building a new image, since `radar.mjs` has no dependencies beyond what that image already ships
(Node + the repo checkout). If a dedicated image is later wanted, copy `skills/doc-indexer/job/Dockerfile`.

## Guardrails (make explicit, not implicit)
- **MNPI**: INND / Xero / Plaid / stock / cap-table / investor / securities subjects are hard-routed to
  `owner=cfo` and marked `mnpi=true`; never appear in a fleet-wide digest. Enforced in `schema.isMnpiSubject`
  + applied unconditionally in `radar.mjs` before any signal is persisted or dispatched.
- **PHI**: MedReview is never a data source. `sentry-error-spike` hard-excludes MedReview Sentry
  projects via `schema.isPhiExcluded`; no other detector touches a PHI-ring system at all.
- **Fail-open**: one detector throwing an error produces zero signals + one diagnostic note for that
  detector only; it never aborts the scan or crashes the process (`radar.mjs`'s `runDetectorSafely`).
  The top-level `scan` command also wraps in try/catch and always exits 0 on error (mirrors fleet-medic).
- **Never-cry-wolf**: `schema.shouldFire` applies a per-severity cooldown (high 4h, medium 12h, low 24h)
  before the SAME finding (same `detector::subject` id) can re-fire, and only escalates (bumps to a
  human-visible flag) after 3 consecutive un-resolved firings. A flapping metric gets ONE dispatch, then
  goes quiet until it either clears or persists long enough to be worth re-flagging.
- **Report-only**: no detector or the radar core ever calls a mutating API on another system (no
  restarts, no rollbacks, no secret rotation, no billing changes). The only writes Radar itself performs
  are (a) its own Cosmos `signals` container and (b) a `fleet-dispatch` inbox message; both are
  observability/coordination writes, never a production action.

## Testing
`tests/signal-radar.test.mjs` covers every detector's PURE logic function hermetically (no network): 
`schema.shouldFire` cooldown/escalate, `schema.isMnpiSubject`/`isPhiExcluded`, `sentry-error-spike.evaluateSeries`,
`eval-regression.findRegressions`, `grant-burn-expiry.classifyGrants`, `rotate-secret-age.findAgedRotateSecrets`,
`mark-review-overdue.parseLedger`/`isReviewCandidate`. `node --check` passes on every file (see `run-tests.sh`).
