#!/usr/bin/env node
// fleet-medic — the auto-dispatch MEDIC for the agent fleet's working memory (superbrain Wave 4).
// Matt's ask: "before I even notice, the medic is auto-dispatched to fix an agent going off the rails."
//
// WHAT IT DOES. A standing monitor (runs on cron as a Container Apps Job, AND on demand) that watches
// every exec agent's MEMORY HEALTH and, the moment an agent is running with its memory OFF, auto-leaves
// a targeted self-heal directive that the agent picks up on its very next prompt (and emits an alert so
// the operator has visibility without watching). Two health signals, each catching a different failure:
//   1. PostHog `memory_beacon` (Fleet Agents project) = the SHARP signal: a FRESH beacon with
//      status=DARK / hooks_wired=false / ledger=0 means the agent is ACTIVE RIGHT NOW with memory off
//      -> the true "off the rails" fire -> DISPATCH.
//   2. `mem.mjs team-health` (the shared exec feed) = the DETERMINISTIC spine for all agents: catches
//      "never initialized" (NO-DATA) and long silence. Staleness alone is only a WATCH (an idle agent
//      is not a broken one), so the medic never cries wolf on a merely-quiet agent.
// Degrades gracefully: if PostHog is unreadable, it still runs on the deterministic team-health spine.
//
// RING-SAFE: reads only health METADATA (agent id, status, age, hook/ledger counts) + the shared feed.
// Never reads a private/clo-personal lane's content. The directive it writes is generic activation
// steps, no secrets. Fail-open: exits 0; a medic that crashes must not be worse than no medic.
//
// STORAGE (ported to S3, 2026-08-27): the medic's directives + state used to live in Azure Blob
// (otchealthcommons/company-journal, account-SAS'd directly in this file). That storage account died
// with the Azure subscription deletion (2026-08-13). Now routes through skills/kb-memory/commons-store.mjs
// (the same facade setup/heartbeat.mjs, fleet-dispatch/dispatch.mjs, sunset-protocol/protocol.mjs, and
// fleet-search/search.mjs use).
//
// CREDS GATE FIX (2026-08-27, alongside the S3 port): the pre-port gates in scan()/check() checked
// `!_saRaw && !process.env.AZURE_SP_CLIENT_ID` -- on an AWS-only seat (ECS task role, no GCP SA, no
// Azure SP env) that condition was ALWAYS TRUE, so the medic exited 0 (its normal fail-open shape) on
// EVERY run without ever scanning anything. This is the exact "component that produces nothing
// produces no error" class fleet-medic itself exists to catch in other agents. The gate now checks
// `awsCredsPresent().any` (skills/kb-memory/aws-secret.mjs) -- the credential the S3 store actually
// needs -- instead of a credential this file no longer uses for storage at all.
//
// Verbs:
//   node medic.mjs scan [--dispatch] [--json]      # classify every agent; --dispatch leaves directives + alerts
//   node medic.mjs check --agent <a>               # print THIS agent's pending directive (for session-start), then ack
//   node medic.mjs clear --agent <a>               # manually clear an agent's directive
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { kvSecret } from "../kb-memory/azure-secret.mjs";
import { awsCredsPresent } from "../kb-memory/aws-secret.mjs";
import { cGet, cPut, cDel } from "../kb-memory/commons-store.mjs";
import { ddMetric } from "../datadog/dd-emit.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const MEDIC_PREFIX = "_MEDIC/";
const EXEC = ["coo", "cfo", "clo", "cto", "capital", "commerce", "compliance", "rainmaker", "growth", "developer"];

const argv = process.argv.slice(2);
const cmd = argv[0];
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const FLAG = (f) => argv.includes(f);

