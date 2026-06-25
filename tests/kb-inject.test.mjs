// Regression tests for skills/kb-memory/kb-inject.sh — guards working-memory agent resolution.
// The CFO ran with memory off (KB_AGENT unset), and the CTO ran MIS-homed (a single shared KB_AGENT
// env var labelled it `cfo` while the CTO session needed `cto`). Fix: resolve the agent per SESSION,
// most-specific signal wins -- ~/.claude/.kb-agent (session marker) > $CLAUDE_PROJECT_DIR/.kb-agent
// (repo default) > $KB_AGENT (shared-env fallback) > nothing => LOUD warning. These lock that in.
import { test } from "node:test";
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOOK = join(ROOT, "skills/kb-memory/kb-inject.sh");

// Hermetic: fresh HOME each run (so no stray ~/.claude/.kb-agent leaks in), CLAUDE_PROJECT_DIR=ROOT so
// the real mem.mjs is found (the repo root has no .kb-agent, so it does not interfere).
function runHook(mode, { env = {}, sessionAgent, projectDir = ROOT } = {}) {
  const HOME = mkdtempSync(join(tmpdir(), "kbhome-"));
  if (sessionAgent !== undefined) {
    mkdirSync(join(HOME, ".claude"), { recursive: true });
    writeFileSync(join(HOME, ".claude", ".kb-agent"), sessionAgent + "\n");
  }
  return execFileSync("bash", [HOOK, mode], {
    // Hermetic: null the agent signals AND the GCP SA, so the hook's ledger preview cannot reach the
    // real backend. In a LIVE agent sandbox the SA is in process.env, so mem.mjs would load the real
    // ledger whose text can contain assertion phrases (e.g. a pitfall quoting "WORKING MEMORY IS OFF"),
    // making this test fail only in sandboxes (green on CI). These tests check the hook's agent
    // RESOLUTION, not the ledger contents, so the backend must be cut off regardless of host env.
    env: { ...process.env, HOME, CLAUDE_PROJECT_DIR: projectDir, KB_AGENT: "", KB_MEMORY_OPTOUT: "", GCP_CLAUDE_DRIVER_SA_JSON: "", GCP_CLAUDE_DRIVER_SA_JSON_B64: "", GOOGLE_APPLICATION_CREDENTIALS: "", ...env },
    encoding: "utf8",
  });
}

test("no agent resolvable (no marker/repo/KB_AGENT, auto-claim off) warns LOUDLY", () => {
  // KB_NO_AUTOCLAIM=1 so the repo-name auto-claim (which maps the claude-tools test dir -> 'cto') does
  // not fire; this exercises the genuine no-identity loud-OFF path. The ambiguous-repo case (where
  // auto-claim correctly DECLINES to guess) is covered in tests/agent-id.test.mjs.
  const out = runHook("session", { env: { KB_NO_AUTOCLAIM: "1" } });
  assert.match(out, /WORKING MEMORY IS OFF/, "must announce memory is off");
  assert.match(out, /No agent resolved/i, "must say no agent resolved");
  assert.match(out, /\.kb-agent/, "must point at the per-session .kb-agent fix");
});

test("KB_MEMORY_OPTOUT silences the warning", () => {
  const out = runHook("session", { env: { KB_MEMORY_OPTOUT: "1" } });
  assert.doesNotMatch(out, /WORKING MEMORY IS OFF/, "opt-out must suppress the notice");
});

test("shared-env KB_AGENT is the fallback when there is no marker", () => {
  const out = runHook("session", { env: { KB_AGENT: "cto" } });
  assert.match(out, /WORKING MEMORY: cto ledger/, "uses the env var when nothing more specific");
  assert.match(out, /via env KB_AGENT/, "labels the source as the env fallback");
  assert.doesNotMatch(out, /WORKING MEMORY IS OFF/);
});

test("a session marker WINS over the shared env var (the shared-environment fix)", () => {
  // The exact bug: shared env said cfo/cto for everyone; the per-session marker must override it.
  const out = runHook("session", { sessionAgent: "clo", env: { KB_AGENT: "cto" } });
  assert.match(out, /WORKING MEMORY: clo ledger/, "the marker agent (clo) wins, not the env (cto)");
  assert.match(out, /via session marker/, "labels the source as the session marker");
  assert.match(out, /KB_AGENT='cto'/, "surfaces the contradiction with the shared env var");
  assert.match(out, /marker wins/, "explains the marker overrides the shared env");
});

test("a repo .kb-agent default resolves the agent when env is unset", () => {
  const repo = mkdtempSync(join(tmpdir(), "kbrepo-"));
  mkdirSync(join(repo, "skills", "kb-memory"), { recursive: true });
  writeFileSync(join(repo, "skills", "kb-memory", "mem.mjs"), "// stub for existence check\n");
  writeFileSync(join(repo, ".kb-agent"), "aware\n");
  const out = runHook("session", { projectDir: repo });
  assert.match(out, /WORKING MEMORY: aware ledger/, "one app repo = one agent, resolved from .kb-agent");
  assert.match(out, /via repo \.kb-agent/, "labels the source as the repo default");
});

test("the hook always exits 0 (fail-safe: never blocks a session)", () => {
  runHook("session");
  runHook("precompact");
  runHook("stop");
});
