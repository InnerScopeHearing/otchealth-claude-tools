// Tests for classify.mjs -- the safety-escalation text classifier.
//
// The one test that MUST exist per the locked design spec is the first one below: the exact
// documented false positive (a bare stem-match on "physician" hitting the marketing brand
// "Physician's Choice") must not reclassify as a safety escalation just because the word boundary is
// technically satisfied. Everything else here is the surrounding evidence that the classifier is not
// just narrowly patched to dodge that one string, but genuinely precision-biased and still functional.
import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, truncateSnippet, stripHtml, RULES } from "../classify.mjs";

// ---- the documented false positive (locked spec, non-negotiable) ----------------------------------

test("does NOT classify marketing copy mentioning the brand 'Physician's Choice' as a safety escalation", () => {
  const text =
    "Check out Physician's Choice hearing aids, doctor recommended and trusted by families for over 20 years. " +
    "Limited time offer, save 30% today!";
  const result = classify(text);
  assert.equal(result.matched, false, "must not fire on the brand name alone");
  assert.equal(result.matches.length, 0);
});

// ---- a SECOND real false positive, caught live against real Intercom traffic during this skill's
//      own required dry run (2026-09-02), not anticipated at design time -- same bug shape as the
//      documented "Physician's Choice" incident: a hazard word inside a fixed phrase meaning the
//      OPPOSITE of an incident (equipment rated safe against a hazard, not a report of one). -------

test("does NOT classify real marketing email pitching 'explosion-proof' industrial equipment as a safety escalation (live-caught false positive)", () => {
  // The actual matched phrase from the real conversation, as it appeared verbatim in Intercom.
  const text = "Our flagship offerings include:\n- Industry-specific adaptations (explosion-proof/corrosion-resistant options)\nSmart energy-saving designs.";
  const result = classify(text);
  assert.equal(result.matched, false, "an 'explosion-proof' safety RATING is not a report of an explosion");
});

for (const [label, text] of [
  ["shockproof (one word)", "This case is fully shockproof and waterproof, perfect for outdoor use."],
  ["shock-resistant", "Our enclosures are shock-resistant and rated for industrial environments."],
  ["fireproof", "The cabinet is fireproof and holds up to 2 hours of direct flame exposure."],
  ["fire-resistant", "All wiring is fire-resistant per the updated safety code."],
]) {
  test(`does NOT classify a safety-rating claim as an incident: ${label}`, () => {
    assert.equal(classify(text).matched, false, `"${text}" must not classify`);
  });
}

test("but a genuine explosion/fire/shock REPORT (not a rating claim) still matches after the fix", () => {
  for (const text of [
    "There was an explosion when I plugged it in and it started smoking.",
    "The device caught fire on my nightstand overnight.",
    "I got an electric shock when I touched the charging port.",
  ]) {
    assert.equal(classify(text).matched, true, `"${text}" must still match`);
  }
});

test("word-boundary regex alone would NOT have fixed the original bug -- proving why a bare 'physician' rule is absent, not just guarded", () => {
  // This is the mechanism check behind the fix above: \bphysician\b DOES match inside "Physician's
  // Choice" (there is a real word boundary between "n" and the apostrophe), so if a bare "physician"
  // rule existed, masking would be the ONLY thing standing between it and a false positive. The actual
  // fix is that no rule in RULES is a single common noun/role word at all -- confirm that directly.
  assert.match("Physician's Choice", /\bphysician\b/i, "sanity check: a naive \\b-anchored rule really would match here");
  for (const rule of RULES) {
    assert.doesNotMatch("Physician's Choice hearing aids, doctor recommended", rule.pattern, `rule "${rule.id}" must not fire on a bare physician/doctor mention`);
  }
});

test("brand-context suppression does not blind the classifier to a REAL signal appearing alongside it", () => {
  // Suppression must mask only the matched brand phrase's own span, not the whole message -- a genuine
  // hazard mentioned in the same conversation as the brand name must still be caught.
  const text = "Saw an ad for Physician's Choice today. Unrelated: my earbud caught fire while charging last night.";
  const result = classify(text);
  assert.equal(result.matched, true);
  assert.ok(result.matches.some((m) => m.id === "fire-shock"));
  assert.equal(result.suppressed.length, 1);
  assert.equal(result.suppressed[0].id, "physicians-choice-brand");
});

// ---- true positives: a real user describing injury/pain/adverse reaction from a device ------------

test("true positive: electrical shock and a burned finger, escalated to the ER", () => {
  const r = classify("The earbud gave me an electrical shock while charging and burned my finger, I had to go to the emergency room.");
  assert.equal(r.matched, true);
  const ids = r.matches.map((m) => m.id);
  assert.ok(ids.includes("fire-shock"));
  assert.ok(ids.includes("harmed-bodypart"));
  assert.ok(ids.includes("emergency-room"));
});

test("true positive: allergic reaction with bleeding", () => {
  const r = classify("I had an allergic reaction to the ear tips, my ear canal is bleeding and it really hurts.");
  assert.equal(r.matched, true);
  const ids = r.matches.map((m) => m.id);
  assert.ok(ids.includes("allergic-reaction"));
  assert.ok(ids.includes("bleeding"));
});

