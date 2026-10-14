#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const RUN_FIELDS = new Set(["schemaVersion", "suite", "model", "prompt", "tool", "sourceVersion", "sourceIndexGeneration", "cases"]);
const CASE_FIELDS = new Set([
  "id", "category", "outcome", "correct", "citationExpected", "citationPresent", "citationValid",
  "abstained", "latencyMs", "costUsd",
]);
const OUTCOMES = new Set(["answered", "no_evidence", "dependency_failed"]);
const BASELINE_REASONS = new Set(["passed", "transport_error", "invalid_envelope", "tool_error", "unrecognized_result", "guardrail_evidence_missing", "recall_keywords_missing", "unknown_kind"]);
const DEPENDENCY_REASONS = new Set(["transport_error", "invalid_envelope", "tool_error", "unrecognized_result"]);
const EVAL_RINGS = new Set(["company", "personal", "public-control"]);

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
}

function assertFields(value, allowed, label) {
  const extra = Object.keys(value).filter((key) => !allowed.has(key));
  if (extra.length) throw new Error(`${label} has unsupported fields`);
}

function requiredLabel(value, name) {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 160) {
    throw new Error(`${name} must be a non-empty string of at most 160 characters`);
  }
  return value;
}

function nullableLabel(value, name, maxLength = 160) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength) {
    throw new Error(`${name} must be a non-empty string of at most ${maxLength} characters or null`);
  }
  return value;
}

function nullableToken(value, name, maxLength = 160) {
  const label = nullableLabel(value, name, maxLength);
  if (label !== null && !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(label)) throw new Error(`${name} must be a bounded metadata token or null`);
  return label;
}

function optionalBoolean(value, name) {
  if (value !== null && typeof value !== "boolean") throw new Error(`${name} must be boolean or null`);
}

function optionalNonnegative(value, name) {
  if (value !== null && (!Number.isFinite(value) || value < 0)) throw new Error(`${name} must be a nonnegative finite number or null`);
}

function ratio(numerator, denominator) {
  return { numerator, denominator, rate: denominator === 0 ? null : numerator / denominator };
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.ceil(p * sorted.length) - 1];
}

/**
 * Convert local evaluator JSON into a content-minimized EvalRunV1 report.
 * Prompt text, case IDs, and result bodies are never copied to the output.
 */
