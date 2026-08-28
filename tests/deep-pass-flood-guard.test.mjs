// Regression gate for deep-pass.mjs's 2026-08-28 AWS/Bedrock port -- specifically the two-tier
// failure-taxonomy flood-guard fix that closes FND-20260821-783d (a transport/model-outage failure
// used to be indistinguishable from a genuine low-confidence finding, and both were written onto the
// row as a TERMINAL `deep:true` + `review:'NEEDS_CLAUDE_REVIEW'` state that selectTodo's `!r.deep`
// filter never re-selects -- meaning one bad tick against a dead/throttled model would have
// PERMANENTLY flooded all three privileged rooms' `_REVIEW/review-queue.csv`, the CFO/CLO "job one"
// list, with near-total false positives on the very first run of a newly-armed cron).
//
// Deliberately pure-function tests (no network, no S3, no lock file, no real Bedrock call) mirroring
// this file's own established convention for deep-pass.mjs -- see tests/deep-pass-loop.test.mjs's
// existing selectTodo/unresolved tests, which this file extends rather than duplicates. The functions
// under test here (applyAnalysisResult, aggregateExitCode, contentFailPatch, isLlmExcludedRoom) were
// factored out of analyze()/worker()/main() specifically so this exact class of bug is directly
// provable without needing to fake a whole network+storage+lock round trip.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  selectTodo,
  applyAnalysisResult,
  aggregateExitCode,
  contentFailPatch,
  isLlmExcludedRoom,
} from "../skills/doc-indexer/deep-pass.mjs";

// ============================================================================================
// (a) happy path: a successful analysis result writes the enrichment fields
// ============================================================================================

test("applyAnalysisResult: a successful (non-callFailed, non-missingSidecar) result writes deep:true, deep_engine, and the patch fields onto the row", () => {
  const row = { path: "legal/company/note.pdf", summary: "old mini summary" };
  const result = {
    patch: {
      summary_deep: "a rich new summary quoting exact figures",
      title_deep: "8pct Convertible Note - Odyssey Capital - 100k",
      doc_type: "convertible note", confidence: "high", review: "", review_reasons: [],
    },
  };
  const applied = applyAnalysisResult(row, result, "us.anthropic.claude-sonnet-4-5-20250929-v1:0");

  assert.deepEqual(applied, { callFailed: false, noLlmCall: false, missingSidecar: false, flagged: false });
  assert.equal(row.deep, true);
  assert.equal(row.deep_engine, "us.anthropic.claude-sonnet-4-5-20250929-v1:0");
  assert.equal(row.summary, "a rich new summary quoting exact figures", "the rich summary must be promoted to the read `summary` field");
  assert.equal(row.summary_mini, "old mini summary", "the OLD summary must be preserved for audit under summary_mini");
  assert.equal(row.title_deep, "8pct Convertible Note - Odyssey Capital - 100k");
  assert.equal(row.review, undefined, "a clean (non-flagged) result must not leave a stale empty review field sitting on the row");
  assert.equal(row.review_reasons, undefined);
});

test("applyAnalysisResult: a flagged (NEEDS_CLAUDE_REVIEW) successful result is still deep:true, but reports flagged:true and keeps the review fields", () => {
  const row = { path: "legal/company/thin.pdf" };
  const result = { patch: { summary_deep: "", confidence: "low", review: "NEEDS_CLAUDE_REVIEW", review_reasons: ["low summary confidence"] } };
  const applied = applyAnalysisResult(row, result, "us.anthropic.claude-sonnet-4-5-20250929-v1:0");
  assert.equal(applied.flagged, true);
  assert.equal(row.deep, true, "a genuine low-confidence CONTENT outcome is still terminal -- only TRANSPORT failure is retried");
  assert.equal(row.review, "NEEDS_CLAUDE_REVIEW");
  assert.deepEqual(row.review_reasons, ["low summary confidence"]);
});

// ============================================================================================
// (b) THE FLOOD-GUARD FIX: a callFailed (transport) outcome must leave the row COMPLETELY
// untouched -- no deep, no review -- and it must still be reselected by selectTodo next run.
// ============================================================================================

test("THE FIX (FND-20260821-783d): applyAnalysisResult on a callFailed result does NOT set deep/review on the row at all", () => {
  const row = { path: "legal/company/unreachable.pdf" };
  const result = { callFailed: true, err: "bedrock converse: retries exhausted after 6 attempts: bedrock 503" };
  const applied = applyAnalysisResult(row, result, "us.anthropic.claude-sonnet-4-5-20250929-v1:0");

  assert.equal(applied.callFailed, true);
  assert.equal(row.deep, undefined, "a transport failure must NEVER set deep:true -- that is exactly the pre-fix flood bug");
  assert.equal(row.review, undefined, "a transport failure must NEVER set review:NEEDS_CLAUDE_REVIEW");
  assert.equal(row.review_reasons, undefined);
  assert.equal(row.deep_call_err, result.err, "the error is recorded as an EPHEMERAL diagnostic field only, never a terminal marker selectTodo/unresolved reads");
});

