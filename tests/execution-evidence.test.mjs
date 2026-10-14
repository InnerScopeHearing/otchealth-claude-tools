import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { classifyExecutionEvidence, classifyMonitorWitness, EXPECTED_CLUSTER } from "../skills/nightly-schedule-canary/execution-evidence.mjs";

const nowMs = Date.parse("2026-10-14T03:00:00Z");
const expected = { accountId: "900915535335", region: "us-east-1", clusterArn: EXPECTED_CLUSTER, schedule: "otchealth-docintel-ocr-sweep", group: "default", taskDefinitionArn: "arn:aws:ecs:us-east-1:900915535335:task-definition/otchealth-job-docintel-ocr-sweep:3" };
const base = { observedAt: "2026-10-14T02:59:00Z", accountId: "900915535335", region: "us-east-1", clusterArn: EXPECTED_CLUSTER, schedule: expected.schedule, group: "default", taskDefinitionArn: expected.taskDefinitionArn, scheduleState: "ENABLED", read: { scheduler: "success", ecs: "success" }, tasks: [] };
const task = (lastStatus, extra = {}) => ({ taskArn: "arn:aws:ecs:us-east-1:900915535335:task/otchealth/abcdef0123456789abcdef0123456789", clusterArn: EXPECTED_CLUSTER, schedule: expected.schedule, group: expected.group, taskDefinitionArn: expected.taskDefinitionArn, lastStatus, startedAt: "2026-10-14T02:58:00Z", ...extra });

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
