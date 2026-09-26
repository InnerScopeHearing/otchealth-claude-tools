// Pure adapter for normalized, content-free billing receipts and quality holdout summaries.
// It performs no network, filesystem, telemetry, or provider calls. Missing evidence stays unknown.

export const BILLABLE_LANES = Object.freeze([
  "chatgpt_subscription",
  "claude_subscription",
  "openai_api",
  "anthropic_api",
  "aws_gross",
  "make",
  "github_actions",
  "depot",
  "github_copilot",
  "greptile",
  "observability",
]);

const CREDIT_LANE = "aws_credits";
const BILLABLE_LANE_SET = new Set(BILLABLE_LANES);
const VALID_EVIDENCE = new Set(["actual_charge", "credit_offset", "usage_only", "estimate"]);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/;

function requireId(value, field) {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    throw new TypeError(`${field} must be a short content-free identifier`);
  }
  return value;
}

function requireExactFields(value, allowedFields, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  if (Object.keys(value).some((key) => !allowedFields.has(key))) {
    throw new TypeError(`${field} contains unsupported fields`);
  }
}

function requirePeriod(period, field) {
  requireExactFields(period, new Set(["start", "end"]), field);
  const { start, end } = period;
  const utcTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
  if (typeof start !== "string" || typeof end !== "string" || !utcTimestamp.test(start) || !utcTimestamp.test(end)) {
    throw new TypeError(`${field} needs UTC ISO timestamps for start and end`);
  }
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs >= endMs) {
    throw new TypeError(`${field} must be a valid increasing time window`);
  }
  return { start, end, startMs, endMs };
}

function requireCount(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${field} must be a non-negative integer`);
  return value;
}

function requireUsd(value, field) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative USD amount`);
  }
  return value;
}

function normalizeReceipt(receipt, index) {
  const field = `receipts[${index}]`;
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) throw new TypeError(`${field} must be an object`);
  const lane = requireId(receipt.lane, `${field}.lane`);
  const receiptId = requireId(receipt.receipt_id, `${field}.receipt_id`);
  const evidenceKind = receipt.evidence_kind;
  if (!VALID_EVIDENCE.has(evidenceKind)) throw new TypeError(`${field}.evidence_kind is unsupported`);
  const fieldsByEvidence = {
    actual_charge: new Set(["lane", "evidence_kind", "amount_usd", "currency", "period", "receipt_id", "source_id"]),
    credit_offset: new Set(["lane", "evidence_kind", "amount_usd", "currency", "period", "receipt_id", "source_id"]),
    usage_only: new Set(["lane", "evidence_kind", "period", "receipt_id", "usage_value", "usage_unit"]),
    estimate: new Set(["lane", "evidence_kind", "period", "receipt_id", "estimated_usd"]),
  };
  requireExactFields(receipt, fieldsByEvidence[evidenceKind], field);
  const period = requirePeriod(receipt.period, `${field}.period`);

  const normalized = { lane, receiptId, evidenceKind, period };
  if (evidenceKind === "actual_charge" || evidenceKind === "credit_offset") {
    normalized.amountUsd = requireUsd(receipt.amount_usd, `${field}.amount_usd`);
    normalized.currency = receipt.currency;
    normalized.sourceId = requireId(receipt.source_id, `${field}.source_id`);
  }
  // Usage units and estimates can be retained as evidence labels, but are never read as USD.
  return normalized;
}

function normalizeRun(run, name) {
  requireExactFields(run, new Set([
    "run_id", "holdout_id", "holdout_task_count", "quality_source_id", "quality_source_version",
    "period", "completed_tasks", "quality_passing_tasks", "receipts",
  ]), name);
  const completedTasks = requireCount(run.completed_tasks, `${name}.completed_tasks`);
  const holdoutTaskCount = requireCount(run.holdout_task_count, `${name}.holdout_task_count`);
  const qualityPassingTasks = requireCount(run.quality_passing_tasks, `${name}.quality_passing_tasks`);
  if (qualityPassingTasks > completedTasks) throw new TypeError(`${name}.quality_passing_tasks exceeds completed_tasks`);
  if (!Array.isArray(run.receipts)) throw new TypeError(`${name}.receipts must be an array`);

  return {
    runId: requireId(run.run_id, `${name}.run_id`),
    holdoutId: requireId(run.holdout_id, `${name}.holdout_id`),
    holdoutTaskCount,
    qualitySourceId: requireId(run.quality_source_id, `${name}.quality_source_id`),
    qualitySourceVersion: requireId(run.quality_source_version, `${name}.quality_source_version`),
    period: requirePeriod(run.period, `${name}.period`),
    completedTasks,
    qualityPassingTasks,
    receipts: run.receipts.map(normalizeReceipt),
  };
}

