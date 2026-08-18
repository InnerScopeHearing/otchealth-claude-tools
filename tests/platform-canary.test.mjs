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
  SEVERITY, assertLedger, assertLedgerFreshness, assertRetrieval, assertCoverage, assertRoomSet,
  assertTokenMint, assertToolFloor, assertCallerAgent, assertConnectorSurface, evaluatePlatform,
  evaluateRun, exitCode, forbiddenRoomsFor,
} from "../skills/platform-canary/assertions.mjs";
import { probeIdentity } from "../skills/platform-canary/platform-canary.mjs";

const SKILL = join(dirname(fileURLToPath(import.meta.url)), "..", "skills", "platform-canary");
const CONFIG = JSON.parse(readFileSync(join(SKILL, "expected-lanes.json"), "utf8"));
const fixture = (n) => JSON.parse(readFileSync(join(SKILL, "fixtures", n), "utf8"));

/**
 * Evaluate a fixture the same way the runner does: only the lanes the fixture actually observed.
 *
 * `coverage` overrides the shipped coverage floors. Partial fixtures (one or two lanes, isolating a
 * single assertion) would otherwise trip the shipped 5-lane / 5-ring floor and every test in this file
 * would fail for the wrong reason. Passing an explicit override per fixture keeps each test measuring
 * exactly what it claims to measure -- and coverage itself gets its own dedicated tests below, run
 * against the REAL shipped floors, so nothing is lost by relaxing it here.
 */
function runFixture(name, coverage) {
  const obs = fixture(name);
  const cfg = {
    ...CONFIG,
    lanes: CONFIG.lanes.filter((l) => obs.lanes && obs.lanes[l.lane] !== undefined),
    coverage: coverage ?? CONFIG.coverage,
  };
  return { obs, ...evaluateRun(cfg, obs) };
}

/** Coverage floors sized to a partial fixture: N lanes observed, all of them ring-checked. */
const partialCoverage = (n) => ({ min_lanes_evaluated: n, min_ring_assertions: n, require_ledger: true, require_retrieval: true });

/** Full exit-code call, so no test can accidentally omit the coverage term and pass by luck. */
const codeOf = (counts, findings) => exitCode({
  assertionFailures: counts.fail, checkErrors: counts.error,
  coverageReductions: counts.reduced, verdictsProduced: findings.length,
});

// ---------------------------------------------------------------------------------------------
// THE INCIDENT LOCK
// ---------------------------------------------------------------------------------------------

test("INCIDENT 2026-08-17/18: shared_entry_count=1 FAILS the canary (the whole reason this exists)", () => {
  const { counts, findings } = runFixture("incident-2026-08-17-shared-ledger.json", partialCoverage(5));
  assert.ok(counts.fail > 0, "the misrouted-ledger fixture must produce at least one FAILED assertion");
  const ledgerFail = findings.find((f) => f.check === "ledger_entry_floor" && f.state === "FAIL");
  assert.ok(ledgerFail, "expected a ledger_entry_floor FAILURE");
  assert.match(ledgerFail.message, /shared_entry_count is 1/);
  assert.match(ledgerFail.message, /BELOW the floor/);
  // And it must page, not merely warn.
  assert.equal(codeOf(counts, findings), 1);
});

test("INCIDENT: the ledger collapsing to a single agent lane also fails, independently of the entry floor", () => {
  const { findings } = runFixture("incident-2026-08-17-shared-ledger.json", partialCoverage(5));
  const agentFail = findings.find((f) => f.check === "ledger_agent_floor" && f.state === "FAIL");
  assert.ok(agentFail, "expected a ledger_agent_floor FAILURE for a 1-lane ledger");
  assert.match(agentFail.message, /only 1 distinct agent lane/);
});

test("INCIDENT: every LANE in the incident fixture is healthy, proving a lane-only canary would have gone green", () => {
  const { findings } = runFixture("incident-2026-08-17-shared-ledger.json", partialCoverage(5));
  const laneFailures = findings.filter((f) => f.scope === "lane" && f.state !== "PASS");
  assert.deepEqual(laneFailures, [], "the lanes were genuinely fine during the incident; only the ledger was wrong");
});

test("HEALTHY CONTROL: the same fixture with a real ledger passes everything and exits 0", () => {
  const { counts, findings } = runFixture("healthy.json", partialCoverage(5));
  assert.equal(counts.fail, 0, `expected zero failures, got: ${findings.filter((f) => f.state === "FAIL").map((f) => f.message).join(" | ")}`);
  assert.equal(counts.error, 0, `expected zero blind checks, got: ${findings.filter((f) => f.state === "ERROR").map((f) => f.message).join(" | ")}`);
  assert.equal(codeOf(counts, findings), 0);
});

