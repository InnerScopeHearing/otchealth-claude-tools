// Regression tests for skills/kb-memory/kb-inject.sh — guards the "working memory must never be
// silently off" fix. The CFO ran for a long time with KB_AGENT unset and lost facts because the
// SessionStart hook used to `exit 0` silently. These tests lock in: unset => LOUD warning; opt-out
// => silent; set => normal ledger injection.
import { test } from "node:test";
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOOK = join(ROOT, "skills/kb-memory/kb-inject.sh");

// Run the hook with a controlled env. CLAUDE_PROJECT_DIR=ROOT makes it resolve the real mem.mjs so the
// session branch actually executes (the hook no-ops if it cannot find mem.mjs).
function runHook(mode, extraEnv = {}) {
  return execFileSync("bash", [HOOK, mode], {
    env: { ...process.env, CLAUDE_PROJECT_DIR: ROOT, KB_AGENT: "", KB_MEMORY_OPTOUT: "", ...extraEnv },
    encoding: "utf8",
  });
}

test("session start with KB_AGENT unset warns LOUDLY (no silent disable)", () => {
  const out = runHook("session");
  assert.match(out, /WORKING MEMORY IS OFF/, "must announce that memory is off");
  assert.match(out, /KB_AGENT is not set/, "must name the missing variable");
  assert.match(out, /set KB_AGENT/, "must tell the operator how to fix it");
});

test("KB_MEMORY_OPTOUT silences the warning (explicit escape hatch)", () => {
  const out = runHook("session", { KB_MEMORY_OPTOUT: "1" });
  assert.doesNotMatch(out, /WORKING MEMORY IS OFF/, "opt-out must suppress the notice");
});

test("session start with KB_AGENT set injects that agent's ledger header (no warning)", () => {
  const out = runHook("session", { KB_AGENT: "cto" });
  assert.match(out, /WORKING MEMORY: cto ledger/, "must inject the named agent's ledger");
  assert.doesNotMatch(out, /WORKING MEMORY IS OFF/, "must not warn when memory is on");
});

test("the hook always exits 0 (fail-safe: never blocks a session)", () => {
  // execFileSync throws on non-zero exit; these calls completing is the assertion.
  runHook("session");
  runHook("precompact");
  runHook("stop");
});
