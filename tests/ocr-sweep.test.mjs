// Tests for skills/ocr-sweep/sweep.mjs -- the Textract-based OCR backfill for the legal + cfo S3 data
// rooms (replaces the dead-Azure-Document-Intelligence version; see the file's own header). Two
// styles, mirroring tests/aws-dr-canary.test.mjs and tests/aws-image-canary.test.mjs's own split:
//   1. Pure-function tests (selection, sidecar path shape, budget/routing/classification logic) --
//      no network, no AWS credentials, instant.
//   2. Stubbed-`fetch` integration tests of runSweep() itself -- the real s3-blob.mjs and
//      ../../setup/aws-sigv4.mjs code paths run for real; only the actual network call is intercepted.
//      Every stub throws on a host/path it does not recognize, so a bug that made this sweep reach
//      further than the S3 room it was told to scan, or an unconfigured Textract action, fails LOUD
//      here rather than silently phoning out. No test in this file ever contacts a real AWS endpoint.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ROOMS,
  SYNC_MAX_BYTES,
  sideFor,
  isSidecarName,
  isEligibleDocName,
  selectCandidates,
  preferSync,
  pageCountOf,
  blocksToText,
  extractExceptionType,
  classifyTextractFailure,
  isSystemicS3Error,
  preflightRooms,
  withinBudget,
  clientRequestToken,
  textractUrl,
  runSweep,
  _setSleepForTests,
  _setPollTimingForTests,
} from "../skills/ocr-sweep/sweep.mjs";
import { _resetCredsCacheForTests } from "../skills/kb-memory/s3-blob.mjs";

// =====================================================================================
// 1. pure functions -- no network, no credentials
// =====================================================================================

test("sideFor: a single top-level _TEXT/ prefix mirroring the full relative path -- matches indexer.mjs's TEXT_PREFIX + path + '.txt' EXACTLY, not the old per-directory-nested shape", () => {
  assert.equal(sideFor("doc.pdf"), "_TEXT/doc.pdf.txt");
  assert.equal(sideFor("folder/sub/doc.pdf"), "_TEXT/folder/sub/doc.pdf.txt");
  assert.notEqual(sideFor("folder/sub/doc.pdf"), "folder/sub/_TEXT/doc.pdf.txt", "must NOT reproduce the old Azure-era per-directory nested sidecar shape");
});

test("isSidecarName / isEligibleDocName: format + our-own-artifact exclusions", () => {
  assert.equal(isSidecarName("_TEXT/a/b.pdf.txt"), true);
  assert.equal(isSidecarName("a/_TEXT/b.pdf.txt"), false, "sidecar detection is TOP-LEVEL _TEXT/ only");
  assert.equal(isSidecarName("_TEXT/a.pdf.md"), false, "must end in .txt");

  assert.equal(isEligibleDocName("statement.pdf"), true);
  assert.equal(isEligibleDocName("scan.PNG"), true, "extension match is case-insensitive");
  assert.equal(isEligibleDocName("photo.jpeg"), true);
  assert.equal(isEligibleDocName("photo.jpg"), true);
  assert.equal(isEligibleDocName("fax.tiff"), true);
  assert.equal(isEligibleDocName("fax.tif"), true);
  assert.equal(isEligibleDocName("notes.txt"), false);
  assert.equal(isEligibleDocName("spreadsheet.xlsx"), false, "Textract has no office-document mode -- deliberately narrower than the old Azure DI sweep, see file header");
  assert.equal(isEligibleDocName("deck.pptx"), false);
  assert.equal(isEligibleDocName("contract.docx"), false);
  assert.equal(isEligibleDocName("scan.bmp"), false, "BMP is not a Textract-supported format");
  assert.equal(isEligibleDocName("_TEXT/already-done.pdf.txt"), false, "never re-OCR our own sidecar tree");
  assert.equal(isEligibleDocName("_TRASH/deleted.pdf"), false, "never OCR a soft-deleted file");
  assert.equal(isEligibleDocName("_CATALOG/catalog.jsonl"), false);
  assert.equal(isEligibleDocName(""), false);
  assert.equal(isEligibleDocName(null), false);
});

