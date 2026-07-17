#!/usr/bin/env node
// agent-unset-beacon.mjs -- W1-5 KB_AGENT PROPAGATION FIX. Makes "this session resolved NO kb-memory
// agent identity, so it is silently writing no memory" a DURABLE, QUERYABLE signal instead of an
// eyeball-only stdout banner.
//
// THE GAP THIS CLOSES: kb-inject.sh already warns LOUDLY in stdout when no agent resolves (session
// mode) -- but that warning only reaches a human who happens to be reading that exact stdout at that
// exact moment. It leaves NOTHING behind: no ledger write (there is no agent identity to write under),
// no PostHog event (beacon.mjs itself no-ops when its --agent is empty, by design), nothing a canary or
// a future dashboard could ever check. A session that scrolled past the banner, or an unattended/CI
// run where nobody was watching stdout, loses the signal completely -- the exact "silently writes no
// memory" failure this fix exists for.
//
// THE FIX: fire a best-effort `kb_agent_unset` event to the SAME PostHog Fleet Agents project every
// other kb-memory/fleet-telemetry signal already uses, from BOTH the session-start "no agent" branch
// (once per session) AND, throttled, from the "periodic-check" hook (so a long single-turn session that
// never resolves an identity keeps emitting roughly every 30 min instead of only once at the very start,
// which is easy to miss). This does NOT attempt to identify WHICH agent the session should have been --
// there is none, by definition -- distinct_id is a fixed sentinel ("unidentified"); properties carry only
// non-sensitive process metadata (repo dir basename, hostname), never secrets or ledger content.
//
// This event is intentionally NOT wired into azure-canary's freshness-SLO registry (setup/expected-
// streams.json): a freshness check pages on SILENCE, but for kb_agent_unset the correct alarm shape is
// the OPPOSITE (an OCCURRENCE is the anomaly; zero occurrences is the healthy state) -- the same
// "medic_dispatch is not a heartbeat" reasoning documented in stream-freshness.mjs, one category further.
// The natural home for "did this anomaly-shaped event fire more than expected" is signal-radar (which
// already does count/rate-based detection), not this freshness-shaped canary; that detector is not built
// here (scope), but the durable event now exists for exactly that future use.
//
// Usage: node agent-unset-beacon.mjs [--reason "no marker, no repo default, KB_AGENT unset"]
// Fails open (never throws, never blocks the calling hook); always exits 0.
import { existsSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { basename } from "node:path";
import { kvSecret } from "./azure-secret.mjs";

const INGEST = "https://us.i.posthog.com/capture/";
const STAMP = `${homedir()}/.claude/kb-journal/.last-agent-unset-beacon`;

/**
 * PURE throttle decision: should we emit now, given the last emit time (ms epoch, 0/undefined if
 * never), the current time, and the throttle window? No IO, no clock reads -- fully unit-testable.
 * Mirrors beacon.mjs's throttle-via-stamp-file pattern, extracted so the DECISION is independently
 * testable from the file-stat side effect.
 */
export function shouldEmit(lastEmitMs, nowMs, throttleMs) {
  if (!lastEmitMs) return true;
  return nowMs - lastEmitMs >= throttleMs;
}

function readStampMs() {
  try { return existsSync(STAMP) ? statSync(STAMP).mtimeMs : 0; } catch { return 0; }
}
function touchStamp() {
  try { mkdirSync(`${homedir()}/.claude/kb-journal`, { recursive: true }); writeFileSync(STAMP, String(Date.now())); } catch { /* best-effort */ }
}

async function main() {
  const argv = process.argv.slice(2);
  const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
  const reason = val("--reason", "no agent resolved");
  const throttleMs = (parseInt(process.env.KB_AGENT_UNSET_THROTTLE_S || "1800", 10) || 1800) * 1000; // 30 min default

  if (!shouldEmit(readStampMs(), Date.now(), throttleMs)) process.exit(0); // within the throttle window; stay quiet
  touchStamp(); // stamp EARLY (mirrors beacon.mjs) so a failed emit below still respects the window

  try {
    const key = await kvSecret("posthog-fleet-ingest-key");
    if (!key) process.exit(0);
    const repo = basename(process.env.CLAUDE_PROJECT_DIR || process.cwd() || "");
    const ev = {
      event: "kb_agent_unset",
      distinct_id: "unidentified",
      timestamp: new Date().toISOString(),
      properties: { reason, repo, host: hostname(), $lib: "kb-memory" },
    };
    await fetch(INGEST, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ api_key: key, ...ev }) });
  } catch { /* fail-open: this beacon must never be worse than no beacon */ }
  process.exit(0);
}

const isMain = (() => {
  try { return process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]; } catch { return false; }
})();
if (isMain) main();
