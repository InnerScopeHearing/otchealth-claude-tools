// Tests for compute-allocator/allocate.mjs, the pure advisory compute router. These pin the DECISION
// logic (fan-out escalation, critic-pass gating) that fleet-dispatch now consults on task dispatches.
import { test } from "node:test";
import assert from "node:assert/strict";
import { allocateCompute, allocateComputeAsync, inferModel } from "../allocate.mjs";

test("quiet lane + plain lookup: baseline fan-out, no critic", () => {
  const r = allocateCompute({ taskText: "what is the current app version", recentSignals: [] });
  assert.equal(r.agents, 1);
  assert.equal(r.useCritic, false);
});

test("a HIGH-severity signal in the lane escalates fan-out AND forces critic-pass", () => {
  const base = allocateCompute({ taskText: "compare Postgres vs DynamoDB for the ledger", recentSignals: [] });
  const hot = allocateCompute({
    taskText: "compare Postgres vs DynamoDB for the ledger",
    recentSignals: [{ severity: "high", subject: "ledger", detector: "sentry-error-spike" }],
  });
  assert.ok(hot.agents > base.agents, `expected escalation above baseline ${base.agents}, got ${hot.agents}`);
  assert.equal(hot.useCritic, true);
  assert.ok(hot.agents <= 4, "must never exceed the hard cap of 4");
});

test("a MEDIUM-severity signal keeps baseline fan-out but turns on critic-pass", () => {
  const r = allocateCompute({
    taskText: "compare two options",
    recentSignals: [{ severity: "medium", subject: "x", detector: "eval-regression" }],
  });
  assert.equal(r.useCritic, true);
});

test("no signal but high-stakes task text (production/credentials) still forces critic-pass", () => {
  const r = allocateCompute({ taskText: "rotate the production credential and delete the old key", recentSignals: [] });
  assert.equal(r.useCritic, true);
});

test("malformed recentSignals never throws and degrades to baseline", () => {
  for (const bad of [null, undefined, "nope", 42, [{}], [{ severity: "banana" }]]) {
    const r = allocateCompute({ taskText: "look up one fact", recentSignals: bad });
    assert.equal(r.agents, 1);
    assert.equal(r.useCritic, false);
  }
});

test("inferModel routes deep-reasoning/design language to opus, else sonnet", () => {
  assert.equal(inferModel("architect the fleet's memory subsystem and prove correctness"), "opus");
  assert.equal(inferModel("rename a variable"), "sonnet");
});

test("allocateComputeAsync returns the full recommendation shape and floors model at sonnet", async () => {
  const r = await allocateComputeAsync({ taskText: "reindex the docs", recentSignals: [] });
  assert.ok(Number.isInteger(r.agents) && r.agents >= 1 && r.agents <= 4);
  assert.ok(r.model === "opus" || r.model === "sonnet", `model floored to sonnet/opus, got ${r.model}`);
  assert.equal(typeof r.useCritic, "boolean");
  assert.equal(typeof r.rationale, "string");
});