test("true positive: explicit safety hazard language plus chemical burn", () => {
  const r = classify("This is a serious safety hazard, the batteries leaked and burned my skin.");
  assert.equal(r.matched, true);
  const ids = r.matches.map((m) => m.id);
  assert.ok(ids.includes("explicit-danger"));
  assert.ok(ids.includes("harmed-bodypart"));
});

test("true positive: swallowed battery, poison control called", () => {
  const r = classify("My daughter swallowed the battery from the hearing aid and we called poison control right away.");
  assert.equal(r.matched, true);
  const ids = r.matches.map((m) => m.id);
  assert.ok(ids.includes("swallowed-part"));
  assert.ok(ids.includes("poison-control"));
});

test("true positive: ruptured eardrum and hospitalization", () => {
  const r = classify("The device caused a perforated eardrum and I ended up hospitalized overnight.");
  assert.equal(r.matched, true);
  const ids = r.matches.map((m) => m.id);
  assert.ok(ids.includes("ruptured-eardrum"));
  assert.ok(ids.includes("hospitalized"));
});

test("true positive: anaphylaxis", () => {
  const r = classify("I went into anaphylaxis after wearing it, my throat swelled up immediately.");
  assert.equal(r.matched, true);
  assert.ok(r.matches.some((m) => m.id === "anaphylaxis"));
});

// ---- true negatives: ordinary support traffic must never fire ------------------------------------

for (const [label, text] of [
  ["Bluetooth pairing complaint", "My hearing aid isn't pairing with Bluetooth, can you help me reconnect it?"],
  ["refund request", "I want a refund because the sound quality is worse than I expected."],
  ["app crash", "The app crashed when I opened it this morning, can you look into it?"],
  ["shipping question", "When will my order ship? It's been five days and I haven't gotten a tracking number."],
  ["generic thanks", "Thanks so much, the team was really helpful and fixed my issue quickly."],
  ["marketing spam (unrelated brand pitch)", "Reach buyers without spending a dollar on ads. TikTok Shop's algorithm puts your products in front of the right people."],
  ["billing question", "Why was I charged twice this month for the same subscription?"],
]) {
  test(`true negative: ${label}`, () => {
    const r = classify(text);
    assert.equal(r.matched, false, `"${text}" must not classify as a safety escalation`);
  });
}

test("word boundaries prevent a stem inside an unrelated longer word from matching", () => {
  // "crash" contains the letters "rash" but there is no word boundary between 'c' and 'r' -- confirms
  // the underlying regex mechanism is sound, independent of which specific words are in the table.
  assert.doesNotMatch("the app keeps crashing on launch", /\brash\b/i);
});

// ---- idiom false positives caught on review (real English phrases sharing surface words with the
//      rule table, unrelated to physical harm -- an adversarial pass on the FIRST draft of this rule
//      table found these; they are pinned here so a future edit cannot silently reintroduce them) -----

for (const [label, text] of [
  ["'cut me some slack' is not a physical injury report", "Can you cut me some slack on the late return, it's my first time missing the window."],
  ["price 'shock' is not an electrical hazard", "Honestly the price shocked me a little but I still want to order two."],
  ["being 'burned' by a bad deal is not a chemical/thermal burn", "That other vendor really burned me on a deal last year, glad you all are different."],
  ["'bleeding money' is a financial idiom, not a wound", "This subscription is bleeding me dry every month, can I get a cheaper plan?"],
  ["'bleeding cash' financial idiom, second phrasing", "We're bleeding cash on ad spend right now and need a bulk discount."],
]) {
  test(`idiom false positive (regression): ${label}`, () => {
    const r = classify(text);
    assert.equal(r.matched, false, `"${text}" must not classify as a safety escalation`);
  });
}

test("but a real electrical shock report (with 'electric') still matches, proving the idiom fix did not just delete the rule", () => {
  const r = classify("I got an electric shock from the charging case, it really scared me.");
  assert.equal(r.matched, true);
  assert.ok(r.matches.some((m) => m.id === "fire-shock"));
});

test("and a real body-part injury with the SAME verbs the idiom fix narrowed still matches", () => {
  for (const text of ["The clasp cut my finger when I opened it.", "The battery burned my hand.", "It shocked my hand when I touched the charging port."]) {
    const r = classify(text);
    assert.equal(r.matched, true, `"${text}" must still match`);
    assert.ok(r.matches.some((m) => m.id === "harmed-bodypart"), `"${text}" should match via harmed-bodypart`);
  }
});

// ---- snippet truncation (the <=120 char cap the locked design requires for the SNS alert only) -----

test("truncateSnippet caps at 120 characters by default and marks truncation", () => {
  const long = "x".repeat(200);
  const out = truncateSnippet(long);
  assert.ok(out.length <= 121, "120 chars plus at most one ellipsis marker");
  assert.notEqual(out, long);
});

test("truncateSnippet leaves short text untouched", () => {
  assert.equal(truncateSnippet("short"), "short");
  assert.equal(truncateSnippet(""), "");
});

// ---- stripHtml -------------------------------------------------------------------------------------

test("stripHtml turns Intercom's wrapped message bodies into plain text with real word boundaries", () => {
  const html = "<div dir=\"auto\">I had an <b>allergic reaction</b> to the ear&nbsp;tips.</div>";
  const plain = stripHtml(html);
  assert.doesNotMatch(plain, /<[^>]+>/, "no tags should remain");
  const r = classify(plain);
  assert.equal(r.matched, true, "the classifier must still see the real phrase once HTML is stripped");
});
