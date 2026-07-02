#!/usr/bin/env node
// structured-notes / note-schema.mjs -- pure, dependency-free schema + validator for STRUCTURED
// agent notes that layer on top of the existing kb-memory ledger row shape:
//   { id, ts, type, text, tags, source, was, supersedes, ekey, evalue, agent }
//
// This module does NOT change the ledger row shape. A structured note is encoded as a canonical
// single-line string and stored in the row's existing `text` field (optionally with a `structured`
// tag), so every existing free-text row keeps working exactly as it does today and the recall
// harness (skills/signal-radar detectors, skills/recall-evals) can keep reading `text` as before.
// Structured notes are an OPT-IN layer: an agent that never calls this module is unaffected.
//
// THE SCHEMA (all fields optional except subject + claim):
//   subject:    string  -- the entity/topic the note is about (a person, a system, a decision, ...)
//   claim:      string  -- the statement being made about the subject
//   evidence?:  string  -- source/citation backing the claim (a URL, a doc name, "Matt 2026-06-19")
//   confidence?:"low"|"med"|"high" -- how sure the writer is (defaults to unspecified if omitted)
//   supersedes?:string  -- an id (ledger row id, or a prior note's own id) this note replaces
//   tags?:      string[] -- free-form labels, merged with (not replacing) any ledger `tags`
//
// WHY: kb-memory's `text` field is free prose. That is fine for a human reading the rendered .md,
// but a RECALL HARNESS (precision@k / hit-rate scoring, contradiction-staleness detection, the
// per-prompt pack ranker) does better with a few explicit, machine-parseable fields: WHAT is this
// about (subject), WHAT is being claimed (claim), and HOW SURE is the writer (confidence). This
// module gives agents an optional, structured way to write that without any ledger schema change.
//
// Bridge to the ledger: `toLedgerText(note)` renders a canonical line like
//   "SUBJECT: Xero OAuth token | CLAIM: refresh token expires after 60 days of inactivity | SRC: Xero docs 2026-05 | CONF: high"
// which is exactly what you would pass as the free-text argument to `mem.mjs remember "<...>"` etc.
// `normalizeNote(text)` parses that same line back into a structured note object, so round-tripping
// through the ledger's plain-text `text` column is lossless for the fields the schema defines.

export const CONFIDENCE_LEVELS = ["low", "med", "high"];

// Field order + labels used by toLedgerText / normalizeNote. Keep in sync with each other.
const FIELD_LABELS = [
  ["subject", "SUBJECT"],
  ["claim", "CLAIM"],
  ["evidence", "SRC"],
  ["confidence", "CONF"],
  ["supersedes", "SUPERSEDES"],
  ["tags", "TAGS"],
];
const LABEL_TO_FIELD = new Map(FIELD_LABELS.map(([field, label]) => [label, field]));

/**
 * Validate a structured note object.
 * @param {*} obj - candidate note (should look like { subject, claim, evidence?, confidence?, supersedes?, tags? }).
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateNote(obj) {
  const errors = [];
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    return { ok: false, errors: ["note must be a non-null object"] };
  }
  const subject = obj.subject;
  const claim = obj.claim;
  if (typeof subject !== "string" || subject.trim().length === 0) {
    errors.push("subject is required and must be a non-empty string");
  }
  if (typeof claim !== "string" || claim.trim().length === 0) {
    errors.push("claim is required and must be a non-empty string");
  }
  if (obj.evidence !== undefined && typeof obj.evidence !== "string") {
    errors.push("evidence must be a string when present");
  }
  if (obj.confidence !== undefined && !CONFIDENCE_LEVELS.includes(obj.confidence)) {
    errors.push(`confidence must be one of ${CONFIDENCE_LEVELS.join("|")} when present`);
  }
  if (obj.supersedes !== undefined && typeof obj.supersedes !== "string") {
    errors.push("supersedes must be a string when present");
  }
  if (obj.tags !== undefined) {
    if (!Array.isArray(obj.tags) || obj.tags.some((t) => typeof t !== "string")) {
      errors.push("tags must be an array of strings when present");
    }
  }
  return { ok: errors.length === 0, errors };
}

// Best-effort parse of a free-text "SUBJECT: X | CLAIM: Y | SRC: Z | CONF: high | ..." line into a
// plain object of the fields it finds. Unknown segments (no recognized "LABEL:" prefix) are ignored.
// Segment order does not matter; any subset of fields may be present.
function parseFreeText(str) {
  const out = {};
  const segments = String(str).split("|");
  for (const raw of segments) {
    const seg = raw.trim();
    if (!seg) continue;
    const m = seg.match(/^([A-Za-z]+)\s*:\s*(.*)$/s);
    if (!m) continue;
    const label = m[1].trim().toUpperCase();
    const value = m[2].trim();
    const field = LABEL_TO_FIELD.get(label);
    if (!field || !value) continue;
    if (field === "tags") {
      out.tags = value.split(",").map((t) => t.trim()).filter(Boolean);
    } else if (field === "confidence") {
      out.confidence = value.toLowerCase();
    } else {
      out[field] = value;
    }
  }
  return out;
}

/**
 * Normalize input into a structured note object, accepting EITHER:
 *   - an already-structured object (a shallow copy is returned, with tags de-duplicated/trimmed), or
 *   - a free-text string in the "SUBJECT: X | CLAIM: Y | SRC: Z | CONF: high | SUPERSEDES: id | TAGS: a,b" form
 *     (any subset/order of labeled segments; unrecognized segments are ignored).
 * Does NOT throw on malformed input; missing fields are simply absent from the result. Callers should
 * run the result through validateNote() to check subject/claim are present before relying on it.
 * @param {object|string} input
 * @returns {{subject?: string, claim?: string, evidence?: string, confidence?: string, supersedes?: string, tags?: string[]}}
 */