// ---------------------------------------------------------------------------------------------
// THE RING ASSERTION (the load-bearing security check)
// ---------------------------------------------------------------------------------------------

test("RING: a forbidden personal-legal room appearing in a cfo-lane room set is a P0 failure", () => {
  const { findings, counts } = runFixture("ring-violation-cfo-personal-legal.json", partialCoverage(2));
  const ring = findings.find((f) => f.subject === "cfo" && f.check === "ring" && f.state === "FAIL");
  assert.ok(ring, "expected a ring FAILURE on the cfo lane");
  assert.equal(ring.severity, SEVERITY.P0);
  assert.match(ring.message, /legal-personal/);
  assert.match(ring.message, /legal-personal-memory/);
  assert.ok(counts.p0 >= 1);
  assert.equal(codeOf(counts, findings), 1);
});

test("RING: the SAME rooms on clo-personal are allowed, so the assertion is ring-aware and not name-matching", () => {
  const { findings } = runFixture("ring-violation-cfo-personal-legal.json", partialCoverage(2));
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
  const { findings, counts } = runFixture("connector-surface-misclassification.json", partialCoverage(1));
  const floor = findings.find((f) => f.check === "tool_floor" && f.state === "FAIL");
  assert.ok(floor, "expected a tool_floor FAILURE");
  assert.match(floor.message, /11 is BELOW its floor/);
  assert.ok(counts.fail >= 1);
});

test("CONNECTOR SURFACE: the same fixture also fails the connector_surface assertion", () => {
  const { findings } = runFixture("connector-surface-misclassification.json", partialCoverage(1));
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
  const laneFindings = findings.filter((f) => f.scope === "lane");
  assert.equal(laneFindings.length, 1, "only the mint verdict should exist; nothing downstream actually ran");
  assert.equal(laneFindings[0].check, "token_mint");
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
  const { findings } = runFixture("ring-violation-cfo-personal-legal.json", partialCoverage(2));
  for (const f of findings) {
    assert.equal(typeof f.message, "string");
    assert.ok(f.message.length < 600, "verdict messages stay short and structured, never a content dump");
  }
});

// ---------------------------------------------------------------------------------------------
// BLOCKER 1 -- THE REAL catalog_probe SHAPE
//
// Round 1 read probe.is_connector_surface / probe.caller_agent at the TOP level of catalog_probe's
// payload. Both live under request_context. So both reads returned null on every run, forever, and a
// null read was then treated as a silent skip -- meaning the connector_surface check and the P0
// caller_agent cross-wiring check could never fire at all. The canary paged blind on two of its five
// per-lane assertions by construction. These tests pin the accessor to the payload actually observed on
// the wire, and pin "field missing on a successful call" to ERROR rather than to a pass.
// ---------------------------------------------------------------------------------------------

test("BLOCKER 1: probeIdentity extracts BOTH identity fields from the REAL nested wire shape", () => {
  const f = fixture("blocker1-probe-real-nested-shape.json");
  // Feed it exactly as callTool() hands it over: structuredContent.result, i.e. the inner `result`.
  const unwrapped = f.raw_probe_payload.result;
  const id = probeIdentity(unwrapped);
  assert.equal(id.shapeOk, true);
  assert.equal(id.callerAgent, "cto", "caller_agent lives at request_context.caller_agent");
  assert.equal(id.connectorSurface, true, "is_connector_surface lives at request_context.is_connector_surface");
});

test("BLOCKER 1: probeIdentity also handles the still-enveloped shape (result.request_context)", () => {
  const f = fixture("blocker1-probe-real-nested-shape.json");
  const id = probeIdentity(f.raw_probe_payload);
  assert.equal(id.callerAgent, "cto");
  assert.equal(id.connectorSurface, true);
});

test("BLOCKER 1: the round-1 TOP-LEVEL shape yields nothing -- proving the old accessor read null forever", () => {
  const f = fixture("blocker1-probe-real-nested-shape.json");
  const unwrapped = f.raw_probe_payload.result;
  // This is the exact expression round 1 used. If it ever becomes non-null the gateway changed shape.
  assert.equal(unwrapped.is_connector_surface ?? unwrapped.connector_surface ?? null, null);
  assert.equal(unwrapped.caller_agent ?? null, null);
});

