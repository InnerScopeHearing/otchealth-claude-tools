// Tests for drift.mjs — probeIndex() and compareDrift(), the pure recall-quality-monitor logic.
// Uses injected embed/search fns so no live Azure AI Search / OpenAI calls are needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { probeIndex, compareDrift } from "../drift.mjs";

test("probeIndex averages topScore/coverage/hitCount across probes", async () => {
  const queries = ["q1", "q2", "q3"];
  const embed = async () => [0, 0, 0];
  const search = async (index, q) => {
    if (q === "q1") return [{ "@search.score": 0.9 }, { "@search.score": 0.5 }];
    if (q === "q2") return [{ "@search.score": 0.6 }];
    return []; // q3 has no hits
  };
  const report = await probeIndex("memory-exec", queries, { embed, search });
  assert.equal(report.index, "memory-exec");
  assert.equal(report.probes.length, 3);
  assert.equal(report.coverage, 2 / 3); // q1, q2 have hits; q3 doesn't
  assert.ok(Math.abs(report.topScore - (0.9 + 0.6 + 0) / 3) < 1e-9);
});

test("probeIndex is fail-safe per probe (a throwing probe scores 0, doesn't abort the batch)", async () => {
  const queries = ["ok", "boom"];
  const embed = async (q) => { if (q === "boom") throw new Error("embed fail"); return [1]; };
  const search = async () => [{ "@search.score": 0.8 }];
  const report = await probeIndex("idx", queries, { embed, search });
  assert.equal(report.probes.length, 2);
  assert.equal(report.probes[1].ok, false);
  assert.equal(report.probes[1].topScore, 0);
  assert.equal(report.coverage, 0.5);
});

test("compareDrift: no baseline is reported as seeding, never flagged as drift", () => {
  const current = { index: "memory-exec", topScore: 0.7, coverage: 0.9 };
  const r = compareDrift(current, null);
  assert.equal(r.hasBaseline, false);
  assert.equal(r.drifted, false);
  assert.match(r.line, /no baseline/i);
});

test("compareDrift: topScore within tolerance of baseline is OK", () => {
  const current = { index: "memory-exec", topScore: 0.72, coverage: 0.9 };
  const baseline = { topScore: 0.78, coverage: 0.9 };
  const r = compareDrift(current, baseline, { topscoreDrop: 0.15, coverageDrop: 0.2 });
  assert.equal(r.drifted, false);
  assert.match(r.line, /OK/);
});

test("compareDrift: a large topScore drop flags drift with a reason", () => {
  const current = { index: "memory-exec", topScore: 0.4, coverage: 0.9 };
  const baseline = { topScore: 0.8, coverage: 0.9 };
  const r = compareDrift(current, baseline, { topscoreDrop: 0.15, coverageDrop: 0.2 });
  assert.equal(r.drifted, true);
  assert.match(r.reasons[0], /topScore dropped/);
});

test("compareDrift: a large coverage drop flags drift with a reason", () => {
  const current = { index: "legal-personal-memory", topScore: 0.75, coverage: 0.3 };
  const baseline = { topScore: 0.75, coverage: 0.9 };
  const r = compareDrift(current, baseline, { topscoreDrop: 0.15, coverageDrop: 0.2 });
  assert.equal(r.drifted, true);
  assert.match(r.reasons.join(" "), /coverage dropped/);
});

test("compareDrift: an improvement vs baseline is never flagged", () => {
  const current = { index: "memory-exec", topScore: 0.95, coverage: 1.0 };
  const baseline = { topScore: 0.7, coverage: 0.8 };
  const r = compareDrift(current, baseline);
  assert.equal(r.drifted, false);
});
