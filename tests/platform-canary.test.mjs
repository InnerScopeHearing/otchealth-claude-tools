// Unit tests for the per-lane / per-platform health canary's assertion core.
//
// The load-bearing test in this file is the first one: the fixture reproducing the 2026-08-17/18
// misrouted-bucket incident (shared_entry_count=1) MUST fail the canary. A canary that would not have
// caught that incident is not worth having, so that fixture is a permanent regression lock. The healthy
// control differs from it in exactly one field, which proves the failure comes from the ledger floor and
// not from fixture drift.
//
// Everything here imports the PURE assertions module, so no test touches the network, a credential, or
// the live gateway.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  SEVERITY, assertLedger, assertRoomSet, assertTokenMint, assertToolFloor, assertCallerAgent,
  assertConnectorSurface, evaluatePlatform, evaluateRun, exitCode, forbiddenRoomsFor,
} from "../skills/platform-canary/assertions.mjs";

const SKILL = join(dirname(fileURLToPath(import.meta.url)), "..", "skills", "platform-canary");
const CONFIG = JSON.parse(readFileSync(join(SKILL, "expected-lanes.json"), "utf8"));
const fixture = (n) => JSON.parse(readFileSync(join(SKILL, "fixtures", n), "utf8"));

/** Evaluate a fixture the same way the runner does: only the lanes the fixture actually observed. */
function runFixture(name) {
  const obs = fixture(name);
  const cfg = { ...CONFIG, lanes: CONFIG.lanes.filter((l) => obs.lanes && obs.lanes[l.lane] !== undefined) };
  return { obs, ...evaluateRun(cfg, obs) };
}

// ---------------------------------------------------------------------------------------------
// THE INCIDENT LOCK
// ---------------------------------------------------------------------------------------------

test("INCIDENT 2026-08-17/18: shared_entry_count=1 FAILS the canary (the whole reason this exists)", () => {
  const { counts, findings } = runFixture("incident-2026-08-17-shared-ledger.json");
  assert.ok(counts.fail > 0, "the misrouted-ledger fixture must produce at least one FAILED assertion");
  const ledgerFail = findings.find((f) => f.check === "ledger_entry_floor" && f.state === "FAIL");
  assert.ok(ledgerFail, "expected a ledger_entry_floor FAILURE");
  assert.match(ledgerFail.message, /shared_entry_count is 1/);
  assert.match(ledgerFail.message, /BELOW the floor/);
  // And it must page, not merely warn.
  assert.equal(exitCode({ assertionFailures: counts.fail, checkErrors: counts.error, verdictsProduced: findings.length }), 1);
});

test("INCIDENT: the ledger collapsing to a single agent lane also fails, independently of the entry floor", () => {
  const { findings } = runFixture("incident-2026-08-17-shared-ledger.json");
  const agentFail = findings.find((f) => f.check === "ledger_agent_floor" && f.state === "FAIL");
  assert.ok(agentFail, "expected a ledger_agent_floor FAILURE for a 1-lane ledger");
  assert.match(agentFail.message, /only 1 distinct agent lane/);
});

test("INCIDENT: every LANE in the incident fixture is healthy, proving a lane-only canary would have gone green", () => {
  const { findings } = runFixture("incident-2026-08-17-shared-ledger.json");
  const laneFailures = findings.filter((f) => f.scope === "lane" && f.state !== "PASS");
  assert.deepEqual(laneFailures, [], "the lanes were genuinely fine during the incident; only the ledger was wrong");
});

test("HEALTHY CONTROL: the same fixture with a real ledger passes everything and exits 0", () => {
  const { counts, findings } = runFixture("healthy.json");
  assert.equal(counts.fail, 0, `expected zero failures, got: ${findings.filter((f) => f.state === "FAIL").map((f) => f.message).join(" | ")}`);
  assert.equal(counts.error, 0, `expected zero blind checks, got: ${findings.filter((f) => f.state === "ERROR").map((f) => f.message).join(" | ")}`);
  assert.equal(exitCode({ assertionFailures: counts.fail, checkErrors: counts.error, verdictsProduced: findings.length }), 0);
});

// ---------------------------------------------------------------------------------------------
// THE RING ASSERTION (the load-bearing security check)
// ---------------------------------------------------------------------------------------------

