#!/usr/bin/env node
// signal-radar — a DETERMINISTIC, detector-based watcher over the fleet's existing telemetry
// (Sentry, PostHog, grant-tracker, Secret Manager, iHEARtest's RELEASE-LEDGER). Report/observe only:
// it never touches prod, never mutates another system, it only surfaces high-precision Signals and
// routes them to the owning agent's inbox (fleet-dispatch). Mirrors fleet-medic's proven discipline:
// classify -> cooldown -> consecutive-escalate -> FAIL-OPEN -> never-cry-wolf-on-idle.
//
// Verbs:
//   node radar.mjs scan [--emit] [--json] [--only <detector-name>]
//     --emit persists each NEW-OR-PAST-COOLDOWN signal to Cosmos `signals`, emits a signal_detected
//     PostHog event, and dispatches high/escalated signals to the owning agent's inbox. Without --emit
//     this is a pure dry-run (prints what WOULD fire; touches no external state).
//
// GUARDRAILS (see schema.mjs for the pure logic):
//   - MNPI (INND/securities/Xero/Plaid/stock) signals are hard-routed to owner=cfo and NEVER appear in
//     a fleet-wide digest, regardless of what a detector's OWNER constant says.
//   - PHI (MedReview) is never a data source; detectors that touch Sentry hard-exclude those projects.
//   - Fail-open: one detector throwing NEVER aborts the scan or crashes the process (exit 0 always,
//     except a bad CLI usage which exits 2).
//   - Cooldown + consecutive-escalate (schema.shouldFire) stop a flapping metric from spamming an inbox.
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { cosmosConfig, cosmosPutSignal, cosmosQuerySignals, posthogEmit } from "./common.mjs";
import { shouldFire, isMnpiSubject, SEVERITY_RANK } from "./schema.mjs";

import * as sentryErrorSpike from "./detectors/sentry-error-spike.mjs";
import * as evalRegression from "./detectors/eval-regression.mjs";
import * as grantBurnExpiry from "./detectors/grant-burn-expiry.mjs";
import * as rotateSecretAge from "./detectors/rotate-secret-age.mjs";
import * as markReviewOverdue from "./detectors/mark-review-overdue.mjs";
import * as contradictionStaleness from "./detectors/contradiction-staleness.mjs";
import * as groundedness from "./detectors/groundedness.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DISPATCH_PATH = join(HERE, "..", "fleet-dispatch", "dispatch.mjs");

// Every detector module exports { NAME, OWNER, run() }. Adding another detector later is: write the
// module (mirroring any existing one), import it, and add it here - no other file changes needed.
const DETECTORS = [sentryErrorSpike, evalRegression, grantBurnExpiry, rotateSecretAge, markReviewOverdue, contradictionStaleness, groundedness];

const argv = process.argv.slice(2);
const cmd = argv[0];
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const FLAG = (f) => argv.includes(f);

/** Cooldown/escalate config per severity (higher severity re-fires sooner; a "low" finding is allowed
 * to go quiet longer before it is worth re-flagging). Mirrors fleet-medic's single-cooldown-constant
 * pattern but tiers it, since Radar's detectors span very different natural cadences (a Sentry spike
 * can recur hourly; a grant expiry is a once-a-day-at-most fact). */
const COOLDOWN_MIN_BY_SEVERITY = { high: 240, medium: 720, low: 1440 };
const ESCALATE_AFTER = 3;

async function runDetectorSafely(mod) {
  const notes = [];
  try {
    const { signals, notes: n } = await mod.run();
    return { name: mod.NAME, signals: signals || [], notes: (n || []).concat(notes), error: null };
  } catch (e) {
    // FAIL-OPEN: a broken detector produces zero signals and one diagnostic note, never crashes the scan.
    return { name: mod.NAME, signals: [], notes: [`detector threw: ${e.message}`], error: e.message };
  }
}