function samePeriod(left, right) {
  return left.startMs === right.startMs && left.endMs === right.endMs;
}

function round(value) {
  return Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;
}

function actualLane(run, lane) {
  const receipts = run.receipts.filter((item) => item.lane === lane);
  const actuals = receipts.filter((item) => item.evidenceKind === "actual_charge");
  if (actuals.length > 1) return { status: "unknown", reason: "multiple_actual_receipts_for_lane" };
  if (actuals.length === 0) {
    return {
      status: "unknown",
      reason: receipts.length ? "non_actual_evidence_is_not_actual_cost" : "no_actual_charge_receipt",
    };
  }

  const receipt = actuals[0];
  if (!BILLABLE_LANE_SET.has(lane)) return { status: "unknown", reason: "lane_not_billable" };
  if (receipt.currency !== "USD") return { status: "unknown", reason: "currency_not_usd" };
  if (!samePeriod(receipt.period, run.period)) return { status: "unknown", reason: "receipt_period_mismatch" };

  return {
    status: "measured",
    actual_cost_usd: round(receipt.amountUsd),
    cost_per_quality_passing_task_usd: run.qualityPassingTasks > 0
      ? round(receipt.amountUsd / run.qualityPassingTasks)
      : null,
    quality_pass_denominator_status: run.qualityPassingTasks > 0 ? "measured" : "unknown_no_quality_passes",
  };
}

function creditOffset(run) {
  const receipts = run.receipts.filter((item) => item.lane === CREDIT_LANE && item.evidenceKind === "credit_offset");
  if (receipts.length > 1) return { status: "unknown", reason: "multiple_credit_receipts" };
  if (receipts.length === 0) return { status: "unknown", reason: "no_credit_receipt" };
  const receipt = receipts[0];
  if (receipt.currency !== "USD") return { status: "unknown", reason: "currency_not_usd" };
  if (!samePeriod(receipt.period, run.period)) return { status: "unknown", reason: "receipt_period_mismatch" };
  return {
    status: "reported_separately",
    offset_usd: round(receipt.amountUsd),
  };
}

function summarizeRun(run) {
  const billableLanes = Object.fromEntries(BILLABLE_LANES.map((lane) => [lane, actualLane(run, lane)]));
  const knownLanes = new Set([...BILLABLE_LANES, CREDIT_LANE]);
  const unclassifiedReceiptCount = run.receipts.filter((item) => !knownLanes.has(item.lane)).length;
  return {
    period: { start: run.period.start, end: run.period.end },
    quality: {
      completed_tasks: run.completedTasks,
      holdout_task_count: run.holdoutTaskCount,
      quality_passing_tasks: run.qualityPassingTasks,
      pass_rate: run.completedTasks > 0 ? round(run.qualityPassingTasks / run.completedTasks) : null,
    },
    billable_lanes: billableLanes,
    aws_credit_offsets: creditOffset(run),
    unclassified_receipt_count: unclassifiedReceiptCount,
  };
}

function laneDelta(before, after, comparable, comparisonReason) {
  const baseline = before.cost_per_quality_passing_task_usd;
  const candidate = after.cost_per_quality_passing_task_usd;
  if (!comparable) return { status: "unknown", reason: comparisonReason };
  if (before.status !== "measured" || after.status !== "measured") {
    return { status: "unknown", reason: "actual_cost_receipt_missing_or_invalid" };
  }
  if (baseline === null || candidate === null) return { status: "unknown", reason: "no_quality_passes_in_window" };

  return {
    status: "measured",
    baseline_cost_per_quality_passing_task_usd: baseline,
    candidate_cost_per_quality_passing_task_usd: candidate,
    delta_usd: round(candidate - baseline),
    delta_percent: baseline === 0 ? null : round(((candidate - baseline) / baseline) * 100),
    percent_change_status: baseline === 0 ? "unknown_baseline_zero" : "measured",
  };
}

/**
 * Compare two normalized billing windows against the same quality holdout.
 * Receipts must be actual USD charges for their exact window. Usage, estimates,
 * credits, and missing lanes never become costs or zeroes.
 */
