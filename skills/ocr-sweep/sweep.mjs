#!/usr/bin/env node
// ocr-sweep -- STANDING auto-OCR for the legal + financial S3 data rooms, so the CFO/CLO always have
// a full text layer (_TEXT/ sidecars) for EVERY scanned PDF/image. Backfills + self-maintains.
//
// FOR EACH CONFIGURED ROOM/CONTAINER: list objects (via skills/kb-memory/s3-blob.mjs, the SAME S3
// mirror layer skills/doc-indexer/indexer.mjs uses -- one bucket-mapping table, two readers), find
// PDFs/images that lack a sidecar at _TEXT/<name>.txt (the SAME shape indexer.mjs's own
// TEXT_PREFIX + path + ".txt" convention writes, so nothing downstream changes), OCR up to the
// configured page/doc/size budget via Amazon Textract, and write the sidecar. Resumable + idempotent
// (a written sidecar is next run's "already done" marker -- no separate marker file/DB needed).
// FAIL-OPEN per document (a corrupt/unsupported file does not stop the run); FAIL LOUD for anything
// that means the PIPELINE itself is broken (missing IAM permission, an unmapped/misconfigured room, an
// unreachable Textract endpoint) -- see "FAIL-LOUD DESIGN" below. Bounded per run so it fits a
// scheduled job; re-runs drain the backlog, then steady-state only touches new uploads.
//
// -----------------------------------------------------------------------------------------------
// WHY THIS IS A REWRITE, NOT A REPOINT (2026-09-03). The prior version of this file was hardcoded to
// Azure Document Intelligence (prebuilt-read) + Azure Blob SAS tokens, both permanently gone since the
// Azure subscription 55c84f6b-ef90-4259-a58b-50835cc4cab4 was deleted 2026-08-13 (see otchealth-cto's
// CLAUDE.md and otchealth-claude-tools' CLAUDE.md "Azure is permanently gone" corrections). The job's
// EventBridge schedule (`otchealth-docintel-ocr-sweep`) has been DISABLED the whole time, so no scanned
// PDF or image in the legal/CFO rooms has been OCR'd since the Azure loss -- this is the fix.
//
// Amazon Textract (DetectDocumentText / StartDocumentTextDetection / GetDocumentTextDetection) is the
// chosen replacement (see the 2026-09-03 fleet audit, L4-aws-ai.md item C1): $1.50 per 1,000 pages,
// runs in our OWN AWS account against the SAME S3 buckets the source documents already live in.
//
// THE ARCHITECTURE IS SIMPLER THAN THE OLD ONE, NOT JUST A PORT. The old sweep downloaded every whole
// file into process memory (a SAS GET) before POSTing its bytes to Document Intelligence, which is
// exactly the pattern that OOM-killed the doc-indexer container before its own MAX_INDEX_MB guard
// existed. Textract's API accepts a `Document.S3Object: {Bucket, Name}` REFERENCE for both the sync
// and async operations -- Textract's OWN service fetches the bytes; this process never buffers a
// document at all. That removes the OOM class entirely and means the IAM grant this job needs is
// `s3:GetObject`/`s3:ListBucket`/`s3:PutObject` on the room prefixes (see SKILL.md), NOT a Secret
// Manager credential -- there is no more azure-docintel-endpoint/-key, azure-legal-storage-key, or
// azure-cfo-storage-account/-key dependency in this file at all. Credentials resolve the same way
// every other AWS-native skill in this toolkit does: the ECS task role (or env fallback) via
// skills/kb-memory/aws-secret.mjs's awsCreds(), reached here through TWO already-audited, already-
// tested callers rather than a third hand-rolled SigV4 implementation (FND-20260828-5ca1): S3 calls go
// through skills/kb-memory/s3-blob.mjs (list/put), Textract calls go through
// ../../setup/aws-sigv4.mjs's awsFetch() (the shared non-S3 SigV4 signer this toolkit consolidated
// onto 2026-09-02).
//
// SYNC VS ASYNC ROUTING. Textract's synchronous DetectDocumentText only accepts a document up to 10MB
// (S3Object mode) and ONLY the first page of a multi-page PDF/TIFF -- feeding it a genuinely
// multi-page document raises `UnsupportedDocumentException` (AWS re:Post, confirmed 2026-09-03: "The
// Synchronous APIs of AWS Textract only support single-page documents... you'll encounter the
// UnsupportedDocumentException error"; StartDocumentTextDetection/GetDocumentTextDetection accept the
// SAME formats -- JPEG, PNG, PDF, TIFF -- up to Textract's 3,000-page async ceiling). Rather than guess a document's page
// count up front (which would need downloading it, defeating the whole point of the S3Object-reference
// design above), this file ALWAYS tries the fast/cheap sync path first for anything under the 10MB
// limit, and falls back to the async job API ONLY when Textract itself reports the document does not
// fit sync (see classifyTextractFailure()'s ROUTE_ASYNC_TYPES). This is simpler and strictly more
// correct than a heuristic: Textract's own answer is authoritative, a byte-scan guess would not be.
//
// FAIL-LOUD DESIGN (the real behavior change from the old sweep, which only ever fail-opened). A
// per-document problem (a corrupt file, an unsupported format despite its extension, a Textract job
// that failed on ITS content) is business as usual for a room full of real-world scanned paperwork --
// it is logged, counted, and the run moves on, exiting 0. A SYSTEMIC problem -- AccessDenied on either
// Textract or S3 (missing IAM grant), an unmapped account/container (no row in s3-blob.mjs's MIRROR
// table -- "missing bucket"), or a network-level failure reaching Textract at all ("unreachable") --
// means the WHOLE PIPELINE is broken, not one file, and every other document would fail identically.
// classifyTextractFailure() and isSystemicS3Error() draw that line; runSweep() aborts the moment either
// side reports one, exits non-zero, and prints exactly which permission/resource is implicated, rather
// than the old class of bug this toolkit has hit before: an API call that "succeeds" doing nothing
// (see otchealth-claude-tools CLAUDE.md's "RunTask succeeded and the task did something are different
// claims" lesson) or a job that reports 0 processed and exits 0 with no explanation why.
//
// COST/BUDGET CAPS. MAX_DOCS_PER_RUN (default 500, legacy env alias LIMIT) is a HARD doc-count cap:
// no more than this many documents are EVER dispatched in one run, independent of CONC. MAX_PAGES
// (default 500, ~$0.75 at Textract's $1.50 per 1,000 pages) bounds CUMULATIVE Textract pages counted
// across a whole run. Both are enforced by withinBudget() checked before each NEW document is
// dispatched, AND -- as of 2026-09-03 (FND-20260903-43c9) -- by a RESERVATION the worker loop makes
// synchronously the instant it claims a candidate, before the (possibly slow) Textract call even
// starts (see reservedPageEstimate() and the worker loop's "RESERVE"/"RELEASE" comments). Before that
// reservation existed, withinBudget() was checked against ONLY completed work, so up to CONC-1 other
// documents already claimed by sibling workers but not yet finished were invisible to it -- a live
// run with MAX_DOCS_PER_RUN=5/CONC=2 processed 6 documents this way. Reserving at claim time (rather
// than counting only at completion) closes that race for BOTH caps, because the check-then-reserve
// step is synchronous with no `await` in between, so no concurrent worker's check can ever be stale
// by more than the ONE document each already reserves. For MAX_DOCS_PER_RUN this makes the cap
// EXACT: a document costs exactly 1, known up front, so the reservation IS the true cost and the cap
// can never be exceeded. For MAX_PAGES the DISPATCH decision is equally race-free, but the true page
// count of an in-flight document is still unknowable until Textract responds (the async API has no
// "stop after N pages" primitive and accepts up to 3,000 pages per document), so the reservation is
// only a conservative one-page floor per in-flight document -- meaning the CUMULATIVE pagesUsed total
// can still finish a run above MAX_PAGES once those floors are trued up to their real counts. The
// bound on that residual overshoot is UNCHANGED from before this fix (it was never the race, it is
// the "page count unknown pre-call" design tradeoff, see the SYNC VS ASYNC ROUTING note above for why
// this file never downloads a document just to count its pages first): up to CONC documents can be
// reserved-but-not-yet-realized at once, each processed in full once dispatched, so the hard worst
// case for one run is MAX_PAGES + CONC x 3,000 pages (~$14.25 at the defaults), while a typical run of
// scanned letters and invoices stays near MAX_PAGES. Pages are counted for every ATTEMPTED document:
// the real count on success, the real count when a sidecar write fails after a successful OCR, and a
// one-page floor when Textract itself failed and reported nothing -- so a run full of failures still
// exhausts its budget instead of looping on free retries. MAX_MB (default 200, matching the old
// sweep's OOM-guard default, though the reason has changed: it is now a cost/sanity ceiling, not an
// OOM guard, since nothing is ever buffered into memory) skips a file entirely before any Textract
// call, and separately, ANY file over Textract's own 10MB sync limit routes straight to the async path
// without wasting a doomed sync attempt (preferSync()).
//
// IDEMPOTENCY, TWO LAYERS. (1) The sidecar itself is the DURABLE completion marker -- selectCandidates()
// skips any document whose _TEXT/<name>.txt already exists, so a re-run only ever touches new/failed
// uploads, exactly like the old sweep. (2) Every async job is submitted with a DETERMINISTIC
// ClientRequestToken (sha256 of "bucket/key" plus the object's listed size and LastModified, so an overwritten file gets its own token), so if this process crashes mid-poll and a later run
// picks the same still-sidecar-less document back up within Textract's idempotency window, Textract
// returns the SAME in-flight/completed JobId instead of starting (and billing) a duplicate job. That
// window is TIME-BOUNDED: AWS documents ClientRequestToken idempotency for 7 days. A re-run more than
// 7 days after a crash re-submits (and re-bills) any document that still has no sidecar -- accepted,
// because the schedule runs far more often than that and the sidecar, not the token, is the marker
// of record; no job state is persisted anywhere else on purpose.
//
// PHI WALL (unchanged): only the legal + cfo (finance) rooms -- NEVER MedReview/Companion (no BAA).
// RING NOTE: the `legal/personal` container is attorney-privileged. Its S3 read+write grant to the
// job role (`PersonalLegalRingReadWrite` on otchealthTaskRole) is LIVE as of 2026-09-03 (verified
// with `aws iam get-role-policy`), so sidecars there are written like any other room's; a sidecar is
// the document's own extracted text and stays inside the same ring-gated bucket. This file does not
// special-case the room -- ring policy is an IAM decision, and an AccessDenied there would (correctly)
// abort the run loud rather than silently skip it.
//
// Run: node sweep.mjs   (env MAX_DOCS_PER_RUN [legacy alias: LIMIT], MAX_PAGES, MAX_MB, CONC, DRYRUN,
// STORES). No Secret Manager / Key Vault credential is read by this file.
// -----------------------------------------------------------------------------------------------
import crypto from "node:crypto";
import { awsFetch } from "../../setup/aws-sigv4.mjs";
import { listBlobsMetaFromS3, putObjectToS3, s3LocationFor, s3Configured } from "../kb-memory/s3-blob.mjs";

