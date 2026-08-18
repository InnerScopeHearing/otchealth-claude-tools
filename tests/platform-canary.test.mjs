// Unit tests for the per-lane / per-platform health canary's assertion core AND its collector.
//
// The load-bearing test in this file is the first one: the fixture reproducing the 2026-08-17/18
// misrouted-bucket incident (shared_entry_count=1) MUST fail the canary. A canary that would not have
// caught that incident is not worth having, so that fixture is a permanent regression lock. The healthy
// control differs from it in exactly one field, which proves the failure comes from the ledger floor and
// not from fixture drift.
//
// ROUND-3 TESTING RULE, learned the hard way. Round 2's lock for the ring bug fed the PURE CLASSIFIER a
// `roomsSearched` array that the LIVE COLLECTOR could not produce when the flag under test was set. The
// test passed, the bug stayed live, and the test's own green light is what made it invisible. So:
// wherever a defect lives in the collector, the test drives the COLLECTOR (observeLane with an injected
// transport) and asserts on its REAL output shape. Hand-built observations are used only for defects
// that genuinely live in the classifier.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  SEVERITY, LANE_CHECKS, LEDGER_CHECKS, RETRIEVAL_CHECKS, checkId, planChecks, validateRegistry,
  assertLedger, assertLedgerFreshness, assertRetrieval, assertCoverage, assertExpectedRooms, assertRing,
  assertTokenMint, assertToolFloor, assertCallerAgent, assertConnectorSurface, evaluatePlatform,
  evaluateLane, evaluateRun, exitCode, forbiddenRoomsFor, isPersonalRingMember,
} from "../skills/platform-canary/assertions.mjs";
import { probeIdentity, observeLane } from "../skills/platform-canary/platform-canary.mjs";

const SKILL = join(dirname(fileURLToPath(import.meta.url)), "..", "skills", "platform-canary");
const CONFIG = JSON.parse(readFileSync(join(SKILL, "expected-lanes.json"), "utf8"));
const fixture = (n) => JSON.parse(readFileSync(join(SKILL, "fixtures", n), "utf8"));

/**
 * Evaluate a fixture the way the runner does.
 *
 * `scope: "observed"` narrows the config -- and, critically, `known_internal_lanes` with it -- to the
 * lanes the fixture actually recorded. That is not a coverage escape hatch: the DERIVED PLAN follows the
 * config it is handed, so a two-lane fixture gets a two-lane plan and each test measures exactly what it
 * claims. The SHIPPED registry's completeness is locked separately, against the real gateway lane list,
 * in its own test below, so nothing is lost by scoping here. The default is the FULL registry.
 *
 * `now` is pinned from the fixture's own `_now` so age-based assertions are judged against the clock the
 * snapshot was taken on, not against today's -- otherwise the control fixture starts failing the 72h
 * freshness SLO days after it was written, for reasons unrelated to any code.
 */
function runFixture(name, scope = "full") {
  const obs = fixture(name);
  const observed = new Set(Object.keys(obs.lanes || {}));
  const cfg = scope === "observed"
    ? { ...CONFIG, lanes: CONFIG.lanes.filter((l) => observed.has(l.lane)), known_internal_lanes: CONFIG.known_internal_lanes.filter((l) => observed.has(l)) }
    : CONFIG;
  const now = typeof obs._now === "string" ? Date.parse(obs._now) : Date.now();
  return { obs, cfg, ...evaluateRun(cfg, obs, { now }) };
}

/** Full exit-code call, so no test can accidentally omit the coverage term and pass by luck. */
const codeOf = (counts, findings) => exitCode({
  assertionFailures: counts.fail, checkErrors: counts.error,
  coverageReductions: counts.reduced, verdictsProduced: findings.length,
});

/** A healthy per-lane observation, in the exact shape observeLane() produces. */
const healthyLaneObs = (lane, rooms, toolCount = 1008) => ({
  lane, credsPresent: true, tokenMinted: true, toolCount, connectorSurface: false, callerAgent: lane, roomsSearched: rooms,
});

/** A single-lane config scoped so its plan is exactly that lane, with no ledger/retrieval/platform terms. */
const laneOnlyCfg = (laneCfg) => ({
  ...CONFIG, lanes: [laneCfg], known_internal_lanes: [laneCfg.lane],
  ledger: undefined, retrieval: undefined, platforms: [],
});
/** Lane-only evaluation, ignoring the registry-block validation noise a stripped config produces. */
function laneOnly(laneCfg, obs) {
  const { findings, counts } = evaluateRun(laneOnlyCfg(laneCfg), { lanes: obs === undefined ? {} : { [laneCfg.lane]: obs } });
  return { findings: findings.filter((f) => f.scope === "lane"), counts, all: findings };
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
  assert.equal(codeOf(counts, findings), 1);
});

test("INCIDENT: the ledger collapsing to a single agent lane also fails, independently of the entry floor", () => {
  const { findings } = runFixture("incident-2026-08-17-shared-ledger.json");
  const agentFail = findings.find((f) => f.check === "ledger_agent_floor" && f.state === "FAIL");
  assert.ok(agentFail, "expected a ledger_agent_floor FAILURE for a 1-lane ledger");
  assert.match(agentFail.message, /only 1 distinct agent lane/);
});

