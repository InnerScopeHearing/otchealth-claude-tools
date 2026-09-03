// Tests for skills/doc-indexer/enrich.mjs's `--bedrock-batch` lane (2026-09-03): the submit/poll/
// collect wiring inside buildAndSubmitBedrockBatch(), its dry-run mode, its resume-marker
// mechanics, and its per-row reconciliation on a full/partial/missing/failed Bedrock batch job.
//
// Follows this directory's own established THREE-LAYER convention for a hard-to-mock CLI script
// (see tests/enrich-llm.test.mjs's header, and tests/storage-backend-default.test.mjs's) --
//   1. Source-level regression locks -- fast, hermetic, no subprocess -- for the ONE property that
//      cannot be proven behaviorally without also proving the outer cmdRun() gate would already
//      have caught it first (the belt-and-suspenders isLegalPersonalRoom() re-check INSIDE
//      buildAndSubmitBedrockBatch() itself; the task this file exists for is explicit that the
//      refusal must be preserved on "every new code path", not merely inherited).
//   2. Subprocess CLI-level validation (no network reached) -- --bedrock-batch is accepted, and
//      legal/personal is refused operationally before ANY network call, exactly like every other
//      provider/flag combination already tested in enrich-llm.test.mjs.
//   3. Full subprocess integration using the `--import` global-fetch-stub technique (extended from
//      enrich-llm.test.mjs's own version to stub THREE hosts instead of two: the document room's
//      S3, the Bedrock CONTROL PLANE (a different host from the runtime Converse endpoint), and a
//      SEPARATE batch-staging S3 bucket) -- proves the actual wire shapes this lane builds, the
//      dry-run/no-network guarantee, the marker-write-before-poll ordering, the resume-without-
//      resubmission property, and the fail-loud-on-a-short-result-set reconciliation contract.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const execFileP = promisify(execFile);
const HERE = fileURLToPath(new URL(".", import.meta.url));
const ENRICH_MJS = join(HERE, "..", "enrich.mjs");

// =========================================================================================
// Layer 1: source-level regression lock
// =========================================================================================

test("source-level: buildAndSubmitBedrockBatch() contains its OWN isLegalPersonalRoom re-check -- the refusal must not rely SOLELY on cmdRun()'s outer gate", () => {
  const src = readFileSync(ENRICH_MJS, "utf8");
  const fnStart = src.indexOf("async function buildAndSubmitBedrockBatch(todo)");
  assert.ok(fnStart > -1, "buildAndSubmitBedrockBatch must exist");
  const fnBody = src.slice(fnStart, src.indexOf("\nasync function ", fnStart + 10));
  assert.match(fnBody, /isLegalPersonalRoom\(PROFILE, effectiveContainer\)/, "the function body must re-check isLegalPersonalRoom itself, not just trust a caller already checked");
  assert.match(fnBody, /throw new Error/, "the re-check must THROW (aborting this function specifically), not merely log");
});

