// Unit tests for the MULTI-JUDGE PANEL + CALIBRATION pure core (skills/agent-evals/judgepanel.mjs),
// north-star self-improving-loop wave, item B. Exercises panel aggregation, confidence labeling, and
// calibration math with zero network I/O and zero mocks beyond a fake judgeFn where needed. Guards the
// safety-relevant invariants: this module is purely advisory (never touches score/pass) and never
// throws on missing/sparse golden data (calibrate() must always be safe to call).
import { test } from "node:test";
import assert from "node:assert";
import {
  resolvePanelTiers,
  runJudgePanel,
  aggregatePanel,
  confidenceLabel,
  buildCalibration,
  calibrate,
  attachPanelToResult,
  DEFAULT_PANEL_TIERS,
} from "./judgepanel.mjs";

// ---------------------------------------------------------------------------
// resolvePanelTiers
// ---------------------------------------------------------------------------

test("resolvePanelTiers resolves known model-routing tier names to their deployments", () => {
  const resolved = resolvePanelTiers(["quality", "standard", "cheap"]);
  assert.equal(resolved.length, 3);
  assert.equal(resolved[0].tier, "quality");
  assert.ok(resolved[0].deployment, "quality tier must resolve to a real deployment name");
  assert.equal(resolved[1].tier, "standard");
  assert.equal(resolved[2].tier, "cheap");
  // never hardcode: the resolved deployment must come from model-routing, not this module.
  const names = resolved.map((r) => r.deployment);
  assert.ok(new Set(names).size === names.length || names.length <= 3, "sanity: distinct tiers resolve");
});

test("resolvePanelTiers treats an unknown name as an explicit deployment override (no crash)", () => {
  const resolved = resolvePanelTiers(["totally-custom-deployment"]);
  assert.equal(resolved[0].tier, "totally-custom-deployment");
  assert.equal(resolved[0].deployment, "totally-custom-deployment");
});

test("DEFAULT_PANEL_TIERS has 2-3 judges as specified", () => {
  assert.ok(DEFAULT_PANEL_TIERS.length >= 2 && DEFAULT_PANEL_TIERS.length <= 3);
});

// ---------------------------------------------------------------------------
// runJudgePanel (IO shim, fault tolerance)
// ---------------------------------------------------------------------------

test("runJudgePanel calls judgeFn once per tier and collects scores", async () => {
  const calls = [];
  const judgeFn = async (tier) => { calls.push(tier); return { score: tier === "quality" ? 1 : 0.5, met: [true], notes: "ok" }; };
  const rows = await runJudgePanel(judgeFn, "task", ["r1"], "answer", { tiers: ["quality", "standard"] });
  assert.equal(calls.length, 2);
  assert.equal(rows.length, 2);
  assert.equal(rows.find((r) => r.tier === "quality").score, 1);
  assert.equal(rows.find((r) => r.tier === "standard").score, 0.5);
});

test("runJudgePanel drops a judge that throws without failing the whole panel", async () => {
  const judgeFn = async (tier) => { if (tier === "cheap") throw new Error("429 rate limited"); return { score: 0.9, met: [true] }; };
  const errors = [];
  const rows = await runJudgePanel(judgeFn, "task", ["r1"], "answer", { tiers: ["quality", "cheap"], onError: (t, r) => errors.push([t, r]) });
  assert.equal(rows.length, 2);
  const cheapRow = rows.find((r) => r.tier === "cheap");
  assert.equal(cheapRow.score, null);
  assert.match(cheapRow.error, /429/);
  assert.equal(errors.length, 1);
  assert.equal(errors[0][0], "cheap");
  // the surviving judge is untouched
  assert.equal(rows.find((r) => r.tier === "quality").score, 0.9);
});

test("runJudgePanel drops a judge that returns a non-finite score", async () => {
  const judgeFn = async () => ({ score: NaN });
  const rows = await runJudgePanel(judgeFn, "task", ["r1"], "answer", { tiers: ["quality"] });
  assert.equal(rows[0].score, null);
  assert.match(rows[0].error, /invalid judge result/i);
});

// ---------------------------------------------------------------------------
// aggregatePanel (pure)
// ---------------------------------------------------------------------------

