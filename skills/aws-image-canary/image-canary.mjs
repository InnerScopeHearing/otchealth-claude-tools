#!/usr/bin/env node
// image-canary.mjs -- catches a scheduled ECS task whose pinned container image tag has aged out of
// its ECR repository's lifecycle policy.
//
// THE INCIDENT THIS CLOSES (2026-08, see FND-20260821-29e2 in ../../FINDINGS-LEDGER.md and this repo's
// CLAUDE.md "Fleet-wide durable lessons from the Azure retirement + AWS migration" entry):
// `otchealth-job-otchealth-mcp-eval` (an EventBridge Scheduler -> ECS RunTask job) pinned
// `otchealth-mcp-gateway:28f3d25` in its task definition. The `otchealth-mcp-gateway` ECR repository
// carries the lifecycle policy `{"rulePriority":1,"selection":{"tagStatus":"any",
// "countType":"imageCountMoreThan","countNumber":10},"action":{"type":"expire"}}` -- `tagStatus:"any"`
// expires TAGGED images too, not only untagged ones, so every pinned tag anywhere in the fleet that
// points at that repo is on a 10-DEPLOY fuse (live-verified 2026-08-21: the repo held exactly 10
// images, newest-to-oldest spanning ~28.5 hours -- roughly one push every ~2.85 hours, so a tag that
// stops being the newest can fall out of the window in well under a day). Once the pinned tag no
// longer existed in ECR, every scheduled firing still looked completely healthy from the outside:
// EventBridge Scheduler dispatched on schedule, and `ecs:RunTask` returned SUCCESS in CloudTrail (the
// API call genuinely succeeds -- ECS accepted the request and tried to start the task). The task then
// failed at IMAGE PULL, before the container process ever started, so it wrote ZERO lines to its own
// CloudWatch log group. Schedule healthy, API call healthy; only the absence of new log lines (easy to
// miss) showed anything was wrong. This ran silently broken for at least 3 days before anyone caught it.
//
// WHY NEITHER SIBLING CANARY CATCHES THIS.
//   - skills/nightly-schedule-canary/schedule-canary.mjs proves "did this workflow's own CRON fire at
//     all" via a self-beat heartbeat written FROM INSIDE the job. A task that dies at image pull never
//     starts running its own code, so it never gets the chance to write that heartbeat -- but the
//     schedule itself fired exactly as expected, so schedule-liveness monitoring is not the gap here.
//   - skills/azure-canary/canary.mjs's dead-job pager (see its own header) asks whether the LATEST ECS
//     RunTask *execution* succeeded via CloudTrail/the ECS API -- but RunTask's own API response IS a
//     success in this failure mode. It has nothing to check that would go red.
// The only way to see this failure class is to independently ask ECR "does the image this task
// definition actually references still exist", which neither of the above ever does. That is the
// entire job of this file.
//
// WHAT THIS CHECKS, for every ACTIVE (State=ENABLED) EventBridge Scheduler schedule in the account/
// region whose target is an ECS RunTask (i.e. carries Target.EcsParameters.TaskDefinitionArn):
//   1. Read that schedule's task definition EXACTLY as the schedule names it (a full "family:revision"
//      ARN if the schedule pins an exact revision, or a bare family reference if it does not -- see
//      taskDefinitionRefKind() below; this canary never assumes ":$LATEST", it reads what the schedule
//      literally targets and lets ECS resolve it the same way RunTask itself would).
//   2. Extract every container's `image` field.
//   3. For every ECR image reference (repo + tag, or repo + digest), call ecr:DescribeImages for that
//      EXACT image. A 200 with a populated imageDetails means the image exists (RESOLVED); an
//      ImageNotFoundException means this job's next scheduled firing will succeed at the API and fail
//      silently at pull, EXACTLY the incident above -- this is the headline, --strict-paging finding.
//   4. INFORMATIONAL, lower severity: for repositories whose lifecycle policy has an unambiguous
//      "keep last N" rule (tagStatus:"any", no tagPrefixList -- see isPreciselyModelable() for why the
//      scope stops there), rank the in-use image among all images in the repo by push time and report
//      how many more pushes to that SAME repo would expire it. This is the leading indicator that would
//      have caught the real incident BEFORE it happened, not just after.
// Non-ECR images (Docker Hub, public.ecr.aws) are reported as NOT_ECR and never treated as an anomaly --
// ECR lifecycle policies are the specific mechanism this canary exists to watch.
//
// Report-only by default (prints a plain-English table + JSON on request); --strict makes any
// unresolvable image (or a hard failure to even complete a check -- an unverifiable dependency is
// treated the same as a broken one, matching skills/cutover-preflight/preflight.mjs's own stated
// philosophy) a non-zero exit so a scheduled caller can page on it. The leading-indicator findings are
// deliberately excluded from --strict's exit code (they are advance warning, not a live break) but are
// always printed and always in the JSON output.
//
// THIS SCRIPT DOES NOT MODIFY ANYTHING. Every AWS call it makes is a read (List/Get/Describe). It does
// not touch schedules, task definitions, images, or lifecycle policies, and it is not wired into any
// scheduled job -- see SKILL.md for the deploy recommendation, which is deliberately left for a human
// to action.
//
// AUTH: resolveAwsCreds() below tries, in order: (1) the ECS task role / env-credential chain that
// ../kb-memory/aws-secret.mjs already implements for every other AWS-touching skill in this repo (so
// this script needs ZERO changes on the day it is actually wired into a scheduled ECS job and starts
// running under a task role); (2) the same broad, read-heavy operator key
// (aws-cto-access-key-id/aws-cto-secret-access-key) skills/cutover-preflight/preflight.mjs already
// reads from Key Vault for exactly this kind of interactive, cross-service, read-only AWS check from an
// agent seat. No secret value is ever printed.
//
// Usage:
//   node skills/aws-image-canary/image-canary.mjs [--json] [--strict] [--warn-slots=N]
import { fileURLToPath } from "node:url";
import { kvSecret } from "../kb-memory/azure-secret.mjs";
import { awsCreds as ecsOrEnvAwsCreds } from "../kb-memory/aws-secret.mjs";
import { awsFetch, canonicalUriPath } from "../../setup/aws-sigv4.mjs";

