// assertions.mjs -- the PURE assertion core of the per-lane / per-platform health canary.
//
// Deliberately ZERO imports and ZERO I/O: every function here takes an already-collected observation
// and returns a verdict record. That is what makes the whole thing unit-testable against fixtures
// (including the fixture reproducing the 2026-08-17/18 shared-ledger incident, see assertLedger below)
// without a network, a credential, or a live gateway. platform-canary.mjs does all the talking to the
// world and hands the results in here; this file decides what is healthy.
//
// =====================================================================================================
// THE GOVERNING RULE, ROUND 3: THE SET OF CHECKS IS DERIVED, NOT CONFIGURED.
// =====================================================================================================
// Rounds 1 and 2 each fixed individual silent-pass holes and each regenerated more of the same shape.
// Three rounds, one recurring CLASS, stated plainly:
//
//     THE EXISTENCE OF A CHECK WAS DETERMINED BY DATA, AND ABSENT DATA RENDERED AS A BENIGN OUTCOME.
//
// Every instance is that sentence:
//   A. `--no-platforms` dropped all five platform observations. evaluateRun() `continue`d past each
//      absent observation, emitted nothing, and the old assertCoverage() enumerated only lanes/ring/
//      ledger/retrieval -- it had no platform term at all. The P0 unauthenticated-front-door check
//      vanished and the run printed OK.
//   B. `expects_brain_search:false` on a lane made the COLLECTOR skip the brain_search call, so
//      roomsSearched was never produced, so the classifier took a vacuous-SKIP branch. Round 2 made the
//      forbidden half unconditional inside the pure function and locked it with a test -- but the test
//      supplied roomsSearched POPULATED, a state the live collector could not produce when the flag was
//      set. The test blessed a fiction while a live P0 leak stayed invisible.
//   C. Omitting `min_tool_count` made the floor comparison `11 < undefined` -> false -> "PASS ...
//      tool_count 11 >= floor undefined". Omitting `expect_connector_surface` deleted that assertion
//      with no record at all. A failure rendered as a plausible value, inside the monitor built to catch
//      exactly that.
//   D. The `cco` lane -- a full EXEC_RING member carrying finance-MNPI and company-legal privileged read
//      -- simply had no row, while the doc claimed coverage of "every lane on the MCP gateway".
//
// Patching four more instances would produce a fourth round. So the ARCHITECTURE is inverted instead,
// on three properties. Each is a required OUTCOME; the mechanism is described where it lives.
//
//   1. CHECKS ARE DERIVED AND MANDATORY, NEVER CONFIG-CONDITIONAL.
//      planChecks() computes, from lane IDENTITY and the registry's structure ALONE and BEFORE any
//      observation exists, the complete set of check ids that MUST produce a verdict this run. Config
//      supplies VALUES (a floor number, an expected room list); it can never decide whether a check
//      EXISTS. A missing required VALUE is an ERROR (validateRegistry() plus a hard type refusal inside
//      each comparison helper), never a comparison that quietly passes. See numeric() below: it refuses
//      a non-number outright, so `11 < undefined` can never be evaluated again.
//
//   2. AN ABSENT OBSERVATION IS AN ERROR BY CONSTRUCTION, NEVER A SKIP.
//      Every planned check produces a verdict. evaluateLane() emits ALL of LANE_CHECKS for every lane,
//      always -- when the mint fails or no observation exists, the downstream checks are emitted as
//      explicit blocked ERROR/SKIP verdicts naming the blocking cause, never omitted. The collector's
//      job is "gather everything the derived check set requires" and it consults NO config flag to
//      decide what to collect; `expects_brain_search` is deleted from the code and the registry, so
//      instance B has no switch left to flip.
//
//   3. COVERAGE IS ASSERTED AGAINST THE DERIVED PLAN, NOT A HAND-MAINTAINED FLOOR.
//      assertCoverage() diffs the planned check-id set against the ids that actually produced a verdict
//      and emits one REDUCED verdict per unproduced id, naming it. There is no `min_lanes_evaluated`
//      number for config to edit downward, and the plan covers PLATFORM checks, so instance A now
//      surfaces as five named REDUCED verdicts and exit 3.
//
// Four outcome classes, four messages, because they demand four different human responses:
//   PASS    -- the assertion ran and held
//   FAIL    -- the assertion ran and something is PROVEN broken            -> exit 1
//   ERROR   -- the check could not run at all; the sensor is BLIND         -> exit 2
//   REDUCED -- the run itself covered less than it must; coverage is thin  -> exit 3
// =====================================================================================================
//
// RING LAW: never put privileged CONTENT into a verdict message. Room NAMES, counts and allow/deny
// outcomes only. These messages land in CI logs and PostHog; a canary that leaks attorney-privileged
// text into a build log is worse than no canary at all.

/** P0 = a ring/exposure violation (privileged data reachable from a lane that must not see it, or the
 *  unauthenticated front door answering). P1 = a real but non-exposure health failure. */
export const SEVERITY = { P0: "P0", P1: "P1" };

const rec = (o) => ({ state: "PASS", severity: null, ...o });

/** Canonical identity of one check. The plan and the produced verdicts are compared on this string, so
 *  it is the single definition of "the same check" and both sides must derive it from here. */
export const checkId = (f) => `${f.scope}/${f.subject}/${f.check}`;

/** The six per-lane checks. EVERY lane in the registry produces EVERY one of these, every run. This
 *  array is the plan for the lane half; nothing may add a lane-scoped verdict outside it and nothing
 *  may omit one. `room_set` (expected rooms PRESENT) and `ring` (the personal-legal ring) are separate
 *  entries deliberately: round 1 and 2 both emitted `ring` only when a leak was found, so on a healthy
 *  run there was no ring verdict at all -- the existence of the security verdict depended on the
 *  outcome, which makes "was the ring watched tonight" unanswerable from the output. */
export const LANE_CHECKS = ["token_mint", "tool_floor", "connector_surface", "caller_agent", "room_set", "ring"];
export const LEDGER_CHECKS = ["ledger_entry_floor", "ledger_agent_floor", "ledger_freshness"];
export const RETRIEVAL_CHECKS = ["room_results", "retrieval_mode"];
export const LEDGER_SUBJECT = "shared-exec-ledger";
export const retrievalSubject = (index) => `retrieval:${index}`;

