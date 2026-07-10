// Tests for kb-memory/dedupe.mjs, the pure write-time near-duplicate + contradiction advisory.
import { test } from "node:test";
import assert from "node:assert/strict";
import { tokenize, jaccard, nearDuplicate, possibleContradiction, writeAdvisory } from "../skills/kb-memory/dedupe.mjs";

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
