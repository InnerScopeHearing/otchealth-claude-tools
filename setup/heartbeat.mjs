#!/usr/bin/env node
// heartbeat.mjs — fleet dead-man's-switch (P0 stability, 2026-07-04). Every scheduled job/agent
// emits a 'start' + 'ok' (or 'fail') beat to durable Blob; a single watcher treats SILENCE as failure.
// Storage: otchealthcommons/company-journal/_HEARTBEAT/<job>.json (non-PHI, shared ops plane).
// Creds: Azure Key Vault via AZURE_SP_* (fail-loud). Dependency-free (node builtins + fetch).
//
// Usage:
//   node setup/heartbeat.mjs beat <job> <start|ok|fail> [--detail "..."]
//   node setup/heartbeat.mjs check [--json]      # LIVE/LATE/DEAD/NO-DATA per expected-interval registry
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
    const reg = loadRegistry();          // { job: { interval_min, owner } }
    const files = await listBeats();
    const seen = new Set(files.map((f) => f.replace(/\.json$/, "")));
    const jobs = [...new Set([...Object.keys(reg), ...seen])].sort();
    const now = Date.now();
    const rows = [];
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
      rows.push({ job, status, ageMin, intervalMin, owner: (reg[job] || {}).owner || "", last_event, consecutive_fail: hb.consecutive_fail || 0, src, armFailed });
    }
    if (argv.includes("--json")) { console.log(JSON.stringify(rows, null, 2)); return; }
    const bad = rows.filter((r) => r.status === "DEAD" || r.status === "LATE" || r.consecutive_fail > 0 || r.armFailed);
    console.log(`# FLEET HEARTBEAT — ${rows.length} job(s); ${bad.length} needing attention`);
    for (const r of rows) {
      const age = r.ageMin == null ? "never" : r.ageMin < 60 ? `${r.ageMin}m` : `${Math.round(r.ageMin / 60)}h`;
      const via = r.src === "arm" ? " via arm" : "";
      console.log(`[${r.status.padEnd(7)}] ${r.job.padEnd(26)} last-ok ${age.padEnd(6)}${via.padEnd(8)} ${r.intervalMin ? "(expect ≤" + r.intervalMin + "m)" : ""}${r.armFailed ? "  LAST-RUN-FAILED" : ""}${r.consecutive_fail ? "  FAILS×" + r.consecutive_fail : ""}${r.owner ? "  -> " + r.owner : ""}`);
    }
    if (bad.length) console.log(`\nSILENCE = FAILURE: ${bad.map((r) => r.job).join(", ")} need attention.`);
    return;
  }
  console.error("usage: heartbeat.mjs beat <job> <start|ok|fail> | check [--json]");
  process.exit(2);
})().catch((e) => { console.error("[heartbeat] ERROR: " + e.message); process.exit(1); });
