// Tests for contradiction-scan.mjs, the Phase-4 B2 pure normalize/partition/contest-detection logic
// and the injectable proposal-opener. Fixtures only -- no Cosmos, no Azure Key Vault, no network, and
// no real decision-clock/child_process shell-out (the opener's `exec` is always a spy here).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  normalizeAssertionRows,
  filterRecent,
  partitionBySubject,
  findContestedGroups,
  hasGenuineValueConflict,
  buildProposalText,
  proposalsFor,
  openProposals,
  DEFAULT_PARTITION_THRESHOLD,
  DEFAULT_CONFLICT_SUBJECT_THRESHOLD,
  MAX_PARTITION_SIZE,
} from "../contradiction-scan.mjs";

const NOW = Date.parse("2026-07-15T00:00:00Z");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const iso = (hoursAgo) => new Date(NOW - hoursAgo * HOUR).toISOString();
const isoDays = (daysAgo) => new Date(NOW - daysAgo * DAY).toISOString();

// Verified fixture sentences (see the module header comment for why the two-tier threshold matters):
// jaccard(A,B) = 0.4545 -- below groupAssertions' 0.5 inner threshold (so B does NOT merge into A's
// cluster -> genuine contradiction), but above the 0.35 outer partition threshold (so A and B still
// land in the SAME topic partition in the first place). jaccard(A,C) = 0.8889 -- well above 0.5, so C
// merges into A's cluster (corroboration, not a contradiction).
const CLAIM_A = "the xero core tier allows 5000 api calls per day"; // cfo
const CLAIM_B = "xero core tier allows 900 requests total not 5000"; // cto, CONTRADICTS A
const CLAIM_C = "xero core tier allows about 5000 api calls a day"; // cto, CORROBORATES A

// ---------------------------- normalizeAssertionRows ----------------------------

test("normalizeAssertionRows keeps only fact/decision/correction/pitfall from both sources", () => {
  const execRows = [
    { id: "e1", _agent: "cfo", type: "fact", text: "kept", ts: iso(1) },
    { id: "e2", _agent: "cfo", type: "status", text: "dropped (status)", ts: iso(1) },
    { id: "e3", _agent: "cfo", type: "entity", ekey: "x", evalue: "y", text: "x = y", ts: iso(1) },
  ];
  const cosmosRows = [
    { id: "c1", agent: "cto", kind: "decision", text: "kept", ts: iso(1) },
    { id: "c2", agent: "cto", kind: "episode", text: "dropped (episode)", ts: iso(1) },
  ];
  const rows = normalizeAssertionRows(execRows, cosmosRows);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.id).sort(), ["c1", "e1"]);
});

test("normalizeAssertionRows drops a row that a later row in the same source supersedes", () => {
  const execRows = [
    { id: "e1", _agent: "cfo", type: "fact", text: "old value", ts: iso(40) },
    { id: "e2", _agent: "cfo", type: "correction", text: "new value", ts: iso(20), supersedes: "e1", was: "old value" },
  ];
  const rows = normalizeAssertionRows(execRows, []);
  assert.deepEqual(rows.map((r) => r.id), ["e2"], "the superseded row must not appear as a live claim");
});

test("normalizeAssertionRows attributes a cross-lane exec-feed row to its writer (by), not the ledger owner", () => {
  const execRows = [{ id: "x1", _agent: "cfo", by: "cto", type: "fact", text: "cto wrote this on cfo's ledger", ts: iso(1) }];
  const rows = normalizeAssertionRows(execRows, []);
  assert.equal(rows[0].agent, "cto");
});

test("normalizeAssertionRows drops clo-personal defensively and drops rows missing agent or text", () => {
  const execRows = [
    { id: "p1", _agent: "clo-personal", type: "fact", text: "privileged, must never surface", ts: iso(1) },
    { id: "p2", _agent: "", type: "fact", text: "no agent", ts: iso(1) },
    { id: "p3", _agent: "cfo", type: "fact", text: "", ts: iso(1) },
    { id: "p4", _agent: "cfo", type: "fact", text: "kept", ts: iso(1) },
  ];
  const rows = normalizeAssertionRows(execRows, []);
  assert.deepEqual(rows.map((r) => r.id), ["p4"]);
});

test("normalizeAssertionRows maps a Cosmos row's kind to type and falls back _ts -> ISO ts", () => {
  const cosmosRows = [{ id: "c1", agent: "cto", kind: "pitfall", text: "kept", _ts: Math.floor(NOW / 1000) }];
  const rows = normalizeAssertionRows([], cosmosRows);
  assert.equal(rows[0].type, "pitfall");
  assert.equal(rows[0].ts, new Date(NOW).toISOString());
});