/**
 * THE DERIVED CHECK PLAN -- property 1 and property 3 in one function.
 *
 * Computed from the registry's STRUCTURE and each lane's IDENTITY only, with no observation in hand and
 * no per-row opt-out consulted. Whatever this returns MUST produce a verdict; anything that does not is
 * reported as REDUCED coverage by name. That is what makes "the check quietly did not exist" impossible:
 * a check cannot fail to exist, it can only fail to be answered, and an unanswered plan entry is loud.
 */
export function planChecks(config = {}) {
  const ids = new Set();
  for (const laneCfg of config.lanes || []) {
    for (const c of LANE_CHECKS) ids.add(`lane/${laneCfg.lane}/${c}`);
  }
  for (const c of LEDGER_CHECKS) ids.add(`ledger/${LEDGER_SUBJECT}/${c}`);
  for (const c of RETRIEVAL_CHECKS) ids.add(`retrieval/${retrievalSubject(config.retrieval?.index)}/${c}`);
  for (const p of config.platforms || []) ids.add(`platform/${p.name}/${p.kind}`);
  return ids;
}

/**
 * REGISTRY VALIDATION -- the other half of property 1.
 *
 * A required VALUE that is absent must be an ERROR here, loudly, rather than flowing into a comparison
 * that happens to evaluate false. Instance C is exactly one missing key producing
 * "PASS ... tool_count 11 >= floor undefined" for a lane that had been degraded to the 11-tool
 * external surface -- the precise misclassification this canary exists to catch, wearing a PASS.
 *
 * Also asserts REGISTRY COMPLETENESS: every lane the gateway actually knows about (declared in
 * `known_internal_lanes`, mirroring src/config/lane-toolsets.ts's KNOWN_INTERNAL_LANES) must have a row.
 * That is instance D's structural lock -- `cco`, a full EXEC_RING member holding finance-MNPI and
 * company-legal privileged read, had no row at all while the doc claimed every lane was covered.
 */
export function validateRegistry(config = {}) {
  const out = [];
  const err = (subject, check, message) => out.push(rec({ scope: "config", subject, check, state: "ERROR", message }));

  const REQUIRED_LANE_KEYS = [
    ["optional", (v) => typeof v === "boolean", "boolean"],
    ["min_tool_count", (v) => Number.isFinite(v), "finite number"],
    ["expect_connector_surface", (v) => typeof v === "boolean", "boolean"],
    ["expected_rooms", (v) => Array.isArray(v), "array"],
    ["forbidden_rooms", (v) => Array.isArray(v), "array"],
  ];
  for (const laneCfg of config.lanes || []) {
    const lane = laneCfg?.lane;
    if (typeof lane !== "string" || !lane) { err("registry", "lane_row", `a lane row has no "lane" name; it cannot be planned or checked at all.`); continue; }
    for (const [key, ok, kind] of REQUIRED_LANE_KEYS) {
      if (!ok(laneCfg[key])) {
        err(lane, "registry_row", `lane ${lane}: registry row is MISSING REQUIRED KEY "${key}" (expected a ${kind}, got ${JSON.stringify(laneCfg[key])}). This is an ERROR, never a skipped check: an absent floor or expectation used to flow straight into a comparison and render as a PASS ("tool_count 11 >= floor undefined"), which is a failure disguised as a plausible value inside the monitor built to catch exactly that.`);
      }
    }
    // A retired flag, actively refused. `expects_brain_search:false` used to make the COLLECTOR skip the
    // brain_search call entirely, so the room list was never produced and the ring assertion took a
    // vacuous-SKIP branch -- one config line deleting the P0 ring check on a live leak. The flag is gone
    // from the code; anyone re-adding it to a row gets told so rather than silently having it ignored.
    if ("expects_brain_search" in laneCfg) {
      err(lane, "registry_row", `lane ${lane}: registry row carries the RETIRED key "expects_brain_search". No code reads it. It once suppressed the personal-legal ring assertion for a lane by stopping the collector from ever gathering that lane's room list; the collector now always collects and the ring check is planned for every lane unconditionally. Remove the key.`);
    }
  }

  const known = config.known_internal_lanes;
  if (!Array.isArray(known) || !known.length) {
    err("registry", "lane_completeness", `the registry declares no "known_internal_lanes" list, so there is nothing to prove the lane roster is COMPLETE against. Mirror src/config/lane-toolsets.ts's KNOWN_INTERNAL_LANES here: without it a whole privileged lane can be missing and no check notices, which is how "cco" -- a full EXEC_RING member -- went unwatched.`);
  } else {
    const rows = new Set((config.lanes || []).map((l) => l?.lane));
    const missing = known.filter((l) => !rows.has(l));
    if (missing.length) err("registry", "lane_completeness", `the gateway knows lane(s) [${missing.join(", ")}] that have NO row in this registry, so nothing is watching them. A lane with no row is not "passing", it is invisible.`);
  }

  for (const [block, keys] of [["ledger", ["probe_lane", "min_shared_entries", "min_agents", "max_age_h"]], ["retrieval", ["probe_lane", "index", "query", "min_results"]]]) {
    const b = config[block];
    if (!b || typeof b !== "object") { err("registry", `${block}_block`, `the registry has no "${block}" block, so its checks have no values to assert against.`); continue; }
    for (const k of keys) if (b[k] === undefined || b[k] === null) err("registry", `${block}_block`, `the registry's "${block}" block is missing required key "${k}".`);
  }
  if (!Array.isArray(config.personal_legal_rooms) || !config.personal_legal_rooms.length) err("registry", "ring_policy", `the registry declares no "personal_legal_rooms", so the ring assertion has nothing to forbid and would pass vacuously on every lane.`);
  if (!Array.isArray(config.personal_legal_ring)) err("registry", "ring_policy", `the registry declares no "personal_legal_ring" array, so no lane can be distinguished as ring member or non-member.`);

  return out;
}

/** Is this lane a member of the personal-legal ring? Identity, derived from policy, never from the
 *  lane's own row -- a lane cannot admit itself to a ring. */
export function isPersonalRingMember(lane, policy = {}) {
  return (policy.personal_legal_ring || []).includes(lane);
}

/**
 * The forbidden-room set for a lane, derived from POLICY first and per-lane config second.
 *
 * The personal-legal rooms are added to EVERY lane's forbidden set automatically unless the lane is a
 * member of the declared personal-legal ring. This is deliberate: if the prohibition lived only in each
 * lane's own `forbidden_rooms` array, then adding a new lane to the registry and forgetting to list the
 * two personal-legal rooms would silently create a lane with no ring assertion at all. Derived-by-
 * default means a new lane is born forbidden and must be explicitly named in the ring to be allowed.
 */
