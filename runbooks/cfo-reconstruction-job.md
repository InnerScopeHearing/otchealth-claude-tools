# cfo-reconstruction nightly job -- deploy runbook

**Status: NOT DEPLOYED.** This runbook documents the exact `az containerapp job` spec to add the
Tier-1 nightly CFO-reconstruction-analysis job alongside the fleet's other Container Apps Jobs on
`otchealth-automation-rg` / `otchealth-jobs-env`. Nothing here has been applied to any live Azure
resource -- deploying it (rebuilding the image, running `az containerapp job create`, confirming
the first run) is a separate, explicit step for whoever reviews and lands this PR (the CTO).

Code lives at `skills/cfo-reconstruction/` (see its `SKILL.md` for the full design). This file is
the deploy/ops side only.

## What this job does, in one paragraph
Every night it (A) pulls a read-only TrialBalance + BalanceSheet snapshot for each of the four
entities (otchealth, innd, hearingassist, personal) and reports whether anything changed since the
last snapshot, and (B) drains up to `--batch-size` pending items from an optional externally-staged
manifest (`reconstruction-analysis/manifest/<org>.jsonl` in the CFO data room), running a read-only
verification per item. If anything was found, it writes ONE evidence-backed batch to the CFO data
room (`cfo-store`, the authoritative copy) and mirrors it to CFO OneDrive "CFO Incoming" (the
human-facing copy), then best-effort opens a `decision-clock` review gate and logs a status line to
the CFO's `kb-memory` ledger. It never posts, writes, or changes anything in Xero or any other
ledger -- see "The never-posts rail" below, and `skills/cfo-reconstruction/xero-readonly.mjs`.

## REQUIRED before this job can succeed: rebuild the shared image
This PR adds three `COPY` lines to `skills/doc-indexer/job/Dockerfile`
(`skills/cfo-reconstruction/`, `skills/gateway-connect/`, `skills/cfo-onedrive/` -- the three skill
directories this job needs that were not already baked into the shared `doc-indexer:latest` image).
**Until the image is rebuilt, this job will fail immediately with `MODULE_NOT_FOUND`.** Rebuild
headlessly the same way every other doc-indexer feature PR in this repo's history has (see
`skills/doc-indexer/job/README.md` and the CTO's dated notes for "doc-indexer image rebuilt
headlessly via ARM"):
```bash
cd otchealth-claude-tools && git pull
az acr build -r otchealthacr -t doc-indexer:latest -f skills/doc-indexer/job/Dockerfile .
```
Do this BEFORE the `az containerapp job create` below, or before the first `job start` smoke test.

## Deploy (copy-paste, Azure Cloud Shell or any az-authenticated shell)

Fixed identifiers used below (verified against this repo's own `setup/deploy-gate-check.mjs` /
`setup/expected-resources.json`, which every other Container Apps Job in this fleet already uses):
- Subscription: `55c84f6b-ef90-4259-a58b-50835cc4cab4`
- Resource group (job + ACR + environment): `otchealth-automation-rg`
- Container Apps environment: `otchealth-jobs-env`
- Image (shared, reused): `otchealthacr.azurecr.io/doc-indexer:latest`
- Managed identity (Key Vault Secrets User + AcrPull, already granted): `id-otc-jobs-kv`
  full resource id:
  `/subscriptions/55c84f6b-ef90-4259-a58b-50835cc4cab4/resourceGroups/otchealth-automation-rg/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-otc-jobs-kv`

```bash
IDENTITY_ID="/subscriptions/55c84f6b-ef90-4259-a58b-50835cc4cab4/resourceGroups/otchealth-automation-rg/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-otc-jobs-kv"

az containerapp job create \
  --name cfo-reconstruction-nightly \
  --resource-group otchealth-automation-rg \
  --environment otchealth-jobs-env \
  --trigger-type Schedule \
  --cron-expression "10 8 * * *" \
  --replica-timeout 1500 \
  --replica-retry-limit 1 \
  --parallelism 1 \
  --image otchealthacr.azurecr.io/doc-indexer:latest \
  --registry-server otchealthacr.azurecr.io \
  --registry-identity "$IDENTITY_ID" \
  --mi-user-assigned "$IDENTITY_ID" \
  --cpu 1 --memory 2Gi \
  --command "/bin/sh" \
  --args "/app/skills/cfo-reconstruction/job/cfo-nightly.sh"
```

