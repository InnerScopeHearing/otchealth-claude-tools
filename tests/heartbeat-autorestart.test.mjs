// Regression gate for HB-AUTORESTART's pure decision core (planAutoRestart in setup/heartbeat.mjs).
// Mirrors tests/fleet-medic.test.mjs's discipline: this is the hermetic "brain" (no Azure/ARM/network),
// so it must catch regressions to the cooldown/escalate rules without ever making a live restart call.
// Load-bearing guarantees: (1) first DEAD sighting restarts; (2) cooldown suppresses a re-restart within
// the window; (3) crossing the escalate threshold PAUSES and does not restart forever; (4) once paused,
// stays paused until a human clears state (no silent un-pause).
import { test } from "node:test";
import assert from "node:assert/strict";
import { planAutoRestart } from "../setup/heartbeat.mjs";

const NOW = Date.parse("2026-07-05T12:00:00Z");
const OPTS = { cooldownMin: 360, escalateAfter: 3 };

test("no prior restart -> plan is restart (attempt 1)", () => {
  const d = planAutoRestart("brain-reindex", null, NOW, OPTS);
  assert.equal(d.plan, "restart");
  assert.equal(d.attempt, 1);
});

test("a restart within the cooldown window is suppressed (no hammering)", () => {
  const prior = { last_restart_ts: new Date(NOW - 60 * 60000).toISOString(), consecutive_restarts: 1, paused: false }; // 60m ago, cooldown 360m
  const d = planAutoRestart("brain-reindex", prior, NOW, OPTS);
  assert.equal(d.plan, "cooldown");
});

test("a restart past the cooldown window is allowed again, attempt increments", () => {
  const prior = { last_restart_ts: new Date(NOW - 400 * 60000).toISOString(), consecutive_restarts: 1, paused: false }; // 400m ago > 360m cooldown
  const d = planAutoRestart("brain-reindex", prior, NOW, OPTS);
  assert.equal(d.plan, "restart");
  assert.equal(d.attempt, 2);
});

test("crossing the escalate threshold (Nth consecutive still-DEAD) PAUSES instead of retrying forever", () => {
  const prior = { last_restart_ts: new Date(NOW - 400 * 60000).toISOString(), consecutive_restarts: 3, paused: false }; // already at escalateAfter
  const d = planAutoRestart("brain-reindex", prior, NOW, OPTS);
  assert.equal(d.plan, "escalate");
  assert.equal(d.nextState.paused, true);
});

test("once paused, stays paused on subsequent sweeps regardless of cooldown elapsed (no silent un-pause)", () => {
  const prior = { last_restart_ts: new Date(NOW - 100000 * 60000).toISOString(), consecutive_restarts: 4, paused: true };
  const d = planAutoRestart("brain-reindex", prior, NOW, OPTS);
  assert.equal(d.plan, "paused");
});

test("exactly at escalateAfter attempts (not yet over) still restarts one more time", () => {
  // consecutive_restarts=2, escalateAfter=3 -> this would-be attempt is 3, which is <= escalateAfter -> restart, not escalate.
  const prior = { last_restart_ts: new Date(NOW - 400 * 60000).toISOString(), consecutive_restarts: 2, paused: false };
  const d = planAutoRestart("brain-reindex", prior, NOW, OPTS);
  assert.equal(d.plan, "restart");
  assert.equal(d.attempt, 3);
});
