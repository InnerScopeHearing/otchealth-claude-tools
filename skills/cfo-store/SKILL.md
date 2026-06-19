---
name: cfo-store
description: Durable, access-controlled object store for the CFO's financial exports and source documents. TWO backends behind the same put/put-dir/list/get verbs - the legacy PRIVATE Google Cloud Storage bucket (otchealth-cfo-source-docs, claude-driver SA) and the Azure Blob data room (account otchealthcfodata, container cfo-source-docs, the funded-credit lane per the Azure directive). Pick with --azure / --gcs or STORAGE_BACKEND. Use to persist QuickBooks/Xero exports, bank statements, invoices, and other source docs out of the ephemeral session sandbox into a permanent, secure home. Non-PHI ring; raw multi-entity financials (incl. INND material non-public info and personal data) live here, never in a git repo.
---

# CFO source-doc store (GCS legacy + Azure Blob data room)

The CFO's permanent, secure home for financial exports and source documents. The session
sandbox is ephemeral, so anything worth keeping (QBO/Xero exports, bank statements, invoices,
1099s, attachments) must land here. A git repo is NOT acceptable for raw financials: INND is a
public company (material non-public information) and the personal entity is personal data, so
the store is PRIVATE / access-controlled, internal handling only, never disclosure.

## Two backends (same verbs)
- **azure** (the funded lane, per the Azure directive): Azure Blob account `otchealthcfodata`
  (RG `otchealth-automation-rg`, subscription `55c84f6b...`, tenant `4ab58580...`, under
  `matthew@otchealth.app`), dedicated container `cfo-source-docs`. SharedKey auth. This is the
  data-room target the GCS bucket migrates into.
- **gcs** (legacy, default while the books are reconstructed): private GCS bucket
  `otchealth-cfo-source-docs` in `otchealth-shared-prod`, IAM-gated to the claude-driver SA
  (`roles/storage.objectAdmin`).

Select the backend with `--azure` / `--gcs` (per-command) or `STORAGE_BACKEND=azure|gcs`.
Default is `gcs` until the migration cuts over; then flip to `azure`.

## Credentials (hydrated, else self-resolved from Secret Manager via the SA)
- `GCP_CLAUDE_DRIVER_SA_JSON` (the SA; auth for GCS AND for resolving the Azure key from SM)
- GCS:   `CFO_SOURCE_BUCKET` (`cfo-source-bucket`; defaults to `otchealth-cfo-source-docs`)
- Azure: `AZURE_STORAGE_ACCOUNT` (`azure-cfo-storage-account` = `otchealthcfodata`),
  `AZURE_STORAGE_KEY` (`azure-cfo-storage-key`, the account key; ROTATE-BEFORE-LAUNCH).
  Container defaults to `cfo-source-docs` (its own container, kept separate from the narrower
  `innd-stock` workbook lane); override with `--container <name>` or `CFO_AZURE_CONTAINER`.

## Commands
```
# GCS (legacy / default)
node skills/cfo-store/store.mjs put <localFile> <objectName>
node skills/cfo-store/store.mjs put-dir <localDir> <objectPrefix>   # recursive upload
node skills/cfo-store/store.mjs list [prefix]
node skills/cfo-store/store.mjs get <objectName> <localFile>

# Azure Blob data room (add --azure, or set STORAGE_BACKEND=azure)
node skills/cfo-store/store.mjs --azure put <localFile> <objectName>
node skills/cfo-store/store.mjs --azure put-dir <localDir> <objectPrefix>
node skills/cfo-store/store.mjs --azure list [prefix]
node skills/cfo-store/store.mjs --azure get <objectName> <localFile>
node skills/cfo-store/store.mjs --azure rm <objectName>
node skills/cfo-store/store.mjs --azure create-container          # idempotent (auto-runs on first put)
```

## Suggested layout
```
qbo-export/<YYYY-MM-DD>/<entity>/...      # QuickBooks exports per run
xero-export/<YYYY-MM-DD>/<entity>/...
bank/<entity>/<account>/<statement>
source-docs/<entity>/<vendor>/<year>/...  # mined invoices/statements/receipts
```

## Guardrails
- Non-PHI ring only. Never store MedReview / PHI data here.
- Entity scoping: keep each entity's data under its own prefix; personal stays separate from the
  business entities.
- INND data is MNPI: internal handling only. Access stays private/restricted; never make objects
  or the Azure container public (container is created private by default; do not set public access).
- This store is for data the CFO owns/extracts; it never holds secrets (those live in Secret Manager).
- Migration note: the GCS bucket is the live data room while the books are reconstructed; the whole
  bucket migrates to the Azure `cfo-source-docs` container in ONE pass once reconstruction is done
  (don't split the room across backends mid-reconciliation).