const DEFAULT_REGION = process.env.AWS_REGION || "us-east-1";
const argv = process.argv.slice(2);
const JSONOUT = argv.includes("--json");
// Matches the fleet's <NAME>_STRICT env convention (NIGHTLY_SCHEDULE_CANARY_STRICT, AZURE_CANARY_STRICT).
const STRICT = argv.includes("--strict") || process.env.AWS_IMAGE_CANARY_STRICT === "1";
const WARN_SLOTS_ARG = argv.find((a) => a.startsWith("--warn-slots="));
const WARN_SLOTS = WARN_SLOTS_ARG
  ? Number(WARN_SLOTS_ARG.split("=")[1])
  : Number(process.env.AWS_IMAGE_CANARY_WARN_SLOTS || 3);

function warn(msg) { console.log(`::warning::[aws-image-canary] ${msg}`); }
function notice(msg) { console.log(`::notice::[aws-image-canary] ${msg}`); }

// ── PURE FUNCTIONS (no I/O; unit-tested in ../../tests/aws-image-canary.test.mjs) ──────────────────

/** Exit-code policy, mirrors every sibling canary's pageExitCode() convention exactly: report-only by
 *  default (never pages), --strict pages (non-zero exit) on any live anomaly. */
export function pageExitCode(anomalyCount, strict) {
  return strict && anomalyCount > 0 ? 1 : 0;
}

// A private ECR image reference: <12-digit-account>.dkr.ecr.<region>.amazonaws.com/<repo>[:<tag>][@sha256:<digest>].
// Deliberately narrow to PRIVATE ECR (the repositories this fleet's own lifecycle policies govern) --
// public.ecr.aws (the public gallery) and Docker Hub/any other registry are not repositories this
// account's lifecycle policies can expire, so they are out of scope by construction, not by omission.
const ECR_RE = /^(\d{12})\.dkr\.ecr\.([a-z0-9-]+)\.amazonaws\.com\/([^:@]+)(?::([^@\s]+))?(?:@(sha256:[0-9a-f]{64}))?$/;

/** Parse one container `image` field into { isEcr:false, raw, reason } for anything this canary does
 *  not govern, or { isEcr:true, raw, account, region, repository, tag, digest } for a private ECR
 *  reference. A bare repo with no tag and no digest defaults to "latest", matching Docker/ECS's own
 *  convention for an unqualified image reference. Pure; no network. */
export function parseImageRef(image) {
  if (typeof image !== "string" || !image.trim()) {
    return { isEcr: false, raw: image ?? null, reason: "empty or non-string image field" };
  }
  const raw = image.trim();
  const m = ECR_RE.exec(raw);
  if (!m) {
    const reason = raw.startsWith("public.ecr.aws/")
      ? "public ECR gallery, not a private repository this account's lifecycle policies govern"
      : "not a private ECR registry host (Docker Hub or another registry)";
    return { isEcr: false, raw, reason };
  }
  const [, account, region, repository, tag, digest] = m;
  return { isEcr: true, raw, account, region, repository, tag: tag || (digest ? null : "latest"), digest: digest || null };
}

