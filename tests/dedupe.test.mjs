// Tests for kb-memory/dedupe.mjs, the pure write-time near-duplicate + contradiction advisory.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  tokenize, jaccard, nearDuplicate, possibleContradiction, writeAdvisory,
  RING_DENY, PRIVILEGED_AGENTS, ringSafeCross,
} from "../skills/kb-memory/dedupe.mjs";

test("tokenize drops stopwords and 1-char tokens, lowercases", () => {
  const s = tokenize("The Xero CORE tier is 5000 a day");
  assert.ok(s.has("xero") && s.has("core") && s.has("tier") && s.has("5000") && s.has("day"));
  assert.ok(!s.has("the") && !s.has("is") && !s.has("a"));
});

test("jaccard is 1 for identical token sets and 0 for disjoint / empty", () => {
  assert.equal(jaccard(tokenize("alpha beta"), tokenize("beta alpha")), 1);
  assert.equal(jaccard(tokenize("alpha beta"), tokenize("gamma delta")), 0);
  assert.equal(jaccard(tokenize(""), tokenize("x y")), 0);
});

test("nearDuplicate flags a high-overlap same-type row and returns its id", () => {
  const rows = [{ id: "d1", type: "fact", text: "Xero CORE tier allows 5000 API calls per day" }];
  const hit = nearDuplicate("Xero CORE tier allows 5000 API calls per day now", rows, { type: "fact" });
  assert.ok(hit && hit.id === "d1" && hit.score >= 0.8);
});

test("nearDuplicate does not match across a different type", () => {
  const rows = [{ id: "d1", type: "decision", text: "Xero CORE tier allows 5000 API calls per day" }];
  assert.equal(nearDuplicate("Xero CORE tier allows 5000 API calls per day", rows, { type: "fact" }), null);
});

test("nearDuplicate ignores rows already superseded", () => {
  const rows = [
    { id: "d1", type: "fact", text: "daily cap is 900" },
    { id: "d2", type: "fact", text: "daily cap is 4800", supersedes: "d1" },
  ];
  // querying the old value should not match the superseded d1
  const hit = nearDuplicate("daily cap is 900 requests", rows, { type: "fact", threshold: 0.5 });
  assert.ok(!hit || hit.id !== "d1");
});

test("possibleContradiction flags same-subject different-value", () => {
  const rows = [{ id: "c1", type: "fact", text: "the daily API cap is 900 requests" }];
  const hit = possibleContradiction("the daily API cap is 4800 requests", rows, { type: "fact" });
  assert.ok(hit && hit.id === "c1");
});

test("possibleContradiction does NOT fire when the value is unchanged", () => {
  const rows = [{ id: "c1", type: "fact", text: "the daily API cap is 900 requests" }];
  assert.equal(possibleContradiction("the daily API cap is 900 requests today", rows, { type: "fact" }), null);
});

test("possibleContradiction does NOT fire on an unrelated subject with numbers", () => {
  const rows = [{ id: "c1", type: "fact", text: "the daily API cap is 900 requests" }];
  assert.equal(possibleContradiction("the office has 3 printers", rows, { type: "fact" }), null);
});

test("writeAdvisory returns a correction hint with the supersedes id, and is capture-able", () => {
  const rows = [{ id: "c1", type: "fact", text: "the daily API cap is 900 requests" }];
  let out = "";
  const msg = writeAdvisory("the daily API cap is 4800 requests", rows, "fact", (m) => { out += m; });
  assert.match(msg, /--supersedes c1/);
  assert.match(out, /--supersedes c1/);
});

test("writeAdvisory is safe on an empty ledger and returns empty string", () => {
  assert.equal(writeAdvisory("a brand new isolated fact xyzzy", [], "fact", () => {}), "");
});

// ============================ ringSafeCross / RING_DENY / PRIVILEGED_AGENTS ============================
// The shared fleet-wide MNPI/PHI content wall (mirrors kb-memory/mem.mjs's RING_DENY and
// company-brain/brain.mjs's RING_DENY, byte-identical by design -- see dedupe.mjs's own comment).
// These are the ONE enforcement point contradiction-scan.mjs and nightly-reflection.mjs rely on to
// keep privileged/MNPI/PHI content from crossing a ring boundary; test it directly and thoroughly.

