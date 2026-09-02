#!/usr/bin/env node
// run-quantize-task.mjs -- the seat-side helper that launches skills/doc-indexer/quantize-indices.mjs
// as a ONE-OFF ECS Fargate task, since this sandbox's egress proxy cannot reach the OpenSearch data
// plane directly (*.es.amazonaws.com) but CAN sign+call the ECS/CloudWatch Logs control-plane APIs
// (verified live, read-only, this session: a real SigV4-signed ecs:DescribeTaskDefinition against
// `otchealth-job-brain-reindex` returned the exact container name/command/log config this file
// hardcodes below).
//
// Reuses the EXISTING `otchealth-job-brain-reindex` task definition family via a containerOverride
// (command + environment) rather than registering a new task definition -- the image
// (otchealth-mcp-server... no, doc-indexer:latest) already carries quantize-indices.mjs (see
// skills/doc-indexer/job/Dockerfile's `COPY skills/doc-indexer/` line; this file lives in that same,
// already-fully-copied directory, so it ships with no Dockerfile change). Network config (subnets/SG)
// and the `otchealth` cluster match skills/aws-jobs-migration/build-missing-schedules.mjs's constants
// exactly -- the fleet's one existing source of truth for these values, not re-derived here.
//
// argv parsing is DELEGATED to quantize-indices.mjs's own parseArgs() -- this tool's CLI is
// deliberately the exact same plan/migrate/rollback grammar, translated into QUANTIZE_* env vars for
// the container (see job/quantize-indices.sh), rather than a second, potentially-drifting copy of
// the same validation logic.
//
// AWS calls use the fleet's ONE shared generic SigV4 signer (skills/kb-memory/sigv4.mjs's
// awsRequest()) -- the same convention skills/safety-monitor/monitor.mjs's SNS publish call already
// established as "the next new SigV4 caller should import from here" -- NOT opensearch-client.mjs's
// signer (that one is OpenSearch/Elasticsearch-specific; ECS and CloudWatch Logs are unrelated AWS
// services with their own JSON-1.1 RPC protocol, confirmed against the live botocore service models
// for ecs/2014-11-13 and logs/2014-03-28: targetPrefix "AmazonEC2ContainerServiceV20141113" and
// "Logs_20140328" respectively, both signingName == their endpointPrefix).
//
// Dependency-free (node builtins + this toolkit's own sigv4.mjs only), no npm dependencies added.
import { pathToFileURL } from "node:url";
import { awsRequest } from "../kb-memory/sigv4.mjs";
import { parseArgs as parseQuantizeArgs } from "./quantize-indices.mjs";

// ============================================================================================
// Constants (matching skills/aws-jobs-migration/build-missing-schedules.mjs's own, and this
// session's live-verified read of the otchealth-job-brain-reindex task definition)
// ============================================================================================
export const REGION = process.env.AWS_REGION || "us-east-1";
export const ACCOUNT_ID = process.env.AWS_ACCOUNT_ID || "900915535335";
export const CLUSTER_ARN = `arn:aws:ecs:${REGION}:${ACCOUNT_ID}:cluster/otchealth`;
export const DEFAULT_TASK_DEFINITION = "otchealth-job-brain-reindex";
export const CONTAINER_NAME = "job"; // live-verified via ecs:DescribeTaskDefinition, read-only, this session
export const SUBNETS = ["subnet-0a94aaba3ce6e2623", "subnet-0e39a2049aa73ab50", "subnet-09695b3527b656f4a"];
export const SECURITY_GROUPS = ["sg-0a5d44b67befc3bbe"];
export const LOG_GROUP = "/ecs/otchealth";
export const LOG_STREAM_PREFIX = "brain-reindex"; // fixed on the container's own logConfiguration;
// unaffected by any containerOverride.command -- confirmed live via the same DescribeTaskDefinition read.
export const DEFAULT_HEARTBEAT_NAME = "quantize-indices";
export const DEFAULT_MAX_WAIT_MS = 3 * 60 * 60 * 1000; // 3h -- the finance room alone is ~13GB (FND-20260829-f7fa)
export const DEFAULT_POLL_INTERVAL_MS = 10_000;

// ============================================================================================
// Pure helpers
// ============================================================================================

