/* Pure structural validator for synthetic N14 quality-clock records.
 * This module deliberately assigns no policy, durations, actors, or live sources.
 */

const validCertainty = new Set(["certain", "uncertain"]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function timestamp(value) {
  if (!nonEmptyString(value)) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, , zoneHour = "00", zoneMinute = "00"] = match;
  if (+month < 1 || +month > 12 || +day < 1 || +day > new Date(Date.UTC(+year, +month, 0)).getUTCDate() ||
      +hour > 23 || +minute > 59 || +second > 59 || +zoneHour > 23 || +zoneMinute > 59) return null;
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? millis : null;
}

function sameIdentity(a, b) {
  return isObject(a) && isObject(b) &&
    a.sourceId === b.sourceId &&
    a.version === b.version &&
    a.contentHash === b.contentHash;
}

/**
 * Validate one synthetic complaint/quality clock record.
 * Returns deterministic diagnostics only; it performs no I/O or side effects.
 */
export function validateComplaintCase(record, nowIso) {
  const errors = [];
  const add = (code) => errors.push(code);

  if (!isObject(record)) {
    return { accepted: false, state: "held", reasons: ["record.invalid"] };
  }

  const identity = record.identity;
  if (!isObject(identity) || !nonEmptyString(identity.sourceId) ||
      !nonEmptyString(identity.version) || !nonEmptyString(identity.contentHash)) {
    add("identity.incomplete");
  }

  const awareness = record.awareness;
  const awarenessMs = isObject(awareness) ? timestamp(awareness.at) : null;
  if (!isObject(awareness) || awarenessMs === null) add("awareness.time_invalid");
  if (!isObject(awareness) || !validCertainty.has(awareness.certainty)) add("awareness.certainty_invalid");
  if (!isObject(awareness) || awareness.sourceId !== identity?.sourceId || awareness.sourceVersion !== identity?.version) {
    add("awareness.identity_mismatch");
  }
  const observedMs = isObject(awareness) ? timestamp(awareness.sourceObservedAt) : null;
  const skew = isObject(awareness) ? awareness.clockSkewSeconds : null;
  if (observedMs === null || typeof skew !== "number" || !Number.isFinite(skew)) {
    add("awareness.observation_or_skew_invalid");
  } else if (awarenessMs !== null && awarenessMs !== observedMs + skew * 1000) {
    add("awareness.skew_binding_mismatch");
  }

  const owner = record.owner;
  if (!isObject(owner) || !nonEmptyString(owner.actorId) || owner.qualified !== true ||
      !nonEmptyString(owner.qualificationRef)) {
    add("owner.not_qualified_named");
  }

  const backup = record.backup;
  if (!isObject(backup) || !nonEmptyString(backup.actorId) || backup.qualified !== true ||
      !nonEmptyString(backup.qualificationRef)) {
    add("backup.not_qualified_named");
  }
  if (isObject(owner) && isObject(backup) && nonEmptyString(owner.actorId) && owner.actorId === backup.actorId) {
    add("backup.not_distinct");
  }

  const due = record.due;
  const dueMs = isObject(due) ? timestamp(due.at) : null;
  if (!isObject(due) || !validCertainty.has(due.certainty)) add("due.certainty_invalid");
  if (isObject(due) && due.certainty === "certain" && dueMs === null) add("due.time_invalid");
  if (awarenessMs !== null && dueMs !== null && dueMs < awarenessMs) add("due.before_awareness");

  const policy = record.policy;
  const adoptedAtMs = isObject(policy) ? timestamp(policy.adoptedAt) : null;
  if (!isObject(policy) || !nonEmptyString(policy.policyId) || !nonEmptyString(policy.version) ||
      policy.adopted !== true || typeof policy.durationMinutes !== "number" ||
      !Number.isFinite(policy.durationMinutes) || policy.durationMinutes <= 0 || adoptedAtMs === null) {
    add("policy.not_adopted_or_incomplete");
  } else {
    if (awarenessMs !== null && adoptedAtMs > awarenessMs) add("policy.adopted_after_awareness");
    if (due?.policyId !== policy.policyId || due?.policyVersion !== policy.version) add("due.policy_mismatch");
    if (awarenessMs !== null && dueMs !== null &&
        dueMs !== awarenessMs + policy.durationMinutes * 60_000) add("due.policy_clock_mismatch");
  }

  const coverage = isObject(backup) ? backup.coverage : null;
  const coverageFrom = isObject(coverage) ? timestamp(coverage.from) : null;
  const coverageTo = isObject(coverage) ? timestamp(coverage.to) : null;
  if (!isObject(coverage) || coverageFrom === null || coverageTo === null || coverageTo < coverageFrom) {
    add("backup.coverage_invalid");
  } else if (awarenessMs !== null && dueMs !== null &&
      (coverageFrom > awarenessMs || coverageTo < dueMs)) {
    add("backup.coverage_incomplete");
  }

  const acknowledgement = record.acknowledgement;
  if (!isObject(acknowledgement)) {
    add("acknowledgement.missing");
  } else {
    const acknowledgedAtMs = timestamp(acknowledgement.at);
    if (acknowledgedAtMs === null) add("acknowledgement.time_invalid");
    if (awarenessMs !== null && acknowledgedAtMs !== null && acknowledgedAtMs < awarenessMs) {
      add("acknowledgement.before_awareness");
    }
    if (dueMs !== null && acknowledgedAtMs !== null && acknowledgedAtMs > dueMs) {
      add("acknowledgement.after_due");
    }
    const isOwner = isObject(owner) && acknowledgement.actorId === owner.actorId && owner.qualified === true;
    const isBackup = isObject(backup) && acknowledgement.actorId === backup.actorId && backup.qualified === true;
    if (!isOwner && !isBackup) add("acknowledgement.actor_unqualified_or_unassigned");
    if (acknowledgement.awarenessAt !== awareness?.at) add("acknowledgement.not_bound_to_awareness");
    if (!sameIdentity(acknowledgement.identity, identity)) add("acknowledgement.identity_mismatch");
  }

  const evaluatedAtMs = timestamp(nowIso);
  if (evaluatedAtMs === null) add("evaluation.time_invalid");
  if (awarenessMs !== null && evaluatedAtMs !== null && awarenessMs > evaluatedAtMs) add("awareness.after_evaluation");
  const acknowledgedAtMs = isObject(acknowledgement) ? timestamp(acknowledgement.at) : null;
  if (acknowledgedAtMs !== null && evaluatedAtMs !== null && acknowledgedAtMs > evaluatedAtMs) {
    add("acknowledgement.after_evaluation");
  }
  if (typeof skew === "number" && Number.isFinite(skew) && skew !== 0) add("awareness.skew_requires_review");
  const closed = isObject(record.closure);
  if (closed) {
    const closureMs = timestamp(record.closure.at);
    if (closureMs === null) add("closure.time_invalid");
    if (closureMs !== null && awarenessMs !== null && closureMs < awarenessMs) add("closure.before_awareness");
    const acknowledgedAtMs = isObject(acknowledgement) ? timestamp(acknowledgement.at) : null;
    if (closureMs !== null && acknowledgedAtMs !== null && closureMs < acknowledgedAtMs) {
      add("closure.before_acknowledgement");
    }
    if (closureMs !== null && evaluatedAtMs !== null && closureMs > evaluatedAtMs) add("closure.after_evaluation");
    const receipt = record.closure.receipt;
    if (!(nonEmptyString(receipt) || (isObject(receipt) && nonEmptyString(receipt.receiptId)))) {
      add("closure.receipt_missing");
    }
    if (record.closure.state !== "resolved") add("closure.state_unconfirmed");
    if (!isObject(record.closure.nativeReadback) ||
        record.closure.nativeReadback.verified !== true ||
        record.closure.nativeReadback.sourceId !== identity?.sourceId ||
        record.closure.nativeReadback.version !== identity?.version) {
      add("closure.native_readback_missing");
    }
    if (!sameIdentity(record.closure.identity, identity)) add("closure.identity_mismatch");
    if (!record.acknowledgement) add("closure.without_acknowledgement");
  }

  const clockUncertain = awareness?.certainty === "uncertain" || due?.certainty === "uncertain" ||
    (typeof skew === "number" && Number.isFinite(skew) && skew !== 0);
  const overdue = due?.certainty === "certain" && dueMs !== null && evaluatedAtMs !== null &&
    evaluatedAtMs > dueMs && !closed;
  const mustHold = clockUncertain || overdue;
  const escalation = record.escalation;
  if (mustHold && (!isObject(escalation) || escalation.escalated !== true || escalation.held !== true)) {
    add("escalation.hold_required");
  }
  if (!mustHold && isObject(escalation) && escalation.held === true && escalation.escalated !== true) {
    add("escalation.hold_without_escalation");
  }

  return {
    accepted: errors.length === 0,
    state: errors.length === 0 ? (mustHold ? "held" : closed ? "closed" : "open") : "held",
    reasons: errors,
  };
}

// Kept as an explicit compatibility alias; callers should pass their evaluation clock.
export const validateN14QualityClock = validateComplaintCase;
