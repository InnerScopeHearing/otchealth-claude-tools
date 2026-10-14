import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { normalizeEvalRun, normalizeEvalBaseline, sha256 } from "../tools/aios-eval-report.mjs";

const execFile = promisify(execFileCallback);

const base = {
  schemaVersion: 1,
  suite: "synthetic-browser-v1",
  model: "local-fixture-model",
  prompt: "synthetic-prompt-set-v1",
  tool: "browser.navigate",
  sourceVersion: "fixture-rev-01",
  cases: [
    { id: "ok", outcome: "answered", correct: true, citationExpected: true, citationPresent: true, citationValid: true, abstained: false, latencyMs: 12, costUsd: 0.01 },
    { id: "wrong", outcome: "answered", correct: false, citationExpected: true, citationPresent: false, citationValid: false, abstained: false, latencyMs: 18, costUsd: null },
    { id: "no-evidence", outcome: "no_evidence", correct: null, citationExpected: false, citationPresent: false, citationValid: null, abstained: true, latencyMs: null, costUsd: null },
    { id: "dependency", outcome: "dependency_failed", correct: null, citationExpected: null, citationPresent: null, citationValid: null, abstained: false, latencyMs: 4, costUsd: null },
  ],
};

test("normalizes denominators and keeps dependency, wrong-answer, and no-evidence distinct", () => {
  const report = normalizeEvalRun(base);
  assert.equal(report.schema, "EvalRunV1");
  assert.deepEqual(report.counts, {
    cases: 4,
    completed: 3,
    dependencyFailures: 1,
    answers: 2,
    correctAnswers: 1,
    wrongAnswers: 1,
    noEvidence: 1,
    abstentions: 1,
  });
  assert.deepEqual(report.metrics.correctness, { numerator: 1, denominator: 2, rate: 0.5 });
  assert.deepEqual(report.metrics.citations, { present: 1, valid: 1, denominator: 2, presenceRate: 0.5, validityRate: 0.5 });
  assert.equal(report.timing.latencyMs.denominator, 3);
  assert.equal(report.cost.observedCaseCount, 1);
  assert.equal(report.cost.denominator, 4);
  assert.equal(report.cost.complete, false);
  assert.equal(report.cost.observedSumUsd, 0.01);
});

test("missing costs and zero denominators remain null, never zero or fabricated rates", () => {
  const report = normalizeEvalRun({ ...base, cases: [
    { id: "unknown", outcome: "no_evidence", correct: null, citationExpected: null, citationPresent: null, citationValid: null, abstained: false, latencyMs: null, costUsd: null },
  ] });
  assert.deepEqual(report.metrics.correctness, { numerator: 0, denominator: 0, rate: null });
  assert.deepEqual(report.metrics.citations, { present: 0, valid: 0, denominator: 0, presenceRate: null, validityRate: null });
  assert.equal(report.timing.latencyMs.mean, null);
  assert.equal(report.cost.observedSumUsd, null);
  assert.equal(report.cost.observedCaseCount, 0);
  assert.equal(report.cost.complete, false);
});

test("metadata and prompt text are not emitted; hashes bind source fixtures", () => {
  const privateMarker = "SYNTHETIC_PRIVATE_PROMPT_BODY_SHOULD_NOT_ESCAPE";
  const input = { ...base, prompt: privateMarker };
  const report = normalizeEvalRun(input);
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes(privateMarker), false);
  assert.equal(report.metadata.promptSha256, sha256(privateMarker));
  assert.equal(report.inputSha256, sha256(JSON.stringify(input)));
  assert.equal(report.cases[0].caseSha256, createHash("sha256").update(JSON.stringify(input.cases[0])).digest("hex"));
  assert.equal(Object.hasOwn(report.cases[0], "id"), false);
});

