// Regression tests for the shared agent-identity resolver (skills/kb-memory/agent-id.sh), the
// self-healing auto-claim. Guards the SAFETY invariant: unambiguous single-agent repos auto-claim,
// but an ambiguous or PHI repo NEVER auto-claims (it would mis-home a shared environment), and an
// explicit marker / KB_AGENT always wins.
import { test } from "node:test";
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SH = join(dirname(fileURLToPath(import.meta.url)), "..", "skills", "kb-memory", "agent-id.sh");

function resolve(projectDir, env = {}, marker) {
  const home = mkdtempSync(join(tmpdir(), "agid-"));
  if (marker) { mkdirSync(join(home, ".claude"), { recursive: true }); writeFileSync(join(home, ".claude", ".kb-agent"), marker + "\n"); }
  const out = execFileSync("bash", ["-c", `. "${SH}"; echo "AG=$AG|AC=$AUTOCLAIMED"`],
    { env: { PATH: process.env.PATH, HOME: home, CLAUDE_PROJECT_DIR: projectDir, ...env }, encoding: "utf8" });
  const m = out.match(/AG=([^|]*)\|AC=(\d)/);
  return { ag: m[1], autoclaimed: m[2] === "1" };
}

test("an app repo auto-claims the developer", () => {
  const r = resolve("/x/fourvault");
  assert.equal(r.ag, "developer"); assert.equal(r.autoclaimed, true);
});
test("the cto/toolkit repos auto-claim cto", () => {
  assert.equal(resolve("/x/otchealth-cto").ag, "cto");
  assert.equal(resolve("/x/otchealth-claude-tools").ag, "cto");
});
test("an AMBIGUOUS repo stays OFF (never mis-homes)", () => {
  const r = resolve("/x/some-unknown-repo");
  assert.equal(r.ag, ""); assert.equal(r.autoclaimed, false);
});
test("a PHI repo (medreview) NEVER auto-claims", () => {
  assert.equal(resolve("/x/medreview").ag, "");
});
test("an explicit session marker beats the repo auto-claim", () => {
  assert.equal(resolve("/x/fourvault", {}, "cfo").ag, "cfo");
});
test("KB_AGENT env beats the repo auto-claim", () => {
  assert.equal(resolve("/x/fourvault", { KB_AGENT: "growth" }).ag, "growth");
});
test("KB_NO_AUTOCLAIM=1 disables the auto-claim", () => {
  assert.equal(resolve("/x/fourvault", { KB_NO_AUTOCLAIM: "1" }).ag, "");
});