// ---------------------------- filterRecent ----------------------------

test("filterRecent keeps only rows within the window and tolerates unparseable/missing ts", () => {
  const rows = [{ ts: isoDays(5) }, { ts: isoDays(20) }, { ts: "not-a-date" }, {}];
  const kept = filterRecent(rows, 14, NOW);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].ts, isoDays(5));
});

// ---------------------------- partitionBySubject ----------------------------

test("partitionBySubject groups same-topic rows across agents and drops singleton clusters", () => {
  const rows = [
    { agent: "cfo", text: CLAIM_A, id: "a" },
    { agent: "cto", text: CLAIM_B, id: "b" },
    { agent: "growth", text: "a completely unrelated marketing headline about spring sale pricing", id: "c" },
  ];
  const partitions = partitionBySubject(rows);
  assert.equal(partitions.length, 1, "the two Xero rows partition together; the unrelated row is a dropped singleton");
  assert.equal(partitions[0].length, 2);
  assert.equal(partitions[0][0].subject, partitions[0][1].subject, "both rows in a partition share one synthetic subject key");
});

test("partitionBySubject skips an oversized partition rather than trusting it automatically", () => {
  const rows = [];
  for (let i = 0; i < 45; i++) {
    rows.push({ agent: `agent${i}`, text: "the shared status report mentions the daily build pipeline health check result", id: `w${i}` });
  }
  const partitions = partitionBySubject(rows, { threshold: 0.35, maxPartitionSize: MAX_PARTITION_SIZE });
  assert.equal(partitions.length, 0, "a 45-row cluster exceeds the 40-row safety cap and must be skipped, not proposed");
});

test("DEFAULT_PARTITION_THRESHOLD is intentionally looser than groupAssertions' own 0.5 inner threshold", () => {
  assert.ok(DEFAULT_PARTITION_THRESHOLD < 0.5 && DEFAULT_PARTITION_THRESHOLD > 0);
});

// ---------------------------- findContestedGroups + proposalsFor + openProposals ----------------------------
// This is the "exactly ONE proposal call vs ZERO" contract the build spec calls out explicitly.

test("a synthetic 2-agent contradiction produces exactly ONE contested group and ONE proposal call", async () => {
  const execRows = [{ id: "e1", _agent: "cfo", type: "fact", text: CLAIM_A, ts: iso(20) }];
  const cosmosRows = [{ id: "c1", agent: "cto", kind: "fact", text: CLAIM_B, ts: iso(10) }];
  const rows = normalizeAssertionRows(execRows, cosmosRows);

  const groups = findContestedGroups(rows, { nowMs: NOW });
  assert.equal(groups.length, 1, "expected exactly one contested group");
  assert.equal(groups[0].scored.status, "contested");

  const proposals = proposalsFor(groups, { owner: "cto" });
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].category, "memory-contradiction");
  assert.equal(proposals[0].owner, "cto");
  assert.match(proposals[0].text, /cfo/);
  assert.match(proposals[0].text, /cto/);

  let calls = 0;
  const calledWith = [];
  const opened = await openProposals(proposals, { commit: true, exec: async (args, p) => { calls++; calledWith.push({ args, p }); } });
  assert.equal(calls, 1, "expected exactly ONE proposal call");
  assert.equal(opened.length, 1);
  assert.equal(opened[0].opened, true);
  assert.deepEqual(calledWith[0].args.slice(0, 2), ["open", "--category"]);
});

test("a non-contradicting (corroborating) fixture produces ZERO contested groups and ZERO proposal calls", async () => {
  const execRows = [{ id: "e1", _agent: "cfo", type: "fact", text: CLAIM_A, ts: iso(20) }];
  const cosmosRows = [{ id: "c1", agent: "cto", kind: "fact", text: CLAIM_C, ts: iso(10) }];
  const rows = normalizeAssertionRows(execRows, cosmosRows);

  const groups = findContestedGroups(rows, { nowMs: NOW });
  assert.equal(groups.length, 0, "corroborating claims must never be flagged as contested");

  let calls = 0;
  const opened = await openProposals(proposalsFor(groups), { commit: true, exec: async () => { calls++; } });
  assert.equal(calls, 0, "expected ZERO proposal calls");
  assert.equal(opened.length, 0);
});

