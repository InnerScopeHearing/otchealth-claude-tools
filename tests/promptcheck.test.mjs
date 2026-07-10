// Unit tests for the prompt-regression scorecard diff (skills/agent-evals/promptcheck.mjs). Pure
// function, no network/Azure calls: proves the base-vs-head comparison logic (regression / improvement
// / new / removed classification) in isolation, matching the pattern of tests/brain-rooms.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { diffScorecards } from "../skills/agent-evals/promptcheck.mjs";

function scorecard(results) {
  return { model: "gpt-5.1", passAt: 0.7, avg: results.reduce((s, r) => s + r.score, 0) / (results.length || 1), passed: results.filter((r) => r.pass).length, total: results.length, results };
}

test("a task that flips PASS->FAIL is flagged as a regression", () => {
  const base = scorecard([{ id: "cto-phi-wall", agent: "cto", callsite_id: "persona.cto", score: 1, pass: true }]);
  const head = scorecard([{ id: "cto-phi-wall", agent: "cto", callsite_id: "persona.cto", score: 0.33, pass: false }]);
  const diff = diffScorecards(base, head);
  assert.equal(diff.regressions.length, 1);
  assert.equal(diff.regressions[0].id, "cto-phi-wall");
  assert.equal(diff.improvements.length, 0);
});

test("a big score drop (>=15pts) that STILL passes is flagged as a regression", () => {
  const base = scorecard([{ id: "brain-cite-and-abstain", agent: "company-brain", callsite_id: "brain.synthesize", score: 1, pass: true }]);
  const head = scorecard([{ id: "brain-cite-and-abstain", agent: "company-brain", callsite_id: "brain.synthesize", score: 0.8, pass: true }]);
  const diff = diffScorecards(base, head);
  assert.equal(diff.regressions.length, 1);
});

test("a small score wobble (<15pts) that still passes is NOT a regression", () => {
  const base = scorecard([{ id: "cfo-entity-scoping", agent: "cfo", callsite_id: "persona.cfo", score: 1, pass: true }]);
  const head = scorecard([{ id: "cfo-entity-scoping", agent: "cfo", callsite_id: "persona.cfo", score: 0.9, pass: true }]);
  const diff = diffScorecards(base, head);
  assert.equal(diff.regressions.length, 0);
});

test("an improvement is flagged when the score rises >=15pts", () => {
  const base = scorecard([{ id: "clo-privilege-wall", agent: "clo", callsite_id: "persona.clo", score: 0.33, pass: false }]);
  const head = scorecard([{ id: "clo-privilege-wall", agent: "clo", callsite_id: "persona.clo", score: 1, pass: true }]);
  const diff = diffScorecards(base, head);
  assert.equal(diff.improvements.length, 1);
  assert.equal(diff.regressions.length, 0);
});

test("a task new on head (absent from base) is classified 'new', not a regression", () => {
  const base = scorecard([]);
  const head = scorecard([{ id: "fgl-professional-teaches-exact-fix", agent: "fgl", callsite_id: "fgl.review_persona.professionals", score: 1, pass: true }]);
  const diff = diffScorecards(base, head);
  const row = diff.rows.find((r) => r.id === "fgl-professional-teaches-exact-fix");
  assert.equal(row.status, "new");
  assert.equal(diff.regressions.length, 0);
});

test("a task removed on head (absent from head) is classified 'removed', not a regression", () => {
  const base = scorecard([{ id: "reflect-no-new-lesson", agent: "kb-reflect", callsite_id: "reflect.distill", score: 1, pass: true }]);
  const head = scorecard([]);
  const diff = diffScorecards(base, head);
  const row = diff.rows.find((r) => r.id === "reflect-no-new-lesson");
  assert.equal(row.status, "removed");
  assert.equal(diff.regressions.length, 0);
});

test("callsite_id defaults to agent when a result predates the tagging", () => {
  const base = scorecard([{ id: "old-task", agent: "cto", score: 1, pass: true }]);
  const head = scorecard([{ id: "old-task", agent: "cto", score: 1, pass: true }]);
  const diff = diffScorecards(base, head);
  assert.equal(diff.rows[0].callsite_id, "cto");
});
