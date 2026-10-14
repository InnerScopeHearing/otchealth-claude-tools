import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { classifyExecutionEvidence, classifyMonitorWitness, EXPECTED_CLUSTER } from "../skills/nightly-schedule-canary/execution-evidence.mjs";
import * as evidenceModule from "../skills/nightly-schedule-canary/execution-evidence.mjs";

const nowMs = Date.parse("2026-10-14T03:00:00Z");
const expected = { accountId: "900915535335", region: "us-east-1", clusterArn: EXPECTED_CLUSTER, schedule: "otchealth-docintel-ocr-sweep", group: "default", taskDefinitionArn: "arn:aws:ecs:us-east-1:900915535335:task-definition/otchealth-job-docintel-ocr-sweep:3" };
const base = { observedAt: "2026-10-14T02:59:00Z", accountId: "900915535335", region: "us-east-1", clusterArn: EXPECTED_CLUSTER, schedule: expected.schedule, group: "default", taskDefinitionArn: expected.taskDefinitionArn, scheduleState: "ENABLED", read: { scheduler: "success", ecs: "success" }, tasks: [] };
const task = (lastStatus, extra = {}) => ({ taskArn: "arn:aws:ecs:us-east-1:900915535335:task/otchealth/abcdef0123456789abcdef0123456789", clusterArn: EXPECTED_CLUSTER, schedule: expected.schedule, group: expected.group, taskDefinitionArn: expected.taskDefinitionArn, lastStatus, startedAt: "2026-10-14T02:58:00Z", ...extra });