// ---- thresholds (override via env for the job) ----
const BEACON_FRESH_MIN = parseInt(process.env.MEDIC_BEACON_FRESH_MIN || "120", 10) || 120;  // a beacon is "the agent is active NOW" only if this fresh
const STALE_WATCH_MIN  = parseInt(process.env.MEDIC_STALE_WATCH_MIN  || "10080", 10) || 10080; // 7d: below this, silence is just "idle", not "broken"
const COOLDOWN_MIN     = parseInt(process.env.MEDIC_COOLDOWN_MIN     || "360", 10) || 360;   // don't re-dispatch the same agent within 6h
const ESCALATE_AFTER   = parseInt(process.env.MEDIC_ESCALATE_AFTER   || "3", 10) || 3;       // N consecutive DARK dispatches -> escalate to the human

// ============================ PURE CORE (hermetically tested) ============================
// classify(): given the two health signals + prior medic state + now, decide each agent's condition and
// whether to dispatch. No I/O -> deterministic + unit-testable. This is the brain of the auto-medic.
//   health:  [{agent, status:"LIVE"|"STALE"|"NO-DATA", last_shared_age_min}]
//   beacons: { agent: {status:"LIVE"|"DARK", age_min, hooks_wired:bool, ledger_size:int} }
//   state:   { agent: {last_dispatch_ts, consecutive_dark} }
// returns:  [{agent, condition:"HEALTHY"|"WATCH"|"DARK"|"NO-MEMORY", severity, dispatch, escalate, reason}]
export function classify(health, beacons, state, now, opts = {}) {
  const beaconFresh = opts.beaconFreshMin ?? BEACON_FRESH_MIN;
  const staleWatch = opts.staleWatchMin ?? STALE_WATCH_MIN;
  const cooldown = opts.cooldownMin ?? COOLDOWN_MIN;
  const escalateAfter = opts.escalateAfter ?? ESCALATE_AFTER;
  const hByAgent = {}; for (const h of (health || [])) hByAgent[h.agent] = h;
  const agents = [...new Set([...(opts.roster || EXEC), ...Object.keys(hByAgent), ...Object.keys(beacons || {})])];
  const out = [];
  for (const agent of agents) {
    const h = hByAgent[agent];
    const b = (beacons || {})[agent];
    const freshBeacon = b && typeof b.age_min === "number" && b.age_min <= beaconFresh ? b : null;
    const st = (state || {})[agent] || { last_dispatch_ts: 0, consecutive_dark: 0 };
    const sinceDispatch = st.last_dispatch_ts ? (now - Date.parse(st.last_dispatch_ts)) / 60000 : Infinity;

    let condition = "WATCH", severity = "low", reason = "";
    // 1. SHARP: an active session (fresh beacon) whose memory is OFF -> the real fire.
    if (freshBeacon && (freshBeacon.status === "DARK" || freshBeacon.hooks_wired === false || freshBeacon.ledger_size === 0)) {
      condition = "DARK"; severity = "high";
      reason = `active session with memory OFF (${freshBeacon.hooks_wired === false ? "hooks unwired" : freshBeacon.ledger_size === 0 ? "ledger empty" : "beacon DARK"}, ${freshBeacon.age_min}m ago)`;
    }
    // 2. A healthy fresh beacon, or a recent shared write -> HEALTHY (memory is functioning).
    else if ((freshBeacon && freshBeacon.status === "LIVE") || (h && h.status === "LIVE")) {
      condition = "HEALTHY"; severity = "ok";
      reason = freshBeacon ? `LIVE beacon ${freshBeacon.age_min}m ago, ledger=${freshBeacon.ledger_size}` : `shared write ${h.last_shared_age_min}m ago`;
    }
    // 3. Never shared at all + no beacon -> uninitialized memory (NO-MEMORY). Dispatch a gentle claim.
    else if (h && h.status === "NO-DATA" && !b) {
      condition = "NO-MEMORY"; severity = "high"; reason = "no memory signal at all (never wrote a shared entry, no beacon)";
    }
    // 4. STALE beyond the watch window with no fresh life -> note it, but DO NOT dispatch (likely idle).
    else if (h && h.status === "STALE" && h.last_shared_age_min > staleWatch) {
      condition = "WATCH"; severity = "low"; reason = `no shared activity in ${Math.round(h.last_shared_age_min / 1440)}d (may just be idle)`;
    }
    else { condition = "WATCH"; severity = "low"; reason = h ? `${h.status} (${Math.round((h.last_shared_age_min || 0) / 60)}h)` : "no signal"; }

    const wantsDispatch = condition === "DARK" || condition === "NO-MEMORY";
    const dispatch = wantsDispatch && sinceDispatch >= cooldown;       // respect cooldown so we don't spam
    const consecutive_dark = wantsDispatch ? (st.consecutive_dark || 0) + (dispatch ? 1 : 0) : 0;
    const escalate = wantsDispatch && consecutive_dark >= escalateAfter;
    out.push({ agent, condition, severity, dispatch, escalate, reason, consecutive_dark, cooled_down: wantsDispatch && !dispatch });
  }
  return out.sort((a, b) => ({ high: 0, low: 1, ok: 2 }[a.severity] - { high: 0, low: 1, ok: 2 }[b.severity]) || a.agent.localeCompare(b.agent));
}

