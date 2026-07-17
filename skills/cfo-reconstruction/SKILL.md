---
name: cfo-reconstruction
description: Advances the CFO's multi-year (FY2021-present) financial-reconstruction ANALYSIS on a Tier-1 nightly Container Apps Job, so it keeps rolling forward between the turn-based CFO agent's Claude Chat/Cowork check-ins instead of sitting idle. READ-ONLY, ANALYSIS ONLY: pulls read-only Xero snapshots (TrialBalance/BalanceSheet) per entity and drains an optional externally-staged manifest of verification items (e.g. attachment-match checks), then stages ONE evidence-backed batch per run into the CFO data room (cfo-store + CFO OneDrive Incoming) for Matt/CFO sign-off. NEVER posts, writes, creates, updates, or voids anything in Xero or any other ledger -- every Xero call goes through xero-readonly.mjs's hardcoded allowlist of gateway tools the gateway itself labels read-only, and the write-capable tool is never imported anywhere in this skill. The CFO's actual posting workflow (skills/xero/xero-bulk.mjs, the xero-run Container Apps Job) is separate and untouched by this skill. INND/HearingAssist financials are MNPI: this skill's output never leaves the CFO's own non-PHI data room and is never sent to web search or any external service. Wielded by the CFO agent and the CTO (who owns the Container Apps Job deploy).
---

# cfo-reconstruction -- nightly analysis harness for the CFO's book reconstruction

## What this is (and is not)
The CFO's FY2021-2022 per-entity Xero reconstruction (see `docs/CFO-MASTER-HANDOFF-2026-06-29.md`)
is deep, judgment-heavy forensic work the CFO agent does turn by turn in Claude Chat/Cowork. Matt
approved wiring the ANALYSIS side of that work as a Tier-1 nightly autonomous job so it advances
between check-ins. This skill is that harness. It is:
- **Read-only against Xero.** It only ever calls gateway tools documented as read-only
  (`xero_report`, `xero_get`, `xero_accounts`, `xero_contacts`, `xero_invoices`,
  `xero_bank_transactions`, `xero_credit_notes`, `xero_payments`, `xero_manual_journals`,
  `xero_attachments`, `xero_orgs`) through the hardcoded allowlist in `xero-readonly.mjs`.
- **A staging harness, not the forensic engine itself.** It does not replace the CFO's own
  judgment-heavy matching/vetting work; it keeps a rolling drift signal fresh (kind A) and drains a
  bounded batch of externally-staged verification items when the CFO (or a future feeder script)
  stages one (kind B). See "Analysis kinds" below.
- **NEVER a posting path.** Posting to Xero (creating/updating/voiding a record) stays exactly where
  it is today: `skills/xero/xero-bulk.mjs` and the `xero-run` Container Apps Job
  (`rg-otchealth-apps-prod`), both gated to Matt's per-step sign-off. This skill does not import,
  shell out to, or otherwise reach either of them. See "The never-posts rail" below.

## Analysis kinds
**(A) xero-snapshot** -- self-bootstrapping, needs no external input. For each of the four entities
(`otchealth | innd | hearingassist | personal`) whose last staged snapshot is missing or older than
`--stale-hours` (default 20h), pulls a read-only `TrialBalance` + `BalanceSheet` as-at today, hashes
the result, and compares it to the last staged hash. Reports `CHANGED` or `UNCHANGED`. This keeps a
rolling "did anything move" signal fresh across all four entities even before anyone stages a
manifest, so the job is never a no-op.

**(B) manifest-drain** -- optional. If a JSONL work queue exists in the data room at
`reconstruction-analysis/manifest/<org>.jsonl` (one JSON object per line, `status:"pending"`), drains
up to `--batch-size` (default 25) pending items per entity per run. Today's item kind:
`attachment-check` (`{org, kind:"attachment-check", endpoint, guid, expectedDoc?}`) -- verifies (via
`xero_attachments`, read-only) that the Xero record actually carries an attachment, and (via a
`cfo-store` existence check) that the claimed source doc exists in the data room. Verdicts:
`MATCHED | MISSING_XERO_ATTACHMENT | MISSING_SOURCE_DOC | MISSING_BOTH | ERROR`. Nothing populates
this manifest yet in this repo -- staging one (by hand, or from a future feeder script built on top
of the CFO's existing forensic scripts) is a follow-up, not a blocker: kind A alone makes every
nightly run useful.

## Use
```
node skills/cfo-reconstruction/reconstruct.mjs sweep [--dry-run] [--json]
     [--batch-size N] [--max-minutes N] [--stale-hours N] [--orgs otchealth,innd,hearingassist,personal]
node skills/cfo-reconstruction/reconstruct.mjs status [--json]   # last snapshot per entity
```
`sweep` with no flags STAGES for real (writes the batch to cfo-store + CFO OneDrive Incoming, best-
effort opens a decision-clock review gate and logs a status line). `--dry-run` computes and reports
the batch that WOULD be staged without writing anything anywhere -- use it to preview or to smoke-
test after a deploy. Unlike `legal-deadline-pager`'s `--commit` gate (which guards an action with a
human-facing cost, sending an email), staging a read-only analysis artifact into the CFO's own
private data room has no such cost, so it is on by default, matching every other librarian/nightly
job in this fleet (`nightly.sh`, `librarian.sh`, `brain-reindex.sh`).

## The never-posts rail
`xero-readonly.mjs` is the ONLY place this skill talks to Xero. Its `callXeroReadOnly()` function
checks the requested gateway tool name against a hardcoded, frozen allowlist BEFORE any network
call, and throws for anything not on it -- including the gateway's one write-capable Xero tool
(method POST/PUT/DELETE against any Xero endpoint), which is never imported or named anywhere in
this skill. `tests/reconstruct.test.mjs` enforces this two ways: (1) a direct test that the allowlist
wrapper refuses a disallowed tool name before ever calling `fetch`, and (2) a source-scan test that
fails the build if the write tool's name, or either of `xero-bulk`/`xero-run` (the separate,
already-existing posting systems), ever appears anywhere in this skill's own `.mjs`/`.sh` files.

## Where it runs
`job/cfo-nightly.sh` mirrors the shape of every other Tier-1 job in this fleet (`nightly.sh`,
`librarian.sh`, `decision-clock/job/decision-clock-sweep.sh`): one command,
`node reconstruct.mjs sweep --json`, authenticating via the job's managed identity
(`id-otc-jobs-kv`) rather than a stored secret. `runbooks/cfo-reconstruction-job.md` (repo root
`runbooks/`) has the exact `az containerapp job create` spec for `otchealth-automation-rg` /
`otchealth-jobs-env` -- not applied by this PR; deploying it is a separate, explicit CTO step.

## Separation from xero-run
This skill reads and writes ONLY under the `reconstruction-analysis/` prefix in the CFO data room
(`state/cursor.json`, `manifest/<org>.jsonl`, `staged/<batchId>.json`) -- deliberately a different
namespace from the existing `xero-run/queue|state|results/` prefix the posting job owns, and a
different Container Apps environment resource group (`otchealth-automation-rg` here vs.
`rg-otchealth-apps-prod` for `xero-run`). Zero shared mutable state between the read-only analysis
job and the write-capable posting job.

## Ring safety
Non-PHI. INND and HearingAssist figures are MNPI: every read is tagged `acknowledge_warning:true`
(this is Matt-approved internal CFO automation) but the output never leaves the CFO data room --
never `web_search`, never any external service, never a git repo. Staged batches note
`innd`-involvement so a human reviewer sees it before opening the artifact. Never touches
MedReview/FourVault or any PHI-ring data.
