// Tests for fleet-telemetry/telemetry.mjs resolveAgent(), the attribution fix behind the
// 2026-07-02 blackout post-mortem. Before the fix, the Stop-hook env usually lacked KB_AGENT, so
// every emitted session was attributed to "unknown" (verified: 38/38 pre-blackout events). The fix
// falls back to the durable on-disk session marker (~/.claude/.kb-agent) that mem.mjs writes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAgent } from "../skills/fleet-telemetry/telemetry.mjs";

// Save/restore the env keys resolveAgent reads, so tests never leak into each other or the runner.
function withEnv(overrides, fn) {
  const keys = ["KB_AGENT", "HOME", "CLAUDE_PROJECT_DIR"];
  const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  try {
    for (const k of keys) {
      if (overrides[k] === undefined) delete process.env[k];
      else process.env[k] = overrides[k];
    }
    return fn();
  } finally {
    for (const k of keys) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

test("resolveAgent: explicit KB_AGENT wins and is lowercased", () => {
  withEnv({ KB_AGENT: "CFO" }, () => assert.equal(resolveAgent(), "cfo"));
});

test("resolveAgent: falls back to ~/.claude/.kb-agent marker (THE blackout attribution fix)", () => {
  const home = mkdtempSync(join(tmpdir(), "tele-home-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude", ".kb-agent"), "developer\n"); // marker has a trailing newline
  try {
    withEnv({ KB_AGENT: undefined, HOME: home, CLAUDE_PROJECT_DIR: home }, () =>
      assert.equal(resolveAgent(), "developer", "must read the on-disk marker, not attribute 'unknown'"),
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("resolveAgent: no env and no marker -> 'unknown' (never throws)", () => {
  const home = mkdtempSync(join(tmpdir(), "tele-empty-")); // no .claude/.kb-agent inside
  try {
    withEnv({ KB_AGENT: undefined, HOME: home, CLAUDE_PROJECT_DIR: home }, () =>
      assert.equal(resolveAgent(), "unknown"),
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
