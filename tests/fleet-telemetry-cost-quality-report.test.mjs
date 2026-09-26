import test from "node:test";
import assert from "node:assert/strict";
import { BILLABLE_LANES, buildCostQualityDelta } from "../skills/fleet-telemetry/cost-quality-report.mjs";

const start = "2026-09-01T00:00:00.000Z";
const end = "2026-09-08T00:00:00.000Z";
const nextStart = "2026-09-08T00:00:00.000Z";
const nextEnd = "2026-09-15T00:00:00.000Z";
const holdout = "synthetic-holdout-v1";

function actual(lane, amountUsd, periodStart, periodEnd, receiptId = `${lane}-fixture`) {
  return {
    lane,
    evidence_kind: "actual_charge",
    amount_usd: amountUsd,
    currency: "USD",
    period: { start: periodStart, end: periodEnd },
    receipt_id: receiptId,
    source_id: `${receiptId}-source`,
  };
}

function run({ id, periodStart, periodEnd, passes, receipts, completed = 10, holdoutId = holdout,
  holdoutTasks = 10, qualitySourceId = "synthetic-evaluator", qualitySourceVersion = "v1" }) {
  return {
    run_id: id,
    holdout_id: holdoutId,
    holdout_task_count: holdoutTasks,
    quality_source_id: qualitySourceId,
    quality_source_version: qualitySourceVersion,
    period: { start: periodStart, end: periodEnd },
    completed_tasks: completed,
    quality_passing_tasks: passes,
    receipts,
  };
}

function completeReceipts(amount, periodStart, periodEnd) {
  return BILLABLE_LANES.map((lane, index) => actual(lane, amount + index, periodStart, periodEnd, `${lane}-${amount}-fixture`));
}

test("reports lane-separated actual cost per quality pass and comparable delta", () => {
  const baselineReceipts = completeReceipts(10, start, end);
  const candidateReceipts = completeReceipts(8, nextStart, nextEnd);
  baselineReceipts.push({
    lane: "aws_credits", evidence_kind: "credit_offset", amount_usd: 50, currency: "USD",
    period: { start, end }, receipt_id: "aws-credit-before", source_id: "aws-credit-before-source",
  });
  candidateReceipts.push({
    lane: "aws_credits", evidence_kind: "credit_offset", amount_usd: 30, currency: "USD",
    period: { start: nextStart, end: nextEnd }, receipt_id: "aws-credit-after", source_id: "aws-credit-after-source",
  });

  const report = buildCostQualityDelta({
    baseline: run({ id: "before", periodStart: start, periodEnd: end, passes: 4, receipts: baselineReceipts }),
    candidate: run({ id: "after", periodStart: nextStart, periodEnd: nextEnd, passes: 5, receipts: candidateReceipts }),
  });

  assert.equal(report.overall.status, "measured");
  assert.equal(report.overall.credit_offsets_excluded, true);
  assert.equal(report.overall.baseline_cost_per_quality_passing_task_usd, 41.25);
  assert.equal(report.overall.candidate_cost_per_quality_passing_task_usd, 28.6);
  assert.equal(report.overall.delta_usd, -12.65);
  assert.equal(report.baseline.aws_credit_offsets.offset_usd, 50);
  assert.equal(report.candidate.aws_credit_offsets.offset_usd, 30);
  assert.equal(report.lanes.openai_api.baseline.actual_cost_usd, 12);
  assert.equal(report.lanes.anthropic_api.candidate.actual_cost_usd, 11);
  assert.equal(report.lanes.openai_api.delta.status, "measured");
});

test("usage counters and estimates never become costs or zero-dollar receipts", () => {
  const baselineReceipts = completeReceipts(1, start, end).filter((item) => item.lane !== "openai_api");
  baselineReceipts.push({
    lane: "openai_api", evidence_kind: "usage_only", usage_value: 1200, usage_unit: "tokens",
    period: { start, end }, receipt_id: "token-usage-fixture",
  });
  const candidateReceipts = completeReceipts(1, nextStart, nextEnd);
  candidateReceipts.push({
    lane: "openai_api", evidence_kind: "estimate", estimated_usd: 0.25,
    period: { start: nextStart, end: nextEnd }, receipt_id: "estimated-cost-fixture",
  });

  const report = buildCostQualityDelta({
    baseline: run({ id: "before", periodStart: start, periodEnd: end, passes: 2, receipts: baselineReceipts }),
    candidate: run({ id: "after", periodStart: nextStart, periodEnd: nextEnd, passes: 2, receipts: candidateReceipts }),
  });

  assert.equal(report.lanes.openai_api.baseline.status, "unknown");
  assert.equal(report.lanes.openai_api.baseline.reason, "non_actual_evidence_is_not_actual_cost");
  assert.equal(report.lanes.openai_api.candidate.actual_cost_usd, 3);
  assert.equal(report.lanes.openai_api.delta.status, "unknown");
  assert.equal(report.overall.status, "unknown");
});