test("INCIDENT: every LANE in the incident fixture is healthy, proving a lane-only canary would have gone green", () => {
  const { findings } = runFixture("incident-2026-08-17-shared-ledger.json");
  const laneFailures = findings.filter((f) => f.scope === "lane" && f.state !== "PASS" && f.state !== "SKIP");
  assert.deepEqual(laneFailures, [], "the lanes were genuinely fine during the incident; only the ledger was wrong");
});

test("HEALTHY CONTROL: the same fixture with a real ledger passes everything and exits 0", () => {
  const { counts, findings } = runFixture("healthy.json");
  assert.equal(counts.fail, 0, `expected zero failures, got: ${findings.filter((f) => f.state === "FAIL").map((f) => f.message).join(" | ")}`);
  assert.equal(counts.error, 0, `expected zero blind checks, got: ${findings.filter((f) => f.state === "ERROR").map((f) => f.message).join(" | ")}`);
  assert.equal(counts.reduced, 0, `expected zero coverage gaps, got: ${findings.filter((f) => f.state === "REDUCED").map((f) => f.subject).join(", ")}`);
  assert.equal(codeOf(counts, findings), 0);
});

// ---------------------------------------------------------------------------------------------
// THE RING ASSERTION (the load-bearing security check)
// ---------------------------------------------------------------------------------------------

test("RING: a forbidden personal-legal room appearing in a cfo-lane room set is a P0 failure", () => {
  const { findings, counts } = runFixture("ring-violation-cfo-personal-legal.json", "observed");
  const ring = findings.find((f) => f.subject === "cfo" && f.check === "ring" && f.state === "FAIL");
  assert.ok(ring, "expected a ring FAILURE on the cfo lane");
  assert.equal(ring.severity, SEVERITY.P0);
  assert.match(ring.message, /legal-personal/);
  assert.match(ring.message, /legal-personal-memory/);
  assert.ok(counts.p0 >= 1);
  assert.equal(codeOf(counts, findings), 1);
});

test("RING: the SAME rooms on clo-personal are allowed, so the assertion is ring-aware and not name-matching", () => {
  const { findings } = runFixture("ring-violation-cfo-personal-legal.json", "observed");
  const personalFailures = findings.filter((f) => f.subject === "clo-personal" && f.state === "FAIL");
  assert.deepEqual(personalFailures, [], "clo-personal is inside the personal-legal ring and must not be flagged");
});