export function forbiddenRoomsFor(laneCfg, policy = {}) {
  const personal = policy.personal_legal_rooms || [];
  const set = new Set(laneCfg.forbidden_rooms || []);
  if (isPersonalRingMember(laneCfg.lane, policy)) for (const r of personal) set.delete(r);
  else for (const r of personal) set.add(r);
  return [...set];
}

/**
 * Hard type refusal for every numeric comparison in this file.
 *
 * `11 < undefined` is false, so an absent floor used to render as "PASS ... 11 >= floor undefined".
 * Rather than trusting every future caller to have validated its config first, the comparison itself
 * refuses a non-number, so the class cannot come back through a code path that skipped validation.
 */
function numeric(v) { return typeof v === "number" && Number.isFinite(v); }

// ---------------------------------------------------------------------------------------------
// PER-LANE ASSERTIONS. Each returns exactly ONE verdict for exactly one planned check id.
// ---------------------------------------------------------------------------------------------

/** A token minted, or it did not. A lane that was never provisioned is a SKIP, not a failure (the same
 *  convention azure-canary's probeLane() uses: "not provisioned" and "provisioned but broken" are
 *  different facts and must not collapse into one alarm). A REQUIRED lane with no creds is an ERROR --
 *  we could not run the check, which is loud but distinct from proving something is wrong. */
export function assertTokenMint({ lane, tokenMinted, credsPresent = true, required = true, detail = "" }) {
  if (!credsPresent) {
    return required
      ? rec({ scope: "lane", subject: lane, check: "token_mint", state: "ERROR", message: `lane ${lane}: CHECK COULD NOT RUN -- oauth-lane-${lane}-id/-secret unavailable, but this lane is REQUIRED. The canary is blind here, not healthy here.` })
      : rec({ scope: "lane", subject: lane, check: "token_mint", state: "SKIP", message: `lane ${lane}: not provisioned (oauth-lane-${lane}-id/-secret absent); optional lane, skipped` });
  }
  if (!tokenMinted) {
    return rec({ scope: "lane", subject: lane, check: "token_mint", state: "FAIL", severity: SEVERITY.P1, message: `lane ${lane}: token mint FAILED${detail ? ` -- ${detail}` : ""}. The lane's OAuth client is rotated, revoked, or dropped from the gateway's client registry. NOTE this is a FAIL on an optional lane too: "no credential provisioned" is a benign state, "a provisioned credential that no longer works" never is.` });
  }
  return rec({ scope: "lane", subject: lane, check: "token_mint", message: `lane ${lane}: token minted` });
}

/**
 * The advertised tool count must be ABOVE this lane's floor.
 *
 * THIS IS THE CONNECTOR-SURFACE MISCLASSIFICATION DETECTOR. Its signature is unmistakable and it has
 * bitten this fleet before: a privileged lane whose credential is bound to a connector-style client
 * gets handed the 11-tool EXTERNAL_READONLY_TOOLSET instead of its ~1000-tool catalog. Nothing errors.
 * Every call the seat still has succeeds. The seat is just quietly, drastically less capable, and the
 * only visible symptom is a number nobody was looking at. A floor is the right instrument here (unlike
 * freshness, where only AGE works) because the failure moves the number DOWN by two orders of magnitude.
 *
 * An absent FLOOR is an ERROR, not a comparison. See numeric() above for why that is load-bearing.
 */
export function assertToolFloor({ lane, toolCount, minToolCount, detail = "" }) {
  if (!numeric(minToolCount)) {
    return rec({ scope: "lane", subject: lane, check: "tool_floor", state: "ERROR", message: `lane ${lane}: CHECK COULD NOT RUN -- no numeric min_tool_count in the registry (got ${JSON.stringify(minToolCount)}). REFUSED rather than compared: comparing an observed count against undefined yields false, which is how a lane degraded to the 11-tool external surface once printed "tool_count 11 >= floor undefined" as a PASS.` });
  }
  if (!numeric(toolCount)) {
    return rec({ scope: "lane", subject: lane, check: "tool_floor", state: "ERROR", message: `lane ${lane}: CHECK COULD NOT RUN -- no advertised tool count was obtained${detail ? ` (${detail})` : " (tools/list did not answer or returned an unreadable shape)"}.` });
  }
  if (toolCount < minToolCount) {
    return rec({ scope: "lane", subject: lane, check: "tool_floor", state: "FAIL", severity: SEVERITY.P1, message: `lane ${lane}: advertised tool_count ${toolCount} is BELOW its floor of ${minToolCount}. Classic connector-surface misclassification: a privileged lane handed the ~11-tool external read-only set instead of its full catalog.` });
  }
  return rec({ scope: "lane", subject: lane, check: "tool_floor", message: `lane ${lane}: tool_count ${toolCount} >= floor ${minToolCount}` });
}

/** A privileged lane authenticated by client_credentials must NOT be classified as a connector surface;
 *  the gateway sets connector_surface only for dcr_/occ_-prefixed client ids, so `true` here means the
 *  lane's stored credential is bound to the wrong client -- the exact CRO occ_cro_* misbinding.
 *  The EXPECTATION is required: an absent expect_connector_surface used to delete this check silently. */
export function assertConnectorSurface({ lane, connectorSurface, expectConnectorSurface, detail = "" }) {
  if (typeof expectConnectorSurface !== "boolean") {
    return rec({ scope: "lane", subject: lane, check: "connector_surface", state: "ERROR", message: `lane ${lane}: CHECK COULD NOT RUN -- the registry row carries no boolean expect_connector_surface (got ${JSON.stringify(expectConnectorSurface)}). Previously an absent expectation removed this assertion entirely, with no verdict and no record that it had gone.` });
  }
  if (typeof connectorSurface !== "boolean") {
    return rec({ scope: "lane", subject: lane, check: "connector_surface", state: "ERROR", message: `lane ${lane}: CHECK COULD NOT RUN -- connector_surface was not observable${detail ? ` (${detail})` : " (catalog_probe not advertised to this lane or no answer)"}.` });
  }
  if (connectorSurface !== expectConnectorSurface) {
    return rec({ scope: "lane", subject: lane, check: "connector_surface", state: "FAIL", severity: SEVERITY.P1, message: `lane ${lane}: connector_surface is ${connectorSurface}, expected ${expectConnectorSurface}. The lane's credential is bound to the wrong client class (a connector client instead of its confidential client_credentials client).` });
  }
  return rec({ scope: "lane", subject: lane, check: "connector_surface", message: `lane ${lane}: connector_surface ${connectorSurface} as expected` });
}

