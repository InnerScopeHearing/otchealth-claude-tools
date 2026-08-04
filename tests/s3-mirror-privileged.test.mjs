// Tests for skills/fleet-backup/s3-mirror.mjs's ring-segregation classification logic -- the hard
// compliance boundary of the whole S3 DR mirror (README.md "ring segregation, hard compliance
// requirement"): a privileged/sensitive room must never reach the non-privileged bucket. Pure,
// deterministic, no network/credential dependency, so it is exercised directly rather than only through
// a full `run()` against live Azure/AWS credentials.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isPrivilegedByName,
  isPrivileged,
  indexNameFromBlob,
  ringGatedIndexNames,
  isNeverMirrorByName,
  isPersonalLegalByName,
  classifyLane,
} from "../skills/fleet-backup/s3-mirror.mjs";

test("isPrivilegedByName: the Cosmos ledger export and known-safe room dumps are NOT privileged", () => {
  assert.equal(isPrivilegedByName("tasks-2026-07-15.jsonl"), false);
  assert.equal(isPrivilegedByName("index-memory-exec-2026-07-15.jsonl"), false);
  assert.equal(isPrivilegedByName("index-commons-company-journal-2026-07-15.jsonl"), false);
  assert.equal(isPrivilegedByName("manifest-2026-07-15.json"), false);
});

test("isPrivilegedByName: every documented privileged substring is caught, case-insensitively", () => {
  assert.equal(isPrivilegedByName("index-legal-personal-2026-07-15.jsonl"), true);
  assert.equal(isPrivilegedByName("index-legal-company-2026-07-15.jsonl"), true);
  assert.equal(isPrivilegedByName("index-finance-cfo-source-docs-2026-07-15.jsonl"), true);
  assert.equal(isPrivilegedByName("index-cfo-memory-2026-07-15.jsonl"), true);
  assert.equal(isPrivilegedByName("some-personal-export-2026-07-15.jsonl"), true);
  assert.equal(isPrivilegedByName("MEDREVIEW-dump-2026-07-15.jsonl"), true);
  assert.equal(isPrivilegedByName("PHI-audit-2026-07-15.jsonl"), true);
  // mixed case, substring in the middle, not just as a prefix
  assert.equal(isPrivilegedByName("index-Finance-CFO-source-docs-2026-07-15.jsonl"), true);
});

test("indexNameFromBlob: extracts the room name from a dated index blob, else null", () => {
  assert.equal(indexNameFromBlob("index-memory-exec-2026-07-15.jsonl"), "memory-exec");
  assert.equal(indexNameFromBlob("index-legal-company-2026-07-15.jsonl"), "legal-company");
  // a room name that itself contains hyphens and digits must not confuse the trailing date capture
  assert.equal(indexNameFromBlob("index-commerce-commerce-source-docs-2026-07-15.jsonl"), "commerce-commerce-source-docs");
  assert.equal(indexNameFromBlob("tasks-2026-07-15.jsonl"), null);
  assert.equal(indexNameFromBlob("manifest-2026-07-15.json"), null);
  assert.equal(indexNameFromBlob("s3-mirror-manifest-2026-07-15.json"), null);
});

test("ringGatedIndexNames: only indexes whose queried_by mentions 'privileged' are flagged", () => {
  const registry = [
    { index: "memory-exec", queried_by: ["brain_search", "kb_search"] },
    { index: "legal-company", queried_by: ["kb_search_privileged"] },
    { index: "finance-cfo-source-docs", queried_by: ["kb_search_privileged", "brain_search"] },
    { index: "commons-company-journal", queried_by: [] },
  ];
  const names = ringGatedIndexNames(registry);
  assert.ok(names.has("legal-company"));
  assert.ok(names.has("finance-cfo-source-docs"));
  assert.ok(!names.has("memory-exec"));
  assert.ok(!names.has("commons-company-journal"));
});

test("ringGatedIndexNames: tolerates a missing/empty queried_by field", () => {
  const names = ringGatedIndexNames([{ index: "no-queried-by-field" }, { index: "empty", queried_by: [] }]);
  assert.equal(names.size, 0);
});

test("isPrivileged: the second, independent registry cross-check catches a room the substring list misses", () => {
  const ringGated = new Set(["some-newly-ring-gated-room"]);
  // not caught by the substring list, but IS in the registry cross-check -- must still be privileged
  assert.equal(isPrivileged("index-some-newly-ring-gated-room-2026-07-15.jsonl", ringGated), true);
  // caught by the substring list alone, with an empty registry cross-check
  assert.equal(isPrivileged("index-legal-personal-2026-07-15.jsonl", new Set()), true);
  // neither signal fires -> not privileged
  assert.equal(isPrivileged("index-memory-exec-2026-07-15.jsonl", new Set()), false);
});

test("isPrivileged: fail-closed direction -- when in doubt, classify privileged, never the reverse", () => {
  // a blob name that merely CONTAINS a privileged substring anywhere, not just as a clean token, is
  // still classified privileged (deliberately over-inclusive per the file's own design comment).
  assert.equal(isPrivilegedByName("weird-cfoadjacent-name-2026-07-15.jsonl"), true);
});

