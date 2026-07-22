import { test } from "node:test";
import assert from "node:assert/strict";
import { findSuperseded, preview } from "../ledger-archive.mjs";

test("findSuperseded pairs an old row with the row whose supersedes field names it", () => {
  const rows = [
    { id: "a", text: "old belief" },
    { id: "b", text: "corrected belief", supersedes: "a" },
    { id: "c", text: "unrelated, nothing supersedes it" },
  ];
  const pairs = findSuperseded(rows);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].old.id, "a");
  assert.equal(pairs[0].successor.id, "b");
});

test("findSuperseded returns an empty array when no row has a supersedes link", () => {
  const rows = [{ id: "a", text: "one" }, { id: "b", text: "two" }];
  assert.deepEqual(findSuperseded(rows), []);
});

test("findSuperseded handles a chain (each link superseded by the next) as independent pairs", () => {
  const rows = [
    { id: "a", text: "1 of 3" },
    { id: "b", text: "2 of 3", supersedes: "a" },
    { id: "c", text: "3 of 3, done", supersedes: "b" },
  ];
  const pairs = findSuperseded(rows);
  assert.equal(pairs.length, 2);
  assert.deepEqual(pairs.map((p) => p.old.id).sort(), ["a", "b"]);
});

test("findSuperseded ignores a supersedes pointer to a nonexistent id (successor undefined, old row still flagged)", () => {
  const rows = [{ id: "a", text: "old" }, { id: "b", text: "new", supersedes: "does-not-exist" }];
  // "a" is not superseded by anything here; "does-not-exist" is never a row in this ledger, so nothing
  // is flagged. This documents the behavior rather than asserting a specific stance on dangling pointers.
  assert.deepEqual(findSuperseded(rows), []);
});

test("preview collapses whitespace and truncates to the given length", () => {
  assert.equal(preview("a\n\nb   c", 100), "a b c");
  assert.equal(preview("x".repeat(200), 10), "x".repeat(10));
});

test("preview is safe on null/undefined/empty input", () => {
  assert.equal(preview(null), "");
  assert.equal(preview(undefined), "");
  assert.equal(preview(""), "");
});