test("ringSafeCross rejects a row from a privileged agent lane regardless of its text", () => {
  assert.equal(ringSafeCross({ agent: "clo-personal", text: "totally ordinary, non-sensitive text" }), false);
  assert.equal(ringSafeCross({ agent: "CLO-PERSONAL", text: "case-insensitive agent match" }), false, "agent match is case-insensitive");
});

test("ringSafeCross rejects a row whose text carries an MNPI marker, from ANY agent (not just clo/cfo)", () => {
  // The whole point of a CONTENT check, not just an agent check: an otherwise-shareable agent (cto,
  // developer, growth...) can still assert one MNPI-flagged fact that must stay in its own lane.
  assert.equal(ringSafeCross({ agent: "cto", text: "INND closed a $2M Reg D raise this week" }), false);
  assert.equal(ringSafeCross({ agent: "developer", text: "the otcmkts ticker moved after the 8-K filing" }), false);
  assert.equal(ringSafeCross({ agent: "growth", text: "materially non-public information about the deal" }), false);
  assert.equal(ringSafeCross({ agent: "commerce", text: "an mnpi flag was raised on this document" }), false);
});

test("ringSafeCross rejects a row whose TAGS (not just text) carry an MNPI/PHI marker", () => {
  assert.equal(ringSafeCross({ agent: "cto", text: "ordinary-looking sentence", tags: ["mnpi", "internal"] }), false);
  assert.equal(ringSafeCross({ agent: "cto", text: "ordinary-looking sentence", tags: "hipaa,internal" }), false, "a string tags value (not array) is also scanned");
});

test("ringSafeCross rejects a row whose WAS field (correction old-value) carries an MNPI/PHI marker", () => {
  assert.equal(ringSafeCross({ agent: "cfo", text: "the new figure is fine", was: "the old INND share price was different" }), false);
});

test("ringSafeCross rejects PHI-adjacent markers too (not just MNPI/securities)", () => {
  assert.equal(ringSafeCross({ agent: "cto", text: "a patient reported an issue" }), false);
  assert.equal(ringSafeCross({ agent: "cto", text: "the hipaa BAA covers this workload" }), false);
  assert.equal(ringSafeCross({ agent: "cto", text: "do not log the hearing number anywhere" }), false);
});

test("ringSafeCross accepts an ordinary, non-privileged, non-MNPI row from any normal agent", () => {
  assert.equal(ringSafeCross({ agent: "cfo", text: "the Xero core tier allows 5000 API calls a day" }), true);
  assert.equal(ringSafeCross({ agent: "cto", text: "the plantid-api endpoint is plantid-api.azurewebsites.net" }), true);
  assert.equal(ringSafeCross({ agent: "clo", text: "filed the trademark renewal on schedule" }), true, "company-legal (non-personal) is not automatically privileged by agent");
});

test("ringSafeCross fails closed (false) on missing/malformed input, never throws", () => {
  assert.equal(ringSafeCross(null), false);
  assert.equal(ringSafeCross(undefined), false);
  assert.equal(ringSafeCross({}), true, "an empty row has no agent and no MNPI text, so it is technically ring-safe (callers still gate on missing text/agent separately)");
});

test("PRIVILEGED_AGENTS contains clo-personal (the kb-memory NO_SHARE set)", () => {
  assert.ok(PRIVILEGED_AGENTS.has("clo-personal"));
});

test("RING_DENY is case-insensitive and word-bounded (does not over-match inside an unrelated word)", () => {
  assert.ok(RING_DENY.test("INND"));
  assert.ok(RING_DENY.test("innd"));
  assert.ok(!RING_DENY.test("grinnd"), "must not match mnpi/innd markers as a mid-word substring");
});