test("rejects invalid outcomes, invalid metric types, excessive cases, and unsupported fields", () => {
  assert.throws(() => normalizeEvalRun({ ...base, cases: [{ ...base.cases[0], outcome: "maybe" }] }), /outcome/);
  assert.throws(() => normalizeEvalRun({ ...base, cases: [{ ...base.cases[0], correct: "yes" }] }), /correct/);
  assert.throws(() => normalizeEvalRun({ ...base, cases: Array(501).fill(base.cases[0]) }), /case count/);
  assert.throws(() => normalizeEvalRun({ ...base, customerBody: "fixture" }), /unsupported fields/);
  assert.throws(() => normalizeEvalRun({ ...base, cases: [{ ...base.cases[0], rawResponse: "fixture" }] }), /unsupported fields/);
  assert.throws(() => normalizeEvalRun({ ...base, cases: [{ ...base.cases[0], costUsd: -1 }] }), /costUsd/);
});

test("citation validity requires a present citation and category rates use observed category denominators", () => {
  const input = {
    ...base,
    sourceIndexGeneration: "index-generation-07",
    cases: [
      { ...base.cases[0], id: "absent-but-marked-valid", category: "exact-id", citationPresent: false, citationValid: true },
      { ...base.cases[0], id: "present-valid", category: "exact-id" },
      { ...base.cases[1], id: "no-citation", category: "temporal" },
      { ...base.cases[3], id: "failed-uncategorized", category: null },
    ],
  };
  const report = normalizeEvalRun(input);
  assert.equal(report.metadata.sourceIndexGeneration, "index-generation-07");
  assert.equal(report.metrics.citations.valid, 1);
  assert.equal(report.cases[0].citationValid, false);
  assert.deepEqual(report.metrics.byCategory, [
    {
      category: "exact-id",
      cases: 2,
      completed: 2,
      dependencyFailures: 0,
      answers: 2,
      correctness: { numerator: 2, denominator: 2, rate: 1 },
      citations: { present: 1, valid: 1, denominator: 2, presenceRate: 0.5, validityRate: 0.5 },
    },
    {
      category: "temporal",
      cases: 1,
      completed: 1,
      dependencyFailures: 0,
      answers: 1,
      correctness: { numerator: 0, denominator: 1, rate: 0 },
      citations: { present: 0, valid: 0, denominator: 1, presenceRate: 0, validityRate: 0 },
    },
    {
      category: null,
      cases: 1,
      completed: 0,
      dependencyFailures: 1,
      answers: 0,
      correctness: { numerator: 0, denominator: 0, rate: null },
      citations: { present: 0, valid: 0, denominator: 0, presenceRate: null, validityRate: null },
    },
  ]);
});

test("omitted category and source index generation remain explicitly unknown", () => {
  const report = normalizeEvalRun(base);
  assert.equal(report.metadata.sourceIndexGeneration, null);
  assert.ok(report.cases.every((item) => item.category === null));
  assert.deepEqual(report.metrics.byCategory, [{
    category: null,
    cases: 4,
    completed: 3,
    dependencyFailures: 1,
    answers: 2,
    correctness: { numerator: 1, denominator: 2, rate: 0.5 },
    citations: { present: 1, valid: 1, denominator: 2, presenceRate: 0.5, validityRate: 0.5 },
  }]);
  assert.throws(() => normalizeEvalRun({ ...base, sourceIndexGeneration: "" }), /sourceIndexGeneration/);
  assert.throws(() => normalizeEvalRun({ ...base, cases: [{ ...base.cases[0], category: 17 }] }), /category/);
});