test("BLOCKER 1: a successful probe missing the fields is ERROR, never a silent skip or a pass", () => {
  const noCtx = probeIdentity({ build_tag: "x", tool_registry_count: 1008 });
  assert.equal(noCtx.shapeOk, false);
  assert.equal(noCtx.callerAgent, undefined, "absent must be undefined, distinguishable from observed-false");
  assert.equal(noCtx.connectorSurface, undefined);
  // And the assertions classify that absence as blindness, not health.
  assert.equal(assertCallerAgent({ lane: "cto", callerAgent: null }).state, "ERROR");
  assert.equal(assertConnectorSurface({ lane: "cto", connectorSurface: null, expectConnectorSurface: false }).state, "ERROR");
});

test("BLOCKER 1: an observed-false connector_surface is NOT treated as a missing field", () => {
  const id = probeIdentity({ request_context: { caller_agent: "cfo", is_connector_surface: false } });
  assert.equal(id.connectorSurface, false, "false is a VALUE; ?? must not collapse it to undefined");
  assert.equal(assertConnectorSurface({ lane: "cfo", connectorSurface: id.connectorSurface, expectConnectorSurface: false }).state, "PASS");
});

// ---------------------------------------------------------------------------------------------
// BLOCKER 2 -- ONE CONFIG LINE MUST NEVER DELETE THE P0 RING ASSERTION
// ---------------------------------------------------------------------------------------------

test("BLOCKER 2: cro with legal-personal in its room set FAILS, despite expects_brain_search:false", () => {
  // The flag is FORCED on here rather than read from the registry. The shipped registry no longer sets
  // expects_brain_search:false on cro (that was the separate config half of this defect, see the test
  // below), so relying on the registry would make this test silently stop exercising the CODE property
  // it exists to lock -- it would pass against the round-1 branch purely because the config changed.
  // This is the reviewer's exact proof case, pinned to the code and immune to config drift.
  const obs = fixture("blocker2-cro-ring-violation-expects-brain-search-false.json");
  const cro = { ...CONFIG.lanes.find((l) => l.lane === "cro"), expects_brain_search: false };
  const { findings, counts } = evaluateRun({ ...CONFIG, lanes: [cro], coverage: partialCoverage(1) }, obs);
  const ring = findings.find((f) => f.subject === "cro" && f.check === "ring" && f.state === "FAIL");
  assert.ok(ring, "the forbidden-room assertion MUST run on a lane configured expects_brain_search:false");
  assert.equal(ring.severity, SEVERITY.P0);
  assert.match(ring.message, /legal-personal/);
  assert.ok(counts.p0 >= 1);
  assert.equal(codeOf(counts, findings), 1, "this observation set must page, not pass");
});

test("BLOCKER 2 (config half): the shipped registry no longer declares expects_brain_search:false anywhere", () => {
  // The code fix makes the flag harmless to the ring assertion. The config fix removes the two false
  // claims that set it (cro and cpo), both of which were contradicted by this repo's own OPEN finding
  // FND-20260817-e462 (client_credentials cro measured at 1008 tools) and by the gateway source.
  const declared = CONFIG.lanes.filter((l) => l.expects_brain_search === false).map((l) => l.lane);
  assert.deepEqual(declared, [], `lanes still declaring expects_brain_search:false: ${declared.join(", ")}`);
});

test("BLOCKER 2 LOCK: expects_brain_search can NEVER suppress the forbidden-room half, for any lane", () => {
  // Exhaustive over the shipped registry: give EVERY lane outside the personal-legal ring a room set
  // containing both personal rooms, with expects_brain_search forced false, and require a P0 every time.
  for (const laneCfg of CONFIG.lanes) {
    if (CONFIG.personal_legal_ring.includes(laneCfg.lane)) continue;
    const cfg = { ...CONFIG, lanes: [{ ...laneCfg, optional: false, expects_brain_search: false }], coverage: partialCoverage(1) };
    const obs = { lanes: { [laneCfg.lane]: {
      lane: laneCfg.lane, credsPresent: true, tokenMinted: true, toolCount: 1008,
      connectorSurface: false, callerAgent: laneCfg.lane,
      roomsSearched: ["memory-exec", ...CONFIG.personal_legal_rooms],
    } } };
    const { findings } = evaluateRun(cfg, obs);
    const ring = findings.find((f) => f.check === "ring" && f.state === "FAIL" && f.severity === SEVERITY.P0);
    assert.ok(ring, `lane ${laneCfg.lane}: expects_brain_search:false must not suppress the ring assertion`);
  }
});

