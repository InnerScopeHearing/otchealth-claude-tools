#!/usr/bin/env node
// beacon.mjs - emit a `memory_beacon` event to PostHog (Fleet Agents project 479484) so each agent's
// MEMORY HEALTH is observable in real time. This is the operator-dashboard signal AND the foundation
// for the Wave-4 auto-medic (a process that watches this stream and auto-dispatches the medic when an
// agent goes dark/off-the-rails).
//
// CHEAP + SAFE: health is read from the LOCAL ledger cache (no extra Blob round-trip); it is THROTTLED
// (default once / 10 min) and meant to run from the Stop hook (OFF the prompt hot path), backgrounded,
// fail-open. It can never block or break a session. One network call (the PostHog POST) per window.
import crypto from "node:crypto";
import { readFileSync, existsSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

const SM = "otchealth-shared-prod";
const INGEST = "https://us.i.posthog.com/capture/";
const argv = process.argv.slice(2);
const AGENT = (argv[argv.indexOf("--agent") + 1] || process.env.KB_AGENT || "").toLowerCase();
if (!AGENT || AGENT.startsWith("--")) process.exit(0);

// Throttle: at most once per window. Stamp EARLY so a failed emit still respects the window (no hammer).
const STAMP = `${homedir()}/.claude/kb-journal/.last-beacon`;
const THROTTLE = (parseInt(process.env.KB_BEACON_THROTTLE_S || "600", 10) || 600) * 1000;
try { if (existsSync(STAMP) && Date.now() - statSync(STAMP).mtimeMs < THROTTLE) process.exit(0); } catch {}
try { mkdirSync(`${homedir()}/.claude/kb-journal`, { recursive: true }); writeFileSync(STAMP, String(Date.now())); } catch {}

function resolveSa() {
  if (process.env.GCP_CLAUDE_DRIVER_SA_JSON) return process.env.GCP_CLAUDE_DRIVER_SA_JSON;
  try { return readFileSync(`${homedir()}/.gcp_claude_driver_sa.json`, "utf8"); } catch { return null; }
}
const raw = resolveSa(); if (!raw) process.exit(0);
let sa; try { sa = JSON.parse(raw); } catch { process.exit(0); }
function saJwt() {
  const n = Math.floor(Date.now() / 1e3), e = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const i = `${e({ alg: "RS256", typ: "JWT" })}.${e({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/cloud-platform", aud: "https://oauth2.googleapis.com/token", iat: n, exp: n + 3600 })}`;
  return i + "." + crypto.createSign("RSA-SHA256").update(i).sign(sa.private_key, "base64url");
}

function cacheHealth(agent) {
  const f = `${homedir()}/.claude/kb-cache/${agent}.jsonl`;
  try {
    const rows = readFileSync(f, "utf8").split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const tss = rows.map((r) => r.ts).filter(Boolean).sort();
    const lastTs = tss[tss.length - 1];
    return { ledger_size: rows.length, last_write_age_min: lastTs ? Math.round((Date.now() - Date.parse(lastTs)) / 60000) : null, cache_age_min: Math.round((Date.now() - statSync(f).mtimeMs) / 60000) };
  } catch { return { ledger_size: 0, last_write_age_min: null, cache_age_min: null }; }
}
function hooksWired() {
  try { const s = JSON.parse(readFileSync(`${homedir()}/.claude/settings.json`, "utf8")); const j = JSON.stringify(s.hooks || {}); return j.includes("kb-recall") && j.includes("kb-inject"); } catch { return false; }
}

(async () => {
  try {
    const tok = (await (await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${encodeURIComponent(saJwt())}` })).json()).access_token;
    const r = await fetch(`https://secretmanager.googleapis.com/v1/projects/${SM}/secrets/posthog-fleet-ingest-key/versions/latest:access`, { headers: { Authorization: "Bearer " + tok } });
    if (!r.ok) process.exit(0);
    const key = Buffer.from((await r.json()).payload.data, "base64").toString("utf8").trim();
    const h = cacheHealth(AGENT);
    const wired = hooksWired();
    const status = h.ledger_size > 0 && wired ? "LIVE" : "DARK";
    const ev = { event: "memory_beacon", distinct_id: AGENT, timestamp: new Date().toISOString(), properties: { agent: AGENT, status, ledger_size: h.ledger_size, last_write_age_min: h.last_write_age_min, cache_age_min: h.cache_age_min, hooks_wired: wired, $lib: "kb-memory" } };
    await fetch(INGEST, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ api_key: key, ...ev }) });
  } catch {}
  process.exit(0);
})();
