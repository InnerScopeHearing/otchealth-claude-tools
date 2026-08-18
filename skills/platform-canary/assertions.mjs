// assertions.mjs -- the PURE assertion core of the per-lane / per-platform health canary.
//
// Deliberately ZERO imports and ZERO I/O: every function here takes an already-collected observation
// and returns a verdict record. That is what makes the whole thing unit-testable against fixtures
// (including the fixture reproducing the 2026-08-17/18 shared-ledger incident, see assertLedger below)
// without a network, a credential, or a live gateway. platform-canary.mjs does all the talking to the
// world and hands the results in here; this file decides what is healthy.
//
// House pattern followed (do not duplicate, extend): skills/azure-canary/canary.mjs's
// assessFreshness()/pageExitCode() and skills/continuity-canary/continuity-canary.mjs's
// assessDocFreshness()/pageExitCode() -- a pure classifier plus a pure exit-code function, with the
// runner kept dumb. The ABSENCE-is-also-an-alarm principle those two encode (a check that stops
// producing a signal must itself be an alarm, not silence) is carried here in two ways: a check that
// could not run at all is an ERROR verdict, never a silent pass; and a floor is asserted on the shared
// ledger's CONTENT, not merely on the call succeeding.
//
// =====================================================================================================
// THE GOVERNING RULE (do not weaken; re-read before adding any branch that returns early)
// =====================================================================================================
// There must be NO configuration, credential state, or environment under which this canary exits 0
// while a lane, a ring, or the ledger went unchecked. Silence must be impossible; reduced coverage must
// be LOUD.
//
// Concretely, three things follow and each has a locking test:
//   (1) A SKIP MUST NEVER STAND IN FOR A SECURITY ASSERTION. The forbidden-room half of the ring check
//       is UNCONDITIONAL: whenever a lane reports any rooms_searched at all, the forbidden set is
//       asserted absent, regardless of expects_brain_search or any other config flag. A config flag may
//       govern the EXPECTED-PRESENT half only. Round 1 coupled the two, so one line of config
//       (expects_brain_search:false, already set on cro and cpo) silently deleted the P0 ring assertion
//       for that lane and the run still passed. Never re-couple them.
//   (2) A MISSING FIELD ON A SUCCESSFUL CALL IS AN ERROR, NEVER A PASS AND NEVER A SILENT SKIP. "The
//       thing I needed to read was not there" and "the check passed" must never be indistinguishable.
//   (3) NOT RUNNING ENOUGH CHECKS IS ITSELF A FAILURE. assertCoverage() below asserts a floor on how
//       many lanes were actually evaluated and how many ring assertions actually ran, and the ledger
//       block having been evaluated at all. A run that quietly narrowed itself to the credential-free
//       platform half exits non-zero with its own distinct message, it does not report OK.
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
  const ring = policy.personal_legal_ring || [];
  const set = new Set(laneCfg.forbidden_rooms || []);
  if (ring.includes(laneCfg.lane)) for (const r of personal) set.delete(r);
  else for (const r of personal) set.add(r);
  return [...set];
}

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
    return rec({ scope: "lane", subject: lane, check: "token_mint", state: "FAIL", severity: SEVERITY.P1, message: `lane ${lane}: token mint FAILED${detail ? ` -- ${detail}` : ""}. The lane's OAuth client is rotated, revoked, or dropped from the gateway's client registry.` });
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
 */
export function assertToolFloor({ lane, toolCount, minToolCount }) {
  if (toolCount == null || !Number.isFinite(toolCount)) {
    return rec({ scope: "lane", subject: lane, check: "tool_floor", state: "ERROR", message: `lane ${lane}: CHECK COULD NOT RUN -- no advertised tool count was obtained (tools/list did not answer or returned an unreadable shape).` });
  }
  if (toolCount < minToolCount) {
    return rec({ scope: "lane", subject: lane, check: "tool_floor", state: "FAIL", severity: SEVERITY.P1, message: `lane ${lane}: advertised tool_count ${toolCount} is BELOW its floor of ${minToolCount}. Classic connector-surface misclassification: a privileged lane handed the ~11-tool external read-only set instead of its full catalog.` });
  }
  return rec({ scope: "lane", subject: lane, check: "tool_floor", message: `lane ${lane}: tool_count ${toolCount} >= floor ${minToolCount}` });
}