/** Pure. Translate quantize-indices.mjs's OWN parsed CLI args (from its own parseArgs()) into the
 *  QUANTIZE_* environment variables job/quantize-indices.sh reads. One source of argument-shape
 *  truth (parseArgs), one translation function -- never a second hand-rolled arg parser here. */
export function buildEnvFromArgs(args) {
  const env = { QUANTIZE_MODE: args.cmd };
  if (args.index) env.QUANTIZE_INDEX = args.index;
  if (args.all) env.QUANTIZE_ALL = "1";
  if (args.commit) env.QUANTIZE_COMMIT = "1";
  if (args.compression) env.QUANTIZE_COMPRESSION = args.compression;
  if (args.includePrivileged) env.QUANTIZE_INCLUDE_PRIVILEGED = "1";
  if (args.cmd === "migrate" && Number.isFinite(args.minOverlapPct)) env.QUANTIZE_MIN_OVERLAP_PCT = String(args.minOverlapPct);
  if (args.json) env.QUANTIZE_JSON = "1";
  if (args.force) env.QUANTIZE_FORCE = "1";
  return env;
}

/** Pure. The exact containerOverrides[0].command this tool always sends -- the SAME with-heartbeat.sh
 *  wrapper shape the task definition's own default command already uses (see this file's header),
 *  so a container that dies unexpectedly still leaves a 'fail' beat under `_HEARTBEAT/<name>.json`
 *  even though this is a manual one-off, not a registered cron job (see job/quantize-indices.sh's
 *  own header for why it is NOT added to setup/heartbeat-registry.json). */
export function buildCommand(heartbeatName) {
  return ["/app/setup/with-heartbeat.sh", heartbeatName, "--", "/bin/sh", "/app/skills/doc-indexer/job/quantize-indices.sh"];
}

/** Pure. The full ecs:RunTask request body. */
export function buildRunTaskParams({ taskDefinition = DEFAULT_TASK_DEFINITION, env, heartbeatName = DEFAULT_HEARTBEAT_NAME, cluster = CLUSTER_ARN, subnets = SUBNETS, securityGroups = SECURITY_GROUPS }) {
  return {
    cluster,
    taskDefinition,
    launchType: "FARGATE",
    count: 1,
    startedBy: "quantize-indices-cli",
    networkConfiguration: { awsvpcConfiguration: { subnets, securityGroups, assignPublicIp: "ENABLED" } },
    overrides: {
      containerOverrides: [
        {
          name: CONTAINER_NAME,
          command: buildCommand(heartbeatName),
          environment: Object.entries(env).map(([name, value]) => ({ name, value })),
        },
      ],
    },
  };
}

/** Pure. A task ARN's final `/`-separated segment is its bare task id (the id GetLogEvents'
 *  stream name and ecs:DescribeTasks both key on). */
export function extractTaskId(taskArn) {
  const parts = String(taskArn || "").split("/");
  return parts.at(-1) || null;
}

/** Pure. The awslogs-driver stream name for this task's container -- `<prefix>/<container>/<taskId>`,
 *  fixed regardless of any containerOverride.command (see LOG_STREAM_PREFIX's own comment). */
export function logStreamNameFor(taskId, { prefix = LOG_STREAM_PREFIX, container = CONTAINER_NAME } = {}) {
  return `${prefix}/${container}/${taskId}`;
}

// ============================================================================================
// AWS I/O (thin, injectable -- makeEcsClient()/makeLogsClient() are what main() uses by default;
// tests inject fakes of the same shape)
// ============================================================================================

async function jsonRpcCall(service, targetPrefix, action, body, region) {
  const host = `${service}.${region}.amazonaws.com`;
  const res = await awsRequest({
    method: "POST",
    service,
    region,
    host,
    path: "/",
    headers: { "x-amz-target": `${targetPrefix}.${action}`, "content-type": "application/x-amz-json-1.1" },
    body: JSON.stringify(body || {}),
  });
  return { ok: res.reason === null, status: res.status, json: res.json, text: res.text, reason: res.reason };
}

export function makeEcsClient(region = REGION) {
  return {
    runTask: (params) => jsonRpcCall("ecs", "AmazonEC2ContainerServiceV20141113", "RunTask", params, region),
    describeTasks: (cluster, tasks) => jsonRpcCall("ecs", "AmazonEC2ContainerServiceV20141113", "DescribeTasks", { cluster, tasks }, region),
  };
}

