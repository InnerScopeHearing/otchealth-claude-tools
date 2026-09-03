---
name: ocr-sweep
description: Standing auto-OCR backfill for the legal + CFO S3 data rooms, so every scanned PDF/image has a full-text _TEXT/<name>.txt sidecar the doc-indexer (and any FTS5/OpenSearch search over the room) can read without re-OCR-ing. Lists each room via the same S3 mirror layer skills/doc-indexer/indexer.mjs uses, finds documents missing a sidecar, and OCRs them with Amazon Textract (DetectDocumentText for a single-page/under-10MB document, StartDocumentTextDetection + polling for anything larger or multi-page). Bounded per run by MAX_PAGES/MAX_DOCS_PER_RUN/MAX_MB so cost stays predictable (default budget: about $0.75 of Textract per run); resumable (a written sidecar is the completion marker, so a re-run only touches new/failed uploads). Fails open on a per-document content problem (a corrupt or genuinely unsupported file is logged and skipped, the run continues) but fails LOUD -- non-zero exit, a clear stderr line -- on anything that means the pipeline itself is broken: a missing IAM permission, an unmapped/misconfigured room ("missing bucket"), or Textract being unreachable. Replaces the fully-dead Azure Document Intelligence version of this file (Azure Document Intelligence and Azure Blob are both permanently gone since the Azure subscription was deleted 2026-08-13). PHI wall: only the legal + cfo rooms, never MedReview. Use when re-arming the otchealth-docintel-ocr-sweep schedule, auditing why scanned documents are not full-text searchable, or granting/reviewing this job's IAM.
---

# ocr-sweep -- Amazon Textract backfill for the legal + CFO data rooms

## Why this exists, and why it needed a rewrite (not just a repoint)

`skills/ocr-sweep/sweep.mjs` runs as the `otchealth-docintel-ocr-sweep` ECS scheduled job. Before
2026-09-03 it was hardcoded to Azure Document Intelligence (`prebuilt-read`) reading from Azure Blob
SAS URLs. Both are permanently gone: the Azure subscription `55c84f6b-ef90-4259-a58b-50835cc4cab4`
was deleted 2026-08-13 (see the repo's `CLAUDE.md` "CORRECTION: Azure is permanently gone" section).
The job's EventBridge schedule has been **DISABLED** the whole time this was true, so no scanned PDF
or image anywhere in the legal or CFO rooms has been OCR'd since the Azure loss -- every document
that needed OCR (not just text-layer PDF extraction, which `skills/doc-indexer/indexer.mjs` still
does on its own, unrelated path) has sat without a searchable text sidecar.

The 2026-09-03 fleet audit (`L4-aws-ai.md` item C1) chose **Amazon Textract** as the replacement: it
runs in our own AWS account, against the same S3 buckets the source documents already live in (no
new data boundary), at $1.50 per 1,000 pages.

## Architecture

**No download, ever.** The old sweep fetched a SAS URL and buffered the WHOLE FILE into process
memory before POSTing it to Document Intelligence -- exactly the pattern that OOM-killed the
doc-indexer container before it got its own `MAX_INDEX_MB` guard. Textract's API instead takes a
plain **S3 object reference** (`Document.S3Object: {Bucket, Name}`) for both the synchronous and
asynchronous operations -- Textract's own service fetches the bytes. This process never buffers a
document. Two direct consequences: (1) there is no OOM class to guard against here at all, and (2)
the credential this job needs is a plain **IAM grant** on its ECS task role, not a Secret Manager
value -- there is no more `azure-docintel-endpoint`/`-key`, `azure-legal-storage-key`, or
`azure-cfo-storage-account`/`-key` dependency anywhere in this file.

**Storage.** Reads/writes go through `skills/kb-memory/s3-blob.mjs` -- the SAME (account, container)
-> (bucket, keyPrefix) MIRROR table `skills/doc-indexer/indexer.mjs` uses, so this sweep and the
indexer agree on exactly where a room's documents and sidecars physically live. This file is scoped
to exactly two logical rooms (the PHI wall):

| room  | account              | containers            |
|-------|----------------------|------------------------|
| legal | `otchealthlegalstore` | `company`, `personal` |
| cfo   | `otchealthcfodata`    | `cfo-source-docs`      |

**Sidecar shape.** `_TEXT/<name>.txt`, a single top-level `_TEXT/` prefix mirroring the whole tree
beneath it (e.g. `folder/sub/doc.pdf` -> `_TEXT/folder/sub/doc.pdf.txt`) -- this matches
`indexer.mjs`'s own `TEXT_PREFIX + path + ".txt"` convention EXACTLY, so a sidecar either file writes
is read identically by the other and nothing downstream (the FTS5 index, `push-search`, `brain_search`)
needs to change. This is a **deliberate shape change** from the pre-2026-08 Azure-era version of this
file, which nested a `_TEXT/` directory inside every subdirectory (`dir/_TEXT/base.ext.txt`) -- that
shape never matched what the indexer actually reads.

**Textract signing.** Via `../../setup/aws-sigv4.mjs`'s `awsFetch()` -- the shared, already-tested,
dependency-free SigV4 signer this toolkit consolidated onto (FND-20260828-5ca1), reused rather than a
third hand-rolled implementation. No AWS SDK is added; this repo has no root `package.json` and no
existing `aws-sdk`/`@aws-sdk/*` dependency anywhere, so a bare fetch-based JSON-protocol call (exactly
how S3 and every other AWS-native skill here already works) is the consistent choice.

**Formats.** JPEG, PNG, PDF, TIFF only -- Textract's own supported set. This is **narrower** than the
old Azure Document Intelligence sweep, which also OCR'd `.docx`/`.xlsx`/`.pptx` (Azure's
`prebuilt-read` model reads Office formats directly; Textract has no equivalent). Those formats are
not "scanned" documents needing OCR to begin with -- `indexer.mjs`'s own LibreOffice-based text
extraction already handles them, on a separate code path, unaffected by this file.

