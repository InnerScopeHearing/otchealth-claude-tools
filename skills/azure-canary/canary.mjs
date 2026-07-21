#!/usr/bin/env node
// canary.mjs -- the fleet FRESHNESS + dead-job CANARY.
//
// WHAT IT WATCHES (and why it now looks nothing like the old version):
//   (1) DEAD-JOB PAGER -- every scheduled Container Apps Job's latest run must be Succeeded (via the
//       gateway's azure_jobs_list / azure_job_executions, cto lane). The failure family that let
//       daily-digest fail silently for 9 days.
//   (2) PER-INDEX FRESHNESS -- for every LIVE index in setup/expected-indexes.json, the newest document's
//       timestamp (indexed_at for the room indexes, ts for memory-exec) must be younger than that index's
//       max_age_h SLO. This REPLACES the old single-index doc-count FLOOR. The floor was the exact blind
//       spot that let `otchealth-brain` (67,645 docs, NO WRITER) sit frozen for ~12 days: a frozen index
//       never drops below a floor -- it stays identical forever. Age can only be measured because the
//       room indexes now carry a sortable indexed_at field (indexer.mjs, 2026-07-13) + the backfill.
//   (3) TOMBSTONE GUARD -- otchealth-brain must stay in `decommissioning`, never re-adopted as live.
//   (4) PER-STREAM FRESHNESS (W1-5, 2026-07-17) -- for every stream in setup/expected-streams.json, the
//       newest PostHog event's timestamp must be younger than that stream's max_age_h SLO. Same
//       AGE-not-FLOOR lesson as (2), applied to the fleet's telemetry/eval/medic streams instead of AI
//       Search indexes: this is what caught $ai_generation/agent_session sitting silent ~367h (~15 days)
//       and medic_dispatch ~331h (~14 days) -- see stream-freshness.mjs's header for the full story.
//   (5) PER-LANE SYNTHETIC PROBE (2026-07-21) -- everything above only ever authenticates as the CTO
//       lane, so a DIFFERENT lane's OAuth client_credentials (cfo/clo/developer) could rot -- an expired
//       or rotated secret, a client silently dropped from the gateway's oauth-clients registry (see
//       setup/oauth-clients-canary.mjs's own regression story), or a ring-gating change that empties the
//       rooms a lane can see -- with ZERO sensor coverage. One real brain_search per lane, mint-to-
//       response; a lane with no creds yet is a SKIP (not provisioned is not an anomaly), a real
//       mint/transport failure, HTTP 4xx/5xx, or JSON-RPC isError is an anomaly. See probeLane()'s header.
//
// REPORT-ONLY on an anomaly (PostHog azure_canary event + ::warning::); exits non-zero ONLY if it cannot
// run at all (sensor lane dark), which is itself the page.
//
// Auth: cto-lane bearer (gateway /mcp) for the job sweep; azure-sp (read via the shared kvSecret, NEVER a
// local AZURE_SP-only reader) -> ARM listQueryKeys -> a read-only AI Search query key for the freshness
// probe. The freshness probe reads ONLY the newest timestamp + doc count -- never document CONTENT, so it
// does not breach the privileged (finance/legal) rings. The stream-freshness probe reads the SAME
// posthog-personal-api-key / posthog-fleet-project-id secrets fleet-medic already uses, and likewise reads
// only the newest event timestamp + count, never event property content. The per-lane probe reads only
// the response envelope (http status, isError, the rooms_searched NAME list) for its own lane's creds --
// never any matched document's content -- so it stays ring-safe even for the cfo/clo lanes. No secret
// value is ever printed.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { kvSecret } from "../kb-memory/azure-secret.mjs";
import { auditScheduledJob } from "./cron-exec.mjs";
import { assessStreamFreshness, newestStreamEventTs, resolvePosthogCreds } from "./stream-freshness.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const GW = process.env.GATEWAY_BASE_URL || "https://mcp.otchealth.app";
const SUB = process.env.AZURE_SUBSCRIPTION_ID || "55c84f6b-ef90-4259-a58b-50835cc4cab4";
const SEARCH_RG = process.env.AZURE_SEARCH_RG || "otchealth-automation-rg";
const JSONOUT = process.argv.includes("--json");
// STRICT turns an anomaly (a STALE/NO_DATE/QUERY_ERROR index or a not-Succeeded scheduled job) into a
// non-zero EXIT so the nightly workflow goes RED and pages. Without it the canary is report-only
// (PostHog event + ::warning:: only) -- which is how a frozen index emits to a dashboard nobody watches.
// The nightly-azure-canary workflow runs with --strict; a manual/local run stays report-only by default.
const STRICT = process.argv.includes("--strict") || process.env.AZURE_CANARY_STRICT === "1";