export function normalizeEvalRun(input, options = {}) {
  assertObject(input, "input");
  assertFields(input, RUN_FIELDS, "input");
  if (input.schemaVersion !== 1) throw new Error("schemaVersion must be 1");
  const suite = requiredLabel(input.suite, "suite");
  const model = requiredLabel(input.model, "model");
  const prompt = requiredLabel(input.prompt, "prompt");
  const tool = requiredLabel(input.tool, "tool");
  const sourceVersion = requiredLabel(input.sourceVersion, "sourceVersion");
  const sourceIndexGeneration = nullableLabel(input.sourceIndexGeneration, "sourceIndexGeneration");
  if (!Array.isArray(input.cases) || input.cases.length > 500) throw new Error("case count must be an array of at most 500");

  const seenIds = new Set();
  const outcomes = input.cases.map((item) => {
    assertObject(item, "case");
    assertFields(item, CASE_FIELDS, "case");
    const id = requiredLabel(item.id, "case id");
    const category = nullableLabel(item.category, "category", 80);
    if (seenIds.has(id)) throw new Error("case IDs must be unique");
    seenIds.add(id);
    if (!OUTCOMES.has(item.outcome)) throw new Error("case outcome is invalid");
    optionalBoolean(item.correct, "correct");
    optionalBoolean(item.citationExpected, "citationExpected");
    optionalBoolean(item.citationPresent, "citationPresent");
    optionalBoolean(item.citationValid, "citationValid");
    optionalBoolean(item.abstained, "abstained");
    optionalNonnegative(item.latencyMs, "latencyMs");
    optionalNonnegative(item.costUsd, "costUsd");
    if (typeof item.abstained !== "boolean") throw new Error("abstained must be boolean");
    if (item.outcome === "answered" && typeof item.correct !== "boolean") throw new Error("answered case correct must be boolean");
    if (item.outcome !== "answered" && item.correct !== null) throw new Error("non-answer case correct must be null");
    return { item, id, category };
  });

  const completed = outcomes.filter(({ item }) => item.outcome !== "dependency_failed");
  const answers = outcomes.filter(({ item }) => item.outcome === "answered");
  const correctAnswers = answers.filter(({ item }) => item.correct === true).length;
  const wrongAnswers = answers.filter(({ item }) => item.correct === false).length;
  const noEvidence = outcomes.filter(({ item }) => item.outcome === "no_evidence").length;
  const dependencyFailures = outcomes.filter(({ item }) => item.outcome === "dependency_failed").length;
  const abstentions = outcomes.filter(({ item }) => item.abstained === true).length;
  const citationCases = completed.filter(({ item }) => item.citationExpected === true);
  const citationPresent = citationCases.filter(({ item }) => item.citationPresent === true).length;
  const citationValid = citationCases.filter(({ item }) => item.citationPresent === true && item.citationValid === true).length;

  const categoryGroups = new Map();
  for (const row of outcomes) {
    const key = row.category;
    if (!categoryGroups.has(key)) categoryGroups.set(key, []);
    categoryGroups.get(key).push(row);
  }
  const byCategory = [...categoryGroups.entries()]
    .sort(([left], [right]) => left === null ? (right === null ? 0 : 1) : right === null ? -1 : left.localeCompare(right))
    .map(([category, rows]) => {
      const categoryCompleted = rows.filter(({ item }) => item.outcome !== "dependency_failed");
      const categoryAnswers = rows.filter(({ item }) => item.outcome === "answered");
      const categoryCorrect = categoryAnswers.filter(({ item }) => item.correct === true).length;
      const categoryCitationCases = categoryCompleted.filter(({ item }) => item.citationExpected === true);
      const categoryCitationPresent = categoryCitationCases.filter(({ item }) => item.citationPresent === true).length;
      const categoryCitationValid = categoryCitationCases.filter(({ item }) => item.citationPresent === true && item.citationValid === true).length;
      return {
        category,
        cases: rows.length,
        completed: categoryCompleted.length,
        dependencyFailures: rows.filter(({ item }) => item.outcome === "dependency_failed").length,
        answers: categoryAnswers.length,
        correctness: ratio(categoryCorrect, categoryAnswers.length),
        citations: {
          present: categoryCitationPresent,
          valid: categoryCitationValid,
          denominator: categoryCitationCases.length,
          presenceRate: categoryCitationCases.length ? categoryCitationPresent / categoryCitationCases.length : null,
          validityRate: categoryCitationCases.length ? categoryCitationValid / categoryCitationCases.length : null,
        },
      };
    });

  const latencies = outcomes.map(({ item }) => item.latencyMs).filter((value) => value !== null).sort((a, b) => a - b);
  const meanLatency = latencies.length ? latencies.reduce((sum, value) => sum + value, 0) / latencies.length : null;
  const costs = outcomes.map(({ item }) => item.costUsd).filter((value) => value !== null);
  const costObserved = costs.length > 0;

  const inputSha256 = options.inputSha256 ?? sha256(JSON.stringify(input));
  if (typeof inputSha256 !== "string" || !/^[a-f0-9]{64}$/.test(inputSha256)) throw new Error("inputSha256 must be a lowercase SHA-256 digest");

  return {
    schema: "EvalRunV1",
    metadata: {
      suite,
      model,
      promptSha256: sha256(prompt),
      tool,
      sourceVersion,
      sourceIndexGeneration,
      inputSha256,
    },
    inputSha256,
    counts: {
      cases: outcomes.length,
      completed: completed.length,
      dependencyFailures,
      answers: answers.length,
      correctAnswers,
      wrongAnswers,
      noEvidence,
      abstentions,
    },
    metrics: {
      correctness: ratio(correctAnswers, answers.length),
      citations: {
        present: citationPresent,
        valid: citationValid,
        denominator: citationCases.length,
        presenceRate: citationCases.length ? citationPresent / citationCases.length : null,
        validityRate: citationCases.length ? citationValid / citationCases.length : null,
      },
      byCategory,
    },
    timing: {
      latencyMs: {
        denominator: latencies.length,
        mean: meanLatency,
        p50: percentile(latencies, 0.5),
        p95: percentile(latencies, 0.95),
      },
    },
    cost: {
      currency: "USD",
      observedCaseCount: costs.length,
      denominator: outcomes.length,
      complete: costs.length === outcomes.length,
      observedSumUsd: costObserved ? costs.reduce((sum, value) => sum + value, 0) : null,
    },
    cases: outcomes.map(({ item, category }) => ({
      caseSha256: sha256(JSON.stringify(item)),
      category,
      outcome: item.outcome,
      correct: item.correct,
      citationExpected: item.citationExpected,
      citationPresent: item.citationPresent,
      citationValid: item.citationPresent !== true && item.citationValid === true ? false : item.citationValid,
      abstained: item.abstained,
      latencyMs: item.latencyMs,
      costUsd: item.costUsd,
    })),
  };
}

