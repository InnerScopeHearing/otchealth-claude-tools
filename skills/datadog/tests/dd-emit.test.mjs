// Tests for skills/datadog/dd-emit.mjs — the honest Datadog metric emitter. The whole point of this
// module is that it can never claim success on a request that never actually landed (the exact
// "fleet-medic emitDispatch" bug class: Succeeded status, zero visible effect). Every test below is
// really a test of THAT property, from a different angle. All network is stubbed (fetchImpl); no
// real Key Vault / Datadog calls happen here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ddEmitMetric } from "../dd-emit.mjs";

function captureConsoleError(fn) {
  const logs = [];
  const orig = console.error;
  console.error = (...a) => logs.push(a.join(" "));
  return (async () => {
    try { return { result: await fn(), logs }; }
    finally { console.error = orig; }
  })();
}

test("ddEmitMetric: returns true and logs nothing on a genuine 2xx", async () => {
  const fetchImpl = async () => ({ ok: true, status: 202, text: async () => "" });
  const { result, logs } = await captureConsoleError(() =>
    ddEmitMetric("otc.fleet.test_metric", 3, ["provider:xero"], { apiKey: "k", site: "datadoghq.com", fetchImpl, backoffMs: 1 }),
  );
  assert.equal(result, true);
  assert.deepEqual(logs, []);
});

test("ddEmitMetric: a persistently failing (non-2xx) response is reported as failure, never as success", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return { ok: false, status: 500, text: async () => "boom" }; };
  const { result, logs } = await captureConsoleError(() =>
    ddEmitMetric("otc.fleet.test_metric", 1, ["x:y"], { apiKey: "k", site: "datadoghq.com", fetchImpl, backoffMs: 1 }),
  );
  assert.equal(result, false, "must never return true when every attempt failed");
  assert.equal(calls, 3, "must actually retry, not give up after one try");
  assert.ok(logs.some((l) => l.includes("DATADOG EMIT FAILED") && l.includes("otc.fleet.test_metric")), "must log a LOUD, greppable failure line");
});

test("ddEmitMetric: THE regression this module exists to prevent — a throwing fetch (network error) must not be swallowed as success", async () => {
  const fetchImpl = async () => { throw new Error("ECONNRESET"); };
  const { result, logs } = await captureConsoleError(() =>
    ddEmitMetric("otc.fleet.test_metric", 1, [], { apiKey: "k", site: "datadoghq.com", fetchImpl, backoffMs: 1 }),
  );
  assert.equal(result, false);
  assert.ok(logs.some((l) => l.includes("DATADOG EMIT FAILED")));
});

test("ddEmitMetric: retries genuinely retry — recovers and returns true if a later attempt succeeds", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return calls < 3 ? { ok: false, status: 503, text: async () => "" } : { ok: true, status: 200, text: async () => "" };
  };
  const result = await ddEmitMetric("otc.fleet.test_metric", 1, [], { apiKey: "k", site: "datadoghq.com", fetchImpl, backoffMs: 1 });
  assert.equal(result, true);
  assert.equal(calls, 3);
});

test("ddEmitMetric: a missing API key is a loud SKIP, not a silent success and not a thrown error", async () => {
  const { result, logs } = await captureConsoleError(() =>
    ddEmitMetric("otc.fleet.test_metric", 1, [], { apiKey: null, site: "datadoghq.com" }),
  );
  assert.equal(result, false);
  assert.ok(logs.some((l) => l.includes("DATADOG EMIT SKIPPED") && l.includes("otc.fleet.test_metric")));
});

test("ddEmitMetric: never throws even when fetchImpl throws on every attempt (fail-open for the caller's real job)", async () => {
  const fetchImpl = async () => { throw new Error("boom"); };
  await assert.doesNotReject(() =>
    ddEmitMetric("otc.fleet.test_metric", 1, [], { apiKey: "k", site: "datadoghq.com", fetchImpl, backoffMs: 1 }),
  );
});