// The remediation an agent self-applies on its next prompt. Generic activation steps (no secrets).
export function remediationFor(agent, item, nowIso) {
  return `# MEDIC DIRECTIVE for ${agent.toUpperCase()}  (auto-dispatched ${nowIso})

The fleet medic detected that THIS agent's working memory looks OFF:
  ${item.reason}

Restore it NOW (3 steps, ~10 seconds), then continue what you were doing:
\`\`\`
git -C /tmp/octools fetch origin main && git -C /tmp/octools reset --hard origin/main
node /tmp/octools/skills/kb-memory/mem.mjs use ${agent}
node /tmp/octools/skills/kb-memory/mem.mjs whoami --agent ${agent}     # expect RESULT: PASS
\`\`\`
If whoami still fails: the service account is missing -> run /tmp/octools/setup/session-start.sh, then retry.
Once whoami is PASS, your ledger + per-prompt recall are back ON. This directive auto-clears after you read it.
`;
}

// =============================== I/O (creds, PostHog) ===============================
// sm(): kvSecret() ALREADY defaults to AWS SSM (/otchealth/*, the store of record since the Azure
// subscription deletion) and never throws, so the old GCP-Secret-Manager fallback leg (a hand-rolled
// JWT + oauth2.googleapis.com token exchange) is dead weight -- SSM is tried before Key Vault would
// ever be reached anyway. Kept as a thin, exported wrapper (not inlined at call sites) purely so a
// future secret-resolution change lands in one place.
export async function sm(id) { return kvSecret(id); }

