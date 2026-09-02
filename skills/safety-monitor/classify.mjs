// classify.mjs -- the safety-escalation text classifier. Pure, synchronous, no I/O: given one piece
// of customer-authored conversation text, decide whether it describes a genuine safety escalation
// (physical injury, adverse/allergic reaction, emergency medical care, or an explicit device hazard).
//
// THE BUG THIS REPLACES (see skills/safety-monitor/SKILL.md "Why this exists" for the full incident).
// The predecessor n8n workflow (D8NH3ITNIhvPyjfP, dead since the Azure loss and not recoverable) did a
// bare keyword-STEM match on the single word "physician". Word-boundary regex alone does NOT fix this:
// \bphysician\b legitimately matches the real, standalone word "Physician" inside the marketing brand
// phrase "Physician's Choice" (there IS a word boundary between "n" and the following apostrophe), so
// the predecessor's exact failure would survive a naive "just add \b" fix. The real defect was using a
// single common noun, on its own, as a safety signal at all -- "physician" says nothing about harm by
// itself. This file's rule table only contains PHRASES that describe an actual harm outcome (an
// injury, a reaction, emergency care, a device hazard), never a bare reference to a person or role.
//
// DESIGN, per the locked spec: word-boundary aware, table-driven (not "regex soup"), and biased toward
// PRECISION over recall -- a missed borderline case costs one human review that never happens; a false
// positive costs trust in the alert (and, worse, misapplies the tag to an innocent conversation). Every
// rule below is a specific, low-ambiguity phrase that a real customer support conversation is very
// unlikely to contain for any reason OTHER than reporting genuine harm.
//
// SCOPE (a deliberate, documented limitation, not an oversight): classify() is meant to be called only
// on CUSTOMER-authored text (see monitor.mjs's isCustomerAuthor()), never on admin/teammate replies.
// Admin apology boilerplate ("sorry you were hurt", "sorry for any harm caused") would otherwise be a
// rich source of false positives on exactly these rules. A staff-authored phone-call note that
// paraphrases what a customer reported by voice is therefore NOT scanned by this monitor version --
// flagged in SKILL.md as a known gap, not hidden.

// ---- context suppression (brand names AND safety-RATING terminology) ------------------------------
// A small, explicit table of phrases that must NEVER themselves be read as a harm signal. Two distinct
// sub-cases share this mechanism because they are the SAME underlying bug shape -- a word that signals
// harm in isolation means something entirely different inside one specific fixed phrase: (1) a brand
// name containing an otherwise-plausible trigger word ("Physician's Choice"), and (2) a safety-RATING
// term for equipment resistant to a hazard, not a report of that hazard occurring ("explosion-proof").
// Case 2 was NOT anticipated at design time -- it was caught live, during this skill's own required
// real dry run against Intercom on 2026-09-02: two genuine marketing emails pitching industrial
// equipment ("explosion-proof/corrosion-resistant options") tripped the fire-shock rule's bare
// "explosion" alternative. Same root cause as the Physician's Choice incident, same fix shape (mask
// the phrase, not the whole rule).
const BRAND_CONTEXT_SUPPRESSIONS = [
  {
    id: "physicians-choice-brand",
    pattern: /physician'?s choice/gi,
    why: "the documented false positive: marketing copy mentioning the brand \"Physician's Choice\", not a report from a physician",
  },
  {
    id: "explosion-safety-rating",
    pattern: /\bexplosion[\s-]?(?:proof|resistant|rated|protected|protection)\b/gi,
    why: "a safety-rating term for equipment resistant to explosion, not a report of one -- live-caught 2026-09-02 in real marketing email for industrial fixtures",
  },
  {
    id: "shock-safety-rating",
    pattern: /\b(?:electric(?:al)?\s+)?shock[\s-]?(?:proof|resistant|rated|protected|protection)\b/gi,
    why: "a safety-rating term for equipment resistant to electric shock, not a report of one",
  },
  {
    id: "fire-safety-rating",
    pattern: /\bfire[\s-]?(?:proof|resistant|rated|retardant)\b/gi,
    why: "a safety-rating term for equipment resistant to fire, not a report of one",
  },
];