test("RING: a ring MEMBER gets the POSITIVE CONTROL from its membership, not from expected_rooms", () => {
  // A ring check that only asserted absence would go green if the personal rooms vanished from the
  // estate entirely -- a different outage wearing the same green light. The presence obligation is now
  // derived from ring membership, so every FUTURE ring member inherits the positive control
  // automatically instead of depending on somebody remembering to list the rooms in expected_rooms.
  const v = assertRing({
    lane: "clo-personal", roomsSearched: ["memory-exec", "commons-company-journal", "legal-company"],
    forbiddenRooms: [], personalLegalRooms: CONFIG.personal_legal_rooms, ringMember: true,
  });
  assert.equal(v.state, "FAIL");
  assert.match(v.message, /positive control failing/);
  assert.match(v.message, /legal-personal/);
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

test("RING: an unreadable room list is ERROR on the ring check -- blindness, never a skip", () => {
  const v = assertRing({ lane: "cfo", roomsSearched: null, forbiddenRooms: ["legal-personal"], personalLegalRooms: ["legal-personal"] });
  assert.equal(v.state, "ERROR");
  assert.match(v.message, /RING CHECK COULD NOT RUN/);
});

// ---------------------------------------------------------------------------------------------
// CONNECTOR-SURFACE MISCLASSIFICATION
// ---------------------------------------------------------------------------------------------

test("TOOL FLOOR: a privileged lane offered ~11 tools instead of ~1000 fails the floor", () => {
  const { findings, counts } = runFixture("connector-surface-misclassification.json", "observed");
  const floor = findings.find((f) => f.check === "tool_floor" && f.state === "FAIL");
  assert.ok(floor, "expected a tool_floor FAILURE");
  assert.match(floor.message, /11 is BELOW its floor/);
  assert.ok(counts.fail >= 1);
});

test("CONNECTOR SURFACE: the same fixture also fails the connector_surface assertion", () => {
  const { findings } = runFixture("connector-surface-misclassification.json", "observed");
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

test("DIAGNOSTICS: the captured cause is READ, not discarded for a generic guess", () => {
  // obs.toolCountError / probeError / probeShapeError / brainSearchError were all WRITE-ONLY: the
  // collector recorded the real reason and every ERROR message then stated a plausible generic cause
  // instead. An operator handed a confidently wrong cause looks in the wrong place.
  const laneCfg = CONFIG.lanes.find((l) => l.lane === "cto");
  const { findings } = laneOnly(laneCfg, {
    lane: "cto", credsPresent: true, tokenMinted: true,
    toolCountError: "tools/list HTTP 502", probeError: "catalog_probe HTTP 403", brainSearchError: "brain_search HTTP 429",
  });
  const msg = (c) => findings.find((f) => f.check === c).message;
  assert.match(msg("tool_floor"), /tools\/list HTTP 502/);
  assert.match(msg("connector_surface"), /catalog_probe HTTP 403/);
  assert.match(msg("caller_agent"), /catalog_probe HTTP 403/);
  assert.match(msg("room_set"), /brain_search HTTP 429/);
  assert.match(msg("ring"), /brain_search HTTP 429/);
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

test("LEDGER: an unreadable ledger still produces ALL of its planned verdicts, as ERRORs", () => {
  // An unread block must not silently shrink the number of checks that ran; that is how "the block was
  // evaluated" used to be reported as a coverage PASS while the block itself had errored.
  const out = assertLedger({ error: "memory_team HTTP 503", minSharedEntries: 25, minAgents: 5 });
  assert.deepEqual(out.map((f) => f.check).sort(), ["ledger_agent_floor", "ledger_entry_floor"]);
  assert.ok(out.every((f) => f.state === "ERROR"));
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

test("TOKEN MINT: an OPTIONAL lane whose provisioned credential stops working is still a hard FAIL", () => {
  // optional:true means only "an ABSENT credential is benign". A credential that exists and no longer
  // mints is a real break on any lane, and the registry note that claimed otherwise was false.
  const laneCfg = { ...CONFIG.lanes.find((l) => l.lane === "cro"), optional: true };
  const { findings, counts } = laneOnly(laneCfg, { lane: "cro", credsPresent: true, tokenMinted: false, mintError: "HTTP 401 (invalid_client)" });
  assert.equal(findings.find((f) => f.check === "token_mint").state, "FAIL");
  assert.equal(exitCode({ assertionFailures: counts.fail, checkErrors: counts.error, coverageReductions: counts.reduced, verdictsProduced: 1 }), 1);
});

test("ROOM SET: an unreadable rooms_searched is ERROR -- a ring assertion that could not run never passes", () => {
  const v = assertExpectedRooms({ lane: "cfo", roomsSearched: null, expectedRooms: ["memory-exec"] });
  assert.equal(v.state, "ERROR");
  assert.match(v.message, /COULD NOT RUN/);
});

test("ROOM SET: a lane whose mint failed produces NO synthesized downstream passes", () => {
  const laneCfg = CONFIG.lanes.find((l) => l.lane === "cfo");
  const { findings } = laneOnly(laneCfg, { lane: "cfo", credsPresent: true, tokenMinted: false, mintError: "HTTP 401" });
  assert.equal(findings.filter((f) => f.state === "PASS").length, 0, "nothing downstream actually ran, so nothing may report PASS");
  assert.equal(findings.find((f) => f.check === "token_mint").state, "FAIL");
  for (const c of LANE_CHECKS.filter((x) => x !== "token_mint")) {
    const v = findings.find((f) => f.check === c);
    assert.equal(v.state, "ERROR", `${c} must be recorded as blocked, not omitted and not passed`);
    assert.match(v.message, /did NOT run/);
  }
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

test("PLATFORM: every row yields exactly ONE verdict, so plan and produced line up one-to-one", () => {
  for (const p of CONFIG.platforms) {
    const obs = p.kind === "health" ? { status: "ok", toolCount: 1008 } : { status: p.expect_status, headers: ["www-authenticate"] };
    const out = evaluatePlatform(p, obs);
    assert.equal(out.length, 1, `platform ${p.name} produced ${out.length} verdicts`);
    assert.equal(checkId(out[0]), `platform/${p.name}/${p.kind}`);
  }
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
  const { findings } = runFixture("ring-violation-cfo-personal-legal.json", "observed");
  for (const f of findings) {
    assert.equal(typeof f.message, "string");
    assert.ok(f.message.length < 700, "verdict messages stay short and structured, never a content dump");
  }
});

// ---------------------------------------------------------------------------------------------
// ROUND 2 -- THE REAL catalog_probe SHAPE (kept: both reviewers verified this and the numbers matched)
// ---------------------------------------------------------------------------------------------

test("PROBE SHAPE: probeIdentity extracts BOTH identity fields from the REAL nested wire shape", () => {
  const f = fixture("blocker1-probe-real-nested-shape.json");
  const unwrapped = f.raw_probe_payload.result;   // exactly as callTool() hands it over
  const id = probeIdentity(unwrapped);
  assert.equal(id.shapeOk, true);
  assert.equal(id.callerAgent, "cto", "caller_agent lives at request_context.caller_agent");
  assert.equal(id.connectorSurface, true, "is_connector_surface lives at request_context.is_connector_surface");
});

test("PROBE SHAPE: probeIdentity also handles the still-enveloped shape (result.request_context)", () => {
  const f = fixture("blocker1-probe-real-nested-shape.json");
  const id = probeIdentity(f.raw_probe_payload);
  assert.equal(id.callerAgent, "cto");
  assert.equal(id.connectorSurface, true);
});

test("PROBE SHAPE: the round-1 TOP-LEVEL shape yields nothing -- the old accessor read null forever", () => {
  const f = fixture("blocker1-probe-real-nested-shape.json");
  const unwrapped = f.raw_probe_payload.result;
  assert.equal(unwrapped.is_connector_surface ?? unwrapped.connector_surface ?? null, null);
  assert.equal(unwrapped.caller_agent ?? null, null);
});

test("PROBE SHAPE: a successful probe missing the fields is ERROR, never a silent skip or a pass", () => {
  const noCtx = probeIdentity({ build_tag: "x", tool_registry_count: 1008 });
  assert.equal(noCtx.shapeOk, false);
  assert.equal(noCtx.callerAgent, undefined, "absent must be undefined, distinguishable from observed-false");
  assert.equal(noCtx.connectorSurface, undefined);
  assert.equal(assertCallerAgent({ lane: "cto", callerAgent: null }).state, "ERROR");
  assert.equal(assertConnectorSurface({ lane: "cto", connectorSurface: null, expectConnectorSurface: false }).state, "ERROR");
});

test("PROBE SHAPE: an observed-false connector_surface is NOT treated as a missing field", () => {
  const id = probeIdentity({ request_context: { caller_agent: "cfo", is_connector_surface: false } });
  assert.equal(id.connectorSurface, false, "false is a VALUE; ?? must not collapse it to undefined");
  assert.equal(assertConnectorSurface({ lane: "cfo", connectorSurface: id.connectorSurface, expectConnectorSurface: false }).state, "PASS");
});

// =============================================================================================
// ROUND 3 -- THE STRUCTURAL PROPERTIES
// =============================================================================================

// ---------------------------------------------------------------------------------------------
// PROPERTY 1: the check set is DERIVED, complete, and never config-conditional
// ---------------------------------------------------------------------------------------------

test("PLAN: the derived check set is non-empty and COMPLETE for every lane in the registry", () => {
  const plan = planChecks(CONFIG);
  assert.ok(plan.size > 0, "an empty plan would make coverage vacuous");
  for (const laneCfg of CONFIG.lanes) {
    for (const c of LANE_CHECKS) {
      assert.ok(plan.has(`lane/${laneCfg.lane}/${c}`), `lane ${laneCfg.lane} is missing planned check ${c}`);
    }
  }
  for (const c of LEDGER_CHECKS) assert.ok(plan.has(`ledger/shared-exec-ledger/${c}`));
  for (const c of RETRIEVAL_CHECKS) assert.ok(plan.has(`retrieval/retrieval:${CONFIG.retrieval.index}/${c}`));
  for (const p of CONFIG.platforms) assert.ok(plan.has(`platform/${p.name}/${p.kind}`), `platform ${p.name} is not planned`);
  assert.equal(plan.size, CONFIG.lanes.length * LANE_CHECKS.length + LEDGER_CHECKS.length + RETRIEVAL_CHECKS.length + CONFIG.platforms.length);
});

test("PLAN: the plan is computed from STRUCTURE, so stripping every per-lane VALUE cannot shrink it", () => {
  // The whole inversion in one assertion: a registry whose rows carry nothing but a lane name still
  // plans the identical check set. Values can be missing (and that is an ERROR); checks cannot.
  const stripped = { ...CONFIG, lanes: CONFIG.lanes.map((l) => ({ lane: l.lane })) };
  assert.deepEqual([...planChecks(stripped)].sort(), [...planChecks(CONFIG)].sort());
});

test("PLAN: every lane produces EXACTLY its planned verdicts, whatever the observation", () => {
  const laneCfg = CONFIG.lanes.find((l) => l.lane === "cfo");
  const observations = [
    undefined,                                                               // collector never reached it
    { lane: "cfo", credsPresent: false, tokenMinted: false },                // unprovisioned
    { lane: "cfo", credsPresent: true, tokenMinted: false },                 // mint broken
    { lane: "cfo", credsPresent: true, tokenMinted: true },                  // minted, nothing else readable
    healthyLaneObs("cfo", ["memory-exec"]),                                  // healthy-ish
  ];
  for (const obs of observations) {
    const out = evaluateLane(laneCfg, obs, CONFIG);
    assert.deepEqual(out.map((f) => f.check), LANE_CHECKS, `observation ${JSON.stringify(obs)} produced the wrong verdict set`);
  }
});

test("INSTANCE C: a MISSING per-lane config key is an ERROR, never a comparison that passes", () => {
  // Round-2 behaviour, reproduced by execution before this fix: with min_tool_count and
  // expect_connector_surface deleted from the cto row and the lane degraded to the exact
  // connector-misclassification signature (11 tools, connector_surface true), the run printed
  //   PASS lane/cto/tool_floor: lane cto: tool_count 11 >= floor undefined
  // with connector_surface absent entirely, and exited 0. `11 < undefined` is false.
  const bare = { lane: "cto", optional: false, expected_rooms: [], forbidden_rooms: [] }; // keys deleted
  const degraded = { lane: "cto", credsPresent: true, tokenMinted: true, toolCount: 11, connectorSurface: true, callerAgent: "cto", roomsSearched: ["memory-exec"] };
  const { findings } = laneOnly(bare, degraded);
  const floor = findings.find((f) => f.check === "tool_floor");
  const conn = findings.find((f) => f.check === "connector_surface");
  assert.equal(floor.state, "ERROR", "an absent floor must REFUSE to compare, not pass");
  assert.match(floor.message, /REFUSED rather than compared/);
  assert.equal(conn.state, "ERROR", "an absent expectation must not delete the assertion");
  assert.ok(!findings.some((f) => f.state === "PASS" && /floor undefined/.test(f.message)), "no PASSING verdict may ever render an absent value as part of a comparison");
});

test("INSTANCE C: validateRegistry NAMES every missing required key on the row", () => {
  const bare = { ...CONFIG, lanes: [{ lane: "cto", optional: false, expected_rooms: [], forbidden_rooms: [] }], known_internal_lanes: ["cto"] };
  const msgs = validateRegistry(bare).map((f) => f.message).join(" | ");
  assert.match(msgs, /MISSING REQUIRED KEY "min_tool_count"/);
  assert.match(msgs, /MISSING REQUIRED KEY "expect_connector_surface"/);
  assert.ok(validateRegistry(bare).every((f) => f.state === "ERROR"));
});

test("INSTANCE C: every numeric comparison in the file REFUSES a non-number rather than evaluating it", () => {
  assert.equal(assertToolFloor({ lane: "x", toolCount: 11, minToolCount: undefined }).state, "ERROR");
  assert.equal(assertLedger({ sharedEntryCount: 1, agents: ["a"], minSharedEntries: undefined, minAgents: undefined })[0].state, "ERROR");
  assert.equal(assertLedgerFreshness({ newestTs: "2020-01-01T00:00:00Z", maxAgeH: undefined }).state, "ERROR");
  assert.equal(assertRetrieval({ index: "i", mode: "hybrid", resultCount: 0, minResults: undefined })[0].state, "ERROR");
  assert.equal(evaluatePlatform({ name: "h", kind: "health", min_tool_count: undefined }, { status: "ok", toolCount: 1 })[0].state, "ERROR");
});

test("INSTANCE C: the SHIPPED registry passes its own validation", () => {
  assert.deepEqual(validateRegistry(CONFIG).map((f) => f.message), []);
});

// ---------------------------------------------------------------------------------------------
// PROPERTY 2: an absent observation is an ERROR by construction, and the COLLECTOR never opts out
// ---------------------------------------------------------------------------------------------

/** A fake transport in the exact shape observeLane() calls: bearer / toolCount / call. */
function fakeIo({ rooms = ["memory-exec"], lane = "cro", tools = 1008, connector = false, brainThrows = null } = {}) {
  const calls = [];
  return {
    calls,
    io: {
      bearer: async () => "tok",
      toolCount: async () => tools,
      call: async (_b, name) => {
        calls.push(name);
        if (name === "catalog_probe") return { request_context: { caller_agent: lane, is_connector_surface: connector } };
        if (name === "brain_search") { if (brainThrows) throw new Error(brainThrows); return { rooms_searched: rooms }; }
        return {};
      },
    },
  };
}

test("INSTANCE B (COLLECTOR): the room list is ALWAYS collected, whatever the row says", async () => {
  // Driven through the REAL collector, not a hand-built observation. Round 2's lock fed the classifier a
  // populated roomsSearched -- a state the live collector could NOT produce with the flag set -- so it
  // passed while a live P0 leak stayed invisible. Here the retired flag is forced on and the collector's
  // own output is asserted.
  const rows = [
    { lane: "cro", expects_brain_search: false },
    { lane: "cro", expects_brain_search: true },
    { lane: "cro" },
  ];
  for (const row of rows) {
    const { io, calls } = fakeIo({ rooms: ["memory-exec", "legal-personal"] });
    const obs = await (observeLane(row, io));
    assert.ok(calls.includes("brain_search"), `row ${JSON.stringify(row)}: the collector MUST call brain_search`);
    assert.deepEqual(obs.roomsSearched, ["memory-exec", "legal-personal"], "and MUST record what it found");
  }
});

test("INSTANCE B (END TO END): a live leak on a lane carrying the retired flag is a P0, not a SKIP", async () => {
  // Collector output -> classifier, with no hand-authored observation anywhere in the chain.
  const row = { ...CONFIG.lanes.find((l) => l.lane === "cro"), expects_brain_search: false };
  const { io } = fakeIo({ rooms: ["memory-exec", "commons-company-journal", "legal-personal"] });
  const obs = await (observeLane(row, io));
  const { findings, counts } = laneOnly(row, obs);
  const ring = findings.find((f) => f.check === "ring");
  assert.equal(ring.state, "FAIL", "the ring assertion MUST run and MUST fail");
  assert.equal(ring.severity, SEVERITY.P0);
  assert.match(ring.message, /legal-personal/);
  assert.notEqual(ring.state, "SKIP");
  assert.ok(counts.p0 >= 1);
});

test("INSTANCE B: the retired expects_brain_search key is REFUSED by validation, not silently ignored", () => {
  const cfg = { ...CONFIG, lanes: [{ ...CONFIG.lanes[0], expects_brain_search: false }], known_internal_lanes: [CONFIG.lanes[0].lane] };
  const v = validateRegistry(cfg).find((f) => /RETIRED key/.test(f.message));
  assert.ok(v, "re-adding the flag must be reported, so it cannot look effective while doing nothing");
  assert.equal(v.state, "ERROR");
});

test("INSTANCE B (config half): the shipped registry declares expects_brain_search nowhere", () => {
  assert.deepEqual(CONFIG.lanes.filter((l) => "expects_brain_search" in l).map((l) => l.lane), []);
});

test("INSTANCE B LOCK: no lane outside the ring can have its forbidden-room check suppressed", async () => {
  // Exhaustive over the shipped registry, driven through the collector each time.
  for (const laneCfg of CONFIG.lanes) {
    if (isPersonalRingMember(laneCfg.lane, CONFIG)) continue;
    const row = { ...laneCfg, optional: false, expects_brain_search: false };
    const { io } = fakeIo({ lane: laneCfg.lane, rooms: ["memory-exec", ...CONFIG.personal_legal_rooms] });
    const obs = await (observeLane(row, io));
    const { findings } = laneOnly(row, obs);
    const ring = findings.find((f) => f.check === "ring");
    assert.equal(ring.state, "FAIL", `lane ${laneCfg.lane}: the ring assertion must run`);
    assert.equal(ring.severity, SEVERITY.P0, `lane ${laneCfg.lane}: a personal-legal leak is P0`);
  }
});

test("BLINDNESS: a lane with no brain-read tool is an honest ERROR carrying the real reason", async () => {
  // The replacement for the old vacuous SKIP. "I could not determine this lane's room set" is blindness
  // on the most important assertion here, so it is loud, and it names what actually happened.
  const { io } = fakeIo({ brainThrows: "brain_search: tool_not_found" });
  const obs = await (observeLane({ lane: "cro" }, io));
  assert.equal(obs.brainSearchError, "brain_search: tool_not_found");
  const v = assertRing({ lane: "cro", roomsSearched: obs.roomsSearched, forbiddenRooms: ["legal-personal"], personalLegalRooms: ["legal-personal"], detail: obs.brainSearchError });
  assert.equal(v.state, "ERROR");
  assert.match(v.message, /tool_not_found/);
});

test("BLINDNESS: a configured lane the collector never reached is ERROR, not a fabricated mint FAILURE", () => {
  const laneCfg = CONFIG.lanes.find((l) => l.lane === "cfo");
  const { findings } = laneOnly(laneCfg, undefined);
  assert.equal(findings.length, LANE_CHECKS.length);
  assert.ok(findings.every((f) => f.state === "ERROR"));
  assert.match(findings[0].message, /no observation was produced/);
});

// ---------------------------------------------------------------------------------------------
// PROPERTY 3: coverage is plan-minus-produced, with no floor for config to edit down
// ---------------------------------------------------------------------------------------------

test("INSTANCE A: dropping the platform observations is LOUD and named, never an exit-0 OK", () => {
  // Round-2 behaviour, reproduced by execution before this fix: --no-platforms silently deleted all five
  // platform checks, including the P0 unauthenticated-POST-/mcp front door and the forged-M365-token
  // refusal, and the run printed pass 33 / FAIL 0 / EXIT 0. assertCoverage enumerated only lanes, ring,
  // ledger and retrieval -- it had no platform term at all, so nothing anywhere noticed.
  const obs = fixture("healthy.json");
  obs.platforms = {};
  const { findings, counts } = evaluateRun(CONFIG, obs, { now: Date.parse(obs._now) });
  assert.equal(counts.fail, 0, "nothing here is broken -- which is exactly why this used to exit 0");
  assert.equal(counts.error, CONFIG.platforms.length, "every dropped platform check must be reported");
  for (const p of CONFIG.platforms) {
    const v = findings.find((f) => f.scope === "platform" && f.subject === p.name && f.check === p.kind);
    assert.ok(v, `${p.name} must still produce a verdict`);
    assert.equal(v.state, "ERROR", `${p.name} must be ERROR, not omitted`);
  }
  assert.notEqual(codeOf(counts, findings), 0, "a run that skipped the front-door check is not a pass");
  assert.equal(codeOf(counts, findings), 2);
});

test("INSTANCE A: the P0 front door specifically cannot be dropped without a named verdict", () => {
  const obs = fixture("healthy.json");
  delete obs.platforms.unauthenticated_mcp_refused;
  const { findings, counts } = evaluateRun(CONFIG, obs, { now: Date.parse(obs._now) });
  const v = findings.find((f) => f.scope === "platform" && f.subject === "unauthenticated_mcp_refused");
  assert.ok(v, "the unauthenticated front door going unchecked must be reported by name");
  assert.equal(v.state, "ERROR");
  assert.match(v.message, /CHECK COULD NOT RUN/);
  assert.notEqual(codeOf(counts, findings), 0);
});

test("INSTANCE A: the PLAN is what makes it impossible -- every planned check produces a verdict", () => {
  // The structural claim, asserted directly: whatever the collector did or did not gather, the set of
  // check ids that produced a verdict covers the whole derived plan. Nothing can go missing quietly;
  // the most a narrowing switch can do is change a verdict's STATE, never its existence.
  const obs = fixture("healthy.json");
  obs.platforms = {};
  delete obs.ledger;
  delete obs.retrieval;
  obs.lanes = {};
  const { findings, counts, planned } = evaluateRun(CONFIG, obs, { now: Date.parse(obs._now) });
  const produced = new Set(findings.map(checkId));
  const unanswered = [...planned].filter((id) => !produced.has(id));
  assert.deepEqual(unanswered, [], "a maximally-narrowed run still answers every planned check");
  assert.equal(counts.reduced, 0, "so the coverage backstop has nothing left to report");
  assert.equal(counts.answered, counts.planned);
  assert.equal(codeOf(counts, findings), 2, "and every one of those answers is BLIND, which is not a pass");
});

test("COVERAGE: an unarmed platform-only run MUST NOT exit 0, and names every unchecked subject", () => {
  const { findings, counts } = runFixture("blocker3-unarmed-platform-only.json");
  assert.equal(counts.fail, 0, "nothing in this fixture is broken -- every platform surface is healthy");
  assert.ok(counts.error > 0, "round 1 exited 0 here having checked no lane, no ring and no ledger");
  assert.equal(codeOf(counts, findings), 2);
  const blind = findings.filter((f) => f.state === "ERROR").map(checkId);
  for (const laneCfg of CONFIG.lanes) assert.ok(blind.includes(`lane/${laneCfg.lane}/ring`), `lane ${laneCfg.lane}'s ring must be named as unchecked`);
  for (const c of LEDGER_CHECKS) assert.ok(blind.includes(`ledger/shared-exec-ledger/${c}`));
  for (const c of RETRIEVAL_CHECKS) assert.ok(blind.includes(`retrieval/retrieval:${CONFIG.retrieval.index}/${c}`));
});

test("COVERAGE: there is NO coverage floor left in the registry for config to edit downward", () => {
  // The old lock compared config to config (min_lanes_evaluated === required.length), so flipping a lane
  // to optional AND lowering the floor in one edit stayed green while removing real coverage.
  assert.equal(CONFIG.coverage, undefined, "a hand-maintained floor block must not come back");
  const flat = JSON.stringify(CONFIG);
  for (const k of ["min_lanes_evaluated", "min_ring_assertions", "require_ledger", "require_retrieval", "require_hybrid"]) {
    assert.ok(!new RegExp(`"${k}"`).test(flat), `the registry must not reintroduce the deletable key ${k}`);
  }
});

test("COVERAGE: assertCoverage names each gap and passes only when the plan is fully answered", () => {
  const plan = new Set(["a/b/c", "d/e/f"]);
  assert.deepEqual(assertCoverage({ planned: plan, produced: new Set(["a/b/c", "d/e/f"]) }).map((f) => f.state), ["PASS"]);
  const gaps = assertCoverage({ planned: plan, produced: new Set(["a/b/c"]) });
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].state, "REDUCED");
  assert.equal(gaps[0].subject, "d/e/f");
});

test("COVERAGE: the ANSWERED count can never exceed the plan it is measured against", () => {
  // config-scope findings are real verdicts but were never planned; counting them made the printed
  // coverage ratio read above 100%, which is not a coverage number.
  const bad = { ...CONFIG, lanes: CONFIG.lanes.map((l) => ({ ...l, expects_brain_search: false })) };
  const { counts } = evaluateRun(bad, fixture("healthy.json"), { now: Date.parse(fixture("healthy.json")._now) });
  assert.ok(counts.answered <= counts.planned, `answered ${counts.answered} > planned ${counts.planned}`);
});

test("COVERAGE: a required lane going dark can no longer produce a green result", () => {
  const obs = fixture("healthy.json");
  delete obs.lanes.clo;
  delete obs.lanes["clo-personal"];
  const { findings, counts } = evaluateRun(CONFIG, obs, { now: Date.parse(obs._now) });
  assert.ok(counts.error >= 1, "the unreached lanes are blind, not healthy");
  assert.notEqual(codeOf(counts, findings), 0);
});

test("COVERAGE: the two ring numbers are reported separately, so neither overstates the other", () => {
  // One combined counter used to add ring MEMBERS (clo-personal, exec), whose forbidden set is empty,
  // to the forbidden-room total -- making the deny-side number read one larger than the estate it had
  // actually checked. Members prove the ALLOW path; non-members prove the DENY path.
  const { counts } = runFixture("healthy.json");
  const observedRing = CONFIG.lanes.filter((l) => isPersonalRingMember(l.lane, CONFIG) && fixture("healthy.json").lanes[l.lane]?.tokenMinted).length;
  assert.equal(counts.ringAllowLanesChecked, observedRing);
  assert.ok(counts.ringDenyLanesChecked > 0);
  assert.equal(counts.ringAllowLanesChecked + counts.ringDenyLanesChecked, counts.lanesEvaluated);
});

// ---------------------------------------------------------------------------------------------
// INSTANCE D: the lane roster must be COMPLETE against the gateway
// ---------------------------------------------------------------------------------------------

test("INSTANCE D: the shipped registry has a row for EVERY lane the gateway knows", () => {
  // cco -- a full EXEC_RING member (src/tools/kb/search-privileged.ts: EXEC_RING = cfo, clo,
  // clo-personal, cpo, cco, exec) carrying finance-MNPI and company-legal privileged read -- had no row
  // at all through rounds 1 and 2, while SKILL.md claimed coverage of "every lane on the MCP gateway".
  const rows = CONFIG.lanes.map((l) => l.lane);
  for (const lane of CONFIG.known_internal_lanes) {
    assert.ok(rows.includes(lane), `gateway lane ${lane} has no row in the registry, so nothing watches it`);
  }
  assert.ok(CONFIG.known_internal_lanes.includes("cco"), "cco is the lane this test exists for");
  assert.ok(rows.includes("cco"));
});

test("INSTANCE D: the declared roster matches the gateway's KNOWN_INTERNAL_LANES verbatim", () => {
  // Read from src/config/lane-toolsets.ts on 2026-08-18. Pinned literally so a gateway-side change makes
  // this test fail loudly rather than leaving the registry quietly behind the estate.
  assert.deepEqual([...CONFIG.known_internal_lanes].sort(),
    ["cco", "cfo", "clo", "clo-personal", "coo", "cpo", "cro", "cto", "developer", "exec"]);
});

test("INSTANCE D: a lane missing from the registry is an ERROR, not silence", () => {
  const without = { ...CONFIG, lanes: CONFIG.lanes.filter((l) => l.lane !== "cco") };
  const v = validateRegistry(without).find((f) => f.check === "lane_completeness");
  assert.ok(v, "a gateway lane with no row must be reported");
  assert.equal(v.state, "ERROR");
  assert.match(v.message, /cco/);
  assert.match(v.message, /not "passing", it is invisible/);
});

test("INSTANCE D: cco is watched with the deny-side ring assertion its EXEC_RING membership requires", () => {
  const cco = CONFIG.lanes.find((l) => l.lane === "cco");
  assert.ok(!isPersonalRingMember("cco", CONFIG), "cco is in EXEC_RING but NOT in PERSONAL_LEGAL_RING");
  for (const room of CONFIG.personal_legal_rooms) assert.ok(forbiddenRoomsFor(cco, CONFIG).includes(room));
  const { findings } = laneOnly(cco, healthyLaneObs("cco", ["memory-exec", "legal-personal"]));
  const ring = findings.find((f) => f.check === "ring");
  assert.equal(ring.state, "FAIL");
  assert.equal(ring.severity, SEVERITY.P0);
});

// ---------------------------------------------------------------------------------------------
// GAP 1 -- A FROZEN-BUT-READABLE LEDGER
// ---------------------------------------------------------------------------------------------

test("GAP 1: a 300-entry / 8-lane ledger with a stale newest timestamp MUST FAIL", () => {
  const { findings, counts } = runFixture("gap1-ledger-frozen-but-large.json", "observed");
  const stale = findings.find((f) => f.check === "ledger_freshness" && f.state === "FAIL");
  assert.ok(stale, "a frozen ledger must fail on AGE even though every size floor passes");
  assert.match(stale.message, /ABOVE the 72h SLO/);
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

test("GAP 1: an unreadable ledger reports freshness as blocked by the SAME cause, not a second guess", () => {
  const v = assertLedgerFreshness({ newestTs: null, maxAgeH: 72, error: "memory_team HTTP 503" });
  assert.equal(v.state, "ERROR");
  assert.match(v.message, /memory_team HTTP 503/, "one cause, stated once, on every verdict it blocked");
});

// ---------------------------------------------------------------------------------------------
// GAPS 2 + 3 -- STALE/EMPTY ROOM, AND SILENT KEYWORD-ONLY DEGRADATION
// ---------------------------------------------------------------------------------------------

test("GAP 2: a room that resolved but returned zero results FAILS, though every room-set check passes", () => {
  const { findings, counts } = runFixture("gap2-3-retrieval-degraded.json", "observed");
  assert.deepEqual(findings.filter((f) => f.check === "room_set" && f.state === "FAIL"), [], "the room set itself is fine -- that is the point");
  const empty = findings.find((f) => f.check === "room_results" && f.state === "FAIL");
  assert.ok(empty, "zero results from a broad query must fail");
  assert.match(empty.message, /empty, frozen, or mid-reindex/);
  assert.equal(codeOf(counts, findings), 1);
});

test("GAP 3: mode 'keyword' instead of 'hybrid' FAILS -- the embeddings half died silently", () => {
  const { findings } = runFixture("gap2-3-retrieval-degraded.json", "observed");
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

test("GAP 3: hybrid can no longer be switched off by config -- the check has no opt-out parameter", () => {
  const out = assertRetrieval({ index: "memory-exec", mode: "keyword", resultCount: 3, minResults: 1, requireHybrid: false });
  assert.equal(out.find((f) => f.check === "retrieval_mode").state, "FAIL", "an ignored legacy flag must not resurrect the opt-out");
});

// ---------------------------------------------------------------------------------------------
// THE INCIDENT LOCK MUST SURVIVE EVERY CHANGE ABOVE
// ---------------------------------------------------------------------------------------------

test("REGRESSION: after all of the above, the incident fixture STILL fails on the ledger while its lanes pass", () => {
  const { findings, counts } = runFixture("incident-2026-08-17-shared-ledger.json");
  const ledgerFail = findings.find((f) => f.check === "ledger_entry_floor" && f.state === "FAIL");
  assert.ok(ledgerFail, "the whole reason this canary exists");
  assert.match(ledgerFail.message, /shared_entry_count is 1/);
  assert.deepEqual(findings.filter((f) => f.scope === "lane" && f.state === "FAIL"), [], "a lane-only canary would still have gone green");
  assert.equal(counts.reduced, 0, "and it fails on the LEDGER, not on a coverage technicality");
  assert.equal(counts.error, 0, "nor on blindness");
  assert.equal(codeOf(counts, findings), 1);
});