test("selectCandidates: a doc with an existing sidecar is excluded; one without is included; non-doc/artifact names are ignored", () => {
  const names = ["a.pdf", "b.png", "c.docx", "_TEXT/a.pdf.txt", "_CATALOG/catalog.jsonl", "sub/d.jpg"];
  const todo = selectCandidates(names);
  assert.deepEqual(todo.sort(), ["b.png", "sub/d.jpg"].sort());
});

test("selectCandidates: sidecar matching is case-insensitive on the computed path (guards a source-name casing mismatch, e.g. a later listing reporting '.PDF' where the sidecar was written against '.pdf')", () => {
  // The sidecar prefix itself is always the literal `_TEXT/` (sweep.mjs writes nothing else) --
  // what can legitimately differ in case is the FILENAME portion the sidecar was computed FROM.
  const names = ["Report.PDF", "_TEXT/Report.pdf.txt"];
  assert.deepEqual(selectCandidates(names), [], "the sidecar written against a differently-cased extension must still count as done");
});

test("selectCandidates: accepts a pre-built sidecar set for a caller that already isolated it", () => {
  const names = ["a.pdf", "b.png"];
  const sidecars = new Set(["_text/a.pdf.txt"]);
  assert.deepEqual(selectCandidates(names, sidecars), ["b.png"]);
});

test("preferSync: true under the 10MB Textract sync limit, false strictly over it, true for an unknown/zero size", () => {
  assert.equal(preferSync(1024), true);
  assert.equal(preferSync(SYNC_MAX_BYTES), true, "exactly at the limit still prefers sync");
  assert.equal(preferSync(SYNC_MAX_BYTES + 1), false, "one byte over routes straight to async");
  assert.equal(preferSync(50 * 1024 * 1024), false);
  assert.equal(preferSync(0), true);
  assert.equal(preferSync(undefined), true);
  assert.equal(preferSync(NaN), true);
  assert.equal(preferSync(-5), true, "a nonsensical negative size must not force the slow path");
});

test("pageCountOf: prefers DocumentMetadata.Pages, falls back to counting PAGE blocks, falls back to 1", () => {
  assert.equal(pageCountOf({ DocumentMetadata: { Pages: 7 } }), 7);
  assert.equal(pageCountOf({ Blocks: [{ BlockType: "PAGE" }, { BlockType: "LINE" }, { BlockType: "PAGE" }] }), 2);
  assert.equal(pageCountOf({}), 1);
  assert.equal(pageCountOf({ Blocks: [] }), 1);
});

test("blocksToText: groups LINE blocks by Page ascending, joins lines within a page in emitted order, blank line between pages, ignores non-LINE blocks", () => {
  const blocks = [
    { BlockType: "PAGE", Page: 1 },
    { BlockType: "LINE", Text: "first line", Page: 1 },
    { BlockType: "WORD", Text: "ignored", Page: 1 },
    { BlockType: "LINE", Text: "second line", Page: 1 },
    { BlockType: "LINE", Text: "page two", Page: 2 },
  ];
  assert.equal(blocksToText(blocks), "first line\nsecond line\n\npage two");
});

test("blocksToText: a block with no Page field (the plain synchronous response shape) defaults to page 1", () => {
  assert.equal(blocksToText([{ BlockType: "LINE", Text: "only line" }]), "only line");
});

test("blocksToText: never throws on a missing/malformed Blocks array", () => {
  assert.equal(blocksToText(undefined), "");
  assert.equal(blocksToText(null), "");
  assert.equal(blocksToText([null, {}, { BlockType: "LINE" }]), "");
});

test("extractExceptionType: strips a namespace prefix when present, passes a bare name through, null when absent", () => {
  assert.equal(extractExceptionType({ __type: "com.amazonaws.textract#UnsupportedDocumentException" }), "UnsupportedDocumentException");
  assert.equal(extractExceptionType({ __type: "AccessDeniedException" }), "AccessDeniedException");
  assert.equal(extractExceptionType({ code: "InvalidParameterException" }), "InvalidParameterException");
  assert.equal(extractExceptionType({}), null);
  assert.equal(extractExceptionType(null), null);
});

