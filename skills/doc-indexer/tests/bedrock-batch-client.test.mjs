// Tests for skills/doc-indexer/bedrock-batch-client.mjs (2026-09-03, enrich.mjs's --bedrock-batch
// lane's control-plane + S3-staging client).
//
// Pure-function tests (status classification, ARN parsing, output/manifest parsing) plus
// dependency-injected `fetchImpl` tests for the two control-plane calls (createModelInvocationJob/
// getModelInvocationJob) that PROVE the exact request shape this file builds matches the LIVE AWS
// documentation it was verified against (host, path, method, body field names/nesting) -- fetched
// 2026-09-03 from docs.aws.amazon.com/bedrock/latest/{userguide,APIReference}/*, quoted in this
// file's own header. Every assertion here traces back to one of those citations, not to what the
// implementation happens to do.
//
// HERMETICITY (added 2026-09-03, same day, after a CI run on 6fa059e failed 12 of these tests with
// "AWS credentials unavailable"): every `fetchImpl`-stubbed call below also passes `creds:
// FAKE_CREDS` (see that constant's own comment). Without it, bedrockControlFetch() calls the real
// awsCreds() BEFORE ever reaching the injected fetchImpl, so these tests only ran their real
// assertions on a seat with ambient AWS credentials already resolvable -- true in an interactive
// CTO/developer sandbox, false in CI, so CI could pass or fail this file for a reason that had
// nothing to do with what it actually tests. FAKE_CREDS makes that irrelevant: these tests now
// genuinely run and genuinely assert their request-shape claims with ZERO AWS credentials present
// anywhere in the environment (verified by running this exact file under `env -u
// AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY -u OTC_AWS_ACCESS_KEY_ID -u
// OTC_AWS_SECRET_ACCESS_KEY -u AWS_SESSION_TOKEN`, both failing before this change and passing
// after it -- see this PR's own description for the exact before/after counts). The ONE test that
// deliberately omits `creds` is "both throw a clear 'AWS credentials unavailable' error..." below,
// which exists specifically to prove the real no-credentials path still fails loud, not silently --
// giving that one test a fake credential would defeat its entire purpose.
//
// The S3-staging wrappers (putBatchInputFile/listBatchOutputFiles/getBatchOutputFileText)
// deliberately do NOT get a fetchImpl seam here -- they delegate to skills/kb-memory/s3-blob.mjs's
// s3RequestExplicit/listObjectsExplicit, which (like every other export in that file) talk to the
// real global `fetch`, no injection point, matching this repo's own established convention (every
// existing S3 I/O test in this repo -- storage-backend-default.test.mjs, push-search-
// opensearch.test.mjs, enrich-llm.test.mjs's Layer 3 -- exercises S3 via a SUBPROCESS + global-
// fetch-stub, never via a fetchImpl param, because s3-blob.mjs offers no such param anywhere).
// tests/enrich-bedrock-batch.test.mjs's Layer 3 integration tests stub those calls at that level,
// alongside the control-plane host. What IS tested here, in-process, is each wrapper's
// missing-required-argument guard, which throws BEFORE any network call and so needs no stub.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  shortJobIdFromArn, isBedrockBatchTerminal,
  BEDROCK_BATCH_TERMINAL_SUCCESS_STATUSES, BEDROCK_BATCH_TERMINAL_FAILURE_STATUSES, BEDROCK_BATCH_NONTERMINAL_STATUSES,
  BEDROCK_BATCH_MIN_TIMEOUT_HOURS, BEDROCK_BATCH_MAX_TIMEOUT_HOURS,
  createModelInvocationJob, getModelInvocationJob,
  putBatchInputFile, listBatchOutputFiles, getBatchOutputFileText,
  parseBatchOutputJsonl, parseManifest,
} from "../bedrock-batch-client.mjs";

