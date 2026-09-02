// Tests for skills/doc-indexer/run-quantize-task.mjs, the seat-side ECS RunTask launcher for
// quantize-indices.mjs. All AWS I/O is dependency-injected (io.ecs/io.logs, mirroring
// quantize-indices.mjs's own main(argv, io) convention), so these never touch the network.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as R from "../skills/doc-indexer/run-quantize-task.mjs";

function makeFakeEcs({ runTaskResult, tasksByPoll }) {
  const calls = [];
  let pollIdx = 0;
  return {
    calls,
    runTask: async (params) => { calls.push({ method: "runTask", params }); return runTaskResult; },
    describeTasks: async (cluster, tasks) => {
      calls.push({ method: "describeTasks", cluster, tasks });
      const t = tasksByPoll[Math.min(pollIdx, tasksByPoll.length - 1)];
      pollIdx++;
      return t;
    },
  };
}
function makeFakeLogs(eventsByPoll = []) {
  let i = 0;
  const calls = [];
  return {
    calls,
    getLogEvents: async (params) => {
      calls.push(params);
      const batch = eventsByPoll[Math.min(i, eventsByPoll.length - 1)] ?? { ok: true, json: { events: [], nextForwardToken: params.nextToken } };
      i++;
      return batch;
    },
  };
}
const okTaskRun = { ok: true, status: 200, json: { tasks: [{ taskArn: "arn:aws:ecs:us-east-1:900915535335:task/otchealth/abcdef1234567890" }], failures: [] } };
const noopLog = () => {};

test("buildEnvFromArgs: translates parsed quantize-indices.mjs args into the exact QUANTIZE_* shape job/quantize-indices.sh reads", () => {
  const args = { cmd: "migrate", index: "memory-exec", all: false, commit: true, compression: "16x", includePrivileged: false, minOverlapPct: 95, json: false, force: false };
  assert.deepEqual(R.buildEnvFromArgs(args), { QUANTIZE_MODE: "migrate", QUANTIZE_INDEX: "memory-exec", QUANTIZE_COMMIT: "1", QUANTIZE_COMPRESSION: "16x", QUANTIZE_MIN_OVERLAP_PCT: "95" });
});

test("buildEnvFromArgs: --all and boolean flags map correctly, and absent/false flags are omitted rather than set to '0'", () => {
  const args = { cmd: "migrate", index: null, all: true, commit: false, compression: "32x", includePrivileged: true, minOverlapPct: 90, json: false, force: false };
  const env = R.buildEnvFromArgs(args);
  assert.equal(env.QUANTIZE_ALL, "1");
  assert.equal(env.QUANTIZE_INCLUDE_PRIVILEGED, "1");
  assert.equal(env.QUANTIZE_COMMIT, undefined, "commit:false must be OMITTED, not '0' -- the shell wrapper only checks for the literal string 1");
  assert.equal(env.QUANTIZE_INDEX, undefined);
});

test("buildEnvFromArgs: plan carries --json through, rollback carries --force through", () => {
  assert.equal(R.buildEnvFromArgs({ cmd: "plan", json: true }).QUANTIZE_JSON, "1");
  assert.equal(R.buildEnvFromArgs({ cmd: "rollback", index: "x", force: true }).QUANTIZE_FORCE, "1");
});

test("buildCommand: the with-heartbeat.sh wrapper shape, matching how this exact task definition already invokes its default job", () => {
  assert.deepEqual(R.buildCommand("quantize-indices"), ["/app/setup/with-heartbeat.sh", "quantize-indices", "--", "/bin/sh", "/app/skills/doc-indexer/job/quantize-indices.sh"]);
});

test("buildRunTaskParams: cluster/subnets/SG/launchType match the fleet's established constants, and env becomes name/value pairs", () => {
  const params = R.buildRunTaskParams({ env: { QUANTIZE_MODE: "plan" } });
  assert.equal(params.cluster, R.CLUSTER_ARN);
  assert.equal(params.taskDefinition, R.DEFAULT_TASK_DEFINITION);
  assert.equal(params.launchType, "FARGATE");
  assert.deepEqual(params.networkConfiguration.awsvpcConfiguration.subnets, R.SUBNETS);
  assert.deepEqual(params.networkConfiguration.awsvpcConfiguration.securityGroups, R.SECURITY_GROUPS);
  assert.equal(params.networkConfiguration.awsvpcConfiguration.assignPublicIp, "ENABLED");
  const co = params.overrides.containerOverrides[0];
  assert.equal(co.name, R.CONTAINER_NAME);
  assert.deepEqual(co.environment, [{ name: "QUANTIZE_MODE", value: "plan" }]);
});

