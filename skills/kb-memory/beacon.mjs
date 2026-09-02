#!/usr/bin/env node
// beacon.mjs - emit a `memory_beacon` event to PostHog (Fleet Agents project 479484) so each agent's
// MEMORY HEALTH is observable in real time. This is the operator-dashboard signal AND the foundation
// for the Wave-4 auto-medic (a process that watches this stream and auto-dispatches the medic when an
// agent goes dark/off-the-rails).
//
// CHEAP + SAFE: health is read from the LOCAL ledger cache (no extra Blob round-trip); it is THROTTLED
// (default once / 10 min) and meant to run from the Stop hook (OFF the prompt hot path), backgrounded,
// fail-open. It can never block or break a session. One network call (the PostHog POST) per window.
//
// TESTABILITY: all side effects (argv/env reads that can process.exit(), file stamps, network calls)
// are gated behind `isMain` at the bottom, mirroring agent-unset-beacon.mjs in this same directory.
// Importing this module (as the test suite does, for `sessionAgeMin`/`decideStatus`) does nothing by
// itself -- it only runs when invoked directly as `node beacon.mjs --agent <a>`.
import crypto from "node:crypto";
import { readFileSync, existsSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { kvSecret } from "./azure-secret.mjs";

const SM = "otchealth-shared-prod";
const INGEST = "https://us.i.posthog.com/capture/";

// FND-20260902-67ce: session-start.sh wires the SessionStart/PreCompact/Stop hooks (kb-inject.sh) and
// the UserPromptSubmit hook (kb-recall.sh) into ~/.claude/settings.json near the END of its run
// (setup/install-octools-hook.mjs). On a container/session where that has not happened YET, a Stop
// event can still reach beacon.mjs (the Stop hook can already be registered from a prior session's
// persisted settings.json) while `hooksWired()` below reads false -- indistinguishable, before this
// fix, from an agent whose hooks genuinely never wired. Verified live 2026-09-02: an agent's most
// recent beacon read DARK while `whoami` PASSED on 2093 ledger entries and hooksWired() returned true
// against the live settings moments later -- proof this was a startup race, not a real outage.
//
// STARTUP_MARKER: session-start.sh re-stamps this file near the START of every run (right after the
// skills-install step, see setup/session-start.sh), well before it reaches install-octools-hook.mjs.
// Its mtime is therefore a reliable "this session's setup began about here" clock -- reused as-is
// (setup/octools-version.sh already treats it the same way) rather than inventing a second marker.
const STARTUP_MARKER = `${homedir()}/.claude/.octools-installed-commit`;
// FIRST_SEEN_STAMP: fallback for a seat that never runs session-start.sh at all (so STARTUP_MARKER
// never exists) -- this beacon's own first invocation becomes the session-age clock instead. Written
// lazily, once, distinct from the throttle STAMP file defined just below (that one exists purely to
// rate-limit how often this script emits at all, and is rewritten on every non-throttled run).
const FIRST_SEEN_STAMP = `${homedir()}/.claude/kb-journal/.beacon-first-seen`;
const GRACE_MIN = parseInt(process.env.BEACON_STARTUP_GRACE_MIN || "10", 10) || 10;

const STAMP = `${homedir()}/.claude/kb-journal/.last-beacon`;
const THROTTLE = (parseInt(process.env.KB_BEACON_THROTTLE_S || "600", 10) || 600) * 1000;

function resolveSa() {
  if (process.env.GCP_CLAUDE_DRIVER_SA_JSON) return process.env.GCP_CLAUDE_DRIVER_SA_JSON;
  try { return readFileSync(`${homedir()}/.gcp_claude_driver_sa.json`, "utf8"); } catch { return null; }
}
function saJwt(sa) {
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

// sessionAgeMin(): how long (minutes) since THIS session/environment appears to have started. See the
// FND-20260902-67ce header above for why this exists. Exported for direct testing (set process.env.HOME
// to a scratch dir to control which marker/stamp files it sees; os.homedir() reads HOME live on POSIX).
export function sessionAgeMin() {
  try { if (existsSync(STARTUP_MARKER)) return (Date.now() - statSync(STARTUP_MARKER).mtimeMs) / 60000; } catch {}
  try {
    mkdirSync(`${homedir()}/.claude/kb-journal`, { recursive: true });
    if (!existsSync(FIRST_SEEN_STAMP)) writeFileSync(FIRST_SEEN_STAMP, String(Date.now()));
    const t = parseInt(readFileSync(FIRST_SEEN_STAMP, "utf8").trim(), 10);
    return Number.isFinite(t) ? (Date.now() - t) / 60000 : 0;
  } catch { return 0; }
}

// decideStatus(): the PURE CORE (no I/O; hermetically tested -- mirrors fleet-medic's classify() split
// of pure decision logic from I/O, see skills/fleet-medic/medic.mjs). FND-20260902-67ce: a session whose
// hooks are not wired YET (session-start.sh has not reached install-octools-hook.mjs) used to be
// INDISTINGUISHABLE from a genuinely broken agent (both read hooksWired()=false -> status=DARK). Now,
// while `ageMin` is still inside the startup grace window, report the DISTINCT "starting" status
// instead -- healthy-pending, not a real signal either way -- and only fall back to the ORIGINAL
// DARK/LIVE computation once the grace window has elapsed. A wired session is completely unaffected:
// the grace window only ever applies when `hooksWired` is false, so its LIVE/DARK computation below is
// byte-identical to the pre-fix behaviour.
export function decideStatus({ ledgerSize, hooksWired: wiredNow, ageMin, graceMin = GRACE_MIN }) {
  const startupGrace = !wiredNow && typeof ageMin === "number" && ageMin < graceMin;
  const status = startupGrace ? "starting" : (ledgerSize > 0 && wiredNow ? "LIVE" : "DARK");
  return { status, startupGrace };
}

async function main() {
  const argv = process.argv.slice(2);
  const AGENT = (argv[argv.indexOf("--agent") + 1] || process.env.KB_AGENT || "").toLowerCase();
  if (!AGENT || AGENT.startsWith("--")) process.exit(0);

  // Throttle: at most once per window. Stamp EARLY so a failed emit still respects the window (no hammer).
  try { if (existsSync(STAMP) && Date.now() - statSync(STAMP).mtimeMs < THROTTLE) process.exit(0); } catch {}
  try { mkdirSync(`${homedir()}/.claude/kb-journal`, { recursive: true }); writeFileSync(STAMP, String(Date.now())); } catch {}

  // GCP SA is now OPTIONAL (Azure Key Vault is primary). Don't exit when it's absent — parse it lazily
  // so the legacy GCP fallback still works on any box that still carries it.
  const raw = resolveSa();
  let sa = null; if (raw) { try { sa = JSON.parse(raw); } catch { sa = null; } }

  try {
    // Azure Key Vault FIRST (GCP retired); GCP fallback only if a SA is present.
    let key = await kvSecret("posthog-fleet-ingest-key");
    if (!key && sa) {
      const tok = (await (await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${encodeURIComponent(saJwt(sa))}` })).json()).access_token;
      const r = await fetch(`https://secretmanager.googleapis.com/v1/projects/${SM}/secrets/posthog-fleet-ingest-key/versions/latest:access`, { headers: { Authorization: "Bearer " + tok } });
      if (r.ok) key = Buffer.from((await r.json()).payload.data, "base64").toString("utf8").trim();
    }
    if (!key) process.exit(0);
    const h = cacheHealth(AGENT);
    const wired = hooksWired();
    const ageMin = sessionAgeMin();
    const { status, startupGrace } = decideStatus({ ledgerSize: h.ledger_size, hooksWired: wired, ageMin });
    const ev = { event: "memory_beacon", distinct_id: AGENT, timestamp: new Date().toISOString(), properties: { agent: AGENT, status, ledger_size: h.ledger_size, last_write_age_min: h.last_write_age_min, cache_age_min: h.cache_age_min, hooks_wired: wired, startup_grace: startupGrace, session_age_min: Math.round(ageMin), $lib: "kb-memory" } };
    await fetch(INGEST, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ api_key: key, ...ev }) });
  } catch {}
  process.exit(0);
}

const isMain = (() => {
  try { return process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]; } catch { return false; }
})();
if (isMain) main();