function maskBrandContext(text) {
  const suppressed = [];
  let masked = text;
  for (const s of BRAND_CONTEXT_SUPPRESSIONS) {
    masked = masked.replace(s.pattern, (m) => {
      suppressed.push({ id: s.id, snippet: m, why: s.why });
      return " ".repeat(m.length);
    });
  }
  return { masked, suppressed };
}

// ---- the rule table -------------------------------------------------------------------------------
// Every pattern is word-boundary anchored (\b) and case-insensitive. Categories exist for the alert's
// human-readable "why it matched" line, not for any branching logic -- a match in any category is
// treated identically (escalate).
export const RULES = [
  { id: "injury-noun", category: "injury", pattern: /\binjur(?:ed|y|ies)\b/i, why: "explicit injury language" },
  {
    // Requires an explicit body part, not just "me"/"myself". This is deliberately narrower than an
    // earlier draft, which also accepted a bare "me"/"myself" object for every verb here -- adversarial
    // review caught that "cut me some slack", "the price shocked me", and "that vendor burned me" (cheated
    // me) are all common English idioms wholly unrelated to physical harm, and this is a customer-support
    // inbox that (per this monitor's own live testing) genuinely receives marketing/complaint email using
    // exactly this kind of language. "cut/shocked/burned/scarred my <body part>" has essentially no such
    // idiomatic reading; "harmed me/myself" (below, kept separate) is the one verb in this family with no
    // common non-physical idiom, so it alone keeps the bare-object form.
    id: "harmed-bodypart",
    category: "injury",
    pattern: /\b(?:hurt|harmed|burned|burnt|shocked|cut|scarred)\s+my\s+(?:ear|ears|skin|hand|face|finger|fingers|arm|eye|eyes)\b/i,
    why: "the product physically harmed a specific body part",
  },
  { id: "harmed-me", category: "injury", pattern: /\bharmed\s+(?:me|myself)\b/i, why: "the product harmed the person directly" },
  {
    // Negative lookahead excludes the common financial idiom ("bleeding money/cash/profits", "bleeding
    // me dry") -- a real risk in an inbox that also receives marketing/complaint email about cost, not
    // just device-related bleeding.
    id: "bleeding",
    category: "injury",
    pattern: /\b(?:bleeding|bled)\b(?!\s+(?:me\s+dry|money|cash|profits?|out\s+cash))/i,
    why: "bleeding",
  },
  {
    id: "ruptured-eardrum",
    category: "injury",
    pattern: /\b(?:ruptured|perforated)\s+eardrum\b/i,
    why: "ruptured/perforated eardrum",
  },
  { id: "allergic-reaction", category: "adverse_reaction", pattern: /\ballergic\s+reactions?\b/i, why: "allergic reaction" },
  { id: "adverse-reaction", category: "adverse_reaction", pattern: /\badverse\s+(?:reactions?|effects?)\b/i, why: "adverse reaction/effect" },
  { id: "anaphylaxis", category: "adverse_reaction", pattern: /\banaphyla(?:xis|ctic)\b/i, why: "anaphylaxis" },
  { id: "emergency-room", category: "emergency_care", pattern: /\b(?:emergency\s+room|e\.?r\.?\s+visit|urgent\s+care)\b/i, why: "emergency medical care" },
  { id: "hospitalized", category: "emergency_care", pattern: /\bhospitali[sz](?:ed|ation)\b/i, why: "hospitalization" },
  { id: "called-911", category: "emergency_care", pattern: /\bcall(?:ed|ing)?\s+911\b/i, why: "a 911 call" },
  { id: "poison-control", category: "emergency_care", pattern: /\bpoison\s+control\b/i, why: "poison control contacted" },
  {
    // "shocked me" (bare, no "electric") was in an earlier draft and is deliberately gone: "the price
    // shocked me" is a common, unrelated idiom. A genuine electrical-shock report is very reliably
    // phrased with "electric"/"electrical" nearby, or lands on harmed-bodypart above ("shocked my hand").
    id: "fire-shock",
    category: "device_hazard",
    pattern: /\b(?:caught\s+fire|catching\s+fire|electric(?:al)?\s+shock|explod(?:ed|ing)|explosion)\b/i,
    why: "fire, electrical shock, or explosion hazard",
  },
  { id: "choking-hazard", category: "device_hazard", pattern: /\bchoking\s+hazard\b/i, why: "choking hazard" },
  {
    id: "swallowed-part",
    category: "device_hazard",
    pattern: /\bswallowed\s+(?:the|a|my)\s+(?:battery|batteries|part|piece|component)\b/i,
    why: "a device component was swallowed",
  },
  {
    id: "explicit-danger",
    category: "explicit_safety",
    pattern: /\b(?:safety\s+(?:issue|concern|hazard|recall)|this\s+(?:device|product)\s+is\s+dangerous|could\s+(?:kill|seriously\s+hurt)\s+(?:someone|me|my\s+\w+))\b/i,
    why: "explicit safety/danger language from the customer",
  },
];

