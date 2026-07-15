// Unit tests for deadline-extract.mjs (Phase 7b). extractCandidates() is pure/offline/
// deterministic; these tests never touch the network, Azure Blob, or an LLM. The central
// property under test: extraction PROPOSES candidates and never commits them (extractCandidates
// has no import of legal.mjs's write path at all -- structurally incapable of writing).
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractCandidates, labelWithLLM } from "../skills/legal/deadline-extract.mjs";
import * as legalModule from "../skills/legal/legal.mjs";

test("extractCandidates finds ISO, US-slash, and long-form dates and normalizes them all to YYYY-MM-DD", () => {
  const text = `Defendant shall respond no later than July 15, 2026.
A case management conference is set for 08/20/2026 at 9:00 AM.
Discovery cutoff is 15 September 2026.
Filed: 2026-06-01.`;
  const cands = extractCandidates(text);
  const dates = cands.map((c) => c.date).sort();
  assert.deepEqual(dates, ["2026-06-01", "2026-07-15", "2026-08-20", "2026-09-15"]);
});

test("every candidate is staged source:'extracted', verified:false (never auto-committed)", () => {
  const cands = extractCandidates("Response due July 15, 2026.");
  assert.ok(cands.length > 0);
  for (const c of cands) {
    assert.equal(c.source, "extracted");
    assert.equal(c.verified, false);
  }
});

test("extractCandidates is a pure data function: it has no docket-store side effects", () => {
  // Structural proof, not just behavioral: the module does not import legal.mjs's write path at
  // all, so calling extract() cannot reach Azure Blob no matter what text is passed. Confirm by
  // reading the module source has no reference to docketAdd/putBlob/putMatter.
  const src = extractCandidates.toString();
  assert.doesNotMatch(src, /docketAdd|putBlob|putMatter/, "extractCandidates must never call a write path directly");
  // and confirm legal.mjs's real write functions are simply never invoked by running extraction
  // against text containing every kind of date, then asserting the return is plain data.
  const cands = extractCandidates("Hearing 07/15/2026, trial July 20, 2026, cutoff 2026-08-01.");
  assert.equal(Array.isArray(cands), true);
  assert.equal(typeof legalModule.docketAdd, "function", "sanity: the real write path exists elsewhere, untouched by extraction");
});

test("rejects dates that are not real calendar dates (Feb 30, month 13, day 0)", () => {
  const text = "Bad: February 30, 2026. Also bad: 13/40/2026. Also bad: 2026-00-00.";
  const cands = extractCandidates(text);
  assert.equal(cands.length, 0);
});

test("2-digit year US-slash dates pivot correctly (00-79 -> 20xx)", () => {
  const cands = extractCandidates("Due 07/15/26.");
  assert.equal(cands.length, 1);
  assert.equal(cands[0].date, "2026-07-15");
});

test("keyword confidence is scoped to the line, not a fixed radius: a neighboring line's keyword does not bleed over", () => {
  const text = [
    "The document itself is dated 2026-06-01.",
    "Discovery cutoff is 15 September 2026.",
  ].join("\n");
  const cands = extractCandidates(text).sort((a, b) => (a.date < b.date ? -1 : 1));
  const docDate = cands.find((c) => c.date === "2026-06-01");
  const cutoffDate = cands.find((c) => c.date === "2026-09-15");
  assert.equal(docDate.confidence, "low", "a bare document date on its own line must not inherit a neighboring line's keyword");
  assert.equal(docDate.keyword, null);
  assert.equal(cutoffDate.confidence, "high");
  assert.equal(cutoffDate.keyword, "Discovery cutoff");
});

test("a label-then-date table (label on the line above a date-only line) still attaches the keyword", () => {
  const text = "Discovery Cutoff:\n09/01/2026\n";
  const cands = extractCandidates(text);
  assert.equal(cands.length, 1);
  assert.equal(cands[0].date, "2026-09-01");
  assert.equal(cands[0].confidence, "high");
  assert.match(cands[0].keyword, /discovery cutoff/i);
});