const REGION = process.env.AWS_REGION || "us-east-1";

// ---- rooms this sweep is allowed to touch (PHI wall: legal + cfo ONLY) --------------------------
// Account/container strings match skills/doc-indexer/indexer.mjs's own `finance`/`legal` PROFILES
// exactly (its azAccount/azContainer defaults), which in turn are the exact keys
// skills/kb-memory/s3-blob.mjs's MIRROR table maps to a real (bucket, keyPrefix). Getting any of
// these three strings wrong would not silently mis-file documents -- s3LocationFor() (via
// preflightRooms(), below) fails loud with "no S3 mirror mapping" before a single network call.
export const ROOMS = Object.freeze({
  legal: { name: "legal", account: "otchealthlegalstore", containers: ["company", "personal"] },
  cfo: { name: "cfo", account: "otchealthcfodata", containers: ["cfo-source-docs"] },
});

// Textract-eligible formats ONLY: JPEG, PNG, PDF, TIFF (confirmed 2026-09-03 against AWS's own
// StartDocumentTextDetection documentation). This is NARROWER than the old sweep's DOCEXT, which also
// matched docx/xlsx/pptx -- Azure Document Intelligence's prebuilt-read model could read Office
// formats directly; Textract has no equivalent. Those formats are not "scanned" documents needing OCR
// in the first place -- skills/doc-indexer/indexer.mjs's own LibreOffice-based extraction already
// handles them on its own text-extraction path, independent of this sweep. Dropping them here is a
// deliberate, documented scope narrowing, not an oversight.
const DOC_EXT_RE = /\.(pdf|png|jpe?g|tiff?)$/i;

