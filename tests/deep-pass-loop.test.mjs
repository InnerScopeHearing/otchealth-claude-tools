// Regression gate for the deep-pass.mjs runaway-reselection loop (root-caused 2026-08-13 from Azure
// usage meters: three Container Apps Jobs re-processing the same already-deep-processed documents
// every 30 minutes at concurrency 16, ~$2,394/month for zero new information).
//
// REAL MECHANISM (confirmed by reading the code, not the originally-hypothesized one): the selection
// filter `unresolved()` reselects a row whenever it is `deep: true` but still carries a review_reason
// matching /thin|re-?OCR/i, is not `non_text_asset`, and has not been healed (`!reocr`). Before this
// fix, `unresolved()` did NOT also check `!reocr_tried`, and `analyze()`'s `reocr_tried` flag was only
// ever set true from INSIDE the low-alnum(<60) auto-re-OCR branch (`reocr_tried: reocr_tried || reocr`,
// where the local `reocr_tried` var is flipped true only when `alnum(txt) < 60` triggers a Document
// Intelligence attempt). A document whose extracted text already cleared the 60-alnum-char threshold
// (so the DI branch never even ran) but which gpt-4.1 itself still flagged e.g. ["text too thin to
// trust"] in its `flags` field therefore NEVER got `reocr_tried=true`. Its input never changes between
// cron ticks, so the (temp=0.1) model kept re-emitting the same "thin"-matching flag every single pass,
// and `unresolved()` reselected it forever -- a real, unbounded infinite loop for any doc that lands in
// exactly that state. It was NOT the originally-suspected mechanism (`patch.non_text_asset = false`
// being written unconditionally on the main analyze() path never resets a row that was correctly
// classified `non_text_asset: true` on a prior pass, because such rows return early via the dedicated
// non-text-asset branch and never reach that line again once `!r.deep` is false and `unresolved()`
// short-circuits false on `!r.non_text_asset`).
//
// The fix: `analyze()` now sets `patch.reocr_tried = true` unconditionally once a full LLM analysis
// pass completes (both the content-filter/error branch and the normal text-analysis branch), and
// `unresolved()` now also requires `!r.reocr_tried`. This preserves the intended "re-select a
// thin-flagged doc ONCE so a fresh re-OCR/re-analysis attempt can heal it" behavior while guaranteeing
// every row reaches a terminal (non-reselected) state after that one attempt, closing the loop.
import { test } from "node:test";
import assert from "node:assert/strict";
import { selectTodo, unresolved, REOCR_RE } from "../skills/doc-indexer/deep-pass.mjs";

test("REOCR_RE: sanity -- matches the exact flag text the model emits, and 're-OCR' spelling variants", () => {
  assert.equal(REOCR_RE.test("text too thin to trust"), true);
  assert.equal(REOCR_RE.test("needs re-OCR"), true);
  assert.equal(REOCR_RE.test("needs reOCR"), true);
  assert.equal(REOCR_RE.test("no title extracted"), false);
});

test("selectTodo: a never-processed row (no `deep` field) is selected", () => {
  const rows = [{ path: "legal/foo.pdf" }];
  const todo = selectTodo(rows, {});
  assert.equal(todo.length, 1);
});

test("selectTodo: a fully-deep, cleanly-resolved row (no review flags) is NOT reselected", () => {
  const rows = [{ path: "legal/foo.pdf", deep: true, review: "", review_reasons: [] }];
  assert.equal(selectTodo(rows, {}).length, 0);
});

test("selectTodo: a row terminally classified non_text_asset is NOT reselected, even with stale thin flags", () => {
  const rows = [{ path: "legal/audio.mp3", deep: true, non_text_asset: true, reocr: false, reocr_tried: true, review_reasons: [] }];
  assert.equal(selectTodo(rows, {}).length, 0);
});

test("selectTodo: a row healed by re-OCR (reocr:true) is NOT reselected, even if it still carries a stale thin flag", () => {
  const rows = [{ path: "legal/scan.pdf", deep: true, non_text_asset: false, reocr: true, reocr_tried: true, review_reasons: ["text too thin to trust"] }];
  assert.equal(selectTodo(rows, {}).length, 0);
});

test("selectTodo: a thin-flagged row given its ONE retry (reocr_tried not yet set) IS selected once", () => {
  // Simulates a legacy catalog row from before reocr_tried existed, or a row whose very first analyze()
  // pass flagged it thin. It must get exactly one more shot at resolution.
  const rows = [{ path: "legal/garbled.pdf", deep: true, non_text_asset: false, reocr: false, review_reasons: ["text too thin to trust"] }];
  assert.equal(selectTodo(rows, {}).length, 1);
});

