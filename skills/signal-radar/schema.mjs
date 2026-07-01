// signal-radar/schema.mjs — the Signal type + pure (no I/O) helpers: severity ranking, cooldown,
// consecutive-escalation, and the MNPI/PHI routing table. Kept separate from radar.mjs so it is
// trivially unit-testable (mirrors fleet-medic's classify() being the hermetic "brain").

/**
 * A Signal is what a detector emits. Fields:
 *   id            stable id for this specific finding (detector + subject + window), used for
 *                 cooldown / consecutive-escalate lookups. NOT globally unique across ticks.
 *   detector       which detector produced it (e.g. "sentry-error-spike")
 *   owner          which agent's inbox this routes to (cto|cfo|growth|commerce|...) - the ROUTING key
 *   subject        the thing the signal is about (app name, secret id, build id, task id...)
 *   severity       "low" | "medium" | "high"
 *   why            ONE line, human-readable, the whole point of "high precision"
 *   evidence_link  a URL or a locator string the owner can click/open to verify
 *   suggested_action  ONE line, concrete next step
 *   mnpi           true if this signal touches INND/securities-sensitive data (routes CFO-ONLY,
 *                  never into a fleet-wide digest)
 *   ts             ISO timestamp
 */
export function makeSignal({ detector, owner, subject, severity, why, evidence_link, suggested_action, mnpi = false }) {
  return {
    id: signalId(detector, subject),
    detector, owner, subject, severity, why,
    evidence_link: evidence_link || null,
    suggested_action, mnpi,
    ts: new Date().toISOString(),
  };
}

/** Deterministic id for a (detector, subject) pair. Same subject re-firing reuses the same id, which
 * is what makes cooldown / consecutive-escalate possible without a fuzzy match. */
export function signalId(detector, subject) {
  return `${detector}::${String(subject).toLowerCase().replace(/[^a-z0-9_.-]+/g, "-")}`;
}

export const SEVERITY_RANK = { high: 0, medium: 1, low: 2 };

/** Owning agent per signal domain. Growth/commerce/cfo/cto are the only routes today; unknown
 * detectors default to "cto" (the infra/portfolio catch-all) rather than silently dropping a signal. */
export const OWNER_BY_DOMAIN = {
  infra: "cto",
  burn: "cfo",
  funnel: "growth",
  inventory: "commerce",
  agent_quality: "cto",
  release: "cto",
  security: "cto",
};

/**
 * Decide whether THIS tick's finding should actually dispatch, given the finding's own history
 * (previously-seen signals for the same id). Pure function, no I/O -> unit-testable exactly like
 * fleet-medic's classify(). Cooldown stops re-spamming a flapping metric every scan; an escalate flag
 * fires once a signal has repeated past a threshold (the caller can bump severity or CC a human).
 *
 * history: array of prior signal docs for this id, each with { ts }, newest-last or any order (sorted here).
 * now: epoch ms.
 * opts: { cooldownMin = 360, escalateAfter = 3 }
 * returns: { fire: bool, escalate: bool, consecutive: number, reason: string }
 */
export function shouldFire(history, now, opts = {}) {
  const cooldownMin = opts.cooldownMin ?? 360;
  const escalateAfter = opts.escalateAfter ?? 3;
  const sorted = [...(history || [])].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  const last = sorted[sorted.length - 1];
  const sinceLastMin = last ? (now - Date.parse(last.ts)) / 60000 : Infinity;
  if (last && sinceLastMin < cooldownMin) {
    return { fire: false, escalate: false, consecutive: sorted.length, reason: `cooldown (${Math.round(sinceLastMin)}m < ${cooldownMin}m)` };
  }
  const consecutive = sorted.length + 1; // this tick would be one more
  const escalate = consecutive >= escalateAfter;
  return { fire: true, escalate, consecutive, reason: escalate ? `persistent (${consecutive}x)` : "new or past cooldown" };
}

/**
 * MNPI/PHI hard guardrail. A signal whose subject/detector touches INND securities data (stock price,
 * Xero/Plaid financials, cap table) MUST be routed CFO-ONLY and marked mnpi=true so the digest/dispatch
 * layer never fans it into a fleet-wide channel. A detector should call this before emitting.
 */
export function isMnpiSubject(detectorName, subject) {
  const s = `${detectorName} ${subject}`.toLowerCase();
  return /innd|xero|plaid|stock|cap.?table|investor|securities|reg.?fd/.test(s);
}

/** PHI hard guardrail: no MedReview / PHI-ring source may ever be a data source for a detector. */
export const PHI_EXCLUDED_SOURCES = new Set(["medreview", "medreview-api", "medreview-admin", "medreview-web"]);
export function isPhiExcluded(name) {
  return PHI_EXCLUDED_SOURCES.has(String(name || "").toLowerCase());
}