/** The gateway must echo back the identity we believe we authenticated as. A mismatch means a credential
 *  is cross-wired between lanes, which is a ring question, not merely a naming one. */
export function assertCallerAgent({ lane, callerAgent, detail = "" }) {
  if (!callerAgent) {
    return rec({ scope: "lane", subject: lane, check: "caller_agent", state: "ERROR", message: `lane ${lane}: CHECK COULD NOT RUN -- the gateway did not echo a caller_agent${detail ? ` (${detail})` : " (catalog_probe unavailable on this lane)"}.` });
  }
  if (callerAgent !== lane) {
    return rec({ scope: "lane", subject: lane, check: "caller_agent", state: "FAIL", severity: SEVERITY.P0, message: `lane ${lane}: the gateway resolved this credential to caller_agent "${callerAgent}". A credential is cross-wired between lanes; ring assertions for BOTH lanes are meaningless until this is fixed.` });
  }
  return rec({ scope: "lane", subject: lane, check: "caller_agent", message: `lane ${lane}: gateway echoed caller_agent ${callerAgent}` });
}

/** EXPECTED ROOMS PRESENT. Half of the old assertRoomSet, split out so that the ring half below is a
 *  separate, independently planned, independently counted verdict rather than a branch of this one. */
export function assertExpectedRooms({ lane, roomsSearched, expectedRooms = [], detail = "" }) {
  if (!Array.isArray(roomsSearched)) {
    return rec({ scope: "lane", subject: lane, check: "room_set", state: "ERROR", message: `lane ${lane}: CHECK COULD NOT RUN -- no readable rooms_searched list was obtained${detail ? ` (${detail})` : ""}, so the expected-room half could not be evaluated.` });
  }
  const seen = new Set(roomsSearched);
  const missing = expectedRooms.filter((r) => !seen.has(r));
  if (missing.length) {
    return rec({ scope: "lane", subject: lane, check: "room_set", state: "FAIL", severity: SEVERITY.P1, message: `lane ${lane}: expected room(s) ABSENT from rooms_searched: [${missing.join(", ")}]. The lane can still answer, but it is answering from a narrower brain than it is supposed to have.` });
  }
  return rec({ scope: "lane", subject: lane, check: "room_set", message: `lane ${lane}: ${roomsSearched.length} room(s) searched; all ${expectedRooms.length} expected present` });
}

/**
 * THE RING ASSERTION. One verdict, for every lane, every run, derived purely from lane IDENTITY.
 *
 * legal-personal and legal-personal-memory carry attorney-privileged personal legal material including a
 * live California family-law matter involving minors; the ring is clo-personal and exec ONLY. That
 * prohibition was a live P0 leak once already (a cfo-lane brain_search returning both personal rooms,
 * closed 2026-07-16). Room NAMES only ever leave this function -- never a matched document, never a
 * snippet, never a title.
 *
 * TWO SYMMETRIC OBLIGATIONS, chosen by ring membership and by nothing else:
 *   NON-MEMBER  -> the forbidden rooms must be ABSENT.
 *   MEMBER      -> the personal rooms must be PRESENT. This is the positive control: a check that only
 *                  ever asserts absence still goes green if the personal rooms vanished from the estate
 *                  entirely, which is a different outage wearing the same green light. Deriving it from
 *                  ring membership (rather than from a hand-written expected_rooms entry) means every
 *                  future ring member gets the positive control automatically.
 *
 * There is no parameter on this function that can switch it off, and no caller-supplied flag it reads.
 */
export function assertRing({ lane, roomsSearched, forbiddenRooms = [], personalLegalRooms = [], ringMember = false, detail = "" }) {
  if (!Array.isArray(roomsSearched)) {
    return rec({ scope: "lane", subject: lane, check: "ring", state: "ERROR", message: `lane ${lane}: RING CHECK COULD NOT RUN -- no readable rooms_searched list was obtained${detail ? ` (${detail})` : ""}. This is BLINDNESS on the single most important assertion this canary makes, and it is deliberately an ERROR rather than a skip: "no room was read" and "I never looked" are indistinguishable from the outside, so they are both treated as the dangerous one.` });
  }
  const seen = new Set(roomsSearched);
  if (ringMember) {
    const absent = personalLegalRooms.filter((r) => !seen.has(r));
    if (absent.length) {
      return rec({ scope: "lane", subject: lane, check: "ring", state: "FAIL", severity: SEVERITY.P1, message: `lane ${lane} is a personal-legal RING MEMBER but its room set is MISSING [${absent.join(", ")}]. This is the positive control failing: the allow path is broken or the rooms have disappeared from the estate, and an absence-only ring check would have stayed green through it.` });
    }
    return rec({ scope: "lane", subject: lane, check: "ring", message: `lane ${lane}: ring member; all ${personalLegalRooms.length} personal-legal room(s) PRESENT (allow path proven)` });
  }
  const leaked = forbiddenRooms.filter((r) => seen.has(r));
  const leakedPersonal = leaked.filter((r) => personalLegalRooms.includes(r));
  if (leaked.length) {
    return rec({
      scope: "lane", subject: lane, check: "ring", state: "FAIL",
      severity: leakedPersonal.length ? SEVERITY.P0 : SEVERITY.P1,
      message: leakedPersonal.length
        ? `RING VIOLATION (P0) on lane ${lane}: brain_search searched attorney-privileged personal-legal room(s) [${leakedPersonal.join(", ")}]. The personal-legal ring is clo-personal and exec ONLY. Treat as an active exposure, not a config nit.`
        : `lane ${lane}: forbidden room(s) present in rooms_searched: [${leaked.join(", ")}]`,
    });
  }
  return rec({ scope: "lane", subject: lane, check: "ring", message: `lane ${lane}: all ${forbiddenRooms.length} forbidden room(s) absent from ${roomsSearched.length} searched` });
}

// ---------------------------------------------------------------------------------------------
// LEDGER / RETRIEVAL
// ---------------------------------------------------------------------------------------------