## Sync vs async routing

Textract's synchronous `DetectDocumentText` only accepts a document up to 10MB (S3Object mode) and
only the FIRST page of a multi-page PDF/TIFF -- a genuinely multi-page document raises
`UnsupportedDocumentException` (confirmed 2026-09-03 against AWS's own documentation and a live-quoted
AWS re:Post answer). `StartDocumentTextDetection`/`GetDocumentTextDetection` (the async job API)
accept the identical format set, up to Textract's 3,000-page ceiling per async document.

Rather than guess a document's page count up front (which would require downloading it, defeating the
whole point of the S3-reference design above), this file:

1. Checks size first: anything **over 10MB** (`SYNC_MAX_BYTES`) skips the sync attempt entirely and
   goes straight to the async job API (a doomed sync call would just waste a round trip).
2. Otherwise tries sync FIRST. If Textract itself reports `UnsupportedDocumentException`, the SAME
   document is retried via the async job API. Any OTHER sync failure is a genuine per-document problem
   and is not retried via async (a truly corrupt file fails the same way either path).
3. The async path polls `GetDocumentTextDetection` (3s interval, up to 100 attempts = 5 minutes per
   document) until `JobStatus` is `SUCCEEDED`/`PARTIAL_SUCCESS` (or `FAILED`, which is a per-document
   failure), following `NextToken` to collect every page of RESULTS for a large document.

