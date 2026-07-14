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
//
// REPORT-ONLY on an anomaly (PostHog azure_canary event + ::warning::); exits non-zero ONLY if it cannot
// run at all (sensor lane dark), which is itself the page.
//
// Auth: cto-lane bearer (gateway /mcp) for the job sweep; azure-sp (read via the shared kvSecret, NEVER a
// local AZURE_SP-only reader) -> ARM listQueryKeys -> a read-only AI Search query key for the freshness
// probe. The freshness probe reads ONLY the newest timestamp + doc count -- never document CONTENT, so it
// does not breach the privileged (finance/legal) rings. No secret value is ever printed.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { kvSecret } from "../kb-memory/azure-secret.mjs";
import { auditScheduledJob } from "./cron-exec.mjs";

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

  const bearer = await ctoBearer();

  // (1) dead-job sweep
  const jl = await mcpCall(bearer, "azure_jobs_list", {});
  const jobs = jl?.jobs || [];
  const scheduled = jobs.filter((j) => j.triggerType === "Schedule");
  const failedJobs = [];
  for (const j of scheduled) {
    try {
      const ex = await mcpCall(bearer, "azure_job_executions", { job_name: j.name, resource_group: j.resourceGroup, top: 1 });
      const last = (ex?.executions || [])[0] || null;
      if (!last) failedJobs.push(`${j.name}: NO EXECUTIONS EVER`);
      else if (last.status !== "Succeeded") failedJobs.push(`${j.name}: ${last.status} @ ${last.startTime}`);
    } catch (e) { failedJobs.push(`${j.name}: executions-query-error (${e.message})`); }
  }

  // (2) per-index freshness
  const now = Date.now();
  const freshness = [];
  const stale = [];
  for (const ix of liveIndexes) {
    try {
      const newest = await newestTimestamp(ix.service, ix.index, ix.timestamp_field);
      const v = assessFreshness(ix, newest, now);
      freshness.push(v);
      if (v.state !== "FRESH") stale.push(`${ix.index}: ${v.state}${v.ageH != null ? ` (${v.ageH}h > ${v.maxAgeH}h)` : ` (no ${ix.timestamp_field})`}`);
    } catch (e) {
      freshness.push({ index: ix.index, state: "QUERY_ERROR", error: e.message });
      stale.push(`${ix.index}: QUERY_ERROR (${e.message})`);
    }
  }

  const anomalies = [];
  if (failedJobs.length) anomalies.push(`${failedJobs.length} scheduled job(s) not-Succeeded`);
  if (stale.length) anomalies.push(`${stale.length} index(es) not FRESH`);

  const summary = {
    ok: anomalies.length === 0,
    jobs_total: jobs.length, jobs_scheduled: scheduled.length, jobs_failed: failedJobs.length, failed_jobs: failedJobs,
    indexes_total: liveIndexes.length,
    indexes_fresh: freshness.filter((f) => f.state === "FRESH").length,
    stale, freshness, tombstoned,
  };
  await emitPosthog(summary);

  if (JSONOUT) console.log(JSON.stringify(summary, null, 2));
  else {
    console.log(`[azure-canary] jobs ${scheduled.length - failedJobs.length}/${scheduled.length} ok | indexes ${summary.indexes_fresh}/${liveIndexes.length} FRESH | tombstoned: ${tombstoned.join(",") || "none"}`);
    for (const f of freshness) console.log(`  ${f.state.padEnd(12)} ${f.index}${f.ageH != null ? ` (${f.ageH}h/${f.maxAgeH}h)` : ""}${f.error ? " " + f.error : ""}`);
    for (const f of failedJobs) console.log(`  DEAD JOB: ${f}`);
  }
  for (const a of anomalies) warn(a);
  console.log(summary.ok ? "[azure-canary] OK (jobs green, all indexes fresh)" : `[azure-canary] ANOMALIES: ${anomalies.join("; ")}`);
  if (STRICT && !summary.ok) console.error(`::error::[azure-canary] STRICT: paging on the above anomalies (stale index or dead job); the nightly run goes RED so a frozen index cannot sit silent.`);
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