test("extractTaskId / logStreamNameFor: pulls the bare id off a task ARN and builds the fixed prefix/container/id stream name", () => {
  assert.equal(R.extractTaskId("arn:aws:ecs:us-east-1:900915535335:task/otchealth/abcdef1234567890"), "abcdef1234567890");
  assert.equal(R.extractTaskId(""), null);
  assert.equal(R.logStreamNameFor("abc123"), "brain-reindex/job/abc123");
});

test("splitArgv: separates this runner's OWN flags from everything handed to quantize-indices.mjs's parseArgs, and validates its own numeric flags", () => {
  const { runner, rest } = R.splitArgv(["migrate", "--index", "memory-exec", "--commit", "--max-wait-minutes", "30", "--heartbeat-name", "custom", "--no-tail"]);
  assert.equal(runner.maxWaitMs, 30 * 60_000);
  assert.equal(runner.heartbeatName, "custom");
  assert.equal(runner.tail, false);
  assert.deepEqual(rest, ["migrate", "--index", "memory-exec", "--commit"]);
  assert.deepEqual(runner.errors, []);
});

test("splitArgv: rejects a non-numeric or non-positive --max-wait-minutes/--poll-interval-seconds", () => {
  assert.ok(R.splitArgv(["plan", "--max-wait-minutes", "nope"]).runner.errors.length > 0);
  assert.ok(R.splitArgv(["plan", "--max-wait-minutes", "0"]).runner.errors.length > 0);
  assert.ok(R.splitArgv(["plan", "--poll-interval-seconds", "-5"]).runner.errors.length > 0);
});

test("waitForTaskStop: polls until STOPPED, tails new log lines, and returns the final task + exit code", async () => {
  const ecs = makeFakeEcs({
    runTaskResult: okTaskRun,
    tasksByPoll: [
      { ok: true, json: { tasks: [{ taskArn: "t1", lastStatus: "RUNNING" }] } },
      { ok: true, json: { tasks: [{ taskArn: "t1", lastStatus: "STOPPED", stopCode: "EssentialContainerExited", stoppedReason: "Essential container exited", containers: [{ name: "job", exitCode: 0 }] }] } },
    ],
  });
  const printed = [];
  const logs = makeFakeLogs([
    { ok: true, json: { events: [{ message: "line1" }], nextForwardToken: "tok1" } },
    { ok: true, json: { events: [{ message: "line2" }], nextForwardToken: "tok2" } },
    { ok: true, json: { events: [], nextForwardToken: "tok2" } }, // final post-stop drain
  ]);
  const r = await R.waitForTaskStop(ecs, logs, { cluster: "c", taskArn: "t1", logGroupName: "g", logStreamName: "s" }, { sleepFn: () => Promise.resolve(), intervalMs: 0, log: (m) => printed.push(m) });
  assert.equal(r.stopped, true);
  assert.equal(r.task.containers[0].exitCode, 0);
  assert.deepEqual(printed, ["line1", "line2"]);
});

test("waitForTaskStop: a missing task in DescribeTasks (e.g. a placement failure) is reported, never mistaken for success", async () => {
  const ecs = makeFakeEcs({ runTaskResult: okTaskRun, tasksByPoll: [{ ok: true, json: { tasks: [], failures: [{ arn: "t1", reason: "MISSING" }] } }] });
  const logs = makeFakeLogs([]);
  const r = await R.waitForTaskStop(ecs, logs, { cluster: "c", taskArn: "t1", logGroupName: "g", logStreamName: "s" }, { sleepFn: () => Promise.resolve(), intervalMs: 0 });
  assert.equal(r.stopped, false);
  assert.match(r.reason, /MISSING/);
});

