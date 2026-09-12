# CFO OCR version-receipt engineering report, 2026-09-12

## Scope and boundary

This report covers only the pending source changes in this worktree and the checked
orchestration commit `928398ac51721aa645f4273c6200b237bc2fdfd2` in
`C:\wt\cto-ocr-repair-oneoff`. It contains no source documents, object keys from a
real store, secret values, AWS responses, or Textract calls.

## Implementation review and repairs

The pending OCR worker change now supplies an opt-in version-bound CFO path.

* The candidate manifest is read from the CFO room, SHA-256 checked against the
  supplied authorization value, parsed as an explicit eligible candidate set, and
  must exactly match the current eligible objects missing sidecars.
* A version-bound candidate is HEADed before work. A missing S3 VersionId fails the
  run before any Textract request.
* PDFs are fetched by `GetObject?versionId=<exactVersionId>` to a private temporary
  file for `pdfinfo`, then deleted. The positive page count is obtained before any
  paid OCR request. Images have a fixed one-page preflight.
* The exact preflight count is synchronously reserved against the aggregate page
  budget. This corrected an earlier pending implementation that performed the
  preflight gate but then reserved the legacy one-page estimate. This is a
  dispatch cap, not a billing guarantee: a later Textract count disagreement is
  detected after the paid call, counted accurately, and withholds the sidecar.
* The Textract S3 object reference uses the actual S3 VersionId only in version-bound
  mode. A separate idempotency value preserves legacy listing-based token behavior;
  it is never sent as an invalid S3 Version field.
* Source VersionId is checked again after Textract and before a sidecar write. The
  sidecar write result now preserves its S3 VersionId so the receipt can bind source
  version, page count, sidecar name, and sidecar version.
* The worker writes a receipt only when the explicit receipt path is configured,
  with conditional create semantics. It returns only receipt metadata to the caller.

## Offline evidence

Command executed from `C:\wt\claude-tools-cfo-ocr-version-receipt`:

```text
node --test tests/ocr-sweep.test.mjs
```

Result: 46 passed, 0 failed, 0 skipped. The tests use only synthetic S3/Textract
responses. Added coverage verifies manifest SHA validation, VersionId on Textract
input, receipt binding, `GetObject` VersionId query construction, and strict
`pdfinfo` page parsing. `git diff --check` also passed.

## Orchestration review

The one-off workflow at commit `928398ac51721aa645f4273c6200b237bc2fdfd2` remains
execution-blocked by its checked-in empty approved-image allow-list. This is a safe
gate. Its currently generated task environment does not set the version-bound worker
switch, candidate-manifest path/SHA, or receipt path. It therefore cannot claim this
source-version receipt behavior until a separate reviewed workflow change supplies
those immutable inputs and the corresponding narrow IAM authorization is verified.
Its execution artifact must describe the maximum as a preflight dispatch cap, not a
hard Textract billing cap.

No AWS, ECS, S3, or Textract operation was invoked for this report.