// team-health from the canonical source: exec mem.mjs (DRY - one health definition). Robust path probe.
function readHealth() {
  const cands = [join(HERE, "..", "kb-memory", "mem.mjs"), `${homedir()}/.claude/skills/kb-memory/mem.mjs`, "/tmp/octools/skills/kb-memory/mem.mjs"];
  for (const p of cands) { if (!existsSync(p)) continue; try { const out = execFileSync("node", [p, "team-health", "--json", "--agent", "cto"], { encoding: "utf8", timeout: 60000 }); return JSON.parse(out); } catch {} }
  return [];
}
// PostHog memory_beacon per agent (the sharp signal). Best-effort: returns {} if PostHog is unreadable.
async function readBeacons() {
  try {
    const KEY = await sm("posthog-personal-api-key"), PID = await sm("posthog-fleet-project-id");
    if (!KEY || !PID) return {};
    const hql = `SELECT properties.agent AS agent, argMax(properties.status, timestamp) AS status, max(timestamp) AS last, argMax(properties.hooks_wired, timestamp) AS hooks, argMax(properties.ledger_size, timestamp) AS ledger FROM events WHERE event='memory_beacon' AND timestamp > now() - INTERVAL 3 DAY GROUP BY properties.agent`;
    const r = await fetch(`https://us.posthog.com/api/projects/${PID}/query/`, { method: "POST", headers: { Authorization: "Bearer " + KEY, "Content-Type": "application/json" }, body: JSON.stringify({ query: { kind: "HogQLQuery", query: hql } }) });
    if (!r.ok) return {};
    const rows = (await r.json()).results || [];
    const out = {};
    for (const [agent, status, last, hooks, ledger] of rows) {
      if (!agent) continue;
      out[String(agent).toLowerCase()] = { status, age_min: last ? Math.round((Date.now() - Date.parse(last)) / 60000) : null, hooks_wired: hooks === true || hooks === "true", ledger_size: typeof ledger === "number" ? ledger : parseInt(ledger || "0", 10) || 0 };
    }
    return out;
  } catch { return {}; }
}
// Returns true iff the PostHog capture genuinely succeeded (HTTP ok). Never throws (fail-open for the
// CALLER's control flow), but unlike the pre-fix version it never SILENTLY swallows a failure either:
// every non-ok response or thrown error is retried a couple of times, then logged LOUD to stderr so a
// failure is visible in plain container logs even with no Log Analytics sink wired (see canary/medic
// history — this is the exact "Succeeded status, zero visible effect" class of bug). Missing ingestKey
// (the secret itself failed to resolve) is also now a loud, distinct failure instead of a quiet return.
async function emitDispatch(ingestKey, agent, item) {
  if (!ingestKey) {
    console.error(`  [fleet-medic] POSTHOG CAPTURE SKIPPED for ${agent}: posthog-fleet-ingest-key did not resolve`);
    return false;
  }
  const body = JSON.stringify({ api_key: ingestKey, event: "medic_dispatch", distinct_id: agent, timestamp: new Date().toISOString(), properties: { agent, condition: item.condition, severity: item.severity, escalate: item.escalate, reason: item.reason, $lib: "fleet-medic" } });
  const ATTEMPTS = 3;
  let lastErr = "unknown";
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const r = await fetch("https://us.i.posthog.com/capture/", { method: "POST", headers: { "Content-Type": "application/json" }, body });
      if (r.ok) return true;
      lastErr = `HTTP ${r.status} ${(await r.text().catch(() => "")).slice(0, 200)}`.trim();
    } catch (e) {
      lastErr = e && e.message || String(e);
    }
    if (attempt < ATTEMPTS) await new Promise((res) => setTimeout(res, 400 * attempt)); // short backoff, not a full withRetry
  }
  console.error(`  [fleet-medic] POSTHOG CAPTURE FAILED for ${agent} after ${ATTEMPTS} attempts: ${lastErr}`);
  return false;
}