// FAKE_CREDS: the SAME publicly-documented AWS example credential pair
// skills/kb-memory/tests/sigv4.test.mjs already uses (its own FAKE_CREDS constant) -- not invented
// here, reused for consistency. It is AWS's own worked-example access key from the SigV4 signing
// docs (note the literal "EXAMPLE" baked into both halves); it authenticates to nothing. Passed as
// `creds` to createModelInvocationJob()/getModelInvocationJob() below (the injectable seam added
// 2026-09-03 to bedrockControlFetch(), mirroring kb-memory/sigv4.mjs's signAwsRequest({creds:
// presetCreds}) pattern verbatim) so these tests reach their injected `fetchImpl` deterministically
// regardless of this seat's ambient AWS credentials -- see bedrock-batch-client.mjs's own doc
// comment on bedrockControlFetch() for why that matters: without this, every test below that
// exercises createModelInvocationJob/getModelInvocationJob's real request-building logic silently
// depended on awsCreds() resolving something from the environment first, which is true on a
// developer/CTO sandbox and false in CI -- so CI could never actually run the assertions this file
// exists to make (a gate that cannot fail is not a gate). This is a TEST credential only; it never
// reaches production code, since every production call site (enrich.mjs's
// buildAndSubmitBedrockBatch()) omits `creds` and falls through to the real awsCreds() unchanged.
const FAKE_CREDS = { ak: "AKIAIOSFODNN7EXAMPLE", sk: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", st: null };

// =========================================================================================
// status classification (verbatim from GetModelInvocationJob's documented status enum)
// =========================================================================================

test("BEDROCK_BATCH_TERMINAL_SUCCESS_STATUSES: exactly Completed + PartiallyCompleted", () => {
  assert.deepEqual([...BEDROCK_BATCH_TERMINAL_SUCCESS_STATUSES].sort(), ["Completed", "PartiallyCompleted"]);
});

test("BEDROCK_BATCH_TERMINAL_FAILURE_STATUSES: exactly Failed + Stopped + Expired", () => {
  assert.deepEqual([...BEDROCK_BATCH_TERMINAL_FAILURE_STATUSES].sort(), ["Expired", "Failed", "Stopped"]);
});

test("BEDROCK_BATCH_NONTERMINAL_STATUSES: exactly Submitted + Validating + Scheduled + InProgress + Stopping", () => {
  assert.deepEqual([...BEDROCK_BATCH_NONTERMINAL_STATUSES].sort(), ["InProgress", "Scheduled", "Stopping", "Submitted", "Validating"]);
});

test("the three status sets partition the full documented enum with no overlap and no gap", () => {
  const fullEnum = ["Submitted", "InProgress", "Completed", "Failed", "Stopping", "Stopped", "PartiallyCompleted", "Expired", "Validating", "Scheduled"];
  const union = new Set([...BEDROCK_BATCH_TERMINAL_SUCCESS_STATUSES, ...BEDROCK_BATCH_TERMINAL_FAILURE_STATUSES, ...BEDROCK_BATCH_NONTERMINAL_STATUSES]);
  assert.deepEqual([...union].sort(), [...fullEnum].sort());
  for (const s of fullEnum) {
    const memberships = [BEDROCK_BATCH_TERMINAL_SUCCESS_STATUSES, BEDROCK_BATCH_TERMINAL_FAILURE_STATUSES, BEDROCK_BATCH_NONTERMINAL_STATUSES].filter((set) => set.has(s));
    assert.equal(memberships.length, 1, `"${s}" must belong to exactly one classification set, found in ${memberships.length}`);
  }
});

test("isBedrockBatchTerminal: true for every success or failure status, false for every non-terminal one", () => {
  for (const s of BEDROCK_BATCH_TERMINAL_SUCCESS_STATUSES) assert.equal(isBedrockBatchTerminal(s), true, s);
  for (const s of BEDROCK_BATCH_TERMINAL_FAILURE_STATUSES) assert.equal(isBedrockBatchTerminal(s), true, s);
  for (const s of BEDROCK_BATCH_NONTERMINAL_STATUSES) assert.equal(isBedrockBatchTerminal(s), false, s);
});

test("BEDROCK_BATCH_MIN_TIMEOUT_HOURS / MAX: 24 and 168 per CreateModelInvocationJob's documented Valid Range", () => {
  assert.equal(BEDROCK_BATCH_MIN_TIMEOUT_HOURS, 24);
  assert.equal(BEDROCK_BATCH_MAX_TIMEOUT_HOURS, 168);
});

// =========================================================================================
// shortJobIdFromArn (pure)
// =========================================================================================

test("shortJobIdFromArn: extracts the trailing 12-char id from a real-shaped jobArn", () => {
  assert.equal(shortJobIdFromArn("arn:aws:bedrock:us-east-1:900915535335:model-invocation-job/abc123def456"), "abc123def456");
});

test("shortJobIdFromArn: throws (not a silent guess) on a malformed/missing arn", () => {
  for (const bad of [null, undefined, "", "not-an-arn", "arn:aws:bedrock:us-east-1:900915535335:model-invocation-job/tooshort"]) {
    assert.throws(() => shortJobIdFromArn(bad), /does not look like a real batch-inference job ARN/);
  }
});

// =========================================================================================
// parseBatchOutputJsonl / parseManifest (pure)
// =========================================================================================

test("parseBatchOutputJsonl: parses each non-blank line as JSON, in order", () => {
  const text = '{"recordId":"a","modelInput":{},"modelOutput":{"x":1}}\n{"recordId":"b","modelInput":{},"error":{"errorCode":400,"errorMessage":"bad"}}\n';
  assert.deepEqual(parseBatchOutputJsonl(text), [
    { recordId: "a", modelInput: {}, modelOutput: { x: 1 } },
    { recordId: "b", modelInput: {}, error: { errorCode: 400, errorMessage: "bad" } },
  ]);
});

test("parseBatchOutputJsonl: tolerates blank/trailing lines and a trailing newline", () => {
  assert.deepEqual(parseBatchOutputJsonl('{"recordId":"a"}\n\n\n'), [{ recordId: "a" }]);
  assert.deepEqual(parseBatchOutputJsonl(""), []);
  assert.deepEqual(parseBatchOutputJsonl(null), []);
});

test("parseBatchOutputJsonl: a malformed line is SKIPPED, not thrown on -- one bad line must not hide every other line's real result", () => {
  const text = '{"recordId":"a","modelOutput":{"ok":true}}\nthis is not json\n{"recordId":"b","modelOutput":{"ok":true}}\n';
  const out = parseBatchOutputJsonl(text);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((l) => l.recordId), ["a", "b"]);
});

