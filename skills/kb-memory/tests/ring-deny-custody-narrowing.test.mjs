// Regression tests for the FND-20260814-b126 fix: RING_DENY's "custody" fragment (kb-memory/dedupe.mjs)
// was a bare `\bcustody\b` token, which is dual-use vocabulary -- brokerage/securities English uses
// "custody" constantly for the unrelated concept of a custodian holding assets, and the bare match was
// dropping legitimate INND/company finance documents out of the shared brain rooms (236+ and climbing).
// The CLO narrowed it to specific family-law phrasings (see the CLO DECISION comment in dedupe.mjs,
// directly above the RING_DENY export). This file pins that decision two ways:
//   1. every named family-law phrasing still trips RING_DENY (ringSafeCross denies it cross-lane) --
//      the narrowing did not silently drop real personal-matter coverage;
//   2. every named finance/custodian phrasing no longer trips it -- the narrowing actually fixed the bug;
//   3. a counterfactual proves the OLD bare-token behavior really did match those finance sentences, so
//      this test would have failed before the fix (it is not vacuously true).
import { test } from "node:test";
import assert from "node:assert/strict";
import { RING_DENY, ringSafeCross } from "../dedupe.mjs";

// The exact pre-fix behavior for the "custody" alternative, reconstructed inline (NOT imported -- the
// whole point is to pin what the OLD code did, independent of whatever dedupe.mjs does today) so this
// counterfactual keeps proving something even if dedupe.mjs's unrelated alternatives change later.
const OLD_BARE_CUSTODY_TOKEN = /\bcustody\b/i;

// ─────────────────────────────── finance/custodian sentences: must NOT ring-deny ───────────────────────────────
// Every sentence below contains the standalone word "custody" (so the OLD bare token matched it -- see the
// counterfactual block) and is a genuine, unremarkable finance/securities usage with no other RING_DENY
// vocabulary anywhere in it (no "InnerScope"/"INND", no "share price", no "settlement offer", etc.), so a
// failure here can only be attributed to the custody fragment specifically, not some other alternative.
const FINANCE_CUSTODY_SENTENCES = [
  "The broker maintains a custody account for the firm's marketable securities.",
  "All shares are held in custody by the transfer agent until the trade closes.",
  "The escrow contract provides that assets remain in the custody of the bank until closing.",
  "Charles Schwab serves as custodian and holds the firm's stock certificates in custody.",
  "The audit confirmed that the portfolio is in the custody of an independent trustee.",
  "Under the safekeeping contract, all certificates are kept in custody at the depository.",
  "The prime broker's custody unit reconciles positions nightly.",
  "Securities purchased on margin remain in custody with the clearing firm.",
];

for (const sentence of FINANCE_CUSTODY_SENTENCES) {
  test(`RING_DENY no longer flags finance custody usage: "${sentence}"`, () => {
    assert.ok(!RING_DENY.test(sentence), `expected RING_DENY NOT to match: ${sentence}`);
  });

  test(`ringSafeCross treats finance custody usage as safe to share cross-lane: "${sentence}"`, () => {
    // Tagged "cfo" (an ordinary, non-personal, non-privileged lane) so only content, not agent identity,
    // is under test -- mirrors the real-world shape of the bug (a company finance doc, not a
    // clo-personal-tagged row).
    assert.equal(ringSafeCross({ agent: "cfo", text: sentence }), true, `expected ringSafeCross to allow: ${sentence}`);
  });
}

test('RING_DENY does not flag the bare word "custodian" on its own (no family-law qualifier anywhere nearby)', () => {
  assert.ok(!RING_DENY.test("The custodian confirmed receipt of the annual report."));
});

// ─────────────────────────── counterfactual: the OLD bare token DID match these ───────────────────────────
// Proves the fix is doing something: before the narrowing, RING_DENY's "custody" alternative was exactly
// this bare token, so every finance sentence above would have failed the "must NOT match" assertions above.
test("COUNTERFACTUAL: the OLD bare `\\bcustody\\b` token matched every finance sentence above (the bug was real)", () => {
  for (const sentence of FINANCE_CUSTODY_SENTENCES) {
    assert.ok(OLD_BARE_CUSTODY_TOKEN.test(sentence), `OLD bare custody token should have matched: ${sentence}`);
  }
});

// ────────────────────────────── family-law sentences: MUST still ring-deny ──────────────────────────────
// One sentence per named sub-pattern (isolated, no other RING_DENY vocabulary present), so a failure
// pinpoints exactly which family-law phrasing regressed. Covers every example the CLO decision named
// (child custody, legal custody, physical custody, custody order/hearing/evaluation/dispute/arrangement/
// schedule, custodial parent) plus the CLO's own additions (joint/sole custody, "custody of the
// children", non-custodial parent) that close gaps the literal example list would otherwise have left.
const FAMILY_LAW_CUSTODY_SENTENCES = [
  ["child custody", "The parents agreed to child custody terms outside of court."],
  ["legal custody", "The agreement grants her legal custody while he retains visitation rights."],
  ["physical custody", "The mother was awarded physical custody starting next month."],
  ["joint custody", "Both parents share joint custody following the court's decision."],
  ["sole custody", "He is seeking sole custody after the recent change in circumstances."],
  ["custody + order", "A new custody order was entered by the judge this week."],
  ["custody + hearing", "A custody hearing has been set for the fifteenth."],
  ["custody + evaluation", "The custody evaluation is expected to take several weeks."],
  ["custody + dispute", "There is an unresolved custody dispute between the two households."],
  ["custody + arrangement", "The parties reached a custody arrangement without going to trial."],
  ["custody + schedule", "The custody schedule alternates every other week."],
  ["custody of the children", "She was awarded custody of the children in the final judgment."],
  ["custodial parent", "As the custodial parent, he handles all school enrollment decisions."],
  ["non-custodial parent", "The non-custodial parent has visitation every other weekend."],
];

for (const [label, sentence] of FAMILY_LAW_CUSTODY_SENTENCES) {
  test(`RING_DENY still flags family-law phrasing (${label}): "${sentence}"`, () => {
    assert.ok(RING_DENY.test(sentence), `expected RING_DENY to match (${label}): ${sentence}`);
  });

  test(`ringSafeCross still denies family-law phrasing cross-lane (${label}), even tagged under the ordinary "clo" (not "clo-personal") lane`, () => {
    // Tagged "clo" (company-legal, not clo-personal) on purpose -- exactly the HOLE-2 leak shape this
    // wall exists to catch: personal content mistagged under the non-personal company-legal lane must
    // still be denied cross-lane by CONTENT, not merely by agent identity.
    assert.equal(ringSafeCross({ agent: "clo", text: sentence }), false, `expected ringSafeCross to deny (${label}): ${sentence}`);
  });
}

test('the existing HOLE-2 regression sentence ("the custody hearing continued to next month") from tests/dedupe.test.mjs still denies (no drift between the two suites)', () => {
  assert.equal(ringSafeCross({ agent: "clo", text: "the custody hearing continued to next month" }), false);
});
