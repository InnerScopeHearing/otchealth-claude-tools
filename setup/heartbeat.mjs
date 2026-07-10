#!/usr/bin/env node
// heartbeat.mjs — fleet dead-man's-switch (P0 stability, 2026-07-04). Every scheduled job/agent
// emits a 'start' + 'ok' (or 'fail') beat to durable Blob; a single watcher treats SILENCE as failure.
// Storage: otchealthcommons/company-journal/_HEARTBEAT/<job>.json (non-PHI, shared ops plane).
// Creds: Azure Key Vault via AZURE_SP_* (fail-loud). Dependency-free (node builtins + fetch).
//
// Usage:
//   node setup/heartbeat.mjs beat <job> <start|ok|fail> [--detail "..."]
//   node setup/heartbeat.mjs check [--json] [--dry-run]      # LIVE/LATE/DEAD/NO-DATA per expected-interval registry
//     --dry-run: for any DEAD job with auto_restart:true, LOG the restart that WOULD happen instead of
//     calling ARM. Safe default for verifying auto-restart behavior before it fires for real. The nightly
//     cron should be run with --dry-run until a human has reviewed at least one dry-run report (see
//     HB-AUTORESTART notes below).
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { kvSecret } from "../skills/kb-memory/azure-secret.mjs";
const HERE = dirname(fileURLToPath(import.meta.url));
const CONTAINER = "company-journal";
const PREFIX = "_HEARTBEAT/";
const argv = process.argv.slice(2);
const cmd = argv[0];
const takeVal = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };

function buildSas(acct, key, perm) {
  const sv = "2021-12-02", ss = "b", srt = "co";
  const st = new Date(Date.now() - 3e5).toISOString().slice(0, 19) + "Z";
  const se = new Date(Date.now() + 36e5).toISOString().slice(0, 19) + "Z";
  const sts = [acct, perm, ss, srt, st, se, "", "https", sv, ""].join("\n") + "\n";
  const sig = crypto.createHmac("sha256", Buffer.from(key, "base64")).update(sts, "utf8").digest("base64");
  return new URLSearchParams({ sv, ss, srt, sp: perm, st, se, spr: "https", sig }).toString();
}
let _acct, _key;
async function creds() {
  if (_acct && _key) return;
  _acct = process.env.AZURE_COMMONS_STORAGE_ACCOUNT || await kvSecret("azure-commons-storage-account");
  _key = process.env.AZURE_COMMONS_STORAGE_KEY || await kvSecret("azure-commons-storage-key");
  if (!_acct || !_key) { console.error("[heartbeat][FATAL] commons storage creds unavailable from Key Vault (azure-commons-storage-account/key)."); process.exit(78); }
}
const url = (name, perm) => `https://${_acct}.blob.core.windows.net/${CONTAINER}/${encodeURIComponent("_HEARTBEAT")}/${encodeURIComponent(name)}?${buildSas(_acct, _key, perm)}`;
async function getJson(file) { const r = await fetch(url(file, "rl")); if (r.status === 404) return null; if (!r.ok) throw new Error("get " + r.status); try { return JSON.parse(await r.text()); } catch { return null; } }
async function putJson(file, obj) { const r = await fetch(url(file, "rwlc"), { method: "PUT", headers: { "x-ms-blob-type": "BlockBlob", "Content-Type": "application/json" }, body: JSON.stringify(obj) }); if (!r.ok) throw new Error("put " + r.status + " " + (await r.text()).slice(0, 120)); }
async function listBeats() {
  const sas = buildSas(_acct, _key, "rl");
  const u = `https://${_acct}.blob.core.windows.net/${CONTAINER}?restype=container&comp=list&prefix=${encodeURIComponent(PREFIX)}&${sas}`;
  const r = await fetch(u); if (!r.ok) return [];
  const xml = await r.text(); const out = [];
  for (const m of xml.matchAll(/<Name>([^<]+)<\/Name>/g)) if (m[1].endsWith(".json")) out.push(m[1].slice(PREFIX.length));
  return out;
}
function loadRegistry() { try { return JSON.parse(readFileSync(join(HERE, "heartbeat-registry.json"), "utf8")); } catch { return {}; } }