// Never OCR our own artifacts. Mirrors the subset of indexer.mjs's SKIP_PREFIXES that is relevant to
// the legal/cfo rooms this file touches (commons-only prefixes like _MEMORY/ are omitted -- they can
// never appear under either room, so listing them here would only be misleading noise).
const SKIP_TOP_PREFIXES = ["_TEXT/", "_CATALOG/", "_TRASH/", "_ARCHIVE/", "_DUPLICATES/", "_NON-ACCOUNTING/"];

// Textract's own synchronous DetectDocumentText hard limit for an S3Object input (10MB). Anything
// larger is routed straight to the async job API -- trying sync first would just be a doomed,
// wasted call (Textract would reject it before ever looking at page count).
export const SYNC_MAX_BYTES = 10 * 1024 * 1024;

// ============================ pure helpers (unit-tested with no network at all) ============================

/** The sidecar path for a source object name, relative to its own container -- matches
 *  skills/doc-indexer/indexer.mjs's TEXT_PREFIX + name + ".txt" convention EXACTLY (a single
 *  top-level `_TEXT/` prefix mirroring the whole tree beneath it), so a sidecar this sweep writes and
 *  a sidecar the indexer's own OCR path writes land in the identical location and neither ever
 *  re-does the other's work. NOTE this is a DELIBERATE shape change from the pre-2026-08 Azure-era
 *  sweep, which nested a `_TEXT/` directory inside EVERY subdirectory (`dir/_TEXT/base.ext.txt`) --
 *  that shape predates, and does not match, what the indexer actually reads/writes today. */
export function sideFor(name) {
  return `_TEXT/${name}.txt`;
}

/** True for an object already living under this sweep's own `_TEXT/` sidecar tree. */
export function isSidecarName(name) {
  return typeof name === "string" && name.startsWith("_TEXT/") && name.toLowerCase().endsWith(".txt");
}

/** True for a source document this sweep should ever consider OCR-ing (right extension, not one of
 *  our own artifact prefixes). Does NOT check whether a sidecar already exists -- see
 *  selectCandidates() for the full "needs OCR" decision. */
export function isEligibleDocName(name) {
  if (typeof name !== "string" || !name) return false;
  if (!DOC_EXT_RE.test(name)) return false;
  for (const p of SKIP_TOP_PREFIXES) if (name.startsWith(p)) return false;
  return true;
}

/** Given every object name in a container's listing (or, for a smaller/synthetic test, just the
 *  relevant subset) and OPTIONALLY a pre-built lowercase set of existing sidecar names, return the
 *  list of source-document names that still need OCR. When `existingSidecarLowerSet` is omitted it is
 *  derived from `names` itself (the normal, whole-listing call site); a caller that already isolated
 *  the sidecar set (e.g. to avoid recomputing it once per container) can pass it directly. Matching is
 *  case-insensitive on the SIDECAR side only (mirrors the old sweep's `.toLowerCase()` guard against
 *  a source/sidecar casing mismatch) -- the returned candidate names retain their original casing. */
export function selectCandidates(names, existingSidecarLowerSet) {
  const sidecars = existingSidecarLowerSet || new Set(names.filter(isSidecarName).map((n) => n.toLowerCase()));
  return names.filter((n) => isEligibleDocName(n) && !sidecars.has(sideFor(n).toLowerCase()));
}

/** Whether to attempt the synchronous DetectDocumentText call for a document of this size. Defaults
 *  to true (attempt sync) for an unknown/zero/negative size -- the common case is a real number under
 *  the limit, and defaulting the OTHER way would needlessly slow-path every object whose size failed
 *  to parse for some unrelated reason. Only a size we POSITIVELY know exceeds Textract's 10MB
 *  S3Object sync limit routes straight to async. */
export function preferSync(sizeBytes) {
  return !(typeof sizeBytes === "number" && Number.isFinite(sizeBytes) && sizeBytes > SYNC_MAX_BYTES);
}

/** Total page count Textract billed/processed for one DetectDocumentText or
 *  GetDocumentTextDetection response. Prefers the authoritative `DocumentMetadata.Pages` field;
 *  falls back to counting `BlockType:"PAGE"` blocks (covers a hypothetical response shape without
 *  DocumentMetadata); falls back to 1 (never 0 -- every real response processed at least one page). */
