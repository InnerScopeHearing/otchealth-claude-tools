// bedrock-batch-client.mjs — minimal, dependency-free AWS Bedrock BATCH inference (control-plane)
// client, plus the small amount of S3 I/O a batch job needs around it (upload the input JSONL,
// list/read the output). Companion to bedrock-client.mjs (the RUNTIME Converse client deep-pass.mjs
// and enrich.mjs's interactive Bedrock lane already use); this file is the CONTROL PLANE
// (CreateModelInvocationJob / GetModelInvocationJob), a different host and a different, much
// coarser-grained API shape (submit a job, poll it, read files it wrote to S3 -- there is no
// per-document request/response here at all).
//
// WHY THIS EXISTS (enrich.mjs's Bedrock BATCH lane, 2026-09-03). enrich.mjs's `--llm-provider
// bedrock` lane (bedrock-client.mjs / enrich-llm.mjs's callBedrockChat, shipped 2026-08-29) is
// already the chosen processor for the two PRIVILEGED rooms this pipeline can reach
// (finance-cfo-source-docs, legal-company) because it runs inside this fleet's own AWS account
// (900915535335) -- see otchealth-cto/CLAUDE.md's 2026-08-19 entry and PILOT-bedrock-enrich.md.
// Bedrock's BATCH inference lane is the SAME model family at roughly half the on-demand price
// (verified live 2026-09-03 against
// https://docs.aws.amazon.com/bedrock/latest/userguide/batch-inference.html and the
// 2024-08 announcement "Amazon Bedrock offers select FMs for batch inference at 50% of on-demand
// inference price") -- exactly the latency-tolerant, large-volume shape the eventual finance/
// legal-company backfill is. This file is the mechanism only; nothing here is wired into a
// scheduled job, and no full backfill has been run (see enrich.mjs's `--bedrock-batch` gate).
//
// **BATCH INFERENCE DOES NOT SUPPORT TOOL USE OR STRUCTURED OUTPUT.** Verbatim from the live AWS
// user guide (fetched 2026-09-03,
// https://docs.aws.amazon.com/bedrock/latest/userguide/batch-inference.html): "Batch inference does
// not support tool calling (function calling) or structured output (`response_format`). Each record
// in the input JSONL file is processed independently without multi-turn interaction, so features
// that require back-and-forth exchanges between the model and client are not available." This holds
// even after Bedrock's 2026-02 "batch inference now supports the Converse API format" update (which
// this file uses -- see below) -- that update added the CONVERSE REQUEST/RESPONSE SHAPE as an
// alternative to InvokeModel's model-specific body, it did not add tool support to batch. So the
// forced-tool-use JSON-mode trick bedrock-client.mjs's converseJson() uses for the INTERACTIVE lane
// (`toolConfig`/`toolChoice`) is not available here. Instead, the batch prompt asks for a single
// JSON object directly in plain text -- EXACTLY what enrich.mjs's enrichSystemPrompt() already does
// ("Output ONLY a JSON object, no prose, matching exactly this schema"), the same instruction the
// openai/azure lanes already rely on via `response_format: json_object`. A batch response therefore
// arrives as an ordinary Converse text content block, parsed with the SAME
// extractJsonObject()/`J()` salvage parser every other lane already uses (first-'{'-to-last-'}'
// fallback for a markdown-fenced or prose-prefixed reply) -- see enrich-llm.mjs's
// parseBedrockBatchModelOutput(). No new parsing strategy was invented for this.
//
// MODEL INVOCATION TYPE: this file ALWAYS submits with `modelInvocationType: "Converse"` (a
// job-level field, not per-record), never the default `InvokeModel` model-specific body shape --
// see createModelInvocationJob() below. This keeps the batch request/response shape aligned with
// the interactive lane's own Converse usage (system/messages/inferenceConfig, `usage.inputTokens`/
// `outputTokens`, `output.message.content`), so enrich-llm.mjs's parsing has one shape to handle,
// not two.
//
// SIGV4 SERVICE NAME: this file signs with `service: "bedrock"`, the SAME signing name
// bedrock-client.mjs already uses (live-verified 2026-08-29) for the DIFFERENT host
// `bedrock-runtime.<region>.amazonaws.com`. AWS assigns one SigV4 signing name per IAM action
// namespace, not per hostname, and both the runtime actions (`bedrock:InvokeModel`,
// `bedrock:Converse`) and the control-plane batch actions this file calls
// (`bedrock:CreateModelInvocationJob`, `bedrock:GetModelInvocationJob`) live under the SAME
// `bedrock:*` IAM namespace (see the batch-inference-permissions.md identity policy, which lists
// `bedrock:CreateModelInvocationJob` etc. as ordinary `bedrock:*` actions, not a separate
// `bedrock-batch:*` namespace). **LIVE-VERIFIED 2026-09-03**, not merely inferred: a real
// `CreateModelInvocationJob` call from this fleet's own account (900915535335) against a freshly
// provisioned S3 staging bucket + IAM service role returned a real `jobArn`
// (`arn:aws:bedrock:us-east-1:900915535335:model-invocation-job/tcf29in6w6ts`), and
// `aws bedrock get-model-invocation-job` (the AWS CLI, an independent client) confirmed the job's
// real status/config server-side -- a wrong signing name would have produced
// `SignatureDoesNotMatch`, not a real job.
//
// TWO REAL BUGS FOUND AND FIXED BY THAT SAME LIVE SUBMISSION, both load-bearing:
//   1. GetModelInvocationJob's `jobIdentifier` MUST be the full jobArn. The API reference's
//      documented pattern technically allows a bare 12-character id too (its own worked example
//      shows one), but a live call with the bare id was REJECTED (`400 ValidationException: The
//      provided ARN is invalid`), reproduced identically via the plain AWS CLI (ruling out a bug
//      in this file's own request construction) -- see getModelInvocationJob()'s own doc comment.
//   2. A job ARN used as a REST path parameter contains a literal `/` (before the trailing job id)
//      and several `:` characters, which opensearch-client.mjs's SHARED `canonicalUri()` had no
//      way to encode correctly as ONE atomic path segment (it always splits on every `/` in its
//      input, with no way to know a given `/` is DATA rather than a structural separator) -- see
//      that function's own doc comment (now updated with an array-of-segments input mode) for the
//      exact live symptom progression (`404 UnknownOperationException` with no pre-encoding,
//      `400 "The provided ARN is invalid"` with a naive single pre-encode, `200` with the fix).
//
// ALSO FOUND LIVE, DOCUMENTATION-GAP-CLOSING, NOT A BUG IN THIS FILE: Bedrock batch inference has a
// real MINIMUM record count per job. A genuine 2-record submission from this same live test was
// accepted by `CreateModelInvocationJob` but then ended `Failed` with message "Batch job ...
// contains less records (2) than the required minimum of: 100" -- the userguide only says to look
// this number up in Service Quotas without stating it, so 100 is this account/region/model's
// OBSERVED value on 2026-09-03, not a documented universal constant. This file does not hard-enforce
// it (an unverified-as-universal number should never become a hard client-side gate), but
// enrich.mjs's `buildAndSubmitBedrockBatch()` warns before submitting fewer than 100 records --
// see PILOT-bedrock-enrich.md and SKILL.md, both updated to size their example `--limit` well above it.
//
// S3 STAGING: batch inference reads its input JSONL and writes its output from/to S3 locations the
// CALLER controls (not the document room's own bucket/MIRROR -- see enrich.mjs's own header for why
// the batch STAGING location is a separate, explicitly-configured bucket, never inferred from the
// room's storage profile). Reuses skills/kb-memory/s3-blob.mjs's `s3RequestExplicit`/
// `listObjectsExplicit` (the SAME proven S3 SigV4 signer every MIRROR-backed room read/write in this
// fleet already uses), added alongside this file specifically so this does not need a second, novel
// S3 client. The live 2026-09-03 test's PUT of the input JSONL to a fresh, non-MIRROR bucket
// succeeded on the first try, confirming s3RequestExplicit's "s3" single-encode signing generalizes
// correctly to an arbitrary bucket, not only the MIRROR-backed ones it was originally written for.
//
// CREDENTIALS: awsCreds() from kb-memory/aws-secret.mjs (ECS task role first, then
// AWS_ACCESS_KEY_ID/SECRET, then OTC_AWS_ACCESS_KEY_ID/SECRET) -- the SAME chain bedrock-client.mjs
// and s3-blob.mjs already use, so a caller authenticates to the control plane, the S3 staging
// bucket, and (via the service role Bedrock itself assumes -- a SEPARATE, server-side identity this
// caller never touches directly) the runtime plane, all through one consistent credential model.
//
// `stopModelInvocationJob` (cancel a running job) is DELIBERATELY NOT implemented here: its exact
// REST shape was not fetched/verified against the live AWS API reference this session (unlike every
// other operation in this file, which was), and this file's own standing rule is to never guess an
// unverified API shape. A stuck or unwanted job can be stopped from the AWS Console or
// `aws bedrock stop-model-invocation-job --job-identifier <arn>` in the meantime.

