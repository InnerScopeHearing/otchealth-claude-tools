import { test } from "node:test";
import assert from "node:assert/strict";
import { evidenceFor, RING_AGENTS } from "../canary.mjs";

test("coo/cro precedent: a real persona + LANES entry never verdicts DORMANT (both required to be true, not either)", () => {
  // coo/cro are not in RING_AGENTS (removed from EXEC_RING) but the underlying evidenceFor logic
  // must still treat them as non-dormant if run against them, to prove the function does not
  // regress to the flawed v1 (memory-volume) signal for roles known to have real personas + LANES.
  const coo = evidenceFor("coo");
  assert.equal(coo.hasPersona, true);
  assert.equal(coo.hasLane, true);
  assert.equal(coo.dormant, false);
});

test("cpo and cco (Wave 3.1 subjects) have neither a persona file nor LANES connectivity today", () => {
  const cpo = evidenceFor("cpo");
  const cco = evidenceFor("cco");
  assert.equal(cpo.hasPersona, false);
  assert.equal(cpo.hasLane, false);
  assert.equal(cpo.dormant, true);
  assert.equal(cco.hasPersona, false);
  assert.equal(cco.hasLane, false);
  assert.equal(cco.dormant, true);
});

test("cfo and clo (real, wired EXEC_RING members) are never flagged dormant", () => {
  for (const agent of ["cfo", "clo"]) {
    const e = evidenceFor(agent);
    assert.equal(e.dormant, false, `${agent} must not be flagged dormant`);
  }
});

test("exec and clo-personal are structural ring names, never flagged dormant regardless of persona/LANES state", () => {
  for (const agent of ["exec", "clo-personal"]) {
    const e = evidenceFor(agent);
    assert.equal(e.structural, true);
    assert.equal(e.dormant, false);
  }
});

test("RING_AGENTS mirrors the current EXEC_RING + PERSONAL_LEGAL_RING shape (6 entries)", () => {
  assert.deepEqual([...RING_AGENTS].sort(), ["cco", "cfo", "clo", "clo-personal", "cpo", "exec"].sort());
});