// ======================= ADVERSARIAL-REVIEW HARDENING: HOLE 1 (bare "innerscope") =======================
// Before the fix, RING_DENY matched the bare ticker "innd" but never the company's actual name
// "innerscope", and the "inscope hearing" fragment was broken (missing the "n", so it never matched
// anything real). This is the direct repro: a row about InnerScope's own cash runway, tagged under an
// ordinary agent (not clo-personal), carried none of the old markers and was fully ring-safe = true.

test("HOLE 1 FIXED: a bare 'innerscope' row is now denied cross-lane, from any agent", () => {
  // The literal old gap: no "innd" substring, no working MNPI marker at all pre-fix.
  assert.equal(ringSafeCross({ agent: "cto", text: "innerscope confidential cash runway update this week" }), false);
  assert.equal(ringSafeCross({ agent: "developer", text: "InnerScope shipped a new investor deck" }), false, "case-insensitive");
});

test("HOLE 1 FIXED: the exact two-row leak repro shape (innerscope runway, two different values) is denied on both rows", () => {
  const rowA = { agent: "cto", text: "innerscope confidential cash runway is 6000000 per the board deck" };
  const rowB = { agent: "developer", text: "innerscope confidential cash runway is actually 900000 not 6000000" };
  assert.equal(ringSafeCross(rowA), false);
  assert.equal(ringSafeCross(rowB), false);
});

test("HOLE 1 FIXED: the new MNPI vocabulary denies cross-lane (term sheet, convertible note, SAFE note, warrant, insider, insolvency, dilution, price per share, reg cf)", () => {
  assert.equal(ringSafeCross({ agent: "cto", text: "the term sheet for the bridge financing was countersigned" }), false);
  assert.equal(ringSafeCross({ agent: "cto", text: "issued a convertible note to the investor" }), false);
  assert.equal(ringSafeCross({ agent: "cto", text: "the SAFE note converts at the next priced round" }), false);
  assert.equal(ringSafeCross({ agent: "cto", text: "the company issued warrants to two lenders" }), false);
  assert.equal(ringSafeCross({ agent: "cto", text: "an insider was briefed ahead of the announcement" }), false);
  assert.equal(ringSafeCross({ agent: "cto", text: "the subsidiary may become insolvent next quarter" }), false, "insolven\\w* must match insolvent, not just a bare unmatchable fragment");
  assert.equal(ringSafeCross({ agent: "cto", text: "filed for insolvency proceedings" }), false, "insolven\\w* must match insolvency too");
  assert.equal(ringSafeCross({ agent: "cto", text: "the round caused significant dilution for early holders" }), false);
  assert.equal(ringSafeCross({ agent: "cto", text: "the price per share was set at close" }), false);
  assert.equal(ringSafeCross({ agent: "cto", text: "the campaign runs under Reg CF this time" }), false);
  assert.equal(ringSafeCross({ agent: "cto", text: "the capital raise closed ahead of schedule" }), false);
});

test("HOLE 1: 'raise' is deliberately scoped, not bare, so ordinary dev language is unaffected", () => {
  assert.equal(ringSafeCross({ agent: "cto", text: "please raise a PR for this change" }), true);
  assert.equal(ringSafeCross({ agent: "cto", text: "raise an issue if you hit a bug" }), true);
});

test("HOLE 1: 'safe' is deliberately scoped to 'safe note', not bare, so type-safe/ring-safe language is unaffected", () => {
  assert.equal(ringSafeCross({ agent: "cto", text: "this refactor is type-safe and keeps ringSafeCross intact" }), true);
});

test("HOLE 1: 'warrant' as a bounded word does not match 'warranty'", () => {
  assert.equal(ringSafeCross({ agent: "cto", text: "the MIT license disclaims all warranty" }), true);
});

// ======================= ADVERSARIAL-REVIEW HARDENING: HOLE 2 (personal-legal vocabulary) =======================
// Before the fix, RING_DENY had ZERO personal-legal vocabulary, so clo-personal content mistagged under
// the ordinary "clo" (company-legal) lane had no content-level backstop, only the agent-tag check. These
// are the exact four leak-repro sentence shapes from the adversarial review, all tagged agent "clo" (NOT
// "clo-personal"), so only the NEW vocabulary -- not the PRIVILEGED_AGENTS agent check -- can catch them.