test("classifyTextractFailure: status:0 (awsFetch's own never-throws contract) is ALWAYS systemic, regardless of body", () => {
  const r = classifyTextractFailure({ status: 0, json: null, reason: "error-fetch failed: getaddrinfo ENOTFOUND" });
  assert.equal(r.kind, "systemic");
  assert.equal(r.type, "network-unreachable");
  assert.match(r.message, /Textract unreachable/);
});

test("classifyTextractFailure: AccessDeniedException is systemic even with a 400 status (AWS JSON protocol quirk)", () => {
  const r = classifyTextractFailure({ status: 400, json: { __type: "AccessDeniedException", Message: "not authorized" } });
  assert.equal(r.kind, "systemic");
  assert.equal(r.message, "not authorized");
});

test("classifyTextractFailure: a bare 403/401 with no __type is still systemic", () => {
  assert.equal(classifyTextractFailure({ status: 403, json: {} }).kind, "systemic");
  assert.equal(classifyTextractFailure({ status: 401, json: null }).kind, "systemic");
});

test("classifyTextractFailure: UnsupportedDocumentException routes to async, live-confirmed AWS re:Post shape", () => {
  const r = classifyTextractFailure({ status: 400, json: { __type: "UnsupportedDocumentException", Message: "Request has unsupported document format" } });
  assert.equal(r.kind, "route-async");
});

test("classifyTextractFailure: throttling (both documented names) and 5xx are retryable, never systemic or route-async", () => {
  assert.equal(classifyTextractFailure({ status: 400, json: { __type: "ThrottlingException", Message: "..." } }).kind, "retryable");
  assert.equal(classifyTextractFailure({ status: 400, json: { __type: "ProvisionedThroughputExceededException", Message: "Provisioned rate exceeded" } }).kind, "retryable");
  assert.equal(classifyTextractFailure({ status: 500, json: {} }).kind, "retryable");
  assert.equal(classifyTextractFailure({ status: 503, json: { __type: "ServiceUnavailableException" } }).kind, "retryable");
});

test("classifyTextractFailure: an ordinary content/parameter problem is per-doc, not systemic and not retryable", () => {
  const r = classifyTextractFailure({ status: 400, json: { __type: "InvalidParameterException", Message: "bad request" } });
  assert.equal(r.kind, "per-doc");
  assert.equal(r.type, "InvalidParameterException");
  const r2 = classifyTextractFailure({ status: 400, json: { __type: "BadDocumentException", Message: "corrupt" } });
  assert.equal(r2.kind, "per-doc");
});

test("isSystemicS3Error: a 403 status, the s3-blob.mjs 'no S3 mirror mapping' message, and a missing-credentials message are all systemic; a plain 500 is not", () => {
  assert.equal(isSystemicS3Error({ status: 403, message: "s3 put 403: ..." }), true);
  assert.equal(isSystemicS3Error(new Error("s3-blob: no S3 mirror mapping for otchealthcommerce/commerce-source-docs (refusing to guess a bucket)")), true);
  assert.equal(isSystemicS3Error(new Error("s3-blob: AWS credentials unavailable (checked the ECS task role...)")), true);
  assert.equal(isSystemicS3Error({ status: 500, message: "s3 put 500: internal error" }), false);
  assert.equal(isSystemicS3Error(null), false);
});

test("preflightRooms: a room whose account/container has no row in s3-blob.mjs's MIRROR table is refused before any network call, with an actionable message", () => {
  const r = preflightRooms([{ name: "bogus", account: "not-a-real-account", containers: ["not-a-real-container"] }]);
  assert.equal(r.ok, false);
  assert.match(r.message, /no S3 mirror mapping for not-a-real-account\/not-a-real-container/);
});

test("preflightRooms: the two real rooms this sweep is scoped to (legal, cfo) resolve cleanly", () => {
  assert.deepEqual(preflightRooms([ROOMS.legal]), { ok: true });
  assert.deepEqual(preflightRooms([ROOMS.cfo]), { ok: true });
  assert.deepEqual(preflightRooms([ROOMS.legal, ROOMS.cfo]), { ok: true });
});