function warn(msg) { console.log(`::warning::[azure-canary] ${msg}`); }

/** Exit-code policy (pure, unit-tested): strict mode pages (exit 1) on any anomaly; default report-only (0). */
export function pageExitCode(summaryOk, strict) { return strict && !summaryOk ? 1 : 0; }

/**
 * PURE freshness verdict for one index. Given the index registry entry, the newest document timestamp
 * (ISO string or null), and "now", classify FRESH / STALE / NO_DATE. Unit-tested; no I/O.
 */
export function assessFreshness(ix, newestIso, nowMs) {
  if (!newestIso) return { index: ix.index, state: "NO_DATE", ageH: null, maxAgeH: ix.max_age_h };
  const ts = Date.parse(newestIso);
  if (Number.isNaN(ts)) return { index: ix.index, state: "NO_DATE", ageH: null, maxAgeH: ix.max_age_h };
  const ageH = (nowMs - ts) / 3_600_000;
  return { index: ix.index, state: ageH <= ix.max_age_h ? "FRESH" : "STALE", ageH: Math.round(ageH * 10) / 10, maxAgeH: ix.max_age_h, newest: newestIso };
}

/** PURE freshness verdict for a PULL-INDEXER-fed room (S1 chunked doc rooms carry no doc timestamp, so
 * freshness = the newest SUCCESSFUL indexer run). newestSuccessIso = newest lastResult.endTime with
 * status 'success' across the room's indexer(s); anyFailed = at least one recent run was not success. */
export function assessIndexerFreshness(ix, newestSuccessIso, anyFailed, nowMs) {
  if (!newestSuccessIso) return { index: ix.index, state: anyFailed ? "FAILED" : "NO_RUN", ageH: null, maxAgeH: ix.max_age_h };
  const ageH = (nowMs - Date.parse(newestSuccessIso)) / 3.6e6;
  if (ageH > ix.max_age_h) return { index: ix.index, state: "STALE", ageH: Math.round(ageH * 10) / 10, maxAgeH: ix.max_age_h, newest: newestSuccessIso };
  return { index: ix.index, state: "FRESH", ageH: Math.round(ageH * 10) / 10, maxAgeH: ix.max_age_h, newest: newestSuccessIso, warnFailed: anyFailed };
}

async function ctoBearer() {
  const cid = await kvSecret("oauth-lane-cto-id");
  const csec = await kvSecret("oauth-lane-cto-secret");
  if (!cid || !csec) throw new Error("cto-lane creds unavailable (oauth-lane-cto-id/secret)");
  const r = await fetch(`${GW}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: cid, client_secret: csec }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error(`cto-lane token mint failed: HTTP ${r.status} ${j.error || ""}`);
  return j.access_token;
}

async function mcpCall(bearer, name, args) {
  const r = await fetch(`${GW}/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const body = await r.text();
  let j = null;
  try { j = JSON.parse(body); } catch { for (const l of body.split("\n")) if (l.startsWith("data:")) { try { j = JSON.parse(l.slice(5)); } catch {} } }
  const err = j?.result?.structuredContent?.error || j?.error;
  if (err) throw new Error(`${name} error: ${err.message || JSON.stringify(err)}`);
  return j?.result?.structuredContent?.result ?? j?.result?.structuredContent ?? null;
}

// --- (5) PER-LANE SYNTHETIC PROBE (2026-07-21) --------------------------------------------------
// Everything above (the dead-job sweep) only ever proves the CTO lane's OAuth client + gateway access
// are healthy -- it is the ONLY lane this file has ever authenticated as. A cfo/clo/developer lane's
// client_credentials can independently break (an expired/rotated secret, a client dropped from the
// gateway's oauth-clients registry -- see setup/oauth-clients-canary.mjs's own regression story -- or a
// ring-gating change that silently empties the rooms a lane is allowed to search) with ZERO sensor
// coverage: "the gateway is up" and "every lane's OAuth client actually works end to end" are different
// claims, and until now only the first one was ever tested. This runs one real brain_search per lane,
// mint-to-response, and classifies it exactly like the other checks in this file (missing creds are a
// SKIP -- a lane that was never provisioned is not an anomaly; a real 4xx/5xx or isError response is one).
export const LANE_PROBE_LANES = ["cto", "cfo", "clo", "developer"];

/** Mint a bearer for an arbitrary lane via the SAME client_credentials flow ctoBearer() uses for cto,
 * generalized to any lane name (oauth-lane-<lane>-id/-secret via the shared kvSecret resolver). Returns
 * null -- not a throw -- when the lane's creds are simply absent from Key Vault, so the caller can tell
 * "never provisioned" (SKIP) apart from "provisioned but the mint failed" (a real anomaly). */
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
  if (!r.ok || !j?.access_token) throw new Error(`token mint HTTP ${r.status}${j?.error ? ` (${j.error})` : ""}`);
  return j.access_token;
}