test("BLOCKER 2: expects_brain_search:false MAY still relax the expected-PRESENT half", () => {
  // The legitimate use of the flag survives: a lane whose room set is not independently known is not
  // failed for missing rooms. Only the security half is immune to config.
  const out = assertRoomSet({
    lane: "cro", roomsSearched: ["memory-exec"],
    expectedRooms: ["memory-exec", "commons-company-journal"],
    forbiddenRooms: ["legal-personal"], personalLegalRooms: ["legal-personal"],
    assertExpected: false, declaredNoBrainSearch: true,
  });
  assert.equal(out.filter((f) => f.check === "room_set" && f.state === "FAIL").length, 0, "no missing-room failure when the expected half is relaxed");
  assert.ok(out.some((f) => f.check === "room_set_registry_drift" && f.state === "FAIL"), "but the stale registry entry is still surfaced");
});

test("BLOCKER 2: a lane that declares no brain tool AND returned no rooms is a vacuous SKIP, not blindness", () => {
  const out = assertRoomSet({
    lane: "cpo", roomsSearched: null, expectedRooms: [], forbiddenRooms: ["legal-personal"],
    personalLegalRooms: ["legal-personal"], assertExpected: false, declaredNoBrainSearch: true,
  });
  assert.equal(out[0].state, "SKIP");
  assert.match(out[0].message, /nothing to forbid/);
});

// ---------------------------------------------------------------------------------------------
// BLOCKER 3 -- AN UNARMED RUN MUST NOT EXIT 0
// ---------------------------------------------------------------------------------------------

test("BLOCKER 3: the unarmed platform-only run MUST NOT exit 0", () => {
  const { findings, counts } = runFixture("blocker3-unarmed-platform-only.json");
  assert.equal(counts.fail, 0, "nothing in this fixture is broken -- every platform surface is healthy");
  assert.equal(counts.error, 0, "and nothing errored -- which is exactly why round 1 exited 0 here");
  assert.ok(counts.reduced >= 1, "coverage must be REDUCED");
  assert.notEqual(codeOf(counts, findings), 0, "a run that checked no lane, no ring and no ledger is not a pass");
  assert.equal(codeOf(counts, findings), 3);
});

test("BLOCKER 3: the unarmed run names all three things it failed to cover, separately", () => {
  const { findings } = runFixture("blocker3-unarmed-platform-only.json");
  const reduced = findings.filter((f) => f.state === "REDUCED").map((f) => f.check);
  for (const c of ["coverage_lanes", "coverage_ring", "coverage_ledger", "coverage_retrieval"]) {
    assert.ok(reduced.includes(c), `expected a REDUCED verdict for ${c}`);
  }
});

test("BLOCKER 3: 'assertion failed', 'could not run' and 'reduced coverage' are three distinct outcomes", () => {
  assert.equal(exitCode({ assertionFailures: 1, checkErrors: 0, coverageReductions: 0, verdictsProduced: 5 }), 1);
  assert.equal(exitCode({ assertionFailures: 0, checkErrors: 1, coverageReductions: 0, verdictsProduced: 5 }), 2);
  assert.equal(exitCode({ assertionFailures: 0, checkErrors: 0, coverageReductions: 1, verdictsProduced: 5 }), 3);
  assert.equal(exitCode({ assertionFailures: 0, checkErrors: 0, coverageReductions: 0, verdictsProduced: 5 }), 0);
  // Precedence: proven failure > blindness > thin coverage.
  assert.equal(exitCode({ assertionFailures: 1, checkErrors: 1, coverageReductions: 1, verdictsProduced: 5 }), 1);
  assert.equal(exitCode({ assertionFailures: 0, checkErrors: 1, coverageReductions: 1, verdictsProduced: 5 }), 2);
});

test("BLOCKER 3: omitting the coverage term cannot silently restore the old exit-0 behaviour", () => {
  // Defensive: the parameter defaults to 0, so a caller that forgets it still gets the pre-existing
  // semantics rather than a crash -- but evaluateRun always supplies it, and codeOf() above is what
  // every test in this file uses, so a regression would surface here rather than in production.
  assert.equal(exitCode({ assertionFailures: 0, checkErrors: 0, verdictsProduced: 5 }), 0);
});

// ---------------------------------------------------------------------------------------------
// COVERAGE, against the REAL shipped floors
// ---------------------------------------------------------------------------------------------