import { signOpenSearchRequest } from "./opensearch-client.mjs";
import { awsCreds } from "../kb-memory/aws-secret.mjs";
import { s3RequestExplicit, listObjectsExplicit } from "../kb-memory/s3-blob.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- job status classification (verbatim from GetModelInvocationJob's documented `status` enum,
// https://docs.aws.amazon.com/bedrock/latest/APIReference/API_GetModelInvocationJob.html, fetched
// 2026-09-03) -----------------------------------------------------------------------------------
// TERMINAL_SUCCESS includes PartiallyCompleted deliberately: AWS's own doc text for it is "This job
// has partially completed. Not all of your records could be processed in time. View the output
// files in the output S3 location." -- a REAL, terminal, non-failure outcome with usable partial
// output, categorically different from Failed/Stopped/Expired. This is exactly the "short/
// mismatched result set" case enrich.mjs's per-row reconciliation exists to handle: proceed to
// collect whatever output exists, and mark any recordId that never appears in it `_callFailed`
// (never enriched) rather than throwing away the rows that DID succeed.
export const BEDROCK_BATCH_TERMINAL_SUCCESS_STATUSES = Object.freeze(new Set(["Completed", "PartiallyCompleted"]));
// A genuinely FAILED/STOPPED/EXPIRED job gets NO usable output at all (or none worth trusting) --
// this is the "the whole run/dependency is broken" case, mirroring the interactive lane's own
// _callFailed-on-throw contract: the caller (enrich.mjs) lets this propagate as a throw, aborting
// the whole batch build rather than silently marking every row _callFailed one at a time.
export const BEDROCK_BATCH_TERMINAL_FAILURE_STATUSES = Object.freeze(new Set(["Failed", "Stopped", "Expired"]));
export const BEDROCK_BATCH_NONTERMINAL_STATUSES = Object.freeze(new Set(["Submitted", "Validating", "Scheduled", "InProgress", "Stopping"]));
export function isBedrockBatchTerminal(status) {
  return BEDROCK_BATCH_TERMINAL_SUCCESS_STATUSES.has(status) || BEDROCK_BATCH_TERMINAL_FAILURE_STATUSES.has(status);
}