/** Classify an ecr:DescribeImages response for ONE specific image (by tag or digest) into the states
 *  this canary reports. Pure -- takes the already-parsed HTTP status + JSON body, no network. This is
 *  the exact shape ECR returns (live-verified 2026-08-21 against the real account: a 400 body with
 *  `__type:"ImageNotFoundException"` for a dead tag, `__type:"RepositoryNotFoundException"` for a dead
 *  repo, and a 200 with a populated `imageDetails` array for a live image). */
export function classifyDescribeImagesResponse(status, bodyJson) {
  if (status === 200 && Array.isArray(bodyJson?.imageDetails) && bodyJson.imageDetails.length > 0) {
    return { state: "RESOLVED", detail: bodyJson.imageDetails[0] };
  }
  if (status === 200) {
    // Belt-and-suspenders: DescribeImages with a specific imageId either 400s ImageNotFoundException
    // or returns exactly one match. An empty 200 has never been observed live, but silently reading it
    // as a pass would be exactly the "configuration presence, not observed behaviour" mistake this
    // whole file exists to avoid -- so an unexpected empty success is its own distinct anomaly state.
    return { state: "QUERY_ERROR", detail: "HTTP 200 with an empty imageDetails array (unexpected shape)" };
  }
  const type = String(bodyJson?.__type || "").split("#").pop();
  const message = String(bodyJson?.message || bodyJson?.Message || "");
  if (/ImageNotFoundException/i.test(type) || /ImageNotFoundException/i.test(message)) {
    return { state: "NOT_FOUND", detail: message || type };
  }
  if (/RepositoryNotFoundException/i.test(type) || /RepositoryNotFoundException/i.test(message)) {
    return { state: "REPO_NOT_FOUND", detail: message || type };
  }
  return { state: "QUERY_ERROR", detail: `HTTP ${status}: ${type || message || "unknown error"}` };
}

/** Does an EcsParameters.TaskDefinitionArn pin an exact, immutable revision (a trailing ":<digits>"),
 *  or is it a "floating latest" family reference that ECS resolves to whatever is CURRENTLY the newest
 *  ACTIVE revision at call time? Reported because a floating reference is a materially different risk
 *  shape from a pinned one -- it can start pointing at a brand-new image with no schedule edit at all,
 *  so this canary's own re-run can observe a different image next time purely because of that, not
 *  because anything about the schedule changed. Pure. */
export function taskDefinitionRefKind(taskDefinitionArn) {
  if (!taskDefinitionArn) return "UNKNOWN";
  return /:\d+$/.test(taskDefinitionArn) ? "PINNED_REVISION" : "FLOATING_LATEST";
}

/** Parse an ECR lifecycle policy's JSON text and return every rule whose countType is
 *  "imageCountMoreThan" (a "keep last N" rule -- the shape that caused the real incident; a
 *  "sinceImagePushed" time-based rule is reported separately, never rank-modeled, see the file header).
 *  Malformed JSON or no policy at all returns []. Pure; no network. */
export function selectCountRules(lifecyclePolicyText) {
  if (!lifecyclePolicyText) return [];
  let policy;
  try {
    policy = JSON.parse(lifecyclePolicyText);
  } catch {
    return [];
  }
  const rules = Array.isArray(policy?.rules) ? policy.rules : [];
  return rules
    .filter((r) => r?.selection?.countType === "imageCountMoreThan")
    .map((r) => ({
      rulePriority: r.rulePriority,
      tagStatus: r.selection.tagStatus,
      tagPrefixList: Array.isArray(r.selection.tagPrefixList) ? r.selection.tagPrefixList : null,
      countNumber: Number(r.selection.countNumber),
    }))
    .filter((r) => Number.isFinite(r.countNumber));
}

/** A rule can be modeled EXACTLY (rank the in-use image among ALL images in the repo, since the rule
 *  applies to all of them) only when it is tagStatus:"any" with no tagPrefixList narrowing which images
 *  it counts. A rule scoped to "tagged" only, or to a tagPrefixList subset, would need the rank computed
 *  over that SAME subset to be correct -- computing it over every image in the repo instead could give a
 *  confidently wrong answer in either direction. Rather than build that subset logic (real work, not
 *  proportionate to what this canary needs to catch the actual incident, which was an unscoped "any"
 *  rule), a not-precisely-modelable rule is surfaced as informational text only: its existence and
 *  countNumber are shown, with no numeric "slots remaining" claim attached to it. Pure. */