/** Truncate `text` so the RESULT is at most `max` units long (default 120, the alert-snippet cap the
 *  locked design requires), cutting only on a whole-character boundary and appending an ellipsis
 *  marker. Two bugs the first version had, both caught in review:
 *   - it returned `slice(0, max)` PLUS an ellipsis, i.e. max + 1, breaking the cap it documented;
 *   - `String.slice` cuts UTF-16 units, so it could split a surrogate pair and emit a lone half,
 *     which is not a whole-character boundary and can render as a replacement glyph in the alert.
 *  Iterating the string yields whole code points, and the ellipsis is paid for out of the budget
 *  rather than added on top of it. */
export function truncateSnippet(text, max = 120) {
  const s = String(text ?? "");
  if (s.length <= max) return s;
  let out = "";
  for (const ch of s) {
    if (out.length + ch.length > max - 1) break; // reserve one unit for the ellipsis
    out += ch;
  }
  return `${out}…`;
}

/**
 * Classify one piece of text. Pure and synchronous; never throws on ordinary string input (a
 * non-string is coerced). Returns:
 *   { matched: boolean, matches: [{ id, category, why, snippet }], suppressed: [{ id, snippet, why }] }
 * `matches` is every rule that fired, in table order (usually just the first is used by a caller, but
 * all are returned so an alert can cite more than one signal when several are present). `suppressed`
 * lists any brand-context phrase that was masked out, purely for observability/testing -- it never by
 * itself implies anything about `matched`.
 */
export function classify(rawText) {
  const text = String(rawText ?? "");
  const { masked, suppressed } = maskBrandContext(text);
  const matches = [];
  for (const rule of RULES) {
    const m = rule.pattern.exec(masked);
    if (m) matches.push({ id: rule.id, category: rule.category, why: rule.why, snippet: m[0] });
  }
  return { matched: matches.length > 0, matches, suppressed };
}

/** Strip HTML tags and collapse whitespace/entities well enough for classification and for a
 *  human-readable alert snippet. Not a general-purpose sanitizer (this output is never re-rendered as
 *  HTML) -- just enough to turn Intercom's `<div>...</div>`-wrapped message bodies into plain text so
 *  word-boundary regexes see real word boundaries instead of tag soup. */
export function stripHtml(html) {
  let s = String(html ?? "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li)>/gi, "\n");

  // Strip tags to a FIXED POINT, not in one pass. A single pass leaves a fragment behind on nested
  // or malformed markup -- "<<script>script>" becomes "<script>" -- and here that is not merely
  // cosmetic: surviving angle-bracket soup changes where \b word boundaries fall, which is the one
  // thing this function exists to get right. Text that keeps its markup can therefore hide a
  // trigger word from the classifier, so an incomplete strip is a detection-evasion path in a
  // SAFETY classifier. Terminates because each pass strictly shortens the string.
  let prev;
  do {
    prev = s;
    s = s.replace(/<[^>]*>/g, "");
  } while (s !== prev);

  // Decode entities with &amp; LAST. Decoding it first double-unescapes: the literal text
  // "&amp;lt;" means "&lt;", but &amp;->& first turns it into "&lt;" and the next rule then turns
  // that into "<", inventing a tag the author never wrote. Every other entity is decoded before it,
  // so "&amp;" can only ever produce a literal ampersand.
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&amp;/gi, "&")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
}