test("COVERAGE: the shipped floors require all five REQUIRED lanes and five ring assertions", () => {
  const required = CONFIG.lanes.filter((l) => l.optional !== true).map((l) => l.lane);
  assert.equal(CONFIG.coverage.min_lanes_evaluated, required.length, "the lane floor tracks the required-lane count");
  assert.equal(CONFIG.coverage.min_ring_assertions, required.length, "and every required lane must have its ring checked");
  assert.equal(CONFIG.coverage.require_ledger, true);
  assert.equal(CONFIG.coverage.require_retrieval, true);
});

test("COVERAGE: healthy.json meets the shipped floors exactly and exits 0", () => {
  const { findings, counts } = runFixture("healthy.json");
  assert.equal(counts.reduced, 0, findings.filter((f) => f.state === "REDUCED").map((f) => f.message).join(" | "));
  assert.equal(counts.lanesEvaluated, 5);
  assert.equal(counts.ringAssertionsRun, 5);
  assert.equal(codeOf(counts, findings), 0);
});

test("COVERAGE (gap 4): four of nine lanes going dark can no longer produce a green result", () => {
  // Drop one required lane's credential. Round 1 would have SKIPped/ERRORed only that lane; the run's
  // OTHER lanes would still look fine. The coverage floor is what makes the shrunken run itself loud.
  const obs = fixture("healthy.json");
  delete obs.lanes.clo;
  delete obs.lanes["clo-personal"];
  const cfg = { ...CONFIG, lanes: CONFIG.lanes.filter((l) => obs.lanes[l.lane] !== undefined) };
  const { findings, counts } = evaluateRun(cfg, obs);
  assert.equal(counts.fail, 0);
  assert.ok(counts.reduced >= 1);
  assert.notEqual(codeOf(counts, findings), 0);
});

test("COVERAGE: a lane whose mint failed does NOT count toward the evaluated-lane floor", () => {
  const obs = fixture("healthy.json");
  obs.lanes.cfo = { lane: "cfo", credsPresent: true, tokenMinted: false, mintError: "HTTP 401" };
  const { counts } = evaluateRun({ ...CONFIG }, obs);
  assert.equal(counts.lanesEvaluated, 4, "a lane that never got a token was not evaluated");
  assert.ok(counts.reduced >= 1, "and that shortfall is loud");
});

test("COVERAGE: a lane whose room list was unreadable does NOT count toward the ring floor", () => {
  const obs = fixture("healthy.json");
  obs.lanes.clo.roomsSearched = null;   // brain_search answered nothing readable
  const { counts, findings } = evaluateRun({ ...CONFIG }, obs);
  assert.equal(counts.ringAssertionsRun, 4, "the ring assertion did not actually execute on clo");
  assert.ok(counts.error >= 1, "and the blind check is reported as blindness");
  assert.equal(codeOf(counts, findings), 2, "blindness outranks the coverage shortfall it caused");
});

// ---------------------------------------------------------------------------------------------
// GAP 1 -- A FROZEN-BUT-READABLE LEDGER
// ---------------------------------------------------------------------------------------------

test("GAP 1: a 300-entry / 8-lane ledger with a stale newest timestamp MUST FAIL", () => {
  const { findings, counts } = runFixture("gap1-ledger-frozen-but-large.json", partialCoverage(1));
  const stale = findings.find((f) => f.check === "ledger_freshness" && f.state === "FAIL");
  assert.ok(stale, "a frozen ledger must fail on AGE even though every size floor passes");
  assert.match(stale.message, /ABOVE the 72h SLO/);
  // And prove the floors themselves were satisfied, so the failure is unambiguously the age check.
  assert.equal(findings.filter((f) => f.check === "ledger_entry_floor" && f.state === "FAIL").length, 0);
  assert.equal(findings.filter((f) => f.check === "ledger_agent_floor" && f.state === "FAIL").length, 0);
  assert.equal(codeOf(counts, findings), 1);
});

test("GAP 1: freshness boundary -- inside the SLO passes, outside fails, unparseable/absent is ERROR", () => {
  const now = Date.parse("2026-08-18T00:00:00.000Z");
  assert.equal(assertLedgerFreshness({ newestTs: "2026-08-15T01:00:00.000Z", maxAgeH: 72, now }).state, "PASS");
  assert.equal(assertLedgerFreshness({ newestTs: "2026-08-14T23:00:00.000Z", maxAgeH: 72, now }).state, "FAIL");
  assert.equal(assertLedgerFreshness({ newestTs: null, maxAgeH: 72, now }).state, "ERROR");
  assert.equal(assertLedgerFreshness({ newestTs: "not-a-timestamp", maxAgeH: 72, now }).state, "ERROR");
});