export function isPreciselyModelable(rule) {
  return rule?.tagStatus === "any" && (!rule.tagPrefixList || rule.tagPrefixList.length === 0);
}

/** Rank (1 = newest) of the image carrying `tag` among `images`, ordered by imagePushedAt descending --
 *  the same ordering ECR's own imageCountMoreThan rule uses to decide which images survive an expiry
 *  sweep. Returns null if the tag is not present at all (the caller already has a NOT_FOUND finding in
 *  that case from classifyDescribeImagesResponse; this function does not re-derive it). Pure --
 *  `images` is a plain array the caller already fetched; imagePushedAt is compared as the epoch-seconds
 *  number ECR itself returns. */
export function rankByTag(images, tag) {
  const withPushed = (images || [])
    .filter((im) => Number.isFinite(im?.imagePushedAt))
    .slice()
    .sort((a, b) => b.imagePushedAt - a.imagePushedAt);
  const idx = withPushed.findIndex((im) => Array.isArray(im.imageTags) && im.imageTags.includes(tag));
  return idx === -1 ? null : idx + 1;
}

/** How many MORE pushes to this same repository would expire this exact image under a "keep last N"
 *  rule: countNumber - rank. 0 means the very next push expires it; a negative number means it should
 *  already be gone by rank alone -- read that as "the lifecycle sweep has not evaluated recently" rather
 *  than a contradiction, since ECR evaluates lifecycle policies periodically, not synchronously on every
 *  push (and DescribeImages already proved this exact image is still resolvable this run). Pure. */
export function slotsRemaining(rank, rule) {
  if (rank == null || !rule || !Number.isFinite(rule.countNumber)) return null;
  return rule.countNumber - rank;
}

/** Classify a slots-remaining count into the leading-indicator state this canary reports. Pure. */
export function assessLeadingIndicator(remaining, warnThreshold) {
  if (remaining == null) return "N/A";
  if (remaining < 0) return "LIKELY_EXPIRED_PENDING_EVALUATION";
  if (remaining <= warnThreshold) return "CLOSE_TO_EXPIRY";
  return "SAFE";
}

// ── AWS signing + calls -----------------------------------------------------------------------------
// FND-20260828-5ca1 (2026-09-02): this used to be a self-contained hand-rolled SigV4 signer -- one of
// nine independent copies the finding found across the toolkit, and one of FOUR that never applied
// AWS's documented double-encode rule for the EventBridge Scheduler REST paths this file signs
// (`/schedules/<name>` via schedulerGetSchedule/schedulerListSchedules below), a latent bug that never
// surfaced only because every schedule name in this fleet has stayed alphanumeric-hyphen so far (see
// ../../setup/aws-sigv4.mjs's header for the full writeup). Now delegates to that shared signer;
// ../../setup/aws-sigv4.mjs's awsFetch() takes a single `url` rather than separate host/path/query, so
// this wrapper's own signature (used by 4 call sites below: schedulerListSchedules,
// schedulerGetSchedule, ecsCall, ecrCall) is preserved unchanged -- only the internals moved.
//
// ONE deliberate, safe simplification: the shared signer only signs+sends `x-amz-content-sha256` for
// service "s3" (the one AWS service that requires it); ECS/ECR/Scheduler ignore its absence, so this
// is fewer signed headers on the wire, never a correctness loss -- verified against AWS's own SigV4
// documentation, which names x-amz-content-sha256 as an S3-specific requirement, not a general one.
export async function awsRequest(creds, { service, host, method = "GET", path = "/", query = "", body = "", region = DEFAULT_REGION, extra = {} }) {
  const url = `https://${host}${path}${query ? `?${query}` : ""}`;
  const r = await awsFetch(url, { method, headers: extra, body }, { service, region, credentials: creds });
  return { status: r.status, json: r.json, text: r.text };
}

/**
 * Resolve AWS credentials. ECS task role / env (via ../kb-memory/aws-secret.mjs, the SAME resolver
 * every other AWS-touching skill in this repo already shares) is tried FIRST, so this script needs no
 * change on the day it actually runs inside a scheduled ECS job under a task role. The Key Vault
 * operator key (aws-cto-access-key-id/aws-cto-secret-access-key) is the interactive/agent-seat
 * fallback -- the same broad, read-heavy key skills/cutover-preflight/preflight.mjs already uses for
 * exactly this shape of cross-service, read-only AWS check. Never throws; returns null if nothing
 * resolves so the caller can report a clear "no AWS credentials" failure instead of a confusing 403.
 */
