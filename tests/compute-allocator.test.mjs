// Regression gate for compute-allocator's pure decision core (skills/compute-allocator/allocate.mjs).
// Mirrors tests/effort-scaling.test.mjs's style and tests/signal-radar.test.mjs's "exercise the pure
// function directly, no network" discipline. allocateCompute() is 100% synchronous and pure, so every
// case here runs instantly and hermetically; recentSignalsFor()'s fail-open contract is also covered.
import { test } from "node:test";
import assert from "node:assert/strict";
import { allocateCompute, recentSignalsFor, inferModel } from "../skills/compute-allocator/allocate.mjs";
import { recommendFanout } from "../skills/fleet-dispatch/effort-scale.mjs";

test("no signals + ordinary (non high-stakes) task text matches the base recommendFanout agent count", () => {
  const taskText = "Compare Postgres vs DynamoDB for the ledger store, tradeoffs across cost and latency.";
  const base = recommendFanout(taskText);
  const r = allocateCompute({ taskText, recentSignals: [] });
  assert.equal(r.agents, base.agents);
  assert.equal(r.useCritic, false);
  assert.ok(r.rationale.length > 0);
  assert.ok(typeof r.model === "string" && r.model.length > 0);
});

test("no signals + a plain lookup also matches the base agent count and stays useCritic=false", () => {
  const taskText = "What is the current version of Node in this repo?";
  const base = recommendFanout(taskText);
  const r = allocateCompute({ taskText, recentSignals: [] });
  assert.equal(r.agents, base.agents);
  assert.equal(r.agents, 1);
  assert.equal(r.useCritic, false);
});

test("a HIGH severity relevant signal escalates agents above base and forces useCritic true", () => {
  const taskText = "What is the current version of Node in this repo?";
  const base = recommendFanout(taskText);
  const r = allocateCompute({
    taskText,
    recentSignals: [{ severity: "high", subject: "node-version-service", detector: "sentry-error-spike" }],
  });
  assert.ok(r.agents > base.agents, `expected escalation above base ${base.agents}, got ${r.agents}`);
  assert.equal(r.useCritic, true);
});

test("a HIGH severity signal on a task already at cap stays clamped at 4", () => {
  const taskText = "Red-team, reverse-engineer, investigate, compare, and break it then fix everything across every disjoint file in the whole broad research audit.";
  const r = allocateCompute({
    taskText,
    recentSignals: [{ severity: "high", subject: "x", detector: "d" }],
  });
  assert.equal(r.agents, 4);
  assert.equal(r.useCritic, true);
});

test("a MEDIUM severity signal forces useCritic true but leaves agents at the base level", () => {
  const taskText = "Compare Postgres vs DynamoDB for the ledger store, tradeoffs across cost and latency.";
  const base = recommendFanout(taskText);
  const r = allocateCompute({
    taskText,
    recentSignals: [{ severity: "medium", subject: "ledger-service", detector: "eval-regression" }],
  });
  assert.equal(r.agents, base.agents);
  assert.equal(r.useCritic, true);
});

test("agents is always clamped to a max of 4 even with multiple HIGH signals stacked", () => {
  const taskText = "Build the new onboarding flow: split the work across disjoint files, one builder per screen.";
  const r = allocateCompute({
    taskText,
    recentSignals: [
      { severity: "high", subject: "a", detector: "d1" },
      { severity: "high", subject: "b", detector: "d2" },
      { severity: "high", subject: "c", detector: "d3" },
    ],
  });
  assert.ok(r.agents <= 4, `expected <=4, got ${r.agents}`);
  assert.equal(r.agents, 4);
});

test("no relevant signals but high-stakes task text (e.g. production/delete/migration) still forces useCritic true", () => {
  const r = allocateCompute({
    taskText: "Write the migration script that deletes stale rows from the production billing table.",
    recentSignals: [],
  });
  assert.equal(r.useCritic, true);
});

test("no relevant signals and ordinary task text leaves useCritic false", () => {
  const r = allocateCompute({
    taskText: "Summarize this week's changelog for the team.",
    recentSignals: [],
  });
  assert.equal(r.useCritic, false);
});

test("allocateCompute never throws on malformed recentSignals (null) and falls back to safe defaults", () => {
  assert.doesNotThrow(() => {
    const r = allocateCompute({ taskText: "What is the current version?", recentSignals: null });
    assert.ok(Number.isInteger(r.agents));
    assert.ok(r.agents >= 1 && r.agents <= 4);
    assert.equal(typeof r.useCritic, "boolean");
  });
});

test("allocateCompute never throws on malformed recentSignals (non-array, entries missing fields)", () => {
  assert.doesNotThrow(() => {
    const r1 = allocateCompute({ taskText: "compare a vs b", recentSignals: "not-an-array" });
    assert.ok(r1.agents >= 1 && r1.agents <= 4);

    const r2 = allocateCompute({
      taskText: "compare a vs b",
      recentSignals: [{}, { severity: "not-a-real-severity" }, null, undefined, { subject: "x" }],
    });
    assert.ok(r2.agents >= 1 && r2.agents <= 4);
    assert.equal(typeof r2.useCritic, "boolean");
  });
});

test("allocateCompute never throws when called with no arguments at all", () => {
  assert.doesNotThrow(() => {
    const r = allocateCompute();
    assert.ok(Number.isInteger(r.agents));
    assert.ok(r.agents >= 1 && r.agents <= 4);
  });
});

test("agents is always an integer in [1,4] and model/rationale/useCritic are always present", () => {
  const cases = [
    { taskText: "what is x", recentSignals: [] },
    { taskText: "red-team this and break it", recentSignals: [{ severity: "high", subject: "x", detector: "y" }] },
    { taskText: "", recentSignals: [{ severity: "medium", subject: "x", detector: "y" }] },
    { taskText: "random unrelated text with no signals at all", recentSignals: undefined },
  ];
  for (const c of cases) {
    const r = allocateCompute(c);
    assert.ok(Number.isInteger(r.agents), `agents must be an integer for ${JSON.stringify(c)}`);
    assert.ok(r.agents >= 1 && r.agents <= 4, `agents out of range for ${JSON.stringify(c)}: ${r.agents}`);
    assert.equal(typeof r.model, "string");
    assert.equal(typeof r.useCritic, "boolean");
    assert.ok(typeof r.rationale === "string" && r.rationale.length > 0);
  }
});

test("inferModel routes deep-reasoning/architecture/security-shaped text to opus, else sonnet", () => {
  assert.equal(inferModel("design the new architecture for the payments service"), "opus");
  assert.equal(inferModel("reverse-engineer this legacy module"), "opus");
  assert.equal(inferModel("list the files in this directory"), "sonnet");
  assert.equal(inferModel(""), "sonnet");
});

// ------------------------------------------------------- recentSignalsFor: fail-open contract -------
test("recentSignalsFor returns [] (never throws) when the Cosmos/GCP store is unreachable or unconfigured", async () => {
  // In this test environment there is no live GCP_CLAUDE_DRIVER_SA_JSON / Cosmos config reachable from
  // a hermetic `node --test` run, so this exercises the real fail-open path end to end: missing creds
  // or a network failure inside recentSignalsFor must resolve to [], never reject/throw.
  await assert.doesNotReject(async () => {
    const result = await recentSignalsFor("some-lane-that-does-not-exist");
    assert.ok(Array.isArray(result));
    assert.equal(result.length, 0);
  });
});

test("recentSignalsFor returns [] for an empty/undefined subjectOrLane argument", async () => {
  await assert.doesNotReject(async () => {
    const result = await recentSignalsFor();
    assert.ok(Array.isArray(result));
  });
});