export function buildCostQualityDelta(input) {
  requireExactFields(input, new Set(["baseline", "candidate"]), "input");
  const baseline = normalizeRun(input.baseline, "baseline");
  const candidate = normalizeRun(input.candidate, "candidate");
  const baselineSummary = summarizeRun(baseline);
  const candidateSummary = summarizeRun(candidate);
  const equalWindowDuration = baseline.period.endMs - baseline.period.startMs === candidate.period.endMs - candidate.period.startMs;
  const sameHoldout = baseline.holdoutId === candidate.holdoutId;
  const sameQualitySource = baseline.qualitySourceId === candidate.qualitySourceId;
  const sameQualitySourceVersion = baseline.qualitySourceVersion === candidate.qualitySourceVersion;
  const sameSampleDenominator = baseline.completedTasks === candidate.completedTasks;
  const sameHoldoutTaskCount = baseline.holdoutTaskCount === candidate.holdoutTaskCount;
  const baselineSampleComplete = baseline.completedTasks > 0 && baseline.completedTasks === baseline.holdoutTaskCount;
  const candidateSampleComplete = candidate.completedTasks > 0 && candidate.completedTasks === candidate.holdoutTaskCount;
  const qualityNonInferiority = baselineSampleComplete && candidateSampleComplete
    ? BigInt(candidate.qualityPassingTasks) * BigInt(baseline.completedTasks) >=
      BigInt(baseline.qualityPassingTasks) * BigInt(candidate.completedTasks)
    : null;
  const comparable = equalWindowDuration && sameHoldout && sameQualitySource && sameQualitySourceVersion &&
    sameSampleDenominator && sameHoldoutTaskCount && baselineSampleComplete && candidateSampleComplete;
  const comparisonReason = comparable ? null :
    !sameHoldout ? "holdout_id_mismatch" :
    !sameQualitySource ? "quality_source_mismatch" :
    !sameQualitySourceVersion ? "quality_source_version_mismatch" :
    !baselineSampleComplete || !candidateSampleComplete ? "sample_incomplete" :
    !sameSampleDenominator ? "sample_denominator_mismatch" :
    !sameHoldoutTaskCount ? "holdout_task_count_mismatch" :
    "window_duration_mismatch";

  const lanes = Object.fromEntries(BILLABLE_LANES.map((lane) => {
    const before = baselineSummary.billable_lanes[lane];
    const after = candidateSummary.billable_lanes[lane];
    return [lane, { baseline: before, candidate: after, delta: laneDelta(before, after, comparable, comparisonReason) }];
  }));

  const incompleteLanes = BILLABLE_LANES.filter((lane) =>
    lanes[lane].baseline.status !== "measured" ||
    lanes[lane].candidate.status !== "measured" ||
    lanes[lane].baseline.cost_per_quality_passing_task_usd === null ||
    lanes[lane].candidate.cost_per_quality_passing_task_usd === null
  );
  const hasUnclassifiedReceipts = baselineSummary.unclassified_receipt_count > 0 || candidateSummary.unclassified_receipt_count > 0;
  const canMeasureOverall = comparable && incompleteLanes.length === 0 && !hasUnclassifiedReceipts;

  let overall = { status: "unknown", reason: "one_or_more_billable_lanes_are_incomplete", unknown_lanes: incompleteLanes };
  if (!comparable) overall = { status: "unknown", reason: comparisonReason, unknown_lanes: incompleteLanes };
  else if (!qualityNonInferiority) overall = { status: "unknown", reason: "quality_regression", unknown_lanes: incompleteLanes };
  else if (hasUnclassifiedReceipts) overall = { status: "unknown", reason: "unclassified_receipts_present", unknown_lanes: incompleteLanes };
  else if (canMeasureOverall) {
    const baselineTotal = BILLABLE_LANES.reduce((sum, lane) => sum + baselineSummary.billable_lanes[lane].actual_cost_usd, 0);
    const candidateTotal = BILLABLE_LANES.reduce((sum, lane) => sum + candidateSummary.billable_lanes[lane].actual_cost_usd, 0);
    const baselinePerPass = baselineTotal / baseline.qualityPassingTasks;
    const candidatePerPass = candidateTotal / candidate.qualityPassingTasks;
    overall = {
      status: "measured",
      baseline_gross_cost_usd: round(baselineTotal),
      candidate_gross_cost_usd: round(candidateTotal),
      baseline_cost_per_quality_passing_task_usd: round(baselinePerPass),
      candidate_cost_per_quality_passing_task_usd: round(candidatePerPass),
      delta_usd: round(candidatePerPass - baselinePerPass),
      delta_percent: baselinePerPass === 0 ? null : round(((candidatePerPass - baselinePerPass) / baselinePerPass) * 100),
      percent_change_status: baselinePerPass === 0 ? "unknown_baseline_zero" : "measured",
      credit_offsets_excluded: true,
    };
  }

  return {
    schema_version: 1,
    comparison: {
      status: comparable ? "comparable" : "unknown",
      same_holdout: sameHoldout,
      same_quality_source: sameQualitySource,
      same_quality_source_version: sameQualitySourceVersion,
      same_sample_denominator: sameSampleDenominator,
      same_holdout_task_count: sameHoldoutTaskCount,
      quality_non_inferiority: qualityNonInferiority === null ? "unknown" : qualityNonInferiority ? "passed" : "failed",
      equal_window_duration: equalWindowDuration,
      reason: comparisonReason,
    },
    baseline: baselineSummary,
    candidate: candidateSummary,
    lanes,
    overall,
  };
}