// CreateModelInvocationJob's `timeoutDurationInHours`: "Valid Range: Minimum value of 24. Maximum
// value of 168" (API reference, fetched 2026-09-03).
export const BEDROCK_BATCH_MIN_TIMEOUT_HOURS = 24;
export const BEDROCK_BATCH_MAX_TIMEOUT_HOURS = 168;

/** Extract the bare 12-character job id from a full jobArn
 *  (`arn:aws:bedrock:<region>:<account>:model-invocation-job/<12 chars>`). NOT used by
 *  getModelInvocationJob() (see its own doc comment for why -- the documented "short id also
 *  works" alternative does not, in practice, against the real API); kept for callers that want a
 *  short, log/label-friendly identifier (job names, S3 folder labels) where the full ARN would be
 *  needlessly long. Pure; throws on a jobArn that does not match the documented pattern rather than
 *  silently returning something that looks plausible but is not a real id. */
export function shortJobIdFromArn(jobArn) {
  const m = String(jobArn || "").match(/model-invocation-job\/([a-z0-9]{12})$/i);
  if (!m) throw new Error(`bedrock-batch-client: jobArn "${jobArn}" does not look like a real batch-inference job ARN (expected .../model-invocation-job/<12 chars>)`);
  return m[1];
}

async function bedrockControlFetch({ region, method, path, bodyStr, timeoutMs, fetchImpl = fetch }) {
  const creds = await awsCreds();
  if (!creds) {
    const err = new Error(
      "bedrock-batch-client: AWS credentials unavailable (checked the ECS task role, " +
      "AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY, and OTC_AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY)");
    err.nonRetryable = true;
    throw err;
  }
  const host = `bedrock.${region}.amazonaws.com`;
  const signed = signOpenSearchRequest({
    method, host, path, body: bodyStr, region,
    accessKeyId: creds.ak, secretAccessKey: creds.sk, sessionToken: creds.st || undefined,
    contentType: bodyStr ? "application/json" : undefined,
    service: "bedrock",
  });
  // Send the WIRE path/query the signer returned, never a separately re-derived one -- the same
  // rule bedrock-client.mjs's own header states, for the same reason (a re-derived URL can
  // silently diverge from what was actually signed).
  const url = `https://${host}${signed.path}${signed.query ? `?${signed.query}` : ""}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs || 30000);
  try {
    return await fetchImpl(url, { method, headers: signed.headers, ...(bodyStr ? { body: bodyStr } : {}), signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Create a Bedrock batch-inference job (`POST /model-invocation-job`, verbatim from the live API
 * reference/create-job guide, fetched 2026-09-03). Always submits with `modelInvocationType:
 * "Converse"` -- see this file's own header for why. `inputS3Uri` may be a single `.jsonl` file or
 * a folder (Bedrock processes every JSONL file at that S3 location); `outputS3Uri` must be a
 * folder (a trailing `/`, matching the API reference's own example `"s3://output-bucket/"`).
 * `timeoutDurationInHours` is clamped into AWS's documented [24, 168] range rather than rejected
 * outside it, since a caller-supplied env override is more likely to be a typo than a deliberate
 * out-of-range value, and clamping is the same "fail safe, not fail closed on a config nit" posture
 * this file's callers already take elsewhere (e.g. enrich.mjs's CONCURRENCY `Math.max(1, ...)`).
 * `clientRequestToken` is optional (idempotency; a caller resuming a specific submission attempt
 * can pass a stable token so a network-retried create is a no-op rather than a duplicate job).
 * Returns `{jobArn, jobId}` (jobId = the short id, via shortJobIdFromArn -- a label/log convenience
 * ONLY; pass `jobArn`, never `jobId`, to getModelInvocationJob() below). Throws with the response
 * body's detail on any non-2xx.
 */
export async function createModelInvocationJob({
  jobName, roleArn, modelId, inputS3Uri, outputS3Uri,
  timeoutDurationInHours = BEDROCK_BATCH_MIN_TIMEOUT_HOURS,
  clientRequestToken, region = "us-east-1", fetchImpl = fetch,
} = {}) {
  for (const [k, v] of Object.entries({ jobName, roleArn, modelId, inputS3Uri, outputS3Uri })) {
    if (!v) throw new Error(`bedrock-batch-client: createModelInvocationJob requires "${k}"`);
  }
  const clampedTimeout = Math.min(BEDROCK_BATCH_MAX_TIMEOUT_HOURS, Math.max(BEDROCK_BATCH_MIN_TIMEOUT_HOURS, Math.round(timeoutDurationInHours)));
  const body = {
    jobName, roleArn, modelId,
    modelInvocationType: "Converse",
    inputDataConfig: { s3InputDataConfig: { s3Uri: inputS3Uri } },
    outputDataConfig: { s3OutputDataConfig: { s3Uri: outputS3Uri } },
    timeoutDurationInHours: clampedTimeout,
    ...(clientRequestToken ? { clientRequestToken } : {}),
  };
  const r = await bedrockControlFetch({ region, method: "POST", path: "/model-invocation-job", bodyStr: JSON.stringify(body), fetchImpl });
  const text = await r.text();
  if (!r.ok) throw new Error(`bedrock-batch-client: CreateModelInvocationJob ${r.status}: ${text.slice(0, 400)}`);
  let j; try { j = text ? JSON.parse(text) : {}; } catch { j = {}; }
  if (!j.jobArn) throw new Error(`bedrock-batch-client: CreateModelInvocationJob returned no jobArn (${text.slice(0, 200)})`);
  return { jobArn: j.jobArn, jobId: shortJobIdFromArn(j.jobArn) };
}

/**
 * Get a batch-inference job's current state (`GET /model-invocation-job/{jobIdentifier}`, verbatim
 * from the live API reference, fetched 2026-09-03). Returns the parsed response object AS-IS
 * (status, totalRecordCount, processedRecordCount, successRecordCount, errorRecordCount, message,
 * outputDataConfig, inputDataConfig, ...); no reshaping, so a caller reading a field this file's
 * own comments do not mention still gets it. Throws on any non-2xx (a 404 for an unknown job id is
 * a real error here, never treated as "the job doesn't exist yet, keep waiting" -- a caller that
 * just submitted the job and gets a 404 immediately after has a genuine problem, not a normal
 * race, since CreateModelInvocationJob's own response already returned a jobArn that is supposed
 * to be immediately gettable).
 *
 * `jobIdentifier` MUST be the full jobArn. The API reference's documented pattern for this field,
 * `((arn:aws(-[^:]+)?:bedrock:[a-z0-9-]{1,20}:[0-9]{12}:model-invocation-job/)?[a-z0-9]{12})`,
 * technically makes the ARN prefix OPTIONAL (a bare 12-character id should also match), and the
 * reference's own worked example shows exactly that shape (`GET
 * /model-invocation-job/BATCHJOB1234`) -- but LIVE-VERIFIED 2026-09-03 against a real job in this
 * fleet's own account, a bare short id is REJECTED with `400 ValidationException: The provided ARN
 * is invalid`, reproduced identically both through this file's own code AND independently through
 * the plain `aws bedrock get-model-invocation-job --job-identifier <short-id>` CLI call (ruling out
 * a bug in this file's own request construction as the cause) -- the documentation and the live
 * service disagree, and the live service wins. Passing the full ARN is REQUIRED in practice.
 *
 * The ARN itself then creates a SEPARATE, genuinely-a-bug encoding problem this function fixes: it
 * contains a literal `/` (before the trailing job id) and multiple `:` characters, and a naive
 * `encodeURIComponent(jobIdentifier)` interpolated into a path TEMPLATE STRING gets DOUBLE-encoded
 * by opensearch-client.mjs's own per-segment `canonicalUri()` pass (which does not know the value
 * was already encoded) -- see that function's own doc comment for the exact live symptom
 * (`404 UnknownOperationException` with no pre-encoding at all; `400 "The provided ARN is invalid"`
 * with the double-encoding bug this replaced). Passing the path as an ARRAY of raw segments
 * (`["model-invocation-job", jobIdentifier]`) tells `canonicalUri()` to treat the ARN as ONE atomic
 * segment and encode it exactly once, which is the fix -- live-verified the same day: HTTP 200,
 * a real job's full status/details returned.
 */
export async function getModelInvocationJob({ jobIdentifier, region = "us-east-1", fetchImpl = fetch } = {}) {
  if (!jobIdentifier) throw new Error("bedrock-batch-client: getModelInvocationJob requires jobIdentifier");
  const r = await bedrockControlFetch({ region, method: "GET", path: ["model-invocation-job", jobIdentifier], fetchImpl });
  const text = await r.text();
  if (!r.ok) throw new Error(`bedrock-batch-client: GetModelInvocationJob ${r.status}: ${text.slice(0, 400)}`);
  try { return text ? JSON.parse(text) : {}; } catch { throw new Error(`bedrock-batch-client: GetModelInvocationJob returned unparseable JSON: ${text.slice(0, 200)}`); }
}

// ---- S3 staging (input upload, output read) --------------------------------------------------
// Thin wrappers over s3-blob.mjs's explicit-bucket primitives (added alongside this file), kept
// here rather than called directly from enrich.mjs so every Bedrock-batch-specific S3 convention
// (key layout, JSONL/manifest parsing) lives in one file.

/** Upload one batch input JSONL file. `key` is the FULL key under `bucket` (caller decides the
 *  layout, e.g. `<prefix>/<jobLabel>/input.jsonl`) -- this function does no key construction of its
 *  own so a caller's resume logic can compute the identical key deterministically without importing
 *  private state from here. Returns the same `{etag}` shape putObjectToS3 does. */
export async function putBatchInputFile({ bucket, key, jsonlText }) {
  if (!bucket || !key) throw new Error("bedrock-batch-client: putBatchInputFile requires bucket + key");
  const r = await s3RequestExplicit({ bucket, method: "PUT", path: key, body: Buffer.from(jsonlText, "utf8"), contentType: "application/x-ndjson" });
  if (!r.ok) throw new Error(`bedrock-batch-client: input upload ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`);
  return { etag: r.headers.get("etag") };
}

/** List every object under a job's output prefix. Returns `{name,size,lastModified}[]` with `name`
 *  the FULL S3 key (see listObjectsExplicit). Bedrock's own naming for what it writes under this
 *  prefix (one `.jsonl.out`-shaped file per input file, plus `manifest.json.out`) is documented as
 *  "Amazon Bedrock generates an output JSONL file for each input JSONL file" without a literal
 *  filename template in the fetched guide -- so this LISTS rather than guessing an exact filename,
 *  and the caller (readBedrockBatchOutput below) classifies by content/suffix instead of by an
 *  assumed name. */
export async function listBatchOutputFiles({ bucket, prefix }) {
  if (!bucket) throw new Error("bedrock-batch-client: listBatchOutputFiles requires bucket");
  return listObjectsExplicit({ bucket, prefix: prefix || "" });
}

/** Fetch one output object's text. Throws loud on anything but a clean 200 -- a 403/404 here must
 *  never be silently read as "no output", since that is exactly the class of bug this fleet has
 *  already been bitten by more than once (see this repo's own CLAUDE.md on "a 403 must never read
 *  as empty"). */
export async function getBatchOutputFileText({ bucket, key }) {
  if (!bucket || !key) throw new Error("bedrock-batch-client: getBatchOutputFileText requires bucket + key");
  const r = await s3RequestExplicit({ bucket, method: "GET", path: key });
  if (!r.ok) throw new Error(`bedrock-batch-client: output GET ${r.status} for ${key}: ${(await r.text().catch(() => "")).slice(0, 200)}`);
  return r.text();
}

/** Parse a Bedrock batch OUTPUT jsonl file's text into `[{recordId, modelInput, modelOutput,
 *  error}]` lines, per the documented output line shape (`{"recordId":..., "modelInput":...,
 *  "modelOutput":...}` with an `error` object REPLACING `modelOutput` on a per-line failure --
 *  verbatim from batch-inference-results.md, fetched 2026-09-03). Pure; tolerant of trailing/blank
 *  lines (S3 text bodies commonly end in a trailing newline). A line that fails to parse as JSON is
 *  SKIPPED, not thrown on -- one malformed line in a large output file must not make every other
 *  line's real result unreachable; the caller's own reconciliation (missing recordId -> _callFailed)
 *  already covers a recordId that never shows up here for any reason, malformed-line included. */
export function parseBatchOutputJsonl(text) {
  const out = [];
  for (const line of String(text || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { out.push(JSON.parse(trimmed)); } catch { /* skip: see doc comment above */ }
  }
  return out;
}

/** Parse a Bedrock batch `manifest.json.out` file's text into its documented summary shape
 *  (totalRecordCount/processedRecordCount/successRecordCount/errorRecordCount/inputTokenCount/
 *  outputTokenCount -- verbatim field names from batch-inference-results.md, fetched 2026-09-03).
 *  Pure; returns null (never throws) on unparseable/missing text, since the manifest is a
 *  convenience summary the caller's per-line reconciliation does not actually depend on -- a
 *  missing/broken manifest must not block collecting the real per-record output. */
export function parseManifest(text) {
  try {
    const j = JSON.parse(text);
    return {
      totalRecordCount: j.totalRecordCount ?? null,
      processedRecordCount: j.processedRecordCount ?? null,
      successRecordCount: j.successRecordCount ?? null,
      errorRecordCount: j.errorRecordCount ?? null,
      inputTokenCount: j.inputTokenCount ?? null,
      outputTokenCount: j.outputTokenCount ?? null,
    };
  } catch {
    return null;
  }
}