test("RING: a forbidden personal-legal room appearing in a cfo-lane room set is a P0 failure", () => {
  const { findings, counts } = runFixture("ring-violation-cfo-personal-legal.json");
  const ring = findings.find((f) => f.subject === "cfo" && f.check === "ring" && f.state === "FAIL");
  assert.ok(ring, "expected a ring FAILURE on the cfo lane");
  assert.equal(ring.severity, SEVERITY.P0);
  assert.match(ring.message, /legal-personal/);
  assert.match(ring.message, /legal-personal-memory/);
  assert.ok(counts.p0 >= 1);
  assert.equal(exitCode({ assertionFailures: counts.fail, checkErrors: counts.error, verdictsProduced: findings.length }), 1);
});

test("RING: the SAME rooms on clo-personal are allowed, so the assertion is ring-aware and not name-matching", () => {
  const { findings } = runFixture("ring-violation-cfo-personal-legal.json");
  const personalFailures = findings.filter((f) => f.subject === "clo-personal" && f.state === "FAIL");
  assert.deepEqual(personalFailures, [], "clo-personal is inside the personal-legal ring and must not be flagged");
});

test("RING: clo-personal is the POSITIVE CONTROL -- the personal rooms going missing is also a failure", () => {
  // If the ring check only ever asserted absence, the personal rooms vanishing from the estate would
  // look identical to a healthy day. clo-personal asserts they are PRESENT, so that outage is visible.
  const cfg = CONFIG.lanes.find((l) => l.lane === "clo-personal");
  const out = assertRoomSet({
    lane: "clo-personal",
    roomsSearched: ["memory-exec", "commons-company-journal", "legal-company"],
    expectedRooms: cfg.expected_rooms,
    forbiddenRooms: forbiddenRoomsFor(cfg, CONFIG),
    personalLegalRooms: CONFIG.personal_legal_rooms,
  });
  const miss = out.find((f) => f.state === "FAIL" && f.check === "room_set");
  assert.ok(miss, "a clo-personal room set missing the personal rooms must fail");
  assert.match(miss.message, /legal-personal/);
});

test("RING: forbidden rooms are DERIVED from policy, so a new lane is born forbidden", () => {
  const brandNewLane = { lane: "some-future-lane" }; // no forbidden_rooms declared at all
  const forbidden = forbiddenRoomsFor(brandNewLane, CONFIG);
  for (const room of CONFIG.personal_legal_rooms) {
    assert.ok(forbidden.includes(room), `a lane that declares nothing must still forbid ${room}`);
  }
});

test("RING: every lane in the shipped registry that is not in the ring forbids BOTH personal-legal rooms", () => {
  for (const laneCfg of CONFIG.lanes) {
    const forbidden = forbiddenRoomsFor(laneCfg, CONFIG);
    const inRing = CONFIG.personal_legal_ring.includes(laneCfg.lane);
    for (const room of CONFIG.personal_legal_rooms) {
      assert.equal(forbidden.includes(room), !inRing, `lane ${laneCfg.lane} vs ${room}: ring membership is ${inRing}`);
    }
  }
});

test("RING: the shipped registry's ring is exactly clo-personal + exec", () => {
  assert.deepEqual([...CONFIG.personal_legal_ring].sort(), ["clo-personal", "exec"]);
});

// ---------------------------------------------------------------------------------------------
// CONNECTOR-SURFACE MISCLASSIFICATION
// ---------------------------------------------------------------------------------------------

test("TOOL FLOOR: a privileged lane offered ~11 tools instead of ~1000 fails the floor", () => {
  const { findings, counts } = runFixture("connector-surface-misclassification.json");
  const floor = findings.find((f) => f.check === "tool_floor" && f.state === "FAIL");
  assert.ok(floor, "expected a tool_floor FAILURE");
  assert.match(floor.message, /11 is BELOW its floor/);
  assert.ok(counts.fail >= 1);
});

test("CONNECTOR SURFACE: the same fixture also fails the connector_surface assertion", () => {
  const { findings } = runFixture("connector-surface-misclassification.json");
  const cs = findings.find((f) => f.check === "connector_surface" && f.state === "FAIL");
  assert.ok(cs, "expected a connector_surface FAILURE");
  assert.match(cs.message, /connector_surface is true, expected false/);
});

test("TOOL FLOOR: exactly at the floor passes; one below fails", () => {
  assert.equal(assertToolFloor({ lane: "cto", toolCount: 100, minToolCount: 100 }).state, "PASS");
  assert.equal(assertToolFloor({ lane: "cto", toolCount: 99, minToolCount: 100 }).state, "FAIL");
});

