#!/usr/bin/env node
// compute-allocator / allocate.mjs, a thin ADVISORY layer that composes three existing pure/near-pure
// skills into one "how much compute should this task get" recommendation:
//   1. fleet-dispatch/effort-scale.mjs  -> recommendFanout(taskText): the pure baseline fan-out width.
//   2. signal-radar                     -> recent high/medium severity Signals as a live risk estimator
//      (a lane that is already flapping is a lane worth extra scrutiny right now, not just on average).
//   3. fleet-telemetry/task-router.mjs  -> classifyTask(taskText): opus vs sonnet (vs haiku) model pick.
// critic-pass is not imported here; this module only decides WHETHER the orchestrator should run a
// critic pass (useCritic), the actual gate lives in skills/critic-pass/critic.mjs.
//
// DESIGN CONTRACT: allocateCompute() is 100% pure (no I/O, no imports of the signal store, no network).
// It takes recentSignals as a plain array the caller already fetched (or filtered). This is what makes
// it trivially unit-testable and keeps the "hard part" (deciding fan-out/model/critic) fully hermetic.
// recentSignalsFor() is the ONE impure helper, and it is fail-open by construction: any error anywhere
// in the Cosmos read path (missing creds, network failure, malformed response, common.mjs itself failing
// to import) is caught and degrades to an empty array, never a thrown error. A broken signal store must
// never prevent the allocator from falling back to pure effort-scaling.
//
// Advisory only, same posture as effort-scale.mjs and critic-pass.mjs: the orchestrator makes the final
// call on agents/model/useCritic; this module recommends.

import { recommendFanout } from "../fleet-dispatch/effort-scale.mjs";

const MAX_AGENTS = 4;

// High-stakes keywords used ONLY when there are no relevant recent signals at all (the "no signal"
// branch below), mirrors task-router.mjs's QUALITY_SIGNALS spirit but narrower: this is specifically
// about "should a critic pass gate this even though nothing is currently flapping," not model choice.
const HIGH_STAKES_SIGNALS = /\b(judg(e|ment)|security|secure|migrat|money|billing|payment|refund|compliance|phi|hipaa|credential|delete|production|prod\b|irreversib)\w*/i;

// Same DEEP_SIGNALS spirit as fleet-telemetry/task-router.mjs, kept local so allocate.mjs still works
// (falls back to this) if task-router.mjs is ever absent or fails to import. Deliberately simple and
// keyword-based, consistent with the rest of this repo's classifier style (effort-scale, task-router).
const DEEP_REASONING_SIGNALS = /\b(architect|design|deep(ly)? reason|reverse.?engineer|prove|derive|root.?cause|complex trade.?off|security review|threat model)\b/i;

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : lo));
}

/** Best-effort, defensive read of a signal's severity. Anything not exactly "high"/"medium"/"low"
 * (missing field, wrong type, typo) is treated as absent rather than thrown on. */
function severityOf(sig) {
  if (!sig || typeof sig !== "object") return null;
  const sev = sig.severity;
  return sev === "high" || sev === "medium" || sev === "low" ? sev : null;
}

/**
 * inferModel(taskText) -> "opus" | "sonnet"
 * Local fallback classifier, used only when fleet-telemetry/task-router.mjs is unavailable. Kept
 * intentionally simple: deep-reasoning/architecture/security/design-heavy language routes to opus,
 * everything else defaults to sonnet (never haiku here, this module is about ALLOCATING more
 * compute for risk, not trimming cost, so it never recommends the cheap tier on its own).
 */
export function inferModel(taskText) {
  const t = String(taskText || "");
  return DEEP_REASONING_SIGNALS.test(t) ? "opus" : "sonnet";
}

/**
 * allocateCompute({ taskText, recentSignals }) -> { agents, model, useCritic, rationale }
 *
 * taskText: free-form description of the task about to be dispatched (same shape effort-scale.mjs
 *   and task-router.mjs take).
 * recentSignals: array of { severity, subject, detector } objects, ALREADY filtered/relevant to the
 *   task's domain by the caller (e.g. via recentSignalsFor(lane)). This function does not re-filter
 *   by subject itself, the caller is expected to have done that loose subject/lane match (signal-radar's
 *   `subject` field is free-form per detector: an app name, secret id, build id, task id...), because
 *   only the caller knows the task's domain well enough to judge "relevant." Passing an already-filtered
 *   list keeps this function pure and keeps the relevance judgment call at the edge, not buried in here.
 *
 * Pure: no I/O, no throws on malformed input. Null/undefined/non-array recentSignals, or entries missing
 * fields, degrade to "treat as no signals" rather than crashing, this is the fail-open contract the
 * spec asks for, applied at the allocation layer too (not just at the store-read layer).
 */