test("duplicate, mismatched-period, and non-USD receipts fail closed per lane", () => {
  const baselineReceipts = completeReceipts(1, start, end);
  baselineReceipts.push(actual("make", 12, start, end, "make-duplicate"));
  const candidateReceipts = completeReceipts(1, nextStart, nextEnd);
  candidateReceipts.find((item) => item.lane === "depot").period.end = "2026-09-14T00:00:00.000Z";
  candidateReceipts.find((item) => item.lane === "greptile").currency = "EUR";

  const report = buildCostQualityDelta({
    baseline: run({ id: "before", periodStart: start, periodEnd: end, passes: 2, receipts: baselineReceipts }),
    candidate: run({ id: "after", periodStart: nextStart, periodEnd: nextEnd, passes: 2, receipts: candidateReceipts }),
  });

  assert.equal(report.lanes.make.baseline.reason, "multiple_actual_receipts_for_lane");
  assert.equal(report.lanes.depot.candidate.reason, "receipt_period_mismatch");
  assert.equal(report.lanes.greptile.candidate.reason, "currency_not_usd");
  assert.equal(report.overall.status, "unknown");
});

test("holdout or window-length mismatch withholds all deltas", () => {
  const receipts = completeReceipts(1, nextStart, nextEnd);
  const report = buildCostQualityDelta({
    baseline: run({ id: "before", periodStart: start, periodEnd: end, passes: 2, receipts: completeReceipts(1, start, end) }),
    candidate: run({ id: "after", periodStart: nextStart, periodEnd: "2026-09-14T00:00:00.000Z", passes: 2, receipts, holdoutId: "different-holdout" }),
  });

  assert.equal(report.comparison.status, "unknown");
  assert.equal(report.comparison.reason, "holdout_id_mismatch");
  assert.equal(report.lanes.chatgpt_subscription.delta.status, "unknown");
  assert.equal(report.overall.status, "unknown");
});

test("a zero quality-pass denominator does not produce an infinite or zero ratio", () => {
  const report = buildCostQualityDelta({
    baseline: run({ id: "before", periodStart: start, periodEnd: end, passes: 0, receipts: completeReceipts(1, start, end) }),
    candidate: run({ id: "after", periodStart: nextStart, periodEnd: nextEnd, passes: 2, receipts: completeReceipts(1, nextStart, nextEnd) }),
  });

  assert.equal(report.lanes.chatgpt_subscription.baseline.status, "measured");
  assert.equal(report.lanes.chatgpt_subscription.baseline.cost_per_quality_passing_task_usd, null);
  assert.equal(report.lanes.chatgpt_subscription.delta.status, "unknown");
  assert.equal(report.overall.status, "unknown");
});

test("unclassified vendor receipts prevent a complete overall total", () => {
  const baselineReceipts = completeReceipts(1, start, end);
  baselineReceipts.push(actual("unknown_vendor", 3, start, end, "unclassified-fixture"));

  const report = buildCostQualityDelta({
    baseline: run({ id: "before", periodStart: start, periodEnd: end, passes: 2, receipts: baselineReceipts }),
    candidate: run({ id: "after", periodStart: nextStart, periodEnd: nextEnd, passes: 2, receipts: completeReceipts(1, nextStart, nextEnd) }),
  });

  assert.equal(report.baseline.unclassified_receipt_count, 1);
  assert.equal(report.overall.status, "unknown");
  assert.equal(report.overall.reason, "unclassified_receipts_present");
});