export function pageCountOf(json) {
  const meta = json && json.DocumentMetadata && Number.isFinite(json.DocumentMetadata.Pages) ? json.DocumentMetadata.Pages : null;
  if (meta) return meta;
  if (Array.isArray(json && json.Blocks)) {
    const n = json.Blocks.filter((b) => b && b.BlockType === "PAGE").length;
    if (n > 0) return n;
  }
  return 1;
}

/** Reassemble a plain-text sidecar body from Textract's Blocks array: every LINE block's Text,
 *  grouped by page (the `Page` field Textract attaches to multi-page async results; absent/undefined
 *  defaults to page 1, correct for every synchronous response), pages in ascending order, LINEs within
 *  a page kept in Textract's own emitted order (already reading order), pages separated by a blank
 *  line. This is the closest plain-text equivalent to the old Azure Document Intelligence
 *  `analyzeResult.content` field this sweep used to persist verbatim -- Textract has no single
 *  pre-assembled "whole document text" field, so this sweep assembles one. */
export function blocksToText(blocks) {
  if (!Array.isArray(blocks)) return "";
  const byPage = new Map();
  for (const b of blocks) {
    if (!b || b.BlockType !== "LINE" || typeof b.Text !== "string") continue;
    const page = Number.isFinite(b.Page) ? b.Page : 1;
    if (!byPage.has(page)) byPage.set(page, []);
    byPage.get(page).push(b.Text);
  }
  const pages = [...byPage.keys()].sort((a, b) => a - b);
  return pages.map((p) => byPage.get(p).join("\n")).join("\n\n");
}

/** AWS JSON-protocol error responses carry the exception name in `__type`, sometimes prefixed with a
 *  namespace ("com.amazonaws.textract#UnsupportedDocumentException", sometimes just
 *  "UnsupportedDocumentException" -- both observed across AWS services). Returns just the bare
 *  exception name, or null when the body carries no `__type`/`code`/`Code` field at all. */
export function extractExceptionType(json) {
  const raw = json && (json.__type || json.code || json.Code);
  if (!raw) return null;
  const s = String(raw);
  const hash = s.lastIndexOf("#");
  return hash >= 0 ? s.slice(hash + 1) : s;
}

// AccessDenied/credential/signature-class failures: the calling identity itself is the problem, and
// every subsequent Textract call in this run would fail identically. Confirmed 2026-09-03 against
// AWS's Service Authorization Reference: Textract documents AccessDeniedException as a possible error
// on every operation this file calls. The remaining names are the general AWS-JSON-protocol auth
// failure family (a bad/expired/malformed credential never reaches Textract's own business logic).
const SYSTEMIC_TEXTRACT_TYPES = new Set([
  "AccessDeniedException",
  "UnrecognizedClientException",
  "InvalidSignatureException",
  "ExpiredTokenException",
  "InvalidClientTokenId",
  "MissingAuthenticationTokenException",
  "IncompleteSignature",
]);
// Confirmed 2026-09-03 (AWS re:Post): synchronous DetectDocumentText raises exactly this exception
// for a document it cannot process synchronously (the multi-page case this file exists to route
// around). Kept as its own named set (rather than folded into "systemic" or "per-doc") because it is
// the one failure class that means "try again a different way", not "give up" or "abort everything".
const ROUTE_ASYNC_TYPES = new Set(["UnsupportedDocumentException"]);
// Confirmed 2026-09-03 (AWS docs + a live-quoted error body): both throttling exception names return
// HTTP 400, not 429 -- classification here keys off `__type`, never off status code, for exactly that
// reason. LimitExceededException (too many concurrent async jobs on the account) is the same shape of
// "try again shortly", not a permission or content problem.
const RETRYABLE_TEXTRACT_TYPES = new Set([
  "ThrottlingException",
  "ProvisionedThroughputExceededException",
  "LimitExceededException",
  "InternalServerError",
  "ServiceUnavailableException",
  "ServiceUnavailable",
]);

/** Classify one Textract API response (the exact `{status, json, reason}` shape
 *  ../../setup/aws-sigv4.mjs's awsFetch() returns) into what the CALLER should do next:
 *    "systemic"    -- abort the whole run; every other document would fail identically
 *                     (AccessDenied/bad-credential, or status:0 meaning the request never got a
 *                     response at all -- Textract unreachable, per awsFetch()'s own documented
 *                     never-throws contract).
 *    "route-async" -- this ONE document should be retried via the async job API, not treated as a
 *                     failure yet.
 *    "retryable"   -- a transient condition (throttling, a 5xx); the caller should back off and try
 *                     the SAME call again, same document, same operation.
 *    "per-doc"     -- a genuine, specific-to-this-document failure (corrupt file, truly unsupported
 *                     format, bad parameters); log it, count it, move on to the next document.
 *  Never throws. */
export function classifyTextractFailure({ status, json, reason }) {
  if (status === 0) return { kind: "systemic", type: "network-unreachable", message: `Textract unreachable: ${reason || "no response"}` };
  const type = extractExceptionType(json);
  const message = (json && (json.Message || json.message)) || reason || `HTTP ${status}`;
  if (type && SYSTEMIC_TEXTRACT_TYPES.has(type)) return { kind: "systemic", type, message };
  if (!type && (status === 401 || status === 403)) return { kind: "systemic", type: `http-${status}`, message };
  if (type && ROUTE_ASYNC_TYPES.has(type)) return { kind: "route-async", type, message };
  if (type && RETRYABLE_TEXTRACT_TYPES.has(type)) return { kind: "retryable", type, message };
  if (typeof status === "number" && status >= 500) return { kind: "retryable", type: type || `http-${status}`, message };
  return { kind: "per-doc", type: type || `http-${status}`, message };
}

