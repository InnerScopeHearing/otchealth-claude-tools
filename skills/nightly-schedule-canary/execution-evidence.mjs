// Side-effect-free classifier for operator supplied ECS control-plane receipts. The daily sentinel does not
// fan out AWS calls: this is an explicit evidence attachment to its existing CLI/output path.
export const EXPECTED_ACCOUNT = "900915535335";
export const EXPECTED_REGION = "us-east-1";
export const EXPECTED_CLUSTER = `arn:aws:ecs:${EXPECTED_REGION}:${EXPECTED_ACCOUNT}:cluster/otchealth`;
export const DEFAULT_EVIDENCE_MAX_AGE_MS = 15 * 60_000;
const MIN_TRUSTED_NOW_MS = Date.parse("2020-01-01T00:00:00Z");
const MAX_TRUSTED_NOW_MS = Date.parse("2100-01-01T00:00:00Z");

const isoMs = (value) => {
  const m = typeof value === "string" && /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!m) return NaN;
  const [, y, mo, d, h, mi, s, , , offH, offM] = m;
  const year = Number(y), month = Number(mo), day = Number(d), hour = Number(h), minute = Number(mi), second = Number(s);
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate() || hour > 23 || minute > 59 || second > 59 || (offH != null && (Number(offH) > 23 || Number(offM) > 59))) return NaN;
  return Date.parse(value);
};
const taskArnOk = (value) => typeof value === "string" && new RegExp(`^arn:aws:ecs:${EXPECTED_REGION}:${EXPECTED_ACCOUNT}:task/otchealth/[A-Fa-f0-9-]{32,36}$`).test(value);
const taskDefinitionArnOk = (value) => typeof value === "string" && new RegExp(`^arn:aws:ecs:${EXPECTED_REGION}:${EXPECTED_ACCOUNT}:task-definition/[A-Za-z0-9_-]+:[1-9][0-9]*$`).test(value);
const nameOk = (value) => typeof value === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(value);

/** Validate and classify one explicit Scheduler/ECS observation. Missing observations never mean "never started". */
export function classifyExecutionEvidence({ evidence, expected, nowMs = Date.now(), maxAgeMs = DEFAULT_EVIDENCE_MAX_AGE_MS } = {}) {
  const invalid = (detail) => ({ state: "EXECUTION-INVALID", detail, ok: false });
  if (!Number.isFinite(nowMs) || nowMs < MIN_TRUSTED_NOW_MS || nowMs > MAX_TRUSTED_NOW_MS || !Number.isFinite(maxAgeMs) || maxAgeMs <= 0 || maxAgeMs > DEFAULT_EVIDENCE_MAX_AGE_MS) return invalid("clock or freshness bound is invalid");
  if (!expected || typeof expected !== "object" || Array.isArray(expected) || expected.accountId !== EXPECTED_ACCOUNT || expected.region !== EXPECTED_REGION || expected.clusterArn !== EXPECTED_CLUSTER || !nameOk(expected.schedule) || !nameOk(expected.group || "default") || !taskDefinitionArnOk(expected.taskDefinitionArn)) return invalid("expected target identity is invalid");
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) return invalid("evidence must be an object");
  const observedMs = isoMs(evidence.observedAt);
  if (!Number.isFinite(observedMs) || observedMs > nowMs || nowMs - observedMs > maxAgeMs) return invalid("observation timestamp is missing, future dated, or stale");
  if (evidence.accountId !== EXPECTED_ACCOUNT || evidence.region !== EXPECTED_REGION || evidence.clusterArn !== EXPECTED_CLUSTER) return invalid("account, region, or cluster does not match the expected target");
  if (evidence.schedule !== expected.schedule || evidence.group !== (expected.group || "default") || evidence.taskDefinitionArn !== expected.taskDefinitionArn) return invalid("observed Scheduler target does not match the expected schedule, group, and task definition");
  if (!["ENABLED", "DISABLED"].includes(evidence.scheduleState)) return invalid("scheduleState must be ENABLED or DISABLED");
  if (evidence.beat != null && !["fresh-ok", "absent-or-stale"].includes(evidence.beat)) return invalid("beat must be fresh-ok or absent-or-stale when supplied");
  if (!evidence.read || !["success", "unavailable"].includes(evidence.read.scheduler) || !["success", "unavailable"].includes(evidence.read.ecs)) return invalid("read status schema is invalid");
  if (evidence.read.scheduler === "unavailable" || evidence.read.ecs === "unavailable") return { state: "EXECUTION-UNREADABLE", detail: "Scheduler or ECS provider evidence is unavailable; execution state is unknown", ok: false };
  if (!Array.isArray(evidence.tasks)) return invalid("tasks must be an array after a successful ECS read");
  const matching = [];
  for (const task of evidence.tasks) {
    if (!task || !taskArnOk(task.taskArn) || task.clusterArn !== EXPECTED_CLUSTER || task.taskDefinitionArn !== expected.taskDefinitionArn || task.schedule !== expected.schedule || task.group !== (expected.group || "default") || !["RUNNING", "STOPPED"].includes(task.lastStatus)) return invalid("task row has invalid schema or mismatched ECS target/schedule binding");
    if ((task.stopCode != null && typeof task.stopCode !== "string") || (task.containers != null && (!Array.isArray(task.containers) || task.containers.some((c) => !c || (c.exitCode != null && (!Number.isInteger(c.exitCode) || c.exitCode < 0 || c.exitCode > 255)))))) return invalid("task stopCode or container exit-code metadata is invalid");
    const started = isoMs(task.startedAt);
    const stopped = task.stoppedAt == null ? null : isoMs(task.stoppedAt);
    if (!Number.isFinite(started) || started > observedMs || (stopped != null && (!Number.isFinite(stopped) || stopped < started || stopped > observedMs))) return invalid("task timestamps are invalid for the observation time");
    if (task.lastStatus === "RUNNING" && (stopped != null || task.containers?.some((c) => c.exitCode != null))) return invalid("RUNNING task has stopped-task metadata");
    matching.push({ ...task, startedMs: started, stoppedMs: stopped });
  }
  const running = matching.filter((t) => t.lastStatus === "RUNNING").sort((a, b) => b.startedMs - a.startedMs)[0];
  if (running) return { state: evidence.beat === "fresh-ok" ? "EXECUTION-RUNNING" : "RUNNING-WITHOUT-BEAT", detail: `ECS task ${running.taskArn.split("/").at(-1)} is RUNNING${evidence.beat === "fresh-ok" ? " with a fresh ok beat" : " without a fresh ok beat"}`, taskArn: running.taskArn, ok: evidence.beat === "fresh-ok" };
  const stopped = matching.filter((t) => t.lastStatus === "STOPPED").sort((a, b) => (b.stoppedMs || b.startedMs) - (a.stoppedMs || a.startedMs))[0];
  if (stopped) {
    if (stopped.stoppedMs == null) return { state: "EXECUTION-OUTCOME-UNKNOWN", detail: "latest ECS task is STOPPED but has no stoppedAt timestamp", taskArn: stopped.taskArn, ok: false };
    const exits = stopped.containers;
    const outcomesComplete = Array.isArray(exits) && exits.length > 0 && exits.every((c) => Number.isInteger(c.exitCode));
    if (stopped.stopCode !== "TaskFailedToStart" && !outcomesComplete) return { state: "EXECUTION-OUTCOME-UNKNOWN", detail: "latest ECS task is STOPPED but its exit outcome is unavailable", taskArn: stopped.taskArn, ok: false };
    const failed = stopped.stopCode === "TaskFailedToStart" || exits.some((c) => c.exitCode !== 0);
    return { state: failed ? "EXECUTION-FAILING" : "EXECUTION-EXITED", detail: `latest observed ECS task ${stopped.taskArn.split("/").at(-1)} is STOPPED${failed ? ` (${stopped.stopCode || "nonzero container exit"})` : ""}`, taskArn: stopped.taskArn, ok: false };
  }
  if (evidence.scheduleState === "DISABLED") return { state: "NO-VERIFIED-LAUNCH", detail: "schedule is DISABLED and no matching task was returned; this observation does not establish that it never started", ok: false };
  return { state: "NO-VERIFIED-LAUNCH", detail: "no matching task was returned by this successful ECS query; this is not proof the job never started", ok: false };
}