test("THE FIX, end to end: a row that received a callFailed outcome IS STILL reselected by selectTodo on the next pass (the actual guarantee this whole fix exists to provide)", () => {
  const row = { path: "legal/company/unreachable.pdf" };
  // Pass 1: fresh row is selected (matches the pre-existing selectTodo contract).
  assert.equal(selectTodo([row], {}).length, 1, "pass 1: a never-processed row must be selected");

  // Simulate exactly what the worker does after analyze() returns callFailed: apply the result via
  // the SAME function main()'s worker loop actually calls, not a hand-rolled Object.assign that could
  // silently diverge from the real code path.
  applyAnalysisResult(row, { callFailed: true, err: "bedrock 503" }, "us.anthropic.claude-sonnet-4-5-20250929-v1:0");

  // Pass 2: MUST still be selected -- this is the entire point. Under the PRE-FIX code (which set
  // deep:true unconditionally on any analyze() outcome, success or failure), this row would now be
  // permanently excluded by selectTodo's `!r.deep` filter, which is precisely the flood-causing bug.
  const pass2 = selectTodo([row], {});
  assert.equal(pass2.length, 1, "pass 2: a row left untouched by a transport failure must be reselected, not silently dropped forever");

  // Pass 3, proving it is not merely a one-tick grace period: the row genuinely never reaches a
  // terminal state from repeated transport failures alone.
  applyAnalysisResult(row, { callFailed: true, err: "bedrock 503 again" }, "us.anthropic.claude-sonnet-4-5-20250929-v1:0");
  assert.equal(selectTodo([row], {}).length, 1, "pass 3: still reselected -- transport failures never accumulate into a terminal state");
});

test("applyAnalysisResult: a missingSidecar result also leaves the row untouched (non-terminal, distinct from callFailed) and remains eligible in selectTodo", () => {
  const row = { path: "finance/maybe-partial-mirror.pdf" };
  const applied = applyAnalysisResult(row, { missingSidecar: true, noLlmCall: true }, "us.anthropic.claude-haiku-4-5-20251001-v1:0");
  assert.deepEqual(applied, { callFailed: false, noLlmCall: true, missingSidecar: true, flagged: false });
  assert.equal(row.deep, undefined);
  assert.equal(row.review, undefined);
  assert.equal(selectTodo([row], {}).length, 1, "a missing-sidecar row must remain eligible so a later-completed S3 mirror gets it re-examined");
});

// ============================================================================================
// (b, continued) the AGGREGATE exit-code gate: an all-calls-failed run must exit non-zero
// ============================================================================================

test("aggregateExitCode: ALL calls failed (0% success) -> exit code 1, a scheduled job against a dead model must go RED", () => {
  assert.equal(aggregateExitCode(6, 6), 1);
  assert.equal(aggregateExitCode(1, 1), 1);
});

test("aggregateExitCode: SOME calls failed but not all -> no forced exit code (a WARN, not a FATAL -- one bad document in a large room should not fail the whole batch)", () => {
  assert.equal(aggregateExitCode(50, 3), undefined);
});

test("aggregateExitCode: no calls attempted at all (e.g. a run with nothing to do, or every row was noLlmCall/missingSidecar) -> no forced exit code", () => {
  assert.equal(aggregateExitCode(0, 0), undefined);
});

test("aggregateExitCode: zero failures out of some calls -> no forced exit code", () => {
  assert.equal(aggregateExitCode(20, 0), undefined);
});

// ============================================================================================
// contentFailPatch: the CONTENT-failure (as opposed to transport-failure) terminal patch shape
// ============================================================================================

test("contentFailPatch: is terminal (review:NEEDS_CLAUDE_REVIEW, reocr_tried:true) and names the stopReason in its diagnostic field", () => {
  const patch = contentFailPatch("max_tokens");
  assert.equal(patch.review, "NEEDS_CLAUDE_REVIEW");
  assert.equal(patch.reocr_tried, true);
  assert.match(patch.deep_softerr, /stopReason=max_tokens/);
  assert.equal(patch.confidence, "low");
  assert.equal(patch.requires_signature, false);
});

test("contentFailPatch: applying it via applyAnalysisResult DOES set deep:true (content failures are terminal -- unlike callFailed)", () => {
  const row = { path: "legal/company/refused.pdf" };
  const applied = applyAnalysisResult(row, { patch: contentFailPatch("end_turn") }, "us.anthropic.claude-sonnet-4-5-20250929-v1:0");
  assert.equal(applied.flagged, true);
  assert.equal(row.deep, true);
  assert.equal(selectTodo([row], {}).length, 0, "a content failure IS terminal and must not be reselected forever");
});

// ============================================================================================
// (c) legal-personal is EXCLUDED from ALL LLM enrichment, categorically
// ============================================================================================

test("isLlmExcludedRoom: legal/personal is excluded", () => {
  assert.equal(isLlmExcludedRoom("legal", "personal"), true);
});

test("isLlmExcludedRoom: legal/company (the actual privileged-but-processed room) is NOT excluded", () => {
  assert.equal(isLlmExcludedRoom("legal", "company"), false);
});

test("isLlmExcludedRoom: finance/cfo-source-docs is NOT excluded", () => {
  assert.equal(isLlmExcludedRoom("finance", "cfo-source-docs"), false);
});

test("isLlmExcludedRoom: legal/exec (a real third legal container, not personal) is NOT excluded", () => {
  assert.equal(isLlmExcludedRoom("legal", "exec"), false);
});

test("isLlmExcludedRoom: case-insensitive on both arguments, and null/undefined-safe", () => {
  assert.equal(isLlmExcludedRoom("LEGAL", "PERSONAL"), true);
  assert.equal(isLlmExcludedRoom("Legal", "Personal"), true);
  assert.equal(isLlmExcludedRoom(undefined, "personal"), false);
  assert.equal(isLlmExcludedRoom("legal", undefined), false);
  assert.equal(isLlmExcludedRoom(undefined, undefined), false);
});

test("isLlmExcludedRoom: 'personal' under a DIFFERENT profile (not legal) is not swept in by a loose match on container alone", () => {
  assert.equal(isLlmExcludedRoom("finance", "personal"), false, "the exclusion is specifically legal+personal, not any room merely named personal");
});