/** A privileged lane authenticated by client_credentials must NOT be classified as a connector surface;
 *  the gateway sets connector_surface only for dcr_/occ_-prefixed client ids, so `true` here means the
 *  lane's stored credential is bound to the wrong client -- the exact CRO occ_cro_* misbinding. */
export function assertConnectorSurface({ lane, connectorSurface, expectConnectorSurface }) {
  if (connectorSurface == null) {
    return rec({ scope: "lane", subject: lane, check: "connector_surface", state: "ERROR", message: `lane ${lane}: CHECK COULD NOT RUN -- connector_surface was not observable (catalog_probe not advertised to this lane or no answer).` });
  }
  if (connectorSurface !== expectConnectorSurface) {
    return rec({ scope: "lane", subject: lane, check: "connector_surface", state: "FAIL", severity: SEVERITY.P1, message: `lane ${lane}: connector_surface is ${connectorSurface}, expected ${expectConnectorSurface}. The lane's credential is bound to the wrong client class (a connector client instead of its confidential client_credentials client).` });
  }
  return rec({ scope: "lane", subject: lane, check: "connector_surface", message: `lane ${lane}: connector_surface ${connectorSurface} as expected` });
}

/** The gateway must echo back the identity we believe we authenticated as. A mismatch means a credential
 *  is cross-wired between lanes, which is a ring question, not merely a naming one. */
export function assertCallerAgent({ lane, callerAgent }) {
  if (!callerAgent) {
    return rec({ scope: "lane", subject: lane, check: "caller_agent", state: "ERROR", message: `lane ${lane}: CHECK COULD NOT RUN -- the gateway did not echo a caller_agent (catalog_probe unavailable on this lane).` });
  }
  if (callerAgent !== lane) {
    return rec({ scope: "lane", subject: lane, check: "caller_agent", state: "FAIL", severity: SEVERITY.P0, message: `lane ${lane}: the gateway resolved this credential to caller_agent "${callerAgent}". A credential is cross-wired between lanes; ring assertions for BOTH lanes are meaningless until this is fixed.` });
  }
  return rec({ scope: "lane", subject: lane, check: "caller_agent", message: `lane ${lane}: gateway echoed caller_agent ${callerAgent}` });
}

/**
 * The lane's brain_search room set: expected rooms PRESENT, forbidden rooms ABSENT.
 *
 * The forbidden half is the load-bearing assertion in this entire file. legal-personal and
 * legal-personal-memory carry attorney-privileged personal legal material; the personal-legal ring is
 * clo-personal and exec ONLY. That prohibition was a live P0 leak once already (a cfo-lane brain_search
 * returning both personal rooms, closed 2026-07-16) and nothing has watched it continuously since.
 * Room NAMES only ever leave this function -- never a matched document, never a snippet, never a title.
 *
 * THE FORBIDDEN HALF IS UNCONDITIONAL. `assertExpected` may switch OFF the expected-present half for a
 * lane whose room set is not independently known; it can never switch off the forbidden-absent half.
 * Any caller that hands this function an array of rooms gets the ring assertion, full stop. See the
 * governing-rule header: one config line silently deleting a P0 security assertion was the round-1 bug.
 */
