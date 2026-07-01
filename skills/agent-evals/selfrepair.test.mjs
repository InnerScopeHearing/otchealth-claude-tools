// Regression tests for the prompt-regression SELF-REPAIR planner (skills/agent-evals/selfrepair.mjs),
// north-star self-improving-loop item #1. Guards the SAFETY-relevant invariants of the pure planner:
//   - a regressed golden task WITH a prompt_file is auto-repairable (a revert target);
//   - a regressed task WITHOUT a prompt_file is SKIPPED with a reason, never silently dropped;
//   - tasks that share a prompt_file collapse to ONE revert (don't propose the same revert N times);
//   - `primary` is the file whose revert recovers the biggest drop (most-negative delta);
//   - a hard pass->fail flip counts as a regression even if the score drop is < 15 pts.
// selfrepair.mjs is a new module, so this suite is inherently fail-on-old-code (it cannot run without it).
import { test } from "node:test";
import assert from "node:assert";
import { planRepairs, renderMarkdown } from "./selfrepair.mjs";

// scorecard row helper. diffScorecards() keys on id and reads {score, pass, agent, callsite_id, prompt_file}.
const row = (id, agent, score, pass, prompt_file, callsite_id) => ({ id, agent, callsite_id: callsite_id || agent, prompt_file: prompt_file ?? null, score, pass, notes: "" });
const card = (results) => ({ model: "gpt-4o", passAt: 0.7, avg: 0, passed: 0, total: results.length, results });

test("regression with a prompt_file is auto-repairable and becomes primary", () => {
  const base = card([row("t1", "cto", 1.0, true, "skills/agent-evals/run-evals.mjs")]);
  const head = card([row("t1", "cto", 0.5, false, "skills/agent-evals/run-evals.mjs")]);
  const plan = planRepairs(base, head);
  assert.equal(plan.total_regressions, 1);
  assert.equal(plan.repairable_count, 1);
  assert.equal(plan.repairs.length, 1);
  assert.ok(plan.primary);
  assert.equal(plan.primary.prompt_file, "skills/agent-evals/run-evals.mjs");
  assert.deepEqual(plan.primary.task_ids, ["t1"]);
  assert.ok(plan.primary.worst_delta <= -0.15);
});

test("regression WITHOUT a prompt_file is skipped with a reason, never repaired", () => {
  const base = card([row("t1", "growth", 1.0, true, null)]);
  const head = card([row("t1", "growth", 0.4, false, null)]);
  const plan = planRepairs(base, head);
  assert.equal(plan.total_regressions, 1);
  assert.equal(plan.repairable_count, 0);
  assert.equal(plan.repairs.length, 0);
  assert.equal(plan.primary, null);
  assert.equal(plan.skipped.length, 1);
  assert.match(plan.skipped[0].reason, /no prompt_file/i);
});

test("multiple regressed tasks sharing one prompt_file collapse to a single revert", () => {
  const pf = "skills/company-brain/brain.mjs";
  const base = card([row("a", "brain", 1.0, true, pf), row("b", "brain", 1.0, true, pf)]);
  const head = card([row("a", "brain", 0.5, false, pf), row("b", "brain", 0.6, false, pf)]);
  const plan = planRepairs(base, head);
  assert.equal(plan.total_regressions, 2);
  assert.equal(plan.repairs.length, 1, "one revert covers both tasks");
  assert.equal(plan.repairs[0].n_tasks, 2);
  assert.deepEqual(plan.repairs[0].task_ids.sort(), ["a", "b"]);
});

test("primary is the file with the most-negative drop across several files", () => {
  const base = card([row("x", "cto", 1.0, true, "fileA"), row("y", "cfo", 1.0, true, "fileB")]);
  const head = card([row("x", "cto", 0.8, true, "fileA"), row("y", "cfo", 0.3, false, "fileB")]); // fileB drops more (-0.7)
  const plan = planRepairs(base, head);
  // fileA drop is -0.2 (>=0.15 so it regresses), fileB drop is -0.7; primary must be fileB.
  assert.equal(plan.repairs.length, 2);
  assert.equal(plan.primary.prompt_file, "fileB");
  assert.ok(plan.primary.worst_delta < plan.repairs[1].worst_delta);
});

test("a hard pass->fail flip is a regression even when the score drop is small", () => {
  // 0.72 (pass) -> 0.68 (fail): only -0.04, below the -0.15 erosion threshold, but it crossed the pass line.
  const base = card([row("t", "cto", 0.72, true, "skills/agent-evals/run-evals.mjs")]);
  const head = card([row("t", "cto", 0.68, false, "skills/agent-evals/run-evals.mjs")]);
  const plan = planRepairs(base, head);
  assert.equal(plan.total_regressions, 1);
  assert.equal(plan.repairable_count, 1);
});

test("no regressions -> empty plan and a clean markdown block", () => {
  const base = card([row("t", "cto", 0.9, true, "f")]);
  const head = card([row("t", "cto", 0.95, true, "f")]);
  const plan = planRepairs(base, head);
  assert.equal(plan.total_regressions, 0);
  assert.equal(plan.repairs.length, 0);
  assert.equal(plan.primary, null);
  const md = renderMarkdown(plan, {});
  assert.match(md, /No regressions to repair/);
  assert.match(md, /never auto-merges/i);
});

test("markdown includes the concrete revert command with the base sha", () => {
  const base = card([row("t1", "cto", 1.0, true, "skills/agent-evals/run-evals.mjs")]);
  const head = card([row("t1", "cto", 0.5, false, "skills/agent-evals/run-evals.mjs")]);
  const md = renderMarkdown(planRepairs(base, head), { baseSha: "abc1234" });
  assert.match(md, /git checkout abc1234 -- skills\/agent-evals\/run-evals\.mjs/);
  assert.match(md, /run-evals\.mjs --json/);
});

test("null scorecards degrade gracefully (no crash, no regressions)", () => {
  const plan = planRepairs(null, null);
  assert.equal(plan.total_regressions, 0);
  assert.equal(plan.primary, null);
});
