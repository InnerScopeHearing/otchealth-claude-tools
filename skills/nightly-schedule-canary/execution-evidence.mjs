// Side-effect-free classifier for operator supplied ECS control-plane receipts. The daily sentinel does not
// fan out AWS calls: this is an explicit evidence attachment to its existing CLI/output path.
export const EXPECTED_ACCOUNT = "900915535335";
export const EXPECTED_REGION = "us-east-1";
export const EXPECTED_CLUSTER = `arn:aws:ecs:${EXPECTED_REGION}:${EXPECTED_ACCOUNT}:cluster/otchealth`;
export const DEFAULT_EVIDENCE_MAX_AGE_MS = 15 * 60_000;
const CORE_SCHEDULE_NAMES = ["brain-reindex", "decision-clock", "deep-finance", "deep-legal-company", "deep-legal-personal", "signal-radar", "memory-librarian", "os-anomaly-watch", "os-healthz-monitor", "os-morning-brief", "os-reflective-memory", "sentinel-os-eval", "token-keeper", "xero-health", "xero-run", "nightly-aws-dr-canary", "p0-selftest", "docintel-ocr-sweep"].map((name) => `otchealth-${name}`);
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

/** Summarize the two B11 operator-captured Core diagnostic envelopes without trusting their provenance. */
export function classifyCoreDiagnosticEnvelopes(envelopes, { nowMs = Date.now(), maxAgeMs = DEFAULT_EVIDENCE_MAX_AGE_MS, registry = {} } = {}) {
  const unknown = (error) => ({ ok: false, authenticity: "unsigned-operator-capture", currentness: "UNKNOWN", error, observations: [], monitor: { state: "MONITOR-WITNESS-UNKNOWN", detail: "captured observations do not authenticate a monitor run" } });
  if (!Array.isArray(envelopes) || envelopes.length !== 2 || !Number.isFinite(nowMs) || nowMs < MIN_TRUSTED_NOW_MS || nowMs > MAX_TRUSTED_NOW_MS || !Number.isFinite(maxAgeMs) || maxAgeMs <= 0 || maxAgeMs > DEFAULT_EVIDENCE_MAX_AGE_MS) return unknown("two envelopes and a bounded clock are required");
  const live = envelopes.find((e) => Array.isArray(e?.return_value?.target_schedules));
  const follow = envelopes.find((e) => Array.isArray(e?.return_value?.schedule_reads));
  if (!live || !follow || live === follow) return unknown("captured envelope shapes are not recognized");
  const validTime = (v) => Number.isFinite(isoMs(v));
  const envelopeOk = (e) => {
    const r = e.return_value;
    const start = isoMs(r.started_at_utc), end = isoMs(r.completed_at_utc);
    if (e.status !== "success" || r.provider_writes !== 0 ||
        !Number.isFinite(start) || !Number.isFinite(end) || end < start || end > nowMs || end - start > 30 * 60_000) return false;
    const allowedCallKeys = new Set(["service", "operation", "status", "n_items"]);
    return Array.isArray(e.api_calls) && e.api_calls.every((c) => c && typeof c === "object" && !Array.isArray(c) &&
      Object.keys(c).every((k) => allowedCallKeys.has(k)) && typeof c.service === "string" && typeof c.operation === "string" &&
      ["success", "unavailable"].includes(c.status));
  };
  if (!envelopeOk(live)) return unknown("live observation envelope failed outer identity, timestamp, or API-call validation");
  if (live.return_value.mode !== "read_only_source_and_target_diagnostic" || live.return_value.account_id !== EXPECTED_ACCOUNT || live.return_value.region !== EXPECTED_REGION || live.return_value.cluster_arn !== EXPECTED_CLUSTER) return unknown("live observation target identity is invalid");
  const liveCalls = live.api_calls;
  const liveCount = (service, operation) => liveCalls.filter((c) => c.service === service && c.operation === operation).length;
  if (liveCount("scheduler", "ListSchedules") !== 1 || liveCount("scheduler", "GetSchedule") !== 3 || liveCount("ecs", "DescribeTaskDefinition") !== 3 || liveCalls.length !== 7) return unknown("live envelope outer api_calls do not match the captured request set");
  const lrv = live.return_value;
  const liveStartMs = isoMs(lrv.started_at_utc), liveEndMs = isoMs(lrv.completed_at_utc);
  if (lrv.artifact !== "B11 fixed-target operational diagnostic packet" || !Array.isArray(lrv.requests?.expected_findings_exact_schedule_names) ||
      JSON.stringify(lrv.requests.expected_findings_exact_schedule_names) !== JSON.stringify(CORE_SCHEDULE_NAMES) ||
      lrv.schedule_inventory?.status !== "returned" || !validTime(lrv.schedule_inventory.observed_at_utc) ||
      !Array.isArray(lrv.schedule_inventory.exact_finding_names_returned) || !Array.isArray(lrv.task_definitions)) return unknown("live envelope schedule inventory or task-definition receipt is malformed");
  if (!envelopeOk(follow)) return unknown("follow-on observation envelope failed outer timestamp or API-call validation");
  const followCalls = follow.api_calls;
  const followCount = (service, operation) => followCalls.filter((c) => c.service === service && c.operation === operation).length;
  const frv = follow.return_value;
  const followStartMs = isoMs(frv.started_at_utc), followEndMs = isoMs(frv.completed_at_utc);
  if (frv.mode !== "read_only_no_import_no_filesystem_access" || frv.artifact !== "B11 live-only operational metadata follow-on" || frv.target?.account !== EXPECTED_ACCOUNT || frv.target?.region !== EXPECTED_REGION || frv.target?.cluster !== EXPECTED_CLUSTER ||
      followCount("scheduler", "GetSchedule") !== 13 || followCount("ecs", "DescribeTaskDefinition") !== 1 || followCount("ecs", "DescribeTasks") !== 1 ||
      followCount("ecr", "DescribeImages") !== 1 || followCount("s3", "ListObjectsV2") !== 1 || followCount("s3", "GetObject") !== 8 || followCalls.length !== 25 ||
      !Array.isArray(frv.schedule_reads) || frv.schedule_reads.length !== 13 || frv.schedule_inventory?.status !== "returned" ||
      frv.schedule_inventory.reused_prior_listing !== true || !Array.isArray(frv.schedule_inventory.returned_exact_names) ||
      JSON.stringify(frv.schedule_inventory.returned_exact_names) !== JSON.stringify(lrv.schedule_inventory.exact_finding_names_returned) ||
      !frv.heartbeat_listing || !Array.isArray(frv.heartbeat_listing.listed_exact_finding_keys) || !Array.isArray(frv.heartbeat_listing.rows)) return unknown("follow-on envelope outer api_calls or scoped inventories do not match the captured request set");
  const allSchedules = [...lrv.target_schedules, ...frv.schedule_reads];
  const scheduleNames = allSchedules.map((r) => r?.name);
  const inventoryNames = lrv.schedule_inventory.exact_finding_names_returned;
  if (new Set(scheduleNames).size !== scheduleNames.length || scheduleNames.some((n) => !CORE_SCHEDULE_NAMES.includes(n)) ||
      inventoryNames.length !== scheduleNames.length || inventoryNames.some((n) => !scheduleNames.includes(n))) return unknown("captured schedule names do not match the exact returned inventory");
  for (const row of allSchedules) {
    const observed = isoMs(row?.observed_at_utc);
    const isLiveTarget = lrv.target_schedules.includes(row);
    const withinCapture = observed >= (isLiveTarget ? liveStartMs : followStartMs) && observed <= (isLiveTarget ? liveEndMs : followEndMs);
    const owner = row?.target_cluster_arn;
    const ecsTarget = owner === EXPECTED_CLUSTER && taskDefinitionArnOk(row?.target_task_definition_arn || row?.task_definition_arn);
    const lambdaTarget = typeof owner === "string" && new RegExp(`^arn:aws:lambda:${EXPECTED_REGION}:${EXPECTED_ACCOUNT}:function:[A-Za-z0-9_-]+$`).test(owner);
    if (row?.status !== "returned" || !validTime(row.observed_at_utc) || observed > nowMs || !withinCapture ||
        row.group !== "default" || !["ENABLED", "DISABLED"].includes(row.state) || !(ecsTarget || lambdaTarget)) return unknown("captured schedule state or target ARN does not match the expected account/region/cluster");
  }
  const defByArn = new Map();
  for (const d of lrv.task_definitions) {
    const arn = d?.task_definition_arn_requested, def = d?.task_definition;
    if (d?.status !== "returned" || !taskDefinitionArnOk(arn) || !validTime(d.observed_at_utc) || isoMs(d.observed_at_utc) < liveStartMs || isoMs(d.observed_at_utc) > liveEndMs ||
        !def || typeof def.family !== "string" || !Number.isInteger(def.revision) ||
        arn.split("/").at(-1) !== `${def.family}:${def.revision}` || defByArn.has(arn)) return unknown("captured task-definition ARN binding is invalid");
    defByArn.set(arn, true);
  }
  const beatListing = frv.heartbeat_listing;
  const listedBeatKeys = new Set(beatListing.listed_exact_finding_keys);
  const beatRows = new Map();
  for (const row of beatListing.rows) {
    if (!row || typeof row !== "object" || row.body_contract !== "parsed_allowlist_only" || row.excluded_control_key !== false ||
        typeof row.key !== "string" || !/^otchealthcommons\/company-journal\/_HEARTBEAT\/[A-Za-z0-9_.-]+\.json$/.test(row.key) ||
        !validTime(row.observed_at_utc) || isoMs(row.observed_at_utc) < followStartMs || isoMs(row.observed_at_utc) > followEndMs || !["returned", "unavailable"].includes(row.status)) return unknown("heartbeat envelope row violates its allowlisted schema");
    const job = row.key.split("/").at(-1).slice(0, -5);
    if (beatRows.has(job) || !listedBeatKeys.has(row.key)) return unknown("heartbeat rows do not bind to their listed exact keys");
    if (row.status === "returned") {
      const h = row.heartbeat;
      if (!h || h.job !== job || !["ok", "fail"].includes(h.last_event) || !validTime(h.updated) || !validTime(h.last_start) ||
          !validTime(h.last_ok) || (h.last_fail != null && !validTime(h.last_fail)) || !Number.isInteger(h.consecutive_fail) || h.consecutive_fail < 0) return unknown("heartbeat parsed body contains invalid or non-allowlisted metadata");
    }
    beatRows.set(job, row);
  }
  if (new Set(listedBeatKeys).size !== listedBeatKeys.size || listedBeatKeys.size > 8) return unknown("heartbeat key selection is malformed");
  const registryLimit = (entry) => Number.isFinite(entry?.max_age_min) && entry.max_age_min > 0 ? entry.max_age_min : Math.max(360, (Number.isFinite(entry?.interval_min) && entry.interval_min > 0 ? entry.interval_min : 0) * 3);
  const byName = new Map(allSchedules.map((s) => [s.name, s]));
  const observations = CORE_SCHEDULE_NAMES.map((scheduleName) => {
    const row = byName.get(scheduleName);
    const job = scheduleName.slice("otchealth-".length);
    const entry = registry?.[job];
    const scheduleCall = ["otchealth-brain-reindex", "otchealth-os-healthz-monitor", "otchealth-docintel-ocr-sweep"].includes(scheduleName)
      ? liveCalls.filter((c) => c.service === "scheduler" && c.operation === "GetSchedule")
      : followCalls.filter((c) => c.service === "scheduler" && c.operation === "GetSchedule");
    const readUnavailable = scheduleCall.some((c) => c.status === "unavailable");
    const observedAt = row?.observed_at_utc || lrv.schedule_inventory.observed_at_utc;
    const ageMs = nowMs - isoMs(observedAt);
    let configuration = "UNKNOWN";
    let configurationDetail = "schedule expression or registry cadence was unavailable";
    const annual = typeof row?.schedule_expression === "string" && /^cron\([^ ]+ [^ ]+ 1 1 \? \*\)$/.test(row.schedule_expression);
    if (row?.schedule_expression && entry && annual && entry.interval_min === 90) {
      configuration = "CONFIGURATION_DRIFT";
      configurationDetail = "annual schedule expression conflicts with registry 90m interval";
    } else if (row?.schedule_expression && entry) {
      configuration = "OBSERVED";
      configurationDetail = `schedule expression observed; registry interval ${entry.interval_min ?? "unknown"}m`;
    } else if (row?.schedule_expression) configurationDetail = "schedule expression observed; no matching local registry row";
    let target = "UNKNOWN";
    if (row?.target_cluster_arn?.startsWith(`arn:aws:lambda:${EXPECTED_REGION}:${EXPECTED_ACCOUNT}:function:`)) target = "LAMBDA";
    else if (row?.target_cluster_arn === EXPECTED_CLUSTER && taskDefinitionArnOk(row?.task_definition_arn || row?.target_task_definition_arn)) target = "ECS";
    const arn = row?.task_definition_arn || row?.target_task_definition_arn || null;
    if (target === "ECS" && arn && lrv.target_schedules.some((s) => s.name === scheduleName) && !defByArn.has(arn)) target = "TASK-DEFINITION-UNVERIFIED";
    const beatKey = `otchealthcommons/company-journal/_HEARTBEAT/${job}.json`;
    const beatRow = beatRows.get(job);
    let beat = "BEAT-NOT-OBSERVED", beatAgeMin = null;
    if (beatListing.status !== "returned" || followCalls.some((c) => c.service === "s3" && c.operation === "ListObjectsV2" && c.status === "unavailable")) beat = "BEAT-UNREADABLE";
    else if (beatRow?.status === "unavailable") beat = "BEAT-UNREADABLE";
    else if (!beatRow && listedBeatKeys.has(beatKey)) beat = followCalls.some((c) => c.service === "s3" && c.operation === "GetObject" && c.status === "unavailable") ? "BEAT-UNREADABLE" : "BEAT-MISSING";
    else if (beatRow?.heartbeat) {
      beatAgeMin = (isoMs(beatRow.observed_at_utc) - isoMs(beatRow.heartbeat.last_ok)) / 60000;
      if (!Number.isFinite(beatAgeMin) || beatAgeMin < 0) beat = "BEAT-UNKNOWN";
      else beat = beatAgeMin > registryLimit(entry) ? "BEAT-OLD" : "BEAT-RECENT-AT-CAPTURE";
    }
    return { job, currentness: ageMs <= maxAgeMs ? "WITHIN-15M-AT-CAPTURE" : "STALE", schedule: readUnavailable ? "SCHEDULE-UNREADABLE" : row ? row.state : "SCHEDULE-NOT-RETURNED", configuration, configurationDetail, target, taskDefinitionArn: arn, beat, beatAgeMin };
  });
  const currentness = observations.every((o) => o.currentness === "WITHIN-15M-AT-CAPTURE") ? "WITHIN-15M-AT-CAPTURE" : "STALE";
  return { ok: false, authenticity: "unsigned-operator-capture", currentness, error: null, observations, monitor: { state: "MONITOR-WITNESS-UNKNOWN", detail: "no authenticated monitor-run witness was supplied" } };
}