export function makeLogsClient(region = REGION) {
  return {
    getLogEvents: (params) => jsonRpcCall("logs", "Logs_20140328", "GetLogEvents", params, region),
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Fetch and print any log events newer than `nextToken`. Tolerates the log stream not existing yet
 *  (the container has not started writing to it -- a normal, expected race right after RunTask
 *  returns, not a failure) by treating a ResourceNotFoundException as "no new events". Returns the
 *  updated `nextToken` for the next call. */
export async function pollNewLogEvents(logs, { logGroupName, logStreamName, nextToken, log = console.log }) {
  const res = await logs.getLogEvents({ logGroupName, logStreamName, nextToken, startFromHead: true, limit: 100 });
  if (!res.ok) {
    const type = String(res.json?.__type || "");
    if (/ResourceNotFoundException/i.test(type)) return nextToken; // stream not created yet -- fine
    return nextToken; // any other transient log-read error: skip this tick, do not fail the whole run over it
  }
  for (const e of res.json?.events || []) log(e.message ?? "");
  return res.json?.nextForwardToken ?? nextToken;
}

/**
 * Poll ecs:DescribeTasks until the task's `lastStatus` is `STOPPED` (bounded by `maxWaitMs`), tailing
 * CloudWatch Logs alongside it. Returns `{stopped, task, reason}` -- `stopped:false` on a timeout
 * (the task may still be running; this function never assumes an unfinished task failed, it reports
 * that it could not confirm either way, matching pollTaskToCompletion's same honesty convention in
 * quantize-indices.mjs).
 */
export async function waitForTaskStop(ecs, logs, { cluster, taskArn, logGroupName, logStreamName }, { sleepFn = sleep, intervalMs = DEFAULT_POLL_INTERVAL_MS, maxWaitMs = DEFAULT_MAX_WAIT_MS, log = console.log } = {}) {
  const deadline = Date.now() + maxWaitMs;
  let nextToken;
  for (;;) {
    nextToken = await pollNewLogEvents(logs, { logGroupName, logStreamName, nextToken, log });
    const desc = await ecs.describeTasks(cluster, [taskArn]);
    if (!desc.ok) return { stopped: false, task: null, reason: `ecs:DescribeTasks failed: HTTP ${desc.status} ${desc.text?.slice(0, 300) || ""}` };
    const task = (desc.json?.tasks || [])[0];
    if (!task) {
      const failure = (desc.json?.failures || [])[0];
      return { stopped: false, task: null, reason: `task not found in DescribeTasks response: ${failure ? JSON.stringify(failure) : "(no failure detail)"}` };
    }
    if (task.lastStatus === "STOPPED") {
      // One final drain so trailing log lines emitted right at exit are not lost.
      await pollNewLogEvents(logs, { logGroupName, logStreamName, nextToken, log });
      return { stopped: true, task, reason: null };
    }
    if (Date.now() > deadline) return { stopped: false, task, reason: `task did not stop within ${Math.round(maxWaitMs / 60000)} minutes (lastStatus=${task.lastStatus})` };
    await sleepFn(intervalMs);
  }
}

// ============================================================================================
// CLI
// ============================================================================================

const USAGE = `Usage: node run-quantize-task.mjs <plan|migrate|rollback> [quantize-indices.mjs flags...]
  [--task-definition otchealth-job-brain-reindex] [--heartbeat-name quantize-indices]
  [--max-wait-minutes 180] [--poll-interval-seconds 10] [--no-tail]

Launches skills/doc-indexer/quantize-indices.mjs as a one-off ECS Fargate RunTask (this seat cannot
reach the OpenSearch data plane directly), tails its CloudWatch logs, and exits with the container's
own exit code. Every plan/migrate/rollback flag quantize-indices.mjs accepts is accepted here too and
passed through as the container's environment.`;

/** Split argv into (a) this file's OWN runner flags and (b) everything else, which is handed
 *  verbatim to quantize-indices.mjs's parseArgs(). Pure, no I/O. */
export function splitArgv(argv) {
  const runner = { taskDefinition: DEFAULT_TASK_DEFINITION, heartbeatName: DEFAULT_HEARTBEAT_NAME, maxWaitMs: DEFAULT_MAX_WAIT_MS, pollIntervalMs: DEFAULT_POLL_INTERVAL_MS, tail: true, errors: [] };
  const rest = [];
  const args = [...argv];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--task-definition") runner.taskDefinition = args[++i];
    else if (a === "--heartbeat-name") runner.heartbeatName = args[++i];
    else if (a === "--max-wait-minutes") runner.maxWaitMs = Number(args[++i]) * 60_000;
    else if (a === "--poll-interval-seconds") runner.pollIntervalMs = Number(args[++i]) * 1000;
    else if (a === "--no-tail") runner.tail = false;
    else rest.push(a);
  }
  if (!Number.isFinite(runner.maxWaitMs) || runner.maxWaitMs <= 0) runner.errors.push("--max-wait-minutes must be a positive number");
  // 0 is a legal (if unusual) poll interval -- "poll as fast as the API allows" -- unlike max-wait,
  // where 0 would mean "give up before ever checking", which contradicts this tool's purpose.
  if (!Number.isFinite(runner.pollIntervalMs) || runner.pollIntervalMs < 0) runner.errors.push("--poll-interval-seconds must be zero or a positive number");
  return { runner, rest };
}

/** The CLI entrypoint. Injectable `io.ecs`/`io.logs` for tests (mirrors quantize-indices.mjs's own
 *  main(argv, io) convention); never calls process.exit itself, returns the exit code instead. */
export async function main(argv, io = {}) {
  const { runner, rest } = splitArgv(argv);
  const log = io.log || console.log;
  const quantizeArgs = parseQuantizeArgs(rest);
  const errors = [...runner.errors, ...quantizeArgs.errors];
  if (errors.length) {
    for (const e of errors) console.error(`[run-quantize-task] ${e}`);
    console.error(USAGE);
    return 2;
  }

  const env = buildEnvFromArgs(quantizeArgs);
  const params = buildRunTaskParams({ taskDefinition: runner.taskDefinition, env, heartbeatName: runner.heartbeatName });
  const ecs = io.ecs || makeEcsClient();
  const logs = io.logs || makeLogsClient();

  log(`[run-quantize-task] dispatching ${quantizeArgs.cmd} on ${runner.taskDefinition} (env: ${JSON.stringify(env)})`);
  const started = await ecs.runTask(params);
  if (!started.ok) {
    console.error(`[run-quantize-task] ecs:RunTask failed: HTTP ${started.status} ${started.text?.slice(0, 500) || ""}`);
    return 1;
  }
  const failure = (started.json?.failures || [])[0];
  if (failure) {
    console.error(`[run-quantize-task] ecs:RunTask reported a placement failure: ${JSON.stringify(failure)}`);
    return 1;
  }
  const task = (started.json?.tasks || [])[0];
  if (!task?.taskArn) {
    console.error(`[run-quantize-task] ecs:RunTask returned no task: ${JSON.stringify(started.json)}`);
    return 1;
  }
  const taskId = extractTaskId(task.taskArn);
  const logStreamName = logStreamNameFor(taskId);
  log(`[run-quantize-task] task started: ${task.taskArn} (log stream ${LOG_GROUP}/${logStreamName})`);

  if (!runner.tail) {
    log("[run-quantize-task] --no-tail: not waiting for completion.");
    return 0;
  }

  const result = await waitForTaskStop(
    ecs, logs,
    { cluster: CLUSTER_ARN, taskArn: task.taskArn, logGroupName: LOG_GROUP, logStreamName },
    { maxWaitMs: runner.maxWaitMs, intervalMs: runner.pollIntervalMs, log },
  );
  if (!result.stopped) {
    console.error(`[run-quantize-task] ${result.reason}`);
    return 1;
  }
  const container = (result.task.containers || []).find((c) => c.name === CONTAINER_NAME) || result.task.containers?.[0];
  const exitCode = container?.exitCode;
  log(`[run-quantize-task] task stopped: stopCode=${result.task.stopCode || "?"} stoppedReason=${result.task.stoppedReason || "?"} containerExitCode=${exitCode ?? "?"}`);
  if (!Number.isInteger(exitCode)) {
    console.error(`[run-quantize-task] container never reported an exit code (likely failed before starting): ${container?.reason || result.task.stoppedReason || "unknown"}`);
    return 1;
  }
  return exitCode;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main(process.argv.slice(2))
    .then((code) => { process.exitCode = code; })
    .catch((e) => { console.error("[run-quantize-task] FATAL:", e?.stack || e); process.exitCode = 1; });
}