test("parseManifest: parses the documented field set verbatim", () => {
  const text = JSON.stringify({ totalRecordCount: 10, processedRecordCount: 10, successRecordCount: 9, errorRecordCount: 1, inputTokenCount: 5000, outputTokenCount: 2000 });
  assert.deepEqual(parseManifest(text), { totalRecordCount: 10, processedRecordCount: 10, successRecordCount: 9, errorRecordCount: 1, inputTokenCount: 5000, outputTokenCount: 2000 });
});

test("parseManifest: missing fields default to null, never undefined/NaN", () => {
  assert.deepEqual(parseManifest("{}"), { totalRecordCount: null, processedRecordCount: null, successRecordCount: null, errorRecordCount: null, inputTokenCount: null, outputTokenCount: null });
});

test("parseManifest: unparseable/missing text returns null (never throws) -- a broken manifest must not block real per-record reconciliation", () => {
  assert.equal(parseManifest("not json"), null);
  assert.equal(parseManifest(""), null);
  assert.equal(parseManifest(undefined), null);
});

// =========================================================================================
// createModelInvocationJob (dependency-injected fetchImpl -- no real network, no subprocess)
// =========================================================================================

function fakeCreateResponse(jobArn = "arn:aws:bedrock:us-east-1:900915535335:model-invocation-job/aaaabbbbcccc") {
  return async (url, opts) => {
    fakeCreateResponse.lastCall = { url: String(url), opts };
    return new Response(JSON.stringify({ jobArn }), { status: 200 });
  };
}

test("createModelInvocationJob: POSTs to the exact control-plane host/path from the live API reference", async () => {
  const fetchImpl = fakeCreateResponse();
  await createModelInvocationJob({
    jobName: "test-job", roleArn: "arn:aws:iam::900915535335:role/TestRole", modelId: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    inputS3Uri: "s3://bucket/in.jsonl", outputS3Uri: "s3://bucket/out/", region: "us-east-1", fetchImpl, creds: FAKE_CREDS,
  });
  const call = fakeCreateResponse.lastCall;
  assert.equal(new URL(call.url).host, "bedrock.us-east-1.amazonaws.com");
  assert.equal(new URL(call.url).pathname, "/model-invocation-job");
  assert.equal(call.opts.method, "POST");
});