/**
 * Bind a sanitized gateway EVAL_BASELINE_V1 ordinal result to the exact bytes of
 * its case artifact. The producer does not report ranks, evidence, currentness,
 * citation-to-claim checks, latency, cost, index generation, or model provenance;
 * those fields stay explicitly unknown instead of being inferred from pass/fail.
 */
export function normalizeEvalBaseline(baseline, caseArtifactBytes, options = {}) {
  assertObject(baseline, "baseline");
  assertFields(baseline, new Set(["schemaVersion", "timestamp", "totalCases", "passed", "failed", "passRate", "threshold", "belowThreshold", "allPassed", "cases"]), "baseline");
  if (baseline.schemaVersion !== 1) throw new Error("baseline schemaVersion must be 1");
  if (!(Buffer.isBuffer(caseArtifactBytes) || caseArtifactBytes instanceof Uint8Array)) throw new Error("case artifact bytes are required to pin ordinals");
  const artifactBytes = Buffer.from(caseArtifactBytes);
  let artifactDocument;
  try { artifactDocument = JSON.parse(artifactBytes.toString("utf8")); } catch { throw new Error("case artifact must contain valid JSON"); }
  let artifactMetadata = {};
  let artifact;
  if (Array.isArray(artifactDocument)) artifact = artifactDocument; // legacy case artifact
  else {
    assertObject(artifactDocument, "case artifact");
    assertFields(artifactDocument, new Set(["schemaVersion", "datasetId", "datasetVersion", "indexGeneration", "ring", "cases"]), "case artifact");
    if (artifactDocument.schemaVersion !== 1 || !Array.isArray(artifactDocument.cases)) throw new Error("case artifact manifest must use schemaVersion 1 and include cases");
    artifactMetadata = {
      datasetId: nullableToken(artifactDocument.datasetId, "datasetId"),
      datasetVersion: nullableToken(artifactDocument.datasetVersion, "datasetVersion"),
      caseArtifactIndexGeneration: nullableToken(artifactDocument.indexGeneration, "indexGeneration"),
      ring: artifactDocument.ring ?? null,
    };
    if (artifactMetadata.ring !== null && !EVAL_RINGS.has(artifactMetadata.ring)) throw new Error("case artifact ring is invalid");
    artifact = artifactDocument.cases;
    if (artifact.length > 1000) throw new Error("case artifact must be an array of at most 1000");
    for (const source of artifact) {
      assertObject(source, "case artifact entry");
      assertFields(source, new Set(["kind", "category", "ring"]), "case artifact entry");
    }
  }
  if (!Array.isArray(artifact) || artifact.length > 1000) throw new Error("case artifact must be an array of at most 1000");
  if (!Array.isArray(baseline.cases) || baseline.cases.length !== artifact.length || baseline.totalCases !== artifact.length) throw new Error("baseline totals must match the pinned case artifact");
  if (!Number.isInteger(baseline.passed) || !Number.isInteger(baseline.failed) || baseline.passed < 0 || baseline.failed < 0 || baseline.passed + baseline.failed !== artifact.length) throw new Error("baseline totals are inconsistent");

  const bindings = baseline.cases.map((row, index) => {
    assertObject(row, "baseline case");
    assertFields(row, new Set(["caseIndex", "kind", "pass", "reason"]), "baseline case");
    const source = artifact[index];
    assertObject(source, "case artifact entry");
    if (row.caseIndex !== index + 1) throw new Error("baseline ordinal mapping must be contiguous and one-based");
    if (row.kind !== source.kind || !["recall", "guardrail"].includes(source.kind)) throw new Error("baseline kind does not match pinned case artifact ordinal");
    if (typeof row.pass !== "boolean" || !BASELINE_REASONS.has(row.reason)) throw new Error("baseline outcome is invalid");
    if (row.pass !== (row.reason === "passed")) throw new Error("baseline pass flag and reason disagree");
    const category = nullableToken(source.category, "case category", 80) ?? source.kind;
    const ring = (source.ring === undefined ? artifactMetadata.ring : source.ring) ?? null;
    if (ring !== null && !EVAL_RINGS.has(ring)) throw new Error("case artifact ring is invalid");
    return { ordinal: row.caseIndex, category, ring, pass: row.pass, reason: row.reason, dependencyFailed: DEPENDENCY_REASONS.has(row.reason) };
  });
  if (bindings.filter((row) => row.pass).length !== baseline.passed) throw new Error("baseline totals do not match case outcomes");

  const groups = new Map();
  for (const row of bindings) {
    if (!groups.has(row.category)) groups.set(row.category, []);
    groups.get(row.category).push(row);
  }
  const byCategory = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([category, rows]) => {
    const passed = rows.filter((row) => row.pass).length;
    return { category, cases: rows.length, passed, failed: rows.length - passed, dependencyFailures: rows.filter((row) => row.dependencyFailed).length, passRate: ratio(passed, rows.length) };
  });
  const ringGroups = new Map();
  for (const row of bindings) {
    if (!ringGroups.has(row.ring)) ringGroups.set(row.ring, []);
    ringGroups.get(row.ring).push(row);
  }
  const byRing = [...ringGroups.entries()].sort(([a], [b]) => a === null ? (b === null ? 0 : 1) : b === null ? -1 : a.localeCompare(b)).map(([ring, rows]) => {
    const passed = rows.filter((row) => row.pass).length;
    return { ring, cases: rows.length, passed, failed: rows.length - passed, dependencyFailures: rows.filter((row) => row.dependencyFailed).length, passRate: ratio(passed, rows.length) };
  });
  const inputSha256 = options.inputSha256 ?? sha256(JSON.stringify(baseline));
  if (typeof inputSha256 !== "string" || !/^[a-f0-9]{64}$/.test(inputSha256)) throw new Error("inputSha256 must be a lowercase SHA-256 digest");
  const caseArtifactSha256 = sha256(artifactBytes);
  return {
    schema: "EvalRunV1",
    metadata: {
      sourceSchema: "EVAL_BASELINE_V1", caseArtifactSha256, datasetId: artifactMetadata.datasetId ?? null,
      datasetVersion: artifactMetadata.datasetVersion ?? null, caseArtifactIndexGeneration: artifactMetadata.caseArtifactIndexGeneration ?? null,
      sourceIndexGeneration: null,
      model: null, promptSha256: null, tool: null, sourceVersion: null, inputSha256,
    },
    inputSha256,
    counts: { cases: bindings.length, passed: baseline.passed, failed: baseline.failed, dependencyFailures: bindings.filter((row) => row.dependencyFailed).length },
    metrics: { passRate: ratio(baseline.passed, bindings.length), byCategory, byRing },
    evidence: {
      expected: { observed: 0, unknown: bindings.length, denominator: bindings.length, coverageRate: null },
      retrieved: { observed: 0, unknown: bindings.length, denominator: bindings.length, coverageRate: null },
      ranks: { observed: 0, unknown: bindings.length, denominator: bindings.length, coverageRate: null },
      currentness: { observed: 0, unknown: bindings.length, denominator: bindings.length },
      citationToClaim: { observed: 0, unknown: bindings.length, denominator: bindings.length },
    },
    timing: { latencyMs: { denominator: 0, mean: null, p50: null, p95: null } },
    cost: { currency: "USD", observedCaseCount: 0, denominator: bindings.length, complete: false, observedSumUsd: null },
    cases: bindings.map((row) => ({ ordinal: row.ordinal, category: row.category, ring: row.ring, pass: row.pass, reason: row.reason, dependencyFailed: row.dependencyFailed, caseArtifactSha256, expectedEvidence: null, retrievedEvidence: null,
      rank: null, currentness: null, citationToClaim: null, latencyMs: null, costUsd: null })),
  };
}

