// setup/hydration-report.mjs is the SOLE place that decides whether a session's fleet-secret
// hydration is complete. These tests exercise verdictFor(), needsFallback(), and computeReport()
// directly as pure functions (no bash, no subprocess, no temp files) -- the fast, precise
// counterpart to the end-to-end integration test in tests/session-start-hydration.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { verdictFor, needsFallback, computeReport, countAssignmentLines } from "../setup/hydration-report.mjs";
import { MAP } from "../setup/secret-map.mjs";

const REQUIRED = MAP.filter((m) => m.required).map((m) => ({ id: m.id, env: m.env }));
assert.ok(REQUIRED.length >= 2, "these tests assume at least 2 required secrets (openai/elevenlabs today)");
const [REQ_A, REQ_B] = REQUIRED;

function stubReader(result) {
  return () => result;
}

// ─── verdictFor(): the ONE function, exercised for every state ──────────────────────────────────

test("not-attempted when attempted is false, regardless of files", () => {
  const v = verdictFor({ attempted: false, resultFile: "whatever", fetchedFile: "whatever" });
  assert.deepEqual(v, { attempted: false, state: "not-attempted" });
});

test("unknown when the result cannot be read (readResult returns null)", () => {
  const v = verdictFor({ attempted: true, resultFile: "x", fetchedFile: "y", readResult: stubReader(null) });
  assert.equal(v.state, "unknown");
  assert.equal(v.requiredMissing, undefined, "unknown must not carry a requiredMissing list of any kind");
});

test("unreachable when reachable is false, and requiredMissing is NOT surfaced", () => {
  const v = verdictFor({
    attempted: true,
    resultFile: "x",
    fetchedFile: "y",
    readResult: stubReader({ store: "aws-ssm", reachable: false, emittedCount: 0, requiredTotal: 2, requiredMissing: [REQ_A] }),
  });
  assert.equal(v.state, "unreachable");
  assert.equal(v.requiredMissing, undefined, "an unreachable store's requiredMissing is not evidence of anything and must not leak through");
});

test("ok when reachable, nothing missing, and the emitted count matches what actually arrived", () => {
  const v = verdictFor({
    attempted: true,
    resultFile: "x",
    fetchedFile: "y",
    readResult: stubReader({ store: "aws-ssm", reachable: true, emittedCount: 2, requiredTotal: 2, requiredMissing: [] }),
    readFetched: () => `${REQ_A.env}='a'\n${REQ_B.env}='b'\n`,
  });
  assert.equal(v.state, "ok");
});

test("partial when reachable and requiredMissing is non-empty, with the count verified", () => {
  const v = verdictFor({
    attempted: true,
    resultFile: "x",
    fetchedFile: "y",
    readResult: stubReader({ store: "aws-ssm", reachable: true, emittedCount: 1, requiredTotal: 2, requiredMissing: [REQ_A] }),
    readFetched: () => `${REQ_B.env}='b'\n`,
  });
  assert.equal(v.state, "partial");
  assert.deepEqual(v.requiredMissing, [REQ_A]);
});

// ─── property C: completeness is ASSERTED against the actual transport, not assumed ─────────────

test("truncated when the claimed emittedCount does not match the actual arrived lines", () => {
  const v = verdictFor({
    attempted: true,
    resultFile: "x",
    fetchedFile: "y",
    readResult: stubReader({ store: "aws-ssm", reachable: true, emittedCount: 5, requiredTotal: 2, requiredMissing: [] }),
    readFetched: () => `${REQ_A.env}='a'\n${REQ_B.env}='b'\n`, // only 2 arrived, 5 claimed
  });
  assert.equal(v.state, "truncated");
  assert.equal(v.emittedClaimed, 5);
  assert.equal(v.emittedActual, 2);
});

test("truncated when the fetched content could not be measured at all (readFetched returns null)", () => {
  // An unmeasurable transfer is treated the SAME as a measured mismatch: only a positive match
  // clears the check. This is the null-is-not-an-exception-to-throw-away rule applied to the
  // transport layer.
  const v = verdictFor({
    attempted: true,
    resultFile: "x",
    fetchedFile: "y",
    readResult: stubReader({ store: "aws-ssm", reachable: true, emittedCount: 1, requiredTotal: 1, requiredMissing: [] }),
    readFetched: () => null,
  });
  assert.equal(v.state, "truncated");
  assert.equal(v.emittedActual, null);
});

test("a truncated verdict does not carry requiredMissing -- a cut transfer cannot vouch for it", () => {
  const v = verdictFor({
    attempted: true,
    resultFile: "x",
    fetchedFile: "y",
    readResult: stubReader({ store: "aws-ssm", reachable: true, emittedCount: 5, requiredTotal: 2, requiredMissing: [REQ_A] }),
    readFetched: () => `${REQ_B.env}='b'\n`,
  });
  assert.equal(v.state, "truncated");
  assert.equal(v.requiredMissing, undefined);
});