const coreNames = ["brain-reindex", "decision-clock", "deep-finance", "deep-legal-company", "deep-legal-personal", "signal-radar", "memory-librarian", "os-anomaly-watch", "os-healthz-monitor", "os-morning-brief", "os-reflective-memory", "sentinel-os-eval", "token-keeper", "xero-health", "xero-run", "nightly-aws-dr-canary", "p0-selftest", "docintel-ocr-sweep"].map((name) => `otchealth-${name}`);
const coreTime = "2026-10-14T07:53:00.000Z";
const coreTaskDef = (name, revision = 1) => `arn:aws:ecs:us-east-1:900915535335:task-definition/otchealth-job-${name}:${revision}`;
function coreCapturePair() {
  const liveScheduleNames = ["otchealth-brain-reindex", "otchealth-os-healthz-monitor", "otchealth-docintel-ocr-sweep"];
  const followNames = coreNames.filter((name) => ![...liveScheduleNames, "otchealth-nightly-aws-dr-canary", "otchealth-p0-selftest"].includes(name));
  const target = (name, state, taskDefinitionArn, observedAt = coreTime) => ({ name, group: "default", status: "returned", observed_at_utc: observedAt, state, target_cluster_arn: EXPECTED_CLUSTER, target_task_definition_arn: taskDefinitionArn });
  const liveTargets = [target(liveScheduleNames[0], "DISABLED", coreTaskDef("brain-reindex", 3)), target(liveScheduleNames[1], "DISABLED", coreTaskDef("os-healthz-monitor", 2)), target(liveScheduleNames[2], "ENABLED", coreTaskDef("docintel-ocr-sweep", 3))];
  const liveDefs = liveTargets.map((row) => ({ task_definition_arn_requested: row.target_task_definition_arn, status: "returned", observed_at_utc: coreTime, task_definition: { family: row.target_task_definition_arn.split("/").at(-1).split(":")[0], revision: Number(row.target_task_definition_arn.split(":").at(-1)) } }));
  const read = (name) => ({ name, group: "default", status: "returned", observed_at_utc: coreTime, state: "ENABLED", schedule_expression: name === "otchealth-deep-finance" ? "cron(0 5 1 1 ? *)" : "cron(0 8 * * ? *)", target_role_arn: "arn:aws:iam::900915535335:role/test", target_cluster_arn: name === "otchealth-os-anomaly-watch" ? "arn:aws:lambda:us-east-1:900915535335:function:watcher" : EXPECTED_CLUSTER, ...(name === "otchealth-os-anomaly-watch" ? {} : { task_definition_arn: coreTaskDef(name.slice(9)) }) });
  const rows = [
    { key: "otchealthcommons/company-journal/_HEARTBEAT/deep-finance.json", status: "returned", observed_at_utc: coreTime, body_contract: "parsed_allowlist_only", heartbeat: { job: "deep-finance", last_event: "ok", updated: "2026-08-13T22:00:00.000Z", last_start: "2026-08-13T21:59:00.000Z", last_ok: "2026-08-13T22:00:00.000Z", consecutive_fail: 0 }, excluded_control_key: false },
    { key: "otchealthcommons/company-journal/_HEARTBEAT/os-anomaly-watch.json", status: "unavailable", observed_at_utc: coreTime, body_contract: "parsed_allowlist_only", excluded_control_key: false },
  ];
  const live = { status: "success", stdout: "PRIVATE BODY MUST NOT BE ECHOED", api_calls: [{ service: "scheduler", operation: "ListSchedules", status: "success" }, { service: "scheduler", operation: "GetSchedule", status: "success" }, { service: "scheduler", operation: "GetSchedule", status: "success" }, { service: "scheduler", operation: "GetSchedule", status: "success" }, ...liveDefs.map(() => ({ service: "ecs", operation: "DescribeTaskDefinition", status: "success" }))], return_value: { artifact: "B11 fixed-target operational diagnostic packet", mode: "read_only_source_and_target_diagnostic", started_at_utc: "2026-10-14T07:52:00.000Z", completed_at_utc: coreTime, account_id: "900915535335", region: "us-east-1", cluster_arn: EXPECTED_CLUSTER, provider_writes: 0, requests: { expected_findings_exact_schedule_names: coreNames }, schedule_inventory: { status: "returned", observed_at_utc: coreTime, exact_finding_names_returned: [...liveScheduleNames, ...followNames] }, target_schedules: liveTargets, task_definitions: liveDefs } };
  const follow = { status: "success", stdout: "ANOTHER PRIVATE BODY", api_calls: [...followNames.map(() => ({ service: "scheduler", operation: "GetSchedule", status: "success" })), { service: "ecs", operation: "DescribeTaskDefinition", status: "success" }, { service: "ecs", operation: "DescribeTasks", status: "success" }, { service: "ecr", operation: "DescribeImages", status: "success" }, { service: "s3", operation: "ListObjectsV2", status: "success" }, ...Array.from({ length: 8 }, () => ({ service: "s3", operation: "GetObject", status: "success" }))], return_value: { artifact: "B11 live-only operational metadata follow-on", mode: "read_only_no_import_no_filesystem_access", provider_writes: 0, started_at_utc: coreTime, completed_at_utc: "2026-10-14T07:54:00.000Z", target: { account: "900915535335", region: "us-east-1", cluster: EXPECTED_CLUSTER }, schedule_inventory: { status: "returned", observed_at_utc: coreTime, returned_exact_names: [...liveScheduleNames, ...followNames], reused_prior_listing: true }, schedule_reads: followNames.map(read), heartbeat_listing: { status: "returned", observed_at_utc: coreTime, listed_exact_finding_keys: [...rows.map((row) => row.key), "otchealthcommons/company-journal/_HEARTBEAT/brain-reindex.json", ...Array.from({ length: 5 }, (_, i) => `otchealthcommons/company-journal/_HEARTBEAT/unused-${i}.json`)], rows } } };
  return [live, follow];
}

test("empty successful ECS response means no verified launch, never never-started", () => {
  const r = classifyExecutionEvidence({ evidence: base, expected, nowMs });
  assert.equal(r.state, "NO-VERIFIED-LAUNCH");
  assert.match(r.detail, /not proof the job never started/);
});

