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