test("HOLE 2 FIXED: the exact four clo-tagged personal-legal leak sentences are now denied cross-lane", () => {
  assert.equal(ringSafeCross({ agent: "clo", text: "the custody hearing continued to next month" }), false);
  assert.equal(ringSafeCross({ agent: "clo", text: "the settlement offer in the civil case is 250000" }), false);
  assert.equal(ringSafeCross({ agent: "clo", text: "the deposition transcript mentions the community-property division" }), false);
  assert.equal(ringSafeCross({ agent: "clo", text: "the spousal support figure discussed in mediation is pending" }), false);
});

test("HOLE 2 FIXED: the rest of the requested personal-legal vocabulary denies cross-lane too", () => {
  assert.equal(ringSafeCross({ agent: "clo", text: "the divorce was finalized last week" }), false);
  assert.equal(ringSafeCross({ agent: "clo", text: "they got divorced after 12 years" }), false, "divorc\\w* must catch the 'divorced' variant too");
  assert.equal(ringSafeCross({ agent: "clo", text: "filed for dissolution of the marriage" }), false);
  assert.equal(ringSafeCross({ agent: "clo", text: "the child support order was modified" }), false);
  assert.equal(ringSafeCross({ agent: "clo", text: "alimony payments begin next month" }), false);
  assert.equal(ringSafeCross({ agent: "clo", text: "opposing counsel filed a motion to compel" }), false);
  assert.equal(ringSafeCross({ agent: "clo", text: "the family court hearing is scheduled for March" }), false);
  assert.equal(ringSafeCross({ agent: "clo", text: "marital assets were disclosed in the filing" }), false);
  assert.equal(ringSafeCross({ agent: "clo", text: "a restraining order was requested this week" }), false);
  assert.equal(ringSafeCross({ agent: "clo", text: "the civil litigation matter proceeds to trial in the spring" }), false);
  assert.equal(ringSafeCross({ agent: "clo", text: "review the community property schedule before the hearing" }), false, "space-separated 'community property', not just the hyphenated form");
});

test("HOLE 2: 'settlement' and 'litigation' are deliberately scoped, not bare, so the CLO's OWN non-personal company docket stays readable", () => {
  // dream-team/agents/clo.md separates "D. California civil litigation (Matt, personal)" from a
  // distinct company FLSA employment matter ("company is defendant"); a bare "litigation"/"settlement"
  // match would have ring-denied the legitimate company-legal content along with the personal content.
  assert.equal(ringSafeCross({ agent: "clo", text: "the FLSA back-wage litigation hold was issued to preserve records" }), true);
  assert.equal(ringSafeCross({ agent: "clo", text: "issue a litigation hold immediately when litigation is reasonably anticipated" }), true);
  assert.equal(ringSafeCross({ agent: "clo", text: "the prior litigation and settlements in the Shennib matter are on file" }), true);
});

test("HOLE 2: bare 'settlement' does not ring-deny Flatstick's non-personal settlement-engine content (a real, frequent collision this fleet would hit)", () => {
  // flatstick/CLAUDE.md: packages/shared is "a pure, property-tested scoring/settlement engine"; this
  // is exactly the kind of common-word collision the task explicitly warned against (cf. "raise a PR").
  assert.equal(ringSafeCross({ agent: "developer", text: "fixed a bug in the debt-minimized settlement engine for skins and nassau" }), true);
  assert.equal(ringSafeCross({ agent: "developer", text: "the settlement algorithm handles presses and wolf scoring" }), true);
  assert.equal(ringSafeCross({ agent: "developer", text: "settlement is outbound Venmo and PayPal links only, the Splitwise model" }), true);
});

test("HOLE 2: the clo agent's ordinary non-personal content (existing test) is still unaffected by the new vocabulary", () => {
  assert.equal(ringSafeCross({ agent: "clo", text: "filed the trademark renewal on schedule" }), true);
});
