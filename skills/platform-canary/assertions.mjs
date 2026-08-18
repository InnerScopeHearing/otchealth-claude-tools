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
 */
export function assertRoomSet({ lane, roomsSearched, expectedRooms = [], forbiddenRooms = [], personalLegalRooms = [] }) {
  if (!Array.isArray(roomsSearched)) {
    return [rec({ scope: "lane", subject: lane, check: "room_set", state: "ERROR", message: `lane ${lane}: CHECK COULD NOT RUN -- brain_search returned no readable rooms_searched list, so neither the expected nor the forbidden half of the ring assertion could be evaluated.` })];
  }
  const out = [];
  const seen = new Set(roomsSearched);
  const missing = expectedRooms.filter((r) => !seen.has(r));
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
  const mint = assertTokenMint({ lane, tokenMinted: !!obs?.tokenMinted, credsPresent: obs?.credsPresent !== false, required, detail: obs?.mintError || "" });
  out.push(mint);
  // No token means no downstream observation exists to judge. Report the mint verdict and stop -- do
  // NOT synthesize passes for checks that never ran.
  if (mint.state !== "PASS") return out;

  out.push(assertToolFloor({ lane, toolCount: obs.toolCount, minToolCount: laneCfg.min_tool_count }));
  if (laneCfg.expect_connector_surface != null) out.push(assertConnectorSurface({ lane, connectorSurface: obs.connectorSurface, expectConnectorSurface: laneCfg.expect_connector_surface }));
  out.push(assertCallerAgent({ lane, callerAgent: obs.callerAgent }));
  if (laneCfg.expects_brain_search === false) {
    out.push(rec({ scope: "lane", subject: lane, check: "room_set", state: "SKIP", message: `lane ${lane}: no brain-read tool is advertised to this lane by design, so there is no room set to assert` }));
  } else {
    out.push(...assertRoomSet({
      lane,
      roomsSearched: obs.roomsSearched,
      expectedRooms: laneCfg.expected_rooms || [],
      forbiddenRooms: forbiddenRoomsFor(laneCfg, policy),
      personalLegalRooms: policy.personal_legal_rooms || [],
    }));
  }
  return out;
}

/** Roll a full run's observations into findings + counts. Pure; the runner supplies observations. */
export function evaluateRun(config, observations) {
  const policy = { personal_legal_rooms: config.personal_legal_rooms, personal_legal_ring: config.personal_legal_ring };
  const findings = [];
  for (const laneCfg of config.lanes || []) {
    findings.push(...evaluateLane(laneCfg, (observations.lanes || {})[laneCfg.lane], policy));
  }
  if (observations.ledger !== undefined) {
    findings.push(...assertLedger({ ...observations.ledger, minSharedEntries: config.ledger.min_shared_entries, minAgents: config.ledger.min_agents }));
  }
  for (const pCfg of config.platforms || []) {
    if ((observations.platforms || {})[pCfg.name] === undefined) continue;
    findings.push(...evaluatePlatform(pCfg, observations.platforms[pCfg.name]));
  }
  const counts = {
    pass: findings.filter((f) => f.state === "PASS").length,
    fail: findings.filter((f) => f.state === "FAIL").length,
    error: findings.filter((f) => f.state === "ERROR").length,
    skip: findings.filter((f) => f.state === "SKIP").length,
    p0: findings.filter((f) => f.severity === SEVERITY.P0).length,
  };
  return { findings, counts, ok: counts.fail === 0 && counts.error === 0 };
}

/**
 * Exit-code policy. Three distinct outcomes, because "an assertion failed" and "the check could not run
 * at all" are different facts that need different human responses -- one says the system is broken, the
 * other says the sensor is blind. Both are loud; neither is ever silent.
 *   0 = every assertion that ran, passed (or --report forced report-only)
 *   1 = at least one assertion FAILED  -> something is proven broken
 *   2 = nothing could be evaluated, or checks errored with no proven failure -> the canary is BLIND
 * A proven failure outranks blindness: if both are present, exit 1, because there is something concrete
 * to act on. Pure and unit-tested, mirroring azure-canary's / continuity-canary's pageExitCode().
 */
export function exitCode({ assertionFailures, checkErrors, verdictsProduced, reportOnly = false }) {
  if (reportOnly) return 0;
  if (!verdictsProduced) return 2;
  if (assertionFailures > 0) return 1;
  if (checkErrors > 0) return 2;
  return 0;
}
