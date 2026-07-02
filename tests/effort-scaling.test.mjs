// Regression gate for the orchestrator effort-scaling standard (app-kit/ORCHESTRATION-STANDARD.md) and its
// pure helper (skills/fleet-dispatch/effort-scale.mjs). Pure function, no I/O, no network: every case here
// should run instantly and hermetically.
import { test } from "node:test";
import assert from "node:assert";
import { recommendFanout } from "../skills/fleet-dispatch/effort-scale.mjs";

test("a single-fact lookup recommends exactly 1 agent", () => {
  const r = recommendFanout("What is the current version of Node in this repo?");
  assert.strictEqual(r.agents, 1);
  assert.strictEqual(r.mode, "single");
  assert.ok(r.rationale.length > 0);
});

test("a quick lookup phrased as a question still recommends 1", () => {
  const r = recommendFanout("Who is the owner of the fleet-dispatch skill?");
  assert.strictEqual(r.agents, 1);
});

test("a comparison task recommends 2-3 agents", () => {
  const r = recommendFanout("Compare Postgres vs DynamoDB for the ledger store, tradeoffs across cost and latency.");
  assert.ok(r.agents >= 2 && r.agents <= 3, `expected 2-3, got ${r.agents}`);
  assert.strictEqual(r.mode, "compare");
});

test("a plain vs comparison recommends at least 2", () => {
  const r = recommendFanout("React vs Vue for the new dashboard");
  assert.ok(r.agents >= 2, `expected >=2, got ${r.agents}`);
});

test("multi-facet research (reverse-engineer) recommends >= 3", () => {
  const r = recommendFanout("Reverse-engineer this legacy billing module and investigate the issue across all its call sites.");
  assert.ok(r.agents >= 3, `expected >=3, got ${r.agents}`);
  assert.strictEqual(r.mode, "research");
});

test("red-team (break it then fix) recommends >= 3", () => {
  const r = recommendFanout("Red-team the new auth flow: break it, then fix whatever you find.");
  assert.ok(r.agents >= 3, `expected >=3, got ${r.agents}`);
  assert.strictEqual(r.mode, "redteam");
});

test("broad investigate task recommends >= 3", () => {
  const r = recommendFanout("Investigate the issue causing intermittent 500s across the whole checkout flow, broad research needed.");
  assert.ok(r.agents >= 3, `expected >=3, got ${r.agents}`);
});

test("a build touching disjoint files recommends up to 4 builders", () => {
  const r = recommendFanout("Build the new onboarding flow: split the work across disjoint files, one builder per screen.");
  assert.ok(r.agents >= 3 && r.agents <= 4, `expected 3-4, got ${r.agents}`);
  assert.strictEqual(r.mode, "build");
});

test("recommendation never exceeds the cap of 4 regardless of signal strength", () => {
  const r = recommendFanout(
    "Red-team, reverse-engineer, investigate, compare, and break it then fix everything across every disjoint file in the whole broad research audit."
  );
  assert.ok(r.agents <= 4, `expected <=4, got ${r.agents}`);
});

test("hints.maxAgents caps below the text-derived recommendation", () => {
  const r = recommendFanout("Red-team the new auth flow: break it, then fix whatever you find.", { maxAgents: 1 });
  assert.strictEqual(r.agents, 1);
});

test("hints.maxAgents cannot push agents above the hard cap of 4", () => {
  const r = recommendFanout("What is the version?", { maxAgents: 10 });
  assert.ok(r.agents <= 4, `expected <=4, got ${r.agents}`);
});

test("hints.minAgents floors a lookup recommendation upward", () => {
  const r = recommendFanout("What is the version?", { minAgents: 2 });
  assert.strictEqual(r.agents, 2);
});

test("agents is always an integer in [1,4] and mode/rationale are always present", () => {
  const cases = [
    "what is x",
    "compare a vs b",
    "reverse-engineer this system",
    "red-team this and break it",
    "build a new feature across disjoint files",
    "",
    "random unrelated text with no signals at all",
  ];
  for (const c of cases) {
    const r = recommendFanout(c);
    assert.ok(Number.isInteger(r.agents), `agents must be an integer for "${c}"`);
    assert.ok(r.agents >= 1 && r.agents <= 4, `agents out of range for "${c}": ${r.agents}`);
    assert.ok(typeof r.mode === "string" && r.mode.length > 0);
    assert.ok(typeof r.rationale === "string" && r.rationale.length > 0);
  }
});
