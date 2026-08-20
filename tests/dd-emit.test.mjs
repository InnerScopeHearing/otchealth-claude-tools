// dd-emit.mjs is the shared, LOUD-ON-FAILURE Datadog metric helper introduced for the two new fleet
// metrics (otc.fleet.token_age_hours, otc.fleet.agent_error). Its whole reason to exist is that the
// two pre-existing emit patterns in this repo (dd-fleet.mjs, xero-token.mjs's local ddEmit()) BOTH
// swallow a failed submission silently. These tests pin the opposite contract: ddMetric() always
// resolves to {ok:true} or {ok:false, error:<string>}, never throws, and never returns ok:true for a
// failed HTTP call.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ddMetric, _resetForTests } from "../skills/datadog/dd-emit.mjs";

async function withStubbedFetch(stub, run) {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try { return await run(); } finally { globalThis.fetch = original; }
}

// This test SESSION may itself carry real Azure SP credentials (AZURE_SP_CLIENT_ID/SECRET/TENANT_ID)
// as ambient env, since the fleet's own credentialed seats run these same tests. A test asserting
// "no credential resolves" must not silently assume a bare CI runner -- it must FORCE that state, or
// it passes on CI and fails (or worse, passes for the wrong reason) on a credentialed seat. Clears
// every path kvSecret()/aws-secret.mjs's awsCreds() can succeed through, restores after.
const CRED_ENV_KEYS = [
  "AZURE_SP_CLIENT_ID", "AZURE_SP_CLIENT_SECRET", "AZURE_SP_TENANT_ID", "IDENTITY_ENDPOINT", "IDENTITY_HEADER",
  "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", "AWS_CONTAINER_CREDENTIALS_FULL_URI",
];
async function withNoAmbientCreds(run) {
  const prev = Object.fromEntries(CRED_ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of CRED_ENV_KEYS) delete process.env[k];
  try { return await run(); }
  finally { for (const k of CRED_ENV_KEYS) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; } }
}

test("a successful submission returns {ok:true}", async () => {
  _resetForTests();
  process.env.DD_API_KEY = "test-key";
  process.env.DD_SITE = "datadoghq.example";
  try {
    const seen = [];
    const result = await withStubbedFetch(
      async (url, init) => { seen.push({ url, body: JSON.parse(init.body) }); return { ok: true, text: async () => "{}" }; },
      () => ddMetric("otc.fleet.test_metric", 42, { tags: ["secret:foo"], type: "gauge" }),
    );
    assert.deepEqual(result, { ok: true });
    assert.equal(seen.length, 1);
    assert.match(seen[0].url, /\/api\/v2\/series$/);
    assert.equal(seen[0].body.series[0].metric, "otc.fleet.test_metric");
    assert.equal(seen[0].body.series[0].points[0].value, 42);
    assert.deepEqual(seen[0].body.series[0].tags, ["secret:foo"]);
  } finally { delete process.env.DD_API_KEY; delete process.env.DD_SITE; }
});

test("count vs gauge type maps to the Datadog v2 series type code", async () => {
  _resetForTests();
  process.env.DD_API_KEY = "test-key";
  process.env.DD_SITE = "datadoghq.example";
  try {
    const seen = [];
    await withStubbedFetch(
      async (url, init) => { seen.push(JSON.parse(init.body).series[0].type); return { ok: true, text: async () => "{}" }; },
      async () => {
        await ddMetric("m", 1, { type: "count" });
        await ddMetric("m", 1, { type: "gauge" });
      },
    );
    assert.deepEqual(seen, [1, 3], "count must be type 1, gauge must be type 3 (Datadog's own encoding)");
  } finally { delete process.env.DD_API_KEY; delete process.env.DD_SITE; }
});

test("a persistent HTTP failure is retried, then surfaces as {ok:false, error} -- NEVER thrown, NEVER silently ok:true", async () => {
  _resetForTests();
  process.env.DD_API_KEY = "test-key";
  process.env.DD_SITE = "datadoghq.example";
  try {
    let calls = 0;
    const result = await withStubbedFetch(
      async () => { calls++; return { ok: false, status: 503, text: async () => "upstream down" }; },
      () => ddMetric("otc.fleet.test_metric", 1, { attempts: 3 }),
    );
    assert.equal(result.ok, false);
    assert.match(result.error, /HTTP 503/);
    assert.match(result.error, /upstream down/);
    assert.equal(calls, 3, "must retry up to the configured attempt count, not give up after one failure");
  } finally { delete process.env.DD_API_KEY; delete process.env.DD_SITE; }
});

test("a thrown network error is caught and reported, never propagated to the caller", async () => {
  _resetForTests();
  process.env.DD_API_KEY = "test-key";
  process.env.DD_SITE = "datadoghq.example";
  try {
    const result = await withStubbedFetch(
      async () => { throw new Error("ECONNRESET"); },
      () => ddMetric("otc.fleet.test_metric", 1, { attempts: 2 }),
    );
    assert.equal(result.ok, false);
    assert.match(result.error, /ECONNRESET/);
  } finally { delete process.env.DD_API_KEY; delete process.env.DD_SITE; }
});

test("a missing API key is a real, named failure -- not a quiet no-op (the dd-fleet.mjs anti-pattern this file exists to avoid)", async () => {
  await withNoAmbientCreds(async () => {
    _resetForTests();
    delete process.env.DD_API_KEY;
    delete process.env.DD_SITE;
    // No credential of any kind reachable (env cleared above) -> kvSecret("datadog-api-key") resolves
    // null on every path -> ddMetric must report a real, diagnosable failure, not silently return ok.
    let fetchCalled = false;
    const result = await withStubbedFetch(
      async () => { fetchCalled = true; return { ok: true, text: async () => "{}" }; },
      () => ddMetric("otc.fleet.test_metric", 1),
    );
    assert.equal(result.ok, false);
    assert.match(result.error, /datadog-api-key did not resolve/);
    assert.equal(fetchCalled, false, "must not attempt a submission it has no key for");
  });
});
