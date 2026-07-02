// Tests for fleet-telemetry/task-router.mjs, the pure quality-gated task -> model/budget classifier.
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyTask, estimateSavings } from "../skills/fleet-telemetry/task-router.mjs";

test("mechanical + short task routes to haiku", () => {
  const r = classifyTask("list the files in the skills directory");
  assert.equal(r.model, "haiku");
});

test("mechanical + high fanout routes to haiku even when not short", () => {
  const long = "extract the title field from this record. " + "x".repeat(800);
  const r = classifyTask(long, { fanout: 8 });
  assert.equal(r.model, "haiku");
});

test("judgment/high-stakes signal is NEVER downgraded below sonnet", () => {
  for (const s of [
    "analyze the tradeoffs and synthesize a recommendation",
    "review this for security vulnerabilities",
    "de-identify the PHI extract",
    "verify the migration schema",
  ]) {
    const r = classifyTask(s);
    assert.ok(r.model === "sonnet" || r.model === "opus", `should hold Sonnet+: ${s} -> ${r.model}`);
  }
});

test("deep-reasoning signal escalates to opus", () => {
  const r = classifyTask("reverse-engineer the competitor architecture and prove the bound");
  assert.equal(r.model, "opus");
});

test("quality signal beats a mechanical keyword in the same task", () => {
  const r = classifyTask("list the risks then analyze the security tradeoffs");
  assert.notEqual(r.model, "haiku");
});

test("unknown/ambiguous task defaults to sonnet (no penny-wise downgrade)", () => {
  assert.equal(classifyTask("do the thing we discussed").model, "sonnet");
});

test("forceModel overrides classification", () => {
  assert.equal(classifyTask("list files", { forceModel: "opus" }).model, "opus");
});

test("estimateSavings is positive routing sonnet -> haiku and ~0 same-model", () => {
  const s = estimateSavings("sonnet", "haiku", 100000, 20000);
  assert.ok(s.savedUsd > 0 && s.savedPct > 0);
  const same = estimateSavings("sonnet", "sonnet", 100000, 20000);
  assert.equal(same.savedUsd, 0);
});