/** True when a caught Error from skills/kb-memory/s3-blob.mjs (list/put) indicates a systemic
 *  infra/permission problem rather than a one-off content issue: an explicit 403 status
 *  (putObjectToS3/deleteObjectFromS3 attach `.status`), or one of s3-blob.mjs's own documented loud
 *  failure messages -- "no S3 mirror mapping" (an unmapped/misconfigured room: this sweep's own
 *  "missing bucket" case), "AWS credentials unavailable" (no usable IAM identity at all), or the
 *  well-known S3 error codes for a bad/missing credential or an authorization failure. */
export function isSystemicS3Error(err) {
  if (!err) return false;
  if (err.status === 403) return true;
  const msg = String(err.message || "");
  return /AccessDenied|Forbidden|InvalidAccessKeyId|SignatureDoesNotMatch|no S3 mirror mapping|AWS credentials unavailable/i.test(msg);
}

/** Preflight: every (account, container) pair this run is about to touch must already have a row in
 *  skills/kb-memory/s3-blob.mjs's MIRROR table. Checked BEFORE any network call -- an unmapped room is
 *  refused with a precise, actionable message rather than surfacing later as a confusing failure deep
 *  inside a listing or a write. */
export function preflightRooms(rooms) {
  for (const room of rooms) {
    for (const container of room.containers) {
      if (!s3LocationFor(room.account, container)) {
        return {
          ok: false,
          message:
            `no S3 mirror mapping for ${room.account}/${container} in skills/kb-memory/s3-blob.mjs's ` +
            `MIRROR table -- refusing to guess a bucket. Add a verified row there before running ` +
            `ocr-sweep against this room.`,
        };
      }
    }
  }
  return { ok: true };
}

/** Whether the run should still take on ONE MORE document, given how much of the page/doc budget is
 *  already spent. 0 (for either cap) means "unlimited", matching this toolkit's established
 *  MAX_MIN/CU_MAX_MINUTES convention (skills/doc-indexer/indexer.mjs). This is checked BEFORE
 *  dispatching a new document, and (as of 2026-09-03) the worker loop reserves a document's cost
 *  against `state` synchronously the instant it is claimed -- BEFORE the Textract call that would
 *  reveal its real page count -- so a concurrent worker's next call here is never stale by more than
 *  one already-reserved document. That makes maxDocs an EXACT hard cap; maxPages' dispatch decision
 *  is equally race-free but its cumulative total can still finish a run above the cap once an
 *  in-flight document's true (still-unknown-at-reservation-time) page count is realized -- see this
 *  file's header "COST/BUDGET CAPS" note for the exact bound and reservedPageEstimate() for the
 *  reservation itself. */
export function withinBudget(state, caps) {
  if (caps.maxDocs > 0 && state.docsUsed >= caps.maxDocs) return false;
  if (caps.maxPages > 0 && state.pagesUsed >= caps.maxPages) return false;
  return true;
}

/** Conservative page-count RESERVATION for a document not yet OCR'd -- what the worker loop charges
 *  against `state.pagesUsed` at DISPATCH time, before the Textract call that would reveal the real
 *  count. This is what makes MAX_PAGES a hard cap under concurrency: reserving here (synchronously,
 *  in the same tick as the MAX_DOCS_PER_RUN reservation) means a concurrent worker's withinBudget()
 *  check can never be stale by more than this one document, closing the same race that let
 *  MAX_DOCS_PER_RUN be exceeded (see the worker loop's "RESERVE" comment, FND-20260903-43c9). Floors
 *  to 1 (every real document has at least one page) when no page count is already known; honors a
 *  candidate's own already-known page count when present. No caller sets `knownPages` today -- the
 *  S3 listing this sweep reads (`listBlobsMetaFromS3`) carries no page-count field, so this always
 *  resolves to 1 in practice -- but the reservation should not have to change if a future listing
 *  source ever does carry one. The real value the worker loop trues this up to once Textract responds
 *  can still be much larger (up to Textract's own 3,000-page async ceiling), which is why MAX_PAGES'
 *  cumulative total can still finish a run above the cap even though dispatch itself is now race-free
 *  -- see this file's header "COST/BUDGET CAPS" note and SKILL.md's budget-cap table. */
export function reservedPageEstimate(candidate) {
  return candidate && Number.isFinite(candidate.knownPages) && candidate.knownPages > 0 ? candidate.knownPages : 1;
}

/** A deterministic Textract ClientRequestToken for one (bucket, key) -- a 64-hex-char sha256 digest of bucket/key plus the object version,
 *  which fits Textract's ClientRequestToken constraints (max 64 chars, `[A-Za-z0-9-_]`) with no
 *  truncation. Reusing the SAME token across runs for the SAME still-unfinished document means a
 *  crash-and-resume never double-submits (and double-bills) an async job for the same file -- see
 *  this file's header "IDEMPOTENCY, TWO LAYERS" note. */
/** `version` is the object's `${size}:${lastModified}` from the S3 listing. Hashing it in makes the
 *  token specific to THIS version of the object: a file overwritten at the same key while still
 *  sidecar-less (inside Textract's 7-day idempotency window) gets a new token and a new job, instead
 *  of Textract handing back the job -- and the text -- of the previous bytes. Omitted/empty version
 *  keeps the bare bucket/key token (the unit tests' pure-helper cases). */
export function clientRequestToken(bucket, key, version = "") {
  return crypto.createHash("sha256").update(`${bucket}/${key}#${version}`).digest("hex");
}