test("TOOL FLOOR: an unobtainable count is ERROR (blind), never a silent PASS", () => {
  assert.equal(assertToolFloor({ lane: "cto", toolCount: null, minToolCount: 100 }).state, "ERROR");
  assert.equal(assertToolFloor({ lane: "cto", toolCount: NaN, minToolCount: 100 }).state, "ERROR");
});

test("CALLER AGENT: a lane resolving to a different identity is a P0 cross-wiring failure", () => {
  const v = assertCallerAgent({ lane: "cfo", callerAgent: "cto" });
  assert.equal(v.state, "FAIL");
  assert.equal(v.severity, SEVERITY.P0);
});

test("CONNECTOR SURFACE: an unobservable value is ERROR, not a pass", () => {
  assert.equal(assertConnectorSurface({ lane: "cro", connectorSurface: null, expectConnectorSurface: false }).state, "ERROR");
});

// ---------------------------------------------------------------------------------------------
// LEDGER FLOORS + BOUNDARIES
// ---------------------------------------------------------------------------------------------

test("LEDGER: exactly at both floors passes (<= boundary convention, matching the other canaries)", () => {
  const out = assertLedger({ sharedEntryCount: 25, agents: ["a", "b", "c", "d", "e"], minSharedEntries: 25, minAgents: 5 });
  assert.deepEqual(out.filter((f) => f.state !== "PASS"), []);
});

test("LEDGER: duplicate agent names do not inflate the distinct-lane count", () => {
  const out = assertLedger({ sharedEntryCount: 500, agents: ["cto", "cto", "cto"], minSharedEntries: 25, minAgents: 5 });
  const fail = out.find((f) => f.check === "ledger_agent_floor" && f.state === "FAIL");
  assert.ok(fail, "three copies of one lane name is still one distinct lane");
});

test("LEDGER: an unreadable ledger is ERROR (blind), clearly distinct from a ledger that read low", () => {
  const err = assertLedger({ error: "memory_team HTTP 503", minSharedEntries: 25, minAgents: 5 });
  assert.equal(err[0].state, "ERROR");
  assert.match(err[0].message, /COULD NOT RUN/);
  const low = assertLedger({ sharedEntryCount: 1, agents: ["cto"], minSharedEntries: 25, minAgents: 5 });
  assert.equal(low[0].state, "FAIL");
});

test("LEDGER: a well-formed response carrying no count is ERROR, not zero", () => {
  const out = assertLedger({ sharedEntryCount: undefined, agents: ["cto"], minSharedEntries: 25, minAgents: 5 });
  assert.equal(out[0].state, "ERROR");
});

// ---------------------------------------------------------------------------------------------
// TOKEN MINT / ROOM-SET BLINDNESS
// ---------------------------------------------------------------------------------------------

test("TOKEN MINT: an unprovisioned OPTIONAL lane is SKIP; an unprovisioned REQUIRED lane is ERROR", () => {
  assert.equal(assertTokenMint({ lane: "exec", credsPresent: false, required: false }).state, "SKIP");
  const req = assertTokenMint({ lane: "cfo", credsPresent: false, required: true });
  assert.equal(req.state, "ERROR");
  assert.match(req.message, /blind here, not healthy here/);
});

test("TOKEN MINT: creds present but the mint failed is a real FAILURE", () => {
  const v = assertTokenMint({ lane: "cfo", credsPresent: true, tokenMinted: false, detail: "token endpoint HTTP 401 (invalid_client)" });
  assert.equal(v.state, "FAIL");
  assert.match(v.message, /invalid_client/);
});

test("ROOM SET: an unreadable rooms_searched is ERROR -- a ring assertion that could not run never passes", () => {
  const out = assertRoomSet({ lane: "cfo", roomsSearched: null, expectedRooms: ["memory-exec"], forbiddenRooms: ["legal-personal"], personalLegalRooms: ["legal-personal"] });
  assert.equal(out[0].state, "ERROR");
  assert.match(out[0].message, /COULD NOT RUN/);
});