/**
 * The shared exec ledger must be READABLE AND NON-TRIVIAL.
 *
 * ===================================================================================================
 * THIS ASSERTION EXISTS BECAUSE OF THE 2026-08-17/18 INCIDENT. Gateway commit c72dd3b routed the
 * commons brain (otchealthcommons/company-journal, exec ledger _MEMORY/_exec/<agent>.jsonl) to bucket
 * otchealth-finance-legal-dr instead of otchealth-brain-dr. The real ~6MB / 29-lane history was intact
 * and untouched at the correct bucket, but the gateway read the wrong one and found a single stray
 * 725-byte cto.jsonl there. Every lane, on every platform, therefore saw memory_team / memory_pack /
 * wake report shared_entry_count = 1.
 *
 * NOTHING ERRORED. The call succeeded, returned HTTP 200, returned well-formed JSON, and returned an
 * entry. A canary that asserted only "the ledger responded" would have stayed green straight through
 * the whole incident, which is precisely why that is not what this asserts. It asserts a FLOOR on the
 * number of shared entries AND on the number of distinct agent lanes represented, because the corrupt
 * state is a small positive number, not zero and not an error.
 * ===================================================================================================
 *
 * ALWAYS returns exactly the two planned verdicts (entry floor, agent floor), including on an
 * unreadable ledger -- an unread ledger must not silently shrink the number of checks that ran.
 */
export function assertLedger({ sharedEntryCount, agents, minSharedEntries, minAgents, error = null }) {
  const subject = LEDGER_SUBJECT;
  const blind = (check, why) => rec({ scope: "ledger", subject, check, state: "ERROR", message: `CHECK COULD NOT RUN -- ${why}` });
  if (error) return [blind("ledger_entry_floor", `the shared ledger could not be read at all: ${error}`), blind("ledger_agent_floor", `the shared ledger could not be read at all: ${error}`)];

  const out = [];
  if (!numeric(minSharedEntries)) out.push(blind("ledger_entry_floor", `the registry carries no numeric ledger.min_shared_entries (got ${JSON.stringify(minSharedEntries)}); REFUSED rather than compared.`));
  else if (!numeric(sharedEntryCount)) out.push(blind("ledger_entry_floor", `memory_team answered but carried no readable shared_entry_count, so the floor could not be evaluated.`));
  else if (sharedEntryCount < minSharedEntries) {
    out.push(rec({ scope: "ledger", subject, check: "ledger_entry_floor", state: "FAIL", severity: SEVERITY.P1, message: `shared_entry_count is ${sharedEntryCount}, BELOW the floor of ${minSharedEntries}. The ledger read succeeded and returned well-formed data, so nothing else in the fleet will report an error -- this is the 2026-08-17/18 misrouted-bucket signature (shared_entry_count=1 against a real ~29-lane history). Check which bucket the commons brain is being read from before assuming data loss.` }));
  } else out.push(rec({ scope: "ledger", subject, check: "ledger_entry_floor", message: `shared_entry_count ${sharedEntryCount} >= floor ${minSharedEntries}` }));

  const agentCount = Array.isArray(agents) ? new Set(agents).size : null;
  if (!numeric(minAgents)) out.push(blind("ledger_agent_floor", `the registry carries no numeric ledger.min_agents (got ${JSON.stringify(minAgents)}); REFUSED rather than compared.`));
  else if (agentCount == null) out.push(blind("ledger_agent_floor", `memory_team carried no readable agents list, so the distinct-lane floor could not be evaluated.`));
  else if (agentCount < minAgents) out.push(rec({ scope: "ledger", subject, check: "ledger_agent_floor", state: "FAIL", severity: SEVERITY.P1, message: `the shared ledger represents only ${agentCount} distinct agent lane(s), BELOW the floor of ${minAgents}. A multi-lane ledger collapsed to one or two lanes means the feed is being read from the wrong place, not that the other lanes went quiet.` }));
  else out.push(rec({ scope: "ledger", subject, check: "ledger_agent_floor", message: `${agentCount} distinct lane(s) >= floor ${minAgents}` }));

  return out;
}

/**
 * The shared exec ledger must also be FRESH, not merely large.
 *
 * WHY A SECOND LEDGER ASSERTION. The entry floor above catches the ledger being read from the wrong
 * place (a small positive number where a large one belongs). It does NOT catch the opposite and equally
 * silent shape: a healthy 300-entry ledger that stopped ACCEPTING WRITES days ago. That state passes
 * every floor forever, because a frozen collection never shrinks -- it stays identical. This is exactly
 * the AGE-not-FLOOR lesson skills/azure-canary/canary.mjs already learned when a frozen search index sat
 * undetected for ~12 days behind a doc-count floor, and it is the direct analogue of the 2026-08-17/18
 * failure: the write path being broken while every read still returns well-formed data.
 *
 * memory_team already returns recent[0].ts, so this costs no extra call. Live shape verified against
 * mcp.otchealth.app on 2026-08-18: result.recent[] rows each carry an ISO `ts`.
 */
export function assertLedgerFreshness({ newestTs, maxAgeH, now = Date.now(), error = null }) {
  const subject = LEDGER_SUBJECT;
  const blind = (why) => rec({ scope: "ledger", subject, check: "ledger_freshness", state: "ERROR", message: `CHECK COULD NOT RUN -- ${why}` });
  if (error) return blind(`the shared ledger could not be read at all: ${error}`);
  if (!numeric(maxAgeH)) return blind(`the registry carries no numeric ledger.max_age_h (got ${JSON.stringify(maxAgeH)}); REFUSED rather than compared.`);
  if (!newestTs) return blind(`memory_team carried no readable newest-entry timestamp, so ledger AGE could not be evaluated. A ledger that is large but frozen is invisible without this check.`);
  const t = Date.parse(newestTs);
  if (!Number.isFinite(t)) return blind(`the newest ledger entry carried an unparseable timestamp, so AGE could not be evaluated.`);
  const ageH = (now - t) / 3_600_000;
  if (ageH > maxAgeH) {
    return rec({ scope: "ledger", subject, check: "ledger_freshness", state: "FAIL", severity: SEVERITY.P1, message: `the newest shared-ledger entry is ${ageH.toFixed(1)}h old, ABOVE the ${maxAgeH}h SLO. The ledger still READS fine and still passes its size floors, so nothing else in the fleet reports a problem -- this is the frozen-but-readable shape: the WRITE path is broken while every read looks healthy.` });
  }
  return rec({ scope: "ledger", subject, check: "ledger_freshness", message: `newest shared-ledger entry is ${ageH.toFixed(1)}h old, within the ${maxAgeH}h SLO` });
}