export function assertRoomSet({ lane, roomsSearched, expectedRooms = [], forbiddenRooms = [], personalLegalRooms = [], assertExpected = true, declaredNoBrainSearch = false }) {
  if (!Array.isArray(roomsSearched)) {
    // A lane that DECLARES it is advertised no brain-read tool, and indeed reported no rooms, is the
    // one honest case where there is genuinely nothing to forbid: no search ran, so no room was read.
    // That is recorded explicitly rather than as a generic skip, and it is the ONLY path on which the
    // forbidden half does not execute. Every other unreadable room list is blindness, not health.
    if (declaredNoBrainSearch) {
      return [rec({ scope: "lane", subject: lane, check: "room_set", state: "SKIP", message: `lane ${lane}: declares no brain-read tool and returned no rooms, so no room was read and there is nothing to forbid. The forbidden-room assertion is vacuous here, not suppressed.` })];
    }
    return [rec({ scope: "lane", subject: lane, check: "room_set", state: "ERROR", message: `lane ${lane}: CHECK COULD NOT RUN -- brain_search returned no readable rooms_searched list, so neither the expected nor the forbidden half of the ring assertion could be evaluated.` })];
  }
  const out = [];
  // REGISTRY DRIFT: the lane declared it has no brain-read tool, yet it just searched rooms. The ring
  // assertion below still runs (that is the point), but the registry is describing a lane that no
  // longer exists and must be corrected before someone trusts it again.
  if (declaredNoBrainSearch) {
    out.push(rec({ scope: "lane", subject: lane, check: "room_set_registry_drift", state: "FAIL", severity: SEVERITY.P1, message: `lane ${lane}: the registry declares expects_brain_search:false, but this lane just searched ${roomsSearched.length} room(s). The registry is STALE. The forbidden-room assertion was still evaluated (it is unconditional), but the expected-room half is not being checked for a lane that demonstrably has a brain-read tool.` }));
  }
  const seen = new Set(roomsSearched);
  const missing = assertExpected ? expectedRooms.filter((r) => !seen.has(r)) : [];
  const leaked = forbiddenRooms.filter((r) => seen.has(r));
  const leakedPersonal = leaked.filter((r) => personalLegalRooms.includes(r));

  if (leaked.length) {
    out.push(rec({
      scope: "lane", subject: lane, check: "ring", state: "FAIL",
      severity: leakedPersonal.length ? SEVERITY.P0 : SEVERITY.P1,
      message: leakedPersonal.length
        ? `RING VIOLATION (P0) on lane ${lane}: brain_search searched attorney-privileged personal-legal room(s) [${leakedPersonal.join(", ")}]. The personal-legal ring is clo-personal and exec ONLY. Treat as an active exposure, not a config nit.`
        : `lane ${lane}: forbidden room(s) present in rooms_searched: [${leaked.join(", ")}]`,
    }));
  }
  if (missing.length) {
    out.push(rec({ scope: "lane", subject: lane, check: "room_set", state: "FAIL", severity: SEVERITY.P1, message: `lane ${lane}: expected room(s) ABSENT from rooms_searched: [${missing.join(", ")}]. The lane can still answer, but it is answering from a narrower brain than it is supposed to have.` }));
  }
  if (!out.length) {
    out.push(rec({ scope: "lane", subject: lane, check: "room_set", message: `lane ${lane}: ${roomsSearched.length} room(s) searched; all ${expectedRooms.length} expected present, all ${forbiddenRooms.length} forbidden absent` }));
  }
  return out;
}

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
 * state is a small positive number, not zero and not an error. A canary that would not have caught
 * tonight's incident is not worth writing.
 * ===================================================================================================
 */
