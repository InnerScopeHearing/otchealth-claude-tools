import { test } from "node:test";
import assert from "node:assert/strict";
import { digestQueryOk } from "../skills/daily-digest/digest.mjs";

// The 2026-07-14 silent-partial-failure fix: a FAILED GitHub query must be distinguishable from a
// genuinely quiet day. Before, gh-app.mjs failing ("Missing JWT issuer") -> ghGraphql returns null
// -> 0 PRs -> the digest wrote "No merged PRs" and exited 0, journaling "nothing shipped" on a day
// 5 PRs actually merged. digestQueryOk() is the gate: false => fail-loud (exit 4) unless --allow-degraded.

test("null (gh-app shell-out threw, e.g. Missing JWT issuer) is a FAILURE, not a quiet day", () => {
  assert.equal(digestQueryOk(null), false);
});

test("a GraphQL error payload with no data.search is a FAILURE", () => {
  assert.equal(digestQueryOk({ message: "Bad credentials" }), false);
  assert.equal(digestQueryOk({ errors: [{ message: "Something went wrong" }] }), false);
  assert.equal(digestQueryOk({ data: {} }), false);
  assert.equal(digestQueryOk({ data: { search: {} } }), false, "search present but nodes missing = malformed = failure");
});

test("a successful query with ZERO nodes is a legitimate quiet day (exit 0, not a failure)", () => {
  assert.equal(digestQueryOk({ data: { search: { nodes: [] } } }), true);
});

test("a successful query with merged PRs is ok", () => {
  assert.equal(digestQueryOk({ data: { search: { nodes: [{ number: 1, title: "x", repository: { name: "r" } }] } } }), true);
});
