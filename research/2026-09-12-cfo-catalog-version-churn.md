# CFO catalog version churn prevention

## Finding

The CFO graph catalog page guard correctly rejects a cohort when the raw catalog's
current S3 VersionId differs from the materialization receipt. The guard runs before
proposal, admission, model, or snapshot work.

The active S3-capable full-catalog writers were the document indexer, enrichment
pass, and deep pass. Each serialized and PUT the complete catalog after its run,
including when the produced bytes were unchanged. An S3 PUT creates a new VersionId,
which invalidates an otherwise current materialization pin.

`force-ocr-specific-files.mjs` also rewrites a catalog, but it is a legacy Azure-only
one-off targeting an explicit non-CFO container. It is not on the current CFO S3 path.
The CFO materializer reads the raw catalog and only creates objects below its separate
materialized-catalog prefix. It does not write the raw catalog.

## Change

The three S3 writers now retain the bytes and ETag returned by their catalog read.
They skip the PUT when the generated canonical JSONL bytes are identical. For a changed
catalog, they issue `If-Match` with that ETag. A concurrent catalog update therefore
causes a visible conditional-write failure instead of a stale overwrite. Initial
creation uses `If-None-Match: *`.

For completed Bedrock batch enrichment, the paid-job resume marker is retained until
that conditional catalog write succeeds. A conflict therefore resumes reconciliation
of the existing batch result on the next run and cannot submit a second paid job.

## Validation

Synthetic tests prove the no-write result for identical bytes, `If-Match` for changed
bytes, conditional creation for an absent object, and fail-closed behavior if a changed
object lacks an ETag. The batch fixture forces a 412 stale-write conflict, verifies the
marker persists, then verifies a retry resumes without a new submission. The S3 helper
test confirms one GET returns binary bytes, ETag, and VersionId together.

No catalog content, credentials, production reads, or production writes were used.
