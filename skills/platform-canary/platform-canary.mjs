#!/usr/bin/env node
// platform-canary.mjs -- the PERMANENT per-lane / per-platform health canary for the MCP gateway.
//
// WHY THIS EXISTS
// The fleet has canaries for search-index freshness, scheduled-job liveness, telemetry streams and
// continuity docs. It has never had one for the thing every single AI seat actually depends on: that
// each gateway LANE still mints, still sees its own catalog, still resolves to its own identity, still
// searches exactly the rooms it is supposed to search and none that it is not, and that the shared exec
// ledger every seat wakes up on still contains a real history. A one-time sweep proves all of that for
// one minute and is worthless the next day. This is the durable version.
//
// THE FOUR FAILURE SHAPES IT IS BUILT AROUND, all of them real, none of them hypothetical:
//   1. CONNECTOR-SURFACE MISCLASSIFICATION -- a privileged lane's credential bound to a connector-style
//      client gets the 11-tool external read-only set instead of its ~1000-tool catalog. Nothing errors.
//      The seat just quietly loses almost everything it can do. Caught by a per-lane tool-count FLOOR.
//   2. RING WIDENING -- a lane that must not see the attorney-privileged personal-legal rooms starts
//      seeing them. This was a live P0 once (cfo lane, closed 2026-07-16) and has had no continuous
//      sensor since. Caught by asserting forbidden rooms are ABSENT, with clo-personal as the positive
//      control proving the allow path still works.
//   3. A SILENTLY EMPTY SHARED LEDGER -- 2026-08-17/18: commit c72dd3b read the commons brain from the
//      wrong S3 bucket and every lane saw shared_entry_count=1 against a real ~29-lane history. HTTP
//      200, well-formed JSON, no error anywhere. Caught ONLY by a floor on the content. See
//      assertions.mjs's assertLedger() header for the full incident write-up.
//   4. A FRONT DOOR THAT STOPS REFUSING -- the unauthenticated and forged-static-token paths must keep
//      answering 401. Checked with no credential at all, so this half still runs even if every lane
//      credential in the estate is unreachable.
//
// READ-ONLY, ABSOLUTELY. Every gateway call this file makes is on the ALLOWED_TOOLS allowlist below and
// callTool() refuses anything else at runtime, so a future edit cannot casually introduce a mutating
// call. It never writes a memory, never checkpoints, never dispatches, never touches a write tool.
//
// NEVER PRINTS PRIVILEGED CONTENT. It reads response ENVELOPES only: room NAMES, counts, identity
// echoes, HTTP status codes. No matched document, no snippet, no ledger entry text is read into a
// variable that is printed, logged, or emitted. Verdict messages carry names and numbers, never prose
// from the brain. A canary that leaks privileged text into a CI log is worse than no canary.
//
// ROUND-3 ARCHITECTURE (read assertions.mjs's header first). This file is now a DUMB COLLECTOR with
// exactly one job: gather everything the DERIVED check plan requires. It consults no per-lane opt-out
// to decide what to collect, and it never narrows the config it hands to evaluateRun(). Both rules are
// load-bearing:
//   * `expects_brain_search:false` used to live here as `if (laneCfg.expects_brain_search !== false)`
//     around the brain_search call. With the flag set the room list was never gathered, so the ring
//     assertion had nothing to judge and took a vacuous-SKIP branch -- one config line deleting the P0
//     personal-legal check on a lane while the run exited 0. The flag is gone from this file and from
//     the registry, and validateRegistry() now ERRORs if anyone re-adds it.
//   * The config passed to evaluateRun() is the FULL registry, always. A --lanes filter or a --no-*
//     switch narrows what is COLLECTED, never what is PLANNED, so the gap surfaces as named REDUCED
//     verdicts (exit 3) instead of vanishing. --no-platforms used to drop all five platform checks --
//     including the P0 unauthenticated-front-door assertion -- and still print OK.
//
// EXIT CODES (see assertions.mjs's exitCode(); this deliberately differs from azure-canary's
// report-by-default convention because a silent break is the exact thing being defended against):
//   0 = everything that ran, passed AND coverage was sufficient
//   1 = an assertion FAILED (something is proven broken)
//   2 = the canary is BLIND (a check could not run at all)
//   3 = COVERAGE REDUCED (all healthy, but too little was checked for the green to mean anything)
// --report forces 0 for a safe manual/local run.
//
// Auth: one client_credentials mint per lane from oauth-lane-<lane>-id/-secret via the shared kvSecret
// resolver (Key Vault, with the AWS SSM fallback). Secret values are never printed, never written to a
// file, and are referenced by NAME only in every log line and every verdict message.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve as resolvePath } from "node:path";
import { kvSecret } from "../kb-memory/azure-secret.mjs";
import { evaluateRun, exitCode, SEVERITY } from "./assertions.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = process.env.PLATFORM_CANARY_CONFIG || join(HERE, "expected-lanes.json");
const GW = process.env.GATEWAY_BASE_URL || "https://mcp.otchealth.app";

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const REPORT_ONLY = flag("--report") || process.env.PLATFORM_CANARY_REPORT === "1";
const JSONOUT = flag("--json");
const NO_LEDGER = flag("--no-ledger");
const NO_RETRIEVAL = flag("--no-retrieval");
const NO_PLATFORMS = flag("--no-platforms");
const ONLY_LANES = (opt("--lanes") || "").split(",").map((s) => s.trim()).filter(Boolean);
const FIXTURE = opt("--fixture");