test("ROOMS: exactly the legal + cfo PHI-wall scope, matching indexer.mjs's own finance/legal profile account+container strings", () => {
  assert.deepEqual(Object.keys(ROOMS).sort(), ["cfo", "legal"]);
  assert.equal(ROOMS.legal.account, "otchealthlegalstore");
  assert.deepEqual(ROOMS.legal.containers, ["company", "personal"]);
  assert.equal(ROOMS.cfo.account, "otchealthcfodata");
  assert.deepEqual(ROOMS.cfo.containers, ["cfo-source-docs"]);
});

test("withinBudget: page-cap and doc-cap enforcement, and 0 meaning unlimited for either", () => {
  assert.equal(withinBudget({ docsUsed: 0, pagesUsed: 0 }, { maxDocs: 5, maxPages: 500 }), true);
  assert.equal(withinBudget({ docsUsed: 5, pagesUsed: 0 }, { maxDocs: 5, maxPages: 500 }), false, "doc cap reached");
  assert.equal(withinBudget({ docsUsed: 0, pagesUsed: 500 }, { maxDocs: 5, maxPages: 500 }), false, "page cap reached");
  assert.equal(withinBudget({ docsUsed: 0, pagesUsed: 499 }, { maxDocs: 5, maxPages: 500 }), true, "one page under the cap is still fine");
  assert.equal(withinBudget({ docsUsed: 999999, pagesUsed: 999999 }, { maxDocs: 0, maxPages: 0 }), true, "0/0 means unlimited on both axes");
});

test("clientRequestToken: deterministic per (bucket,key), 64 lowercase-hex characters (fits Textract's ClientRequestToken constraints with no truncation)", () => {
  const t1 = clientRequestToken("my-bucket", "path/to/doc.pdf");
  const t2 = clientRequestToken("my-bucket", "path/to/doc.pdf");
  const t3 = clientRequestToken("my-bucket", "path/to/other.pdf");
  assert.equal(t1, t2, "same input must always produce the same token, so a crash-and-resume reuses the same Textract job");
  assert.notEqual(t1, t3);
  assert.equal(t1.length, 64);
  assert.match(t1, /^[0-9a-f]{64}$/);
});

test("textractUrl: the plain AWS JSON-protocol endpoint for a region, no path/query", () => {
  assert.equal(textractUrl("us-east-1"), "https://textract.us-east-1.amazonaws.com/");
});

// =====================================================================================
// 2. stubbed-fetch integration tests of runSweep()
// =====================================================================================
// Real bucket/keyPrefix values from skills/kb-memory/s3-blob.mjs's own MIRROR table, so a test
// exercises the ACTUAL resolved location, not a stand-in.
const CFO_BUCKET = "otchealth-finance-legal-dr-55c84f6b";
const CFO_PREFIX = "otchealthcfodata/cfo-source-docs/";
const TEXTRACT_HOST = "textract.us-east-1.amazonaws.com";

const FAKE_ENV = { AWS_ACCESS_KEY_ID: "AKIAUNITTESTFAKE0002", AWS_SECRET_ACCESS_KEY: "unit-test-fake-secret-not-real" };

async function withEnv(vars, run) {
  const saved = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    process.env[k] = vars[k];
  }
  _resetCredsCacheForTests();
  try {
    return await run();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    _resetCredsCacheForTests();
  }
}
async function withStubbedFetch(stub, run) {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}
function header(opts, name) {
  const h = (opts && opts.headers) || {};
  const key = Object.keys(h).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? h[key] : undefined;
}
function xmlListing(s3Objects, prefix) {
  const contents = Object.entries(s3Objects)
    .filter(([k]) => k.startsWith("/" + prefix))
    .map(([k, v]) => `<Contents><Key>${k.slice(1)}</Key><Size>${v.size}</Size><LastModified>${v.lastModified || "2026-01-01T00:00:00.000Z"}</LastModified></Contents>`)
    .join("");
  return `<ListBucketResult>${contents}<IsTruncated>false</IsTruncated></ListBucketResult>`;
}

/** A combined S3 + Textract fetch stub. `s3Objects` seeds ONE bucket's listing (keyed by the full
 *  path with a leading '/', matching tests/aws-dr-canary.test.mjs's own convention); `textract` is a
 *  {ActionName: [ {status,json}, ... ]} queue -- each call to that action pops the next entry (so a
 *  test can script "IN_PROGRESS, IN_PROGRESS, SUCCEEDED"), and a queue that runs dry (or an action
 *  never given a queue) throws, catching an unexpected extra Textract call. Any request to a host
 *  other than the one configured S3 bucket host or the Textract host throws by design. */
