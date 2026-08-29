// Tests for skills/agent-evals/judge-compare.mjs -- the PURE agreement-math behind --judge-compare.
// No network, no fs; every case is a plain function call on hand-built judge-result fixtures.
import { test } from "node:test";
import assert from "node:assert/strict";
import { compareJudgeRow, aggregateJudgeComparison, renderJudgeComparisonReport } from "../judge-compare.mjs";

test("compareJudgeRow: identical scores/met -> verdictAgree true, scoreDelta 0, full criterion agreement", () => {
  const row = compareJudgeRow({ id: "t1", agent: "cto", a: { score: 1, met: [true, true] }, b: { score: 1, met: [true, true] } });
  assert.equal(row.verdictAgree, true);
  assert.equal(row.scoreDelta, 0);
  assert.equal(row.criterionAgreementRate, 1);
  assert.equal(row.passA, true);
  assert.equal(row.passB, true);
});

test("compareJudgeRow: a scored above PASS_AT, b scored below -> verdictAgree false (a real disagreement)", () => {
  const row = compareJudgeRow({ id: "t2", agent: "cfo", a: { score: 0.8, met: [true, true] }, b: { score: 0.4, met: [true, false] } }, 0.7);
  assert.equal(row.passA, true);
  assert.equal(row.passB, false);
  assert.equal(row.verdictAgree, false);
  assert.ok(Math.abs(row.scoreDelta - 0.4) < 1e-9);
  assert.equal(row.criterionAgreementRate, 0.5);
});

test("compareJudgeRow: both judges below PASS_AT -> verdictAgree true even though neither passed (agreement is about the VERDICT, not the score)", () => {
  const row = compareJudgeRow({ id: "t3", agent: "clo", a: { score: 0.3, met: [false] }, b: { score: 0.1, met: [false] } }, 0.7);
  assert.equal(row.passA, false);
  assert.equal(row.passB, false);
  assert.equal(row.verdictAgree, true);
});

test("compareJudgeRow: default passAt is 0.7 (matches run-evals.mjs's PASS_AT) when not supplied", () => {
  const row = compareJudgeRow({ id: "t4", agent: "cto", a: { score: 0.7, met: [] }, b: { score: 0.69, met: [] } });
  assert.equal(row.passA, true);
  assert.equal(row.passB, false);
});

test("compareJudgeRow: mismatched met-array lengths report criterionAgreementRate as null, never a wrong number or a crash", () => {
  const row = compareJudgeRow({ id: "t5", agent: "cto", a: { score: 0.5, met: [true, false] }, b: { score: 0.5, met: [true] } });
  assert.equal(row.criterionAgreementRate, null);
});

test("compareJudgeRow: missing/malformed met arrays (undefined, non-array) never throw and report null agreement", () => {
  const row1 = compareJudgeRow({ id: "t6", agent: "cto", a: { score: 0.5 }, b: { score: 0.5, met: [true] } });
  assert.equal(row1.criterionAgreementRate, null);
  const row2 = compareJudgeRow({ id: "t7", agent: "cto", a: {}, b: {} });
  assert.equal(row2.scoreA, 0);
  assert.equal(row2.scoreB, 0);
  assert.equal(row2.criterionAgreementRate, null);
});

test("compareJudgeRow: an empty met array on both sides reports null (not divide-by-zero 0/0=NaN)", () => {
  const row = compareJudgeRow({ id: "t8", agent: "cto", a: { score: 0, met: [] }, b: { score: 0, met: [] } });
  assert.equal(row.criterionAgreementRate, null);
});

test("aggregateJudgeComparison: n=0 (no rows) returns all-null fields, never NaN or a throw", () => {
  const summary = aggregateJudgeComparison([]);
  assert.equal(summary.n, 0);
  assert.equal(summary.meanAbsDelta, null);
  assert.equal(summary.maxDelta, null);
  assert.equal(summary.verdictAgreementRate, null);
  assert.equal(summary.meanCriterionAgreement, null);
  assert.deepEqual(summary.disagreements, []);
});

test("aggregateJudgeComparison: mixed agree/disagree rows compute the right rates and lists the disagreements by agent/id", () => {
  const rows = [
    compareJudgeRow({ id: "a1", agent: "cto", a: { score: 1, met: [true] }, b: { score: 1, met: [true] } }),   // agree
    compareJudgeRow({ id: "a2", agent: "cfo", a: { score: 0.9, met: [true] }, b: { score: 0.1, met: [false] } }), // disagree
    compareJudgeRow({ id: "a3", agent: "clo", a: { score: 0.2, met: [false] }, b: { score: 0.3, met: [false] } }), // agree (both fail)
  ];
  const summary = aggregateJudgeComparison(rows);
  assert.equal(summary.n, 3);
  assert.ok(Math.abs(summary.verdictAgreementRate - 2 / 3) < 1e-9);
  assert.deepEqual(summary.disagreements, ["cfo/a2"]);
  assert.ok(summary.meanAbsDelta > 0);
  assert.ok(summary.maxDelta >= summary.meanAbsDelta);
});

test("aggregateJudgeComparison: meanCriterionAgreement excludes rows with a null criterionAgreementRate rather than treating them as 0", () => {
  const rows = [
    compareJudgeRow({ id: "b1", agent: "cto", a: { score: 1, met: [true, true] }, b: { score: 1, met: [true, true] } }), // agreement 1
    compareJudgeRow({ id: "b2", agent: "cto", a: { score: 1, met: [true, true, true] }, b: { score: 1, met: [true] } }), // mismatched length -> null
  ];
  const summary = aggregateJudgeComparison(rows);
  // If the null row were coerced to 0 this would read 0.5; excluding it correctly keeps it at 1.
  assert.equal(summary.meanCriterionAgreement, 1);
});

test("renderJudgeComparisonReport produces a readable report naming both judges, every row, and the summary line, with no em/en dashes", () => {
  const rows = [compareJudgeRow({ id: "c1", agent: "cto", a: { score: 1, met: [true] }, b: { score: 0.5, met: [false] } })];
  const summary = aggregateJudgeComparison(rows);
  const report = renderJudgeComparisonReport(rows, summary, { labelA: "openai-standard", labelB: "bedrock-nova" });
  assert.match(report, /openai-standard vs bedrock-nova/);
  assert.match(report, /cto\/c1/);
  assert.match(report, /DISAGREE/);
  assert.match(report, /SUMMARY:/);
  assert.match(report, /DISAGREEMENTS \(verdict flips\): cto\/c1/);
  assert.ok(!report.includes("—"), "no em dash");
  assert.ok(!report.includes("–"), "no en dash");
});

test("renderJudgeComparisonReport handles the n=0 case without throwing or printing 'NaN'/'undefined'", () => {
  const summary = aggregateJudgeComparison([]);
  const report = renderJudgeComparisonReport([], summary);
  assert.ok(!/NaN/.test(report));
  assert.ok(!/undefined/.test(report));
  assert.match(report, /n=0/);
});