Notes on every field:
- **No `--secrets` / `--env-vars` at all.** This job authenticates entirely through
  `id-otc-jobs-kv` (`--mi-user-assigned`), the SAME pattern `nightly.sh`/`cfo-store`/`kb-memory`
  already use (`skills/kb-memory/azure-secret.mjs`'s `kvSecret()` tries the managed identity first).
  This is a deliberate improvement over the OLDER per-skill job docs still in this repo
  (`skills/decision-clock/job/decision-clock-job.md`, `skills/legal-deadline-pager/job/*.md`), which
  predate the 2026-07-13 cutover to managed-identity auth (see `skills/cfo-store/store.mjs`'s git
  history) and still show a `gcpsa` job secret. Follow THIS file's pattern, not those two, if you are
  looking for the current canonical shape.
- **`--registry-identity` matches `--mi-user-assigned`** so the platform pulls the image using
  `id-otc-jobs-kv`'s existing `AcrPull` role (already granted per
  `setup/deploy-gate-check.mjs`/`setup/expected-resources.json`) instead of ACR admin credentials.
- **`--cron-expression "10 8 * * *"`** (08:10 UTC daily) is staggered against the fleet's existing
  `otchealth-automation-rg` cron jobs: `daily-digest` (59 23), `brain-reindex`/`librarian-finance`
  (0 */6), `librarian-commerce` (:15 hourly), `librarian-legal-company` (:20/6h),
  `librarian-legal-personal` (:40/6h), `ledger-compaction` (0 8 -- ten minutes before this job, not
  the same minute), `agent-state-janitor` (30 */6). It is also deliberately NOT the same minute as
  the CFO's separate posting job's own `0 7` cron (a different resource group, `rg-otchealth-apps-prod`)
  so the two are never mistaken for the same run in a shared log view.