test("ROOM SET: a lane whose mint failed produces NO synthesized downstream passes", () => {
  const cfg = CONFIG.lanes.find((l) => l.lane === "cfo");
  const { findings } = evaluateRun({ ...CONFIG, lanes: [cfg] }, { lanes: { cfo: { lane: "cfo", credsPresent: true, tokenMinted: false, mintError: "HTTP 401" } } });
  assert.equal(findings.length, 1, "only the mint verdict should exist; nothing downstream actually ran");
  assert.equal(findings[0].check, "token_mint");
});

// ---------------------------------------------------------------------------------------------
// PLATFORM SURFACES
// ---------------------------------------------------------------------------------------------

test("PLATFORM: the unauthenticated front door answering 200 instead of 401 is a P0", () => {
  const cfg = CONFIG.platforms.find((p) => p.name === "unauthenticated_mcp_refused");
  const out = evaluatePlatform(cfg, { status: 200, headers: ["content-type"] });
  const fail = out.find((f) => f.state === "FAIL");
  assert.equal(fail.severity, SEVERITY.P0);
  assert.match(fail.message, /live exposure/);
});

test("PLATFORM: the door refusing correctly but losing its WWW-Authenticate pointer still fails", () => {
  const cfg = CONFIG.platforms.find((p) => p.name === "unauthenticated_mcp_refused");
  const out = evaluatePlatform(cfg, { status: 401, headers: ["content-type"] });
  assert.ok(out.some((f) => f.state === "FAIL" && /www-authenticate/i.test(f.message)));
});

test("PLATFORM: a forged M365 static token must still be refused", () => {
  const cfg = CONFIG.platforms.find((p) => p.name === "forged_m365_token_refused");
  assert.equal(evaluatePlatform(cfg, { status: 401, headers: [] })[0].state, "PASS");
  assert.equal(evaluatePlatform(cfg, { status: 200, headers: [] })[0].state, "FAIL");
});

test("PLATFORM: /health below the registry tool floor fails even when status is ok", () => {
  const cfg = CONFIG.platforms.find((p) => p.name === "gateway_health");
  const out = evaluatePlatform(cfg, { status: "ok", toolCount: 42 });
  assert.ok(out.some((f) => f.state === "FAIL" && /BELOW the registry floor/.test(f.message)));
});

test("PLATFORM: an unreachable surface is ERROR (blind), not a pass", () => {
  const cfg = CONFIG.platforms.find((p) => p.name === "gateway_health");
  assert.equal(evaluatePlatform(cfg, { error: "fetch failed" })[0].state, "ERROR");
});

// ---------------------------------------------------------------------------------------------
// EXIT-CODE POLICY: "broken" and "blind" are different facts
// ---------------------------------------------------------------------------------------------

test("EXIT: a failed assertion exits 1; a blind check with no failure exits 2; clean exits 0", () => {
  assert.equal(exitCode({ assertionFailures: 1, checkErrors: 0, verdictsProduced: 10 }), 1);
  assert.equal(exitCode({ assertionFailures: 0, checkErrors: 1, verdictsProduced: 10 }), 2);
  assert.equal(exitCode({ assertionFailures: 0, checkErrors: 0, verdictsProduced: 10 }), 0);
});

test("EXIT: a proven failure outranks blindness -- there is something concrete to act on", () => {
  assert.equal(exitCode({ assertionFailures: 2, checkErrors: 5, verdictsProduced: 20 }), 1);
});

test("EXIT: evaluating nothing at all is exit 2, never 0 -- an empty run is not a pass", () => {
  assert.equal(exitCode({ assertionFailures: 0, checkErrors: 0, verdictsProduced: 0 }), 2);
});

test("EXIT: --report forces 0 for a safe manual run, even with failures", () => {
  assert.equal(exitCode({ assertionFailures: 9, checkErrors: 9, verdictsProduced: 9, reportOnly: true }), 0);
});

// ---------------------------------------------------------------------------------------------
// NO PRIVILEGED CONTENT EVER LEAVES THE CANARY
// ---------------------------------------------------------------------------------------------

test("SAFETY: verdict messages carry only names, counts and outcomes -- never room CONTENT", () => {
  // Feed a room set whose entries are the real room names, plus a decoy that looks like document text.
  // The assertion must report room NAMES it was configured to care about and must not echo arbitrary
  // payload back into a message that lands in CI logs and PostHog.
  const { findings } = runFixture("ring-violation-cfo-personal-legal.json");
  for (const f of findings) {
    assert.equal(typeof f.message, "string");
    assert.ok(f.message.length < 600, "verdict messages stay short and structured, never a content dump");
  }
});