Every async job is submitted with a **deterministic `ClientRequestToken`** (a sha256 of `bucket/key` plus the object's listed size and `LastModified`, so an overwritten file gets its own token),
so if this process crashes mid-poll, a later run of the SAME still-sidecar-less document reuses the
in-flight or completed job instead of starting and billing a duplicate -- **within Textract's
idempotency window, which AWS documents as 7 days**. A re-run more than 7 days after a crash
re-submits (and re-bills) any document that still has no sidecar. That is accepted: the schedule runs
far more often than weekly, and the `_TEXT/` sidecar, not the token, is the durable marker of
record; no job state is persisted anywhere else on purpose.

## Fail-open vs fail-loud (the real behavior change from the old sweep)

The old sweep only ever fail-opened -- any per-document error was logged and the run moved on, exiting
0 regardless of how much of the backlog actually got processed. This version draws an explicit line:

- **Fail OPEN** (log, count, continue; the run still exits 0): a corrupt file, a genuinely unsupported
  format despite its extension, a Textract job that failed on its OWN content, a document that timed
  out polling. Business as usual for a room full of real-world scanned paperwork.
- **Fail LOUD** (abort the whole run immediately; non-zero exit; a clear stderr line naming the cause):
  - **Missing IAM permission** -- an `AccessDeniedException`/`UnrecognizedClientException`/etc. from
    Textract, or a 403 from S3. Every other document in the run would fail identically; there is no
    point grinding through the rest of the backlog to report the same failure hundreds of times.
  - **Missing bucket** -- the configured room's (account, container) has no row in
    `skills/kb-memory/s3-blob.mjs`'s MIRROR table. Checked BEFORE any network call.
  - **Unreachable Textract** -- a real network-level failure reaching the Textract endpoint at all
    (`status:0` from `awsFetch()`, its documented never-throws contract for exactly this case).
  - **A run that OCR'd zero files because none needed it** is explicitly reported as success (`"No
    documents need OCR -- every eligible file ... already has a _TEXT/ sidecar"`), never silence.

## Budget caps (env, or the matching `runSweep()` option)

| env | default | meaning |
|---|---|---|
| `MAX_PAGES` | `500` | cumulative Textract pages counted this run (~$0.75 at $1.50/1,000 pages). As of 2026-09-03 (`FND-20260903-43c9`) each worker **reserves** a document's cost the instant it claims it -- synchronously, before the Textract call that would reveal the real page count -- so the DISPATCH decision is a hard, race-free cap: no concurrent worker's check can ever be stale by more than one already-reserved document. What can still exceed `MAX_PAGES` is the CUMULATIVE total once those reservations are trued up: a document's true page count is unknown until Textract responds (the async API has no "stop after N pages" primitive and accepts up to 3,000 pages per document), so up to `CONC` documents can be reserved-but-not-yet-realized at once, each processed in full, giving a hard worst case of `MAX_PAGES + CONC x 3000` pages (~$14.25 at the defaults); typical scanned letters and invoices stay near the cap. Every attempted document is counted: real pages on success or on a failed sidecar write, a one-page floor when Textract reported nothing. |
| `MAX_DOCS_PER_RUN` | `500` | doc-count HARD cap, independent of the page budget. As of 2026-09-03 (`FND-20260903-43c9`) this is enforced by the SAME dispatch-time reservation as `MAX_PAGES` above, but for docs it is exact rather than a floor (a document always costs exactly 1, known up front): no more than this many documents are EVER dispatched in one run, regardless of `CONC`. Before that fix, a live run with `MAX_DOCS_PER_RUN=5`/`CONC=2` processed 6 documents, because the check only looked at COMPLETED work and could not see what a sibling worker had already claimed. Legacy alias: `LIMIT`. |
| `MAX_MB` | `200` | any file over this size is skipped ENTIRELY, before any Textract call (a cost/sanity ceiling, comfortably under Textract's own 500MB async hard limit). |
| `CONC` | `3` | worker concurrency. Workers stagger their first Textract call by 750ms each (the 2026-08-01 throttle-storm fix, carried forward from the Azure-era version) and back off with jitter on a retryable error. |
| `STORES` | `legal,cfo` | which rooms to scan this run, comma-separated (`legal`, `cfo`, or both). |
| `DRYRUN` | unset | `1` reports the scope (candidate count per room) and exits without OCR-ing or writing anything. |

`node skills/ocr-sweep/sweep.mjs` runs with these defaults. No Secret Manager / Key Vault credential
is read by this file.

## Region

Textract only reads an `S3Object` from a bucket in the SAME region as the Textract endpoint it is
called on. The sweep calls `textract.<AWS_REGION>.amazonaws.com` (default `us-east-1`), and all three
buckets the MIRROR table maps these rooms to (`otchealth-finance-legal-dr-55c84f6b`,
`otchealth-legal-personal-dr-55c84f6b`, and the commons `otchealth-brain-dr-55c84f6b`) are in
`us-east-1` (verified 2026-09-03 with `aws s3api get-bucket-location`, `LocationConstraint` null).
If a room is ever mirrored to a bucket in another region, run the sweep with `AWS_REGION` set to
that bucket's region; there is no per-bucket region derivation in the code on purpose, because
today there is exactly one region.

## IAM the job role needs (this skill does not touch IAM itself)

Live state, verified with `aws iam list-role-policies` / `get-role-policy` on 2026-09-03:
`otchealthTaskRole` carries inline policy `textract-ocr-sweep` (exactly the three Textract actions
below, granted 2026-09-03) and, in `runtime-access`, bucket-wide `s3:GetObject`/`PutObject`/
`ListBucket` on both target buckets. So NOTHING below is a missing grant today; the prefix-scoped
shape is the least-privilege target for a future dedicated job role.

Three Textract actions, plus S3 read+write scoped to exactly the room prefixes this sweep touches
(never a bucket-wide grant -- `otchealth-finance-legal-dr-55c84f6b` also holds `exec`,
`cro-from-the-chair`, and `innd-stock` prefixes this job has no business reading or writing):

```
textract:DetectDocumentText
textract:StartDocumentTextDetection
textract:GetDocumentTextDetection
```

S3 (per AWS's own Textract IAM guidance: the CALLING identity needs GetObject/PutObject even though
Textract's service does the actual byte transfer on your behalf):

- Bucket `otchealth-finance-legal-dr-55c84f6b` (holds `legal/company` AND `cfo/cfo-source-docs`):
  - `s3:GetObject` + `s3:PutObject` on
    `arn:aws:s3:::otchealth-finance-legal-dr-55c84f6b/otchealthlegalstore/company/*`
  - `s3:GetObject` + `s3:PutObject` on
    `arn:aws:s3:::otchealth-finance-legal-dr-55c84f6b/otchealthcfodata/cfo-source-docs/*`
  - `s3:ListBucket` on `arn:aws:s3:::otchealth-finance-legal-dr-55c84f6b` -- **this is a
    BUCKET-level permission**, not covered by the object-level grants above; scope it with an
    `s3:prefix` `StringLike` condition to `otchealthlegalstore/company/*` and
    `otchealthcfodata/cfo-source-docs/*` so listing the room does not also expose neighboring
    prefixes in the same bucket.
- Bucket `otchealth-legal-personal-dr-55c84f6b` (`legal/personal` -- **ring-sensitive**): the job role
  ALREADY holds `s3:GetObject` + `s3:PutObject` + `s3:ListBucket` on this bucket (`otchealthTaskRole`
  inline policy `runtime-access`, statement `PersonalLegalRingReadWrite`, verified live with
  `aws iam get-role-policy` on 2026-09-03), so no new grant is needed and sidecars are written there
  like any other room. A sidecar is the document's own extracted text and never leaves the bucket.
  If that statement is ever removed, the sweep will 403 on the first personal sidecar write and abort
  the run loud (fail-loud by design); the code has no container-level selector, so the fix is the
  grant, not a schedule split.

## Re-arming the schedule

The EventBridge schedule for `otchealth-docintel-ocr-sweep` is currently DISABLED. Re-arming it is a
CTO/IAM action, not something this skill does:

1. Grant the IAM policy above to the job's task role.
2. Update the task definition's environment: the old `azure-docintel-endpoint`/`azure-docintel-key`/
   `azure-legal-storage-key`/`azure-cfo-storage-account`/`azure-cfo-storage-key` secret references are
   gone from this file and can be removed from the task def; nothing replaces them (IAM is the only
   credential). `MAX_DOCS_PER_RUN`/`MAX_PAGES`/`MAX_MB`/`CONC`/`STORES` are the only env knobs, all
   optional (sensible defaults above). `LIMIT` still works as a legacy alias for `MAX_DOCS_PER_RUN`.
2. Confirm `doc-indexer:latest` is unaffected (this file lives in `skills/ocr-sweep/`, a separate
   image/job from `doc-indexer`).
3. Enable the schedule; watch the first run's log line (`[ocr-sweep] DONE this run: ...` or a FAILED
   line naming the exact missing permission/resource).

## Testing

`tests/ocr-sweep.test.mjs` -- pure-function tests for selection, sidecar-path shape, routing/budget
decisions, and Textract-error classification (no network), plus stubbed-`fetch` integration tests of
`runSweep()` itself covering sync success, sync-to-async fallback on a multi-page document, an
over-10MB document routing straight to async, page-cap and doc-cap enforcement under BOTH `CONC:1`
(sequential) and `CONC:2` (concurrent, gated releases proving the dispatch-time reservation is a real
hard cap -- the `FND-20260903-43c9` regression case), an oversize file never reaching Textract, a
per-document failure staying fail-open, and the three fail-loud cases (AccessDenied,
network-unreachable, an S3 write 403 on a ring-gated room). No test contacts a real AWS endpoint.
