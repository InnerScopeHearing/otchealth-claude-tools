// Tests for kb-memory/blobwrite.mjs, the pure optimistic-concurrency helpers behind the ledger
// ETag write fix (red-team HIGH 2026-07-01: two engines could silently clobber each other's appends).
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseNdjson, serializeNdjson, nextId, isConflict, condHeaders } from "../skills/kb-memory/blobwrite.mjs";

test("parseNdjson round-trips and skips blank/corrupt lines", () => {
  const rows = [{ id: "a", x: 1 }, { id: "b", y: 2 }];
  const text = serializeNdjson(rows);
  assert.equal(parseNdjson(text).length, 2);
  assert.deepEqual(parseNdjson(text + "\n{bad json}\n\n"), rows);
  assert.deepEqual(parseNdjson(""), []);
  assert.deepEqual(parseNdjson(null), []);
});

test("serializeNdjson emits one JSON object per line with a trailing newline", () => {
  const out = serializeNdjson([{ a: 1 }, { b: 2 }]);
  assert.equal(out, '{"a":1}\n{"b":2}\n');
});

test("nextId keeps the YYYYMMDD prefix + monotonic counter and startsWith the date", () => {
  const now = new Date("2026-07-01T12:00:00Z");
  const id0 = nextId([], now, () => "abcd");
  assert.equal(id0, "20260701-001-abcd");
  assert.ok(id0.startsWith("20260701"));
  const rows = [{ id: "20260701-001-xxxx" }, { id: "20260701-002-yyyy" }];
  assert.equal(nextId(rows, now, () => "zzzz"), "20260701-003-zzzz");
});

test("nextId is collision-resistant: two mints from the same stale snapshot differ (salt)", () => {
  const now = new Date("2026-07-01T12:00:00Z");
  const rows = [{ id: "20260701-001-aaaa" }];
  const a = nextId(rows, now); // real random salt
  const b = nextId(rows, now);
  assert.notEqual(a, b, "the random suffix must make same-snapshot ids unique");
  assert.ok(a.startsWith("20260701-002-") && b.startsWith("20260701-002-"));
});

test("isConflict flags precondition-failed / conflict, not success", () => {
  assert.ok(isConflict(412));
  assert.ok(isConflict(409));
  assert.ok(!isConflict(200));
  assert.ok(!isConflict(404));
  assert.ok(!isConflict(500));
});

test("condHeaders requires the blob UNCHANGED when we hold an etag, else create-only", () => {
  assert.deepEqual(condHeaders('"0x8DABC"'), { "If-Match": '"0x8DABC"' });
  assert.deepEqual(condHeaders(null), { "If-None-Match": "*" });
  assert.deepEqual(condHeaders(undefined), { "If-None-Match": "*" });
});

test("simulated conflict-then-retry never loses a concurrent writer's row", () => {
  // Model the commitAppend loop purely: writer B commits between A's read and A's write, so A's first
  // PUT is a 412; on reload A re-appends onto B's row (both survive) and the ids do not collide.
  let blob = serializeNdjson([{ id: "20260701-001-seed", text: "seed" }]);
  const now = new Date("2026-07-01T12:00:00Z");
  // A reads
  let aRows = parseNdjson(blob);
  // B commits first
  const bRows = parseNdjson(blob);
  bRows.push({ id: nextId(bRows, now), type: "fact", text: "from B" });
  blob = serializeNdjson(bRows);
  // A's conditional PUT would 412 (blob changed) -> A reloads and reapplies
  aRows = parseNdjson(blob);
  aRows.push({ id: nextId(aRows, now), type: "fact", text: "from A" });
  blob = serializeNdjson(aRows);
  const final = parseNdjson(blob);
  assert.equal(final.length, 3, "seed + B + A all present, nothing clobbered");
  assert.ok(final.some((r) => r.text === "from B") && final.some((r) => r.text === "from A"));
  assert.equal(new Set(final.map((r) => r.id)).size, 3, "all ids unique");
});