test("unrelated single-agent facts across many topics never produce a false contradiction", () => {
  const execRows = [
    { id: "e1", _agent: "cfo", type: "fact", text: "the Q3 marketing budget is finalized", ts: iso(5) },
    { id: "e2", _agent: "growth", type: "fact", text: "the iOS build pipeline runs on Depot macOS", ts: iso(5) },
    { id: "e3", _agent: "commerce", type: "decision", text: "list the TReO PSAP on Amazon under the existing ASIN", ts: iso(5) },
  ];
  const rows = normalizeAssertionRows(execRows, []);
  const groups = findContestedGroups(rows, { nowMs: NOW });
  assert.equal(groups.length, 0, "distinct topics from distinct single agents must not be mislabeled as contradictions");
});

// ---------------------------- openProposals dry-run contract ----------------------------

test("openProposals with commit=false (the default) NEVER calls exec, even with real contested groups", async () => {
  const execRows = [{ id: "e1", _agent: "cfo", type: "fact", text: CLAIM_A, ts: iso(20) }];
  const cosmosRows = [{ id: "c1", agent: "cto", kind: "fact", text: CLAIM_B, ts: iso(10) }];
  const groups = findContestedGroups(normalizeAssertionRows(execRows, cosmosRows), { nowMs: NOW });
  let calls = 0;
  const opened = await openProposals(proposalsFor(groups), { exec: async () => { calls++; } }); // commit omitted -> defaults false
  assert.equal(calls, 0, "dry-run must never invoke exec, structurally, not just by convention");
  assert.equal(opened.length, 1);
  assert.equal(opened[0].opened, false);
});

// ---------------------------- buildProposalText ----------------------------

test("buildProposalText names both sides, includes a trust rationale, evidence ids, and no em/en dash", () => {
  const execRows = [{ id: "e1", _agent: "cfo", type: "fact", text: CLAIM_A, ts: iso(20) }];
  const cosmosRows = [{ id: "c1", agent: "cto", kind: "fact", text: CLAIM_B, ts: iso(10) }];
  const groups = findContestedGroups(normalizeAssertionRows(execRows, cosmosRows), { nowMs: NOW });
  const built = buildProposalText(groups[0]);
  assert.match(built.text, /Majority \(cfo\) asserts/);
  assert.match(built.text, /Contradicted by cto/);
  assert.match(built.text, /Trust score/);
  assert.match(built.text, /never auto-resolves/);
  assert.match(built.evidence, /cfo:exec-feed:e1/);
  assert.match(built.evidence, /cto:cosmos-memory:c1/);
  assert.ok(!/[–—]/.test(built.text), "no em dash or en dash in proposal text");
  assert.deepEqual(built.majorityAgents, ["cfo"]);
  assert.deepEqual(built.minorityAgents, ["cto"]);
});

// ---------------------------- PRECISION GATE: templated-overlap false positives ----------------------------
// Adversarial-review repro band (0.35 <= jaccard < 0.5): templated same-shape/different-IDENTIFIER
// facts overlap enough to land in one topic partition, and would otherwise become a BOGUS "cross-agent
// contradiction" proposal. The value-conflict gate (hasGenuineValueConflict) must suppress them while
// keeping the genuine numeric-value conflict (the Xero rate-limit) firing. jaccard values below were
// verified empirically against the real dedupe.mjs tokenize/jaccard.

test("REPRO (HIGH): two ROTATE-BEFORE-LAUNCH lines naming DIFFERENT secrets produce ZERO proposals", () => {
  // jaccard 0.385 -> DOES partition (>= 0.35), so this genuinely exercises the value-gate, not just the
  // partition floor. Neither line carries a numeric value token, so it is correctly NOT a contradiction.
  const execRows = [{ id: "e1", _agent: "cto", type: "fact", text: "ROTATE-BEFORE-LAUNCH: azure-storage-key, fingerprint-hmac-secret", ts: iso(20) }];
  const cosmosRows = [{ id: "c1", agent: "developer", kind: "fact", text: "ROTATE-BEFORE-LAUNCH: revenuecat-secret-key, plantid-client-api-key", ts: iso(10) }];
  const rows = normalizeAssertionRows(execRows, cosmosRows);
  assert.equal(partitionBySubject(rows).length, 1, "the two ROTATE lines share enough vocabulary to partition together");
  assert.equal(findContestedGroups(rows, { nowMs: NOW }).length, 0, "different-secret lists are not a contradiction");
});