/**
 * RETRIEVAL HEALTH: the brain must actually be RETRIEVING, and must be doing it in HYBRID mode.
 *
 * Two silent degradations this closes, neither of which any other assertion in this file can see:
 *
 *  (a) A STALE OR EMPTY ROOM. brain_search's rooms_searched lists every room whose query RESOLVED,
 *      including rooms that matched nothing at all. An index that is empty, frozen, or mid-reindex
 *      therefore still appears in rooms_searched and every room-set assertion above passes. Asserting a
 *      floor on the number of RESULTS a deliberately broad query returns is what distinguishes "the
 *      room answered" from "the room has anything in it".
 *
 *  (b) EMBEDDINGS DEAD -> SILENT KEYWORD-ONLY DEGRADATION. src/search/opensearch.ts's hybridSearch()
 *      wraps embed() in try/catch and sets vector=null on ANY failure, then fuses BM25 alone and returns
 *      mode:'keyword' instead of 'hybrid'. Nothing errors, every room still appears in rooms_searched,
 *      every health check stays green, and the whole fleet's retrieval quality silently halves -- a
 *      rotated embeddings key would do this fleet-wide with zero signal. kb_search surfaces that exact
 *      mode string per room (verified live on mcp.otchealth.app 2026-08-18: kb_search on memory-exec
 *      returned mode:"hybrid"), so this asserts it directly rather than inferring it.
 *
 * ALWAYS returns both planned verdicts. There is no longer a `require_hybrid` switch: a config key that
 * can delete the only observable for a dead embeddings provider is the same defect class as the rest of
 * this round, so hybrid is simply required.
 */
export function assertRetrieval({ index, mode, resultCount, minResults, error = null }) {
  const subject = retrievalSubject(index);
  const blind = (check, why) => rec({ scope: "retrieval", subject, check, state: "ERROR", message: `CHECK COULD NOT RUN -- ${why}` });
  if (error) return [blind("room_results", `the retrieval-health probe failed: ${error}`), blind("retrieval_mode", `the retrieval-health probe failed: ${error}`)];

  const out = [];
  if (!numeric(minResults)) out.push(blind("room_results", `the registry carries no numeric retrieval.min_results (got ${JSON.stringify(minResults)}); REFUSED rather than compared.`));
  else if (!numeric(resultCount)) out.push(blind("room_results", `kb_search on "${index}" returned no readable result count, so the empty/frozen-room floor could not be evaluated.`));
  else if (resultCount < minResults) out.push(rec({ scope: "retrieval", subject, check: "room_results", state: "FAIL", severity: SEVERITY.P1, message: `a deliberately broad query against "${index}" returned ${resultCount} result(s), BELOW the floor of ${minResults}. The room still RESOLVES, so it keeps appearing in every lane's rooms_searched and every ring assertion keeps passing; the index itself is empty, frozen, or mid-reindex.` }));
  else out.push(rec({ scope: "retrieval", subject, check: "room_results", message: `"${index}" returned ${resultCount} result(s) >= floor ${minResults}` }));

  if (!mode) out.push(blind("retrieval_mode", `kb_search on "${index}" reported no retrieval mode, so hybrid-vs-keyword-only could not be distinguished.`));
  else if (mode !== "hybrid") out.push(rec({ scope: "retrieval", subject, check: "retrieval_mode", state: "FAIL", severity: SEVERITY.P1, message: `"${index}" answered in mode "${mode}", not "hybrid". The vector half of the hybrid query did not run: hybridSearch() catches ANY embed() failure and continues keyword-only, so a rotated or revoked embeddings credential silently degrades fleet-wide retrieval with no error anywhere.` }));
  else out.push(rec({ scope: "retrieval", subject, check: "retrieval_mode", message: `"${index}" answered in hybrid mode (vector half alive)` }));

  return out;
}

/**
 * COVERAGE, computed as PLAN MINUS PRODUCED. Property 3.
 *
 * ===================================================================================================
 * There is no floor number here any more, and that is the entire point.
 *
 * The old version enumerated a hand-maintained list -- lanes, ring, ledger, retrieval -- against
 * hand-maintained minimums in the config. Two failures followed directly. (i) It had NO PLATFORM TERM,
 * so `--no-platforms` dropped all five platform checks including the P0 unauthenticated-front-door
 * assertion and coverage still reported OK; the run exited 0 having never touched the door. (ii) The
 * lock test compared config to config (`min_lanes_evaluated === required.length`), so flipping a lane to
 * optional AND lowering the floor in the same edit kept the test green while removing real coverage --
 * a floor config can edit down is not a coverage guarantee.
 *
 * Now: planChecks() derives what MUST be answered, this diffs it against what WAS answered, and every
 * gap is named individually. Nothing config can set makes a planned check disappear from the plan; the
 * most a narrowing flag can do is turn its verdict into a named REDUCED line and exit 3.
 * ===================================================================================================
 */
export function assertCoverage({ planned, produced }) {
  const plan = planned instanceof Set ? planned : new Set(planned || []);
  const got = produced instanceof Set ? produced : new Set(produced || []);
  const missing = [...plan].filter((id) => !got.has(id));
  if (!missing.length) {
    return [rec({ scope: "coverage", subject: "plan", check: "coverage_plan", message: `all ${plan.size} planned check(s) produced a verdict` })];
  }
  return missing.map((id) => rec({
    scope: "coverage", subject: id, check: "coverage_plan", state: "REDUCED",
    message: `COVERAGE REDUCED: the planned check "${id}" produced NO verdict at all. Nothing here is proven broken and nothing errored -- this check simply did not happen, and a run that silently drops a check is exactly the failure this canary exists to prevent. A --no-platforms / --no-ledger / --no-retrieval / --lanes narrowing, an unarmed credential path, or a collector that never reached the subject will each do this.`,
  }));
}

/** Platform-level (credential-free) checks: the gateway's own health envelope and the shape of its
 *  front door. `kind: "health"` asserts status + a tool-registry floor; `kind: "http_status"` asserts an
 *  exact status code and, optionally, that a named response header is present. Exactly ONE verdict per
 *  platform row, so the plan and the produced set line up one-to-one. */
