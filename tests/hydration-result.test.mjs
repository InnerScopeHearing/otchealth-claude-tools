// setup/hydration-result.mjs is the machine-readable contract that replaced bash re-parsing a
// hydrator's stderr sentence. These tests pin the write/read round trip and, more importantly,
// every way readHydrationResult() must return `null` ("I could not determine") rather than a
// value that could be misread as "nothing was missing".
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeHydrationResult, readHydrationResult, statusOf } from "../setup/hydration-result.mjs";

function tmp() {
  return join(mkdtempSync(join(tmpdir(), "hr-")), "result.json");
}

test("a valid result round-trips byte-for-byte through JSON", () => {
  const path = tmp();
  const r = { store: "aws-ssm", reachable: true, emittedCount: 3, requiredTotal: 2, requiredMissing: [] };
  writeHydrationResult(path, r);
  assert.deepEqual(readHydrationResult(path), r);
  assert.equal(statusOf(readHydrationResult(path)), "ok");
});

test("a named requiredMissing entry survives the round trip and drives 'partial'", () => {
  const path = tmp();
  const r = { store: "aws-ssm", reachable: true, emittedCount: 1, requiredTotal: 2, requiredMissing: [{ id: "openai-api-key", env: "OPENAI_API_KEY" }] };
  writeHydrationResult(path, r);
  const back = readHydrationResult(path);
  assert.deepEqual(back.requiredMissing, r.requiredMissing);
  assert.equal(statusOf(back), "partial");
});

test("reachable:false drives 'unreachable' regardless of requiredMissing content", () => {
  const path = tmp();
  writeHydrationResult(path, { store: "aws-ssm", reachable: false, emittedCount: 0, requiredTotal: 2, requiredMissing: [] });
  assert.equal(statusOf(readHydrationResult(path)), "unreachable");
});

// ─── readHydrationResult() must return null -- never a value that reads as "nothing missing" ────

test("a missing file is UNKNOWN (null), not a clean result", () => {
  assert.equal(readHydrationResult(join(tmpdir(), "definitely-does-not-exist-" + Date.now() + ".json")), null);
});

test("an empty path is UNKNOWN (null)", () => {
  assert.equal(readHydrationResult(""), null);
  assert.equal(readHydrationResult(undefined), null);
});

test("malformed JSON is UNKNOWN (null)", () => {
  const path = tmp();
  writeFileSync(path, "{not json");
  assert.equal(readHydrationResult(path), null);
});

test("valid JSON that is not an object (array, string, number) is UNKNOWN (null)", () => {
  for (const bad of ['[]', '"hello"', "42", "null", "true"]) {
    const path = tmp();
    writeFileSync(path, bad);
    assert.equal(readHydrationResult(path), null, `expected null for ${bad}`);
  }
});

test("a missing/wrong-typed field is UNKNOWN (null)", () => {
  const base = { store: "aws-ssm", reachable: true, emittedCount: 1, requiredTotal: 1, requiredMissing: [] };
  const cases = [
    { ...base, store: undefined },
    { ...base, store: "" },
    { ...base, reachable: "true" }, // string, not boolean
    { ...base, emittedCount: "1" },
    { ...base, emittedCount: -1 },
    { ...base, emittedCount: 1.5 },
    { ...base, requiredTotal: undefined },
    { ...base, requiredMissing: "none" }, // not an array
    { ...base, requiredMissing: undefined },
  ];
  for (const c of cases) {
    const path = tmp();
    writeFileSync(path, JSON.stringify(c));
    assert.equal(readHydrationResult(path), null, `expected null for ${JSON.stringify(c)}`);
  }
});

// ─── THE FOUR HISTORICAL BUGS, reproduced directly against this module's validation ──────────────

test("BUG 1 REGRESSION: an entry with an EMPTY env name is UNKNOWN, not silently admitted", () => {
  // The exact shape of the shipped bug: a sed capture group `([A-Z0-9_]*)` can match zero
  // characters. Here there is no capture group at all -- but if some future producer ever wrote
  // one, the schema validator must refuse the whole result rather than accept a blank env name
  // that a shell `${!env_name}` or `printf -v` could later mishandle.
  const path = tmp();
  writeFileSync(path, JSON.stringify({ store: "aws-ssm", reachable: true, emittedCount: 0, requiredTotal: 1, requiredMissing: [{ id: "openai-api-key", env: "" }] }));
  assert.equal(readHydrationResult(path), null);
});

test("BUG 1b REGRESSION: an entry whose env name is not a complete bash identifier is UNKNOWN", () => {
  // A digit-leading name ("9BAD") is exactly what broke the old sed-based guard (bash's
  // `${!9BAD}` throws 'invalid variable name' and aborted the whole sourced block). Here it simply
  // fails schema validation up front -- there is no expansion downstream that could ever see it.
  for (const badEnv of ["9BAD", "HAS SPACE", "HAS-DASH", "has.dot"]) {
    const path = tmp();
    writeFileSync(path, JSON.stringify({ store: "aws-ssm", reachable: true, emittedCount: 0, requiredTotal: 1, requiredMissing: [{ id: "x", env: badEnv }] }));
    assert.equal(readHydrationResult(path), null, `expected null for env=${badEnv}`);
  }
});

test("BUG 2 REGRESSION: requiredMissing longer than requiredTotal is internally inconsistent -> UNKNOWN", () => {
  // The old code never cross-checked the claimed count against the recovered list at all. Here the
  // count IS the array length by construction, so this specific inconsistency is the one shape
  // that requires an explicit guard: a result that names MORE missing entries than it claims exist
  // in total cannot be a result anyone should trust.
  const path = tmp();
  writeFileSync(path, JSON.stringify({ store: "aws-ssm", reachable: true, emittedCount: 0, requiredTotal: 1, requiredMissing: [{ id: "a", env: "A" }, { id: "b", env: "B" }] }));
  assert.equal(readHydrationResult(path), null);
});

test("a missing entry that is an empty object, null, or missing id is UNKNOWN", () => {
  for (const entry of [{}, null, { env: "A" }, { id: "", env: "A" }]) {
    const path = tmp();
    writeFileSync(path, JSON.stringify({ store: "aws-ssm", reachable: true, emittedCount: 0, requiredTotal: 1, requiredMissing: [entry] }));
    assert.equal(readHydrationResult(path), null, `expected null for entry ${JSON.stringify(entry)}`);
  }
});

test("writeHydrationResult with no path is a silent no-op (optional by design)", () => {
  assert.doesNotThrow(() => writeHydrationResult("", { store: "aws-ssm", reachable: true, emittedCount: 0, requiredTotal: 0, requiredMissing: [] }));
  assert.doesNotThrow(() => writeHydrationResult(undefined, { store: "aws-ssm", reachable: true, emittedCount: 0, requiredTotal: 0, requiredMissing: [] }));
});

test("writeHydrationResult to an unwritable path does not throw (best-effort)", () => {
  assert.doesNotThrow(() => writeHydrationResult("/nonexistent-dir-xyz/deep/path/result.json", { store: "aws-ssm", reachable: true, emittedCount: 0, requiredTotal: 0, requiredMissing: [] }));
});