// otc.fleet.agent_error emission (2026-08-18) — closes the Datadog monitor "AI Fleet — agent errors
// (1h)" (id 22893313, sum:otc.fleet.agent_error{*}.as_count() > 0), which has shown "No Data" since
// it was created 2026-06-27 because nothing in the codebase ever emitted this metric (confirmed by a
// repo-wide grep). fleet-medic's classify() is exactly "where errors are already known" for an
// AGENT (as opposed to a scheduled JOB, which skills/azure-canary/canary.mjs already watches
// separately) — DARK (an active session running with memory OFF) and NO-MEMORY (never initialized)
// are real per-agent error conditions, not mere staleness (WATCH), so they map directly onto "agent
// error" without inventing a new detection mechanism.
//
// Emits ONE point per agent EVERY scan, value 1 (errored this scan) or 0 (not errored), tagged
// agent:<name>. This is deliberate, not merely "emit on error": a count metric with NOTHING
// submitted during a healthy stretch reads as "No Data" in Datadog exactly like this monitor's
// original bug, so a 0-value point is what keeps the monitor's data continuous through the common
// case (zero errors) and lets `.as_count() > 0` mean what it says. Runs on every `scan` call
// (dispatch or not) — the classification is already computed either way, and the existing production
// job already runs `scan --dispatch` every ~30 min (skills/doc-indexer/job/fleet-medic.sh), so this
// rides that schedule with NO change needed to the job itself. MEDIC_SKIP_METRICS=1 is an escape
// hatch if this ever needs disabling without a code change.
//
// LOUD ON FAILURE: unlike emitDispatch()'s PostHog capture (which is also retried+checked, see its
// own header), a Datadog send failure here does not change medic's overall fail-open exit-0 policy
// (a broken medic must not be worse than none) — but it prints a distinct, greppable error line per
// failed agent AND is counted into the run summary printed at the end of scan(), the same
// "N ok, M failed" visibility pattern emitDispatch()'s fix established. A run that "Succeeded" while
// silently losing this telemetry must never look identical to a real one in plain container logs.
export async function emitAgentErrorMetrics(results) {
  if (process.env.MEDIC_SKIP_METRICS === "1") return { emitted: 0, failed: 0, skipped: true };
  let emitted = 0, failed = 0;
  for (const r of results) {
    const isError = r.condition === "DARK" || r.condition === "NO-MEMORY";
    const res = await ddMetric("otc.fleet.agent_error", isError ? 1 : 0, {
      tags: [`agent:${r.agent}`, "job:fleet-medic", `condition:${r.condition}`],
      type: "count",
    });
    if (res.ok) emitted++;
    else { failed++; console.error(`  [fleet-medic] METRIC EMIT FAILED for agent_error{agent:${r.agent}}: ${res.error}`); }
  }
  return { emitted, failed, skipped: false };
}