- **`--replica-timeout 1500`** (25 min) gives headroom over the job's own `--max-minutes 20` soft
  budget (container start + auth round trips are not free); `--replica-retry-limit 1` and
  `--parallelism 1` match the task brief and avoid the read-modify-write manifest race a concurrent
  run could otherwise cause (see `reconstruct.mjs`'s `runSweep` doc comment).
- **`--cpu 1 --memory 2Gi`**: this is a dependency-free Node job doing a handful of HTTPS calls, not
  OCR/embedding -- the same size as `decision-clock-sweep`/`legal-deadline-pager-sweep`, far lighter
  than the doc-indexer heavy-pass jobs.
- **`--args` is ONE token** (the script path). Per this fleet's own documented footgun
  (`skills/doc-indexer/job/README.md` "CRITICAL: --args must be SEPARATE tokens, not a comma
  string"), never pass a comma-joined string here.

### Smoke test before trusting the cron (recommended)
`--args` on `job start` REPLACES the whole args array for that one execution, so append `--dry-run`
as a second token to preview without writing anything anywhere (mirrors
`skills/cfo-reconstruction/reconstruct.mjs`'s own `--dry-run` flag):
```bash
az containerapp job start -n cfo-reconstruction-nightly -g otchealth-automation-rg \
  --command "/bin/sh" \
  --args "/app/skills/cfo-reconstruction/job/cfo-nightly.sh" "--dry-run"
```
Check the execution's outcome via:
```bash
az containerapp job execution list -n cfo-reconstruction-nightly -g otchealth-automation-rg -o table
```
There is no Log Analytics workspace on `otchealth-jobs-env` (a known, standing limitation shared by
every job on it), so a failed replica's console output is not retrievable after the fact. If a run
fails, reproduce it directly in a session that has the identity's equivalent credentials hydrated
(`node skills/cfo-reconstruction/reconstruct.mjs sweep --dry-run --json`) to see the actual error.

### Update example (cron change, no code change)
```bash
az containerapp job update -n cfo-reconstruction-nightly -g otchealth-automation-rg \
  --cron-expression "15 9 * * *"
```

## Why staging is on by default, unlike legal-deadline-pager's `--commit` gate
`legal-deadline-pager` and `nightly-reflection`/`contradiction-scan` default to a dry run and
require `--commit` to write, because their write is a human-facing action with a real cost if wrong
(an email lands in an inbox, a proposal is opened). Staging a read-only analysis artifact into the
CFO's OWN private, non-PHI data room has no equivalent cost: nothing is sent to anyone, nothing is
posted anywhere, and a wrong or redundant staged batch is a minor review nuisance, not a mistake with
consequences. So `reconstruct.mjs sweep` stages unconditionally by default, exactly like every other
librarian/nightly job in this fleet (`nightly.sh`, `librarian.sh`, `brain-reindex.sh`) -- `--dry-run`
is the opt-in preview flag for manual testing, not the default posture.

## The never-posts rail (read this before touching this job)
This job is **structurally** incapable of writing to Xero, not merely configured not to:
- Every Xero call in `skills/cfo-reconstruction/` goes through
  `xero-readonly.mjs`'s `callXeroReadOnly()`, which checks the requested gateway tool name against a
  hardcoded, frozen allowlist (`xero_orgs`, `xero_accounts`, `xero_contacts`, `xero_invoices`,
  `xero_bank_transactions`, `xero_credit_notes`, `xero_payments`, `xero_manual_journals`,
  `xero_attachments`, `xero_report`, `xero_get`) BEFORE any network call, and throws for anything
  else -- including the gateway's one write-capable Xero tool
  (`mcp__otchealth-gateway__xero_request`, method POST/PUT/DELETE against any Xero endpoint), which
  is never imported or named anywhere in this skill.
- `skills/cfo-reconstruction/tests/reconstruct.test.mjs` enforces this two ways: a direct test that
  the allowlist wrapper refuses a disallowed tool name before `fetch` is ever called, and a
  source-scan test that fails the build if the write tool's name, or either of the CFO's existing
  separate Xero-posting skill/job (deliberately not named by literal path in this file either -- see
  below), ever appears anywhere in this skill's own source.
- There is no flag, environment variable, or CLI argument anywhere in this job that turns a read
  into a write.

## Separation from the posting job
The CFO's existing, already-scheduled Xero-posting system (a batched poster skill plus its own
Container Apps Job, named in `docs/CFO-MASTER-HANDOFF-2026-06-29.md` -- `skills/xero/xero-bulk.mjs`
and the `xero-run` job in the DIFFERENT resource group `rg-otchealth-apps-prod`) is the thing that
actually writes to the books, gated to Matt's per-step sign-off. This job:
- Runs in `otchealth-automation-rg` (not `rg-otchealth-apps-prod`).
- Reads/writes only under the `reconstruction-analysis/` prefix in the CFO data room
  (`reconstruction-analysis/state/cursor.json`, `reconstruction-analysis/manifest/<org>.jsonl`,
  `reconstruction-analysis/staged/<batchId>.json`) -- a different namespace from the posting job's
  own queue/state/results prefix, so there is zero shared mutable state between the two.
- Never imports, shells out to, or otherwise reaches the posting skill or the posting job. This
  skill's own source deliberately never spells out their literal path/name (see the "NOTE ON THIS
  COMMENT'S PHRASING" comment in `xero-readonly.mjs`) so the source-scan test above stays a real,
  un-gameable guarantee rather than a string a future edit could quietly re-add around.

## The manifest contract (for a future feeder script; nothing populates it yet)
`reconstruction-analysis/manifest/<org>.jsonl` in the CFO data room (`cfo-store`), one JSON object
per line:
```json
{"id": "optional-stable-id", "kind": "attachment-check", "org": "otchealth", "endpoint": "Invoices", "guid": "<Xero record GUID>", "expectedDoc": "source-docs/otchealth/vendor/2021/invoice-118.pdf", "status": "pending"}
```
`endpoint` is one of the values `xero_attachments` accepts (`Invoices | CreditNotes |
BankTransactions | BankTransfers | Payments | ManualJournals | Receipts | Contacts |
PurchaseOrders`). `reconstruct.mjs sweep` drains up to `--batch-size` `status:"pending"` items per
entity per run (file order, oldest first), verifies read-only whether the Xero record actually
carries an attachment and whether `expectedDoc` exists in the data room, and flips processed items to
`status:"staged"` (never deletes a line, so the manifest itself stays an audit trail). Staging this
file today is a manual step (or a future feeder script built on the CFO's existing forensic
scripts) -- the nightly job is useful without it (see kind A, the self-bootstrapping snapshot pass).

## After deploying (follow-ups, not done by this PR)
- Add `cfo-reconstruction-nightly` to `setup/expected-resources.json` (type `containerAppJob`,
  resource group `otchealth-automation-rg`) ONLY after the `az containerapp job create` above has
  actually been run -- adding it before the resource exists would make `resource-reconcile.mjs`
  report a false "expected but absent" drift.
- Confirm the `id-otc-jobs-kv` managed identity can reach the `oauth-lane-cfo-id` /
  `oauth-lane-cfo-secret` Key Vault secrets (the same RBAC role, Key Vault Secrets User on
  `kv-otc-55c84f6bef`, already covers these -- no new grant should be needed, but the smoke test
  above is the actual proof).
- Optionally stage a first manifest file (see the contract above) once a feeder script or a manual
  batch exists; kind A (the snapshot pass) already makes every night useful without one.
- Watch the first several real runs' `decision-clock` review gates (`node
  skills/decision-clock/decision.mjs list --owner cfo`) to confirm Matt/CFO are actually seeing and
  clearing them, not letting them silently accumulate.
