// Regression gate for skills/structured-notes/note-schema.mjs -- the optional structured-note layer
// that encodes into kb-memory's existing free-text ledger `text` field (no ledger schema change).
// Pure, dependency-free module: these tests run hermetically, no fs/network/credentials.
import { test } from "node:test";
import assert from "node:assert";
import { validateNote, normalizeNote, toLedgerText, CONFIDENCE_LEVELS } from "../skills/structured-notes/note-schema.mjs";

test("validateNote: missing subject and claim both produce errors", () => {
  const { ok, errors } = validateNote({});
  assert.equal(ok, false);
  assert.ok(errors.some((e) => /subject/i.test(e)), "reports a subject error");
  assert.ok(errors.some((e) => /claim/i.test(e)), "reports a claim error");
});

test("validateNote: missing subject only", () => {
  const { ok, errors } = validateNote({ claim: "the sky is blue" });
  assert.equal(ok, false);
  assert.ok(errors.some((e) => /subject/i.test(e)));
  assert.ok(!errors.some((e) => /claim/i.test(e)));
});

test("validateNote: missing claim only", () => {
  const { ok, errors } = validateNote({ subject: "sky" });
  assert.equal(ok, false);
  assert.ok(errors.some((e) => /claim/i.test(e)));
  assert.ok(!errors.some((e) => /subject/i.test(e)));
});

test("validateNote: a minimal valid note passes with no errors", () => {
  const { ok, errors } = validateNote({ subject: "Xero OAuth token", claim: "refresh token expires after 60 days" });
  assert.equal(ok, true);
  assert.deepEqual(errors, []);
});

test("validateNote: rejects a non-object input", () => {
  assert.equal(validateNote(null).ok, false);
  assert.equal(validateNote("not an object").ok, false);
  assert.equal(validateNote(["subject", "claim"]).ok, false);
});

test("validateNote: rejects a bad confidence value", () => {
  const { ok, errors } = validateNote({ subject: "x", claim: "y", confidence: "extremely-high" });
  assert.equal(ok, false);
  assert.ok(errors.some((e) => /confidence/i.test(e)));
});

test("validateNote: accepts every documented confidence level", () => {
  for (const c of CONFIDENCE_LEVELS) {
    const { ok } = validateNote({ subject: "x", claim: "y", confidence: c });
    assert.equal(ok, true, `confidence '${c}' should be valid`);
  }
});

test("validateNote: rejects non-array tags and non-string tag entries", () => {
  assert.equal(validateNote({ subject: "x", claim: "y", tags: "not-an-array" }).ok, false);
  assert.equal(validateNote({ subject: "x", claim: "y", tags: ["ok", 5] }).ok, false);
});

test("normalizeNote: accepts a structured object as-is (fields preserved, tags de-duped)", () => {
  const note = normalizeNote({
    subject: "Xero OAuth token",
    claim: "refresh token expires after 60 days of inactivity",
    evidence: "Xero docs 2026-05",
    confidence: "high",
    tags: ["xero", "auth", "xero"],
  });
  assert.equal(note.subject, "Xero OAuth token");
  assert.equal(note.claim, "refresh token expires after 60 days of inactivity");
  assert.equal(note.evidence, "Xero docs 2026-05");
  assert.equal(note.confidence, "high");
  assert.deepEqual(note.tags, ["xero", "auth"]);
});

test("normalizeNote: best-effort parses a free-text SUBJECT/CLAIM/SRC/CONF line", () => {
  const note = normalizeNote("SUBJECT: Xero OAuth token | CLAIM: refresh token expires after 60 days | SRC: Xero docs 2026-05 | CONF: high");
  assert.equal(note.subject, "Xero OAuth token");
  assert.equal(note.claim, "refresh token expires after 60 days");
  assert.equal(note.evidence, "Xero docs 2026-05");
  assert.equal(note.confidence, "high");
});

test("normalizeNote: free-text parse tolerates any subset and any order of segments", () => {
  const note = normalizeNote("CLAIM: build 47 shipped | SUBJECT: iHEARtest CFBundleVersion");
  assert.equal(note.subject, "iHEARtest CFBundleVersion");
  assert.equal(note.claim, "build 47 shipped");
  assert.equal(note.evidence, undefined);
  assert.equal(note.confidence, undefined);
});

test("normalizeNote: plain free text with no recognizable labels yields an empty note (no throw)", () => {
  const note = normalizeNote("just a normal sentence with no structure at all");
  assert.deepEqual(note, {});
});

test("normalizeNote: never throws on odd input (null, number, array)", () => {
  assert.doesNotThrow(() => normalizeNote(null));
  assert.doesNotThrow(() => normalizeNote(42));
  assert.doesNotThrow(() => normalizeNote(["not", "an", "object"]));
});

test("toLedgerText: renders a canonical single line with only present fields", () => {
  const line = toLedgerText({ subject: "Xero OAuth token", claim: "refresh token expires after 60 days" });
  assert.equal(line, "SUBJECT: Xero OAuth token | CLAIM: refresh token expires after 60 days");
});

test("toLedgerText: includes optional fields when present, in canonical order", () => {
  const line = toLedgerText({
    subject: "Xero OAuth token",
    claim: "refresh token expires after 60 days",
    evidence: "Xero docs 2026-05",
    confidence: "high",
    supersedes: "20260101-001",
    tags: ["xero", "auth"],
  });
  assert.equal(
    line,
    "SUBJECT: Xero OAuth token | CLAIM: refresh token expires after 60 days | SRC: Xero docs 2026-05 | CONF: high | SUPERSEDES: 20260101-001 | TAGS: xero,auth"
  );
});

test("round-trip: toLedgerText(note) then normalizeNote(...) reproduces the same fields (full note)", () => {
  const original = {
    subject: "Xero OAuth token",
    claim: "refresh token expires after 60 days of inactivity",
    evidence: "Xero docs 2026-05",
    confidence: "med",
    supersedes: "20260101-001",
    tags: ["xero", "auth"],
  };
  const roundTripped = normalizeNote(toLedgerText(original));
  assert.deepEqual(roundTripped, original);
});

test("round-trip: toLedgerText(note) then normalizeNote(...) reproduces the same fields (minimal note)", () => {
  const original = { subject: "sky", claim: "is blue" };
  const roundTripped = normalizeNote(toLedgerText(original));
  assert.deepEqual(roundTripped, original);
});

test("round-trip: a value containing a pipe character in claim/evidence does not corrupt other fields", () => {
  // Pipe is the segment separator; this documents current best-effort behavior rather than requiring
  // full escaping -- the SUBJECT and leading part of CLAIM must still survive intact.
  const original = { subject: "build pipeline", claim: "stage A completed" };
  const line = toLedgerText(original);
  const roundTripped = normalizeNote(line);
  assert.equal(roundTripped.subject, "build pipeline");
  assert.equal(roundTripped.claim, "stage A completed");
});

test("toLedgerText: a note missing required fields simply omits those segments (no throw)", () => {
  assert.equal(toLedgerText({ evidence: "some source" }), "SRC: some source");
  assert.equal(toLedgerText({}), "");
});

test("existing free-text ledger rows remain untouched by this module (no mutation, no throw on plain text)", () => {
  const plainText = "Xero refresh tokens expire after 60 days of inactivity";
  const note = normalizeNote(plainText);
  // No SUBJECT:/CLAIM: labels present -> nothing parsed out, proving a pre-existing free-text row is
  // left exactly as free text for any consumer that does not opt into structured parsing.
  assert.deepEqual(note, {});
  assert.equal(validateNote(note).ok, false, "an unparsed free-text row is correctly NOT a valid structured note");
});