export function textractUrl(region) {
  return `https://textract.${region}.amazonaws.com/`;
}

// ============================ test-only timing overrides ============================
// Mirrors skills/kb-memory/s3-blob.mjs's `_resetCredsCacheForTests()` convention: a narrow, clearly-
// named escape hatch so a test can make retry/poll loops instant, never used by real (non-test) code.
let _sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let POLL_INTERVAL_MS = 3000;
let MAX_POLL_ATTEMPTS = 100; // 100 * 3000ms = 5 minutes per async job, generous for a scanned legal/financial PDF
const MAX_TEXTRACT_RETRIES = 4; // 5 total attempts per call, matching the old sweep's withRetry() budget

/** Test-only: replace the sleep implementation (e.g. an instant no-op) so retry/poll-wait tests do
 *  not actually wait in real time. Never called from non-test code. */
export function _setSleepForTests(fn) {
  _sleepImpl = fn || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
}
/** Test-only: shrink the poll interval/attempt budget for a fast, deterministic "IN_PROGRESS a few
 *  times then SUCCEEDED" test. Pass no args to restore the production defaults. Never called from
 *  non-test code. */
export function _setPollTimingForTests(intervalMs = 3000, maxAttempts = 100) {
  POLL_INTERVAL_MS = intervalMs;
  MAX_POLL_ATTEMPTS = maxAttempts;
}
function sleep(ms) {
  return _sleepImpl(ms);
}
function retryDelayMs(attempt) {
  return Math.min(30000, 500 * 2 ** attempt) + Math.floor(Math.random() * 300);
}

// ============================ Textract calls ============================

/** One signed Textract JSON-protocol call, with transient-error retry built in (RETRYABLE_TEXTRACT_TYPES,
 *  or a 5xx). Returns `{ok:true, status, json}` on success, or `{ok:false, status, json, reason, cls}`
 *  once retries are exhausted -- `cls` is classifyTextractFailure()'s own verdict, computed once here so
 *  every caller shares the identical classification instead of re-deriving it. Never throws. */
async function callTextract(action, body) {
  const url = textractUrl(REGION);
  let last;
  for (let attempt = 0; attempt <= MAX_TEXTRACT_RETRIES; attempt++) {
    const r = await awsFetch(
      url,
      { method: "POST", headers: { "Content-Type": "application/x-amz-json-1.1", "X-Amz-Target": `Textract.${action}` }, body: JSON.stringify(body) },
      { service: "textract", region: REGION }
    );
    if (typeof r.status === "number" && r.status >= 200 && r.status < 300) return { ok: true, status: r.status, json: r.json };
    const cls = classifyTextractFailure(r);
    last = { ok: false, status: r.status, json: r.json, reason: r.reason, cls };
    if (cls.kind === "retryable" && attempt < MAX_TEXTRACT_RETRIES) {
      await sleep(retryDelayMs(attempt));
      continue;
    }
    return last;
  }
  return last;
}

function taggedError(message, extra) {
  const e = new Error(message);
  return Object.assign(e, extra);
}

/** Poll an in-flight async job to completion, collecting every page of RESULTS (Textract's own
 *  NextToken -- a separate concept from "more pages of the DOCUMENT" -- paginates a large Blocks
 *  array across multiple GetDocumentTextDetection calls even after the job itself has finished). */
async function pollJob(jobId) {
  let blocks = [];
  let pages = null;
  let nextToken;
  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
    const body = nextToken ? { JobId: jobId, MaxResults: 1000, NextToken: nextToken } : { JobId: jobId, MaxResults: 1000 };
    const r = await callTextract("GetDocumentTextDetection", body);
    if (!r.ok) {
      if (r.cls.kind === "systemic") throw taggedError(r.cls.message, { systemic: true, textractType: r.cls.type });
      throw taggedError(`Textract GetDocumentTextDetection failed (${r.cls.type}): ${r.cls.message}`, { textractType: r.cls.type });
    }
    const status = r.json && r.json.JobStatus;
    if (status === "FAILED") throw taggedError(`Textract async job ${jobId} FAILED: ${(r.json && r.json.StatusMessage) || "no status message"}`, { textractType: "JobFailed" });
    if (status === "IN_PROGRESS") {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }
    // SUCCEEDED or PARTIAL_SUCCESS: collect this page of results.
    if (Array.isArray(r.json.Blocks)) blocks = blocks.concat(r.json.Blocks);
    if (pages === null) pages = pageCountOf(r.json);
    if (r.json.NextToken) {
      nextToken = r.json.NextToken;
      continue;
    }
    return { via: "async", pages: pages || 1, text: blocksToText(blocks) };
  }
  throw taggedError(`Textract async job ${jobId} did not finish within ${MAX_POLL_ATTEMPTS} polls`, { textractType: "PollTimeout" });
}

async function ocrAsync(bucket, key, version) {
  const start = await callTextract("StartDocumentTextDetection", {
    DocumentLocation: { S3Object: { Bucket: bucket, Name: key } },
    ClientRequestToken: clientRequestToken(bucket, key, version),
  });
  if (!start.ok) {
    if (start.cls.kind === "systemic") throw taggedError(start.cls.message, { systemic: true, textractType: start.cls.type });
    throw taggedError(`Textract StartDocumentTextDetection failed (${start.cls.type}): ${start.cls.message}`, { textractType: start.cls.type });
  }
  return pollJob(start.json.JobId);
}