export function evaluatePlatform(cfg, obs) {
  const subject = cfg.name;
  const check = cfg.kind;
  const one = (o) => [rec({ scope: "platform", subject, check, ...o })];
  if (!obs || obs.error) return one({ state: "ERROR", message: `platform check ${subject}: CHECK COULD NOT RUN -- ${obs?.error || "no observation was produced"}` });

  if (cfg.kind === "health") {
    const problems = [];
    if (obs.status !== "ok") problems.push(`/health status is "${obs.status}", expected "ok"`);
    if (!numeric(cfg.min_tool_count)) return one({ state: "ERROR", message: `platform check ${subject}: CHECK COULD NOT RUN -- no numeric min_tool_count in the registry row; REFUSED rather than compared.` });
    if (!numeric(obs.toolCount)) return one({ state: "ERROR", message: `platform check ${subject}: CHECK COULD NOT RUN -- /health carried no readable tool_count; the registry floor could not be evaluated.` });
    if (obs.toolCount < cfg.min_tool_count) problems.push(`tool_count ${obs.toolCount} is BELOW the registry floor of ${cfg.min_tool_count}; the catalog did not fully register on this revision`);
    if (problems.length) return one({ state: "FAIL", severity: SEVERITY.P1, message: `gateway ${problems.join("; ")}` });
    return one({ message: `gateway /health ok, tool_count ${obs.toolCount} >= ${cfg.min_tool_count}` });
  }

  if (cfg.kind === "http_status") {
    const problems = [];
    // A front door that stops answering 401 is an EXPOSURE question, not a health one.
    const isDoor = cfg.expect_status === 401;
    if (obs.status !== cfg.expect_status) problems.push(`HTTP ${obs.status}, expected ${cfg.expect_status}${isDoor ? ". An unauthenticated or forged-token request that is no longer refused is a live exposure of the whole gateway surface." : "."}`);
    if (cfg.expect_header && !(obs.headers || []).includes(String(cfg.expect_header).toLowerCase())) problems.push(`response is missing the expected "${cfg.expect_header}" header; the door is shut but no longer signposts how to authenticate (RFC 9728 discovery broken).`);
    if (problems.length) return one({ state: "FAIL", severity: isDoor && obs.status !== cfg.expect_status ? SEVERITY.P0 : SEVERITY.P1, message: `${subject}: ${problems.join(" ")}` });
    return one({ message: `${subject}: HTTP ${obs.status} as expected${cfg.expect_header ? `, ${cfg.expect_header} present` : ""}` });
  }

  return one({ state: "ERROR", message: `platform check ${subject}: unknown check kind "${cfg.kind}"` });
}

/**
 * Compose EVERY per-lane assertion for one lane. Always returns exactly LANE_CHECKS.length verdicts, in
 * order, whatever happened -- property 2.
 *
 * When the mint did not PASS, or no observation exists at all, the downstream checks are emitted as
 * EXPLICIT blocked verdicts naming the cause, never omitted and never synthesized as passes. An omitted
 * check and a passing check are indistinguishable in a summary line, which is how three rounds of this
 * defect stayed invisible; a blocked check that says so is not.
 */
export function evaluateLane(laneCfg, obs, policy = {}) {
  const lane = laneCfg.lane;
  const required = laneCfg.optional !== true;
  const downstream = LANE_CHECKS.filter((c) => c !== "token_mint");
  const blocked = (state, why) => downstream.map((check) => rec({ scope: "lane", subject: lane, check, state, message: `lane ${lane}: check "${check}" did NOT run -- ${why}` }));

  // NO OBSERVATION AT ALL is blindness, not a proven mint failure. Without this branch, a lane the
  // collector never reached would be read as credsPresent:true + tokenMinted:false and reported as a
  // FAIL ("the OAuth client is rotated or revoked") -- a confident, wrong diagnosis manufactured from
  // an absence. That is the same defect class as the rest of this round: a missing thing rendered as a
  // plausible value.
  if (obs === undefined || obs === null) {
    return [
      rec({ scope: "lane", subject: lane, check: "token_mint", state: "ERROR", message: `lane ${lane}: CHECK COULD NOT RUN -- no observation was produced for this lane at all. The collector never reached it; nothing about its health is known.` }),
      ...blocked("ERROR", "no observation was produced for this lane at all"),
    ];
  }

  const mint = assertTokenMint({ lane, tokenMinted: !!obs.tokenMinted, credsPresent: obs.credsPresent !== false, required, detail: obs.mintError || "" });
  if (mint.state !== "PASS") {
    // An unprovisioned OPTIONAL lane is the one benign blocked state: there is genuinely no credential,
    // so nothing downstream could have been observed. It is still RECORDED per check rather than dropped.
    const benign = mint.state === "SKIP";
    return [mint, ...blocked(benign ? "SKIP" : "ERROR", benign ? `this optional lane has no credential provisioned, so nothing downstream could be observed` : `it is blocked behind the token_mint verdict above (${mint.state})`)];
  }

  return [
    mint,
    assertToolFloor({ lane, toolCount: obs.toolCount, minToolCount: laneCfg.min_tool_count, detail: obs.toolCountError || "" }),
    assertConnectorSurface({ lane, connectorSurface: obs.connectorSurface, expectConnectorSurface: laneCfg.expect_connector_surface, detail: obs.probeError || obs.probeShapeError || "" }),
    assertCallerAgent({ lane, callerAgent: obs.callerAgent, detail: obs.probeError || obs.probeShapeError || "" }),
    assertExpectedRooms({ lane, roomsSearched: obs.roomsSearched, expectedRooms: laneCfg.expected_rooms || [], detail: obs.brainSearchError || "" }),
    assertRing({
      lane,
      roomsSearched: obs.roomsSearched,
      forbiddenRooms: forbiddenRoomsFor(laneCfg, policy),
      personalLegalRooms: policy.personal_legal_rooms || [],
      ringMember: isPersonalRingMember(lane, policy),
      detail: obs.brainSearchError || "",
    }),
  ];
}

/** Roll a full run's observations into findings + counts. Pure; the runner supplies observations.
 *  `options.now` pins the clock for the age-based assertions. A recorded fixture carries the instant it
 *  was taken (`_now`), so an offline evaluation is judged against the snapshot's own clock; without that
 *  the control fixture rots -- its newestTs is frozen, so the same unchanged file starts failing the
 *  72h freshness SLO days after it was written, breaking the suite for a reason unrelated to the code. */