export function allocateCompute({ taskText, recentSignals } = {}) {
  const text = String(taskText || "");
  const base = recommendFanout(text);

  const signals = Array.isArray(recentSignals) ? recentSignals : [];
  const severities = signals.map(severityOf).filter(Boolean);
  const hasHigh = severities.includes("high");
  const hasMedium = severities.includes("medium");

  let agents = base.agents;
  let useCritic = false;
  let signalNote;

  if (hasHigh) {
    // Escalate toward the cap rather than jumping straight to 4: a base of 1 becomes 2 (still modest,
    // this was a lookup-shaped task), while a base already at 2+ climbs by one each time up to the cap.
    // This keeps "one high-severity signal on a trivial lookup" from instantly demanding 4 agents, while
    // still meaningfully increasing scrutiny relative to the pure baseline.
    agents = Math.min(MAX_AGENTS, base.agents + 1);
    useCritic = true;
    signalNote = `${severities.filter((s) => s === "high").length} HIGH-severity recent signal(s) in this lane: escalated agents ${base.agents} -> ${agents} and forced useCritic=true (a lane that is actively flapping deserves a second look before it ships).`;
  } else if (hasMedium) {
    agents = base.agents;
    useCritic = true;
    signalNote = `${severities.filter((s) => s === "medium").length} MEDIUM-severity recent signal(s) in this lane: agents held at the base fan-out (${agents}), but useCritic=true (worth a cheap verification pass, not worth extra fan-out yet).`;
  } else {
    agents = base.agents;
    const highStakesText = HIGH_STAKES_SIGNALS.test(text);
    useCritic = highStakesText;
    signalNote = highStakesText
      ? "No relevant recent signals, but the task text itself matches a high-stakes keyword (security/migration/money/compliance/PHI/credentials/delete/production/irreversible): useCritic=true on that basis alone."
      : "No relevant recent signals and no high-stakes keyword in the task text: useCritic=false, pure effort-scaling baseline stands.";
  }

  agents = clamp(Math.round(agents), 1, MAX_AGENTS);

  // Synchronous model inference: fleet-telemetry/task-router.mjs's classifyTask is preferred and used
  // via allocateComputeAsync() below (it is a real module, not guaranteed synchronously importable from
  // a pure function without top-level await), so the plain synchronous allocateCompute() uses the local
  // keyword fallback. This keeps allocateCompute() 100% synchronous and pure, per the spec.
  const model = inferModel(text);

  const rationale = `${base.rationale} ${signalNote}`;

  return { agents, model, useCritic, rationale };
}

// classifyTask is imported dynamically (not statically) so a missing/broken task-router.mjs never
// prevents this module itself from loading, a static `import` would throw at module-load time for
// every caller of allocate.mjs, not just the ones that hit this code path.
let _classifyTaskPromise;
async function resolveModel(taskText) {
  if (_classifyTaskPromise === undefined) {
    _classifyTaskPromise = import("../fleet-telemetry/task-router.mjs").catch(() => null);
  }
  const mod = await _classifyTaskPromise;
  if (mod && typeof mod.classifyTask === "function") {
    try {
      const r = mod.classifyTask(taskText);
      // task-router can recommend haiku for mechanical work; compute-allocator never downgrades below
      // sonnet on its own (it exists to ALLOCATE more compute under risk, not to trim cost), so haiku
      // is floored to sonnet here.
      if (r && (r.model === "opus" || r.model === "sonnet")) return r.model;
      return "sonnet";
    } catch {
      return inferModel(taskText);
    }
  }
  return inferModel(taskText);
}

/**
 * allocateComputeAsync({ taskText, recentSignals }) -> Promise<{ agents, model, useCritic, rationale }>
 * Same decision logic as allocateCompute, but resolves `model` via fleet-telemetry/task-router.mjs's
 * classifyTask when that module is importable, falling back to inferModel() otherwise. Split out from
 * the synchronous, fully pure allocateCompute() so the core allocation logic stays trivially testable
 * without ever touching import()/dynamic module resolution in the hot path.
 */
export async function allocateComputeAsync({ taskText, recentSignals } = {}) {
  const sync = allocateCompute({ taskText, recentSignals });
  const model = await resolveModel(taskText);
  return { ...sync, model };
}