test("running task without current beat is explicit", () => {
  const r = classifyExecutionEvidence({ evidence: { ...base, tasks: [task("RUNNING")] }, expected, nowMs });
  assert.equal(r.state, "RUNNING-WITHOUT-BEAT");
  assert.equal(r.ok, false);
});

test("running task with beat and stopped failure remain distinct", () => {
  assert.equal(classifyExecutionEvidence({ evidence: { ...base, beat: "fresh-ok", tasks: [task("RUNNING")] }, expected, nowMs }).state, "EXECUTION-RUNNING");
  assert.equal(classifyExecutionEvidence({ evidence: { ...base, tasks: [task("STOPPED", { stoppedAt: "2026-10-14T02:58:30Z", containers: [{ exitCode: 1 }] })] }, expected, nowMs }).state, "EXECUTION-FAILING");
  assert.equal(classifyExecutionEvidence({ evidence: { ...base, tasks: [task("STOPPED", { stoppedAt: "2026-10-14T02:58:30Z", containers: [{ exitCode: 0 }] })] }, expected, nowMs }).state, "EXECUTION-EXITED");
});

test("provider unavailable, malformed schema, wrong target and stale receipt never collapse together", () => {
  assert.equal(classifyExecutionEvidence({ evidence: { ...base, read: { scheduler: "unavailable", ecs: "success" } }, expected, nowMs }).state, "EXECUTION-UNREADABLE");
  assert.equal(classifyExecutionEvidence({ evidence: { ...base, accountId: "000000000000" }, expected, nowMs }).state, "EXECUTION-INVALID");
  assert.equal(classifyExecutionEvidence({ evidence: { ...base, schedule: "different" }, expected, nowMs }).state, "EXECUTION-INVALID");
  assert.equal(classifyExecutionEvidence({ evidence: { ...base, observedAt: "2026-10-14T02:00:00Z" }, expected, nowMs }).state, "EXECUTION-INVALID");
  assert.equal(classifyExecutionEvidence({ evidence: { ...base, tasks: [{ ...task("RUNNING"), taskDefinitionArn: "other" }] }, expected, nowMs }).state, "EXECUTION-INVALID");
  assert.equal(classifyExecutionEvidence({ evidence: { ...base, tasks: [{ ...task("RUNNING"), schedule: "another-schedule" }] }, expected, nowMs }).state, "EXECUTION-INVALID");
  assert.equal(classifyExecutionEvidence({ evidence: { ...base, tasks: [{ ...task("RUNNING"), taskArn: "arn:aws:ecs:us-east-1:900915535335:task/otchealth/not-an-arn" }] }, expected, nowMs }).state, "EXECUTION-INVALID");
});

test("classifier rejects non-ARN targets, incoherent task timestamps and unbounded clocks", () => {
  assert.equal(classifyExecutionEvidence({ evidence: base, expected: { ...expected, taskDefinitionArn: "not-an-arn" }, nowMs }).state, "EXECUTION-INVALID");
  assert.equal(classifyExecutionEvidence({ evidence: { ...base, tasks: [task("RUNNING", { stoppedAt: "2026-10-14T02:58:30Z" })] }, expected, nowMs }).state, "EXECUTION-INVALID");
  assert.equal(classifyExecutionEvidence({ evidence: base, expected, nowMs: NaN }).state, "EXECUTION-INVALID");
  assert.equal(classifyExecutionEvidence({ evidence: { ...base, observedAt: "2000" }, expected, nowMs }).state, "EXECUTION-INVALID");
  assert.equal(classifyExecutionEvidence({ evidence: { ...base, observedAt: "2026-02-30T02:59:00Z" }, expected, nowMs }).state, "EXECUTION-INVALID");
  assert.equal(classifyExecutionEvidence({ evidence: base, expected, nowMs: 2_000 }).state, "EXECUTION-INVALID");
  assert.equal(classifyExecutionEvidence({ evidence: base, expected, nowMs, maxAgeMs: 2_000 }).state, "EXECUTION-INVALID");
});