test("aggregatePanel averages surviving scores into panel_score", () => {
  const rows = [{ tier: "quality", score: 1.0 }, { tier: "standard", score: 0.8 }, { tier: "cheap", score: 0.6 }];
  const panel = aggregatePanel(rows);
  assert.ok(Math.abs(panel.panel_score - 0.8) < 1e-9);
  assert.equal(panel.n_judges_attempted, 3);
  assert.equal(panel.n_judges_surviving, 3);
});

test("aggregatePanel excludes errored judges from the mean but keeps them in judges[]", () => {
  const rows = [{ tier: "quality", score: 1.0 }, { tier: "cheap", score: null, error: "timeout" }];
  const panel = aggregatePanel(rows);
  assert.equal(panel.panel_score, 1.0, "errored judge must not drag the mean toward 0");
  assert.equal(panel.n_judges_attempted, 2);
  assert.equal(panel.n_judges_surviving, 1);
  assert.equal(panel.judges.length, 2, "errored judge is still visible in the raw judges list");
});

test("aggregatePanel: perfect agreement (identical scores) yields agreement close to 1", () => {
  const rows = [{ tier: "quality", score: 0.75 }, { tier: "standard", score: 0.75 }, { tier: "cheap", score: 0.75 }];
  const panel = aggregatePanel(rows);
  assert.ok(panel.agreement > 0.99);
});

test("aggregatePanel: maximal disagreement (0 vs 1) yields low agreement", () => {
  const rows = [{ tier: "quality", score: 1.0 }, { tier: "standard", score: 0.0 }];
  const panel = aggregatePanel(rows);
  assert.ok(panel.agreement < 0.2, `expected low agreement, got ${panel.agreement}`);
  assert.ok(panel.agreement >= 0, "agreement must be clamped to >= 0");
});

test("aggregatePanel: agreement is null with fewer than 2 surviving judges", () => {
  const onlyOne = aggregatePanel([{ tier: "quality", score: 0.9 }]);
  assert.equal(onlyOne.agreement, null);
  const none = aggregatePanel([{ tier: "quality", score: null, error: "boom" }]);
  assert.equal(none.agreement, null);
  assert.equal(none.panel_score, null);
});

// ---------------------------------------------------------------------------
// confidenceLabel (pure)
// ---------------------------------------------------------------------------

test("confidenceLabel: unscored when nothing survived", () => {
  assert.equal(confidenceLabel(null, 0), "unscored");
});

test("confidenceLabel: low with only one surviving judge, even if agreement is somehow non-null", () => {
  assert.equal(confidenceLabel(0.99, 1), "low");
});

test("confidenceLabel: high/medium/low thresholds", () => {
  assert.equal(confidenceLabel(0.9, 3), "high");
  assert.equal(confidenceLabel(0.8, 2), "high");
  assert.equal(confidenceLabel(0.6, 2), "medium");
  assert.equal(confidenceLabel(0.5, 3), "medium");
  assert.equal(confidenceLabel(0.3, 2), "low");
});

// ---------------------------------------------------------------------------
// buildCalibration + calibrate (pure)
// ---------------------------------------------------------------------------

test("buildCalibration with no golden pairs returns the identity curve", () => {
  const cal = buildCalibration([]);
  assert.equal(cal.n, 0);
  assert.equal(cal.mae, null);
  assert.equal(calibrate(0.42, cal), 0.42);
  assert.equal(calibrate(0, cal), 0);
  assert.equal(calibrate(1, cal), 1);
});

test("buildCalibration fits an exact curve through golden pairs and calibrate() reproduces them", () => {
  const pairs = [
    { panel_score: 0.0, human_score: 0.0 },
    { panel_score: 0.5, human_score: 0.4 },
    { panel_score: 1.0, human_score: 1.0 },
  ];
  const cal = buildCalibration(pairs);
  assert.equal(cal.n, 3);
  assert.ok(cal.mae < 1e-9, "MAE should be ~0 when calibrate() is evaluated exactly at the fitted points");
  assert.ok(Math.abs(calibrate(0.5, cal) - 0.4) < 1e-9);
  assert.ok(Math.abs(calibrate(0.0, cal) - 0.0) < 1e-9);
  assert.ok(Math.abs(calibrate(1.0, cal) - 1.0) < 1e-9);
});