test("a HIGH-overlap templated PENDING pair (different items, no numbers) still produces ZERO proposals", () => {
  // jaccard ~0.64 -> partitions strongly; the gate, not the partition floor, is what filters it.
  const execRows = [{ id: "e1", _agent: "cto", type: "fact", text: "PENDING (Matt): rotate the azure storage key before public launch", ts: iso(20) }];
  const cosmosRows = [{ id: "c1", agent: "developer", kind: "fact", text: "PENDING (Matt): rotate the revenuecat secret key before public launch", ts: iso(10) }];
  const rows = normalizeAssertionRows(execRows, cosmosRows);
  assert.equal(partitionBySubject(rows).length, 1, "the high-overlap PENDING lines partition together");
  assert.equal(findContestedGroups(rows, { nowMs: NOW }).length, 0, "different pending items are not a contradiction");
});

test("two 'the X endpoint is Y' facts about DIFFERENT services produce ZERO proposals", () => {
  const execRows = [{ id: "e1", _agent: "cto", type: "fact", text: "the plantid-api endpoint is plantid-api.azurewebsites.net", ts: iso(20) }];
  const cosmosRows = [{ id: "c1", agent: "developer", kind: "fact", text: "the gateway endpoint is mcp.otchealth.app slash mcp", ts: iso(10) }];
  const rows = normalizeAssertionRows(execRows, cosmosRows);
  assert.equal(findContestedGroups(rows, { nowMs: NOW }).length, 0, "different-service endpoints are not a contradiction");
});

test("the genuine Xero rate-limit conflict (5000 vs 900) STILL fires exactly one proposal after the gate", () => {
  const execRows = [{ id: "e1", _agent: "cfo", type: "fact", text: CLAIM_A, ts: iso(20) }];
  const cosmosRows = [{ id: "c1", agent: "cto", kind: "fact", text: CLAIM_B, ts: iso(10) }];
  const groups = findContestedGroups(normalizeAssertionRows(execRows, cosmosRows), { nowMs: NOW });
  assert.equal(groups.length, 1, "a real same-subject/different-value conflict must survive the value gate");
});

test("hasGenuineValueConflict: same subject + differing numeric value -> true; no numbers -> false", () => {
  // same subject, values differ (5000 vs 900) -> a genuine conflict.
  assert.equal(hasGenuineValueConflict(CLAIM_A, [{ row: { text: CLAIM_B, id: "c1" } }]), true);
  // same shape, DIFFERENT identifiers, NO numbers -> not a value conflict.
  assert.equal(
    hasGenuineValueConflict(
      "ROTATE-BEFORE-LAUNCH: azure-storage-key, fingerprint-hmac-secret",
      [{ row: { text: "ROTATE-BEFORE-LAUNCH: revenuecat-secret-key, plantid-client-api-key", id: "c1" } }],
    ),
    false,
  );
  // same subject, SAME value (corroboration, not conflict) -> false.
  assert.equal(hasGenuineValueConflict(CLAIM_A, [{ row: { text: "the xero core tier allows 5000 api calls each day", id: "c1" } }]), false);
  // empty inputs -> false, never throws.
  assert.equal(hasGenuineValueConflict("", [{ row: { text: CLAIM_B, id: "c" } }]), false);
  assert.equal(hasGenuineValueConflict(CLAIM_A, []), false);
});

test("DEFAULT_CONFLICT_SUBJECT_THRESHOLD sits between a templated-overlap pair (~0.38) and the Xero pair (0.4545)", () => {
  assert.ok(DEFAULT_CONFLICT_SUBJECT_THRESHOLD > 0.385 && DEFAULT_CONFLICT_SUBJECT_THRESHOLD <= 0.4545);
});

// ---------------------------- NEVER-MUTATE static regression (future-proofing) ----------------------------

test("contradiction-scan.mjs source contains no memory-mutation tokens (mem.mjs / correct / --supersedes)", () => {
  // A future edit must never be able to turn a PROPOSAL into an in-place memory edit. This asserts the
  // source itself carries none of the mutation call tokens. `correction` (the memory TYPE this file
  // READS) is deliberately allowed via the \bcorrect\b word boundary (it does not match "correction").
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "contradiction-scan.mjs"), "utf8");
  assert.ok(!src.includes("mem.mjs"), "contradiction-scan.mjs must not reference mem.mjs (the memory-mutating CLI)");
  assert.ok(!/\bcorrect\b/.test(src), "contradiction-scan.mjs must not contain the bare mutation verb 'correct' (the 'correction' TYPE is fine)");
  assert.ok(!src.includes("--supersedes"), "contradiction-scan.mjs must not pass the --supersedes flag anywhere");
});