export async function resolveAwsCreds() {
  const fromEcsOrEnv = await ecsOrEnvAwsCreds();
  if (fromEcsOrEnv) return { ak: fromEcsOrEnv.ak, sk: fromEcsOrEnv.sk, st: fromEcsOrEnv.st || null };
  const ak = await kvSecret("aws-cto-access-key-id");
  const sk = await kvSecret("aws-cto-secret-access-key");
  if (ak && sk) return { ak: ak.trim(), sk: sk.trim(), st: null };
  return null;
}

// scheduler.* is REST-JSON with PascalCase fields (Schedules, Name, GroupName, State, Target,
// EcsParameters, TaskDefinitionArn); ecs.*/ecr.* are the older JSON-1.1 target-header protocol with
// camelCase fields (taskDefinition, containerDefinitions, imageDetails, imageTags, imagePushedAt,
// nextToken). Both casings are live-verified 2026-08-21 against the real account, not assumed.
async function schedulerListSchedules(creds, region, nextToken) {
  const qp = ["MaxResults=100"];
  if (nextToken) qp.push(`NextToken=${encodeURIComponent(nextToken)}`);
  return awsRequest(creds, { service: "scheduler", host: `scheduler.${region}.amazonaws.com`, path: "/schedules", region, query: qp.join("&") });
}
async function schedulerGetSchedule(creds, region, name, groupName) {
  // canonicalUriPath(), not plain encodeURIComponent(): a schedule NAME is exactly the kind of
  // caller-supplied identifier this file's own header flags -- see ../../setup/aws-sigv4.mjs for why
  // this specific pattern was the latent bug FND-20260828-5ca1 closes.
  const path = canonicalUriPath(`/schedules/${name}`);
  const query = groupName ? `groupName=${encodeURIComponent(groupName)}` : "";
  return awsRequest(creds, { service: "scheduler", host: `scheduler.${region}.amazonaws.com`, path, region, query });
}
async function ecsCall(creds, region, action, body) {
  return awsRequest(creds, {
    service: "ecs", host: `ecs.${region}.amazonaws.com`, method: "POST", path: "/", region, body: JSON.stringify(body),
    extra: { "x-amz-target": `AmazonEC2ContainerServiceV20141113.${action}`, "content-type": "application/x-amz-json-1.1" },
  });
}
async function ecrCall(creds, region, action, body) {
  return awsRequest(creds, {
    service: "ecr", host: `ecr.${region}.amazonaws.com`, method: "POST", path: "/", region, body: JSON.stringify(body),
    extra: { "x-amz-target": `AmazonEC2ContainerRegistry_V20150921.${action}`, "content-type": "application/x-amz-json-1.1" },
  });
}

/** Every schedule in the account/region, across every group, bounded to 10 pages (1,000 schedules) so
 *  a pagination bug can never spin forever -- this fleet has ~30, so 10 pages is generous headroom, not
 *  a real ceiling. */
async function listAllSchedules(creds, region) {
  const out = [];
  let nextToken;
  for (let page = 0; page < 10; page++) {
    const r = await schedulerListSchedules(creds, region, nextToken);
    if (r.status !== 200) throw new Error(`ListSchedules HTTP ${r.status}: ${r.text.slice(0, 200)}`);
    out.push(...(r.json?.Schedules || []));
    nextToken = r.json?.NextToken;
    if (!nextToken) break;
  }
  return out;
}

/** Every image in a repository (summary fields only: digest, tags, push time), bounded to 10 pages
 *  (up to ~1,000 images at the default page size) for the same reason as listAllSchedules(). */
async function listAllImages(creds, region, repositoryName) {
  const out = [];
  let nextToken;
  for (let page = 0; page < 10; page++) {
    const r = await ecrCall(creds, region, "DescribeImages", { repositoryName, maxResults: 100, ...(nextToken ? { nextToken } : {}) });
    if (r.status !== 200) throw new Error(`DescribeImages(list) HTTP ${r.status}: ${r.text.slice(0, 200)}`);
    out.push(...(r.json?.imageDetails || []));
    nextToken = r.json?.nextToken;
    if (!nextToken) break;
  }
  return out;
}

// ── report formatting helpers (display only; every field they read is already on the row) ──────────
/** A compact task-definition label for the table: "rev N" for a pinned revision, "latest" for a
 *  floating family reference -- the full ARN is still in the JSON output for anyone who needs it. */