// ================================== commands ==================================
async function scan() {
  if (!awsCredsPresent().any) { console.error("fleet-medic: no AWS credentials (checked the ECS task role, AWS_ACCESS_KEY_ID/SECRET, OTC_AWS_ACCESS_KEY_ID/SECRET); cannot reach the commons S3 store, so cannot scan."); process.exit(0); }
  const health = readHealth();
  const beacons = await readBeacons();
  let state = {}; try { const t = await cGet(`${MEDIC_PREFIX}_state.json`); if (t) state = JSON.parse(t); } catch {}
  const now = Date.now();
  const results = classify(health, beacons, state, now);
  const dispatching = FLAG("--dispatch");

  if (FLAG("--json")) { console.log(JSON.stringify({ ts: new Date(now).toISOString(), beacons_seen: Object.keys(beacons).length, results }, null, 2)); }
  else {
    console.log(`# FLEET MEDIC scan ${new Date(now).toISOString()}  (beacons: ${Object.keys(beacons).length}; ${dispatching ? "DISPATCH" : "dry-run"})`);
    for (const r of results) {
      const tag = r.condition === "HEALTHY" ? "  ok " : r.condition === "WATCH" ? "watch" : "DARK!";
      const act = r.dispatch ? " -> DISPATCH" : r.cooled_down ? " (cooldown)" : "";
      console.log(`[${tag}] ${r.agent.padEnd(11)} ${r.condition.padEnd(10)} ${act.padEnd(13)} ${r.reason}`);
    }
  }

  const metricSummary = await emitAgentErrorMetrics(results);
  if (!metricSummary.skipped) {
    console.log(`[fleet-medic] agent_error metrics: ${metricSummary.emitted} emitted, ${metricSummary.failed} failed (of ${results.length} agents)`);
  }

  if (!dispatching) return;
  const ingestKey = await sm("posthog-fleet-ingest-key");
  const nowIso = new Date(now).toISOString();
  const escalations = [];
  const newState = { ...state };
  let captureOk = 0, captureFail = 0;
  for (const r of results) {
    if (r.dispatch) {
      try { await cPut(`${MEDIC_PREFIX}${r.agent}.md`, remediationFor(r.agent, r, nowIso), "text/markdown; charset=utf-8"); } catch (e) { console.error(`  dispatch ${r.agent}: directive write failed (${e.message})`); }
      // The self-heal directive above is the actual fix and is written regardless; `captured` reflects
      // ONLY whether the PostHog telemetry event (the thing that makes this dispatch visible off-box)
      // made it. Do NOT claim "DISPATCHED" when that capture failed — say so plainly instead, so a run
      // that "Succeeded" but produced zero visible telemetry is never indistinguishable from a real one.
      const captured = await emitDispatch(ingestKey, r.agent, r);
      if (captured) captureOk++; else captureFail++;
      newState[r.agent] = { last_dispatch_ts: nowIso, consecutive_dark: r.consecutive_dark };
      console.error(`  ${captured ? "DISPATCHED" : "DISPATCH FAILED (capture)"} medic -> ${r.agent}: ${r.reason}${r.escalate ? "  [ESCALATE]" : ""}`);
      if (r.escalate) escalations.push(r);
    } else if (r.condition === "HEALTHY" && newState[r.agent]) {
      newState[r.agent] = { last_dispatch_ts: newState[r.agent].last_dispatch_ts, consecutive_dark: 0 }; // recovered -> reset the streak
    }
  }
  try { await cPut(`${MEDIC_PREFIX}_state.json`, JSON.stringify(newState, null, 1), "application/json"); } catch {}
  if (escalations.length) {
    // persistent failures the self-heal directive did not resolve -> a single operator-facing alert.
    const line = `MEDIC ESCALATION ${nowIso}: ${escalations.map((e) => `${e.agent} (${e.consecutive_dark}x DARK: ${e.reason})`).join("; ")}. Self-heal directive left; needs a human/medic-session look.`;
    try { await cPut(`${MEDIC_PREFIX}_ESCALATIONS.md`, line + "\n", "text/markdown; charset=utf-8"); } catch {}
    if (await emitDispatch(ingestKey, "fleet", { condition: "ESCALATION", severity: "high", escalate: true, reason: line })) captureOk++; else captureFail++;
    console.log("\n" + line);
  }
  // Visible-at-a-glance summary so a partial failure (job "Succeeded", some/all telemetry silently
  // lost) shows up in plain container logs without needing a Log Analytics query.
  console.log(`[fleet-medic] run complete: ${captureOk} dispatched successfully, ${captureFail} capture failures`);
}

async function check() {
  const agent = (val("--agent", "") || process.env.KB_AGENT || "").toLowerCase();
  if (!agent || !awsCredsPresent().any) process.exit(0);
  try {
    const t = await cGet(`${MEDIC_PREFIX}${agent}.md`);
    if (!t) process.exit(0);
    process.stdout.write("\n================= FLEET MEDIC: PENDING SELF-HEAL =================\n" + t + "=================================================================\n");
    await cDel(`${MEDIC_PREFIX}${agent}.md`); // ack: surface once, then clear (idempotent on next session)
  } catch { /* fail-open */ }
  process.exit(0);
}

async function clear() {
  const agent = (val("--agent", "") || "").toLowerCase();
  if (!agent) { console.error("usage: medic.mjs clear --agent <a>"); process.exit(2); }
  await cDel(`${MEDIC_PREFIX}${agent}.md`);
  console.log(`cleared medic directive for ${agent}`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  (async () => {
    try {
      if (cmd === "scan") await scan();
      else if (cmd === "check") await check();
      else if (cmd === "clear") await clear();
      else { console.error('usage: medic.mjs scan [--dispatch] [--json] | check --agent <a> | clear --agent <a>'); process.exit(2); }
    } catch (e) { console.error("fleet-medic ERROR: " + e.message); process.exit(0); } // fail-open: a broken medic must not be worse than none
  })();
}