test("GAP 1: an unreadable ledger does not ALSO emit a redundant freshness ERROR", () => {
  const cfg = { ...CONFIG, lanes: [], coverage: { min_lanes_evaluated: 0, min_ring_assertions: 0, require_retrieval: false } };
  const { findings } = evaluateRun(cfg, { lanes: {}, ledger: { error: "memory_team HTTP 503" }, platforms: {} });
  assert.equal(findings.filter((f) => f.check === "ledger_freshness").length, 0, "one cause, one message");
});

// ---------------------------------------------------------------------------------------------
// GAPS 2 + 3 -- STALE/EMPTY ROOM, AND SILENT KEYWORD-ONLY DEGRADATION
// ---------------------------------------------------------------------------------------------

test("GAP 2: a room that resolved but returned zero results FAILS, though every room-set check passes", () => {
  const { findings, counts } = runFixture("gap2-3-retrieval-degraded.json", partialCoverage(1));
  assert.deepEqual(findings.filter((f) => f.check === "room_set" && f.state === "FAIL"), [], "the room set itself is fine -- that is the point");
  const empty = findings.find((f) => f.check === "room_results" && f.state === "FAIL");
  assert.ok(empty, "zero results from a broad query must fail");
  assert.match(empty.message, /empty, frozen, or mid-reindex/);
  assert.equal(codeOf(counts, findings), 1);
});

test("GAP 3: mode 'keyword' instead of 'hybrid' FAILS -- the embeddings half died silently", () => {
  const { findings } = runFixture("gap2-3-retrieval-degraded.json", partialCoverage(1));
  const degraded = findings.find((f) => f.check === "retrieval_mode" && f.state === "FAIL");
  assert.ok(degraded, "keyword-only retrieval must fail");
  assert.match(degraded.message, /embeddings credential/);
});

test("GAP 3: hybrid passes; an absent mode is ERROR (blind), never an implied pass", () => {
  const ok = assertRetrieval({ index: "memory-exec", mode: "hybrid", resultCount: 3, minResults: 1 });
  assert.deepEqual(ok.filter((f) => f.state !== "PASS"), []);
  const blind = assertRetrieval({ index: "memory-exec", mode: null, resultCount: 3, minResults: 1 });
  assert.equal(blind.find((f) => f.check === "retrieval_mode").state, "ERROR");
  const noCount = assertRetrieval({ index: "memory-exec", mode: "hybrid", resultCount: undefined, minResults: 1 });
  assert.equal(noCount.find((f) => f.check === "room_results").state, "ERROR");
});

// ---------------------------------------------------------------------------------------------
// THE INCIDENT LOCK MUST SURVIVE EVERY CHANGE ABOVE
// ---------------------------------------------------------------------------------------------

test("REGRESSION: after all of the above, the incident fixture STILL fails on the ledger while its lanes pass", () => {
  const { findings, counts } = runFixture("incident-2026-08-17-shared-ledger.json", partialCoverage(5));
  const ledgerFail = findings.find((f) => f.check === "ledger_entry_floor" && f.state === "FAIL");
  assert.ok(ledgerFail, "the whole reason this canary exists");
  assert.match(ledgerFail.message, /shared_entry_count is 1/);
  assert.deepEqual(findings.filter((f) => f.scope === "lane" && f.state !== "PASS"), [], "lane-only canary would still have gone green");
  assert.equal(counts.reduced, 0, "and it fails on the LEDGER, not on a coverage technicality");
  assert.equal(codeOf(counts, findings), 1);
});

test("BLINDNESS: a configured lane the collector never reached is ERROR, not a fabricated mint FAILURE", () => {
  // Without the absent-observation branch, `obs?.credsPresent !== false` reads undefined as "creds
  // present" and `!!obs?.tokenMinted` reads it as "mint failed", producing a confident and WRONG
  // diagnosis ("the OAuth client is rotated or revoked") manufactured out of an absence.
  const cfg = CONFIG.lanes.find((l) => l.lane === "cfo");
  const { findings } = evaluateRun({ ...CONFIG, lanes: [cfg], coverage: { min_lanes_evaluated: 0, min_ring_assertions: 0, require_ledger: false, require_retrieval: false } }, { lanes: {} });
  const lane = findings.filter((f) => f.scope === "lane");
  assert.equal(lane.length, 1);
  assert.equal(lane[0].state, "ERROR");
  assert.match(lane[0].message, /no observation was produced/);
});