/** Require exact, one-to-one coverage from expected schedule refs to supplied observations. */
export function classifyExecutionBundle(bundle, { nowMs = Date.now(), maxAgeMs = DEFAULT_EVIDENCE_MAX_AGE_MS } = {}) {
  const invalid = (detail) => ({ ok: false, error: detail, observations: [], monitor: { state: "MONITOR-WITNESS-UNKNOWN", detail: "monitor witness was not evaluated" } });
  if (!bundle || typeof bundle !== "object" || Array.isArray(bundle) || !bundle.expected || typeof bundle.expected !== "object" || Array.isArray(bundle.expected) || !Array.isArray(bundle.observations)) return invalid("receipt requires expected targets and an observations array");
  const keys = Object.keys(bundle.expected);
  if (!keys.length) return invalid("receipt has no expected targets");
  const counts = new Map(keys.map((k) => [k, 0]));
  for (const row of bundle.observations) {
    if (!row || typeof row !== "object" || Array.isArray(row) || typeof row.finding !== "string" || !counts.has(row.finding)) return invalid("receipt contains an unrelated or malformed observation");
    counts.set(row.finding, counts.get(row.finding) + 1);
  }
  if ([...counts.values()].some((n) => n > 1)) return invalid("receipt has a duplicate observation");
  if (bundle.observations.length !== keys.length || [...counts.values()].some((n) => n === 0)) return invalid("receipt has a missing observation");
  const observations = bundle.observations.map((row) => ({ job: row.finding, ...classifyExecutionEvidence({ evidence: row, expected: bundle.expected[row.finding], nowMs, maxAgeMs }) }));
  return { ok: true, observations, monitor: classifyMonitorWitness({ ...(bundle.monitorWitness || {}), nowMs, maxAgeMs }) };
}

/** Monitor health is a separate witness. A stale/absent monitor run never changes workload classification. */
export function classifyMonitorWitness({ status, observedAt, nowMs = Date.now(), maxAgeMs = DEFAULT_EVIDENCE_MAX_AGE_MS } = {}) {
  const t = isoMs(observedAt);
  if (status === "unavailable" || !Number.isFinite(t) || !Number.isFinite(nowMs) || nowMs < MIN_TRUSTED_NOW_MS || nowMs > MAX_TRUSTED_NOW_MS || !Number.isFinite(maxAgeMs) || maxAgeMs <= 0 || maxAgeMs > DEFAULT_EVIDENCE_MAX_AGE_MS || t > nowMs || nowMs - t > maxAgeMs) return { state: "MONITOR-WITNESS-UNKNOWN", detail: "no fresh verified monitor-run witness; monitor health is unknown" };
  if (status === "failed") return { state: "MONITOR-FAILING", detail: "the observed monitor run failed" };
  if (status === "success") return { state: "MONITOR-WITNESSED", detail: "the monitor has a fresh successful run witness" };
  return { state: "MONITOR-WITNESS-UNKNOWN", detail: "monitor witness status is invalid" };
}