test("createModelInvocationJob: body matches the documented shape exactly -- modelInvocationType:Converse, nested s3InputDataConfig/s3OutputDataConfig, no per-record modelId leakage", async () => {
  const fetchImpl = fakeCreateResponse();
  await createModelInvocationJob({
    jobName: "test-job", roleArn: "arn:aws:iam::900915535335:role/TestRole", modelId: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    inputS3Uri: "s3://bucket/in.jsonl", outputS3Uri: "s3://bucket/out/", timeoutDurationInHours: 48, region: "us-east-1", fetchImpl, creds: FAKE_CREDS,
  });
  const body = JSON.parse(fakeCreateResponse.lastCall.opts.body);
  assert.deepEqual(body, {
    jobName: "test-job",
    roleArn: "arn:aws:iam::900915535335:role/TestRole",
    modelId: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    modelInvocationType: "Converse",
    inputDataConfig: { s3InputDataConfig: { s3Uri: "s3://bucket/in.jsonl" } },
    outputDataConfig: { s3OutputDataConfig: { s3Uri: "s3://bucket/out/" } },
    timeoutDurationInHours: 48,
  });
});

test("createModelInvocationJob: timeoutDurationInHours clamps into AWS's documented [24,168] range rather than rejecting an out-of-range value", async () => {
  // fakeCreateResponse() stashes each call's {url, opts} on the FACTORY function itself
  // (fakeCreateResponse.lastCall), not on the returned fetchImpl closure -- read it back from
  // there after each call, not from the local `low`/`high`/`dflt` bindings (which are just the
  // returned functions and carry no properties of their own).
  await createModelInvocationJob({ jobName: "t", roleArn: "r", modelId: "m", inputS3Uri: "s3://b/i.jsonl", outputS3Uri: "s3://b/o/", timeoutDurationInHours: 1, fetchImpl: fakeCreateResponse(), creds: FAKE_CREDS });
  assert.equal(JSON.parse(fakeCreateResponse.lastCall.opts.body).timeoutDurationInHours, 24);

  await createModelInvocationJob({ jobName: "t", roleArn: "r", modelId: "m", inputS3Uri: "s3://b/i.jsonl", outputS3Uri: "s3://b/o/", timeoutDurationInHours: 999, fetchImpl: fakeCreateResponse(), creds: FAKE_CREDS });
  assert.equal(JSON.parse(fakeCreateResponse.lastCall.opts.body).timeoutDurationInHours, 168);

  await createModelInvocationJob({ jobName: "t", roleArn: "r", modelId: "m", inputS3Uri: "s3://b/i.jsonl", outputS3Uri: "s3://b/o/", fetchImpl: fakeCreateResponse(), creds: FAKE_CREDS });
  assert.equal(JSON.parse(fakeCreateResponse.lastCall.opts.body).timeoutDurationInHours, 24, "omitted timeout defaults to the minimum, not a hardcoded 0 or undefined");
});

test("createModelInvocationJob: returns {jobArn, jobId} parsed from a real 200 response", async () => {
  const res = await createModelInvocationJob({
    jobName: "t", roleArn: "r", modelId: "m", inputS3Uri: "s3://b/i.jsonl", outputS3Uri: "s3://b/o/",
    fetchImpl: fakeCreateResponse("arn:aws:bedrock:us-east-1:900915535335:model-invocation-job/ffffeeeeaaaa"),
    creds: FAKE_CREDS,
  });
  assert.deepEqual(res, { jobArn: "arn:aws:bedrock:us-east-1:900915535335:model-invocation-job/ffffeeeeaaaa", jobId: "ffffeeeeaaaa" });
});