// ---------- two-lane split (2026-08-04, AZURE-LOSS-DR-PLAN.md gap #3) ----------
// The load-bearing guarantee this whole section pins: a personal-legal room (Matt's CA divorce/
// family/civil matters, including minors' data) can NEVER classify into the same lane as a
// finance/CFO room, and PHI/medreview can NEVER classify into ANY arm-able lane at all -- those are
// the exact two failure modes that would recreate the P0 cross-ring leak this split exists to prevent.

test("isNeverMirrorByName: medreview and phi are blocked, unconditionally, case-insensitively", () => {
  assert.equal(isNeverMirrorByName("MEDREVIEW-dump-2026-07-15.jsonl"), true);
  assert.equal(isNeverMirrorByName("PHI-audit-2026-07-15.jsonl"), true);
  assert.equal(isNeverMirrorByName("index-legal-personal-2026-07-15.jsonl"), false);
  assert.equal(isNeverMirrorByName("index-finance-cfo-source-docs-2026-07-15.jsonl"), false);
});

test("isPersonalLegalByName: legal-personal and any *-personal* room, but NEVER a medreview/phi blob (never-mirror wins)", () => {
  assert.equal(isPersonalLegalByName("index-legal-personal-2026-07-15.jsonl"), true);
  assert.equal(isPersonalLegalByName("index-legal-personal-memory-2026-07-15.jsonl"), true);
  assert.equal(isPersonalLegalByName("some-personal-export-2026-07-15.jsonl"), true);
  assert.equal(isPersonalLegalByName("index-legal-company-2026-07-15.jsonl"), false);
  assert.equal(isPersonalLegalByName("index-finance-cfo-source-docs-2026-07-15.jsonl"), false);
  // regression pin: a name that happens to contain BOTH a personal substring and a never-mirror
  // substring must resolve as never-mirror, not personal-legal -- the PHI wall always wins.
  assert.equal(isPersonalLegalByName("medreview-personal-notes-2026-07-15.jsonl"), false);
});

test("classifyLane: resolves every blob to exactly one of four lanes, with the documented priority order", () => {
  const noRingGate = new Set();
  assert.equal(classifyLane("tasks-2026-07-15.jsonl", noRingGate), "non-privileged");
  assert.equal(classifyLane("index-memory-exec-2026-07-15.jsonl", noRingGate), "non-privileged");
  assert.equal(classifyLane("index-legal-personal-2026-07-15.jsonl", noRingGate), "personal-legal");
  assert.equal(classifyLane("index-legal-personal-memory-2026-07-15.jsonl", noRingGate), "personal-legal");
  assert.equal(classifyLane("some-other-personal-room-2026-07-15.jsonl", noRingGate), "personal-legal");
  assert.equal(classifyLane("index-legal-company-2026-07-15.jsonl", noRingGate), "finance-company-legal");
  assert.equal(classifyLane("index-finance-cfo-source-docs-2026-07-15.jsonl", noRingGate), "finance-company-legal");
  assert.equal(classifyLane("index-cfo-memory-2026-07-15.jsonl", noRingGate), "finance-company-legal");
  // never-mirror wins over every other signal, including one that also looks personal or finance-y
  assert.equal(classifyLane("MEDREVIEW-dump-2026-07-15.jsonl", noRingGate), "never-mirror");
  assert.equal(classifyLane("PHI-audit-2026-07-15.jsonl", noRingGate), "never-mirror");
  assert.equal(classifyLane("medreview-cfo-crossover-2026-07-15.jsonl", noRingGate), "never-mirror");
});

test("classifyLane: a ring-gated room not caught by any substring falls through to finance-company-legal, never non-privileged", () => {
  // the registry cross-check is a second, independent signal for rooms the naming convention alone
  // doesn't catch -- it must never silently land in the open, non-privileged bucket.
  const ringGated = new Set(["some-newly-ring-gated-room"]);
  assert.equal(classifyLane("index-some-newly-ring-gated-room-2026-07-15.jsonl", ringGated), "finance-company-legal");
});

test("classifyLane: a ring-gated room that ALSO matches the personal-legal substring still lands in personal-legal, not finance-company-legal", () => {
  const ringGated = new Set(["legal-personal"]);
  assert.equal(classifyLane("index-legal-personal-2026-07-15.jsonl", ringGated), "personal-legal");
});

test("classifyLane: regression pin -- a personal-legal blob and a finance/CFO blob NEVER resolve to the same lane (the exact P0 recurrence this split prevents)", () => {
  const noRingGate = new Set();
  const personalLane = classifyLane("index-legal-personal-2026-07-15.jsonl", noRingGate);
  const financeLane = classifyLane("index-finance-cfo-source-docs-2026-07-15.jsonl", noRingGate);
  assert.notEqual(personalLane, financeLane);
  assert.equal(personalLane, "personal-legal");
  assert.equal(financeLane, "finance-company-legal");
});