test("THE REGRESSION: a row whose text cleared the alnum>=60 threshold (re-OCR never applicable) but was "
  + "still flagged thin by the model, and has already been given its one retry (reocr_tried:true), "
  + "must NOT appear in todo on a second selection pass -- this is the exact loop that was closing "
  + "the same ~535 documents forever", () => {
  // First pass: fresh row, gets selected and (per the fixed analyze()) processed.
  const rows = [{ path: "legal/persistently-thin.pdf" }];
  assert.equal(selectTodo(rows, {}).length, 1, "pass 1: fresh row must be selected");

  // Simulate exactly what the FIXED analyze()/worker() now writes back onto the row after a completed
  // pass where the model still flagged it thin, text never cleared the DI re-OCR threshold (reocr
  // stays false), and it is a real text doc (not non_text_asset). This is the state that used to loop.
  Object.assign(rows[0], {
    deep: true,
    non_text_asset: false,
    reocr: false,
    reocr_tried: true, // <-- the fix: set unconditionally once analyze() completes a full pass
    confidence: "low",
    review: "NEEDS_CLAUDE_REVIEW",
    review_reasons: ["text too thin to trust"],
  });

  // Second pass: MUST be excluded now that it has had its one resolution attempt.
  const todoPass2 = selectTodo(rows, {});
  assert.equal(todoPass2.length, 0, "pass 2: a row already given its one retry must not be reselected");

  // Third pass (proves it stays terminal, not just excluded once): identical outcome, still excluded.
  const todoPass3 = selectTodo(rows, {});
  assert.equal(todoPass3.length, 0, "pass 3: terminal state must persist indefinitely");
});

test("PRE-FIX SANITY CHECK: reproduces the bug against the OLD unresolved() semantics (reocr_tried unchecked), "
  + "proving the loop was real and not hypothetical", () => {
  const REOCR_RE_OLD = /thin|re-?OCR/i;
  const unresolvedOld = (r) => (r.review_reasons || []).some((x) => REOCR_RE_OLD.test(x)) && !r.non_text_asset && !r.reocr;
  const selectTodoOld = (rows) => rows.filter((r) => r.path && !r.path.startsWith("_") && (!r.deep || unresolvedOld(r)));

  const row = { path: "legal/persistently-thin.pdf", deep: true, non_text_asset: false, reocr: false, reocr_tried: true, review_reasons: ["text too thin to trust"] };
  // Under the OLD (buggy) logic this row is selected AGAIN despite already being fully deep-processed
  // and already having reocr_tried:true -- exactly the runaway loop.
  assert.equal(selectTodoOld([row]).length, 1, "old logic: incorrectly reselects a terminally-thin doc forever");
  // The FIXED logic (imported from the real module) correctly excludes it.
  assert.equal(selectTodo([row], {}).length, 0, "new logic: correctly terminal");
});

test("selectTodo: REINDEX/reindex:true forces every row back into todo regardless of terminal state", () => {
  const rows = [
    { path: "legal/a.pdf", deep: true, review_reasons: [] },
    { path: "legal/b.pdf", deep: true, non_text_asset: true, reocr_tried: true, review_reasons: [] },
  ];
  assert.equal(selectTodo(rows, { reindex: true }).length, 2);
});

test("selectTodo: prefix and limit filters still apply on top of the terminal-state gate", () => {
  const rows = [
    { path: "legal/company/a.pdf" },
    { path: "legal/personal/b.pdf" },
    { path: "legal/company/c.pdf" },
  ];
  const todo = selectTodo(rows, { prefix: "legal/company/" });
  assert.deepEqual(todo.map((r) => r.path), ["legal/company/a.pdf", "legal/company/c.pdf"]);
  assert.equal(selectTodo(rows, { limit: 1 }).length, 1);
});

test("selectTodo: underscore-prefixed catalog metadata paths (e.g. _TEXT/, _CATALOG/) are never selected", () => {
  const rows = [{ path: "_TEXT/foo.pdf.txt" }, { path: "_CATALOG/catalog.jsonl" }];
  assert.equal(selectTodo(rows, {}).length, 0);
});

test("selectTodo: a row with no `path` is never selected", () => {
  const rows = [{ deep: false }];
  assert.equal(selectTodo(rows, {}).length, 0);
});