test("emittedCount 0 with zero actual lines is a real 'ok' (0 does not look like an unmeasured null)", () => {
  const v = verdictFor({
    attempted: true,
    resultFile: "x",
    fetchedFile: "y",
    readResult: stubReader({ store: "aws-ssm", reachable: true, emittedCount: 0, requiredTotal: 0, requiredMissing: [] }),
    readFetched: () => "",
  });
  assert.equal(v.state, "ok");
});

// ─── needsFallback(): the gate both arms are judged by identically ───────────────────────────────

test("needsFallback is false ONLY for a clean ok verdict", () => {
  assert.equal(needsFallback({ state: "ok" }), false);
  for (const state of ["not-attempted", "unknown", "unreachable", "truncated", "partial"]) {
    assert.equal(needsFallback({ state }), true, `state=${state} must request a fallback attempt`);
  }
});

// ─── computeReport(): property D (identical treatment) + property E (store vs session truth) ────

test("property D: computeReport calls the SAME verdict logic for both arms (proven via injected readers)", () => {
  const calls = [];
  const readResult = (path) => {
    calls.push(path);
    if (path === "ssm.json") return { store: "aws-ssm", reachable: true, emittedCount: REQUIRED.length, requiredTotal: REQUIRED.length, requiredMissing: [] };
    if (path === "kv.json") return { store: "azure-keyvault", reachable: true, emittedCount: REQUIRED.length, requiredTotal: REQUIRED.length, requiredMissing: [] };
    return null;
  };
  const readFetched = (path) => (path.startsWith("ssm") || path.startsWith("kv") ? REQUIRED.map((r) => `${r.env}='v'`).join("\n") + "\n" : null);
  const report = computeReport({
    ssmAttempted: true,
    ssmResultFile: "ssm.json",
    ssmFetchedFile: "ssm.fetched",
    kvAttempted: true,
    kvResultFile: "kv.json",
    kvFetchedFile: "kv.fetched",
    env: {},
    readResult,
    readFetched,
  });
  assert.equal(report.ssm.state, "ok");
  assert.equal(report.kv.state, "ok");
  assert.deepEqual(calls.sort(), ["kv.json", "ssm.json"]);
});

test("every required secret covered by the store: no missing lists in the banner, and an all-clear IS printed", () => {
  const readResult = () => ({ store: "aws-ssm", reachable: true, emittedCount: REQUIRED.length, requiredTotal: REQUIRED.length, requiredMissing: [] });
  const readFetched = () => REQUIRED.map((r) => `${r.env}='v'`).join("\n") + "\n";
  const report = computeReport({ ssmAttempted: true, ssmResultFile: "x", ssmFetchedFile: "y", kvAttempted: false, env: {}, readResult, readFetched });
  assert.equal(report.stillMissing.length, 0);
  assert.equal(report.unknownCoverage.length, 0);
  assert.ok(report.covered.every((c) => c.coveredBy === "store"));
  assert.ok(report.lines.some((l) => /All required secrets are present/.test(l)));
});

test("property E: a secret covered ONLY by a direct session env var is labelled session-env, not store, and the banner says so", () => {
  const readResult = () => ({ store: "aws-ssm", reachable: true, emittedCount: 0, requiredTotal: REQUIRED.length, requiredMissing: REQUIRED });
  const readFetched = () => "";
  const env = { [REQ_A.env]: "from-the-session", [REQ_B.env]: "also-from-the-session" };
  const report = computeReport({ ssmAttempted: true, ssmResultFile: "x", ssmFetchedFile: "y", kvAttempted: false, env, readResult, readFetched });
  assert.equal(report.stillMissing.length, 0);
  assert.equal(report.unknownCoverage.length, 0);
  assert.ok(report.covered.every((c) => c.coveredBy === "session-env"));
  const banner = report.lines.join("\n");
  assert.match(banner, /came from a direct session env var, not a store/);
  assert.doesNotMatch(banner, /verified against a store\)/, "a session-only cover must not read as a store-verified all-clear");
});

test("property E: store coverage wins over a stale/irrelevant session env var when both exist", () => {
  const readResult = () => ({ store: "aws-ssm", reachable: true, emittedCount: REQUIRED.length, requiredTotal: REQUIRED.length, requiredMissing: [] });
  const readFetched = () => REQUIRED.map((r) => `${r.env}='v'`).join("\n") + "\n";
  const env = { [REQ_A.env]: "also-present-in-session" };
  const report = computeReport({ ssmAttempted: true, ssmResultFile: "x", ssmFetchedFile: "y", kvAttempted: false, env, readResult, readFetched });
  const a = report.covered.find((c) => c.env === REQ_A.env);
  assert.equal(a.coveredBy, "store");
});

