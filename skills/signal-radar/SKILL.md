---
name: signal-radar
description: A deterministic, detector-based watcher over the fleet's EXISTING telemetry (Sentry, PostHog, grant-tracker, Secret Manager, iHEARtest's release ledger). Report and observe only, it never acts on production and never mutates another system, it only surfaces high-precision Signals into the agent-state `signals` container (RDS Postgres via skills/kb-memory/pg-state.mjs) and routes high-severity or escalated ones to the owning agent's fleet-dispatch inbox (cto for infra/security/release, cfo for burn and any MNPI subject, growth for funnel, commerce for inventory). `--emit` FAILS LOUD (non-zero exit) if the agent-state store is unconfigured or a write fails, rather than silently succeeding. Reuses the fleet-medic classify-cooldown-escalate-fail-open discipline. Use to run a scan on demand or on the AWS EventBridge Scheduler cron.
---

# signal-radar — the fleet's own smoke detector, not a fire truck

Signal Radar answers "is anything quietly going wrong across the fleet that nobody has noticed yet."
It is deliberately narrow and boring: five hand-picked, high-precision detectors, each reusing data the
fleet already collects, each tuned so a healthy system stays SILENT. It never takes action on
production; it only classifies, records, and routes a Signal to the human/agent who owns that lane.

## Detectors (5 from the original brief + `contradiction-staleness` + `groundedness`; one brief candidate dropped, see below)

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
6. **`contradiction-staleness`** — a NEW row in the shared exec MEMORY feed (the same
   `otchealthcommons/company-journal/_MEMORY/_exec/*.jsonl` lanes company-brain and reflect read)
   CONTRADICTS a still-active older row, or makes one STALE-with-material-drift. Self-improving-loop
   item #2. Entity resolution is a coarse LEXICAL key (a closed ~40-term fleet vocabulary + secret-id-
   shaped tokens, reusing `mem.mjs`'s `normKey`), computed AT SCAN TIME (no new field on the ledger, no
   backfill). Cost is bounded HARD: only rows in a rolling window (`CONTRADICTION_WINDOW_DAYS`, default
   7) are examined, each same-entity slice is capped at <=20 rows, one quality-tier (gpt-5.1, never
   gpt-4.1-mini) entailment call per recent row, total calls capped (`CONTRADICTION_MAX_LLM_CALLS`,
   default 40) with a no-silent-truncation note when the cap bites. Two precision levers keep it quiet:
   a GROUNDING GATE (the verdict is discarded unless the model cites a row id actually in the slice) and
   a MATERIALITY FLOOR (only `contradict`/`stale-with-material-drift` fire; `agree`/`supersede`/
   `paraphrase` never do, so a normal version bump is not flagged). REPORT-MODE / observe-only: it
   NEVER writes the ledger; its `suggested_action` DRAFTS the exact `mem.mjs correct ...` command a
   human/agent may choose to run. MNPI/PHI rows are dropped before the LLM ever sees them (defense in
   depth on top of radar.mjs's central MNPI hard-route). Fail-open (no creds / no network -> idle,
   never throws). New consumers of the shared exec feed; adds NO new infra (no new agent-state
   container, no new secret) beyond what kb-memory + model-routing already resolve. Pure core (`extractEntityKeys`,
   `candidateSlice`, `gateVerdict`, `recentClaimRows`, `scanRows`) is unit-tested with an injected fake
   entailment fn (no live network in tests).