/** OCR one document, referenced by its REAL bucket + full S3 key (the caller resolves these via
 *  s3LocationFor() -- this function never touches the "logical" account/container naming). Tries the
 *  fast synchronous path first when the size makes that plausible (preferSync()); a document Textract
 *  itself reports as sync-ineligible (ROUTE_ASYNC_TYPES) is retried once via the async job API. Any
 *  OTHER sync failure is a genuine per-document failure and is NOT retried via async (a truly corrupt
 *  or unsupported file fails the same way either path). */
async function ocrOneDocument(bucket, key, sizeBytes, version) {
  if (preferSync(sizeBytes)) {
    const sync = await callTextract("DetectDocumentText", { Document: { S3Object: { Bucket: bucket, Name: key } } });
    if (sync.ok) return { via: "sync", pages: pageCountOf(sync.json), text: blocksToText(sync.json.Blocks) };
    if (sync.cls.kind === "systemic") throw taggedError(sync.cls.message, { systemic: true, textractType: sync.cls.type });
    if (sync.cls.kind !== "route-async") throw taggedError(`Textract DetectDocumentText failed (${sync.cls.type}): ${sync.cls.message}`, { textractType: sync.cls.type });
    // fall through: Textract itself says this document needs the async path (e.g. multi-page).
  }
  return ocrAsync(bucket, key, version);
}

// ============================ orchestration ============================

function emptyCounts() {
  return { stats: {}, candidates: 0, processed: 0, okCount: 0, failCount: 0, overCount: 0, pagesUsed: 0, backlogRemaining: 0 };
}
function intOpt(v, envName, def) {
  if (v !== undefined && v !== null) return v;
  const raw = process.env[envName];
  if (raw === undefined) return def;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : def;
}

/** Run one sweep. Never calls process.exit() -- every outcome (including a systemic failure) comes
 *  back as a plain result object so this is directly unit-testable; the CLI wrapper at the bottom of
 *  this file is the only place that turns `result` into an exit code. `opts` overrides the matching
 *  env var (see this file's header for the full list); every field is optional. */