function makeWorld({ bucket = CFO_BUCKET, s3Objects = {}, textract = {} } = {}) {
  const host = `${bucket}.s3.us-east-1.amazonaws.com`;
  const objects = { ...s3Objects };
  const queues = Object.fromEntries(Object.entries(textract).map(([k, v]) => [k, [...v]]));
  const calls = [];
  const puts = [];
  const stub = async (url, opts = {}) => {
    const u = String(url);
    const { hostname, pathname, searchParams } = new URL(u);
    const method = (opts.method || "GET").toUpperCase();
    if (hostname === host) {
      calls.push({ method, host: hostname, path: pathname });
      if (method === "GET" && searchParams.get("list-type") === "2") {
        const prefix = searchParams.get("prefix") || "";
        return { ok: true, status: 200, text: async () => xmlListing(objects, prefix) };
      }
      if (method === "PUT") {
        const bodyText = Buffer.isBuffer(opts.body) ? opts.body.toString("utf8") : String(opts.body || "");
        puts.push({ path: pathname, bodyText });
        return { ok: true, status: 200, headers: { get: (n) => (n.toLowerCase() === "etag" ? '"fake-etag"' : null) }, text: async () => "" };
      }
      throw new Error(`TEST SAFETY: unexpected S3 call ${method} ${pathname}`);
    }
    if (hostname === TEXTRACT_HOST) {
      const action = String(header(opts, "X-Amz-Target") || "").split(".").pop();
      calls.push({ method, host: hostname, action, body: opts.body ? JSON.parse(opts.body) : null });
      const q = queues[action];
      if (!q || !q.length) throw new Error(`TEST SAFETY: unexpected/exhausted Textract call for action "${action}"`);
      const next = q.shift();
      const status = next.status ?? 200;
      return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(next.json ?? {}) };
    }
    throw new Error(`TEST SAFETY: fetch reached an unrecognized host "${hostname}" -- ocr-sweep must never leave S3 + Textract`);
  };
  return { stub, objects, calls, puts };
}

test("runSweep: an unrecognized STORES value is a systemic, zero-network failure", async () => {
  const r = await withStubbedFetch(
    async () => {
      throw new Error("must not touch the network at all");
    },
    () => runSweep({ stores: "not-a-real-room" })
  );
  assert.equal(r.ok, false);
  assert.equal(r.systemic, true);
  assert.match(r.message, /no recognized store/);
});

test("runSweep: an empty room reports EXPLICIT success -- 'no documents need OCR' is not the same as silence", async () => {
  const world = makeWorld({ s3Objects: {} });
  const r = await withEnv(FAKE_ENV, () => withStubbedFetch(world.stub, () => runSweep({ stores: "cfo" })));
  assert.equal(r.ok, true);
  assert.equal(r.systemic, false);
  assert.match(r.message, /No documents need OCR/);
  assert.equal(r.okCount, 0);
  assert.equal(world.calls.some((c) => c.host === TEXTRACT_HOST), false, "must never call Textract when there is nothing to OCR");
});

test("runSweep: DRYRUN finds candidates but writes nothing and calls Textract zero times", async () => {
  const world = makeWorld({
    s3Objects: { [`/${CFO_PREFIX}a.pdf`]: { size: 1000 } },
  });
  const r = await withEnv(FAKE_ENV, () => withStubbedFetch(world.stub, () => runSweep({ stores: "cfo", dryRun: true })));
  assert.equal(r.ok, true);
  assert.equal(r.dryRun, true);
  assert.equal(r.candidates, 1);
  assert.equal(world.puts.length, 0);
  assert.equal(world.calls.some((c) => c.host === TEXTRACT_HOST), false);
});

