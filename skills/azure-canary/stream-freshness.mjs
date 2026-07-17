// stream-freshness.mjs -- W1-5 FLYWHEEL SELF-MONITORING. Freshness SLOs for the PostHog telemetry
// streams the fleet's self-improving loop depends on (eval_result, $ai_generation, agent_session,
// medic_dispatch). Mirrors azure-canary.mjs's own assessFreshness() for Azure AI Search indexes, but
// the sensor here is a PostHog HogQL query (max(timestamp) per event) instead of an AI Search
// `docs/search` call -- the streams live in PostHog, not in an index.
//
// WHY THIS EXISTS: on 2026-07-17 (while wiring this check) we found `$ai_generation` / `agent_session`
// (fleet-telemetry's Stop-hook emit) had gone SILENT for ~367 HOURS (~15 days) fleet-wide, and
// `medic_dispatch` for ~331 hours (~14 days) -- exactly the failure this task exists to catch ("a dead
// telemetry/eval/medic stream pages within 24h, not 15 days"). Nothing had been watching those streams'
// FRESHNESS at all; only their per-event shape was ever asserted (e.g. groundedness-injection.test.mjs),
// never "is this stream still alive." This is the same blind spot class as the pre-2026-07-13 AI Search
// doc-count floor: a dead stream just stops, and a floor/shape-only check never notices silence.
//
// MEDIC_DISPATCH IS A DIFFERENT SHAPE OF STREAM, ON PURPOSE. eval_result / $ai_generation / agent_session
// are near-continuous (a daily cron, or every agent session) -- silence past ~2 days is unambiguously bad.
// medic_dispatch only fires when fleet-medic actually DISPATCHES or ESCALATES (see skills/fleet-medic/
// medic.mjs classify()); zero dispatches across a healthy fleet is GOOD news, not staleness. Its
// max_age_h is deliberately set much longer (see setup/expected-streams.json's note) and framed as a
// belt-and-suspenders check on the MEDIC'S OWN detection capability (a job that runs green but silently
// stops finding real problems), NOT "the medic must nag every day." The medic JOB's liveness itself
// (is fleet-medic's scheduled Container Apps Job still Succeeded) is already covered by canary.mjs's
// existing dead-job pager -- this is a secondary signal, not the primary one.
//
// Reads ONLY the newest event timestamp + count per stream (metadata), never event property CONTENT --
// same privacy posture as the AI Search freshness probe. Non-PHI (Fleet Agents project only).
import { kvSecret } from "../kb-memory/azure-secret.mjs";

/**
 * PURE freshness verdict for one PostHog stream. Mirrors canary.mjs's assessFreshness(ix, newestIso,
 * nowMs) exactly (same states: FRESH / STALE / NO_DATE), so the two checks read identically in the
 * summary + are unit-tested the same way. `newestIso` is the newest event's ISO timestamp (or null if
 * the stream has ZERO events ever, or the query failed to find one).
 * @param {{stream: string, max_age_h: number}} streamDef
 * @param {string|null} newestIso
 * @param {number} nowMs
 */
export function assessStreamFreshness(streamDef, newestIso, nowMs) {
  if (!newestIso) return { stream: streamDef.stream, state: "NO_DATA", ageH: null, maxAgeH: streamDef.max_age_h };
  const ts = Date.parse(newestIso);
  if (Number.isNaN(ts)) return { stream: streamDef.stream, state: "NO_DATA", ageH: null, maxAgeH: streamDef.max_age_h };
  const ageH = (nowMs - ts) / 3_600_000;
  return {
    stream: streamDef.stream,
    state: ageH <= streamDef.max_age_h ? "FRESH" : "STALE",
    ageH: Math.round(ageH * 10) / 10,
    maxAgeH: streamDef.max_age_h,
    newest: newestIso,
  };
}

// HogQL string-literal escaping: PostHog's query endpoint takes a raw HogQL string, so an event name
// containing a single quote (none of ours do, but $ai_generation's `$` is fine unescaped in a string
// literal) must have its OWN quotes escaped. Defensive, not currently load-bearing.
function hogqlLiteral(s) { return `'${String(s).replace(/'/g, "\\'")}'`; }

/**
 * Query PostHog for the newest timestamp + total count of one event over a lookback window. Returns
 * { newestIso, count } (newestIso is null if the event never fired in the window). Throws on a genuine
 * query error (bad creds, PostHog down) so the caller can classify it as QUERY_ERROR, matching
 * canary.mjs's existing per-index try/catch pattern for AI Search freshness queries.
 */
export async function newestStreamEventTs(eventName, { key, projectId, lookbackDays = 90, fetchImpl = fetch } = {}) {
  const hql = `SELECT max(timestamp) AS newest, count() AS n FROM events WHERE event=${hogqlLiteral(eventName)} AND timestamp > now() - INTERVAL ${Number(lookbackDays) || 90} DAY`;
  const r = await fetchImpl(`https://us.posthog.com/api/projects/${projectId}/query/`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: { kind: "HogQLQuery", query: hql } }),
  });
  if (!r.ok) throw new Error(`posthog query ${eventName} -> ${r.status}: ${(await r.text()).slice(0, 160)}`);
  const j = await r.json();
  const row = (j.results || [])[0] || [];
  const rawNewest = row[0] || null;
  // PostHog's ClickHouse DateTime64 renders as "YYYY-MM-DD HH:MM:SS.ffffff" (space, no Z) rather than
  // strict ISO 8601 -- Date.parse() on that form is engine-dependent, so normalize before returning.
  const newestIso = rawNewest ? new Date(String(rawNewest).replace(" ", "T") + (String(rawNewest).endsWith("Z") ? "" : "Z")).toISOString() : null;
  return { newestIso, count: row[1] || 0 };
}

/**
 * Resolve the shared Fleet Agents PostHog creds (personal API key + project id) the SAME way
 * fleet-medic's readBeacons() does. Returns null if either secret is unavailable (caller treats the
 * whole stream-freshness check as a QUERY_ERROR-per-stream, never a silent skip).
 */
export async function resolvePosthogCreds() {
  const key = await kvSecret("posthog-personal-api-key");
  const projectId = await kvSecret("posthog-fleet-project-id");
  if (!key || !projectId) return null;
  return { key, projectId };
}