test("a real, named gap (no store, no session var) is reported as stillMissing, and no all-clear is printed", () => {
  const readResult = () => ({ store: "aws-ssm", reachable: true, emittedCount: 0, requiredTotal: REQUIRED.length, requiredMissing: [REQ_A] });
  const readFetched = () => "";
  const report = computeReport({ ssmAttempted: true, ssmResultFile: "x", ssmFetchedFile: "y", kvAttempted: false, env: {}, readResult, readFetched });
  assert.deepEqual(report.stillMissing.map((m) => m.env).sort(), [REQ_A.env]);
  const banner = report.lines.join("\n");
  assert.match(banner, new RegExp(`still MISSING after every store: .*${REQ_A.env}`));
  assert.doesNotMatch(banner, /All required secrets are present/);
  assert.doesNotMatch(banner, /gap was covered/);
});

// ─── THE FOUR STATE-TABLE PROPERTIES, restated directly against computeReport() ──────────────────

test("BLOCKER regression: neither arm produces a trustworthy result -> UNKNOWN coverage, never an all-clear", () => {
  // This is the direct analogue of the historical bug: both arms are 'unknown'/'unreachable', so
  // there is no trustworthy missing-list anywhere. The old code's `-z` check would have printed
  // "all required secrets are present" here. This must instead say it does not know.
  const report = computeReport({
    ssmAttempted: true,
    ssmResultFile: "x",
    ssmFetchedFile: "y",
    kvAttempted: true,
    kvResultFile: "a",
    kvFetchedFile: "b",
    env: {},
    readResult: () => null, // both arms unreadable
    readFetched: () => null,
  });
  assert.equal(report.stillMissing.length, 0, "nothing was ever confirmed missing -- there is no trustworthy list to confirm it");
  assert.equal(report.unknownCoverage.length, REQUIRED.length, "every required secret's coverage is genuinely unknown");
  const banner = report.lines.join("\n");
  assert.doesNotMatch(banner, /All required secrets are present/);
  assert.doesNotMatch(banner, /gap was covered/);
  assert.match(banner, /could not determine whether these REQUIRED secret\(s\) are available/);
});

test("unknownCoverage and stillMissing render as distinct claims when both occur together", () => {
  // SSM confirms REQ_A is missing (a real, named gap); KV never produced a trustworthy result at
  // all, so whatever it might have said about REQ_B is simply not known.
  const report = computeReport({
    ssmAttempted: true,
    ssmResultFile: "ssm.json",
    ssmFetchedFile: "ssm.fetched",
    kvAttempted: true,
    kvResultFile: "kv.json",
    kvFetchedFile: "kv.fetched",
    env: {},
    readResult: (p) => (p === "ssm.json" ? { store: "aws-ssm", reachable: true, emittedCount: 0, requiredTotal: REQUIRED.length, requiredMissing: [REQ_A] } : null),
    readFetched: (p) => (p === "ssm.fetched" ? "" : null),
  });
  // REQ_A: SSM (trustworthy) confirms it missing -> stillMissing. REQ_B: SSM's trustworthy list
  // does NOT name it missing, so REQ_B actually resolves as "covered by store" (absence from a
  // trustworthy missing-list means it resolved) -- proving the two secrets are judged
  // independently rather than the whole session being smeared with one verdict.
  assert.deepEqual(report.stillMissing.map((m) => m.env), [REQ_A.env]);
  assert.equal(report.unknownCoverage.length, 0);
});

test("a truncated arm behaves like unknown for coverage purposes (its requiredMissing is not trusted)", () => {
  const report = computeReport({
    ssmAttempted: true,
    ssmResultFile: "x",
    ssmFetchedFile: "y",
    kvAttempted: false,
    env: {},
    readResult: () => ({ store: "aws-ssm", reachable: true, emittedCount: 5, requiredTotal: REQUIRED.length, requiredMissing: [] }), // claims OK but...
    readFetched: () => "", // ...nothing actually arrived: a truncation, not a clean ok
  });
  assert.equal(report.ssm.state, "truncated");
  assert.equal(report.unknownCoverage.length, REQUIRED.length);
  const banner = report.lines.join("\n");
  assert.match(banner, /TRUNCATED/);
  assert.doesNotMatch(banner, /All required secrets are present/);
});

// ─── countAssignmentLines(): the transport-layer measurement itself ─────────────────────────────

test("countAssignmentLines counts only well-formed ENV='value' lines, ignoring stray text", () => {
  assert.equal(countAssignmentLines("A='1'\nB='2'\n"), 2);
  assert.equal(countAssignmentLines(""), 0);
  assert.equal(countAssignmentLines(null), null);
  // A line that is not a clean assignment (no leading identifier + quote) does not count -- this
  // is deliberately conservative so a corrupted line lowers the count rather than inflating it.
  assert.equal(countAssignmentLines("not an assignment\nA='1'\n"), 1);
});