// ── Control-plane liveness (P0 stability, HB-EXTEND 2026-07-04) ──────────────
// Jobs on public base images we can't wrap (no in-image beat) are monitored via ARM: read the
// last Container Apps Job execution. This is a STRONGER dead-man's-switch than a self-beat — it
// catches a job that can't even START. Fail-open: if ARM is unreachable the job shows NO-ARM
// (unknown), never a false DEAD.
const SUB = process.env.AZURE_SUBSCRIPTION_ID || "55c84f6b-ef90-4259-a58b-50835cc4cab4";
let _armTok;
async function armToken() {
  if (_armTok !== undefined) return _armTok;
  const t = process.env.AZURE_SP_TENANT_ID, c = process.env.AZURE_SP_CLIENT_ID, s = process.env.AZURE_SP_CLIENT_SECRET;
  if (!t || !c || !s) { _armTok = null; return null; }
  try {
    const r = await fetch(`https://login.microsoftonline.com/${t}/oauth2/v2.0/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "client_credentials", client_id: c, client_secret: s, scope: "https://management.azure.com/.default" }) });
    _armTok = (await r.json()).access_token || null;
  } catch { _armTok = null; }
  return _armTok;
}
async function armLastExec(rg, job) {
  const tok = await armToken(); if (!tok) return null;
  try {
    const r = await fetch(`https://management.azure.com/subscriptions/${SUB}/resourceGroups/${rg}/providers/Microsoft.App/jobs/${job}/executions?api-version=2024-03-01`, { headers: { Authorization: "Bearer " + tok } });
    if (!r.ok) return null;
    const v = ((await r.json()).value || []).map((e) => ({ status: e.properties?.status, startMs: Date.parse(e.properties?.startTime || 0) || null }));
    if (!v.length) return { status: "None", startMs: null, lastOkMs: null };
    const latest = v.slice().sort((a, b) => (b.startMs || 0) - (a.startMs || 0))[0];
    const lastOk = v.filter((e) => e.status === "Succeeded").sort((a, b) => (b.startMs || 0) - (a.startMs || 0))[0];
    return { status: latest.status, startMs: latest.startMs, lastOkMs: lastOk ? lastOk.startMs : null };
  } catch { return null; }
}

// ── HB-AUTORESTART (2026-07-05): opt-in ARM auto-restart for DEAD jobs on the ARM (rg) path ────────
// Additive extension, does NOT touch the classification logic above. A job is only ever eligible here
// if (a) it has an `rg` in the registry (ARM-monitorable, so also ARM-restartable) AND (b) the registry
// entry explicitly sets `"auto_restart": true` (opt-in only; default is no auto-restart). Mirrors
// fleet-medic's proven discipline (skills/fleet-medic/medic.mjs classify()): cooldown so we never
// restart more than once per window, and an escalate-instead-of-retry-forever rule after N consecutive
// auto-restart attempts still show DEAD. Fail-open everywhere: any error in this block is logged and
// falls through to the existing alert path; it never throws and never crashes the sweep.
//
// Cooldown constant: reuses fleet-medic's MEDIC_COOLDOWN_MIN default (360min / 6h) rather than inventing
// a new number — same "don't hammer a broken thing" judgment call, same knob name pattern, overridable
// via env for ops tuning without a code change.
const RESTART_COOLDOWN_MIN = parseInt(process.env.HEARTBEAT_RESTART_COOLDOWN_MIN || "360", 10) || 360;   // 6h, mirrors fleet-medic MEDIC_COOLDOWN_MIN
const RESTART_ESCALATE_AFTER = parseInt(process.env.HEARTBEAT_RESTART_ESCALATE_AFTER || "3", 10) || 3;   // 3x, mirrors fleet-medic MEDIC_ESCALATE_AFTER
const RESTART_STATE_BLOB = "_autorestart_state.json";
const DRY_RUN = argv.includes("--dry-run") || process.env.HEARTBEAT_RESTART_DRY_RUN === "1";

async function loadRestartState() { try { return (await getJson(RESTART_STATE_BLOB)) || {}; } catch { return {}; } }
async function saveRestartState(state) { try { await putJson(RESTART_STATE_BLOB, state); } catch (e) { console.error("[heartbeat][autorestart] state save failed (non-fatal): " + e.message); } }

// ARM REST call to trigger a Container Apps Job execution: POST .../jobs/{job}/start?api-version=...
// (same auth pattern as armLastExec: bearer token from armToken()). Returns true on a successful
// trigger (ARM responds 200/201/202 with an execution payload), false otherwise. Never throws.
async function armStartJob(rg, job) {
  const tok = await armToken();
  if (!tok) return { ok: false, reason: "no ARM token available" };
  try {
    const r = await fetch(`https://management.azure.com/subscriptions/${SUB}/resourceGroups/${rg}/providers/Microsoft.App/jobs/${job}/start?api-version=2024-03-01`, {
      method: "POST",
      headers: { Authorization: "Bearer " + tok, "Content-Type": "application/json" },
    });
    if (r.ok) return { ok: true };
    const body = await r.text().catch(() => "");
    return { ok: false, reason: `ARM start ${r.status}: ${body.slice(0, 200)}` };
  } catch (e) {
    return { ok: false, reason: "ARM start threw: " + e.message };
  }
}

// Send a single escalation nudge via fleet-dispatch (the fleet's existing message bus, same mechanism
// decision-clock and fleet-medic already reuse for "human/operator needs to look at this now"). Dynamic
// import so a job image without fleet-dispatch installed still runs heartbeat normally (fail-open: skip
// the nudge, never crash the sweep).
async function escalateRestartFailure(job, row, reason) {
  try {
    const mod = await import(join(HERE, "..", "skills", "fleet-dispatch", "dispatch.mjs")).catch(() => null);
    // dispatch.mjs is a CLI-shaped module (no exported send()); shell out the same way its own CLI does
    // rather than reaching into internals we don't own. Fail-open on any error.
    const { execFileSync } = await import("node:child_process");
    const text = `HEARTBEAT AUTO-RESTART ESCALATION: job "${job}" (rg=${row.rg}) is still DEAD after ${RESTART_ESCALATE_AFTER} consecutive auto-restart attempt(s). ${reason || ""} Auto-restart is now PAUSED for this job until a human clears the state (delete the "${job}" entry from ${RESTART_STATE_BLOB} in _HEARTBEAT/, or investigate + fix, then it resumes on next DEAD). Needs a human look.`;
    execFileSync("node", [join(HERE, "..", "skills", "fleet-dispatch", "dispatch.mjs"), "send", row.owner || "cto", text, "--from", "heartbeat"], { stdio: ["ignore", "ignore", "ignore"], timeout: 15000 });
    void mod; // module presence already confirmed above; CLI invocation is the actual send path
  } catch (e) {
    console.error(`[heartbeat][autorestart] escalation dispatch failed (non-fatal, falls through to normal DEAD alert): ${e.message}`);
  }
}

// ============================ PURE CORE (hermetically tested) ============================
// planAutoRestart(): given prior per-job restart state + now, decide what SHOULD happen — restart,
// hold in cooldown, or escalate-and-pause — with no I/O. Mirrors fleet-medic's classify() being the
// hermetic "brain" (skills/fleet-medic/medic.mjs), separated from the ARM call + dispatch side effects
// below so the cooldown/escalate discipline itself is unit-testable without any network/Azure access.
//   prior: { last_restart_ts, consecutive_restarts, paused } (defaults applied if absent)
//   opts:  { cooldownMin, escalateAfter } (defaults to the module constants; overridable for tests)
// returns: { plan: "paused"|"cooldown"|"escalate"|"restart", detail, attempt, nextState }
export function planAutoRestart(job, prior, now, opts = {}) {
  const cooldownMin = opts.cooldownMin ?? RESTART_COOLDOWN_MIN;
  const escalateAfter = opts.escalateAfter ?? RESTART_ESCALATE_AFTER;
  const st = prior || { last_restart_ts: 0, consecutive_restarts: 0, paused: false };

  if (st.paused) return { plan: "paused", detail: "auto-restart previously escalated + paused for this job; human clear required", attempt: st.consecutive_restarts || 0, nextState: st };

  const sinceMs = st.last_restart_ts ? now - Date.parse(st.last_restart_ts) : Infinity;
  if (sinceMs < cooldownMin * 60000) {
    return { plan: "cooldown", detail: `last restart ${Math.round(sinceMs / 60000)}m ago, cooldown is ${cooldownMin}m`, attempt: st.consecutive_restarts || 0, nextState: st };
  }

  const attempt = (st.consecutive_restarts || 0) + 1;
  if (attempt > escalateAfter) {
    // Already past the escalate threshold and still DEAD -> stop retrying forever, pause, escalate once.
    return { plan: "escalate", detail: `${st.consecutive_restarts} prior auto-restart attempt(s) did not bring it back to LIVE`, attempt: st.consecutive_restarts || 0, nextState: { ...st, paused: true } };
  }

  return { plan: "restart", detail: `attempt ${attempt}/${escalateAfter}`, attempt, nextState: null /* caller fills in on ARM success */ };
}

// maybeAutoRestart(): I/O wrapper around planAutoRestart() — calls ARM (or, in --dry-run, just reports
// the plan) and fleet-dispatch for escalation, then persists the updated per-job state into `state`
// (mutated in place; caller saves it once per sweep). Fail-open: returns a small annotation object
// describing what happened/would happen, never throws.
async function maybeAutoRestart(job, entry, state) {
  const now = Date.now();
  const prior = state[job] || { last_restart_ts: 0, consecutive_restarts: 0, paused: false };
  const decision = planAutoRestart(job, prior, now);

  if (decision.plan === "paused") return { action: "paused", detail: decision.detail };
  if (decision.plan === "cooldown") return { action: "cooldown", detail: decision.detail };
  if (decision.plan === "escalate") {
    state[job] = decision.nextState;
    await escalateRestartFailure(job, entry, decision.detail + ".");
    return { action: "escalated", detail: `${decision.detail}; paused + escalated to ${entry.owner || "cto"} via fleet-dispatch` };
  }

  // decision.plan === "restart"
  if (DRY_RUN) {
    return { action: "dry-run-would-restart", detail: `would call ARM start for ${job} in ${entry.rg} (${decision.detail})` };
  }

  const result = await armStartJob(entry.rg, job);
  if (result.ok) {
    state[job] = { last_restart_ts: new Date(now).toISOString(), consecutive_restarts: decision.attempt, paused: false };
    const escalateNow = decision.attempt >= RESTART_ESCALATE_AFTER;
    if (escalateNow) {
      // Fired the restart, but this is the Nth consecutive attempt -> also warn now rather than waiting
      // for one more DEAD cycle, so a human sees the pattern as soon as it crosses the threshold.
      await escalateRestartFailure(job, entry, `This was auto-restart attempt ${decision.attempt}/${RESTART_ESCALATE_AFTER}.`);
    }
    return { action: "restarted", detail: `ARM start triggered (${decision.detail})`, escalated: escalateNow };
  }
  // ARM call itself failed -> fail open: log it, do NOT throw, fall through to the existing alert path.
  console.error(`[heartbeat][autorestart] ${job}: ARM start failed (${result.reason}); falling through to normal DEAD alert.`);
  return { action: "restart-failed", detail: result.reason };
}

// isMain guard (added alongside HB-AUTORESTART): the pure planAutoRestart() export above needs to be
// importable from a hermetic test file (tests/heartbeat-autorestart.test.mjs) without the CLI body
// firing process.exit() on import — mirrors the same isMain pattern already used by fleet-medic/medic.mjs
// and signal-radar/radar.mjs. Purely additive: behavior when actually run as `node heartbeat.mjs ...` is
// unchanged (isMain is true in that case, so the IIFE still runs exactly as before).
import { pathToFileURL } from "node:url";
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain)
(async () => {
  if (cmd === "beat") {
    const job = argv[1], event = argv[2];
    if (!job || !["start", "ok", "fail"].includes(event)) { console.error("usage: heartbeat.mjs beat <job> <start|ok|fail> [--detail ...]"); process.exit(2); }
    await creds();
    const now = new Date().toISOString();
    const cur = (await getJson(`${job}.json`)) || { job };
    cur.last_event = event; cur.updated = now; cur.detail = takeVal("--detail") || cur.detail || "";
    if (event === "start") cur.last_start = now;
    if (event === "ok") { cur.last_ok = now; cur.consecutive_fail = 0; }
    if (event === "fail") { cur.last_fail = now; cur.consecutive_fail = (cur.consecutive_fail || 0) + 1; }
    await putJson(`${job}.json`, cur);
    console.log(`[heartbeat] ${job} <- ${event} @ ${now}`);
    return;
  }
  if (cmd === "check") {
    await creds();
    const reg = loadRegistry();          // { job: { interval_min, owner, rg, auto_restart } }
    const files = await listBeats();
    const seen = new Set(files.map((f) => f.replace(/\.json$/, "")));
    const jobs = [...new Set([...Object.keys(reg), ...seen])].sort();
    const now = Date.now();
    const rows = [];
    let restartState = null; // lazy-loaded only if at least one auto_restart-eligible job goes DEAD
    for (const job of jobs) {
      const hb = (await getJson(`${job}.json`)) || {};
      const intervalMin = (reg[job] && reg[job].interval_min) || null;
      const rg = reg[job] && reg[job].rg;
      let lastOk = hb.last_ok ? Date.parse(hb.last_ok) : null;
      let src = lastOk ? "beat" : "";
      let armRunning = false, armFailed = false, armUnknown = false;
      if (rg) {
        const a = await armLastExec(rg, job);
        if (a === null) armUnknown = true;                       // ARM unreachable -> don't false-alarm
        else {
          if (a.lastOkMs && (!lastOk || a.lastOkMs > lastOk)) { lastOk = a.lastOkMs; src = "arm"; }
          if (a.status === "Running" || a.status === "Processing") armRunning = true;
          if (a.status === "Failed" || a.status === "Degraded") armFailed = true;
        }
      }
      const ageMin = lastOk ? Math.round((now - lastOk) / 60000) : null;
      let status;
      if (armRunning) status = "LIVE";                                   // currently executing
      else if (!intervalMin && !lastOk) status = rg && armUnknown ? "NO-ARM" : "NO-DATA";
      else if (!lastOk) status = rg && armUnknown ? "NO-ARM" : "DEAD";   // expected but never succeeded
      else if (intervalMin && ageMin > intervalMin * 3) status = "DEAD"; // 3x = alert
      else if (intervalMin && ageMin > intervalMin) status = "LATE";     // 1x = missing
      else status = "LIVE";
      const last_event = hb.last_event || (armFailed ? "fail(arm)" : src === "arm" ? "ok(arm)" : "");
      const row = { job, status, ageMin, intervalMin, owner: (reg[job] || {}).owner || "", last_event, consecutive_fail: hb.consecutive_fail || 0, src, armFailed };

      // HB-AUTORESTART: only for jobs classified DEAD *via the ARM path* — i.e. rg is set (ARM-monitorable
      // -> also ARM-restartable) AND the registry opted this specific job in with auto_restart:true.
      // Fail-open: any error in this whole block is caught and logged; it never prevents the row from
      // being reported via the normal alert path below.
      if (status === "DEAD" && rg && reg[job] && reg[job].auto_restart === true) {
        try {
          if (!restartState) restartState = await loadRestartState();
          const outcome = await maybeAutoRestart(job, reg[job], restartState);
          row.autoRestart = outcome;
        } catch (e) {
          console.error(`[heartbeat][autorestart] ${job}: unexpected error (${e.message}); falling through to normal DEAD alert.`);
          row.autoRestart = { action: "error", detail: e.message };
        }
      }
      rows.push(row);
    }
    if (restartState && !DRY_RUN) await saveRestartState(restartState);
    if (argv.includes("--json")) { console.log(JSON.stringify(rows, null, 2)); return; }
    const bad = rows.filter((r) => r.status === "DEAD" || r.status === "LATE" || r.consecutive_fail > 0 || r.armFailed);
    console.log(`# FLEET HEARTBEAT — ${rows.length} job(s); ${bad.length} needing attention${DRY_RUN ? "  [--dry-run: auto-restart is REPORT-ONLY]" : ""}`);
    for (const r of rows) {
      const age = r.ageMin == null ? "never" : r.ageMin < 60 ? `${r.ageMin}m` : `${Math.round(r.ageMin / 60)}h`;
      const via = r.src === "arm" ? " via arm" : "";
      const ar = r.autoRestart ? `  AUTO-RESTART[${r.autoRestart.action}${r.autoRestart.detail ? ": " + r.autoRestart.detail : ""}]` : "";
      console.log(`[${r.status.padEnd(7)}] ${r.job.padEnd(26)} last-ok ${age.padEnd(6)}${via.padEnd(8)} ${r.intervalMin ? "(expect ≤" + r.intervalMin + "m)" : ""}${r.armFailed ? "  LAST-RUN-FAILED" : ""}${r.consecutive_fail ? "  FAILS×" + r.consecutive_fail : ""}${r.owner ? "  -> " + r.owner : ""}${ar}`);
    }
    if (bad.length) console.log(`\nSILENCE = FAILURE: ${bad.map((r) => r.job).join(", ")} need attention.`);
    return;
  }
  console.error("usage: heartbeat.mjs beat <job> <start|ok|fail> | check [--json] [--dry-run]");
  process.exit(2);
})().catch((e) => { console.error("[heartbeat] ERROR: " + e.message); process.exit(1); });