export function assertLedger({ sharedEntryCount, agents, minSharedEntries, minAgents, error = null }) {
  const subject = "shared-exec-ledger";
  if (error) {
    return [rec({ scope: "ledger", subject, check: "ledger_readable", state: "ERROR", message: `CHECK COULD NOT RUN -- the shared ledger could not be read at all: ${error}` })];
  }
  if (sharedEntryCount == null || !Number.isFinite(sharedEntryCount)) {
    return [rec({ scope: "ledger", subject, check: "ledger_readable", state: "ERROR", message: `CHECK COULD NOT RUN -- memory_team answered but carried no readable shared_entry_count, so the floor could not be evaluated.` })];
  }
  const out = [];
  if (sharedEntryCount < minSharedEntries) {
    out.push(rec({
      scope: "ledger", subject, check: "ledger_entry_floor", state: "FAIL", severity: SEVERITY.P1,
      message: `shared_entry_count is ${sharedEntryCount}, BELOW the floor of ${minSharedEntries}. The ledger read succeeded and returned well-formed data, so nothing else in the fleet will report an error -- this is the 2026-08-17/18 misrouted-bucket signature (shared_entry_count=1 against a real ~29-lane history). Check which bucket the commons brain is being read from before assuming data loss.`,
    }));
  }
  const agentCount = Array.isArray(agents) ? new Set(agents).size : null;
  if (agentCount == null) {
    out.push(rec({ scope: "ledger", subject, check: "ledger_agent_floor", state: "ERROR", message: `CHECK COULD NOT RUN -- memory_team carried no readable agents list, so the distinct-lane floor could not be evaluated.` }));
  } else if (agentCount < minAgents) {
    out.push(rec({ scope: "ledger", subject, check: "ledger_agent_floor", state: "FAIL", severity: SEVERITY.P1, message: `the shared ledger represents only ${agentCount} distinct agent lane(s), BELOW the floor of ${minAgents}. A multi-lane ledger collapsed to one or two lanes means the feed is being read from the wrong place, not that the other lanes went quiet.` }));
  }
  if (!out.length) {
    out.push(rec({ scope: "ledger", subject, check: "ledger_entry_floor", message: `shared_entry_count ${sharedEntryCount} >= floor ${minSharedEntries}; ${agentCount} distinct lane(s) >= floor ${minAgents}` }));
  }
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
export function assertLedgerFreshness({ newestTs, maxAgeH, now = Date.now() }) {
  const subject = "shared-exec-ledger";
  if (!newestTs) {
    return rec({ scope: "ledger", subject, check: "ledger_freshness", state: "ERROR", message: `CHECK COULD NOT RUN -- memory_team carried no readable newest-entry timestamp, so ledger AGE could not be evaluated. A ledger that is large but frozen is invisible without this check.` });
  }
  const t = Date.parse(newestTs);
  if (!Number.isFinite(t)) {
    return rec({ scope: "ledger", subject, check: "ledger_freshness", state: "ERROR", message: `CHECK COULD NOT RUN -- the newest ledger entry carried an unparseable timestamp, so AGE could not be evaluated.` });
  }
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
 */
export function assertRetrieval({ index, mode, resultCount, minResults, requireHybrid = true }) {
  const subject = `retrieval:${index}`;
  const out = [];
  if (resultCount == null || !Number.isFinite(resultCount)) {
    out.push(rec({ scope: "retrieval", subject, check: "room_results", state: "ERROR", message: `CHECK COULD NOT RUN -- kb_search on "${index}" returned no readable result count, so the empty/frozen-room floor could not be evaluated.` }));
  } else if (resultCount < minResults) {
    out.push(rec({ scope: "retrieval", subject, check: "room_results", state: "FAIL", severity: SEVERITY.P1, message: `a deliberately broad query against "${index}" returned ${resultCount} result(s), BELOW the floor of ${minResults}. The room still RESOLVES, so it keeps appearing in every lane's rooms_searched and every ring assertion keeps passing; the index itself is empty, frozen, or mid-reindex.` }));
  } else {
    out.push(rec({ scope: "retrieval", subject, check: "room_results", message: `"${index}" returned ${resultCount} result(s) >= floor ${minResults}` }));
  }
  if (!requireHybrid) return out;
  if (!mode) {
    out.push(rec({ scope: "retrieval", subject, check: "retrieval_mode", state: "ERROR", message: `CHECK COULD NOT RUN -- kb_search on "${index}" reported no retrieval mode, so hybrid-vs-keyword-only could not be distinguished.` }));
  } else if (mode !== "hybrid") {
    out.push(rec({ scope: "retrieval", subject, check: "retrieval_mode", state: "FAIL", severity: SEVERITY.P1, message: `"${index}" answered in mode "${mode}", not "hybrid". The vector half of the hybrid query did not run: hybridSearch() catches ANY embed() failure and continues keyword-only, so a rotated or revoked embeddings credential silently degrades fleet-wide retrieval with no error anywhere.` }));
  } else {
    out.push(rec({ scope: "retrieval", subject, check: "retrieval_mode", message: `"${index}" answered in hybrid mode (vector half alive)` }));
  }
  return out;
}

/**
 * COVERAGE: the run must have actually covered enough to be worth believing.
 *
 * ===================================================================================================
 * THIS IS THE ANSWER TO "the canary reported OK while checking almost nothing."
 * In round 1, when the AWS secret-store credentials were absent the workflow appended
 * `--lanes __unarmed__ --no-ledger`. No lane matched that filter and the ledger block was dropped
 * entirely, so the run evaluated only the five credential-free platform surfaces, found them healthy,
 * and exited 0. Every six hours, forever, it would have reported OK while checking neither a single
 * lane, nor a single ring, nor the ledger -- the precise failure class it was built to detect, wearing
 * a green light. Four of nine lanes being optional compounded it: absent credentials SKIPped without
 * touching the exit code.
 *
 * So coverage is now itself an assertion with its own outcome class (REDUCED, exit 3), separate from
 * FAIL ("something is broken") and ERROR ("I could not look at one thing"). REDUCED means "I did look,
 * but at too little for this result to mean anything."
 * ===================================================================================================
 */
export function assertCoverage({ lanesEvaluated, ringAssertionsRun, ledgerEvaluated, retrievalEvaluated, cfg = {} }) {
  const minLanes = cfg.min_lanes_evaluated ?? 0;
  const minRing = cfg.min_ring_assertions ?? 0;
  const requireLedger = cfg.require_ledger !== false;
  const requireRetrieval = cfg.require_retrieval !== false;
  const out = [];
  if (lanesEvaluated < minLanes) {
    out.push(rec({ scope: "coverage", subject: "lanes", check: "coverage_lanes", state: "REDUCED", message: `COVERAGE REDUCED: only ${lanesEvaluated} lane(s) were actually evaluated, below the required minimum of ${minLanes}. Nothing here is proven broken and nothing errored -- the run simply did not look at enough of the estate for a green result to mean anything. Unarmed credentials or a --lanes filter will do this.` }));
  } else {
    out.push(rec({ scope: "coverage", subject: "lanes", check: "coverage_lanes", message: `${lanesEvaluated} lane(s) evaluated >= required ${minLanes}` }));
  }
  if (ringAssertionsRun < minRing) {
    out.push(rec({ scope: "coverage", subject: "ring", check: "coverage_ring", state: "REDUCED", message: `COVERAGE REDUCED: the forbidden-room ring assertion actually EXECUTED on only ${ringAssertionsRun} lane(s), below the required minimum of ${minRing}. The attorney-privileged personal-legal ring is the single most important thing this canary watches; a run that checked it on too few lanes must not report OK.` }));
  } else {
    out.push(rec({ scope: "coverage", subject: "ring", check: "coverage_ring", message: `ring assertion executed on ${ringAssertionsRun} lane(s) >= required ${minRing}` }));
  }
  if (requireLedger && !ledgerEvaluated) {
    out.push(rec({ scope: "coverage", subject: "ledger", check: "coverage_ledger", state: "REDUCED", message: `COVERAGE REDUCED: the shared-ledger block was NOT evaluated at all in this run (--no-ledger, or no probe-lane credential). The 2026-08-17/18 incident this canary exists for lives entirely in that block, so a run without it proves nothing about the failure class it was built for.` }));
  } else if (requireLedger) {
    out.push(rec({ scope: "coverage", subject: "ledger", check: "coverage_ledger", message: `the shared-ledger block was evaluated` }));
  }
  if (requireRetrieval && !retrievalEvaluated) {
    out.push(rec({ scope: "coverage", subject: "retrieval", check: "coverage_retrieval", state: "REDUCED", message: `COVERAGE REDUCED: the retrieval-health block (room result floor + hybrid-vs-keyword mode) was NOT evaluated in this run, so a silently empty room or a dead embeddings credential would be invisible.` }));
  } else if (requireRetrieval) {
    out.push(rec({ scope: "coverage", subject: "retrieval", check: "coverage_retrieval", message: `the retrieval-health block was evaluated` }));
  }
  return out;
}

/** Platform-level (credential-free) checks: the gateway's own health envelope and the shape of its
 *  front door. `kind: "health"` asserts status + a tool-registry floor; `kind: "http_status"` asserts an
 *  exact status code and, optionally, that a named response header is present. */
export function evaluatePlatform(cfg, obs) {
  const subject = cfg.name;
  if (!obs || obs.error) {
    return [rec({ scope: "platform", subject, check: cfg.kind, state: "ERROR", message: `platform check ${subject}: CHECK COULD NOT RUN -- ${obs?.error || "no observation was produced"}` })];
  }
  const out = [];
  if (cfg.kind === "health") {
    if (obs.status !== "ok") out.push(rec({ scope: "platform", subject, check: "health", state: "FAIL", severity: SEVERITY.P1, message: `gateway /health status is "${obs.status}", expected "ok"` }));
    if (!Number.isFinite(obs.toolCount)) out.push(rec({ scope: "platform", subject, check: "health", state: "ERROR", message: `gateway /health carried no readable tool_count; the registry floor could not be evaluated` }));
    else if (obs.toolCount < cfg.min_tool_count) out.push(rec({ scope: "platform", subject, check: "health", state: "FAIL", severity: SEVERITY.P1, message: `gateway /health tool_count ${obs.toolCount} is BELOW the registry floor of ${cfg.min_tool_count}; the catalog did not fully register on this revision` }));
    if (!out.length) out.push(rec({ scope: "platform", subject, check: "health", message: `gateway /health ok, tool_count ${obs.toolCount} >= ${cfg.min_tool_count}` }));
    return out;
  }
  if (cfg.kind === "http_status") {
    if (obs.status !== cfg.expect_status) {
      // A front door that stops answering 401 is an EXPOSURE question, not a health one.
      const isDoor = cfg.expect_status === 401;
      out.push(rec({ scope: "platform", subject, check: "http_status", state: "FAIL", severity: isDoor ? SEVERITY.P0 : SEVERITY.P1, message: `${subject}: HTTP ${obs.status}, expected ${cfg.expect_status}${isDoor ? ". An unauthenticated or forged-token request that is no longer refused is a live exposure of the whole gateway surface." : "."}` }));
    }
    if (cfg.expect_header && !(obs.headers || []).includes(String(cfg.expect_header).toLowerCase())) {
      out.push(rec({ scope: "platform", subject, check: "http_status", state: "FAIL", severity: SEVERITY.P1, message: `${subject}: response is missing the expected "${cfg.expect_header}" header; the door is shut but no longer signposts how to authenticate (RFC 9728 discovery broken).` }));
    }
    if (!out.length) out.push(rec({ scope: "platform", subject, check: "http_status", message: `${subject}: HTTP ${obs.status} as expected${cfg.expect_header ? `, ${cfg.expect_header} present` : ""}` }));
    return out;
  }
  return [rec({ scope: "platform", subject, check: cfg.kind, state: "ERROR", message: `platform check ${subject}: unknown check kind "${cfg.kind}"` })];
}

/** Compose every per-lane assertion for one lane from its config + one observation. */
export function evaluateLane(laneCfg, obs, policy = {}) {
  const lane = laneCfg.lane;
  const required = laneCfg.optional !== true;
  const out = [];
  // NO OBSERVATION AT ALL is blindness, not a proven mint failure. Without this branch, a lane the
  // collector never reached would be read as credsPresent:true + tokenMinted:false and reported as a
  // FAIL ("the OAuth client is rotated or revoked") -- a confident, wrong diagnosis manufactured from
  // an absence. That is the same defect class as the rest of this round: a missing thing rendered as a
  // plausible value.
  if (obs === undefined || obs === null) {
    out.push(rec({ scope: "lane", subject: lane, check: "token_mint", state: "ERROR", message: `lane ${lane}: CHECK COULD NOT RUN -- no observation was produced for this lane at all. The collector never reached it; nothing about its health is known.` }));
    return out;
  }
  const mint = assertTokenMint({ lane, tokenMinted: !!obs?.tokenMinted, credsPresent: obs?.credsPresent !== false, required, detail: obs?.mintError || "" });
  out.push(mint);
  // No token means no downstream observation exists to judge. Report the mint verdict and stop -- do
  // NOT synthesize passes for checks that never ran.
  if (mint.state !== "PASS") return out;

  out.push(assertToolFloor({ lane, toolCount: obs.toolCount, minToolCount: laneCfg.min_tool_count }));
  if (laneCfg.expect_connector_surface != null) out.push(assertConnectorSurface({ lane, connectorSurface: obs.connectorSurface, expectConnectorSurface: laneCfg.expect_connector_surface }));
  out.push(assertCallerAgent({ lane, callerAgent: obs.callerAgent }));
  // THE RING ASSERTION ALWAYS RUNS. expects_brain_search:false narrows the EXPECTED-PRESENT half only;
  // the forbidden-absent half is evaluated for every lane that reported any rooms at all. Round 1
  // branched around assertRoomSet entirely here, which meant cro and cpo (both expects_brain_search:
  // false in the shipped registry) had NO ring assertion and a run with legal-personal in a cro room
  // set passed. Proven by execution, now locked by test.
  out.push(...assertRoomSet({
    lane,
    roomsSearched: obs.roomsSearched,
    expectedRooms: laneCfg.expected_rooms || [],
    forbiddenRooms: forbiddenRoomsFor(laneCfg, policy),
    personalLegalRooms: policy.personal_legal_rooms || [],
    assertExpected: laneCfg.expects_brain_search !== false,
    declaredNoBrainSearch: laneCfg.expects_brain_search === false,
  }));
  return out;
}

/** Roll a full run's observations into findings + counts. Pure; the runner supplies observations. */
export function evaluateRun(config, observations) {
  const policy = { personal_legal_rooms: config.personal_legal_rooms, personal_legal_ring: config.personal_legal_ring };
  const findings = [];
  for (const laneCfg of config.lanes || []) {
    findings.push(...evaluateLane(laneCfg, (observations.lanes || {})[laneCfg.lane], policy));
  }
  const ledgerEvaluated = observations.ledger !== undefined;
  if (ledgerEvaluated) {
    findings.push(...assertLedger({ ...observations.ledger, minSharedEntries: config.ledger.min_shared_entries, minAgents: config.ledger.min_agents }));
    // Freshness runs only when the ledger read itself worked; assertLedger already emitted the ERROR
    // for an unreadable ledger and a second "could not run" line for the same cause is noise.
    if (!observations.ledger.error) {
      findings.push(assertLedgerFreshness({ newestTs: observations.ledger.newestTs, maxAgeH: config.ledger.max_age_h ?? 72 }));
    }
  }
  const retrievalEvaluated = observations.retrieval !== undefined;
  if (retrievalEvaluated) {
    const rc = config.retrieval || {};
    if (observations.retrieval.error) {
      findings.push(rec({ scope: "retrieval", subject: `retrieval:${rc.index || "?"}`, check: "room_results", state: "ERROR", message: `CHECK COULD NOT RUN -- the retrieval-health probe failed: ${observations.retrieval.error}` }));
    } else {
      findings.push(...assertRetrieval({
        index: rc.index, mode: observations.retrieval.mode, resultCount: observations.retrieval.resultCount,
        minResults: rc.min_results ?? 1, requireHybrid: rc.require_hybrid !== false,
      }));
    }
  }
  for (const pCfg of config.platforms || []) {
    if ((observations.platforms || {})[pCfg.name] === undefined) continue;
    findings.push(...evaluatePlatform(pCfg, observations.platforms[pCfg.name]));
  }

  // COVERAGE, always last and ALWAYS evaluated. A lane counts as evaluated only when its token minted,
  // because that is the point past which the downstream checks genuinely ran. The ring count is stricter
  // still: it counts lanes on which the forbidden-room assertion actually EXECUTED against a real room
  // list, which is the only number that can honestly answer "was the ring watched tonight".
  const laneVerdicts = findings.filter((f) => f.scope === "lane");
  const lanesEvaluated = laneVerdicts.filter((f) => f.check === "token_mint" && f.state === "PASS").length;
  const ringAssertionsRun = new Set(
    laneVerdicts.filter((f) => (f.check === "room_set" || f.check === "ring") && f.state !== "ERROR" && f.state !== "SKIP").map((f) => f.subject),
  ).size;
  findings.push(...assertCoverage({ lanesEvaluated, ringAssertionsRun, ledgerEvaluated, retrievalEvaluated, cfg: config.coverage || {} }));

  const counts = {
    pass: findings.filter((f) => f.state === "PASS").length,
    fail: findings.filter((f) => f.state === "FAIL").length,
    error: findings.filter((f) => f.state === "ERROR").length,
    skip: findings.filter((f) => f.state === "SKIP").length,
    reduced: findings.filter((f) => f.state === "REDUCED").length,
    p0: findings.filter((f) => f.severity === SEVERITY.P0).length,
    lanesEvaluated,
    ringAssertionsRun,
  };
  return { findings, counts, ok: counts.fail === 0 && counts.error === 0 && counts.reduced === 0 };
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
