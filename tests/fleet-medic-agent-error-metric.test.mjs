// otc.fleet.agent_error is fleet-medic's own classify() output turned into a Datadog metric. These
// tests pin the two guarantees that make the fix actually close the monitor's "No Data" problem:
//   1. EVERY agent gets a point EVERY run (a healthy 0, not silence) -- a count metric with nothing
//      submitted during a healthy stretch reads as "No Data" exactly like the original bug.
//   2. DARK / NO-MEMORY map to 1 (an error), everything else maps to 0 -- and a submission failure is
//      counted and surfaced, never silently dropped.
import { test } from "node:test";
import assert from "node:assert/strict";
import { emitAgentErrorMetrics } from "../skills/fleet-medic/medic.mjs";

async function withStubbedFetch(stub, run) {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  const prevKey = process.env.DD_API_KEY;
  process.env.DD_API_KEY = "test-key";
  try { return await run(); }
  finally { globalThis.fetch = original; if (prevKey === undefined) delete process.env.DD_API_KEY; else process.env.DD_API_KEY = prevKey; }
}

const RESULTS = [
  { agent: "cto", condition: "HEALTHY" },
  { agent: "clo", condition: "WATCH" },
  { agent: "growth", condition: "NO-MEMORY" },
  { agent: "developer", condition: "DARK" },
];

test("emits one point per agent, every run -- including the healthy ones (no silence during a healthy stretch)", async () => {
  const seen = [];
  const summary = await withStubbedFetch(
    async (url, init) => { seen.push(JSON.parse(init.body).series[0]); return { ok: true, text: async () => "{}" }; },
    () => emitAgentErrorMetrics(RESULTS),
  );
  assert.equal(seen.length, RESULTS.length);
  assert.equal(summary.emitted, RESULTS.length);
  assert.equal(summary.failed, 0);
});

test("DARK and NO-MEMORY map to value 1 (an error); HEALTHY and WATCH map to 0", async () => {
  const byAgent = {};
  await withStubbedFetch(
    async (url, init) => { const s = JSON.parse(init.body).series[0]; byAgent[s.tags.find((t) => t.startsWith("agent:")).slice(6)] = s.points[0].value; return { ok: true, text: async () => "{}" }; },
    () => emitAgentErrorMetrics(RESULTS),
  );
  assert.equal(byAgent.cto, 0);
  assert.equal(byAgent.clo, 0);
  assert.equal(byAgent.growth, 1);
  assert.equal(byAgent.developer, 1);
});

test("every submission is tagged agent:<name> and job:fleet-medic, submitted as a count metric", async () => {
  const seen = [];
  await withStubbedFetch(
    async (url, init) => { seen.push(JSON.parse(init.body).series[0]); return { ok: true, text: async () => "{}" }; },
    () => emitAgentErrorMetrics([{ agent: "cfo", condition: "HEALTHY" }]),
  );
  assert.equal(seen[0].metric, "otc.fleet.agent_error");
  assert.equal(seen[0].type, 1, "count-type (Datadog code 1), matching this metric's semantics");
  assert.ok(seen[0].tags.includes("agent:cfo"));
  assert.ok(seen[0].tags.includes("job:fleet-medic"));
});

test("a send failure is counted as failed, not silently dropped -- and the OTHER agents still get their point", async () => {
  // Fail EVERY attempt for agent "a" (so its internal retries are exhausted too), succeed for "b" --
  // proves both that a real, persistent failure is counted (not masked by ddMetric's own retry) and
  // that one agent's failure does not stop the run from covering the rest.
  const summary = await withStubbedFetch(
    async (url, init) => {
      const tags = JSON.parse(init.body).series[0].tags;
      const forA = tags.includes("agent:a");
      return forA ? { ok: false, status: 500, text: async () => "boom" } : { ok: true, text: async () => "{}" };
    },
    () => emitAgentErrorMetrics([{ agent: "a", condition: "HEALTHY" }, { agent: "b", condition: "HEALTHY" }]),
  );
  assert.equal(summary.emitted, 1);
  assert.equal(summary.failed, 1, "the induced failure must be counted, never silently treated as a success");
});

test("MEDIC_SKIP_METRICS=1 is a clean escape hatch (skips without touching the network)", async () => {
  const prev = process.env.MEDIC_SKIP_METRICS;
  process.env.MEDIC_SKIP_METRICS = "1";
  let fetchCalled = false;
  try {
    const original = globalThis.fetch;
    globalThis.fetch = async () => { fetchCalled = true; return { ok: true, text: async () => "{}" }; };
    try {
      const summary = await emitAgentErrorMetrics(RESULTS);
      assert.equal(summary.skipped, true);
      assert.equal(fetchCalled, false);
    } finally { globalThis.fetch = original; }
  } finally { if (prev === undefined) delete process.env.MEDIC_SKIP_METRICS; else process.env.MEDIC_SKIP_METRICS = prev; }
});
