// Tests for critic-pass/critic.mjs, the pure cheap-verifier prompt-builder + verdict-parser.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCriticPrompt, parseCriticVerdict, shouldRevise } from "../skills/critic-pass/critic.mjs";

test("buildCriticPrompt includes the task and draft verbatim", () => {
  const p = buildCriticPrompt("Design a billing migration", "Step 1: drop the old table.");
  assert.ok(p.includes("Design a billing migration"));
  assert.ok(p.includes("Step 1: drop the old table."));
});

test("buildCriticPrompt instructs strict JSON output with verdict/issues/confidence shape", () => {
  const p = buildCriticPrompt("task", "draft");
  assert.ok(/STRICT JSON/i.test(p));
  assert.ok(p.includes('"verdict"'));
  assert.ok(p.includes('"issues"'));
  assert.ok(p.includes('"confidence"'));
});

test("buildCriticPrompt lists the five check categories", () => {
  const p = buildCriticPrompt("task", "draft");
  assert.ok(/unsupported claims/i.test(p));
  assert.ok(/logical gaps/i.test(p));
  assert.ok(/missed constraints/i.test(p));
  assert.ok(/math or factual errors/i.test(p));
  assert.ok(/unstated assumptions/i.test(p));
});

test("buildCriticPrompt includes constraints and context when provided", () => {
  const p = buildCriticPrompt("task", "draft", { constraints: ["must be HIPAA compliant"], context: "prior PR #12 context" });
  assert.ok(p.includes("must be HIPAA compliant"));
  assert.ok(p.includes("prior PR #12 context"));
});

test("parseCriticVerdict handles valid approve JSON", () => {
  const raw = JSON.stringify({ verdict: "approve", issues: [], confidence: 0.9 });
  const v = parseCriticVerdict(raw);
  assert.equal(v.verdict, "approve");
  assert.deepEqual(v.issues, []);
  assert.equal(v.confidence, 0.9);
  assert.equal(v.malformed, false);
});

test("parseCriticVerdict handles valid revise JSON with issues", () => {
  const raw = JSON.stringify({
    verdict: "revise",
    issues: [
      { severity: "high", note: "unsupported claim about throughput" },
      { severity: "low", note: "minor wording nit" },
    ],
    confidence: 0.7,
  });
  const v = parseCriticVerdict(raw);
  assert.equal(v.verdict, "revise");
  assert.equal(v.issues.length, 2);
  assert.equal(v.issues[0].severity, "high");
  assert.equal(v.malformed, false);
});

test("parseCriticVerdict strips markdown code fences", () => {
  const raw = '```json\n{"verdict": "approve", "issues": [], "confidence": 0.5}\n```';
  const v = parseCriticVerdict(raw);
  assert.equal(v.verdict, "approve");
  assert.equal(v.malformed, false);
});

test("parseCriticVerdict extracts JSON from surrounding prose", () => {
  const raw = 'Sure, here is my review:\n{"verdict": "revise", "issues": [{"severity":"medium","note":"x"}], "confidence": 0.6}\nHope that helps!';
  const v = parseCriticVerdict(raw);
  assert.equal(v.verdict, "revise");
  assert.equal(v.malformed, false);
});

test("parseCriticVerdict fails safe to approve on malformed JSON", () => {
  const v = parseCriticVerdict("not json at all {{{");
  assert.equal(v.verdict, "approve");
  assert.equal(v.malformed, true);
  assert.deepEqual(v.issues, []);
});

test("parseCriticVerdict fails safe to approve on null/empty input", () => {
  assert.equal(parseCriticVerdict(null).malformed, true);
  assert.equal(parseCriticVerdict("").malformed, true);
  assert.equal(parseCriticVerdict(undefined).malformed, true);
});

test("parseCriticVerdict fails safe when verdict field is missing or invalid", () => {
  const v1 = parseCriticVerdict(JSON.stringify({ issues: [], confidence: 0.5 }));
  assert.equal(v1.malformed, true);
  assert.equal(v1.verdict, "approve");

  const v2 = parseCriticVerdict(JSON.stringify({ verdict: "maybe", issues: [] }));
  assert.equal(v2.malformed, true);
});

test("parseCriticVerdict clamps out-of-range confidence and defaults missing confidence", () => {
  const v1 = parseCriticVerdict(JSON.stringify({ verdict: "approve", issues: [], confidence: 5 }));
  assert.equal(v1.confidence, 1);
  const v2 = parseCriticVerdict(JSON.stringify({ verdict: "approve", issues: [], confidence: -3 }));
  assert.equal(v2.confidence, 0);
  const v3 = parseCriticVerdict(JSON.stringify({ verdict: "approve", issues: [] }));
  assert.equal(v3.confidence, 0.5);
});

test("parseCriticVerdict coerces unknown issue severity to medium", () => {
  const raw = JSON.stringify({ verdict: "revise", issues: [{ severity: "bogus", note: "x" }], confidence: 0.5 });
  const v = parseCriticVerdict(raw);
  assert.equal(v.issues[0].severity, "medium");
});

test("shouldRevise is true for revise verdict meeting default (medium) severity", () => {
  const v = parseCriticVerdict(JSON.stringify({ verdict: "revise", issues: [{ severity: "medium", note: "x" }], confidence: 0.6 }));
  assert.equal(shouldRevise(v), true);
});

test("shouldRevise honors minSeverity - low-severity revise does not clear a high bar", () => {
  const v = parseCriticVerdict(JSON.stringify({ verdict: "revise", issues: [{ severity: "low", note: "x" }], confidence: 0.6 }));
  assert.equal(shouldRevise(v, { minSeverity: "high" }), false);
  assert.equal(shouldRevise(v, { minSeverity: "low" }), true);
});

test("shouldRevise honors minSeverity - critical issue clears every bar", () => {
  const v = parseCriticVerdict(JSON.stringify({ verdict: "revise", issues: [{ severity: "critical", note: "x" }], confidence: 0.9 }));
  assert.equal(shouldRevise(v, { minSeverity: "critical" }), true);
  assert.equal(shouldRevise(v, { minSeverity: "low" }), true);
});

test("shouldRevise is always false for approve verdicts", () => {
  const v = parseCriticVerdict(JSON.stringify({ verdict: "approve", issues: [], confidence: 0.9 }));
  assert.equal(shouldRevise(v), false);
});

test("shouldRevise is always false for malformed (fail-safe) verdicts, even if forced to revise shape", () => {
  const v = parseCriticVerdict("garbage");
  assert.equal(v.malformed, true);
  assert.equal(shouldRevise(v), false);
  assert.equal(shouldRevise(v, { minSeverity: "low" }), false);
});

test("shouldRevise treats a revise verdict with no itemized issues as revise-worthy", () => {
  const v = parseCriticVerdict(JSON.stringify({ verdict: "revise", issues: [], confidence: 0.5 }));
  assert.equal(shouldRevise(v), true);
});

test("no em-dash or en-dash characters appear in critic.mjs output strings", () => {
  const p = buildCriticPrompt("task", "draft");
  assert.ok(!p.includes("—"), "no em dash");
  assert.ok(!p.includes("–"), "no en dash");
});