async function scan() {
  const only = val("--only", "");
  const emitting = FLAG("--emit");
  const asJson = FLAG("--json");
  const targets = only ? DETECTORS.filter((d) => d.NAME === only) : DETECTORS;
  if (only && !targets.length) { console.error(`unknown detector "${only}". known: ${DETECTORS.map((d) => d.NAME).join(", ")}`); process.exit(2); }

  const cosmosCfg = await cosmosConfig().catch(() => null);
  const now = Date.now();

  const perDetector = [];
  let allSignals = [];
  for (const mod of targets) {
    const result = await runDetectorSafely(mod);
    perDetector.push(result);
    allSignals = allSignals.concat(result.signals);
  }

  // MNPI hard-route: regardless of a detector's default OWNER, any subject that trips the MNPI test
  // is force-routed to cfo and flagged mnpi=true so a digest layer can hard-exclude it.
  for (const s of allSignals) {
    if (isMnpiSubject(s.detector, s.subject)) { s.mnpi = true; s.owner = "cfo"; }
  }

  // cooldown / consecutive-escalate per signal id, using Cosmos history when configured. Without
  // Cosmos configured, every signal is treated as "fire" (dry-run-safe; --emit still requires Cosmos
  // to actually persist, so a mis-provisioned Cosmos never silently double-dispatches).
  const decisions = [];
  for (const s of allSignals) {
    let history = [];
    if (cosmosCfg) {
      try { history = await cosmosQuerySignals(s.owner, "SELECT c.ts FROM c WHERE c.id = @id", [{ name: "@id", value: s.id }]); }
      catch { /* fail-open: treat as no history */ }
    }
    const cooldownMin = COOLDOWN_MIN_BY_SEVERITY[s.severity] ?? 720;
    const decision = shouldFire(history, now, { cooldownMin, escalateAfter: ESCALATE_AFTER });
    decisions.push({ signal: s, ...decision });
  }

  const firing = decisions.filter((d) => d.fire);
  firing.sort((a, b) => (SEVERITY_RANK[a.signal.severity] ?? 9) - (SEVERITY_RANK[b.signal.severity] ?? 9));

  if (asJson) {
    console.log(JSON.stringify({ ts: new Date(now).toISOString(), emitting, detectors: perDetector.map((r) => ({ name: r.name, count: r.signals.length, error: r.error, notes: r.notes })), firing: firing.map((d) => d.signal), suppressed: decisions.length - firing.length }, null, 2));
  } else {
    console.log(`# SIGNAL RADAR scan ${new Date(now).toISOString()}  (${emitting ? "EMIT" : "dry-run"}; cosmos ${cosmosCfg ? "configured" : "NOT configured"})`);
    for (const r of perDetector) {
      console.log(`  [${r.error ? "ERR " : "ok  "}] ${r.name.padEnd(22)} ${String(r.signals.length).padStart(2)} signal(s)${r.error ? `  (${r.error})` : ""}`);
      for (const note of r.notes) console.log(`         note: ${note}`);
    }
    console.log("");
    if (!firing.length) console.log("  (nothing above threshold; fleet looks quiet)");
    for (const d of firing) {
      const s = d.signal;
      console.log(`[${s.severity.toUpperCase().padEnd(6)}] ${s.detector} -> ${s.owner}${s.mnpi ? " [MNPI: CFO-ONLY]" : ""}${d.escalate ? " [ESCALATE]" : ""}`);
      console.log(`         ${s.why}`);
      console.log(`         action: ${s.suggested_action}`);
    }
    const suppressed = decisions.length - firing.length;
    if (suppressed) console.log(`\n  (${suppressed} finding(s) suppressed by cooldown; a flapping metric will not spam an inbox)`);
  }

  if (!emitting) return;

  if (!cosmosCfg) {
    console.error("[signal-radar] --emit requested but Cosmos is not configured (cosmos-endpoint/cosmos-key/cosmos-db secrets missing); nothing persisted or dispatched.");
    return;
  }

  const dispatched = [];
  for (const d of firing) {
    const s = d.signal;
    try { await cosmosPutSignal({ id: s.id, owner: s.owner, ...s, escalate: d.escalate, consecutive: d.consecutive }); }
    catch (e) { console.error(`  [warn] could not persist signal ${s.id}: ${e.message}`); }

    await posthogEmit("signal_detected", s.owner, { detector: s.detector, subject: s.subject, severity: s.severity, mnpi: s.mnpi, escalate: d.escalate, consecutive: d.consecutive });

    // Route to the owning agent's inbox. Only high severity or an escalated finding actually pages an
    // agent (a "low" or first-time "medium" is left in Cosmos for the operator/company-brain to query,
    // not pushed into an inbox) - this is the never-cry-wolf discipline applied to routing, not just cooldown.
    if (s.severity === "high" || d.escalate) {
      const text = `[signal-radar] ${s.severity.toUpperCase()} ${s.detector}: ${s.why} Action: ${s.suggested_action}`;
      try {
        execFileSync("node", [DISPATCH_PATH, "send", s.owner, text, "--from", "signal-radar"], { stdio: ["ignore", "pipe", "pipe"] });
        dispatched.push(s.id);
      } catch (e) { console.error(`  [warn] dispatch to ${s.owner} failed for ${s.id}: ${e.message}`); }
    }
  }
  // Narration only, never part of the structured contract: in --json mode this MUST go to stderr so
  // stdout stays pure, parseable JSON for a machine caller (e.g. the Container Apps Job wrapper).
  const summaryLine = `[signal-radar] persisted ${firing.length} signal(s); dispatched ${dispatched.length} to owner inbox(es).`;
  if (asJson) console.error(summaryLine); else console.log(`\n${summaryLine}`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  (async () => {
    try {
      if (cmd === "scan") await scan();
      else { console.error("usage: radar.mjs scan [--emit] [--json] [--only <detector-name>]"); process.exit(2); }
    } catch (e) { console.error("signal-radar ERROR: " + e.message); process.exit(0); } // fail-open at the top level too
  })();
}