test("runSweep: sync success -- a single small PDF is OCR'd via DetectDocumentText and the sidecar lands at the exact _TEXT/<name>.txt S3 key", async () => {
  const world = makeWorld({
    s3Objects: { [`/${CFO_PREFIX}invoices/a.pdf`]: { size: 1000 } },
    textract: {
      DetectDocumentText: [{ status: 200, json: { DocumentMetadata: { Pages: 1 }, Blocks: [{ BlockType: "LINE", Text: "hello invoice" }] } }],
    },
  });
  const r = await withEnv(FAKE_ENV, () => withStubbedFetch(world.stub, () => runSweep({ stores: "cfo" })));
  assert.equal(r.ok, true);
  assert.equal(r.systemic, false);
  assert.equal(r.okCount, 1);
  assert.equal(r.failCount, 0);
  assert.equal(r.pagesUsed, 1);
  assert.equal(world.puts.length, 1);
  assert.equal(world.puts[0].path, `/${CFO_PREFIX}_TEXT/invoices/a.pdf.txt`, "the sidecar must be written under the SAME keyPrefix as the source, at the top-level _TEXT/ shape");
  assert.equal(world.puts[0].bodyText, "hello invoice");
  const dtCalls = world.calls.filter((c) => c.action === "DetectDocumentText");
  assert.equal(dtCalls.length, 1);
  assert.deepEqual(dtCalls[0].body.Document.S3Object, { Bucket: CFO_BUCKET, Name: `${CFO_PREFIX}invoices/a.pdf` }, "Textract must be given a direct S3Object reference, never downloaded bytes");
});

test("runSweep: sync-to-async fallback -- DetectDocumentText reports UnsupportedDocumentException (multi-page), the SAME document is retried via StartDocumentTextDetection + polled to completion", async () => {
  const world = makeWorld({
    s3Objects: { [`/${CFO_PREFIX}multi.pdf`]: { size: 2000 } },
    textract: {
      DetectDocumentText: [{ status: 400, json: { __type: "UnsupportedDocumentException", Message: "Request has unsupported document format" } }],
      StartDocumentTextDetection: [{ status: 200, json: { JobId: "job-123" } }],
      GetDocumentTextDetection: [
        { status: 200, json: { JobStatus: "IN_PROGRESS" } },
        { status: 200, json: { JobStatus: "SUCCEEDED", DocumentMetadata: { Pages: 3 }, Blocks: [{ BlockType: "LINE", Text: "page one", Page: 1 }, { BlockType: "LINE", Text: "page two", Page: 2 }] } },
      ],
    },
  });
  _setSleepForTests(async () => {});
  _setPollTimingForTests(0, 10);
  let r;
  try {
    r = await withEnv(FAKE_ENV, () => withStubbedFetch(world.stub, () => runSweep({ stores: "cfo" })));
  } finally {
    _setPollTimingForTests();
    _setSleepForTests();
  }
  assert.equal(r.ok, true);
  assert.equal(r.okCount, 1);
  assert.equal(r.pagesUsed, 3);
  assert.equal(world.puts[0].bodyText, "page one\n\npage two");
  const startCalls = world.calls.filter((c) => c.action === "StartDocumentTextDetection");
  assert.equal(startCalls.length, 1);
  assert.equal(startCalls[0].body.DocumentLocation.S3Object.Name, `${CFO_PREFIX}multi.pdf`);
  assert.equal(startCalls[0].body.ClientRequestToken, clientRequestToken(CFO_BUCKET, `${CFO_PREFIX}multi.pdf`, "2000:2026-01-01T00:00:00.000Z"), "must reuse the deterministic idempotency token, bound to the listed size + LastModified");
  assert.notEqual(startCalls[0].body.ClientRequestToken, clientRequestToken(CFO_BUCKET, `${CFO_PREFIX}multi.pdf`, "2000:2026-02-02T00:00:00.000Z"), "an overwritten object (new LastModified) must get a different token, never the previous bytes' job");
  assert.equal(world.calls.filter((c) => c.action === "GetDocumentTextDetection").length, 2, "must poll until SUCCEEDED, not just once");
});

