// Tests for fleet-telemetry/task-router.mjs, the pure quality-gated task -> model/budget classifier.
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyTask, classifyTaskWithHistory, estimateSavings, intakeCompanyTask } from "../skills/fleet-telemetry/task-router.mjs";

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

// classifyTaskWithHistory: strict superset of classifyTask that escalates on a caller-supplied
// prior-failure signal (agent-evals pass-rate for this callsite, or a bare "last run failed" flag).
// No I/O, no PostHog query — the caller supplies history as plain data, same discipline as
// compute-allocator's recentSignals injection.

test("no history supplied is IDENTICAL to classifyTask (no behavior change by default)", () => {
  for (const t of ["list the files", "analyze the tradeoffs", "reverse-engineer the architecture", "do the thing"]) {
    assert.deepEqual(classifyTaskWithHistory(t, {}), classifyTask(t, {}));
  }
});

test("high prior failure rate escalates one tier (haiku -> sonnet)", () => {
  const r = classifyTaskWithHistory("list the files in the skills directory", { priorFailureRate: 0.6 });
  assert.equal(r.model, "sonnet");
  assert.match(r.reason, /escalated haiku -> sonnet/);
});

test("low prior failure rate does NOT escalate", () => {
  const r = classifyTaskWithHistory("list the files in the skills directory", { priorFailureRate: 0.1 });
  assert.equal(r.model, "haiku");
});

test("lastRunFailed alone escalates even with no/low priorFailureRate", () => {
  const r = classifyTaskWithHistory("extract the title field", { lastRunFailed: true });
  assert.equal(r.model, "sonnet");
});

test("escalation never exceeds opus (ceiling, not unbounded)", () => {
  const r = classifyTaskWithHistory("reverse-engineer the competitor architecture and prove the bound", {
    priorFailureRate: 0.99,
    lastRunFailed: true,
  });
  assert.equal(r.model, "opus");
});

test("escalation never downgrades below what classifyTask already picked", () => {
  const r = classifyTaskWithHistory("analyze the tradeoffs and synthesize a recommendation", { priorFailureRate: 0.9 });
  assert.ok(r.model === "sonnet" || r.model === "opus");
});

test("forceModel overrides history-based escalation too", () => {
  const r = classifyTaskWithHistory("list files", { forceModel: "haiku", priorFailureRate: 0.99, lastRunFailed: true });
  assert.equal(r.model, "haiku");
});

test("custom failRateThreshold is honored", () => {
  const belowCustom = classifyTaskWithHistory("list the files", { priorFailureRate: 0.25, failRateThreshold: 0.2 });
  assert.equal(belowCustom.model, "sonnet"); // 0.25 >= 0.2 -> escalates
  const stillHaiku = classifyTaskWithHistory("list the files", { priorFailureRate: 0.25, failRateThreshold: 0.5 });
  assert.equal(stillHaiku.model, "haiku"); // 0.25 < 0.5 -> no escalation
});

const intakeNow = Date.now();
const observedCapabilities = [
  ["engineering", "developer"], ["finance", "cfo"], ["operations", "coo"],
].map(([domain, agentId]) => ({
  callerAgentId: "cto", agentId, role: agentId,
  surface: "fleet://company/app", operation: "review", observedAt: new Date(intakeNow).toISOString(),
}));
const companyIntake = {
  parentTaskId: "task-42", classification: "company", objective: "Ship the cross-domain change",
  outcome: "One accepted parent receipt", scope: "bounded",
  domains: ["engineering", "finance", "operations"],
  evidencePointers: ["artifact://spec/42"], intendedSource: "repo://company/app",
  intendedOwner: "CTO", intendedSurface: "fleet://company/app", operation: "review",
  availableRoles: ["developer", "cfo", "coo"], observedCapabilities, nowMs: intakeNow,
};

test("company intake creates three domain packets under the same parent ID", () => {
  const r = intakeCompanyTask(companyIntake);
  assert.equal(r.status, "ready_for_handoff");
  assert.deepEqual(r.packets.map((p) => [p.domain, p.owner, p.parentTaskId]), [
    ["engineering", "Developer", "task-42"], ["finance", "CFO", "task-42"], ["operations", "COO", "task-42"],
  ]);
  assert.ok(r.packets.every((p) => p.status === "ready_for_handoff" && p.capabilityEvidence));
  assert.deepEqual(intakeCompanyTask(companyIntake), r); // deterministic; no IDs or dispatch side effects
});

test("personal intake returns direct-owner disposition without source or evidence reads", () => {
  const r = intakeCompanyTask({ ...companyIntake, classification: "personal", intendedSource: "secret://not-read" });
  assert.equal(r.status, "direct-owner");
  assert.equal(r.sourceRead, false);
  assert.deepEqual(r.evidencePointers, []);
  assert.equal("intendedSource" in r, false);
});

test("missing role capability evidence blocks only its packet, and partial child receipts stay partial", () => {
  const r = intakeCompanyTask({ ...companyIntake, availableRoles: ["developer", "cfo"], observedCapabilities: [],
    childReceipts: [{ parentTaskId: "task-42", domain: "engineering", status: "complete", outcome: "built" }] });
  assert.equal(r.status, "blocked");
  assert.equal(r.packets[2].status, "blocked");
  assert.equal(r.parentOutcome, "partial");
  assert.deepEqual(r.childReceipts[0], { parentTaskId: "task-42", domain: "engineering", status: "complete", outcome: "built" });
});

test("stale, future, wrong-seat, wrong-surface, and unrelated-operation evidence cannot authorize handoff", () => {
  const corruptions = [
    (cap) => ({ ...cap, observedAt: new Date(intakeNow - 301_000).toISOString() }),
    (cap) => ({ ...cap, observedAt: new Date(intakeNow + 1_000).toISOString() }),
    (cap) => ({ ...cap, agentId: "cro", role: "cro" }),
    (cap) => ({ ...cap, callerAgentId: "cro" }),
    (cap) => ({ ...cap, surface: "fleet://unrelated" }),
    (cap) => ({ ...cap, operation: "delete" }),
    () => ({ callable: true, metadata: {} }),
    (cap) => ({ ...cap, agentId: "wefunder", role: "wefunder" }),
  ];
  for (const corrupt of corruptions) {
    const capabilities = [...observedCapabilities];
    capabilities[0] = corrupt(capabilities[0]);
    const r = intakeCompanyTask({ ...companyIntake, observedCapabilities: capabilities });
    assert.equal(r.packets[0].status, "blocked");
    assert.equal(r.packets[0].parentTaskId, "task-42");
    assert.deepEqual(r.packets[0].evidencePointers, ["artifact://spec/42"]);
  }
});

test("invalid company scope blocks every child packet even with fresh matching evidence", () => {
  const r = intakeCompanyTask({ ...companyIntake, scope: "unbounded" });
  assert.equal(r.status, "blocked");
  assert.ok(r.packets.every((p) => p.status === "blocked"));
});