7. **`groundedness`** — a FAITHFULNESS/GROUNDEDNESS detector, a report-mode hallucination guard.
   Self-improving-loop item D. Reads the SAME shared exec MEMORY feed `contradiction-staleness`
   reads; for each recent claim-type row that carries a non-empty `source` field (a citation to
   retrieved context), runs ONE bounded LLM faithfulness call asking whether the claim text is
   actually entailed by that source. Rows with no `source` are skipped entirely (out of scope, not
   guessed at). Cost is bounded HARD: rolling window (`GROUNDEDNESS_WINDOW_DAYS`, default 7), one
   BOUNDED gpt tier (cheap/classification tier, not the quality/reasoning tier - this is a binary
   classification, not open synthesis) call per sourced row, total calls capped
   (`GROUNDEDNESS_MAX_LLM_CALLS`, default 40, <=40) with a no-silent-truncation note when the cap
   bites, and a fixed character budget on both the claim and source excerpts handed to the model.
   Two precision levers keep it quiet: a GROUNDING GATE (a verdict is discarded unless the model
   echoes back the exact row id it was asked about) and a MATERIALITY FLOOR (only `unsupported`/
   `contradicted` fire; `supported`/`partial` never do, so a normal paraphrase or summary is not
   flagged). REPORT-MODE / observe-only: it NEVER writes the ledger; its `suggested_action` tells a
   human/agent to re-verify against the source and drafts the `mem.mjs correct ...` command if the
   claim cannot be substantiated. MNPI/PHI rows are dropped before the LLM ever sees them (defense in
   depth on top of radar.mjs's central MNPI hard-route); MedReview/PHI-ring agents are never a data
   source at all. Fail-open (no creds / no network -> idle, never throws). Adds NO new infra beyond
   what kb-memory + model-routing already resolve. Pure core (`checkableRows`, `gateVerdict`,
   `scanRows`) is unit-tested with an injected fake faithfulness fn (no live network in tests).

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
would fire, touches no external state (no agent-state write, no PostHog emit, no dispatch). `--emit`
persists each firing Signal to the agent-state `signals` container, emits a `signal_detected` PostHog
event (Fleet Agents project), and routes `high` severity / escalated Signals to the owning agent's
`fleet-dispatch` inbox. `--json` emits a single machine-parseable JSON object on stdout (all narration
goes to stderr in this mode) for a cron wrapper or another tool to consume.

**FAIL LOUD, not silent-success (2026-09-03).** `--emit` used to print `cosmos NOT configured ...
nothing persisted or dispatched` to stderr and still exit 0 -- a scheduled job that ran every 30
minutes, looked perfectly healthy (fresh logs, every detector `[ok]`), and silently did nothing since
at least the 2026-08-28 SSM cleanup that removed the dead `cosmos-endpoint` secret. `--emit` now sets a
non-zero exit code in BOTH failure shapes: the store is unconfigured (checked before any write is
attempted), or the store reports configured but a real write still fails (unreachable/permission/auth).
A quiet fleet with nothing to persist is unaffected -- that is a genuine, honest success.

## Signal schema (see `schema.mjs`)
`{ id, detector, owner, subject, severity, why, evidence_link, suggested_action, mnpi, ts }`. `id` is a
stable `detector::subject` key (same finding re-firing reuses the same id, which is what makes cooldown
and consecutive-escalate possible without fuzzy matching). `owner` is the routing key (`cto` | `cfo` |
`growth` | `commerce`); a signal whose subject matches the MNPI test (INND/Xero/Plaid/stock/securities)
is hard-force-routed to `owner=cfo` and flagged `mnpi=true` regardless of which detector produced it,
so it can never leak into a fleet-wide digest.

## Storage: RDS Postgres `signals` container, via pg-state.mjs (ported 2026-09-03)
`skills/signal-radar/common.mjs` (`cosmosConfig`/`cosmosPutSignal`/`cosmosQuerySignals` -- names kept
for the two other live callers, radar.mjs's own cooldown lookup and
`compute-allocator/allocate.mjs`'s `recentSignalsFor()`) used to be a raw Azure Cosmos DB for NoSQL
REST client against the SAME Cosmos account decision-clock used. Azure subscription `55c84f6b` was
permanently deleted 2026-08-13, so it now delegates to `skills/kb-memory/pg-state.mjs`, the fleet's
RDS Postgres agent-state backend (built 2026-08-16 in PR #437, wired into this and
`decision-clock/cosmos-client.mjs` -- its only two intended callers -- on 2026-09-03). There is no
Cosmos fallback: this file had no `STATE_BACKEND`-style switch before the port, and a default-to-Cosmos
branch could only reproduce the exact silent-no-op bug the port fixes (see the FAIL LOUD note above for
the live incident this was caught from).

**Connection**: `pg-state.mjs` resolves `aws-pg-host` / `aws-pg-master-user` /
`aws-pg-master-password` / `aws-pg-port` via `kvSecret()` -- under the fleet default
`SECRET_BACKEND=ssm` that means AWS SSM `/otchealth/aws-pg-host` etc. This skill's ECS task definition
(`otchealth-job-signal-radar`) and its EventBridge schedule (`otchealth-signal-radar`, `rate(30
minutes)`, currently ENABLED) already run under the shared `otchealthTaskRole`, which already holds
`ssm:GetParameter*` on `/otchealth/*` and network access to the RDS security group -- **no
task-definition or IAM change was needed** to make this work.

**Known caveat, worth checking before relying on this in production**: `skills/kb-memory/
pg-state-schema.sql`'s own header states it was NOT YET APPLIED as of 2026-08-16 ("applied by the CTO
via a Fargate task" against the VPC-internal RDS instance, since this sandbox cannot reach it
directly). If the `agentstate_signals` table does not exist yet, the first real `--emit` tick after
this port lands will fail loud (a Postgres "relation does not exist" error propagating out of
`queryDocs`/`upsertDoc`) rather than the old silent no-op -- which is the CORRECT new behavior, but
confirm the schema has actually been applied (or apply it) so the schedule's very next tick succeeds
rather than merely failing correctly.

**Testing without a real Postgres connection**: `common.mjs` exports a test-only
`_setStateBackendForTests(fake)` / `_resetStateBackendForTests()` seam, and `radar.mjs` exports
`runScan({ io, dispatch, detectors, only, emitting, asJson, now })` with `io` (cosmosConfig/
cosmosPutSignal/cosmosQuerySignals/posthogEmit), `dispatch`, and `detectors` all injectable.
`node:test`'s `mock.module()` is not an option here (it needs `--experimental-test-module-mocks`,
which `run-tests.sh`'s `node --test` invocation does not pass); see
`tests/signal-radar-pg-state.test.mjs` for the working pattern -- including the gotcha that
`posthogEmit` must ALSO be injected in any test that reaches the persist loop, or a test with real AWS
credentials in its environment (as this sandbox has) will make a real network call and could post a
genuine event to the live Fleet Agents PostHog project.

## Deploy shape: AWS ECS + EventBridge Scheduler (already provisioned)
ECS task definition `otchealth-job-signal-radar` (image `doc-indexer:latest`, command
`/app/skills/signal-radar/job/radar.sh`), fired by EventBridge Scheduler `otchealth-signal-radar`
(`rate(30 minutes)`, currently ENABLED). Reuses the shared `doc-indexer` image (same repo, same
self-resolving secret pattern) rather than a dedicated image, since `radar.mjs` has no dependencies
beyond what that image already ships (Node + the repo checkout).

## Guardrails (make explicit, not implicit)
- **MNPI**: INND / Xero / Plaid / stock / cap-table / investor / securities subjects are hard-routed to
  `owner=cfo` and marked `mnpi=true`; never appear in a fleet-wide digest. Enforced in `schema.isMnpiSubject`
  + applied unconditionally in `radar.mjs` before any signal is persisted or dispatched.
- **PHI**: MedReview is never a data source. `sentry-error-spike` hard-excludes MedReview Sentry
  projects via `schema.isPhiExcluded`; no other detector touches a PHI-ring system at all.
- **Fail-open on a DETECTOR error, fail-loud on a STORE error**: one detector throwing an error produces
  zero signals + one diagnostic note for that detector only; it never aborts the scan or crashes the
  process (`radar.mjs`'s `runDetectorSafely`), and the top-level `scan` command wraps in try/catch and
  exits 0 on an unexpected internal error (mirrors fleet-medic). This is deliberately NARROWER than it
  used to be: `--emit` failing to persist or dispatch because the agent-state store is unconfigured or
  unreachable is its OWN, separate, non-zero exit code (see "FAIL LOUD" above) set BEFORE that top-level
  catch is ever reached -- a broken detector staying quiet must never be confused with a healthy fleet
  whose findings simply never got recorded.
- **Never-cry-wolf**: `schema.shouldFire` applies a per-severity cooldown (high 4h, medium 12h, low 24h)
  before the SAME finding (same `detector::subject` id) can re-fire, and only escalates (bumps to a
  human-visible flag) after 3 consecutive un-resolved firings. A flapping metric gets ONE dispatch, then
  goes quiet until it either clears or persists long enough to be worth re-flagging.
- **Report-only**: no detector or the radar core ever calls a mutating API on another system (no
  restarts, no rollbacks, no secret rotation, no billing changes). The only writes Radar itself performs
  are (a) its own agent-state `signals` container and (b) a `fleet-dispatch` inbox message; both are
  observability/coordination writes, never a production action.

## Testing
`tests/signal-radar.test.mjs` covers every detector's PURE logic function hermetically (no network): 
`schema.shouldFire` cooldown/escalate, `schema.isMnpiSubject`/`isPhiExcluded`, `sentry-error-spike.evaluateSeries`,
`eval-regression.findRegressions`, `grant-burn-expiry.classifyGrants`, `rotate-secret-age.findAgedRotateSecrets`,
`mark-review-overdue.parseLedger`/`isReviewCandidate`. `tests/signal-radar-pg-state.test.mjs` covers the
agent-state wiring itself with a fake backend: `common.mjs`'s delegation, and `radar.mjs`'s `runScan()`
persisting + dispatching when configured and failing loud (non-zero exit) when not, or when a
configured store's write still fails. `node --check` passes on every file (see `run-tests.sh`).