test("runSweep: an over-10MB document skips the sync attempt entirely and goes straight to the async job API", async () => {
  const world = makeWorld({
    s3Objects: { [`/${CFO_PREFIX}big.pdf`]: { size: SYNC_MAX_BYTES + 1 } },
    textract: {
      StartDocumentTextDetection: [{ status: 200, json: { JobId: "job-big" } }],
      GetDocumentTextDetection: [{ status: 200, json: { JobStatus: "SUCCEEDED", DocumentMetadata: { Pages: 1 }, Blocks: [{ BlockType: "LINE", Text: "big doc text" }] } }],
    },
  });
  const r = await withEnv(FAKE_ENV, () => withStubbedFetch(world.stub, () => runSweep({ stores: "cfo" })));
  assert.equal(r.ok, true);
  assert.equal(r.okCount, 1);
  assert.equal(world.calls.filter((c) => c.action === "DetectDocumentText").length, 0, "must never attempt sync on a document known to exceed the sync size limit");
});

test("runSweep: page-cap enforcement -- once the cumulative page budget is reached, no MORE documents are dispatched, but the in-flight one still finishes and is written", async () => {
  const world = makeWorld({
    s3Objects: {
      [`/${CFO_PREFIX}a.pdf`]: { size: 1000 },
      [`/${CFO_PREFIX}b.pdf`]: { size: 1000 },
    },
    textract: {
      DetectDocumentText: [{ status: 200, json: { DocumentMetadata: { Pages: 1 }, Blocks: [{ BlockType: "LINE", Text: "doc a" }] } }],
    },
  });
  const r = await withEnv(FAKE_ENV, () => withStubbedFetch(world.stub, () => runSweep({ stores: "cfo", maxPages: 1, concurrency: 1 })));
  assert.equal(r.ok, true);
  assert.equal(r.okCount, 1, "exactly one document processed before the page budget stopped further dispatch");
  assert.equal(r.overCount, 0);
  assert.equal(r.pagesUsed, 1);
  assert.equal(world.calls.filter((c) => c.host === TEXTRACT_HOST).length, 1, "the SECOND document must never even reach Textract once the budget is spent");
});

test("runSweep: MAX_DOCS_PER_RUN enforcement, independent of the page budget", async () => {
  const world = makeWorld({
    s3Objects: {
      [`/${CFO_PREFIX}a.pdf`]: { size: 1000 },
      [`/${CFO_PREFIX}b.pdf`]: { size: 1000 },
      [`/${CFO_PREFIX}c.pdf`]: { size: 1000 },
    },
    textract: {
      DetectDocumentText: [
        { status: 200, json: { DocumentMetadata: { Pages: 1 }, Blocks: [{ BlockType: "LINE", Text: "x" }] } },
        { status: 200, json: { DocumentMetadata: { Pages: 1 }, Blocks: [{ BlockType: "LINE", Text: "y" }] } },
      ],
    },
  });
  const r = await withEnv(FAKE_ENV, () => withStubbedFetch(world.stub, () => runSweep({ stores: "cfo", maxDocsPerRun: 2, maxPages: 0, concurrency: 1 })));
  assert.equal(r.okCount, 2);
  assert.equal(world.calls.filter((c) => c.host === TEXTRACT_HOST).length, 2, "the third document must never be dispatched once the doc-count cap is hit");
});

test("runSweep: an oversize file (over MAX_MB) is skipped WITHOUT ever calling Textract, and does not consume the page/doc budget", async () => {
  const world = makeWorld({
    s3Objects: {
      [`/${CFO_PREFIX}huge.pdf`]: { size: 300 * 1024 * 1024 },
      [`/${CFO_PREFIX}normal.pdf`]: { size: 1000 },
    },
    textract: {
      DetectDocumentText: [{ status: 200, json: { DocumentMetadata: { Pages: 1 }, Blocks: [{ BlockType: "LINE", Text: "normal doc" }] } }],
    },
  });
  const r = await withEnv(FAKE_ENV, () => withStubbedFetch(world.stub, () => runSweep({ stores: "cfo", maxMb: 200, concurrency: 1 })));
  assert.equal(r.overCount, 1);
  assert.equal(r.okCount, 1);
  assert.equal(world.calls.filter((c) => c.host === TEXTRACT_HOST).length, 1, "the oversize file must never reach Textract at all");
});

