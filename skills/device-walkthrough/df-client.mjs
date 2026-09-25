// df-client.mjs -- AWS Device Farm calls for the device-walkthrough skill. All IO; the request-body
// building and response-shape decisions this file does NOT own live in lib.mjs.
//
// Signing reuses the fleet's ONE shared SigV4 signer (../../setup/aws-sigv4.mjs), which resolves
// credentials via aws-secret.mjs's awsCreds() (ECS task role -> AWS_ACCESS_KEY_ID/SECRET/SESSION_TOKEN
// -> the OTC_AWS_-prefixed sandbox-safe fallback) when no explicit credentials are passed -- exactly
// "the way other skills do", per this skill's own build brief. Device Farm's JSON-1.1 RPC protocol
// always signs a bare "/" path, so the double-vs-single-encode question that file exists to fix is a
// no-op here, the same as its SSM caller.
import { readFileSync, statSync } from "node:fs";
import { awsFetch } from "../../setup/aws-sigv4.mjs";

const REGION = "us-west-2";
const HOST = `devicefarm.${REGION}.amazonaws.com`;
const SERVICE = "devicefarm";

/** Raw signed Device Farm call. Throws with the AWS error type/message on any non-200; never
 *  returns a "successful" shape for a failed call. */
export async function dfCall(target, body = {}) {
  const res = await awsFetch(
    `https://${HOST}/`,
    { method: "POST", headers: { "x-amz-target": `DeviceFarm_20150623.${target}`, "content-type": "application/x-amz-json-1.1" }, body: JSON.stringify(body) },
    { service: SERVICE, region: REGION },
  );
  if (res.reason === "no-aws-credentials") {
    throw new Error("No AWS credentials resolvable (set AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY, or ensure the session's credential hydration ran).");
  }
  if (res.status !== 200) {
    const type = res.json?.__type || res.reason || `http-${res.status}`;
    const message = res.json?.message || res.text || "";
    throw new Error(`DeviceFarm ${target} failed: ${type}${message ? ` -- ${message}` : ""}`);
  }
  return res.json;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** CreateUpload -> { arn, url }. */
export async function createUpload({ projectArn, name, type }) {
  const r = await dfCall("CreateUpload", { projectArn, name, type });
  return { arn: r.upload.arn, url: r.upload.url };
}

/** Polls GetUpload until SUCCEEDED (returns the upload) or FAILED (throws with Device Farm's own
 *  message) or the timeout elapses (throws). */
export async function waitForUpload(arn, { timeoutMs = 8 * 60 * 1000, intervalMs = 8000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await dfCall("GetUpload", { arn });
    const u = r.upload;
    if (u.status === "SUCCEEDED") return u;
    if (u.status === "FAILED") throw new Error(`upload ${arn} FAILED: ${u.message || "(no message)"}`);
    if (Date.now() >= deadline) throw new Error(`upload ${arn} timed out after ${timeoutMs}ms (last status ${u.status})`);
    await sleep(intervalMs);
  }
}

/** Reads `filePath` fully into memory and PUTs it to a Device Farm presigned upload URL (no signing
 *  needed -- the URL itself is the credential, matching df-xcui.sh's plain `curl -T`). */
export async function uploadFile(url, filePath) {
  const body = readFileSync(filePath);
  const res = await fetch(url, { method: "PUT", body });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`upload PUT to Device Farm failed for ${filePath}: ${res.status} ${text.slice(0, 300)}`);
  }
}

/** CreateUpload + PUT the file + wait for SUCCEEDED. Returns the upload ARN. */
export async function uploadAndWait({ projectArn, name, type, filePath, timeoutMs, intervalMs }) {
  statSync(filePath); // throws a clear ENOENT before ever talking to AWS
  const { arn, url } = await createUpload({ projectArn, name, type });
  await uploadFile(url, filePath);
  await waitForUpload(arn, { timeoutMs, intervalMs });
  return arn;
}

/** ScheduleRun. `body` is lib.mjs's buildScheduleRunBody() output. Returns the full run object. */
export async function scheduleRun(body) {
  const r = await dfCall("ScheduleRun", body);
  return r.run;
}

export async function getRun(arn) {
  const r = await dfCall("GetRun", { arn });
  return r.run;
}

export async function stopRun(arn) {
  const r = await dfCall("StopRun", { arn });
  return r.run;
}

/** Polls GetRun on `pollMs` until status COMPLETED (see lib.mjs's isRunComplete -- 0 device-minutes
 *  and PENDING suites are NOT "stuck", they are normal mid-flight). `onPoll(run)` fires after every
 *  poll (including the first) for progress reporting; never throws on a non-SUCCESS `result`, since
 *  a completed-but-failed/stopped run is still a completed run the caller must be able to inspect. */
export async function waitForRunCompletion(arn, { pollMs = 90 * 1000, timeoutMs = 4 * 60 * 60 * 1000, onPoll } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const run = await getRun(arn);
    if (onPoll) onPoll(run);
    if (run.status === "COMPLETED") return run;
    if (Date.now() >= deadline) throw new Error(`run ${arn} did not complete within ${timeoutMs}ms (last status ${run.status})`);
    await sleep(pollMs);
  }
}

async function paginate(target, arn, extra = {}) {
  const out = [];
  let nextToken;
  do {
    const body = { arn, ...extra };
    if (nextToken) body.nextToken = nextToken;
    const r = await dfCall(target, body);
    const key = target === "ListJobs" ? "jobs" : target === "ListSuites" ? "suites" : "artifacts";
    out.push(...(r[key] || []));
    nextToken = r.nextToken || null;
  } while (nextToken);
  return out;
}

export async function listJobs(runArn) {
  return paginate("ListJobs", runArn);
}

export async function listSuites(jobArn) {
  return paginate("ListSuites", jobArn);
}

export async function listArtifacts(jobArn, type) {
  return paginate("ListArtifacts", jobArn, { type });
}