// The complete set of gateway tools this canary is permitted to invoke. Every one is a READ. callTool()
// enforces this at runtime so the read-only property is a property of the code, not of a promise in a
// comment that a later edit can quietly break. Deliberately stated without a count: round 1's comment
// said "all four" over a three-element set, and a comment that miscounts the thing directly beneath it
// is a small instance of exactly the defect class this file exists to catch.
const ALLOWED_TOOLS = new Set(["brain_search", "catalog_probe", "memory_team", "kb_search"]);

function warn(msg) { console.log(`::warning::[platform-canary] ${msg}`); }

// ---------------------------------------------------------------------------------------------
// I/O: gateway transport. Every helper returns data or throws a message that carries NO secret value.
// ---------------------------------------------------------------------------------------------

/** Parse a JSON-or-SSE MCP response body into its JSON-RPC envelope. Same shape azure-canary uses. */
function parseEnvelope(body) {
  try { return JSON.parse(body); } catch { /* fall through to SSE framing */ }
  for (const line of body.split("\n")) {
    if (line.startsWith("data:")) { try { return JSON.parse(line.slice(5)); } catch { /* keep scanning */ } }
  }
  return null;
}

/** Mint a lane bearer via client_credentials. Returns null when the lane simply has no credential in
 *  the store (never provisioned -- a different fact from "provisioned but broken", which throws). */
async function laneBearer(lane) {
  const cid = await kvSecret(`oauth-lane-${lane}-id`);
  const csec = await kvSecret(`oauth-lane-${lane}-secret`);
  if (!cid || !csec) return null;
  const r = await fetch(`${GW}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: cid, client_secret: csec }),
  });
  const j = await r.json().catch(() => null);
  // j.error is an OAuth error CODE (e.g. invalid_client), never a secret value.
  if (!r.ok || !j?.access_token) throw new Error(`token endpoint HTTP ${r.status}${j?.error ? ` (${j.error})` : ""}`);
  return j.access_token;
}

/** The lane's ADVERTISED tool count, via tools/list (cursor-paged, bounded). This is deliberately not
 *  catalog_probe's tool_registry_count: the registry count is the gateway's whole catalog and is
 *  identical on every lane, so it can never detect a lane being handed the wrong, narrower surface.
 *  Only the advertised list can. Names are counted; no schema or description is retained. */
async function advertisedToolCount(bearer) {
  let cursor, total = 0;
  for (let page = 0; page < 20; page++) {
    const r = await fetch(`${GW}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: cursor ? { cursor } : {} }),
    });
    if (!r.ok) throw new Error(`tools/list HTTP ${r.status}`);
    const j = parseEnvelope(await r.text());
    const tools = j?.result?.tools;
    if (!Array.isArray(tools)) throw new Error("tools/list returned no readable tools array");
    total += tools.length;
    cursor = j.result.nextCursor;
    if (!cursor) return total;
  }
  return total;
}

