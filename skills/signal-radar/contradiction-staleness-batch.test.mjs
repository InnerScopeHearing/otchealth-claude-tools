// Tests for skills/signal-radar/detectors/contradiction-staleness.mjs's OPENAI_BATCH mode (2026-09-02,
// the OpenAI cost-lever sweep's second lever): planEntailments() and makeBatchedEntailer(). Mirrors
// contradiction-staleness-openai-port.test.mjs's env-clearing and withStubbedFetch/withEnv conventions.
import { test } from "node:test";
import assert from "node:assert/strict";
import { planEntailments, makeBatchedEntailer, scanRows } from "../signal-radar/detectors/contradiction-staleness.mjs";

async function withStubbedFetch(stub, run) {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try { return await run(); } finally { globalThis.fetch = original; }
}
async function withEnv(vars, run) {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  try { return await run(); } finally { for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
}
const NO_CREDS_ENV = {
  OPENAI_API_KEY: undefined, CONTRADICTION_MODEL: undefined,
  AWS_ACCESS_KEY_ID: undefined, AWS_SECRET_ACCESS_KEY: undefined, AWS_SESSION_TOKEN: undefined,
  OTC_AWS_ACCESS_KEY_ID: undefined, OTC_AWS_SECRET_ACCESS_KEY: undefined, OTC_AWS_SESSION_TOKEN: undefined,
  AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: undefined, AWS_CONTAINER_CREDENTIALS_FULL_URI: undefined,
  AZURE_SP_TENANT_ID: undefined, AZURE_SP_CLIENT_ID: undefined, AZURE_SP_CLIENT_SECRET: undefined,
  IDENTITY_ENDPOINT: undefined, IDENTITY_HEADER: undefined,
};

const NOW = Date.parse("2026-08-28T12:00:00Z");
function row(id, tsOffsetDays, text, ekeys) {
  const ts = new Date(NOW - tsOffsetDays * 86400000).toISOString();
  return { id, type: "fact", ts, text, ekeys };
}

test("planEntailments: same-entity prior rows produce ONE plan entry per recent row that has a candidate slice", () => {
  const rows = [
    row("old-1", 10, "flatstick build is CFBundleVersion 20", ["flatstick"]),
    row("new-1", 1, "flatstick build is CFBundleVersion 25", ["flatstick"]),
    row("solo-1", 1, "an unrelated fact with no prior same-entity row", ["unrelated-entity"]),
  ];
  const plan = planEntailments(rows, { nowMs: NOW });
  assert.equal(plan.length, 1, "only new-1 has a same-entity PRIOR row in its candidate slice; solo-1 and old-1 (itself the prior) do not");
  assert.equal(plan[0].row.id, "new-1");
  assert.equal(plan[0].slice[0].id, "old-1");
});

test("planEntailments: respects maxLlmCalls exactly like scanRows()'s own budget", () => {
  const rows = [];
  for (let i = 0; i < 5; i++) {
    rows.push(row(`old-${i}`, 10, `entity ${i} was version 1`, [`entity-${i}`]));
    rows.push(row(`new-${i}`, 1, `entity ${i} is now version 2`, [`entity-${i}`]));
  }
  const plan = planEntailments(rows, { nowMs: NOW, maxLlmCalls: 2 });
  assert.equal(plan.length, 2);
});

test("planEntailments: returns an EMPTY plan when there is nothing to entail (no recent rows, or no same-entity priors)", () => {
  assert.deepEqual(planEntailments([], { nowMs: NOW }), []);
  assert.deepEqual(planEntailments([row("solo", 1, "an isolated fact", ["only-entity"])], { nowMs: NOW }), []);
});

test("makeBatchedEntailer: with no OPENAI_API_KEY and no resolvable fleet secret returns null, same contract as makeEntailer()", async () =>
  withEnv(NO_CREDS_ENV, async () => {
    const rows = [row("old-1", 10, "x is 1", ["x"]), row("new-1", 1, "x is 2", ["x"])];
    const entail = await withStubbedFetch(
      async () => ({ ok: false, status: 404, text: async () => "not found", json: async () => ({}) }),
      () => makeBatchedEntailer(rows, { nowMs: NOW })
    );
    assert.equal(entail, null);
  }));

test("makeBatchedEntailer: submits ONE batch line per planned row, and the returned entail() looks results up by row id", async () =>
  withEnv({ ...NO_CREDS_ENV, OPENAI_API_KEY: "sk-test" }, async () => {
    const rows = [row("old-1", 10, "x is 1", ["x"]), row("new-1", 1, "x is 2", ["x"])];
    let uploadedLineCount = null;
    const entail = await withStubbedFetch(async (url, init) => {
      const u = String(url);
      if (u === "https://api.openai.com/v1/files") {
        const text = await init.body.get("file").text();
        uploadedLineCount = text.trim().split("\n").length;
        return { ok: true, status: 200, json: async () => ({ id: "file-in-1" }) };
      }
      if (u === "https://api.openai.com/v1/batches" && init.method === "POST") return { ok: true, status: 200, json: async () => ({ id: "batch_abc123" }) };
      if (u === "https://api.openai.com/v1/batches/batch_abc123") return { ok: true, status: 200, json: async () => ({ id: "batch_abc123", status: "completed", output_file_id: "file-out-1", error_file_id: null }) };
      if (u === "https://api.openai.com/v1/files/file-out-1/content") return { ok: true, status: 200, text: async () => JSON.stringify({ custom_id: "row-0", response: { body: { choices: [{ message: { content: '{"label":"contradict","citedId":"old-1","reason":"direct conflict"}' } }] } }, error: null }) };
      throw new Error("unexpected url " + u);
    }, () => makeBatchedEntailer(rows, { nowMs: NOW }));
    assert.equal(uploadedLineCount, 1, "exactly ONE plan entry (new-1) should have been batched");
    assert.equal(typeof entail, "function");
    const verdict = await entail(rows[1], [rows[0]]);
    assert.equal(verdict.label, "contradict");
    assert.equal(verdict.citedId, "old-1");
  }));

test("makeBatchedEntailer's returned entail() throws (never fabricates 'agree') when asked about a row NOT in the plan -- the plan/scanRows mismatch guard", async () =>
  withEnv({ ...NO_CREDS_ENV, OPENAI_API_KEY: "sk-test" }, async () => {
    const rows = [row("old-1", 10, "x is 1", ["x"]), row("new-1", 1, "x is 2", ["x"])];
    const entail = await withStubbedFetch(async (url) => {
      const u = String(url);
      if (u === "https://api.openai.com/v1/files") return { ok: true, status: 200, json: async () => ({ id: "file-in-1" }) };
      if (u === "https://api.openai.com/v1/batches") return { ok: true, status: 200, json: async () => ({ id: "batch_abc123" }) };
      if (u === "https://api.openai.com/v1/batches/batch_abc123") return { ok: true, status: 200, json: async () => ({ id: "batch_abc123", status: "completed", output_file_id: "file-out-1", error_file_id: null }) };
      if (u === "https://api.openai.com/v1/files/file-out-1/content") return { ok: true, status: 200, text: async () => JSON.stringify({ custom_id: "row-0", response: { body: { choices: [{ message: { content: "{}" } }] } }, error: null }) };
      throw new Error("unexpected url " + u);
    }, () => makeBatchedEntailer(rows, { nowMs: NOW }));
    await assert.rejects(() => entail({ id: "never-planned-row" }, []), /no pre-computed batch result for row never-planned-row/);
  }));

test("makeBatchedEntailer + scanRows end to end: the batched entail is a true drop-in, scanRows() itself is unmodified", async () =>
  withEnv({ ...NO_CREDS_ENV, OPENAI_API_KEY: "sk-test" }, async () => {
    const rows = [
      row("old-1", 10, "flatstick build is CFBundleVersion 20", ["flatstick"]),
      row("new-1", 1, "flatstick build is CFBundleVersion 25", ["flatstick"]),
    ];
    const entail = await withStubbedFetch(async (url) => {
      const u = String(url);
      if (u === "https://api.openai.com/v1/files") return { ok: true, status: 200, json: async () => ({ id: "file-in-1" }) };
      if (u === "https://api.openai.com/v1/batches") return { ok: true, status: 200, json: async () => ({ id: "batch_abc123" }) };
      if (u === "https://api.openai.com/v1/batches/batch_abc123") return { ok: true, status: 200, json: async () => ({ id: "batch_abc123", status: "completed", output_file_id: "file-out-1", error_file_id: null }) };
      if (u === "https://api.openai.com/v1/files/file-out-1/content") return { ok: true, status: 200, text: async () => JSON.stringify({ custom_id: "row-0", response: { body: { choices: [{ message: { content: '{"label":"supersede","citedId":"old-1","reason":"normal version bump"}' } }] } }, error: null }) };
      throw new Error("unexpected url " + u);
    }, () => makeBatchedEntailer(rows, { nowMs: NOW }));
    const res = await scanRows(rows, entail, { nowMs: NOW });
    // "supersede" is gated out by gateVerdict (a normal expected update, never an alert signal) --
    // proving scanRows() consumed the batched entailer's verdict through its OWN unmodified gating.
    assert.equal(res.signals.length, 0);
    assert.equal(res.llmCalls, 1);
  }));