async function main(argv) {
  if (!argv.length) throw new Error("usage: node tools/aios-eval-report.mjs <local-eval.json> [--cases <case-artifact.json>] [--out <report.json>]");
  const inputPath = argv[0];
  let outputPath = null;
  let caseArtifactPath = null;
  for (let index = 1; index < argv.length; index += 1) {
    if (argv[index] === "--out" && argv[index + 1] && !outputPath) outputPath = argv[++index];
    else if (argv[index] === "--cases" && argv[index + 1] && !caseArtifactPath) caseArtifactPath = argv[++index];
    else throw new Error("expected one optional --cases <case-artifact.json> and --out <report.json>");
  }
  const raw = await readFile(inputPath);
  let parsed;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new Error("input file must contain valid JSON");
  }
  const report = caseArtifactPath
    ? normalizeEvalBaseline(parsed, await readFile(caseArtifactPath), { inputSha256: sha256(raw) })
    : normalizeEvalRun(parsed, { inputSha256: sha256(raw) });
  const rendered = `${JSON.stringify(report, null, 2)}\n`;
  if (outputPath) await writeFile(outputPath, rendered, { flag: "wx" });
  else process.stdout.write(rendered);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`aios-eval-report: ${error.message}\n`);
    process.exitCode = 2;
  });
}
