import test from "node:test";
import assert from "node:assert/strict";
import { validateComplaintCase } from "./n14-quality.mjs";

const identity = { sourceId: "synthetic-source-7", version: "v1", contentHash: "sha256:abc" };
const NOW = "2026-10-05T10:05:00Z";

function validRecord() {
  return {
    identity: { ...identity },
    awareness: {
      at: "2026-10-05T10:00:00Z", certainty: "certain", sourceId: identity.sourceId,
      sourceVersion: identity.version, sourceObservedAt: "2026-10-05T10:00:00Z", clockSkewSeconds: 0,
    },
    owner: { actorId: "qualified-owner", qualified: true, qualificationRef: "synthetic-qual-owner" },
    backup: {
      actorId: "qualified-backup", qualified: true, qualificationRef: "synthetic-qual-backup",
      coverage: { from: "2026-10-05T09:00:00Z", to: "2026-10-05T13:00:00Z" },
    },
    acknowledgement: {
      actorId: "qualified-owner", at: "2026-10-05T10:03:00Z",
      awarenessAt: "2026-10-05T10:00:00Z", identity: { ...identity },
    },
    policy: {
      policyId: "synthetic-policy", version: "p1", adopted: true, durationMinutes: 120,
      adoptedAt: "2026-10-05T09:00:00Z",
    },
    due: {
      at: "2026-10-05T12:00:00Z", certainty: "certain",
      policyId: "synthetic-policy", policyVersion: "p1",
    },
  };
}

const errorCodes = (record, nowIso = NOW) => validateComplaintCase(record, nowIso).reasons;

test("accepts source-bound qualified ownership, coverage, acknowledgement, and due clock", () => {
  const result = validateComplaintCase(validRecord(), NOW);
  assert.deepEqual(result, { accepted: true, state: "open", reasons: [] });
});

test("accepts receipt-bound closure with unchanged source identity", () => {
  const record = validRecord();
  record.closure = {
    state: "resolved", at: "2026-10-05T10:04:00Z", identity: { ...identity },
    receipt: { receiptId: "synthetic-receipt-1" },
    nativeReadback: { verified: true, sourceId: identity.sourceId, version: identity.version },
  };
  const result = validateComplaintCase(record, NOW);
  assert.deepEqual(result, { accepted: true, state: "closed", reasons: [] });
});

test("uncertain clocks fail closed and require explicit escalation plus hold", () => {
  const record = validRecord();
  record.due = { ...record.due, at: null, certainty: "uncertain" };
  record.escalation = { escalated: true, held: true };
  assert.equal(validateComplaintCase(record, NOW).accepted, true);
  assert.equal(validateComplaintCase(record, NOW).state, "held");
  delete record.escalation;
  assert.ok(errorCodes(record).includes("escalation.hold_required"));
});

test("rejects missing or unqualified owner and backup, including same actor", () => {
  const missingOwner = validRecord();
  delete missingOwner.owner;
  assert.ok(errorCodes(missingOwner).includes("owner.not_qualified_named"));

  const unqualifiedBackup = validRecord();
  unqualifiedBackup.backup.qualified = false;
  assert.ok(errorCodes(unqualifiedBackup).includes("backup.not_qualified_named"));

  const sameActor = validRecord();
  sameActor.backup.actorId = sameActor.owner.actorId;
  assert.ok(errorCodes(sameActor).includes("backup.not_distinct"));
});

test("rejects inadequate or malformed backup coverage", () => {
  const record = validRecord();
  record.backup.coverage.to = "2026-10-05T11:59:59Z";
  assert.ok(errorCodes(record).includes("backup.coverage_incomplete"));

  const malformed = validRecord();
  malformed.backup.coverage.from = "not-a-time";
  assert.ok(errorCodes(malformed).includes("backup.coverage_invalid"));
});

test("rejects acknowledgement not bound to awareness, identity, or an assigned qualified actor", () => {
  const wrongAwareness = validRecord();
  wrongAwareness.acknowledgement.awarenessAt = "2026-10-05T10:01:00Z";
  assert.ok(errorCodes(wrongAwareness).includes("acknowledgement.not_bound_to_awareness"));

  const wrongIdentity = validRecord();
  wrongIdentity.acknowledgement.identity.version = "v2";
  assert.ok(errorCodes(wrongIdentity).includes("acknowledgement.identity_mismatch"));

  const unassigned = validRecord();
  unassigned.acknowledgement.actorId = "unassigned";
  assert.ok(errorCodes(unassigned).includes("acknowledgement.actor_unqualified_or_unassigned"));
});

test("rejects invalid/reversed clock values and escalates an overdue open clock", () => {
  const malformed = validRecord();
  malformed.awareness.at = "yesterday-ish";
  assert.ok(errorCodes(malformed).includes("awareness.time_invalid"));

  const reversed = validRecord();
  reversed.due.at = "2026-10-05T09:59:00Z";
  assert.ok(errorCodes(reversed).includes("due.before_awareness"));

  const overdue = validRecord();
  const overdueNow = "2026-10-05T12:01:00Z";
  overdue.escalation = { escalated: true, held: true };
  assert.equal(validateComplaintCase(overdue, overdueNow).state, "held");
  delete overdue.escalation;
  assert.ok(errorCodes(overdue, overdueNow).includes("escalation.hold_required"));
});

test("rejects closure without receipt and closure source-version drift", () => {
  const missingReceipt = validRecord();
  missingReceipt.closure = {
    state: "resolved", at: "2026-10-05T11:00:00Z", identity: { ...identity },
    nativeReadback: { verified: true, sourceId: identity.sourceId, version: identity.version },
  };
  assert.ok(errorCodes(missingReceipt).includes("closure.receipt_missing"));

  const drift = validRecord();
  drift.closure = {
    state: "resolved", at: "2026-10-05T11:00:00Z", identity: { ...identity, version: "v2" },
    receipt: { receiptId: "synthetic-receipt-1" },
    nativeReadback: { verified: true, sourceId: identity.sourceId, version: "v2" },
  };
  assert.ok(errorCodes(drift).includes("closure.identity_mismatch"));

  const premature = validRecord();
  premature.closure = {
    state: "resolved", at: "2026-10-05T10:01:00Z", identity: { ...identity },
    receipt: { receiptId: "synthetic-receipt-1" },
    nativeReadback: { verified: true, sourceId: identity.sourceId, version: identity.version },
  };
  assert.ok(errorCodes(premature).includes("closure.before_acknowledgement"));
});

test("rejects non-record input deterministically", () => {
  assert.deepEqual(validateComplaintCase(null, NOW), {
    accepted: false, state: "held", reasons: ["record.invalid"],
  });
});