test("createModelInvocationJob: throws with the response body's detail on a non-2xx", async () => {
  const fetchImpl = async () => new Response("Input validation failed: modelId not found", { status: 400 });
  await assert.rejects(
    () => createModelInvocationJob({ jobName: "t", roleArn: "r", modelId: "m", inputS3Uri: "s3://b/i.jsonl", outputS3Uri: "s3://b/o/", fetchImpl, creds: FAKE_CREDS }),
    /CreateModelInvocationJob 400.*Input validation failed/s,
  );
});

test("createModelInvocationJob: throws (never a silent undefined) when the 2xx response carries no jobArn", async () => {
  const fetchImpl = async () => new Response("{}", { status: 200 });
  await assert.rejects(
    () => createModelInvocationJob({ jobName: "t", roleArn: "r", modelId: "m", inputS3Uri: "s3://b/i.jsonl", outputS3Uri: "s3://b/o/", fetchImpl, creds: FAKE_CREDS }),
    /returned no jobArn/,
  );
});

test("createModelInvocationJob: validates every required field BEFORE any network call", async () => {
  let called = false;
  const fetchImpl = async () => { called = true; return new Response("{}", { status: 200 }); };
  for (const missing of ["jobName", "roleArn", "modelId", "inputS3Uri", "outputS3Uri"]) {
    const args = { jobName: "t", roleArn: "r", modelId: "m", inputS3Uri: "s3://b/i.jsonl", outputS3Uri: "s3://b/o/", fetchImpl };
    delete args[missing];
    await assert.rejects(() => createModelInvocationJob(args), new RegExp(`requires "${missing}"`));
  }
  assert.equal(called, false, "no fetch call should ever be made when a required field is missing");
});

// =========================================================================================
// getModelInvocationJob (dependency-injected fetchImpl)
// =========================================================================================

test("getModelInvocationJob: GETs the exact documented path with the jobIdentifier in the path (short id, no query string)", async () => {
  let seen = null;
  const fetchImpl = async (url, opts) => {
    seen = { url: String(url), method: opts?.method || "GET" };
    return new Response(JSON.stringify({ status: "InProgress", totalRecordCount: 100, processedRecordCount: 40 }), { status: 200 });
  };
  const job = await getModelInvocationJob({ jobIdentifier: "abc123def456", region: "us-east-1", fetchImpl, creds: FAKE_CREDS });
  assert.equal(new URL(seen.url).host, "bedrock.us-east-1.amazonaws.com");
  assert.equal(new URL(seen.url).pathname, "/model-invocation-job/abc123def456");
  assert.equal(seen.method, "GET");
  assert.equal(job.status, "InProgress");
  assert.equal(job.processedRecordCount, 40);
});

test("getModelInvocationJob: returns the response object AS-IS, no reshaping (a caller reading an unmentioned field still gets it)", async () => {
  const raw = { status: "Completed", totalRecordCount: 5, processedRecordCount: 5, successRecordCount: 5, errorRecordCount: 0, jobArn: "x", jobName: "y", modelInvocationType: "Converse", someFutureFieldNotYetDocumented: "z" };
  const fetchImpl = async () => new Response(JSON.stringify(raw), { status: 200 });
  const job = await getModelInvocationJob({ jobIdentifier: "abc123def456", fetchImpl, creds: FAKE_CREDS });
  assert.deepEqual(job, raw);
});

test("getModelInvocationJob: throws on a non-2xx (a 404 for an unknown job id is a real error, never 'not ready yet')", async () => {
  const fetchImpl = async () => new Response("ResourceNotFoundException", { status: 404 });
  await assert.rejects(() => getModelInvocationJob({ jobIdentifier: "abc123def456", fetchImpl, creds: FAKE_CREDS }), /GetModelInvocationJob 404/);
});

test("getModelInvocationJob: throws on an unparseable 2xx body rather than returning garbage", async () => {
  const fetchImpl = async () => new Response("not json", { status: 200 });
  await assert.rejects(() => getModelInvocationJob({ jobIdentifier: "abc123def456", fetchImpl, creds: FAKE_CREDS }), /unparseable JSON/);
});

test("getModelInvocationJob: requires jobIdentifier before any network call", async () => {
  let called = false;
  await assert.rejects(() => getModelInvocationJob({ fetchImpl: async () => { called = true; return new Response("{}"); } }), /requires jobIdentifier/);
  assert.equal(called, false);
});

