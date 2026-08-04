// Tests for fleet-backup/azure-watchdog.mjs's decideNextStep(), the pure outage-detection state
// machine. Extracted specifically so threshold-crossing, recovery, and the no-open-episode guard are
// deterministically testable without mocking S3, exec, or the network (2026-07-28 review finding: none
// of this had a test before, despite being load-bearing logic a 15-minute production schedule relies on).
import { test } from "node:test";
import assert from "node:assert/strict";
import { decideNextStep } from "../skills/fleet-backup/azure-watchdog.mjs";

const emptyState = () => ({ consecutiveFailures: 0, lastCheckAt: null, lastSuccessAt: null, episodes: [] });
const T1 = "2026-07-28T00:00:00.000Z";
const T2 = "2026-07-28T00:15:00.000Z";
const T3 = "2026-07-28T00:30:00.000Z";
const T4 = "2026-07-28T00:45:00.000Z";

test("healthy with no prior episode -> noop, counter stays 0, lastSuccessAt updates", () => {
  const d = decideNextStep(emptyState(), true, T1, 3);
  assert.equal(d.action, "noop");
  assert.equal(d.next.consecutiveFailures, 0);
  assert.equal(d.next.lastSuccessAt, T1);
  assert.equal(d.next.lastCheckAt, T1);
  assert.equal(d.next.episodes.length, 0);
});

test("unhealthy checks increment the counter and never declare below threshold", () => {
  let state = emptyState();
  let d = decideNextStep(state, false, T1, 3);
  assert.equal(d.action, "increment");
  assert.equal(d.next.consecutiveFailures, 1);
  state = d.next;

  d = decideNextStep(state, false, T2, 3);
  assert.equal(d.action, "increment");
  assert.equal(d.next.consecutiveFailures, 2);
  assert.equal(d.next.episodes.length, 0, "must not declare below threshold");
});

test("reaching the threshold with no open episode -> declare, with a fresh episode object", () => {
  let state = { ...emptyState(), consecutiveFailures: 2 };
  const d = decideNextStep(state, false, T3, 3);
  assert.equal(d.action, "declare");
  assert.equal(d.next.consecutiveFailures, 3);
  assert.deepEqual(d.episode, { declaredAt: T3, recoveredAt: null });
  // decideNextStep does NOT push the episode itself -- the caller only commits it after a successful
  // page(), so `next.episodes` must still be empty at this point.
  assert.equal(d.next.episodes.length, 0);
});

test("staying unhealthy past the threshold with an ALREADY-open episode -> increment, never re-declare", () => {
  const state = {
    consecutiveFailures: 5,
    lastCheckAt: T2,
    lastSuccessAt: null,
    episodes: [{ declaredAt: T1, recoveredAt: null }],
  };
  const d = decideNextStep(state, false, T3, 3);
  assert.equal(d.action, "increment", "must not re-declare a second episode while one is already open");
  assert.equal(d.next.consecutiveFailures, 6);
  assert.equal(d.next.episodes.length, 1);
});

test("healthy with an open episode -> recover, returns that episode (still unrecovered in `next`)", () => {
  const state = {
    consecutiveFailures: 4,
    lastCheckAt: T3,
    lastSuccessAt: null,
    episodes: [{ declaredAt: T1, recoveredAt: null }],
  };
  const d = decideNextStep(state, true, T4, 3);
  assert.equal(d.action, "recover");
  assert.equal(d.next.consecutiveFailures, 0);
  assert.equal(d.next.lastSuccessAt, T4);
  // The caller sets recoveredAt on d.episode ONLY after a successful page() -- decideNextStep leaves
  // it unrecovered, matching the page-before-mutate contract documented in main().
  assert.equal(d.episode.recoveredAt, null);
  assert.equal(d.episode.declaredAt, T1);
  // d.episode must be the SAME object reference as the one inside d.next.episodes, so that a caller
  // mutating d.episode.recoveredAt actually updates what gets persisted.
  assert.equal(d.episode, d.next.episodes[0]);
});

test("a closed (already-recovered) episode does not block a NEW declaration later", () => {
  const state = {
    consecutiveFailures: 2,
    lastCheckAt: T2,
    lastSuccessAt: T2,
    episodes: [{ declaredAt: T1, recoveredAt: T2 }], // the earlier outage is over
  };
  const d = decideNextStep(state, false, T4, 3);
  assert.equal(d.action, "declare", "a closed episode must not suppress a fresh one");
  assert.equal(d.next.consecutiveFailures, 3);
});

test("decideNextStep never mutates its `state` argument (pure)", () => {
  const state = { ...emptyState(), episodes: [{ declaredAt: T1, recoveredAt: null }] };
  const stateCopy = JSON.parse(JSON.stringify(state));
  decideNextStep(state, true, T2, 3);
  assert.deepEqual(state, stateCopy, "input state object must be untouched");
});
