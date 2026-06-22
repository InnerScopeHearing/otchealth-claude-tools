// Unit tests for the focus-group-loop scoring helpers. The invariant under test is the one that made
// the 90% gate REACHABLE again: a persona whose JSON could not be parsed (tooling noise) is EXCLUDED
// from the average, never counted as a 0 (which silently poisoned the gate). Pure functions, no I/O.
import { test } from "node:test";
import assert from "node:assert/strict";
import { avg, parseFails, parseJson } from "../skills/focus-group-loop/fgl.mjs";

test("avg EXCLUDES a parse-failed persona (never scores it 0) - guards the 90% gate", () => {
  const rows = [{ rating: 9 }, { rating: 9 }, { rating: null, _parse_fail: true }];
  assert.equal(avg(rows), 9, "a parse failure must not drag a 9.0 group down to 6.0");
});

test("avg EXCLUDES an infra-errored persona (Azure 429 throttle), not just unparseable ones", () => {
  // the exact shape runRound's catch now produces when a call throws after retry + fallback. This is
  // what dragged PlantID's gate below 9.0 (9 throttled personas scored 0) while every responder was 9.2+.
  const throttled = { rating: null, _parse_fail: true, _err: "chat 429 exhausted" };
  assert.equal(avg([{ rating: 9 }, { rating: 9 }, throttled]), 9, "a throttled persona must not drag a 9.0 group to 6.0");
  assert.equal(parseFails([{ rating: 9 }, throttled]), 1, "a throttled persona is counted among the excluded");
});

test("avg ignores null ratings even without the _parse_fail flag", () => {
  assert.equal(avg([{ rating: 8 }, { rating: null }]), 8);
});

test("avg of an all-failed group is 0 (no scored personas)", () => {
  assert.equal(avg([{ rating: null, _parse_fail: true }]), 0);
});

test("avg computes the plain mean when every persona scored", () => {
  assert.equal(avg([{ rating: 10 }, { rating: 8 }, { rating: 9 }]), 9);
});

test("parseFails counts only the parse-failed personas", () => {
  assert.equal(parseFails([{ _parse_fail: true }, { rating: 9 }, { _parse_fail: true }]), 2);
  assert.equal(parseFails([{ rating: 9 }]), 0);
});

test("parseJson strips a ```json fence and trailing prose", () => {
  const raw = '```json\n{"rating": 9, "would_pay": true}\n```\nHope that helps!';
  assert.deepEqual(parseJson(raw), { rating: 9, would_pay: true });
});

test("parseJson returns null on unparseable content (so the caller retries/excludes)", () => {
  assert.equal(parseJson("the model returned no JSON at all"), null);
});