test("getModelInvocationJob: a full jobArn (containing '/' and ':') produces the EXACT wire path live-verified against the real Bedrock control plane 2026-09-03 -- single-encoded, no double-encoding regression", async () => {
  // This is the real, live-verified wire path from this fleet's own 2026-09-03 pilot job
  // (arn:aws:bedrock:us-east-1:900915535335:model-invocation-job/tcf29in6w6ts, HTTP 200 confirmed
  // both through this file's own code and independently via the AWS CLI). A regression back to
  // either of the two broken variants this replaced (see opensearch-client.mjs's canonicalUri() doc
  // comment) would change this exact string.
  const arn = "arn:aws:bedrock:us-east-1:900915535335:model-invocation-job/tcf29in6w6ts";
  let seenPath = null;
  const fetchImpl = async (url) => { seenPath = new URL(url).pathname; return new Response(JSON.stringify({ status: "Completed" }), { status: 200 }); };
  await getModelInvocationJob({ jobIdentifier: arn, region: "us-east-1", fetchImpl, creds: FAKE_CREDS });
  assert.equal(seenPath, "/model-invocation-job/arn%3Aaws%3Abedrock%3Aus-east-1%3A900915535335%3Amodel-invocation-job%2Ftcf29in6w6ts");
  assert.doesNotMatch(seenPath, /%25/, "must never contain a re-encoded percent sign -- the exact double-encoding bug this test locks against");
});

test("getModelInvocationJob: a bare short id (no '/', no ':') is byte-identical to the pre-fix path shape -- the array-input change is additive, not a regression for the simple case", async () => {
  let seenPath = null;
  const fetchImpl = async (url) => { seenPath = new URL(url).pathname; return new Response(JSON.stringify({ status: "InProgress" }), { status: 200 }); };
  await getModelInvocationJob({ jobIdentifier: "abc123def456", fetchImpl, creds: FAKE_CREDS });
  assert.equal(seenPath, "/model-invocation-job/abc123def456");
});

// =========================================================================================
// credential-missing behavior (mirrors enrich-llm.test.mjs's identical ENV_KEYS save/restore
// technique for callBedrockChat's real-converseJson default -- same fail-closed contract, same
// AWS credential chain, so the same test shape applies to the control-plane calls too).
// =========================================================================================

test("createModelInvocationJob / getModelInvocationJob: both throw a clear 'AWS credentials unavailable' error (not a network timeout) when no AWS credentials resolve at all, with the DEFAULT fetchImpl", async () => {
  const ENV_KEYS = ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "OTC_AWS_ACCESS_KEY_ID", "OTC_AWS_SECRET_ACCESS_KEY", "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", "AWS_CONTAINER_CREDENTIALS_FULL_URI"];
  const saved = {};
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  try {
    await assert.rejects(
      () => createModelInvocationJob({ jobName: "t", roleArn: "r", modelId: "m", inputS3Uri: "s3://b/i.jsonl", outputS3Uri: "s3://b/o/" }),
      /AWS credentials unavailable/,
    );
    await assert.rejects(
      () => getModelInvocationJob({ jobIdentifier: "abc123def456" }),
      /AWS credentials unavailable/,
    );
  } finally {
    for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
});

// =========================================================================================
// S3-staging wrapper argument validation (throws BEFORE any network call -- no stub needed)
// =========================================================================================

test("putBatchInputFile: requires bucket + key before any S3 call", async () => {
  await assert.rejects(() => putBatchInputFile({ key: "k", jsonlText: "{}" }), /requires bucket \+ key/);
  await assert.rejects(() => putBatchInputFile({ bucket: "b", jsonlText: "{}" }), /requires bucket \+ key/);
});

test("listBatchOutputFiles: requires bucket before any S3 call", async () => {
  await assert.rejects(() => listBatchOutputFiles({}), /requires bucket/);
});

test("getBatchOutputFileText: requires bucket + key before any S3 call", async () => {
  await assert.rejects(() => getBatchOutputFileText({ key: "k" }), /requires bucket \+ key/);
  await assert.rejects(() => getBatchOutputFileText({ bucket: "b" }), /requires bucket \+ key/);
});
