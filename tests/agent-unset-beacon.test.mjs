// W1-5 KB_AGENT propagation fix: the durable, canary-detectable signal for "this session resolved NO
// kb-memory agent identity" (skills/kb-memory/agent-unset-beacon.mjs). Guards the PURE throttle
// decision only (no network, no PostHog, no filesystem) -- the emit path itself is a fire-and-forget
// side effect exercised indirectly by tests/kb-inject.test.mjs (which asserts the hook still exits 0
// and prints its banner with the beacon wired in).
import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldEmit } from "../skills/kb-memory/agent-unset-beacon.mjs";

test("shouldEmit: never emitted before (0/undefined) -> emit now", () => {
  assert.equal(shouldEmit(0, Date.now(), 1_800_000), true);
  assert.equal(shouldEmit(undefined, Date.now(), 1_800_000), true);
});

test("shouldEmit: within the throttle window -> stay quiet (no spam)", () => {
  const now = Date.parse("2026-07-17T12:30:00Z");
  const last = Date.parse("2026-07-17T12:15:00Z"); // 15 min ago, throttle is 30 min
  assert.equal(shouldEmit(last, now, 30 * 60 * 1000), false);
});

test("shouldEmit: exactly at the throttle boundary -> emit (>=)", () => {
  const now = Date.parse("2026-07-17T12:30:00Z");
  const last = Date.parse("2026-07-17T12:00:00Z"); // exactly 30 min ago
  assert.equal(shouldEmit(last, now, 30 * 60 * 1000), true);
});

test("shouldEmit: well past the throttle window -> emit (a long single-turn session keeps re-flagging)", () => {
  const now = Date.parse("2026-07-17T14:00:00Z");
  const last = Date.parse("2026-07-17T12:00:00Z"); // 2h ago
  assert.equal(shouldEmit(last, now, 30 * 60 * 1000), true);
});
