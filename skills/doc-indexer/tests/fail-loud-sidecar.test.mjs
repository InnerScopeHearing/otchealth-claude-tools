// Regression lock for a real fail-open bug found while fixing the CFO write-lock outage
// (2026-08-18): runIndex()'s per-document _TEXT sidecar write used to be wrapped in a bare
// `catch {}` -- an empty catch. A sidecar PUT failure (the exact class of failure this whole fix
// exists to close) vanished with no trace: no row.err on the catalog entry, no failure counter, and
// the run's own final "[index] done" line and exit code 0 looked completely clean. This is the same
// silent-swallow SHAPE the task's own brief calls out by name in skills/ledger-compaction ("Fail-
// open: exiting 0, nothing compacted this run") -- found here independently, in code this fix
// already had to touch (putBuf), and fixed the same way: record it, count it, and make the run-level
// exit code reflect that something failed.
//
// A live, credential-dependent, timing-sensitive reproduction of "the sidecar PUT specifically
// fails while the surrounding getBuf/extract succeed" is not practical to force hermetically without
// network mocking indexer.mjs does not currently support (it makes real fetch calls, unlike
// s3-blob.mjs which is stub-friendly). This file locks the fix at the source level instead -- the
// same convention skills/kb-memory/tests/s3-blob-write-path.test.mjs already uses for its own
// "counterfactual guards" section (pinning that mem.mjs/semantic.mjs never regress to a bare
// `if (!r.ok) break;`).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const INDEXER_MJS = join(dirname(fileURLToPath(import.meta.url)), "..", "indexer.mjs");

function sidecarWriteBlock(src) {
  const anchor = "row.sidecar = true";
  const idx = src.indexOf(anchor);
  assert.ok(idx > -1, "the sidecar-write line must still exist in runIndex()");
  // The relevant statement is one line (`if (!NO_TEXT ... ) { try {...} catch (se) {...} }`) --
  // grab a window around the anchor rather than trying to balance braces across this file's
  // deliberately dense single-line style.
  return src.slice(Math.max(0, idx - 400), idx + 400);
}

test("the sidecar text-write no longer has a bare empty catch -- a failure is recorded on the row, not silently discarded", () => {
  const block = sidecarWriteBlock(readFileSync(INDEXER_MJS, "utf8"));
  assert.doesNotMatch(block, /catch\s*\{\s*\}/, "must not regress to an empty catch block around the sidecar putBuf call");
  assert.match(block, /catch \(se\)/, "the sidecar catch must bind the error so it can be recorded, not just swallowed anonymously");
  assert.match(block, /row\.err\s*=.*sidecar put failed/, "a sidecar write failure must be written onto the catalog row's err field");
});

test("a sidecar write failure increments a counter that the run checks before declaring success", () => {
  const src = readFileSync(INDEXER_MJS, "utf8");
  const runIndexStart = src.indexOf("async function runIndex()");
  assert.ok(runIndexStart > -1);
  const runIndexBody = src.slice(runIndexStart, src.indexOf("\nasync function runSearch", runIndexStart));
  assert.match(runIndexBody, /let n = 0, since = 0, sidecarFailures = 0;/, "runIndex must declare a sidecarFailures counter");
  assert.match(runIndexBody, /sidecarFailures\+\+/, "the sidecar catch block must increment it");
  assert.match(runIndexBody, /if \(sidecarFailures > 0\) \{/, "the run must check the counter after the loop");
  assert.match(runIndexBody, /if \(sidecarFailures > 0\) \{[\s\S]*?process\.exit\(1\);/, "a nonzero sidecarFailures count must exit the process non-zero -- the whole point of the fix");
});

test("the fix does not regress into aborting the ENTIRE batch on the first sidecar failure -- the failing catch is scoped to one document, not the whole todo loop", () => {
  const src = readFileSync(INDEXER_MJS, "utf8");
  const block = sidecarWriteBlock(src);
  // The try/catch wraps only the putBuf call (and the row.sidecar assignment), not the surrounding
  // `for (const o of todo)` loop -- i.e. there is no `break`/`return` inside this specific catch,
  // only bookkeeping. Processing continues to the next document; only the run's FINAL exit code
  // reflects the failure.
  assert.doesNotMatch(block, /catch \(se\) \{[^}]*\b(break|return)\b/, "the per-document sidecar catch must not abort the loop or return early -- only record + count + continue");
});