test("evaluator identity, evaluator version, sample denominator, and holdout size must match", () => {
  const base = {
    id: "before", periodStart: start, periodEnd: end, passes: 2,
    receipts: completeReceipts(1, start, end),
  };
  const candidate = {
    id: "after", periodStart: nextStart, periodEnd: nextEnd, passes: 2,
    receipts: completeReceipts(1, nextStart, nextEnd),
  };

  for (const [change, reason] of [
    [{ qualitySourceId: "different-evaluator" }, "quality_source_mismatch"],
    [{ qualitySourceVersion: "v2" }, "quality_source_version_mismatch"],
    [{ completed: 11 }, "sample_denominator_mismatch"],
    [{ holdoutTasks: 11 }, "holdout_task_count_mismatch_or_empty"],
  ]) {
    const report = buildCostQualityDelta({ baseline: run(base), candidate: run({ ...candidate, ...change }) });
    assert.equal(report.comparison.status, "unknown");
    assert.equal(report.comparison.reason, reason);
    assert.equal(report.lanes.openai_api.delta.status, "unknown");
  }
});

test("zero holdout task count is not comparable", () => {
  const report = buildCostQualityDelta({
    baseline: run({ id: "before", periodStart: start, periodEnd: end, passes: 2, holdoutTasks: 0, receipts: completeReceipts(1, start, end) }),
    candidate: run({ id: "after", periodStart: nextStart, periodEnd: nextEnd, passes: 2, holdoutTasks: 0, receipts: completeReceipts(1, nextStart, nextEnd) }),
  });

  assert.equal(report.comparison.status, "unknown");
  assert.equal(report.comparison.reason, "holdout_task_count_mismatch_or_empty");
});

test("output omits all supplied run, holdout, evaluator, receipt, and source identifiers", () => {
  const baselineReceipts = completeReceipts(1, start, end);
  baselineReceipts[0].receipt_id = "synthetic-customer-name-1";
  baselineReceipts[0].source_id = "synthetic-account-label-1";
  const candidateReceipts = completeReceipts(1, nextStart, nextEnd);
  const report = buildCostQualityDelta({
    baseline: run({
      id: "synthetic-run-label-1", holdoutId: "synthetic-customer-holdout-1", qualitySourceId: "synthetic-evaluator-label-1",
      periodStart: start, periodEnd: end, passes: 2, receipts: baselineReceipts,
    }),
    candidate: run({
      id: "synthetic-run-label-2", holdoutId: "synthetic-customer-holdout-1", qualitySourceId: "synthetic-evaluator-label-1",
      periodStart: nextStart, periodEnd: nextEnd, passes: 2, receipts: candidateReceipts,
    }),
  });
  const serialized = JSON.stringify(report);

  for (const value of [
    "synthetic-run-label-1", "synthetic-run-label-2", "synthetic-customer-holdout-1",
    "synthetic-evaluator-label-1", "synthetic-customer-name-1", "synthetic-account-label-1",
  ]) assert.equal(serialized.includes(value), false);
  assert.equal(serialized.includes("\"run_id\""), false);
  assert.equal(serialized.includes("\"holdout_id\""), false);
  assert.equal(serialized.includes("\"source_id\""), false);
  assert.equal(serialized.includes("\"receipt_id\""), false);
});

test("rejects fields outside the normalized input contract", () => {
  const validBaseline = run({ id: "before", periodStart: start, periodEnd: end, passes: 2, receipts: completeReceipts(1, start, end) });
  const validCandidate = run({ id: "after", periodStart: nextStart, periodEnd: nextEnd, passes: 2, receipts: completeReceipts(1, nextStart, nextEnd) });

  assert.throws(() => buildCostQualityDelta({ baseline: validBaseline, candidate: validCandidate, customer: "fixture-only" }), /unsupported fields/);
  assert.throws(() => buildCostQualityDelta({ baseline: { ...validBaseline, extra: true }, candidate: validCandidate }), /unsupported fields/);
  assert.throws(() => buildCostQualityDelta({ baseline: { ...validBaseline, period: { ...validBaseline.period, customer: "fixture-only" } }, candidate: validCandidate }), /unsupported fields/);
  assert.throws(() => buildCostQualityDelta({
    baseline: { ...validBaseline, receipts: [{ ...validBaseline.receipts[0], account_name: "fixture-only" }, ...validBaseline.receipts.slice(1)] },
    candidate: validCandidate,
  }), /unsupported fields/);
});