export function evaluateRun(config, observations = {}, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const policy = { personal_legal_rooms: config.personal_legal_rooms, personal_legal_ring: config.personal_legal_ring };
  const findings = [...validateRegistry(config)];

  for (const laneCfg of config.lanes || []) {
    findings.push(...evaluateLane(laneCfg, (observations.lanes || {})[laneCfg.lane], policy));
  }

  // ONE RULE FOR EVERY SCOPE: an absent observation is an ERROR naming the subject, never silence and
  // never a shrunken check set. `notCollected` is the same sentence for lanes, ledger, retrieval and
  // platforms alike, because "the collector did not produce this" is one fact however it came about --
  // a --no-* switch, a --lanes filter, an unarmed credential, or a collector that simply never got
  // there. There is deliberately no `ledger_evaluated` boolean any more: it was TRUE whenever the block
  // returned an object, INCLUDING an error object, so the run printed "PASS coverage/ledger: the
  // shared-ledger block was evaluated" while that very block had errored. There are only verdicts now.
  const notCollected = (scope, subject, checks) => checks.map((check) => rec({
    scope, subject, check, state: "ERROR",
    message: `${scope} ${subject}: CHECK COULD NOT RUN -- the collector produced no observation for it. A --no-ledger / --no-retrieval / --no-platforms switch, a --lanes filter, an unarmed credential path, or a collector that never reached this subject will each do this. It is recorded per check rather than dropped, because an omitted check and a passing check look identical in a summary line.`,
  }));

  if (observations.ledger === undefined) findings.push(...notCollected("ledger", LEDGER_SUBJECT, LEDGER_CHECKS));
  else {
    const led = observations.ledger;
    findings.push(...assertLedger({ ...led, minSharedEntries: config.ledger?.min_shared_entries, minAgents: config.ledger?.min_agents }));
    findings.push(assertLedgerFreshness({ newestTs: led.newestTs, maxAgeH: config.ledger?.max_age_h, error: led.error ?? null, now }));
  }

  if (observations.retrieval === undefined) findings.push(...notCollected("retrieval", retrievalSubject(config.retrieval?.index), RETRIEVAL_CHECKS));
  else {
    findings.push(...assertRetrieval({
      index: config.retrieval?.index, mode: observations.retrieval.mode, resultCount: observations.retrieval.resultCount,
      minResults: config.retrieval?.min_results, error: observations.retrieval.error ?? null,
    }));
  }

  for (const pCfg of config.platforms || []) {
    const obs = (observations.platforms || {})[pCfg.name];
    if (obs === undefined) findings.push(...notCollected("platform", pCfg.name, [pCfg.kind]));
    else findings.push(...evaluatePlatform(pCfg, obs));
  }

  // COVERAGE, always last and ALWAYS evaluated, against the DERIVED plan. With every scope above now
  // emitting an explicit verdict for an uncollected subject, this is the STRUCTURAL BACKSTOP rather than
  // the first line of defence: it catches any planned check that some future code path emits nothing
  // for at all. That is exactly the failure it must survive -- the whole class began with a branch that
  // returned early and produced no verdict, and nothing downstream noticed the gap.
  const planned = planChecks(config);
  const produced = new Set(findings.map(checkId));
  findings.push(...assertCoverage({ planned, produced }));

  const laneVerdicts = findings.filter((f) => f.scope === "lane");
  const substantive = (f) => f.state !== "ERROR" && f.state !== "SKIP";
  // TWO ring numbers, not one. The old single counter overstated coverage by counting ring-MEMBER lanes
  // (clo-personal, exec), whose forbidden set is empty, toward the forbidden-room total. They are now
  // reported separately: members prove the ALLOW path, non-members prove the DENY path, and conflating
  // them made the deny-side number look one larger than the estate it had actually checked.
  const ringDenyLanesChecked = laneVerdicts.filter((f) => f.check === "ring" && substantive(f) && !isPersonalRingMember(f.subject, policy)).length;
  const ringAllowLanesChecked = laneVerdicts.filter((f) => f.check === "ring" && substantive(f) && isPersonalRingMember(f.subject, policy)).length;

  const counts = {
    pass: findings.filter((f) => f.state === "PASS").length,
    fail: findings.filter((f) => f.state === "FAIL").length,
    error: findings.filter((f) => f.state === "ERROR").length,
    skip: findings.filter((f) => f.state === "SKIP").length,
    reduced: findings.filter((f) => f.state === "REDUCED").length,
    p0: findings.filter((f) => f.severity === SEVERITY.P0).length,
    lanesEvaluated: laneVerdicts.filter((f) => f.check === "token_mint" && f.state === "PASS").length,
    ringDenyLanesChecked,
    ringAllowLanesChecked,
    planned: planned.size,
    // ANSWERED counts planned ids that got a verdict -- NOT produced.size, which also contains
    // config-scope findings that were never part of the plan and would make "produced/planned" read
    // above 100%. A coverage number that can exceed its own denominator is not a coverage number.
    answered: [...planned].filter((id) => produced.has(id)).length,
  };
  return { findings, counts, planned, produced, ok: counts.fail === 0 && counts.error === 0 && counts.reduced === 0 };
}

/**
 * Exit-code policy. FOUR distinct outcomes, because "an assertion failed", "a check could not run" and
 * "the run covered too little to mean anything" are three different facts demanding three different
 * human responses -- the system is broken / the sensor is blind / the sensor only looked at a corner.
 * All are loud; none is ever silent.
 *   0 = every assertion that ran, passed, and coverage was sufficient (or --report forced report-only)
 *   1 = at least one assertion FAILED     -> something is proven broken
 *   2 = nothing could be evaluated, or checks errored with no proven failure -> the canary is BLIND
 *   3 = everything checked was healthy, but too little was checked          -> COVERAGE REDUCED
 * Precedence is deliberate: a proven failure outranks blindness, which outranks thin coverage, because
 * that is the order in which they are actionable. Note that 3 is NOT a soft pass -- it is non-zero and
 * it pages, which is the whole point: the round-1 unarmed path returned 0 here.
 * Pure and unit-tested, mirroring azure-canary's / continuity-canary's pageExitCode().
 */
export function exitCode({ assertionFailures, checkErrors, coverageReductions = 0, verdictsProduced, reportOnly = false }) {
  if (reportOnly) return 0;
  if (!verdictsProduced) return 2;
  if (assertionFailures > 0) return 1;
  if (checkErrors > 0) return 2;
  if (coverageReductions > 0) return 3;
  return 0;
}
