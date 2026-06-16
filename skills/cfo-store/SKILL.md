---
name: cfo-store
description: Durable, access-controlled object store for the CFO's financial exports and source documents. Wraps a PRIVATE Google Cloud Storage bucket (otchealth-cfo-source-docs) in otchealth-shared-prod, IAM-gated to the claude-driver SA. Use to persist QuickBooks/Xero exports, bank statements, invoices, and other source docs out of the ephemeral session sandbox into a permanent, secure home. Put/put-dir/list/get. Non-PHI ring; raw multi-entity financials (incl. INND material non-public info and personal data) live here, never in a git repo.
---

# CFO source-doc store (durable GCS)

The CFO's permanent, secure home for financial exports and source documents. The session
sandbox is ephemeral, so anything worth keeping (QBO/Xero exports, bank statements, invoices,
1099s, attachments) must land here. A git repo is NOT acceptable for raw financials: INND is a
public company (material non-public information) and the personal entity is personal data, so
the store is a PRIVATE, IAM-gated GCS bucket, internal handling only, never disclosure.

## The store
- Bucket: `otchealth-cfo-source-docs` (private, uniform access, public-access-prevention ON),
  project `otchealth-shared-prod` (same project as the secrets).
- Access: IAM grant of `roles/storage.objectAdmin` to `claude-driver@otchealth-shared-prod.iam.gserviceaccount.com`.
  The SA already hydrates every session, so no new credential to manage.

## Credentials (hydrated)
- `GCP_CLAUDE_DRIVER_SA_JSON` (the SA; auth)
- `CFO_SOURCE_BUCKET` (`cfo-source-bucket`; defaults to `otchealth-cfo-source-docs` if unset)

## Commands
```
node skills/cfo-store/store.mjs put <localFile> <objectName>
node skills/cfo-store/store.mjs put-dir <localDir> <objectPrefix>   # recursive upload (use for export dirs)
node skills/cfo-store/store.mjs list [prefix]
node skills/cfo-store/store.mjs get <objectName> <localFile>
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
- INND data is MNPI: internal handling only. Access stays IAM-restricted; never make objects public.
- This store is for data the CFO owns/extracts; it never holds secrets (those live in Secret Manager).