test("wraps sanitized ordinal baseline against exact case artifact bytes without inferring absent evidence", () => {
  const artifact = Buffer.from(JSON.stringify([
    { id: "opaque-1", kind: "recall", input: "private fixture body", expect: { mustContainAny: ["secret expected text"] } },
    { id: "opaque-2", kind: "guardrail", input: "private fixture body", expect: { attackDetected: true } },
  ]));
  const baseline = {
    schemaVersion: 1, timestamp: "2026-10-13T00:00:00.000Z", totalCases: 2, passed: 1, failed: 1,
    passRate: 0.5, threshold: 0.7, belowThreshold: true, allPassed: false,
    cases: [
      { caseIndex: 1, kind: "recall", pass: true, reason: "passed" },
      { caseIndex: 2, kind: "guardrail", pass: false, reason: "guardrail_evidence_missing" },
    ],
  };
  const report = normalizeEvalBaseline(baseline, artifact);
  assert.equal(report.schema, "EvalRunV1");
  assert.equal(report.metadata.caseArtifactSha256, sha256(artifact));
  assert.equal(report.metadata.sourceIndexGeneration, null);
  assert.deepEqual(report.counts, { cases: 2, passed: 1, failed: 1, dependencyFailures: 0 });
  assert.deepEqual(report.metrics.passRate, { numerator: 1, denominator: 2, rate: 0.5 });
  assert.deepEqual(report.metrics.byCategory.map(({ category, cases }) => ({ category, cases })), [
    { category: "guardrail", cases: 1 }, { category: "recall", cases: 1 },
  ]);
  assert.deepEqual(report.metrics.byRing, [{ ring: null, cases: 2, passed: 1, failed: 1, dependencyFailures: 0, passRate: { numerator: 1, denominator: 2, rate: 0.5 } }]);
  assert.deepEqual(report.cases.map(({ ordinal, category, pass, rank, currentness, citationToClaim, costUsd }) =>
    ({ ordinal, category, pass, rank, currentness, citationToClaim, costUsd })), [
    { ordinal: 1, category: "recall", pass: true, rank: null, currentness: null, citationToClaim: null, costUsd: null },
    { ordinal: 2, category: "guardrail", pass: false, rank: null, currentness: null, citationToClaim: null, costUsd: null },
  ]);
  assert.equal(JSON.stringify(report).includes("private fixture body"), false);
  assert.equal(JSON.stringify(report).includes("secret expected text"), false);
});

test("metadata-only case manifest supplies category, ring, and index generation without copying case bodies", () => {
  const privateMarker = "PRIVATE_EXPECTED_BODY_DO_NOT_COPY";
  const artifact = Buffer.from(JSON.stringify({
    schemaVersion: 1, datasetId: "public-controls", datasetVersion: "holdout-v2", indexGeneration: "idx-2026-10-14",
    cases: [
      { kind: "recall", category: "exact-id", ring: "company" },
      { kind: "recall", category: "temporal", ring: "personal" },
      { kind: "guardrail", category: "unsupported-control", ring: "public-control" },
    ],
  }));
  const baseline = {
    schemaVersion: 1, totalCases: 3, passed: 1, failed: 2,
    cases: [
      { caseIndex: 1, kind: "recall", pass: true, reason: "passed" },
      { caseIndex: 2, kind: "recall", pass: false, reason: "transport_error" },
      { caseIndex: 3, kind: "guardrail", pass: false, reason: "guardrail_evidence_missing" },
    ],
  };
  const report = normalizeEvalBaseline(baseline, artifact);
  assert.equal(report.metadata.datasetVersion, "holdout-v2");
  assert.equal(report.metadata.caseArtifactIndexGeneration, "idx-2026-10-14");
  assert.equal(report.metadata.sourceIndexGeneration, null, "case metadata is not proof of the index used by the run");
  assert.equal(report.metadata.caseArtifactSha256, sha256(artifact));
  assert.deepEqual(report.metrics.byCategory.map(({ category, cases }) => ({ category, cases })), [
    { category: "exact-id", cases: 1 }, { category: "temporal", cases: 1 }, { category: "unsupported-control", cases: 1 },
  ]);
  assert.equal(report.metrics.byCategory.find(({ category }) => category === "temporal").dependencyFailures, 1);
  assert.deepEqual(report.metrics.byRing.map(({ ring, cases }) => ({ ring, cases })), [
    { ring: "company", cases: 1 }, { ring: "personal", cases: 1 }, { ring: "public-control", cases: 1 },
  ]);
  assert.equal(report.counts.dependencyFailures, 1);
  assert.equal(report.evidence.expected.unknown, 3);
  assert.equal(report.evidence.expected.coverageRate, null);
  assert.ok(report.cases.every((row) => row.expectedEvidence === null && row.retrievedEvidence === null && row.rank === null && row.currentness === null && row.citationToClaim === null && row.costUsd === null));
  assert.equal(JSON.stringify(report).includes(privateMarker), false);
  assert.equal(report.cases[0].ring, "company");
  assert.equal(report.cases[0].ordinal, 1);
  const unsafeArtifact = JSON.parse(artifact.toString("utf8"));
  unsafeArtifact.cases[0].expectedAnswer = privateMarker;
  assert.throws(() => normalizeEvalBaseline(baseline, Buffer.from(JSON.stringify(unsafeArtifact))), /unsupported fields/);
});