test("runSweep: a per-document content failure (a genuinely corrupt/unsupported file) fails OPEN -- logged, counted, the run still succeeds overall", async () => {
  const world = makeWorld({
    s3Objects: {
      [`/${CFO_PREFIX}corrupt.pdf`]: { size: 1000 },
      [`/${CFO_PREFIX}fine.pdf`]: { size: 1000 },
    },
    textract: {
      DetectDocumentText: [
        { status: 400, json: { __type: "BadDocumentException", Message: "unable to parse" } },
        { status: 200, json: { DocumentMetadata: { Pages: 1 }, Blocks: [{ BlockType: "LINE", Text: "fine doc" }] } },
      ],
    },
  });
  const r = await withEnv(FAKE_ENV, () => withStubbedFetch(world.stub, () => runSweep({ stores: "cfo", concurrency: 1 })));
  assert.equal(r.ok, true, "a per-document failure must not fail the whole run");
  assert.equal(r.systemic, false);
  assert.equal(r.failCount, 1);
  assert.equal(r.okCount, 1, "the OTHER document must still be processed after one document's failure");
});

test("runSweep: FAIL LOUD -- Textract AccessDeniedException aborts the whole run, non-ok, systemic, and the message names the cause", async () => {
  const world = makeWorld({
    s3Objects: { [`/${CFO_PREFIX}a.pdf`]: { size: 1000 } },
    textract: {
      DetectDocumentText: [{ status: 400, json: { __type: "AccessDeniedException", Message: "User is not authorized to perform: textract:DetectDocumentText" } }],
    },
  });
  const r = await withEnv(FAKE_ENV, () => withStubbedFetch(world.stub, () => runSweep({ stores: "cfo" })));
  assert.equal(r.ok, false);
  assert.equal(r.systemic, true);
  assert.match(r.message, /not authorized/);
});

test("runSweep: FAIL LOUD -- Textract unreachable (a real network-level fetch failure) aborts the whole run, non-ok, systemic", async () => {
  const world = makeWorld({ s3Objects: { [`/${CFO_PREFIX}a.pdf`]: { size: 1000 } } });
  const stub = async (url, opts = {}) => {
    const { hostname } = new URL(String(url));
    if (hostname === TEXTRACT_HOST) throw new Error("getaddrinfo ENOTFOUND textract.us-east-1.amazonaws.com");
    return world.stub(url, opts);
  };
  const r = await withEnv(FAKE_ENV, () => withStubbedFetch(stub, () => runSweep({ stores: "cfo" })));
  assert.equal(r.ok, false);
  assert.equal(r.systemic, true);
  assert.match(r.message, /Textract unreachable/);
});

test("runSweep: FAIL LOUD -- an S3 write AccessDenied (e.g. the ring-gated legal/personal room) aborts the run instead of silently reporting a false success", async () => {
  const PERSONAL_BUCKET = "otchealth-legal-personal-dr-55c84f6b";
  const PERSONAL_PREFIX = "otchealthlegalstore/personal/";
  const host = `${PERSONAL_BUCKET}.s3.us-east-1.amazonaws.com`;
  const stub = async (url, opts = {}) => {
    const { hostname, pathname, searchParams } = new URL(String(url));
    const method = (opts.method || "GET").toUpperCase();
    if (hostname === host && method === "GET" && searchParams.get("list-type") === "2") {
      return { ok: true, status: 200, text: async () => xmlListing({ [`/${PERSONAL_PREFIX}filing.pdf`]: { size: 1000 } }, searchParams.get("prefix") || "") };
    }
    if (hostname === TEXTRACT_HOST) {
      const action = String(header(opts, "X-Amz-Target") || "").split(".").pop();
      if (action === "DetectDocumentText") return { ok: true, status: 200, text: async () => JSON.stringify({ DocumentMetadata: { Pages: 1 }, Blocks: [{ BlockType: "LINE", Text: "filing text" }] }) };
    }
    if (hostname === host && method === "PUT") {
      return { ok: false, status: 403, text: async () => "<Error><Code>AccessDenied</Code></Error>" };
    }
    throw new Error(`TEST SAFETY: unrecognized call ${method} ${hostname}${pathname}`);
  };
  const r = await withEnv(FAKE_ENV, () => withStubbedFetch(stub, () => runSweep({ stores: "legal" })));
  assert.equal(r.ok, false);
  assert.equal(r.systemic, true, "a 403 writing the sidecar is an IAM/permission problem for the WHOLE room, not one document's content problem");
});