export async function runSweep(opts = {}) {
  const DRY = opts.dryRun ?? process.env.DRYRUN === "1";
  const MAX_DOCS = intOpt(opts.maxDocsPerRun, "MAX_DOCS_PER_RUN", intOpt(undefined, "LIMIT", 500));
  const MAX_PAGES = intOpt(opts.maxPages, "MAX_PAGES", 500);
  const MAX_MB = intOpt(opts.maxMb, "MAX_MB", 200);
  const CONC = Math.max(1, intOpt(opts.concurrency, "CONC", 3));
  const wantRaw = opts.stores ?? process.env.STORES ?? "legal,cfo";
  const want = (Array.isArray(wantRaw) ? wantRaw : String(wantRaw).split(",")).map((s) => String(s).trim()).filter(Boolean);

  const rooms = want.map((n) => ROOMS[n]).filter(Boolean);
  if (!rooms.length) {
    return { ok: false, systemic: true, message: `no recognized store in STORES="${want.join(",")}" (expected one or both of: ${Object.keys(ROOMS).join(", ")})`, ...emptyCounts() };
  }

  const preflight = preflightRooms(rooms);
  if (!preflight.ok) return { ok: false, systemic: true, message: preflight.message, ...emptyCounts() };

  if (!(await s3Configured())) {
    return {
      ok: false,
      systemic: true,
      message: "AWS credentials unavailable (checked the ECS task role, AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY, and OTC_AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY) -- cannot list or OCR any document.",
      ...emptyCounts(),
    };
  }

  // ---- list every room/container, select what needs OCR ----
  const stats = {};
  const candidates = [];
  for (const room of rooms) {
    for (const container of room.containers) {
      let listed;
      try {
        listed = await listBlobsMetaFromS3(room.account, container, "");
      } catch (e) {
        return { ok: false, systemic: true, message: `listing ${room.account}/${container} failed: ${e.message}`, ...emptyCounts() };
      }
      const names = listed.map((o) => o.name);
      const sizeByName = new Map(listed.map((o) => [o.name, o.size]));
      const lmByName = new Map(listed.map((o) => [o.name, o.lastModified || ""]));
      const docs = names.filter(isEligibleDocName);
      const todo = selectCandidates(names);
      stats[`${room.name}/${container}`] = { docs: docs.length, todo: todo.length };
      for (const n of todo) candidates.push({ room: room.name, account: room.account, container, name: n, size: sizeByName.get(n) || 0, lastModified: lmByName.get(n) || "" });
    }
  }
  console.log("[ocr-sweep] scope:", JSON.stringify(stats));
  console.log("[ocr-sweep] total docs needing OCR:", candidates.length);

  if (!candidates.length) {
    return {
      ok: true,
      systemic: false,
      message: `No documents need OCR -- every eligible file across all scanned rooms already has a _TEXT/ sidecar. This is success, not failure.`,
      ...emptyCounts(),
      stats,
    };
  }

  if (DRY) {
    return { ok: true, systemic: false, dryRun: true, message: `DRYRUN: ${candidates.length} document(s) would be OCR'd; nothing written.`, ...emptyCounts(), stats, candidates: candidates.length };
  }

  // ---- process, with a shared budget + a shared systemic-abort flag every worker checks ----
  const maxBytes = MAX_MB * 1024 * 1024;
  const state = { idx: 0, docsUsed: 0, pagesUsed: 0, ok: 0, fail: 0, over: 0, systemic: null };

  async function worker(startDelayMs) {
    if (startDelayMs) await sleep(startDelayMs); // stagger so CONC workers don't all submit in the same instant (the 2026-08-01 throttle-storm fix, carried forward)
    for (;;) {
      if (state.systemic) return;
      if (state.idx >= candidates.length) return;
      if (!withinBudget(state, { maxDocs: MAX_DOCS, maxPages: MAX_PAGES })) return;
      const it = candidates[state.idx++];
      if (it.size > maxBytes) {
        state.over++;
        continue;
      }
      // RESERVE this document against the budget IMMEDIATELY -- synchronously, before the (possibly
      // slow) Textract call even starts, and with NO `await` between the withinBudget() check above,
      // the `state.idx++` claim, and this reservation. That is what makes MAX_DOCS_PER_RUN/MAX_PAGES
      // actual HARD caps under concurrency (CONC>1): previously withinBudget() was checked against
      // ONLY completed work, so up to CONC-1 other documents already claimed by sibling workers but
      // not yet finished were invisible to it -- a live run with MAX_DOCS_PER_RUN=5/CONC=2 processed
      // 6 documents this way (FND-20260903-43c9). Because this reservation happens in the same
      // synchronous tick as the claim above, no other worker's withinBudget() check can ever observe
      // a state that omits it -- see reservedPageEstimate() for why the page half is a floor, not the
      // real count. True-up/release below corrects both counters to the REAL outcome once it is
      // known, so the FINAL accounting (state.ok/state.fail/state.pagesUsed) is byte-identical to
      // before this fix -- only the TIMING of the reservation moved earlier, not what gets counted.
      const reservedPages = reservedPageEstimate(it);
      state.docsUsed++;
      state.pagesUsed += reservedPages;
      const loc = s3LocationFor(it.account, it.container);
      const key = `${loc.keyPrefix}${it.name}`;
      try {
        // The object version (size + LastModified from the listing) rides into the async idempotency
        // token, so an overwritten file never inherits the previous bytes' Textract job.
        const result = await ocrOneDocument(loc.bucket, key, it.size, `${it.size}:${it.lastModified}`);
        try {
          await putObjectToS3(it.account, it.container, sideFor(it.name), Buffer.from(result.text, "utf8"), "text/plain; charset=utf-8");
        } catch (putErr) {
          // The OCR already happened and was billed: carry its real page count on the error so the
          // budget accounting in the catch below charges what Textract actually processed.
          if (isSystemicS3Error(putErr)) throw taggedError(`sidecar write for ${it.room}/${it.container}/${it.name} failed: ${putErr.message}`, { systemic: true, pagesBilled: result.pages || 1 });
          throw taggedError(`sidecar write for ${it.room}/${it.container}/${it.name} failed: ${putErr.message}`, { pagesBilled: result.pages || 1 }); // a non-systemic write failure is still this document's failure, not a reason to keep the OCR result unpersisted and call it success
        }
        state.ok++;
        // True UP the page reservation to the REAL count now that Textract has told us. docsUsed was
        // already reserved above -- do not increment it again here (that would double-count it).
        state.pagesUsed += (result.pages || 1) - reservedPages;
      } catch (e) {
        if ((e && e.systemic) || isSystemicS3Error(e)) {
          // RELEASE the reservation: a systemic abort has never counted against the budget (there is
          // no further dispatch decision left to protect once state.systemic is set -- every worker
          // stops at the top of its next loop iteration regardless of the counters), and releasing
          // keeps that pre-existing accounting behavior exact.
          state.docsUsed--;
          state.pagesUsed -= reservedPages;
          state.systemic = e;
          return;
        }
        state.fail++;
        // Charge the budget for a failed attempt too: the real page count when it is known (a sidecar
        // write that failed AFTER a successful OCR), otherwise a one-page floor -- Textract reports no
        // page count on a failure, and a run full of failures must still exhaust MAX_PAGES rather than
        // retry for free forever. (docsUsed was already reserved above -- do not increment it again.)
        const billed = e && Number.isFinite(e.pagesBilled) && e.pagesBilled > 0 ? e.pagesBilled : 1;
        state.pagesUsed += billed - reservedPages;
        console.error(`[ocr-sweep]   FAILED ${it.room}/${it.container}/${it.name}: ${e.message}`);
      }
      if ((state.ok + state.fail) % 25 === 0) console.log(`[ocr-sweep]   ...${state.ok + state.fail} processed (ok ${state.ok}, fail ${state.fail})`);
    }
  }
  await Promise.all(Array.from({ length: CONC }, (_, i) => worker(i * 750)));

  const counts = { stats, candidates: candidates.length, processed: state.docsUsed, okCount: state.ok, failCount: state.fail, overCount: state.over, pagesUsed: state.pagesUsed, backlogRemaining: Math.max(0, candidates.length - state.ok) };

  if (state.systemic) {
    return { ok: false, systemic: true, message: state.systemic.message, ...counts };
  }
  const message =
    `DONE this run: ${state.ok} sidecars written, ${state.fail} failed, ${state.over} oversize-skipped (>${MAX_MB}MB), ` +
    `of ${state.docsUsed} processed (~${state.pagesUsed} Textract page(s) used, budget ${MAX_PAGES || "unlimited"}). ` +
    `Backlog remaining: ${counts.backlogRemaining}.`;
  return { ok: true, systemic: false, message, ...counts };
}

// ============================ CLI wrapper (thin, not itself unit-tested) ============================
async function main() {
  const result = await runSweep({});
  if (result.dryRun) {
    console.log(`[ocr-sweep] ${result.message}`);
    process.exitCode = 0;
    return;
  }
  if (!result.ok) {
    console.error(`[ocr-sweep] FAILED (systemic): ${result.message}`);
    process.exitCode = 1;
    return;
  }
  console.log(`[ocr-sweep] ${result.message}`);
  process.exitCode = 0;
}

const isDirectRun = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  main().catch((e) => {
    console.error("[ocr-sweep] ERR", e && e.message ? e.message : e);
    process.exitCode = 1;
  });
}