/** One read-only tool call. Refuses any tool not on ALLOWED_TOOLS. */
async function callTool(bearer, name, args) {
  if (!ALLOWED_TOOLS.has(name)) throw new Error(`refusing to call "${name}": platform-canary is read-only and may only call ${[...ALLOWED_TOOLS].join(", ")}`);
  const r = await fetch(`${GW}/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  if (!r.ok) throw new Error(`${name} HTTP ${r.status}`);
  const j = parseEnvelope(await r.text());
  if (j?.result?.isError) throw new Error(`${name} returned isError`);
  const err = j?.result?.structuredContent?.error || j?.error;
  if (err) throw new Error(`${name}: ${err.code || err.message || "error"}`);
  // TWO PAYLOAD SHAPES ARE REAL. The gateway normally answers with structuredContent, whose `result`
  // field carries the tool's own payload; some paths return only a content[] block whose first text
  // part is that same JSON. Round 1 read only the first shape. Both are handled, and the fallback is
  // tried in order rather than merged, so an unparseable text part degrades to null (-> ERROR upstream)
  // instead of silently half-populating an observation.
  const sc = j?.result?.structuredContent;
  if (sc && typeof sc === "object") return sc.result ?? sc;
  const text = j?.result?.content?.find?.((c) => c?.type === "text")?.text;
  if (typeof text === "string") {
    try {
      const parsed = JSON.parse(text);
      return parsed && typeof parsed === "object" && parsed.result !== undefined ? parsed.result : parsed;
    } catch { return null; }
  }
  return null;
}

/**
 * Pull catalog_probe's identity fields out of whatever shape the gateway handed back.
 *
 * ===================================================================================================
 * THE REAL SHAPE, COPIED FROM A LIVE CALL to mcp.otchealth.app on 2026-08-18 (cto lane), not from any
 * description of it:
 *
 *   {"result":{"build_tag":"catalog-probe-2026-07-26.1","revision":{...},"tool_registry_count":1008,
 *     "known_tools_present":{...},
 *     "request_context":{"caller_agent":"cto","is_m365_static_auth":false,"is_connector_surface":true}},
 *    "compliance_warning":null,"correlation_id":"0bf4a4c3-...","dry_run":false}
 *
 * Both identity fields are nested under `request_context`. Round 1 read `probe.is_connector_surface`
 * and `probe.caller_agent` at the TOP level, where neither has ever existed, so both resolved to null
 * on every run -- and null was then classified as a silent skip, meaning two of the five per-lane
 * assertions (connector_surface and caller_agent, one of them the P0 cross-wiring check) could never
 * fire. The canary paged blind on those two checks by construction.
 *
 * Accessor accepts the payload either already unwrapped (`.request_context`) or still carrying its
 * outer envelope (`.result.request_context`), and returns undefined -- never null-as-a-value -- when
 * the field genuinely is not there, so the caller can tell "absent" from "observed false".
 * ===================================================================================================
 */
export function probeIdentity(probe) {
  const ctx = probe?.request_context ?? probe?.result?.request_context ?? null;
  if (!ctx || typeof ctx !== "object") return { connectorSurface: undefined, callerAgent: undefined, shapeOk: false };
  return {
    connectorSurface: typeof ctx.is_connector_surface === "boolean" ? ctx.is_connector_surface : undefined,
    callerAgent: typeof ctx.caller_agent === "string" && ctx.caller_agent ? ctx.caller_agent : undefined,
    shapeOk: true,
  };
}

/**
 * The default transport bundle. Injected so observeLane() can be exercised by a test against its REAL
 * output shape with no network -- round 2's regression lock for the ring bug fed the classifier a
 * roomsSearched array that the live collector COULD NOT PRODUCE when the flag was set, so the test
 * passed while the bug was live. A collector that can only be tested through a hand-built observation
 * is a collector nobody has actually tested.
 */
export const defaultIo = {
  bearer: laneBearer,
  toolCount: advertisedToolCount,
  call: callTool,
};

/** Collect one lane's observation. Never throws: every failure mode becomes a field on the observation
 *  so assertions.mjs can classify "did not run" separately from "ran and failed". Every captured error
 *  string is READ downstream (evaluateLane threads them into the ERROR messages) -- they were all
 *  write-only before, so the operator got a confident generic cause instead of the real one. */
export async function observeLane(laneCfg, io = defaultIo) {
  const lane = laneCfg.lane;
  const obs = { lane, credsPresent: true, tokenMinted: false };
  let bearer;
  try {
    bearer = await io.bearer(lane);
  } catch (e) {
    obs.mintError = e.message;
    return obs;
  }
  if (!bearer) { obs.credsPresent = false; return obs; }
  obs.tokenMinted = true;

  try { obs.toolCount = await io.toolCount(bearer); } catch (e) { obs.toolCountError = e.message; }

  // catalog_probe is not advertised to every lane. Its absence leaves connectorSurface/callerAgent
  // undefined, which assertions.mjs classifies as ERROR (blind), never as a pass.
  //
  // A SUCCESSFUL PROBE WHOSE FIELDS ARE MISSING IS ALSO AN ERROR, not a skip. "the call worked but the
  // field I need is not there" is a shape regression -- exactly what a renamed or re-nested field would
  // look like -- and it must be as loud as a failed call, never indistinguishable from a pass.
  try {
    const probe = await io.call(bearer, "catalog_probe", {});
    const id = probeIdentity(probe);
    if (!id.shapeOk) {
      obs.probeShapeError = "catalog_probe answered but carried no request_context block (expected result.request_context.{caller_agent,is_connector_surface}); the response shape has changed";
    } else {
      if (id.connectorSurface === undefined) obs.probeShapeError = "catalog_probe's request_context carried no boolean is_connector_surface";
      if (id.callerAgent === undefined) obs.probeShapeError = (obs.probeShapeError ? obs.probeShapeError + "; " : "") + "catalog_probe's request_context carried no caller_agent";
    }
    obs.connectorSurface = id.connectorSurface ?? null;
    obs.callerAgent = id.callerAgent ?? null;
  } catch (e) { obs.probeError = e.message; }

  // THE ROOM LIST IS ALWAYS COLLECTED. There is deliberately no condition here, and none may be added:
  // the ring check is planned for every lane unconditionally, so the collector's contract is to gather
  // what the plan needs. A lane that genuinely has no brain-read tool produces a brainSearchError, which
  // becomes an ERROR (blind) carrying that exact reason -- an honest "I could not determine this lane's
  // room set", never a pass and never a skip.
  try {
    // A deliberately neutral probe query with top:1. Only rooms_searched is read off the response;
    // the results array is never touched, so no privileged content enters this process.
    const res = await io.call(bearer, "brain_search", { query: "platform canary lane probe", top: 1 });
    obs.roomsSearched = Array.isArray(res?.rooms_searched) ? res.rooms_searched : null;
    if (obs.roomsSearched === null) obs.brainSearchError = "brain_search answered but carried no readable rooms_searched array";
  } catch (e) { obs.brainSearchError = e.message; }
  return obs;
}

/** The shared exec ledger observation: counts and lane names ONLY. memory_team returns entry TEXT; that
 *  text is never read out of the response here, only shared_entry_count and the agents name list. */
async function observeLedger(cfg) {
  const lane = cfg.ledger.probe_lane;
  try {
    const bearer = await laneBearer(lane);
    if (!bearer) return { error: `ledger probe lane "${lane}" has no credential in the store (oauth-lane-${lane}-id/-secret)` };
    const team = await callTool(bearer, "memory_team", { limit: 1 });
    // recent[0].ts is the newest shared entry's ISO timestamp (live shape verified 2026-08-18). Only
    // the timestamp is read; the entry's `text` is never touched, so no ledger content enters this
    // process even though memory_team returns it.
    const newest = Array.isArray(team?.recent) && team.recent.length ? team.recent[0] : null;
    return {
      sharedEntryCount: Number(team?.shared_entry_count),
      agents: Array.isArray(team?.agents) ? team.agents : null,
      newestTs: newest && typeof newest.ts === "string" ? newest.ts : null,
    };
  } catch (e) {
    return { error: e.message };
  }
}

/**
 * RETRIEVAL HEALTH observation. One kb_search against an OPEN index (never a ring-gated one), reading
 * ONLY the envelope's `mode` and `count`; the matches array is never touched, so no document text
 * enters this process. `mode` is the gateway's own hybrid-vs-keyword marker and is the only externally
 * visible signal that the embeddings half of every hybrid query is still alive.
 */
async function observeRetrieval(cfg) {
  const rc = cfg.retrieval || {};
  const lane = rc.probe_lane || cfg.ledger?.probe_lane;
  try {
    const bearer = await laneBearer(lane);
    if (!bearer) return { error: `retrieval probe lane "${lane}" has no credential in the store (oauth-lane-${lane}-id/-secret)` };
    const res = await callTool(bearer, "kb_search", { index: rc.index, query: rc.query, top: rc.top || 3 });
    return { mode: typeof res?.mode === "string" ? res.mode : null, resultCount: Number(res?.count) };
  } catch (e) {
    return { error: e.message };
  }
}

/** Credential-free platform surface observations. */
async function observePlatform(p) {
  try {
    if (p.kind === "health") {
      const r = await fetch(`${GW}${p.path}`, { method: "GET" });
      const j = await r.json().catch(() => null);
      return { status: j?.status ?? `http-${r.status}`, toolCount: Number(j?.tool_count) };
    }
    const r = await fetch(`${GW}${p.path}`, {
      method: p.method || "GET",
      headers: p.method === "POST" ? { "Content-Type": "application/json", Accept: "application/json, text/event-stream" } : {},
      body: p.method === "POST" ? JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) : undefined,
    });
    return { status: r.status, headers: [...r.headers.keys()].map((k) => k.toLowerCase()) };
  } catch (e) {
    return { error: e.message };
  }
}

async function emitPosthog(props) {
  try {
    // FIXTURE MODE IS HERMETIC, and this is where round 1's "no network, no credentials" claim was
    // false: main() called emitPosthog() unconditionally, which reads posthog-fleet-ingest-key from the
    // secret store and POSTs to us.i.posthog.com even for an offline fixture evaluation. A claim of
    // hermeticity that the code does not honour is worse than no claim, because the next person builds
    // an air-gapped test on it.
    if (FIXTURE) return;
    const key = process.env.POSTHOG_FLEET_INGEST_KEY || (await kvSecret("posthog-fleet-ingest-key"));
    if (!key) return;
    const host = process.env.POSTHOG_HOST || "https://us.i.posthog.com";
    await fetch(`${host}/capture/`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: key, event: "platform_canary", distinct_id: "fleet-platform-canary", properties: props }),
    });
  } catch { /* emit is best-effort; a dead telemetry pipe must never mask the canary's own verdict */ }
}

// ---------------------------------------------------------------------------------------------

/** Gather observations. A --lanes filter or a --no-* switch narrows what is COLLECTED here; it never
 *  narrows the config handed to evaluateRun(), so every gap becomes a named REDUCED verdict. */
async function collect(cfg) {
  const observations = { lanes: {}, platforms: {} };
  const lanes = (cfg.lanes || []).filter((l) => !ONLY_LANES.length || ONLY_LANES.includes(l.lane));
  for (const laneCfg of lanes) observations.lanes[laneCfg.lane] = await observeLane(laneCfg);
  if (!NO_LEDGER) observations.ledger = await observeLedger(cfg);
  if (!NO_RETRIEVAL && cfg.retrieval) observations.retrieval = await observeRetrieval(cfg);
  if (!NO_PLATFORMS) for (const p of cfg.platforms || []) observations.platforms[p.name] = await observePlatform(p);
  return { observations };
}

async function main() {
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch (e) {
    // Config unreadable = total blindness. Exit 2, never 0: a canary that cannot load its own
    // expectations has not proven anything and must not look like a pass.
    console.error(`::error::[platform-canary] CANNOT RUN: registry ${CONFIG_PATH} is unreadable (${e.message}). No assertion was evaluated.`);
    process.exit(REPORT_ONLY ? 0 : 2);
  }

  let observations;
  if (FIXTURE) {
    // Offline mode: evaluate a recorded observation set. Same pure classifier, no network, no
    // credential. This is how the incident fixture is demonstrated end to end from the command line.
    observations = JSON.parse(readFileSync(resolvePath(FIXTURE), "utf8"));
    if (NO_LEDGER) delete observations.ledger;
    if (NO_RETRIEVAL) delete observations.retrieval;
    if (NO_PLATFORMS) observations.platforms = {};
    // --lanes now behaves in fixture mode exactly as SKILL.md always documented it: as a filter. It was
    // silently ignored here, so a documented flag did nothing and any conclusion drawn from a
    // "--fixture X --lanes Y" run was about the whole fixture, not about Y.
    if (ONLY_LANES.length && observations.lanes) {
      for (const l of Object.keys(observations.lanes)) if (!ONLY_LANES.includes(l)) delete observations.lanes[l];
    }
    console.log(`[platform-canary] FIXTURE MODE: evaluating ${FIXTURE} (no network, no credentials, no telemetry emit)`);
  } else {
    ({ observations } = await collect(cfg));
  }

  // THE CONFIG IS NEVER NARROWED. evaluateRun() plans from the FULL registry, so anything the collector
  // did not reach -- a --lanes filter, a --no-* switch, an unarmed credential, a lane the fixture does
  // not contain -- surfaces as a named REDUCED verdict instead of quietly shrinking the check set.
  // A fixture is a SNAPSHOT: judge its age-based assertions against the clock it was taken on, not
  // against today's, or the control fixture starts failing the freshness SLO purely by getting older.
  const pinnedNow = FIXTURE && typeof observations._now === "string" ? Date.parse(observations._now) : Date.now();
  const { findings, counts } = evaluateRun(cfg, observations, { now: pinnedNow });

  const summary = {
    ok: counts.fail === 0 && counts.error === 0 && counts.reduced === 0,
    gateway: GW,
    fixture: FIXTURE || null,
    pass: counts.pass, fail: counts.fail, error: counts.error, skip: counts.skip,
    reduced: counts.reduced, p0: counts.p0,
    lanes_evaluated: counts.lanesEvaluated,
    ring_deny_lanes_checked: counts.ringDenyLanesChecked, ring_allow_lanes_checked: counts.ringAllowLanesChecked,
    planned_checks: counts.planned, answered_checks: counts.answered,
    findings,
  };
  await emitPosthog({ ...summary, findings: findings.map((f) => ({ scope: f.scope, subject: f.subject, check: f.check, state: f.state, severity: f.severity })) });

  if (JSONOUT) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`[platform-canary] ${GW} | pass ${counts.pass} | FAIL ${counts.fail} | ERROR(blind) ${counts.error} | REDUCED(coverage) ${counts.reduced} | skip ${counts.skip} | P0 ${counts.p0} | lanes evaluated ${counts.lanesEvaluated} | ring deny-checked ${counts.ringDenyLanesChecked} / allow-checked ${counts.ringAllowLanesChecked} | plan ${counts.answered}/${counts.planned}`);
    for (const f of findings) {
      const sev = f.severity ? ` [${f.severity}]` : "";
      console.log(`  ${f.state.padEnd(5)}${sev.padEnd(6)} ${f.scope}/${f.subject}/${f.check}: ${f.message}`);
    }
  }

  // Two anomaly classes, two messages. "Something is broken" and "I could not look" demand different
  // human responses, so they are never collapsed into one line.
  for (const f of findings.filter((x) => x.state === "FAIL")) warn(`ASSERTION FAILED${f.severity === SEVERITY.P0 ? " (P0)" : ""} -- ${f.message}`);
  for (const f of findings.filter((x) => x.state === "ERROR")) warn(`CHECK COULD NOT RUN -- ${f.message}`);
  for (const f of findings.filter((x) => x.state === "REDUCED")) warn(`COVERAGE REDUCED -- ${f.message}`);

  const code = exitCode({ assertionFailures: counts.fail, checkErrors: counts.error, coverageReductions: counts.reduced, verdictsProduced: findings.length, reportOnly: REPORT_ONLY });
  if (code === 1) console.error(`::error::[platform-canary] ${counts.fail} ASSERTION(S) FAILED${counts.p0 ? ` including ${counts.p0} P0` : ""}. A lane or platform surface is provably broken; do not treat this as flaky.`);
  if (code === 2) console.error(`::error::[platform-canary] THE CANARY IS BLIND: ${counts.error} check(s) could not run at all${findings.length ? "" : " and nothing was evaluated"}. This is not a pass. Fix the sensor before trusting any lane's health.`);
  if (code === 3) console.error(`::error::[platform-canary] COVERAGE REDUCED: everything that was checked was healthy, but ${counts.reduced} of ${counts.planned} PLANNED check(s) produced no verdict at all (each named above). This is NOT a pass. A run that inspects a corner of the estate and reports OK is the exact failure this canary exists to prevent, so it is refused here too.`);
  if (code === 0 && !REPORT_ONLY) console.log(`[platform-canary] OK (all ${counts.planned} planned check(s) answered and passed; ${counts.lanesEvaluated} lane(s) evaluated, ring deny-path checked on ${counts.ringDenyLanesChecked} lane(s), allow-path on ${counts.ringAllowLanesChecked})`);
  process.exit(code);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(async (e) => {
    // Even an unexpected crash must be loud AND must not masquerade as healthy: exit 2 (blind), never 0.
    await emitPosthog({ ok: false, fatal: true, error: e.message });
    console.error(`::error::[platform-canary] FATAL: ${e.message}. Nothing was proven; treating as BLIND.`);
    process.exit(REPORT_ONLY ? 0 : 2);
  });
}