/**
 * One lane's live brain_search smoke test: mint -> POST /mcp tools/call -> classify. Never throws --
 * every failure mode (absent creds, mint error, transport error, HTTP 4xx/5xx, JSON-RPC isError, a
 * malformed/empty rooms_searched) comes back as a same-shaped { lane, state, ... } record so main() can
 * log and tally uniformly, the same convention as assessFreshness/assessIndexerFreshness above.
 * state: "SKIPPED" (no creds -- not an anomaly) | "OK" | "ERROR" (an anomaly under --strict).
 * Reads only the response ENVELOPE (http status, isError, the rooms_searched NAME list) -- never any
 * matched document's content -- so this stays ring-safe even for the cfo/clo lanes that can see
 * privileged rooms; a lane probe can prove a room resolved without ever reading what is in it.
 */
export async function probeLane(lane) {
  let bearer;
  try {
    bearer = await laneBearer(lane);
  } catch (e) {
    return { lane, state: "ERROR", detail: `token mint failed: ${e.message}` };
  }
  if (!bearer) return { lane, state: "SKIPPED", detail: `oauth-lane-${lane}-id/secret unavailable (lane not provisioned)` };
  try {
    const r = await fetch(`${GW}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "brain_search", arguments: { query: "lane probe", top: 1 } } }),
    });
    const body = await r.text();
    let j = null;
    try { j = JSON.parse(body); } catch { for (const l of body.split("\n")) if (l.startsWith("data:")) { try { j = JSON.parse(l.slice(5)); } catch {} } }
    if (r.status < 200 || r.status >= 300) {
      return { lane, state: "ERROR", httpStatus: r.status, detail: `HTTP ${r.status}` };
    }
    const isError = !!j?.result?.isError;
    if (isError) {
      const msg = j?.result?.content?.[0]?.text || j?.result?.structuredContent?.error?.message || "isError with no detail";
      return { lane, state: "ERROR", httpStatus: r.status, detail: `isError: ${String(msg).slice(0, 160)}` };
    }
    const data = j?.result?.structuredContent?.result ?? null;
    const rooms = data?.rooms_searched;
    if (!Array.isArray(rooms) || rooms.length === 0) {
      return { lane, state: "ERROR", httpStatus: r.status, detail: `rooms_searched empty/missing (${JSON.stringify(rooms)})` };
    }
    return { lane, state: "OK", httpStatus: r.status, rooms_searched: rooms };
  } catch (e) {
    return { lane, state: "ERROR", detail: `request failed: ${e.message}` };
  }
}

// --- azure-sp -> ARM token -> per-service AI Search query key (cached). Read-only query key; never logged. ---
async function armToken() {
  const tid = await kvSecret("azure-sp-tenant-id");
  const cid = await kvSecret("azure-sp-client-id");
  const sec = await kvSecret("azure-sp-client-secret");
  if (!tid || !cid || !sec) throw new Error("azure-sp creds unavailable for ARM listQueryKeys");
  const r = await fetch(`https://login.microsoftonline.com/${tid}/oauth2/v2.0/token`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: cid, client_secret: sec, scope: "https://management.azure.com/.default" }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error(`ARM token mint failed (${r.status})`);
  return j.access_token;
}
const _keyCache = {};
async function searchKeyFor(service) {
  if (_keyCache[service]) return _keyCache[service];
  const tok = await armToken();
  const r = await fetch(`https://management.azure.com/subscriptions/${SUB}/resourceGroups/${SEARCH_RG}/providers/Microsoft.Search/searchServices/${service}/listQueryKeys?api-version=2023-11-01`, { method: "POST", headers: { Authorization: `Bearer ${tok}` } });
  if (!r.ok) throw new Error(`listQueryKeys(${service}) -> ${r.status}`);
  const key = (await r.json()).value?.find((k) => k.key)?.key;
  if (!key) throw new Error(`no query key for ${service}`);
  return (_keyCache[service] = key);
}

// Indexer STATUS is a management-plane read that query keys cannot reach (they only see /docs), so it
// needs an admin key. The canary's identity (MI with Search Service Contributor, or local azure-sp)
// already holds that privilege via ARM listAdminKeys; the key is used ONLY for read-only status GETs
// and is never logged. Cached per service.
const _adminKeyCache = {};
async function searchAdminKeyFor(service) {
  if (_adminKeyCache[service]) return _adminKeyCache[service];
  const tok = await armToken();
  const r = await fetch(`https://management.azure.com/subscriptions/${SUB}/resourceGroups/${SEARCH_RG}/providers/Microsoft.Search/searchServices/${service}/listAdminKeys?api-version=2023-11-01`, { method: "POST", headers: { Authorization: `Bearer ${tok}` } });
  if (!r.ok) throw new Error(`listAdminKeys(${service}) -> ${r.status}`);
  const key = (await r.json()).primaryKey;
  if (!key) throw new Error(`no admin key for ${service}`);
  return (_adminKeyCache[service] = key);
}

/** Newest value of `field` in `index` on `service`, or null. Reads only that one field (metadata, not content). */
async function newestTimestamp(service, index, field) {
  const key = await searchKeyFor(service);
  const r = await fetch(`https://${service}.search.windows.net/indexes/${encodeURIComponent(index)}/docs/search?api-version=2023-11-01`, {
    method: "POST", headers: { "api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({ search: "*", top: 1, orderby: `${field} desc`, select: field }),
  });
  if (!r.ok) throw new Error(`freshness query ${index} -> ${r.status}: ${(await r.text()).slice(0, 120)}`);
  const j = await r.json();
  return j.value?.[0]?.[field] ?? null;
}

/** Newest SUCCESSFUL pull-indexer run for a room. `name` is an exact indexer, or (isPrefix) a prefix
 * matching several (commons has ~15 ixr-commons-* indexers). Reads only run STATUS + endTime, never
 * document content, so it is ring-safe even for the privileged legal/finance rooms. */
async function indexerFreshness(service, name, isPrefix) {
  const key = await searchAdminKeyFor(service); // indexer status needs an admin key (query keys see only /docs)
  let names = [name];
  if (isPrefix) {
    const lr = await fetch(`https://${service}.search.windows.net/indexers?api-version=2023-11-01&$select=name`, { headers: { "api-key": key } });
    names = ((await lr.json()).value || []).map((x) => x.name).filter((n) => n.startsWith(name));
  }
  let newestSuccess = null, anyFailed = false, checked = 0;
  for (const n of names) {
    const r = await fetch(`https://${service}.search.windows.net/indexers/${encodeURIComponent(n)}/status?api-version=2023-11-01`, { headers: { "api-key": key } });
    if (!r.ok) { anyFailed = true; continue; }
    checked++;
    const last = (await r.json()).lastResult;
    if (last?.status === "success" && last.endTime) {
      if (!newestSuccess || Date.parse(last.endTime) > Date.parse(newestSuccess)) newestSuccess = last.endTime;
    } else if (last && last.status && last.status !== "success") anyFailed = true;
  }
  if (!checked && !newestSuccess) throw new Error(`no indexer matched ${isPrefix ? name + "*" : name}`);
  return { newestSuccess, anyFailed };
}

// --- (3) SEMANTIC HEALTH (2026-07-20) -----------------------------------------------------------
// The semantic ranker is the layer whose free-quota 402 SILENTLY took down brain_search + kb_search
// fleet-wide (the CFO FY2021 outage: the shared 1000/mo free semantic quota on the S1 service ran
// out, so every semantic query 402'd for every agent, and NOTHING alerted -- a human hit the wall).
// These two checks make that class of outage loud.

/** PURE verdict on a service's semanticSearch setting. 'standard' = billed, no monthly cap (safe).
 * 'free' = a 1000/mo quota that WILL 402 once exhausted (re-arms the outage). 'disabled'/unset = the
 * ranker is unavailable. Only 'standard' is OK. */
export function assessSemanticSetting(setting) {
  return { ok: setting === "standard", setting: setting || "unset" };
}

/** Service-level semanticSearch setting via ARM control-plane GET. Read-only; no key printed. */
async function semanticSetting(service) {
  const tok = await armToken();
  const r = await fetch(`https://management.azure.com/subscriptions/${SUB}/resourceGroups/${SEARCH_RG}/providers/Microsoft.Search/searchServices/${service}?api-version=2023-11-01`, { headers: { Authorization: `Bearer ${tok}` } });
  if (!r.ok) throw new Error(`GET service ${service} -> ${r.status}`);
  return (await r.json()).properties?.semanticSearch ?? null;
}

/** Run ONE live semantic query (the exact call brain_search/kb_search make) and return its HTTP status.
 * 200 = OK; 402 = free semantic quota exhausted (THE outage); 5xx = service fault. top:1 and we read
 * only the status code, never document content, so it never breaches a ring. */
async function semanticProbe(service, index) {
  const key = await searchKeyFor(service);
  const r = await fetch(`https://${service}.search.windows.net/indexes/${encodeURIComponent(index)}/docs/search?api-version=2023-11-01`, {
    method: "POST", headers: { "api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({ search: "healthcheck", top: 1, queryType: "semantic", semanticConfiguration: "sem" }),
  });
  return r.status;
}

async function emitPosthog(props) {
  try {
    const key = await kvSecret("posthog-fleet-ingest-key");
    const host = process.env.POSTHOG_HOST || "https://us.i.posthog.com";
    if (!key) return;
    await fetch(`${host}/capture/`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: key, event: "azure_canary", distinct_id: "fleet-azure-canary", properties: props }),
    });
  } catch { /* emit is best-effort */ }
}

async function main() {
  const registry = JSON.parse(readFileSync(join(HERE, "..", "..", "setup", "expected-indexes.json"), "utf8"));
  const liveIndexes = registry.indexes || [];
  const tombstoned = (registry.decommissioning || []).map((d) => d.index);
  const streamRegistry = JSON.parse(readFileSync(join(HERE, "..", "..", "setup", "expected-streams.json"), "utf8"));
  const liveStreams = streamRegistry.streams || [];

  const bearer = await ctoBearer();

  // (1) DEAD-JOB SWEEP -- NOW CRON-AWARE.
  //
  // >>> 2026-07-14. This sweep used to ask for `top: 1` -- the LATEST execution, of ANY trigger type.
  // >>> That single word is how `daily-digest` failed TEN CONSECUTIVE SCHEDULED RUNS (2026-07-04 ->
  // >>> 2026-07-13) while every monitor in the fleet reported it healthy. Each time an engineer
  // >>> re-kicked the job by hand to debug it, that MANUAL execution became "the latest execution" and
  // >>> the canary went green. THE ACT OF DEBUGGING LAUNDERED THE FAILURE. Three sessions in a row
  // >>> declared it fixed on the strength of a manual run that passed, while the 23:59 cron kept dying.
  // >>> A MANUAL RE-KICK IS NOT A TEST OF A SCHEDULE.
  // >>>
  // >>> We now pull enough history to find the most recent CRON-TRIGGERED execution and judge THAT --
  // >>> and separately assert that the schedule actually FIRED, because a cron that silently stops
  // >>> producing executions leaves no failed run and no error behind, only a stale green. See
  // >>> ./cron-exec.mjs for how a scheduled execution is identified (its name encodes its cron slot).
  const jl = await mcpCall(bearer, "azure_jobs_list", {});
  const jobs = jl?.jobs || [];
  const scheduled = jobs.filter((j) => j.triggerType === "Schedule");
  const failedJobs = [];
  for (const j of scheduled) {
    try {
      const ex = await mcpCall(bearer, "azure_job_executions", { job_name: j.name, resource_group: j.resourceGroup, top: 30 });
      const execs = ex?.executions || [];
      if (!execs.length) { failedJobs.push(`${j.name}: NO EXECUTIONS EVER`); continue; }
      failedJobs.push(...auditScheduledJob({ name: j.name, executions: execs, nowMs: Date.now() }));
    } catch (e) { failedJobs.push(`${j.name}: executions-query-error (${e.message})`); }
  }

  // (2) per-index freshness
  const now = Date.now();
  const freshness = [];
  const stale = [];
  for (const ix of liveIndexes) {
    try {
      let v;
      if (ix.writer_indexer || ix.writer_indexer_prefix) {
        // S1 chunked doc room: freshness = the newest SUCCESSFUL pull-indexer run (no doc timestamp exists).
        const { newestSuccess, anyFailed } = await indexerFreshness(ix.service, ix.writer_indexer || ix.writer_indexer_prefix, !!ix.writer_indexer_prefix);
        v = assessIndexerFreshness(ix, newestSuccess, anyFailed, now);
        if (v.state === "FRESH" && v.warnFailed) warn(`${ix.index}: newest indexer run OK (${v.ageH}h) but a concurrent run is not success`);
      } else {
        // timestamp-based room (memory-exec has a sortable `ts`).
        v = assessFreshness(ix, await newestTimestamp(ix.service, ix.index, ix.timestamp_field), now);
      }
      freshness.push(v);
      if (v.state !== "FRESH") stale.push(`${ix.index}: ${v.state}${v.ageH != null ? ` (${v.ageH}h > ${v.maxAgeH}h)` : ""}`);
    } catch (e) {
      freshness.push({ index: ix.index, state: "QUERY_ERROR", error: e.message });
      stale.push(`${ix.index}: QUERY_ERROR (${e.message})`);
    }
  }

  // (3) SEMANTIC HEALTH -- billing setting per service + a live semantic query per index (the exact
  // call that 402'd for the CFO). Pages under --strict so a semantic-quota outage can never sit silent.
  const semanticHealth = [];
  const semAnoms = [];
  for (const svc of [...new Set(liveIndexes.map((ix) => ix.service))]) {
    try {
      const v = assessSemanticSetting(await semanticSetting(svc));
      semanticHealth.push({ service: svc, kind: "billing", setting: v.setting, ok: v.ok });
      if (!v.ok) semAnoms.push(`${svc}: semanticSearch='${v.setting}' (must be 'standard'; 'free' re-arms the 402 quota outage)`);
    } catch (e) {
      semanticHealth.push({ service: svc, kind: "billing", state: "ARM_ERROR", error: e.message });
      semAnoms.push(`${svc}: semantic-setting ARM error (${e.message})`);
    }
  }
  for (const ix of liveIndexes) {
    try {
      const status = await semanticProbe(ix.service, ix.index);
      semanticHealth.push({ service: ix.service, index: ix.index, kind: "query", status, ok: status === 200 });
      if (status !== 200) semAnoms.push(`${ix.index}@${ix.service}: semantic query HTTP ${status}${status === 402 ? " (free quota exhausted -> enable standard billing)" : ""}`);
    } catch (e) {
      semanticHealth.push({ service: ix.service, index: ix.index, kind: "query", state: "PROBE_ERROR", error: e.message });
      semAnoms.push(`${ix.index}: semantic-probe error (${e.message})`);
    }
  }

  // (4) PER-STREAM FRESHNESS (W1-5) -- the PostHog-stream sibling of (2). One shared creds resolve (the
  // SAME posthog-personal-api-key / posthog-fleet-project-id fleet-medic already reads); a creds failure
  // marks every stream QUERY_ERROR rather than silently skipping the whole check (dark-sensor discipline
  // applied per-stream, not just at the top level).
  const streamFreshness = [];
  const staleStreams = [];
  const posthogCreds = await resolvePosthogCreds();
  for (const sd of liveStreams) {
    try {
      if (!posthogCreds) throw new Error("posthog-personal-api-key / posthog-fleet-project-id unavailable");
      const { newestIso } = await newestStreamEventTs(sd.stream, posthogCreds);
      const v = assessStreamFreshness(sd, newestIso, now);
      streamFreshness.push(v);
      if (v.state !== "FRESH") staleStreams.push(`${sd.stream}: ${v.state}${v.ageH != null ? ` (${v.ageH}h > ${v.maxAgeH}h)` : " (event never seen)"}`);
    } catch (e) {
      streamFreshness.push({ stream: sd.stream, state: "QUERY_ERROR", error: e.message });
      staleStreams.push(`${sd.stream}: QUERY_ERROR (${e.message})`);
    }
  }

  // (5) PER-LANE SYNTHETIC PROBE -- see probeLane()'s header. A lane with no creds yet is logged as a
  // warning (dark-sensor discipline: never silently skip without a trace) but NOT counted as an anomaly.
  const laneProbes = [];
  const laneAnoms = [];
  for (const lane of LANE_PROBE_LANES) {
    const p = await probeLane(lane);
    laneProbes.push(p);
    if (p.state === "SKIPPED") warn(`lane probe ${lane}: ${p.detail}`);
    else if (p.state === "ERROR") laneAnoms.push(`${lane}: ${p.detail}`);
  }

  const anomalies = [];
  if (failedJobs.length) anomalies.push(`${failedJobs.length} scheduled job(s) not-Succeeded`);
  if (stale.length) anomalies.push(`${stale.length} index(es) not FRESH`);
  if (staleStreams.length) anomalies.push(`${staleStreams.length} PostHog stream(s) not FRESH`);
  if (semAnoms.length) anomalies.push(`${semAnoms.length} semantic-health issue(s)`);
  if (laneAnoms.length) anomalies.push(`${laneAnoms.length} gateway lane probe(s) failed`);

  const summary = {
    ok: anomalies.length === 0,
    jobs_total: jobs.length, jobs_scheduled: scheduled.length, jobs_failed: failedJobs.length, failed_jobs: failedJobs,
    indexes_total: liveIndexes.length,
    indexes_fresh: freshness.filter((f) => f.state === "FRESH").length,
    stale, freshness, tombstoned,
    streams_total: liveStreams.length,
    streams_fresh: streamFreshness.filter((f) => f.state === "FRESH").length,
    stale_streams: staleStreams, stream_freshness: streamFreshness,
    semantic_ok: semAnoms.length === 0, semantic_anomalies: semAnoms, semantic_health: semanticHealth,
    lane_probes_total: LANE_PROBE_LANES.length,
    lane_probes_ok: laneProbes.filter((p) => p.state === "OK").length,
    lane_probes_skipped: laneProbes.filter((p) => p.state === "SKIPPED").length,
    lane_probe_anomalies: laneAnoms, lane_probes: laneProbes,
  };
  await emitPosthog(summary);

  if (JSONOUT) console.log(JSON.stringify(summary, null, 2));
  else {
    console.log(`[azure-canary] jobs ${scheduled.length - failedJobs.length}/${scheduled.length} ok | indexes ${summary.indexes_fresh}/${liveIndexes.length} FRESH | streams ${summary.streams_fresh}/${liveStreams.length} FRESH | semantic ${semAnoms.length ? "ISSUES(" + semAnoms.length + ")" : "OK"} | lanes ${summary.lane_probes_ok}/${LANE_PROBE_LANES.length} OK (${summary.lane_probes_skipped} skipped) | tombstoned: ${tombstoned.join(",") || "none"}`);
    for (const f of freshness) console.log(`  ${f.state.padEnd(12)} ${f.index}${f.ageH != null ? ` (${f.ageH}h/${f.maxAgeH}h)` : ""}${f.error ? " " + f.error : ""}`);
    for (const f of streamFreshness) console.log(`  ${f.state.padEnd(12)} ${f.stream}${f.ageH != null ? ` (${f.ageH}h/${f.maxAgeH}h)` : ""}${f.error ? " " + f.error : ""}`);
    for (const s of semAnoms) console.log(`  SEMANTIC: ${s}`);
    for (const f of failedJobs) console.log(`  DEAD JOB: ${f}`);
    for (const p of laneProbes) console.log(`  LANE ${p.state.padEnd(9)} ${p.lane}${p.rooms_searched ? ` rooms=${p.rooms_searched.join(",")}` : ""}${p.detail ? " " + p.detail : ""}`);
  }
  for (const a of anomalies) warn(a);
  console.log(summary.ok ? "[azure-canary] OK (jobs green, all indexes fresh, all streams fresh, all lane probes OK)" : `[azure-canary] ANOMALIES: ${anomalies.join("; ")}`);
  if (STRICT && !summary.ok) console.error(`::error::[azure-canary] STRICT: paging on the above anomalies (stale index, dead job, dead telemetry stream, or a broken gateway lane); the nightly run goes RED so nothing can sit silent.`);
  process.exit(pageExitCode(summary.ok, STRICT)); // strict => page on anomaly; default => report-only
}

// Only run as a script (not when imported by the test).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(async (e) => {
    await emitPosthog({ ok: false, fatal: true, error: e.message });
    console.error(`::error::[azure-canary] FATAL: ${e.message}`);
    process.exit(1);
  });
}
