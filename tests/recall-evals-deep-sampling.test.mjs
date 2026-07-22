// Unit tests for run-deep-evals.mjs's PURE subset-selection helper (sampleEvenly). No IO: importing
// this module must not mint a gateway token or hit the network (isMain guard keeps main() from
// running under `node --test`, mirroring every other CLI script in this skill).
import { test } from "node:test";
import assert from "node:assert/strict";
import { sampleEvenly } from "../skills/recall-evals/run-deep-evals.mjs";

test("sampleEvenly: limit >= items.length returns the whole list unchanged", () => {
  const items = [1, 2, 3];
  assert.deepEqual(sampleEvenly(items, 10), [1, 2, 3]);
  assert.deepEqual(sampleEvenly(items, 3), [1, 2, 3]);
});
test("sampleEvenly: a limit smaller than the list picks evenly-spaced indices, including the first item", () => {
  const items = Array.from({ length: 10 }, (_, i) => i); // [0..9]
  const picked = sampleEvenly(items, 5);
  assert.equal(picked.length, 5);
  assert.equal(picked[0], 0); // always includes the first item
  // strictly increasing (spread across the list, not clustered at the front)
  for (let i = 1; i < picked.length; i++) assert.ok(picked[i] > picked[i - 1]);
});
test("sampleEvenly: deterministic -- calling it twice on the same input gives the identical subset", () => {
  const items = Array.from({ length: 44 }, (_, i) => `q-${i}`);
  const a = sampleEvenly(items, 15);
  const b = sampleEvenly(items, 15);
  assert.deepEqual(a, b);
});
test("sampleEvenly: limit of 1 returns exactly one item (the first)", () => {
  const items = ["a", "b", "c", "d"];
  assert.deepEqual(sampleEvenly(items, 1), ["a"]);
});
test("sampleEvenly: limit <= 0 returns an empty array, never throws", () => {
  assert.deepEqual(sampleEvenly(["a", "b"], 0), []);
  assert.deepEqual(sampleEvenly(["a", "b"], -5), []);
});
test("sampleEvenly: empty/non-array input -> empty output, never throws", () => {
  assert.deepEqual(sampleEvenly([], 5), []);
  assert.deepEqual(sampleEvenly(undefined, 5), []);
  assert.deepEqual(sampleEvenly(null, 5), []);
});
test("sampleEvenly: never returns more items than requested even with dedupe on a tiny list", () => {
  const items = ["a", "b"];
  const picked = sampleEvenly(items, 2);
  assert.ok(picked.length <= 2);
});
test("sampleEvenly: on a realistic 44-item golden set, a limit of 15 spans indices from near-start to near-end", () => {
  const items = Array.from({ length: 44 }, (_, i) => i);
  const picked = sampleEvenly(items, 15);
  assert.equal(picked.length, 15);
  assert.equal(picked[0], 0);
  assert.ok(picked[picked.length - 1] >= 40, "the subset should reach near the end of the file, not cluster at the front");
});
