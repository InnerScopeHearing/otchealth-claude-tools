// Tests for fleet-telemetry/result-guard.mjs, the pure oversized-tool-result clamp.
import { test } from "node:test";
import assert from "node:assert/strict";
import { guardResult, guardResultFields, DEFAULT_MAX } from "../skills/fleet-telemetry/result-guard.mjs";

test("short text passes through untouched", () => {
  const r = guardResult("hello world");
  assert.equal(r.truncated, false);
  assert.equal(r.text, "hello world");
});

test("oversized text is truncated with a marker and kept under budget", () => {
  const big = "H".repeat(1000) + "M".repeat(60000) + "T".repeat(1000);
  const r = guardResult(big, { max: 5000 });
  assert.equal(r.truncated, true);
  assert.ok(r.text.length <= 5000);
  assert.match(r.text, /result-guard: truncated/);
  assert.equal(r.originalLen, big.length);
});

test("head and tail are both preserved", () => {
  const big = "HEAD_MARKER" + "x".repeat(60000) + "TAIL_MARKER";
  const r = guardResult(big, { max: 4000 });
  assert.ok(r.text.startsWith("HEAD_MARKER"));
  assert.ok(r.text.endsWith("TAIL_MARKER"));
});

test("default max applies when unspecified", () => {
  const big = "z".repeat(DEFAULT_MAX + 5000);
  assert.equal(guardResult(big).truncated, true);
});

test("guardResultFields guards only string fields and reports truncation", () => {
  const obj = { note: "y".repeat(30000), count: 42, keep: "small" };
  const { value, truncated } = guardResultFields(obj, { max: 3000 });
  assert.equal(truncated, true);
  assert.ok(value.note.length <= 3000);
  assert.equal(value.count, 42);
  assert.equal(value.keep, "small");
});

test("guardResultFields with fields[] only touches listed keys", () => {
  const obj = { a: "y".repeat(30000), b: "y".repeat(30000) };
  const { value } = guardResultFields(obj, { max: 3000, fields: ["a"] });
  assert.ok(value.a.length <= 3000);
  assert.equal(value.b.length, 30000);
});

test("null/undefined are handled without throwing", () => {
  assert.equal(guardResult(null).text, "");
  assert.equal(guardResult(undefined).truncated, false);
});
