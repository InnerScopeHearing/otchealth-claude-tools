#!/usr/bin/env node
// canary.mjs -- the Azure control-plane freshness + dead-job CANARY (ITEM #2 Phase A, DoD item 5).
//
// The 6 Azure read tools (azure_jobs_list / azure_job_executions / azure_search_index_stats / ...) shipped
// in gateway PR #101 are the SENSORS. This is the MONITOR that makes their silence page us: it calls them
// the way the Chat CTO does -- a cto-lane client_credentials bearer against the live gateway /mcp over
// public HTTPS -- and raises a signal if:
//   (1) the tools are unreachable / erroring (the gateway is down, or the MI lost its RBAC), OR
//   (2) any scheduled Container Apps Job's latest run != Succeeded (the dead-job pager -- the exact
//       failure family that let daily-digest fail silently for 9 days), OR
//   (3) the otchealth-brain index doc count fell below a floor (the freshness canary -- a broken
//       reindex / emptied index).
// REPORT-ONLY: it never exits non-zero on an anomaly (the PostHog event + the ::warning:: line ARE the
// alert, same model as nightly-recall-eval). It exits non-zero ONLY if it cannot run at all (no creds /
// gateway unreachable), which is itself a page-worthy signal that the sensor lane is dark.
//
// Auth: cto-lane creds from Key Vault via kvSecret (managed-identity / azure-sp / az-cli resolver -- NEVER
// a local AZURE_SP-only reader). No secret value is ever printed.
import { kvSecret } from "../kb-memory/azure-secret.mjs";

const GW = process.env.GATEWAY_BASE_URL || "https://mcp.otchealth.app";
const BRAIN_FLOOR = parseInt(process.env.AZURE_CANARY_BRAIN_FLOOR || "60000", 10);
const JSONOUT = process.argv.includes("--json");

function warn(msg) { console.log(`::warning::[azure-canary] ${msg}`); }

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

async function emitPosthog(props) {
  try {
    const key = await kvSecret("posthog-fleet-ingest-key");
    const host = process.env.POSTHOG_HOST || "https://us.i.posthog.com";
    if (!key) return;
    await fetch(`${host}/capture/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: key, event: "azure_canary", distinct_id: "fleet-azure-canary", properties: props }),
    });
  } catch { /* emit is best-effort; never fail the canary on telemetry */ }
}

async function main() {
  const bearer = await ctoBearer();

  // (1) reachability + jobs
  const jl = await mcpCall(bearer, "azure_jobs_list", {});
  const jobs = jl?.jobs || [];
  const scheduled = jobs.filter((j) => j.triggerType === "Schedule");

  // (2) dead-job sweep (dogfoods azure_job_executions)
  const failed = [];
  for (const j of scheduled) {
    let last = null;
    try {
      const ex = await mcpCall(bearer, "azure_job_executions", { job_name: j.name, resource_group: j.resourceGroup, top: 1 });
      last = (ex?.executions || [])[0] || null;
    } catch (e) { failed.push(`${j.name}: executions-query-error (${e.message})`); continue; }
    if (!last) failed.push(`${j.name}: NO EXECUTIONS EVER`);
    else if (last.status !== "Succeeded") failed.push(`${j.name}: ${last.status} @ ${last.startTime}`);
  }

  // (3) freshness canary
  const brain = await mcpCall(bearer, "azure_search_index_stats", { index: "otchealth-brain" });
  const mem = await mcpCall(bearer, "azure_search_index_stats", { index: "memory-exec" }).catch(() => null);
  const brainDocs = brain?.documentCount ?? 0;
  const brainBelowFloor = brainDocs < BRAIN_FLOOR;

  const anomalies = [];
  if (failed.length) anomalies.push(`${failed.length} scheduled job(s) not-Succeeded`);
  if (brainBelowFloor) anomalies.push(`otchealth-brain doc count ${brainDocs} < floor ${BRAIN_FLOOR}`);

  const summary = {
    ok: anomalies.length === 0,
    jobs_total: jobs.length,
    jobs_scheduled: scheduled.length,
    jobs_failed: failed.length,
    failed_names: failed,
    brain_docs: brainDocs,
    memory_exec_docs: mem?.documentCount ?? null,
    brain_below_floor: brainBelowFloor,
  };
  await emitPosthog(summary);

  if (JSONOUT) console.log(JSON.stringify(summary, null, 2));
  else {
    console.log(`[azure-canary] jobs=${jobs.length} scheduled=${scheduled.length} failed=${failed.length} | brain=${brainDocs} memory-exec=${summary.memory_exec_docs}`);
    for (const f of failed) console.log(`  FAILED: ${f}`);
  }
  for (const a of anomalies) warn(a);
  console.log(summary.ok ? "[azure-canary] OK (all sensors green)" : `[azure-canary] ANOMALIES: ${anomalies.join("; ")}`);
  // Report-only: exit 0 even on an anomaly (the PostHog event + ::warning:: are the alert).
  process.exit(0);
}

main().catch(async (e) => {
  // Cannot run at all -> the sensor lane itself is dark. THAT is page-worthy: emit + exit non-zero.
  await emitPosthog({ ok: false, fatal: true, error: e.message });
  console.error(`::error::[azure-canary] FATAL: ${e.message}`);
  process.exit(1);
});