test("source-level: polling uses marker.jobArn, never marker.jobId -- live-verified 2026-09-03 that the short id is rejected by the real Bedrock API", () => {
  const src = readFileSync(ENRICH_MJS, "utf8");
  const fnStart = src.indexOf("async function buildAndSubmitBedrockBatch(todo)");
  const fnBody = src.slice(fnStart, src.indexOf("\nasync function ", fnStart + 10));
  assert.match(fnBody, /getModelInvocationJob\(\{ jobIdentifier: marker\.jobArn/, "must poll with the full jobArn");
  assert.doesNotMatch(fnBody, /getModelInvocationJob\(\{ jobIdentifier: marker\.jobId/, "must never poll with the short id -- see bedrock-batch-client.mjs's getModelInvocationJob doc comment for why");
});

test("source-level: the safety cap (BEDROCK_BATCH_MAX_RECORDS) is checked before any JSONL line is built or any network call", () => {
  const src = readFileSync(ENRICH_MJS, "utf8");
  const fnStart = src.indexOf("async function buildAndSubmitBedrockBatch(todo)");
  const fnBody = src.slice(fnStart, src.indexOf("\nasync function ", fnStart + 10));
  const capIdx = fnBody.indexOf("BEDROCK_BATCH_MAX_RECORDS");
  const buildLinesIdx = fnBody.indexOf("buildConverseBatchLine");
  assert.ok(capIdx > -1 && buildLinesIdx > -1 && capIdx < buildLinesIdx, "the max-records cap check must appear before any buildConverseBatchLine call in source order");
});

// =========================================================================================
// Layer 2: CLI-level validation (subprocess, no network reached)
// =========================================================================================

function run(args, envExtra = {}) {
  try {
    const stdout = execFileSync("node", [ENRICH_MJS, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...envExtra } });
    return { status: 0, stdout, stderr: "" };
  } catch (e) {
    return { status: e.status, stdout: e.stdout || "", stderr: e.stderr || "" };
  }
}

test("--bedrock-batch is accepted (does not break argv parsing) and does not itself require --llm-provider bedrock to parse -- provider mismatch is a semantic no-op, not a CLI error", () => {
  const r = run(["run", "--bedrock-batch", "--profile", "finance", "--azure-account", "otchealthcfodata", "--container", "no-such-room-fixture-batchflag"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /no S3 mirror mapping/, "must fail at the SAME later gate an unmapped room hits under any other flag combination -- --bedrock-batch must not add a NEW earlier failure mode");
});

test("legal/personal is refused under --bedrock-batch specifically, before any network call, exit code 2", () => {
  const r = run(["run", "--profile", "legal", "--container", "personal", "--llm-provider", "bedrock", "--bedrock-batch"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /REFUSED.*legal.*personal.*attorney-client-privileged/is);
});

test("legal/personal is refused under --bedrock-batch --dry-run too -- dry-run must never be a way around the refusal", () => {
  const r = run(["run", "--profile", "legal", "--container", "personal", "--llm-provider", "bedrock", "--bedrock-batch", "--dry-run"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /REFUSED/i);
});

// =========================================================================================
// Layer 3: full subprocess integration (three stubbed hosts)
// =========================================================================================

const S3_BUCKET = "otchealth-finance-legal-dr-55c84f6b";
const S3_KEY_PREFIX = "otchealthcfodata/cfo-source-docs/";
const S3_HOST = `${S3_BUCKET}.s3.us-east-1.amazonaws.com`;
const BEDROCK_CONTROL_HOST = "bedrock.us-east-1.amazonaws.com";
const STAGING_BUCKET = "test-bedrock-batch-bucket";
const STAGING_HOST = `${STAGING_BUCKET}.s3.us-east-1.amazonaws.com`;
const MARKER_PATH = "_CATALOG/.enrich-bedrock-batch.json";

function isHost(u, host) { try { return new URL(u).host === host; } catch { return false; } }
function pathOf(u) { try { return new URL(u).pathname; } catch { return ""; } }
function queryOf(u) { try { return Object.fromEntries(new URL(u).searchParams); } catch { return {}; } }

const ROW_A = { path: "test/batch-a.md", sidecar: true, title: "Batch Fixture A", entity: "OTCHealth", category: "testing", sha256: "shaBatchA" };
const ROW_B = { path: "test/batch-b.md", sidecar: true, title: "Batch Fixture B", entity: "OTCHealth", category: "testing", sha256: "shaBatchB" };
const FAKE_JOB_ARN = "arn:aws:bedrock:us-east-1:900915535335:model-invocation-job/aaaabbbbcccc";
const FAKE_JOB_ID = "aaaabbbbcccc";

function s3ListXml(prefix, keys) {
  const contents = keys.map((k) => `<Contents><Key>${prefix}${k}</Key><Size>10</Size><LastModified>2026-09-03T00:00:00.000Z</LastModified></Contents>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult>${contents}<IsTruncated>false</IsTruncated></ListBucketResult>`;
}

/**
 * Build the preload script's source. `opts.catalogRows` seeds the doc-room catalog. `opts.marker`,
 * if given, is written verbatim as the PRE-EXISTING resume marker (so the run resumes it instead of
 * submitting a new job). `opts.jobStatusSequence` is the status GetModelInvocationJob returns on
 * each successive poll call (the LAST entry repeats if polled more times than entries provided).
 * `opts.outputLines` / `opts.manifest` are what the staging bucket's LIST+GET-object calls return
 * for a FRESH submission (the label is unpredictable -- see the LIST handler's prefix-echo below);
 * for a RESUME test, `opts.marker.outputPrefix` is known up front so the same generic handler
 * still works unmodified.
 */
function preloadSource(logPath, catalogFlushPath, opts) {
  const { catalogRows, marker = null, jobStatusSequence = ["Completed"], outputLines = [], manifest = null, createJobShouldFail = false } = opts;
  return `
import { appendFileSync, writeFileSync, readFileSync, existsSync } from "node:fs";
function isHost(u, host) { try { return new URL(u).host === host; } catch { return false; } }
function pathOf(u) { try { return new URL(u).pathname; } catch { return ""; } }
function queryOf(u) { try { return Object.fromEntries(new URL(u).searchParams); } catch { return {}; } }
const CATALOG_ROWS = ${JSON.stringify(catalogRows)};
const MARKER_SEED = ${JSON.stringify(marker)};
const JOB_STATUS_SEQUENCE = ${JSON.stringify(jobStatusSequence)};
const OUTPUT_LINES = ${JSON.stringify(outputLines)};
const MANIFEST = ${JSON.stringify(manifest)};
let pollCount = 0;
let markerState = MARKER_SEED ? JSON.stringify(MARKER_SEED) : null;

globalThis.fetch = async (url, opts2) => {
  const u = String(typeof url === "string" ? url : url?.url || url);
  const method = (opts2 && opts2.method) || "GET";
  const bodyStr = opts2 && opts2.body ? String(opts2.body) : null;
  appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ method, url: u, body: bodyStr ? bodyStr.slice(0, 6000) : null }) + "\\n");

  // ---- document-room S3 ----
  if (isHost(u, ${JSON.stringify(S3_HOST)})) {
    const p = pathOf(u);
    if (method === "GET" && p === ${JSON.stringify("/" + S3_KEY_PREFIX + "_CATALOG/catalog.jsonl")}) {
      return new Response(CATALOG_ROWS.map((r) => JSON.stringify(r)).join("\\n") + "\\n", { status: 200 });
    }
    for (const r of CATALOG_ROWS) {
      if (method === "GET" && p === ${JSON.stringify("/" + S3_KEY_PREFIX + "_TEXT/")} + r.path + ".txt") {
        return new Response("Full extracted text for " + r.path, { status: 200 });
      }
    }
    if (method === "GET" && p === ${JSON.stringify("/" + S3_KEY_PREFIX + "_CATALOG/.enrich.lock")}) {
      return new Response("not found", { status: 404 });
    }
    if (p === ${JSON.stringify("/" + S3_KEY_PREFIX + MARKER_PATH)}) {
      if (method === "GET") {
        return markerState ? new Response(markerState, { status: 200 }) : new Response("not found", { status: 404 });
      }
      if (method === "PUT") { markerState = bodyStr; return new Response("", { status: 200 }); }
      if (method === "DELETE") { markerState = null; return new Response("", { status: 200 }); }
    }
    if (method === "PUT" && p === ${JSON.stringify("/" + S3_KEY_PREFIX + "_CATALOG/catalog.jsonl")}) {
      writeFileSync(${JSON.stringify(catalogFlushPath)}, String(bodyStr));
      return new Response("", { status: 200 });
    }
    if (method === "PUT" || method === "DELETE") return new Response("", { status: 200 }); // lock/review-queue writes
    return new Response("not found", { status: 404 });
  }

  // ---- Bedrock control plane (batch) ----
  if (isHost(u, ${JSON.stringify(BEDROCK_CONTROL_HOST)})) {
    const p = pathOf(u);
    if (method === "POST" && p === "/model-invocation-job") {
      if (${JSON.stringify(createJobShouldFail)}) return new Response("TEST FAILURE: should not have submitted a new job (a marker already existed)", { status: 500 });
      return new Response(JSON.stringify({ jobArn: ${JSON.stringify(FAKE_JOB_ARN)} }), { status: 200 });
    }
    if (method === "GET" && p.startsWith("/model-invocation-job/")) {
      const status = JOB_STATUS_SEQUENCE[Math.min(pollCount, JOB_STATUS_SEQUENCE.length - 1)];
      pollCount++;
      return new Response(JSON.stringify({ status, totalRecordCount: CATALOG_ROWS.length, processedRecordCount: CATALOG_ROWS.length, message: status === "Failed" ? "TEST: simulated Bedrock job failure" : undefined }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }

  // ---- batch-staging S3 bucket ----
  if (isHost(u, ${JSON.stringify(STAGING_HOST)})) {
    const p = pathOf(u);
    if (method === "PUT" && p.endsWith("/input.jsonl")) return new Response("", { status: 200 });
    if (method === "GET" && p === "/") {
      const q = queryOf(u);
      const prefix = q.prefix || "";
      const keys = ["part-0.jsonl.out", "manifest.json.out"];
      return new Response(${JSON.stringify("__S3LISTXML__")}.replace("__PREFIX__", prefix).replace("__KEYS__", JSON.stringify(keys)), { status: 200, headers: { "content-type": "application/xml" } });
    }
    if (method === "GET" && p.endsWith("manifest.json.out")) {
      return new Response(MANIFEST ? JSON.stringify(MANIFEST) : "{}", { status: 200 });
    }
    if (method === "GET" && p.endsWith("part-0.jsonl.out")) {
      return new Response(OUTPUT_LINES.map((l) => JSON.stringify(l)).join("\\n") + "\\n", { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }

  return new Response("not found (unstubbed host: " + u + ")", { status: 404 });
};
`.replace('"__S3LISTXML__"', JSON.stringify(s3ListXml("__PREFIX__", ["part-0.jsonl.out", "manifest.json.out"])));
}

function runEnrichBedrockBatch(args, opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), "enrich-bedrock-batch-test-"));
  const logPath = join(dir, "calls.log");
  const catalogFlushPath = join(dir, "catalog-flush.jsonl");
  writeFileSync(logPath, "");
  writeFileSync(catalogFlushPath, "");
  const preload = join(dir, "preload.mjs");
  writeFileSync(preload, preloadSource(logPath, catalogFlushPath, opts));
  const env = {
    PATH: process.env.PATH,
    AWS_ACCESS_KEY_ID: "AKIAUNITTESTFAKE0000",
    AWS_SECRET_ACCESS_KEY: "unit-test-fake-secret-access-key-not-real",
    ENRICH_BEDROCK_BATCH_BUCKET: STAGING_BUCKET,
    ENRICH_BEDROCK_BATCH_ROLE_ARN: "arn:aws:iam::900915535335:role/TestBedrockBatchRole",
    ...(opts.envExtra || {}),
  };
  return execFileP(process.execPath, ["--import", preload, ENRICH_MJS, "run", "--profile", "finance", "--s3", "--llm-provider", "bedrock", "--bedrock-batch", ...args], { env, timeout: 30000 })
    .then((r) => ({ status: 0, stdout: r.stdout, stderr: r.stderr, calls: readCalls(logPath), catalogFlush: readCatalogFlush(catalogFlushPath) }))
    .catch((e) => ({ status: e.code ?? 1, stdout: e.stdout || "", stderr: e.stderr || "", calls: readCalls(logPath), catalogFlush: readCatalogFlush(catalogFlushPath) }));
}
function readCalls(logPath) { return readFileSync(logPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); }
function readCatalogFlush(p) {
  const raw = readFileSync(p, "utf8").trim();
  if (!raw) return null;
  return raw.split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

// ---- dry run: network-free ----

test("--dry-run: makes ZERO calls to the Bedrock control plane or the staging bucket, and needs NEITHER ENRICH_BEDROCK_BATCH_BUCKET NOR ROLE_ARN set at all", async () => {
  const r = await runEnrichBedrockBatch(["--dry-run"], {
    catalogRows: [ROW_A],
    envExtra: { ENRICH_BEDROCK_BATCH_BUCKET: "", ENRICH_BEDROCK_BATCH_ROLE_ARN: "" },
  });
  assert.equal(r.status, 0, `expected a clean exit; stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  const stray = r.calls.filter((c) => isHost(c.url, BEDROCK_CONTROL_HOST) || isHost(c.url, STAGING_HOST));
  assert.deepEqual(stray, [], "a dry run must reach neither the Bedrock control plane nor the staging bucket");
  assert.match(r.stdout, /BEDROCK_BATCH DRY RUN: would submit 1 record/);
  assert.match(r.stdout, /nothing submitted -- no S3 upload and no CreateModelInvocationJob call were made/);
  assert.equal(r.catalogFlush, null, "a dry run must never flush the catalog -- nothing was actually enriched");
});

test("--dry-run: reports a NOTE when a resume marker already exists, without touching it (no GET-then-poll, no delete)", async () => {
  const marker = { jobArn: FAKE_JOB_ARN, jobId: FAKE_JOB_ID, submittedAt: "2026-09-03T00:00:00.000Z", recordIds: [ROW_A.path], bucket: STAGING_BUCKET, outputPrefix: "doc-indexer-enrich-batches/x/output/" };
  const r = await runEnrichBedrockBatch(["--dry-run"], { catalogRows: [ROW_A], marker });
  assert.equal(r.status, 0);
  assert.match(r.stdout, new RegExp(`already recorded in flight.*jobId=${FAKE_JOB_ID}`));
  const stray = r.calls.filter((c) => isHost(c.url, BEDROCK_CONTROL_HOST) || isHost(c.url, STAGING_HOST));
  assert.deepEqual(stray, [], "dry run must still make no network call even when a marker exists");
});

// ---- the safety cap ----

test("BEDROCK_BATCH_MAX_RECORDS: a too-large batch is refused before any network call, even under --dry-run", async () => {
  const r = await runEnrichBedrockBatch(["--dry-run"], { catalogRows: [ROW_A, ROW_B], envExtra: { ENRICH_BEDROCK_BATCH_MAX_RECORDS: "1" } });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /ERROR: BEDROCK_BATCH: 2 row\(s\) need enrichment, above the 1-row safety cap/);
  const stray = r.calls.filter((c) => isHost(c.url, BEDROCK_CONTROL_HOST) || isHost(c.url, STAGING_HOST));
  assert.deepEqual(stray, [], "the cap must be enforced before any network call");
});

// ---- fresh submission: ordering + a total job failure ----

test("fresh submission, job FAILS: marker is written BEFORE polling starts, the run exits non-zero, the catalog is never flushed, and the marker is left in place (not deleted)", async () => {
  const r = await runEnrichBedrockBatch([], { catalogRows: [ROW_A], jobStatusSequence: ["Failed"] });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /ERROR: BEDROCK_BATCH: job aaaabbbbcccc ended in terminal FAILURE status "Failed": TEST: simulated Bedrock job failure/);

  const inputPut = r.calls.find((c) => isHost(c.url, STAGING_HOST) && c.method === "PUT");
  const createJob = r.calls.find((c) => isHost(c.url, BEDROCK_CONTROL_HOST) && c.method === "POST");
  const markerPut = r.calls.find((c) => isHost(c.url, S3_HOST) && c.method === "PUT" && pathOf(c.url).endsWith("enrich-bedrock-batch.json"));
  const poll = r.calls.find((c) => isHost(c.url, BEDROCK_CONTROL_HOST) && c.method === "GET");
  assert.ok(inputPut && createJob && markerPut && poll, "all four calls must have happened");
  assert.deepEqual(JSON.parse(createJob.body).modelInvocationType, "Converse");
  const markerBody = JSON.parse(markerPut.body);
  assert.equal(markerBody.jobId, FAKE_JOB_ID);
  assert.deepEqual(markerBody.recordIds, [ROW_A.path]);
  // The poll must target the FULL jobArn, correctly single-encoded as one atomic path segment
  // (the ARN's own '/' as %2F, colons as %3A, no double-encoded %25...) -- the exact live-verified
  // shape from bedrock-batch-client.mjs's 2026-09-03 fix, not just "some GET happened".
  assert.equal(pathOf(poll.url), `/model-invocation-job/${encodeURIComponent(FAKE_JOB_ARN)}`);
  assert.doesNotMatch(pathOf(poll.url), /%25/, "must never be double-encoded");

  // ORDERING: the marker PUT must precede the first poll GET -- this is the property that makes a
  // process kill immediately after submission still resumable.
  const order = r.calls.map((c) => `${c.method} ${pathOf(c.url)}`);
  const markerPutIdx = order.findIndex((s) => s.includes("PUT") && s.endsWith("enrich-bedrock-batch.json"));
  const pollIdx = order.findIndex((s) => s.startsWith("GET /model-invocation-job/"));
  assert.ok(markerPutIdx > -1 && pollIdx > -1 && markerPutIdx < pollIdx, `marker PUT must precede the first poll: ${JSON.stringify(order)}`);

  const markerDelete = r.calls.find((c) => isHost(c.url, S3_HOST) && c.method === "DELETE" && pathOf(c.url).endsWith("enrich-bedrock-batch.json"));
  assert.equal(markerDelete, undefined, "a FAILED job must leave the marker in place as evidence, never delete it");
  assert.equal(r.catalogFlush, null, "nothing was ever enriched -- the worker pool never starts when the batch submission throws");
});

// ---- resume: no double submission, full reconciliation, cleanup ----

test("resume: with a pre-existing marker, NO new job is submitted; the SAME job is polled, reconciled successfully, and the marker is deleted afterward", async () => {
  const marker = { jobArn: FAKE_JOB_ARN, jobId: FAKE_JOB_ID, submittedAt: "2026-09-03T00:00:00.000Z", recordIds: [ROW_A.path], bucket: STAGING_BUCKET, outputPrefix: "doc-indexer-enrich-batches/resume-test/output/" };
  const outputLines = [{ recordId: ROW_A.path, modelInput: {}, modelOutput: { output: { message: { content: [{ text: '{"doc_title":"Resumed Fixture","doc_type":"other","keywords":["resume"],"confidence":"high"}' }] } }, usage: { inputTokens: 500, outputTokens: 40 } } }];
  const manifest = { totalRecordCount: 1, processedRecordCount: 1, successRecordCount: 1, errorRecordCount: 0, inputTokenCount: 500, outputTokenCount: 40 };
  const r = await runEnrichBedrockBatch([], { catalogRows: [ROW_A], marker, jobStatusSequence: ["Completed"], outputLines, manifest, createJobShouldFail: true });
  assert.equal(r.status, 0, `expected a clean exit; stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  // Progress lines go to stderr in this file (mirroring OPENAI_BATCH's own convention -- only the
  // final run summary line uses console.log); see cmdRun()'s existing "[enrich] domain=..." line.
  assert.match(r.stderr, new RegExp(`resuming an already-submitted job \\(jobId=${FAKE_JOB_ID}`));

  const createJobCalls = r.calls.filter((c) => isHost(c.url, BEDROCK_CONTROL_HOST) && c.method === "POST");
  assert.deepEqual(createJobCalls, [], "resume must NEVER call CreateModelInvocationJob again");
  const inputPuts = r.calls.filter((c) => isHost(c.url, STAGING_HOST) && c.method === "PUT");
  assert.deepEqual(inputPuts, [], "resume must NEVER re-upload the input JSONL either");

  assert.ok(r.catalogFlush, "the catalog must have been flushed");
  const rowA = r.catalogFlush.find((row) => row.path === ROW_A.path);
  assert.equal(rowA.enriched, true);
  assert.equal(rowA.enriched_sha256, ROW_A.sha256);
  assert.equal(rowA.doc_title, "Resumed Fixture");

  const markerDelete = r.calls.find((c) => isHost(c.url, S3_HOST) && c.method === "DELETE" && pathOf(c.url).endsWith("enrich-bedrock-batch.json"));
  assert.ok(markerDelete, "the marker must be deleted once every row it named has been reconciled");
  assert.match(r.stdout, /llm: 1\/1 calls ok/);
});

// ---- fresh submission: full success, proving the wire shapes end to end ----

test("fresh submission, job Completes cleanly: the input JSONL is Converse-shaped with no toolConfig, the row is enriched, and the marker is deleted", async () => {
  const outputLines = [{ recordId: ROW_A.path, modelInput: {}, modelOutput: { output: { message: { content: [{ text: '{"doc_title":"Fresh Batch Fixture","confidence":"high"}' }] } }, usage: { inputTokens: 300, outputTokens: 20 } } }];
  const r = await runEnrichBedrockBatch([], { catalogRows: [ROW_A], jobStatusSequence: ["Completed"], outputLines });
  assert.equal(r.status, 0, `expected a clean exit; stdout: ${r.stdout}\nstderr: ${r.stderr}`);

  const inputPut = r.calls.find((c) => isHost(c.url, STAGING_HOST) && c.method === "PUT");
  const uploaded = JSON.parse(inputPut.body);
  assert.equal(uploaded.recordId, ROW_A.path);
  assert.equal(uploaded.modelInput.toolConfig, undefined, "batch inference does not support tool calling -- the uploaded line must never carry a toolConfig block");
  assert.ok(uploaded.modelInput.messages[0].content[0].text.includes("Full extracted text for " + ROW_A.path), "the document text must actually be in the uploaded batch line");

  const createJob = r.calls.find((c) => isHost(c.url, BEDROCK_CONTROL_HOST) && c.method === "POST");
  const createBody = JSON.parse(createJob.body);
  assert.equal(createBody.modelInvocationType, "Converse");
  const inputKey = pathOf(inputPut.url).replace(/^\//, "");
  assert.equal(createBody.inputDataConfig.s3InputDataConfig.s3Uri, `s3://${STAGING_BUCKET}/${inputKey}`, "the exact key uploaded to must be the exact key CreateModelInvocationJob is told to read");

  const rowA = r.catalogFlush.find((row) => row.path === ROW_A.path);
  assert.equal(rowA.enriched, true);
  assert.equal(rowA.doc_title, "Fresh Batch Fixture");

  const markerDelete = r.calls.find((c) => isHost(c.url, S3_HOST) && c.method === "DELETE" && pathOf(c.url).endsWith("enrich-bedrock-batch.json"));
  assert.ok(markerDelete, "a fully-reconciled Completed job must have its marker deleted");
});

// ---- PartiallyCompleted / a missing record: the core "fail loud on a short result set" contract ----

test("PartiallyCompleted with one record missing from output: the present row IS enriched, the MISSING row is NOT (never silently dropped), the run is a WARN not a FATAL, and the marker is still cleared", async () => {
  const outputLines = [{ recordId: ROW_A.path, modelInput: {}, modelOutput: { output: { message: { content: [{ text: '{"doc_title":"A Only","confidence":"high"}' }] } }, usage: { inputTokens: 100, outputTokens: 10 } } }];
  const manifest = { totalRecordCount: 2, processedRecordCount: 1, successRecordCount: 1, errorRecordCount: 0, inputTokenCount: 100, outputTokenCount: 10 };
  const r = await runEnrichBedrockBatch([], { catalogRows: [ROW_A, ROW_B], jobStatusSequence: ["PartiallyCompleted"], outputLines, manifest });
  assert.equal(r.status, 0, `a partial completion must NOT be a total failure; stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.doesNotMatch(r.stderr, /FATAL: all \d+ LLM call\(s\) failed/);
  assert.match(r.stderr, /WARN: 1\/2 LLM call\(s\) failed/);
  assert.match(r.stderr, /1 record\(s\) had NO result at all in job aaaabbbbcccc's output \(job status=PartiallyCompleted\)/);
  assert.match(r.stderr, new RegExp(ROW_B.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  const rowA = r.catalogFlush.find((row) => row.path === ROW_A.path);
  const rowB = r.catalogFlush.find((row) => row.path === ROW_B.path);
  assert.equal(rowA.enriched, true, "the row that WAS in the output must be enriched");
  assert.equal(rowA.doc_title, "A Only");
  assert.equal(rowB.enriched, false, "the MISSING row must NEVER be marked enriched -- this is the load-bearing contract this test exists to lock down");
  assert.equal(rowB.enriched_sha256, "", "so it is retried on the next run, not permanently skipped");
  assert.ok(rowB.enrich_reasons?.[0]?.includes("LLM call failed"), `expected an 'LLM call failed' reason on the missing row, got: ${JSON.stringify(rowB.enrich_reasons)}`);

  const markerDelete = r.calls.find((c) => isHost(c.url, S3_HOST) && c.method === "DELETE" && pathOf(c.url).endsWith("enrich-bedrock-batch.json"));
  assert.ok(markerDelete, "a PartiallyCompleted job -- terminal, not ambiguous -- must still clear the marker once every named row has SOME outcome (ok, errored, or missing)");
});

test("integration: --bedrock-batch never reaches the interactive Bedrock Converse runtime host, an OpenAI host, or an Azure OpenAI host", async () => {
  const outputLines = [{ recordId: ROW_A.path, modelInput: {}, modelOutput: { output: { message: { content: [{ text: "{}" }] } }, usage: {} } }];
  const r = await runEnrichBedrockBatch([], { catalogRows: [ROW_A], jobStatusSequence: ["Completed"], outputLines });
  const stray = r.calls.filter((c) => /bedrock-runtime\.|api\.openai\.com|openai\.azure\.com|cognitiveservices\.azure\.com/i.test(c.url));
  assert.deepEqual(stray, [], "the batch lane must never fall through to the interactive runtime host or a different provider's endpoint");
});
