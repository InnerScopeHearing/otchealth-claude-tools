// W1-4: the recall-quality SLO pager. Guards the exit-code policy recall-evals/run-evals.mjs uses to
// turn a hit@K regression past the baseline SLO into a PAGE, mirroring skills/azure-canary/canary.mjs's
// pageExitCode(summaryOk, strict) convention exactly (see tests/azure-canary-freshness.test.mjs for the
// canary's own version of this same guard). Report-mode by default (a low score never fails a run on
// its own); --strict / --enforce / RECALL_EVAL_STRICT=1 turns a real regression into a non-zero exit so
// the nightly workflow goes RED instead of writing to a dashboard nobody watches.
import { test } from "node:test";
import assert from "node:assert/strict";
import { pageExitCode } from "../skills/recall-evals/run-evals.mjs";

test("pageExitCode: strict + regressed pages (exit 1) -- a real recall-quality drop cannot sit silent", () => {
  assert.equal(pageExitCode(true, true), 1);
});

test("pageExitCode: strict + not-regressed does not page (exit 0)", () => {
  assert.equal(pageExitCode(false, true), 0);
});

test("pageExitCode: non-strict (report-mode default) never pages, even on a real regression", () => {
  assert.equal(pageExitCode(true, false), 0);
  assert.equal(pageExitCode(false, false), 0);
});