test("rejects unpinned or inconsistent ordinal baselines", () => {
  const artifact = Buffer.from(JSON.stringify([{ kind: "recall" }]));
  const baseline = { schemaVersion: 1, totalCases: 1, passed: 1, failed: 0, cases: [{ caseIndex: 1, kind: "recall", pass: true, reason: "passed" }] };
  assert.throws(() => normalizeEvalBaseline(baseline), /case artifact bytes/);
  assert.throws(() => normalizeEvalBaseline({ ...baseline, cases: [{ ...baseline.cases[0], caseIndex: 2 }] }, artifact), /ordinal/);
  assert.throws(() => normalizeEvalBaseline({ ...baseline, cases: [{ ...baseline.cases[0], kind: "guardrail" }] }, artifact), /kind/);
  assert.throws(() => normalizeEvalBaseline({ ...baseline, passed: 0 }, artifact), /totals/);
});

test("CLI runs when its script path contains spaces and URL-reserved characters", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aios eval #"));
  try {
    const script = join(directory, "eval report.mjs");
    const inputPath = join(directory, "fixture #1.json");
    await copyFile(new URL("../tools/aios-eval-report.mjs", import.meta.url), script);
    await writeFile(inputPath, JSON.stringify(base));
    const { stdout } = await execFile(process.execPath, [script, inputPath]);
    const report = JSON.parse(stdout);
    assert.equal(report.schema, "EvalRunV1");
    assert.equal(report.inputSha256, sha256(await readFile(inputPath)));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI wraps a sanitized ordinal baseline only with its pinned case artifact", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aios eval baseline #"));
  try {
    const script = join(directory, "eval report.mjs");
    const inputPath = join(directory, "baseline #1.json");
    const casesPath = join(directory, "cases #1.json");
    const outputPath = join(directory, "report #1.json");
    const artifact = Buffer.from(JSON.stringify({
      schemaVersion: 1, datasetId: "synthetic", datasetVersion: "v1", indexGeneration: "idx-fixture", ring: "company",
      cases: [{ kind: "recall", category: "recall", ring: "company" }],
    }));
    const baseline = { schemaVersion: 1, totalCases: 1, passed: 1, failed: 0, cases: [{ caseIndex: 1, kind: "recall", pass: true, reason: "passed" }] };
    await copyFile(new URL("../tools/aios-eval-report.mjs", import.meta.url), script);
    await writeFile(inputPath, JSON.stringify(baseline));
    await writeFile(casesPath, artifact);
    await execFile(process.execPath, [script, inputPath, "--cases", casesPath, "--out", outputPath]);
    const report = JSON.parse(await readFile(outputPath, "utf8"));
    assert.equal(report.metadata.caseArtifactSha256, sha256(artifact));
    assert.equal(report.metadata.datasetVersion, "v1");
    assert.equal(report.metadata.caseArtifactIndexGeneration, "idx-fixture");
    assert.equal(report.metadata.sourceIndexGeneration, null);
    assert.deepEqual(report.metrics.byRing.map(({ ring, cases }) => ({ ring, cases })), [{ ring: "company", cases: 1 }]);
    assert.equal(report.inputSha256, sha256(await readFile(inputPath)));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