test("Core diagnostic captures remain unsigned and expose independent schedule, cadence, target, and beat observations", () => {
  const classify = evidenceModule.classifyCoreDiagnosticEnvelopes;
  assert.equal(typeof classify, "function");
  const [live, follow] = coreCapturePair();
  const report = classify([live, follow], { nowMs: Date.parse("2026-10-14T09:00:00Z"), registry: {
    "deep-finance": { interval_min: 90 }, "brain-reindex": { interval_min: 480 }, "os-anomaly-watch": { interval_min: 360 },
  } });
  assert.equal(report.ok, false);
  assert.equal(report.authenticity, "unsigned-operator-capture");
  assert.equal(report.currentness, "STALE", report.error);
  const byJob = new Map(report.observations.map((row) => [row.job, row]));
  assert.equal(byJob.get("deep-finance").configuration, "CONFIGURATION_DRIFT");
  assert.match(byJob.get("deep-finance").configurationDetail, /annual.*registry 90m/i);
  assert.equal(byJob.get("deep-finance").target, "ECS");
  assert.equal(byJob.get("deep-finance").beat, "BEAT-OLD");
  assert.equal(byJob.get("os-anomaly-watch").target, "LAMBDA");
  assert.equal(byJob.get("os-anomaly-watch").beat, "BEAT-UNREADABLE");
  assert.equal(byJob.get("memory-librarian").beat, "BEAT-NOT-OBSERVED");
  assert.equal(byJob.get("nightly-aws-dr-canary").schedule, "SCHEDULE-NOT-RETURNED");
  assert.equal(byJob.get("brain-reindex").schedule, "DISABLED");
  assert.equal(byJob.get("brain-reindex").beat, "BEAT-MISSING");
  assert.equal(JSON.stringify(report).includes("PRIVATE BODY"), false);
});

test("a stopped task without exit outcome remains unknown", () => {
  const r = classifyExecutionEvidence({ evidence: { ...base, tasks: [task("STOPPED", { stoppedAt: "2026-10-14T02:58:30Z" })] }, expected, nowMs });
  assert.equal(r.state, "EXECUTION-OUTCOME-UNKNOWN");
  assert.equal(r.ok, false);
});

test("monitor own-witness uncertainty is independent from workload execution", () => {
  assert.equal(classifyMonitorWitness({ status: "unavailable" }).state, "MONITOR-WITNESS-UNKNOWN");
  assert.equal(classifyMonitorWitness({ status: "failed", observedAt: "2026-10-14T02:59:00Z", nowMs }).state, "MONITOR-FAILING");
});

