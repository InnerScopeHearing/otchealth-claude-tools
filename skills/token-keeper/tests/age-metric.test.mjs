// Tests for the otc.fleet.token_age_hours wiring in skills/token-keeper/keeper.mjs. Datadog monitor
// 22896070 ("Credential health -- rotating token aging toward idle-expiry") has watched this metric
// since 2026-06-27 with nothing ever emitting it (repo-wide grep, zero hits, before this change).
// These tests exercise the pure age math and the emit-wiring, with no real Key Vault or Datadog
// network calls (emitAgeMetrics takes an injectable emitter; computeAgeRows takes an injectable
// provider registry so the real PROVIDERS config's secret-id mapping is covered without depending on
// keeper.mjs's private constant).
import { test } from "node:test";
import assert from "node:assert/strict";
import { ageHours, computeAgeRows, emitAgeMetrics } from "../keeper.mjs";

// A miniature stand-in for the real PROVIDERS registry, covering the two shapes that matter here:
// single-tenant oauth-rotating (xero), multi-tenant oauth-rotating (quickbooks), and a non-rotating
// kind (mercury) that must never produce an age row even if status() somehow reported a lastRefresh
// for it (defense in depth: only oauth-rotating providers can be trusted to mean what the timestamp says).
const FAKE_PROVIDERS = {
  xero: { kind: "oauth-rotating", refreshSecret: "xero-refresh-token" },
  quickbooks: { kind: "oauth-rotating", tenants: ["otchealth", "innd"], refreshSecretFor: (t) => `qbo-refresh-${t}` },
  mercury: { kind: "static-token", apiToken: "mercury-api-token" },
};

test("ageHours: null (never a fabricated 0) when there is no recorded last-refresh", () => {
  assert.equal(ageHours(null), null);
  assert.equal(ageHours(undefined), null);
  assert.equal(ageHours(""), null);
  assert.equal(ageHours("not-a-real-timestamp"), null);
});

test("ageHours: computes real elapsed hours from an ISO timestamp", () => {
  const now = Date.parse("2026-08-18T12:00:00Z");
  assert.equal(ageHours("2026-08-18T10:00:00Z", now), 2);
  assert.equal(ageHours("2026-08-17T12:00:00Z", now), 24);
  assert.equal(ageHours("2026-08-11T12:00:00Z", now), 168); // 7 days
});

test("ageHours: never negative (clock-skew / future-timestamp safety)", () => {
  const now = Date.parse("2026-08-18T12:00:00Z");
  assert.equal(ageHours("2026-08-18T13:00:00Z", now), 0);
});

test("computeAgeRows: single-tenant provider (xero) reports one row keyed by its real refresh-token secret id", () => {
  const now = Date.parse("2026-08-18T12:00:00Z");
  const rows = computeAgeRows([{ provider: "xero", lastRefresh: "2026-08-18T06:00:00Z" }], now, FAKE_PROVIDERS);
  assert.deepEqual(rows, [{ secret: "xero-refresh-token", provider: "xero", ageHours: 6 }]);
});

test("computeAgeRows: multi-tenant provider (quickbooks) fans out to one row PER TENANT'S real secret id -- matches monitor 22896070's `by {secret}` grouping", () => {
  const now = Date.parse("2026-08-18T12:00:00Z");
  const rows = computeAgeRows([{ provider: "quickbooks", lastRefresh: "2026-08-17T12:00:00Z" }], now, FAKE_PROVIDERS);
  assert.deepEqual(rows, [
    { secret: "qbo-refresh-otchealth", provider: "quickbooks", ageHours: 24 },
    { secret: "qbo-refresh-innd", provider: "quickbooks", ageHours: 24 },
  ]);
});

test("computeAgeRows: drops providers with no lastRefresh yet (does not fabricate an age for a never-rotated credential)", () => {
  const now = Date.parse("2026-08-18T12:00:00Z");
  const rows = computeAgeRows(
    [
      { provider: "xero", lastRefresh: null },
      { provider: "quickbooks", lastRefresh: undefined },
    ],
    now,
    FAKE_PROVIDERS,
  );
  assert.deepEqual(rows, []);
});

test("computeAgeRows: a non-oauth-rotating provider (mercury) never produces a row, even if lastRefresh were somehow set (defense in depth)", () => {
  const now = Date.parse("2026-08-18T12:00:00Z");
  const rows = computeAgeRows([{ provider: "mercury", lastRefresh: "2026-08-18T06:00:00Z" }], now, FAKE_PROVIDERS);
  assert.deepEqual(rows, []);
});

test("computeAgeRows: an unknown provider name (registry drift) is dropped, not thrown on", () => {
  const now = Date.parse("2026-08-18T12:00:00Z");
  const rows = computeAgeRows([{ provider: "not-a-real-provider", lastRefresh: "2026-08-18T06:00:00Z" }], now, FAKE_PROVIDERS);
  assert.deepEqual(rows, []);
});

test("emitAgeMetrics: forwards each row to the injected emitter with the real metric name + secret/provider tags (matches the monitor's `by {secret}` query)", async () => {
  const calls = [];
  const fakeEmit = async (metric, value, tags) => { calls.push({ metric, value, tags }); return true; };
  await emitAgeMetrics([{ secret: "xero-refresh-token", provider: "xero", ageHours: 6 }], fakeEmit);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].metric, "otc.fleet.token_age_hours");
  assert.equal(calls[0].value, 6);
  assert.deepEqual(calls[0].tags, ["secret:xero-refresh-token", "provider:xero"]);
});

test("emitAgeMetrics: partial failure is reported precisely -- never collapses 'some failed' into a false overall success", async () => {
  const fakeEmit = async (metric, value, tags) => tags[0] === "secret:xero-refresh-token"; // xero ok, qbo-otchealth fails
  const result = await emitAgeMetrics(
    [
      { secret: "xero-refresh-token", provider: "xero", ageHours: 6 },
      { secret: "qbo-refresh-otchealth", provider: "quickbooks", ageHours: 100 },
    ],
    fakeEmit,
  );
  assert.deepEqual(result.emitted, ["xero-refresh-token"]);
  assert.deepEqual(result.failed, ["qbo-refresh-otchealth"]);
});

test("emitAgeMetrics: empty input makes zero calls and reports zero of everything (no phantom emits)", async () => {
  let called = false;
  const fakeEmit = async () => { called = true; return true; };
  const result = await emitAgeMetrics([], fakeEmit);
  assert.equal(called, false);
  assert.deepEqual(result, { emitted: [], failed: [] });
});

test("keeper.mjs wires the REAL ddEmitMetric as emitAgeMetrics' default emitter, not a stub or a bare fire-and-forget (source check -- deliberately avoids a real network/Key-Vault round trip in the test suite)", async () => {
  const src = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../keeper.mjs", import.meta.url), "utf8"));
  assert.match(src, /import\s*\{\s*ddEmitMetric\s*\}\s*from\s*["']\.\.\/datadog\/dd-emit\.mjs["']/, "must import the shared honest emitter");
  assert.match(src, /emitFn\s*=\s*ddEmitMetric/, "emitAgeMetrics must default to the real ddEmitMetric, not a local stand-in");
  assert.match(src, /computeAgeRows\(await status\(tok\)\)/, "the CLI must actually call computeAgeRows against live status(), not a fixture");
  assert.match(src, /emitAgeMetrics\(ageRows\)/, "the `refresh` command must actually call emitAgeMetrics, not just define it unused");
});