export function normalizeNote(input) {
  const raw = typeof input === "string" ? parseFreeText(input) : (input && typeof input === "object" ? input : {});
  const note = {};
  if (typeof raw.subject === "string" && raw.subject.trim()) note.subject = raw.subject.trim();
  if (typeof raw.claim === "string" && raw.claim.trim()) note.claim = raw.claim.trim();
  if (typeof raw.evidence === "string" && raw.evidence.trim()) note.evidence = raw.evidence.trim();
  if (typeof raw.confidence === "string") {
    const c = raw.confidence.trim().toLowerCase();
    if (CONFIDENCE_LEVELS.includes(c)) note.confidence = c;
  }
  if (typeof raw.supersedes === "string" && raw.supersedes.trim()) note.supersedes = raw.supersedes.trim();
  if (Array.isArray(raw.tags)) {
    const tags = [...new Set(raw.tags.map((t) => String(t).trim()).filter(Boolean))];
    if (tags.length) note.tags = tags;
  }
  return note;
}

/**
 * Render a structured note as a canonical single-line string suitable for a ledger row's `text`
 * field. Only includes segments for fields actually present on the note. Round-trips through
 * normalizeNote(): normalizeNote(toLedgerText(note)) reproduces the same fields (subject/claim
 * required; optional fields present iff they were present on the input).
 * @param {object} note - a note object (need not be pre-validated; missing subject/claim just omit
 *   those segments, so callers who want a guaranteed-valid line should validateNote() first).
 * @returns {string}
 */
export function toLedgerText(note) {
  const n = normalizeNote(note);
  const parts = [];
  for (const [field, label] of FIELD_LABELS) {
    if (field === "tags") {
      if (n.tags && n.tags.length) parts.push(`${label}: ${n.tags.join(",")}`);
      continue;
    }
    if (n[field] !== undefined) parts.push(`${label}: ${n[field]}`);
  }
  return parts.join(" | ");
}

// ---- CLI ----
// Usage:
//   node note-schema.mjs validate '<json>'
//   node note-schema.mjs normalize '<json-or-freetext>'
//   node note-schema.mjs to-ledger-text '<json>'
function isMain() {
  try {
    return import.meta.url === `file://${process.argv[1]}`;
  } catch {
    return false;
  }
}
if (isMain()) {
  const [cmd, ...rest] = process.argv.slice(2);
  const arg = rest.join(" ");
  const tryParseJson = (s) => { try { return JSON.parse(s); } catch { return s; } };
  if (cmd === "validate") {
    const obj = tryParseJson(arg);
    console.log(JSON.stringify(validateNote(obj)));
  } else if (cmd === "normalize") {
    const input = tryParseJson(arg);
    console.log(JSON.stringify(normalizeNote(input)));
  } else if (cmd === "to-ledger-text") {
    const obj = tryParseJson(arg);
    console.log(toLedgerText(obj));
  } else {
    console.error("usage: note-schema.mjs validate|normalize|to-ledger-text '<json-or-text>'");
    process.exit(2);
  }
}