test("waitForTaskStop: bounded -- a task that never stops fails loud once maxWaitMs elapses rather than hanging forever", async () => {
  const ecs = makeFakeEcs({ runTaskResult: okTaskRun, tasksByPoll: [{ ok: true, json: { tasks: [{ taskArn: "t1", lastStatus: "RUNNING" }] } }] });
  const logs = makeFakeLogs([]);
  const r = await R.waitForTaskStop(ecs, logs, { cluster: "c", taskArn: "t1", logGroupName: "g", logStreamName: "s" }, { sleepFn: () => Promise.resolve(), intervalMs: 0, maxWaitMs: 5 });
  assert.equal(r.stopped, false);
  assert.match(r.reason, /did not stop/);
});

test("pollNewLogEvents: a stream that does not exist yet (ResourceNotFoundException) is treated as 'no new events', not a failure", async () => {
  const logs = { getLogEvents: async () => ({ ok: false, json: { __type: "ResourceNotFoundException", message: "The specified log stream does not exist." } }) };
  const printed = [];
  const token = await R.pollNewLogEvents(logs, { logGroupName: "g", logStreamName: "s", nextToken: undefined, log: (m) => printed.push(m) });
  assert.deepEqual(printed, []);
  assert.equal(token, undefined);
});

test("main(): a full happy-path run dispatches RunTask with the right env, tails logs, and returns the container's own exit code", async () => {
  const ecs = makeFakeEcs({
    runTaskResult: okTaskRun,
    tasksByPoll: [{ ok: true, json: { tasks: [{ taskArn: okTaskRun.json.tasks[0].taskArn, lastStatus: "STOPPED", stopCode: "EssentialContainerExited", containers: [{ name: "job", exitCode: 3 }] }] } }],
  });
  const logs = makeFakeLogs([{ ok: true, json: { events: [], nextForwardToken: undefined } }]);
  const code = await R.main(["migrate", "--index", "memory-exec", "--commit", "--poll-interval-seconds", "0"], { ecs, logs, log: noopLog });
  assert.equal(code, 3, "main() must propagate the CONTAINER's exit code, not always 0/1");
  const runTaskCall = ecs.calls.find((c) => c.method === "runTask");
  const env = Object.fromEntries(runTaskCall.params.overrides.containerOverrides[0].environment.map((e) => [e.name, e.value]));
  assert.deepEqual(env, { QUANTIZE_MODE: "migrate", QUANTIZE_INDEX: "memory-exec", QUANTIZE_COMMIT: "1", QUANTIZE_COMPRESSION: "32x", QUANTIZE_MIN_OVERLAP_PCT: "90" });
});

test("main(): invalid quantize-indices.mjs arguments are rejected BEFORE ever calling ecs:RunTask", async () => {
  const ecs = { runTask: async () => { throw new Error("must not be called"); } };
  const code = await R.main(["migrate"], { ecs, logs: makeFakeLogs([]), log: noopLog }); // migrate needs --index or --all
  assert.equal(code, 2);
});

test("main(): a placement failure from ecs:RunTask itself is reported and never treated as a started task", async () => {
  const ecs = { runTask: async () => ({ ok: true, status: 200, json: { tasks: [], failures: [{ arn: "?", reason: "RESOURCE:FARGATE" }] } }) };
  const code = await R.main(["plan"], { ecs, logs: makeFakeLogs([]), log: noopLog });
  assert.equal(code, 1);
});

test("main(): --no-tail returns immediately after a successful dispatch without polling for completion", async () => {
  const ecs = makeFakeEcs({ runTaskResult: okTaskRun, tasksByPoll: [] });
  const code = await R.main(["plan", "--no-tail"], { ecs, logs: makeFakeLogs([]), log: noopLog });
  assert.equal(code, 0);
  assert.equal(ecs.calls.filter((c) => c.method === "describeTasks").length, 0, "--no-tail must never call DescribeTasks");
});

test("main(): a container that never reports an exit code (failed before starting) is a failure, not a silent 0", async () => {
  const ecs = makeFakeEcs({
    runTaskResult: okTaskRun,
    tasksByPoll: [{ ok: true, json: { tasks: [{ taskArn: okTaskRun.json.tasks[0].taskArn, lastStatus: "STOPPED", stoppedReason: "CannotPullContainerError", containers: [] }] } }],
  });
  const code = await R.main(["plan", "--poll-interval-seconds", "0"], { ecs, logs: makeFakeLogs([{ ok: true, json: { events: [] } }]), log: noopLog });
  assert.equal(code, 1);
});
