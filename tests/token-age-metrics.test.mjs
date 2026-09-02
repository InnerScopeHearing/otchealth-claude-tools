// rotatingSecrets() is the pure core of token-age-metrics.mjs: it decides WHICH secret ids the
// otc.fleet.token_age_hours emitter is allowed to speak for. Getting this wrong in either direction
// is a real failure -- too narrow silently loses coverage of a real idle-expiry risk (the original
// bug this monitor exists to catch), too broad emits a dishonest age for a gateway-owned or static
// credential (see token-age-metrics.mjs's header for the Xero/Mercury/Plaid/Amazon reasoning). These
// tests pin both directions.
import { test } from "node:test";
import assert from "node:assert/strict";
import { rotatingSecrets, runFailed } from "../skills/token-keeper/token-age-metrics.mjs";
import { PROVIDERS as REAL_PROVIDERS } from "../skills/token-keeper/keeper.mjs";

test("every QuickBooks tenant in the registry produces a tracked secret id", () => {
  const fake = { quickbooks: { kind: "oauth-rotating", tenants: ["a", "b"], refreshSecretFor: (t) => `qbo-refresh-${t}` } };
  const ids = rotatingSecrets(fake).map((r) => r.id);
  assert.deepEqual(ids.filter((i) => i.startsWith("qbo-refresh-")).sort(), ["qbo-refresh-a", "qbo-refresh-b"]);
});

test("graph-onedrive-refresh-token is always included, even though token-keeper's own PROVIDERS does not own it", () => {
  const ids = rotatingSecrets({ quickbooks: { kind: "oauth-rotating", tenants: [], refreshSecretFor: () => "" } }).map((r) => r.id);
  assert.ok(ids.includes("graph-onedrive-refresh-token"));
});

test("Xero is NEVER emitted, even if a fake registry marks it oauth-rotating -- the gateway (not SSM) owns its live rotation since 2026-07-16", () => {
  const fake = {
    quickbooks: { kind: "oauth-rotating", tenants: ["otchealth"], refreshSecretFor: (t) => `qbo-refresh-${t}` },
    xero: { kind: "oauth-rotating", refreshSecret: "xero-refresh-token" },
  };
  const rows = rotatingSecrets(fake);
  assert.ok(!rows.some((r) => /xero/i.test(r.id) || /xero/i.test(r.label)), "xero must never appear, by construction (the function never reads providers.xero at all)");
});

test("a non-rotating provider shape (mercury/plaid, no tenants array) contributes nothing beyond graph-onedrive", () => {
  const fake = { quickbooks: { kind: "static-token" } }; // wrong kind / no tenants -> defensive no-op
  const ids = rotatingSecrets(fake).map((r) => r.id);
  assert.deepEqual(ids, ["graph-onedrive-refresh-token"]);
});

test("counterfactual: the REAL token-keeper PROVIDERS registry still has the expected quickbooks shape (kind + 4 tenants)", () => {
  // Pins the assumption rotatingSecrets() is built on. If this ever drifts (a tenant renamed/removed,
  // the kind relabeled), the function silently starts tracking the wrong set -- this test catches that
  // at the SOURCE, not just in the isolated pure-function test above.
  assert.equal(REAL_PROVIDERS.quickbooks.kind, "oauth-rotating");
  assert.deepEqual([...REAL_PROVIDERS.quickbooks.tenants].sort(), ["hearingassist", "innd", "otchealth", "personal"]);
  assert.equal(REAL_PROVIDERS.quickbooks.refreshSecretFor("otchealth"), "qbo-refresh-otchealth");
});

test("counterfactual: running rotatingSecrets() against the REAL registry never yields an xero id", () => {
  const ids = rotatingSecrets(REAL_PROVIDERS).map((r) => r.id.toLowerCase());
  assert.ok(!ids.some((i) => i.includes("xero")), "the real registry DOES mark xero oauth-rotating too -- this pins that rotatingSecrets() still excludes it by construction");
});

test("counterfactual: mercury and plaid never appear -- they are kind static-token / no-expire, never oauth-rotating", () => {
  assert.notEqual(REAL_PROVIDERS.mercury.kind, "oauth-rotating");
  assert.notEqual(REAL_PROVIDERS.plaid.kind, "oauth-rotating");
  const ids = rotatingSecrets(REAL_PROVIDERS).map((r) => r.id);
  assert.ok(!ids.some((i) => i.includes("mercury") || i.includes("plaid")));
});

// runFailed() is the run-severity decision. rotatingSecrets() above decides WHICH secrets are
// tracked; this decides whether a run that could not speak for one of them is allowed to exit 0.
// The interesting case is the third: an ABSENT expected target used to be a stderr line plus exit 0,
// so a deleted or renamed secret quietly dropped out of monitoring and the monitor stayed green
// about a secret it was no longer watching -- the exact per-secret "No Data" state this emitter was
// built to end.
test("a clean run does not fail", () => {
  assert.equal(runFailed({ failed: 0, lookupErrors: 0, notFound: 0 }), false);
  assert.equal(runFailed({}), false, "an empty summary is a clean run, not a failure");
});

test("a metric SEND failure fails the run", () => {
  assert.equal(runFailed({ failed: 1, lookupErrors: 0, notFound: 0 }), true);
});

test("an SSM LOOKUP failure fails the run (a run that could not read the ages is not a run that found nothing)", () => {
  assert.equal(runFailed({ failed: 0, lookupErrors: 1, notFound: 0 }), true);
});

test("an ABSENT expected target fails the run, alone -- counterfactual against the old failed||lookupErrors rule", () => {
  const summary = { failed: 0, lookupErrors: 0, notFound: 1 };
  assert.equal(runFailed(summary), true, "a tracked secret with no age emitted must not exit 0");
  // Pin the difference explicitly: the superseded rule returned false for exactly this summary, so
  // this assertion fails on the old code and is not merely restating the new implementation.
  const supersededRule = (s) => s.failed > 0 || s.lookupErrors > 0;
  assert.equal(supersededRule(summary), false, "the old rule tolerated a missing target -- that is the defect");
  assert.notEqual(runFailed(summary), supersededRule(summary));
});

test("all three causes together still fail the run", () => {
  assert.equal(runFailed({ failed: 2, lookupErrors: 1, notFound: 3 }), true);
});
