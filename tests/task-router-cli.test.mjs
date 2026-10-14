import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const cli = resolve(fileURLToPath(new URL("../skills/fleet-telemetry/task-router.mjs", import.meta.url)));
const dir = mkdtempSync(join(tmpdir(), "task-router-cli-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const inputPath = join(dir, "input.json");
const now = Date.now();
const intake = {
  parentTaskId: "parent-7", classification: "company", objective: "Review bounded change", outcome: "One parent receipt",
  scope: "bounded", domains: ["engineering"], evidencePointers: ["artifact://spec"], intendedSource: "repo://source",
  intendedOwner: "CTO", intendedSurface: "fleet://company/app", operation: "review", availableRoles: ["developer"], nowMs: now,
  observedCapabilities: [{ callerAgentId: "cto", agentId: "developer", role: "developer", surface: "fleet://company/app", operation: "review", observedAt: new Date(now).toISOString() }],
};
function invoke(value, args = ["--intake", inputPath]) {
  writeFileSync(inputPath, typeof value === "string" ? value : JSON.stringify(value));
  return spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
}

test("CLI emits one source-only receipt for the existing intake function", () => {
  try {
    const result = invoke({ ...intake, childReceipts: [{ parentTaskId: "parent-7", domain: "engineering", status: "complete", outcome: "private child detail" }] });
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.parentTaskId, "parent-7");
    assert.equal(receipt.status, "ready_for_handoff");
    assert.equal(receipt.parentOutcome, "complete");
    assert.deepEqual(receipt.childReceipts, [{ parentTaskId: "parent-7", domain: "engineering", status: "complete" }]);
    assert.equal(JSON.stringify(receipt).includes("private child detail"), false);
    assert.equal(JSON.stringify(receipt).includes("repo://source"), false);
  } finally { /* shared temp directory is removed by the suite hook */ }
});

test("CLI rejects malformed input and unsafe argument shapes without leaking parser details", () => {
  const malformed = invoke("{");
  assert.notEqual(malformed.status, 0);
  assert.equal(malformed.stderr.trim(), "Invalid intake input.");
  const args = invoke(intake, []);
  assert.notEqual(args.status, 0);
  assert.equal(args.stderr.trim(), "Usage: node task-router.mjs --intake <input.json>");
});

test("CLI keeps parent correlation, bounded receipt output, and personal-first redaction", () => {
  const wrong = invoke({ ...intake, childReceipts: [
    { parentTaskId: "other-parent", domain: "engineering", status: "complete", outcome: "do not disclose" },
  ] });
  const wrongReceipt = JSON.parse(wrong.stdout);
  assert.equal(wrongReceipt.parentOutcome, "unknown");
  assert.deepEqual(wrongReceipt.childReceipts, [{ parentTaskId: "other-parent", domain: "engineering", status: "unknown" }]);
  assert.equal(wrong.stdout.includes("do not disclose"), false);

  const personal = invoke({ ...intake, classification: "personal", intendedSource: "secret://private", evidencePointers: ["private://pointer"] });
  const personalReceipt = JSON.parse(personal.stdout);
  assert.equal(personalReceipt.status, "direct-owner");
  assert.equal(personalReceipt.parentTaskId, "parent-7");
  assert.equal(personal.stdout.includes("secret://"), false);
  assert.equal(personal.stdout.includes("private://"), false);
});

test("CLI rejects inputs above its fixed byte bound", () => {
  const oversized = invoke({ ...intake, objective: "x".repeat(66000) });
  assert.notEqual(oversized.status, 0);
  assert.equal(oversized.stderr.trim(), "Invalid intake input.");
});

test("CLI main detection works when the script path contains spaces", () => {
  const spacedDir = join(dir, "space path");
  mkdirSync(spacedDir);
  const spacedCli = join(spacedDir, "task-router.mjs");
  copyFileSync(cli, spacedCli);
  const result = spawnSync(process.execPath, [spacedCli, "--intake", join(spacedDir, "missing.json")], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.equal(result.stderr.trim(), "Invalid intake input.");
  assert.equal(result.stdout, "");
});
