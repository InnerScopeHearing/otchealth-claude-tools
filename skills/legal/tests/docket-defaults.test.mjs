// Hermetic test for legal.mjs's pure applyDocketRowDefaults() helper (the source/verified default
// rule that skills/legal-deadline-pager relies on to decide what is safe to page). Importing legal.mjs
// must NOT execute its CLI (no Azure Blob credentials needed here) -- that is what the isMain guard in
// legal.mjs is for; this test doubles as a regression check for that guard.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyDocketRowDefaults } from "../legal.mjs";

test("applyDocketRowDefaults: a row with neither field defaults to manual + verified (a human typed it in)", () => {
  const out = applyDocketRowDefaults({ ns: "company", id: "m1", date: "2026-07-16", what: "x" });
  assert.equal(out.source, "manual");
  assert.equal(out.verified, true);
});

test("applyDocketRowDefaults: source=extracted with verified:false is preserved, never upgraded to verified", () => {
  const out = applyDocketRowDefaults({ source: "extracted", verified: false });
  assert.equal(out.source, "extracted");
  assert.equal(out.verified, false);
});

test("applyDocketRowDefaults: source=courtlistener with verified:true is preserved", () => {
  const out = applyDocketRowDefaults({ source: "courtlistener", verified: true });
  assert.equal(out.source, "courtlistener");
  assert.equal(out.verified, true);
});

test("applyDocketRowDefaults: verified:false with no explicit source still defaults source to manual (fields are independent)", () => {
  const out = applyDocketRowDefaults({ verified: false });
  assert.equal(out.source, "manual");
  assert.equal(out.verified, false);
});

test("applyDocketRowDefaults: does not mutate the input row", () => {
  const input = { date: "2026-07-16", what: "x" };
  const out = applyDocketRowDefaults(input);
  assert.equal(Object.prototype.hasOwnProperty.call(input, "source"), false);
  assert.notEqual(out, input);
});

test("applyDocketRowDefaults: preserves all other fields untouched", () => {
  const out = applyDocketRowDefaults({ ns: "personal", id: "ca-divorce", date: "2026-07-17", what: "FL-142 due", overdue: false, added: "2026-06-01" });
  assert.equal(out.ns, "personal");
  assert.equal(out.id, "ca-divorce");
  assert.equal(out.overdue, false);
  assert.equal(out.added, "2026-06-01");
});