test("existing schedule-canary CLI consumes explicit evidence offline", () => {
  const dir = mkdtempSync(join(tmpdir(), "sentinel-execution-"));
  try {
    const path = join(dir, "evidence.json");
    writeFileSync(path, JSON.stringify({ expected: { [expected.schedule]: expected }, observations: [{ ...base, observedAt: new Date().toISOString(), finding: expected.schedule }], monitorWitness: { status: "unavailable" } }));
    const script = fileURLToPath(new URL("../skills/nightly-schedule-canary/schedule-canary.mjs", import.meta.url));
    const run = spawnSync(process.execPath, [script, "--execution-evidence", path, "--execution-evidence-only"], { encoding: "utf8", timeout: 10_000 });
    assert.equal(run.status, 1);
    assert.match(run.stdout, /NO-VERIFIED-LAUNCH/);
    assert.match(run.stdout, /MONITOR-WITNESS-UNKNOWN/);
    assert.match(run.stdout, /not proof the job never started/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("existing CLI routes raw Core captures offline in ordinary text and JSON modes", () => {
  const dir = mkdtempSync(join(tmpdir(), "sentinel-core-capture-"));
  try {
    const [live, follow] = coreCapturePair();
    const paths = [join(dir, "live.json"), join(dir, "follow.json")];
    writeFileSync(paths[0], JSON.stringify(live));
    writeFileSync(paths[1], JSON.stringify(follow));
    const script = fileURLToPath(new URL("../skills/nightly-schedule-canary/schedule-canary.mjs", import.meta.url));
    const args = [script, "--execution-evidence", paths[0], "--execution-evidence", paths[1]];
    const textRun = spawnSync(process.execPath, args, { encoding: "utf8", timeout: 10_000 });
    assert.equal(textRun.status, 1);
    assert.match(textRun.stdout, /UNAUTHENTICATED.*not current provider proof/);
    assert.doesNotMatch(textRun.stderr, /padEnd|TypeError|AccessDenied/);
    const run = spawnSync(process.execPath, [...args, "--json"], { encoding: "utf8", timeout: 10_000 });
    assert.equal(run.status, 1);
    const body = JSON.parse(run.stdout).executionEvidence;
    assert.equal(body.authenticity, "unsigned-operator-capture");
    assert.equal(body.currentness, "STALE");
    assert.equal(body.ok, false);
    assert.equal(JSON.stringify(body).includes("PRIVATE BODY"), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("offline CLI requires complete unique observations and a successful monitor witness", () => {
  const dir = mkdtempSync(join(tmpdir(), "sentinel-execution-complete-"));
  try {
    const path = join(dir, "evidence.json");
    const second = { ...expected, schedule: "otchealth-brain-reindex", taskDefinitionArn: "arn:aws:ecs:us-east-1:900915535335:task-definition/otchealth-job-brain-reindex:3" };
    const observedAt = new Date().toISOString();
    const healthy = (target, id) => ({ ...base, observedAt, finding: target.schedule, schedule: target.schedule, taskDefinitionArn: target.taskDefinitionArn, beat: "fresh-ok", tasks: [task("RUNNING", { taskArn: `arn:aws:ecs:us-east-1:900915535335:task/otchealth/${id}`, schedule: target.schedule, taskDefinitionArn: target.taskDefinitionArn })] });
    const script = fileURLToPath(new URL("../skills/nightly-schedule-canary/schedule-canary.mjs", import.meta.url));
    const run = (bundle, flags = []) => {
      writeFileSync(path, JSON.stringify(bundle));
      return spawnSync(process.execPath, [script, "--execution-evidence", path, "--execution-evidence-only", ...flags], { encoding: "utf8", timeout: 10_000 });
    };
    const complete = { expected: { [expected.schedule]: expected, [second.schedule]: second }, observations: [healthy(expected, "abcdef0123456789abcdef0123456789"), healthy(second, "0123456789abcdef0123456789abcdef")], monitorWitness: { status: "failed", observedAt } };
    const failedMonitor = run(complete);
    assert.equal(failedMonitor.status, 1);
    assert.match(failedMonitor.stdout, /MONITOR-FAILING/);

    const healthyRun = run({ ...complete, monitorWitness: { status: "success", observedAt } }, ["--json"]);
    assert.equal(healthyRun.status, 0);
    assert.equal(JSON.parse(healthyRun.stdout).ok, true, "--json stays valid in offline mode");

    const missing = run({ expected: complete.expected, observations: [], monitorWitness: { status: "success", observedAt } });
    assert.equal(missing.status, 1);
    assert.match(missing.stdout, /missing observation/);

    const duplicate = run({ ...complete, observations: [healthy(expected, "abcdef0123456789abcdef0123456789"), healthy(expected, "11111111111111111111111111111111"), healthy(second, "0123456789abcdef0123456789abcdef")], monitorWitness: { status: "success", observedAt } }, ["--json"]);
    assert.equal(duplicate.status, 1);
    assert.equal(JSON.parse(duplicate.stdout).executionEvidence.error, "receipt has a duplicate observation");

    const unrelated = run({ ...complete, observations: [healthy(expected, "abcdef0123456789abcdef0123456789"), { ...healthy(second, "0123456789abcdef0123456789abcdef"), finding: "unregistered" }], monitorWitness: { status: "success", observedAt } });
    assert.equal(unrelated.status, 1);
    assert.match(unrelated.stdout, /unrelated or malformed observation/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