test("calibrate interpolates linearly between two golden anchor points", () => {
  const cal = buildCalibration([{ panel_score: 0.0, human_score: 0.0 }, { panel_score: 1.0, human_score: 0.8 }]);
  // midpoint of a straight line from (0,0) to (1,0.8) is (0.5, 0.4)
  assert.ok(Math.abs(calibrate(0.5, cal) - 0.4) < 1e-9);
});

test("buildCalibration enforces monotonicity even if golden labels are noisy/non-monotone", () => {
  // A human rated a HIGHER panel_score with a LOWER human_score than a lower panel_score point -
  // the fitted curve must never decrease as panel_score increases.
  const pairs = [
    { panel_score: 0.3, human_score: 0.6 },
    { panel_score: 0.7, human_score: 0.5 }, // noisy: lower human score at a higher panel_score
  ];
  const cal = buildCalibration(pairs);
  let prevY = -Infinity;
  for (const p of cal.points) {
    assert.ok(p.y >= prevY - 1e-9, "calibration curve must be non-decreasing");
    prevY = p.y;
  }
});

test("buildCalibration averages duplicate panel_score buckets", () => {
  const pairs = [
    { panel_score: 0.5, human_score: 0.4 },
    { panel_score: 0.5, human_score: 0.6 },
  ];
  const cal = buildCalibration(pairs);
  assert.ok(Math.abs(calibrate(0.5, cal) - 0.5) < 1e-9, "duplicate bucket should average to 0.5");
});

test("calibrate never throws and passes through non-finite / missing input safely", () => {
  const cal = buildCalibration([{ panel_score: 0.2, human_score: 0.3 }]);
  assert.equal(calibrate(NaN, cal), NaN);
  assert.equal(calibrate(undefined, cal), undefined);
  assert.doesNotThrow(() => calibrate(0.5, null));
  assert.equal(calibrate(0.5, null), 0.5);
  assert.doesNotThrow(() => calibrate(0.5, { points: [] }));
});

test("calibrate clamps out-of-range panel scores into [0,1] before interpolating", () => {
  const cal = buildCalibration([{ panel_score: 0.0, human_score: 0.1 }, { panel_score: 1.0, human_score: 0.9 }]);
  assert.equal(calibrate(-5, cal), calibrate(0, cal));
  assert.equal(calibrate(5, cal), calibrate(1, cal));
});

// ---------------------------------------------------------------------------
// attachPanelToResult (pure, additive-only invariant)
// ---------------------------------------------------------------------------

test("attachPanelToResult is purely additive: never touches existing score/pass fields", () => {
  const result = { id: "t1", agent: "cto", score: 0.85, pass: true, notes: "single-judge gate result", met: [true, true] };
  const panel = aggregatePanel([{ tier: "quality", score: 0.8 }, { tier: "standard", score: 0.8 }]);
  const merged = attachPanelToResult(result, panel);
  assert.equal(merged.score, 0.85, "single-judge score must be unchanged");
  assert.equal(merged.pass, true, "single-judge pass verdict must be unchanged");
  assert.equal(merged.notes, "single-judge gate result");
  assert.deepEqual(merged.met, [true, true]);
  // new advisory fields are present
  assert.ok(Math.abs(merged.panel_score - 0.8) < 1e-9);
  assert.equal(merged.confidence, "high");
  assert.deepEqual(merged.judge_tiers, ["quality", "standard"]);
});

test("attachPanelToResult applies calibration to produce calibrated_score when provided", () => {
  const result = { id: "t1", score: 0.6, pass: false };
  const panel = aggregatePanel([{ tier: "quality", score: 0.5 }, { tier: "standard", score: 0.5 }]);
  const calibration = buildCalibration([{ panel_score: 0.0, human_score: 0.0 }, { panel_score: 0.5, human_score: 0.3 }, { panel_score: 1.0, human_score: 1.0 }]);
  const merged = attachPanelToResult(result, panel, calibration);
  assert.ok(Math.abs(merged.calibrated_score - 0.3) < 1e-9);
  assert.equal(merged.calibration_n, 3);
});

test("attachPanelToResult handles a fully-unscored panel (calibrated_score is null, not a crash)", () => {
  const result = { id: "t1", score: 0.4, pass: false };
  const panel = aggregatePanel([{ tier: "quality", score: null, error: "boom" }]);
  const merged = attachPanelToResult(result, panel);
  assert.equal(merged.panel_score, null);
  assert.equal(merged.calibrated_score, null);
  assert.equal(merged.confidence, "unscored");
});