/**
 * recentSignalsFor(subjectOrLane) -> Promise<Array<{severity, subject, detector}>>
 * The ONE non-pure helper in this module. Mirrors signal-radar's OWN read pattern exactly:
 * common.mjs's cosmosConfig() resolves {endpoint, key, db} from Secret Manager (via the claude-driver
 * SA), then cosmosQuerySignals(owner, query, parameters) runs a partitioned SQL query against the
 * `signals` container (partitioned by /owner, same as radar.mjs's own cooldown-history lookup at
 * radar.mjs:96). signal-radar has no local JSON file store (recent signals live in Cosmos, not on
 * disk), so this helper talks to the SAME Cosmos container the same way, rather than inventing a
 * second store or a different query shape.
 *
 * subjectOrLane is used two ways, exactly mirroring how radar.mjs itself treats these two concepts:
 *   - it is tried first as an OWNER partition key (radar's routing key: cto|cfo|growth|commerce), since
 *     that is the only indexed/partitioned dimension cosmosQuerySignals can query directly;
 *   - the result is then filtered client-side by a loose case-insensitive substring match against each
 *     signal's `subject` field, so a caller passing an app name / secret id / build id (signal-radar's
 *     free-form `subject` shape, per schema.mjs) still gets a meaningfully narrowed list even though
 *     `subject` itself is not a partition key.
 * If subjectOrLane does not look like a known owner, this queries every known owner partition and
 * relies entirely on the client-side subject filter.
 *
 * FAIL-OPEN CONTRACT: wrapped in try/catch end-to-end. Missing GCP creds, Cosmos not provisioned,
 * network failure, malformed JSON, or common.mjs/schema.mjs failing to import for any reason all result
 * in `[]`, never a thrown error. This is what lets allocateCompute() degrade to pure effort-scaling
 * whenever the signal store is unreadable, exactly as the orchestrator should be able to rely on.
 */
export async function recentSignalsFor(subjectOrLane) {
  try {
    // Dynamic import: if signal-radar's own files are missing/moved/broken, that failure is caught here
    // too, same fail-open guarantee as a network error.
    const { cosmosConfig, cosmosQuerySignals } = await import("../signal-radar/common.mjs");
    const { OWNER_BY_DOMAIN } = await import("../signal-radar/schema.mjs");

    const cfg = await cosmosConfig().catch(() => null);
    if (!cfg) return [];

    const needle = String(subjectOrLane || "").trim().toLowerCase();
    const knownOwners = Array.from(new Set(Object.values(OWNER_BY_DOMAIN)));
    const owners = needle && knownOwners.includes(needle) ? [needle] : knownOwners;

    // Same query shape as radar.mjs:96 (cooldown history lookup), generalized from "same id" to "recent
    // rows for this owner partition," ordered newest-first, capped at 50 so this never pulls an unbounded
    // history out of a long-lived container.
    const query = "SELECT TOP 50 c.severity, c.subject, c.detector, c.ts FROM c ORDER BY c.ts DESC";

    let rows = [];
    for (const owner of owners) {
      try {
        const r = await cosmosQuerySignals(owner, query, []);
        if (Array.isArray(r)) rows = rows.concat(r);
      } catch {
        // fail-open per-owner: one bad partition query does not blank out the others.
      }
    }

    const filtered = needle
      ? rows.filter((r) => String(r?.subject || "").toLowerCase().includes(needle) || String(r?.detector || "").toLowerCase().includes(needle))
      : rows;

    return filtered.map((r) => ({
      severity: severityOf(r) || "low",
      subject: typeof r?.subject === "string" ? r.subject : "",
      detector: typeof r?.detector === "string" ? r.detector : "",
    }));
  } catch {
    // Fail-open: ANY error anywhere above (missing SA, no network, bad JSON, missing module) -> [].
    return [];
  }
}

export default { allocateCompute, allocateComputeAsync, recentSignalsFor, inferModel };

// ---------------------------------------------------------------------------
// CLI: node allocate.mjs "<task text>" [--signals '[{"severity":"high","subject":"x","detector":"y"}]']
//                                       [--lane <subjectOrLane>] [--live]
// --live fetches recentSignals via recentSignalsFor(--lane) instead of/in addition to --signals.
// Mirrors effort-scale.mjs's / critic.mjs's CLI style: plain argv parsing, JSON out on stdout.
// ---------------------------------------------------------------------------

function parseArgv(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        out[key] = next;
        i++;
      } else {
        out[key] = true;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

const isMain = (() => {
  try {
    return process.argv[1] && new URL(import.meta.url).pathname === process.argv[1];
  } catch {
    return false;
  }
})();

if (isMain) {
  (async () => {
    const argv = process.argv.slice(2);
    const args = parseArgv(argv);
    const taskText = args._.join(" ");

    if (!taskText.trim()) {
      console.error('usage: node allocate.mjs "<task text>" [--signals \'<json array>\'] [--lane <subjectOrLane>] [--live]');
      process.exit(2);
    }

    let recentSignals = [];
    if (typeof args.signals === "string") {
      try {
        const parsed = JSON.parse(args.signals);
        if (Array.isArray(parsed)) recentSignals = parsed;
      } catch {
        console.error("warning: --signals was not valid JSON; ignoring (falling back to no signals)");
      }
    }
    if (args.live) {
      const live = await recentSignalsFor(typeof args.lane === "string" ? args.lane : "");
      recentSignals = recentSignals.concat(live);
    }

    const result = await allocateComputeAsync({ taskText, recentSignals });
    console.log(JSON.stringify(result, null, 2));
  })();
}