function shortTaskDef(r) {
  if (!r.taskDefinitionArn) return "-";
  if (r.taskDefRefKind === "PINNED_REVISION") {
    const m = /:(\d+)$/.exec(r.taskDefinitionArn);
    return m ? `rev ${m[1]}` : "rev ?";
  }
  return "latest";
}
/** A compact image label: "repo:tag" (or "repo@digest12…") for ECR rows -- the account/region prefix
 *  every ECR image shares is noise in a table meant to answer "which repo, which tag"; the full
 *  reference is still in the JSON output. Non-ECR rows are shown as-is, with a long "name@sha256:..."
 *  digest shortened the same way. */
function shortImage(r) {
  if (r.ecr) {
    return r.ecr.digest ? `${r.ecr.repository}@${r.ecr.digest.slice(0, 19)}…` : `${r.ecr.repository}:${r.ecr.tag}`;
  }
  const img = r.image || r.detail || "-";
  const at = img.indexOf("@sha256:");
  return at === -1 ? img : `${img.slice(0, at + 8 + 12)}…`;
}

// ── main ─────────────────────────────────────────────────────────────────────────────────────────
async function main() {
  const region = DEFAULT_REGION;
  const creds = await resolveAwsCreds();
  if (!creds) {
    console.error("::error::[aws-image-canary] no AWS credentials resolvable (checked ECS task role / env, then Key Vault aws-cto-access-key-id/aws-cto-secret-access-key)");
    process.exit(1);
  }

  const schedules = await listAllSchedules(creds, region);
  const enabled = schedules.filter((s) => s.State === "ENABLED");
  const disabled = schedules.filter((s) => s.State !== "ENABLED");

  // Rows: one per (schedule, container) pair that resolves to an ECS RunTask target. `errors` collects
  // schedule- and task-definition-level failures (a schedule this canary could not even inspect is a
  // dark sensor, not a silent pass -- same discipline every sibling canary in this repo applies).
  const rows = [];
  const nonEcsSchedules = [];
  const taskDefCache = new Map(); // exact TaskDefinitionArn string -> { status, json }

  for (const s of enabled) {
    const g = await schedulerGetSchedule(creds, region, s.Name, s.GroupName);
    if (g.status !== 200) {
      rows.push({ schedule: s.Name, group: s.GroupName, state: "QUERY_ERROR", stage: "GetSchedule", detail: `HTTP ${g.status}: ${(g.text || "").slice(0, 160)}` });
      continue;
    }
    const target = g.json?.Target;
    const tdArn = target?.EcsParameters?.TaskDefinitionArn;
    if (!tdArn) {
      nonEcsSchedules.push({ schedule: s.Name, targetArn: target?.Arn || null });
      continue;
    }

    let td = taskDefCache.get(tdArn);
    if (!td) {
      const d = await ecsCall(creds, region, "DescribeTaskDefinition", { taskDefinition: tdArn });
      td = d;
      taskDefCache.set(tdArn, d);
    }
    if (td.status !== 200 || !td.json?.taskDefinition) {
      const type = String(td.json?.__type || "").split("#").pop();
      rows.push({
        schedule: s.Name, group: s.GroupName, scheduleExpression: g.json?.ScheduleExpression,
        taskDefinitionArn: tdArn, taskDefRefKind: taskDefinitionRefKind(tdArn),
        state: "QUERY_ERROR", stage: "DescribeTaskDefinition",
        detail: `HTTP ${td.status}: ${type || (td.json?.message ?? "").slice(0, 160) || td.text?.slice(0, 160) || "unknown error"}`,
      });
      continue;
    }

    const containers = td.json.taskDefinition.containerDefinitions || [];
    for (const c of containers) {
      const ref = parseImageRef(c.image);
      const base = {
        schedule: s.Name, group: s.GroupName, scheduleExpression: g.json?.ScheduleExpression,
        taskDefinitionArn: tdArn, taskDefRefKind: taskDefinitionRefKind(tdArn),
        taskDefStatus: td.json.taskDefinition.status, container: c.name, image: c.image,
      };
      if (!ref.isEcr) {
        rows.push({ ...base, state: "NOT_ECR", detail: ref.reason });
        continue;
      }
      const idSpec = ref.digest ? { imageDigest: ref.digest } : { imageTag: ref.tag };
      const di = await ecrCall(creds, ref.region || region, "DescribeImages", { repositoryName: ref.repository, imageIds: [idSpec] });
      const verdict = classifyDescribeImagesResponse(di.status, di.json);
      rows.push({ ...base, ecr: ref, state: verdict.state, detail: typeof verdict.detail === "string" ? verdict.detail : undefined, imageDetail: typeof verdict.detail === "object" ? verdict.detail : undefined });
    }
  }

  // ── (4) leading indicator: for every repo with at least one RESOLVED ECR image, rank the in-use
  //        tag against the repo's own "keep last N" lifecycle rule (when precisely modelable).
  const indicators = [];
  const reposChecked = new Map(); // repository name -> { rules, images } cached across rows in the same repo
  for (const row of rows) {
    if (row.state !== "RESOLVED" || !row.ecr || !row.ecr.tag) continue; // digest-pinned refs are not ranked by tag
    const repo = row.ecr.repository;
    let cached = reposChecked.get(repo);
    if (!cached) {
      const lp = await ecrCall(creds, row.ecr.region || region, "GetLifecyclePolicy", { repositoryName: repo });
      const rules = lp.status === 200 ? selectCountRules(lp.json?.lifecyclePolicyText) : [];
      let images = [];
      let imagesError = null;
      if (rules.some(isPreciselyModelable)) {
        try {
          images = await listAllImages(creds, row.ecr.region || region, repo);
        } catch (e) {
          imagesError = e.message;
        }
      }
      cached = { rules, images, imagesError, hasPolicy: lp.status === 200 };
      reposChecked.set(repo, cached);
    }
    const modelable = cached.rules.filter(isPreciselyModelable);
    const other = cached.rules.filter((r) => !isPreciselyModelable(r));
    for (const rule of modelable) {
      if (cached.imagesError) {
        indicators.push({ repository: repo, tag: row.ecr.tag, schedule: row.schedule, state: "N/A", detail: `could not list images to rank: ${cached.imagesError}` });
        continue;
      }
      const rank = rankByTag(cached.images, row.ecr.tag);
      const remaining = slotsRemaining(rank, rule);
      const state = assessLeadingIndicator(remaining, WARN_SLOTS);
      if (state !== "SAFE") indicators.push({ repository: repo, tag: row.ecr.tag, schedule: row.schedule, rank, countNumber: rule.countNumber, slotsRemaining: remaining, state });
    }
    for (const rule of other) {
      indicators.push({ repository: repo, tag: row.ecr.tag, schedule: row.schedule, state: "POLICY_NOT_PRECISELY_MODELED", detail: `rule countNumber=${rule.countNumber} tagStatus=${rule.tagStatus}${rule.tagPrefixList ? ` tagPrefixList=${rule.tagPrefixList.join(",")}` : ""} -- scoped narrower than "any"/no-prefix, read the repo's policy directly` });
    }
  }

  // ── verdict ──────────────────────────────────────────────────────────────────────────────────
  const liveFailures = rows.filter((r) => r.state === "NOT_FOUND" || r.state === "REPO_NOT_FOUND");
  const queryErrors = rows.filter((r) => r.state === "QUERY_ERROR");
  const resolved = rows.filter((r) => r.state === "RESOLVED");
  const notEcr = rows.filter((r) => r.state === "NOT_ECR");
  const anomalyCount = liveFailures.length + queryErrors.length;

  const summary = {
    ok: anomalyCount === 0,
    schedules_total: schedules.length, schedules_enabled: enabled.length, schedules_disabled: disabled.length,
    ecs_runtask_schedules: new Set(rows.map((r) => r.schedule)).size, non_ecs_target_schedules: nonEcsSchedules.length,
    containers_checked: rows.length, resolved: resolved.length, not_ecr: notEcr.length,
    live_failures: liveFailures.length, query_errors: queryErrors.length,
    leading_indicators: indicators.filter((i) => i.state !== "POLICY_NOT_PRECISELY_MODELED" && i.state !== "N/A").length,
    warn_slots_threshold: WARN_SLOTS,
    rows, indicators, non_ecs_schedules: nonEcsSchedules, disabled_schedules: disabled.map((s) => s.Name),
  };

  if (JSONOUT) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`[aws-image-canary] ${schedules.length} schedule(s) total (${enabled.length} enabled, ${disabled.length} disabled) | ${summary.ecs_runtask_schedules} ECS RunTask schedule(s), ${nonEcsSchedules.length} non-ECS target | ${rows.length} container-image check(s): ${resolved.length} RESOLVED, ${notEcr.length} NOT_ECR, ${liveFailures.length} LIVE FAILURE(S), ${queryErrors.length} QUERY_ERROR(S)`);
    console.log("");
    console.log("SCHEDULE".padEnd(40) + "TASKDEF".padEnd(10) + "CONTAINER".padEnd(12) + "IMAGE".padEnd(42) + "STATUS");
    for (const r of rows) {
      console.log(
        String(r.schedule).padEnd(40) +
          shortTaskDef(r).padEnd(10) +
          String(r.container || "-").padEnd(12) +
          shortImage(r).slice(0, 40).padEnd(42) +
          r.state,
      );
    }
    if (liveFailures.length) {
      console.log("\nLIVE FAILURES (this job's NEXT scheduled firing will succeed at the API and fail silently at image pull):");
      for (const f of liveFailures) console.log(`  ${f.schedule} -> ${f.image}: ${f.state} -- ${f.detail}`);
    }
    if (queryErrors.length) {
      console.log("\nQUERY ERRORS (could not complete the check -- treated as unresolvable, not a pass):");
      for (const f of queryErrors) console.log(`  ${f.schedule} [${f.stage || "DescribeImages"}]: ${f.detail}`);
    }
    const closeOrExpired = indicators.filter((i) => i.state === "CLOSE_TO_EXPIRY" || i.state === "LIKELY_EXPIRED_PENDING_EVALUATION");
    if (closeOrExpired.length) {
      console.log(`\nLEADING INDICATORS (informational -- a currently-live image approaching its repo's "keep last N" limit, warn threshold <=${WARN_SLOTS} slots):`);
      for (const i of closeOrExpired) console.log(`  ${i.schedule} -> ${i.repository}:${i.tag} rank ${i.rank}/${i.countNumber} (${i.slotsRemaining} push(es) from expiry) [${i.state}]`);
    }
    const notModeled = indicators.filter((i) => i.state === "POLICY_NOT_PRECISELY_MODELED");
    if (notModeled.length) {
      console.log("\nLifecycle rules present but not precisely modeled by this canary (scoped narrower than tagStatus:any with no tagPrefixList):");
      for (const i of new Map(notModeled.map((n) => [n.repository + n.detail, n])).values()) console.log(`  ${i.repository}: ${i.detail}`);
    }
    if (nonEcsSchedules.length) {
      console.log(`\n${nonEcsSchedules.length} enabled schedule(s) do not target ECS RunTask (out of scope for this canary): ${nonEcsSchedules.map((s) => s.schedule).join(", ")}`);
    }
  }

  // In --json mode, stdout carries EXACTLY ONE JSON object (the summary printed above) and nothing
  // else, so a caller doing real machine consumption (`node x.mjs --json | jq .`, or JSON.parse() on
  // captured stdout, which is exactly how this was verified live against production) gets clean,
  // parseable output. Every fact these lines would add (per-row state, live_failures, query_errors,
  // leading_indicators counts) is already IN that JSON object -- these are purely a human-readable
  // trail on top of it, so skipping them in JSON mode loses no information, only formatting noise a
  // machine consumer never wanted mixed into its stdout stream.
  if (!JSONOUT) {
    for (const f of liveFailures) warn(`${f.schedule}: ${f.image} -- ${f.state} (${f.detail}). Next scheduled firing will dispatch and RunTask will report SUCCESS, then fail at image pull with zero log output.`);
    for (const f of queryErrors) warn(`${f.schedule}: could not verify (${f.stage || "DescribeImages"}: ${f.detail})`);
    for (const i of indicators) if (i.state === "CLOSE_TO_EXPIRY" || i.state === "LIKELY_EXPIRED_PENDING_EVALUATION") notice(`${i.schedule}: ${i.repository}:${i.tag} is ${i.slotsRemaining} push(es) from falling out of its repo's keep-last-${i.countNumber} lifecycle window`);
    console.log(summary.ok ? "\n[aws-image-canary] OK (every scheduled ECS job's pinned image is currently resolvable in ECR)" : `\n[aws-image-canary] ANOMALIES: ${anomalyCount} (${liveFailures.length} live failure(s), ${queryErrors.length} query error(s)) -- ${summary.leading_indicators} informational leading indicator(s) (never gates --strict)`);
  }
  // STRICT's paging line goes to STDERR (console.error), so it never pollutes stdout in either mode --
  // safe to leave unconditional, and a scheduled caller wants this GH Actions ::error:: annotation
  // regardless of whether stdout is a human report or a JSON artifact.
  if (STRICT && !summary.ok) console.error("::error::[aws-image-canary] STRICT: paging on the above -- an unresolvable pinned image is invisible to both schedule-liveness monitoring and CloudTrail RunTask-success monitoring, so this is the only signal that would ever catch it before the next scheduled firing fails silently.");
  process.exit(pageExitCode(anomalyCount, STRICT));
}

// Only run as a script (not when imported by tests), matching every other canary in this repo.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(`::error::[aws-image-canary] FATAL: ${e.message}`);
    process.exit(1);
  });
}