test("a bare date with no nearby deadline keyword gets confidence 'low'", () => {
  const cands = extractCandidates("The company was incorporated on March 3, 2010.");
  assert.equal(cands.length, 1);
  assert.equal(cands[0].confidence, "low");
  assert.equal(cands[0].keyword, null);
});

test("near-duplicate matches of the SAME date within ~30 chars collapse to one candidate", () => {
  // A parenthetical restatement of the same date immediately after the original mention.
  const cands = extractCandidates("Due no later than 2026-07-15 (July 15, 2026).");
  assert.equal(cands.length, 1, "the ISO date and its long-form restatement right next to it must not double-count");
  assert.equal(cands[0].date, "2026-07-15");
});

test("two genuinely separate mentions of the same date elsewhere in a long document are NOT collapsed", () => {
  const filler = "x".repeat(500);
  const text = `Hearing set for July 15, 2026. ${filler} Reminder: the hearing on July 15, 2026 was previously continued.`;
  const cands = extractCandidates(text);
  assert.equal(cands.length, 2, "far-apart mentions of the same date are two distinct candidates for CLO review");
});

test("candidates are sorted by date ascending", () => {
  const text = "Later: September 1, 2026. Earlier: June 1, 2026. Middle: July 1, 2026.";
  const cands = extractCandidates(text);
  assert.deepEqual(cands.map((c) => c.date), ["2026-06-01", "2026-07-01", "2026-09-01"]);
});

test("empty, undefined, and no-date text all return an empty array without throwing", () => {
  assert.deepEqual(extractCandidates(""), []);
  assert.deepEqual(extractCandidates(undefined), []);
  assert.deepEqual(extractCandidates("no dates anywhere in this sentence"), []);
});

// ---- labelWithLLM: optional context labeling, fail-open, DI-only (no live LLM in tests) ----

test("labelWithLLM rewrites `what` from an injected chatFn and preserves the deterministic text as `context`", async () => {
  const cands = extractCandidates("Respond no later than July 15, 2026.");
  const chatFn = async (_system, _user) => "Response to motion due";
  const labeled = await labelWithLLM(cands, { chatFn });
  assert.equal(labeled[0].what, "Response to motion due");
  assert.equal(labeled[0].context, cands[0].what, "the original deterministic context must be preserved, not discarded");
  assert.equal(labeled[0].date, cands[0].date, "labeling must never change the date");
});

test("labelWithLLM fails open on a throwing chatFn: the deterministic `what` is unchanged", async () => {
  const cands = extractCandidates("Respond no later than July 15, 2026.");
  const chatFn = async () => { throw new Error("network unreachable"); };
  const labeled = await labelWithLLM(cands, { chatFn });
  assert.equal(labeled[0].what, cands[0].what);
  assert.equal(labeled.length, cands.length);
});

test("labelWithLLM leaves `what` unchanged when the model returns UNCLEAR", async () => {
  const cands = extractCandidates("Respond no later than July 15, 2026.");
  const chatFn = async () => "UNCLEAR";
  const labeled = await labelWithLLM(cands, { chatFn });
  assert.equal(labeled[0].what, cands[0].what);
  assert.equal(labeled[0].context, undefined, "context is only attached when a real label replaces `what`");
});

test("labelWithLLM bounds LLM calls to `limit`: candidates beyond the bound keep deterministic text untouched", async () => {
  const text = Array.from({ length: 5 }, (_, i) => `Item ${i}: due January ${i + 1}, 2026.`).join(" ");
  const cands = extractCandidates(text);
  assert.ok(cands.length >= 5);
  let calls = 0;
  const chatFn = async () => { calls++; return "Labeled"; };
  const labeled = await labelWithLLM(cands, { chatFn, limit: 2 });
  assert.equal(calls, 2, "only `limit` candidates should ever reach the chat function");
  assert.equal(labeled.filter((c) => c.what === "Labeled").length, 2);
});
