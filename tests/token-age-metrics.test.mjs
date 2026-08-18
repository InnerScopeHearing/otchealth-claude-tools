// rotatingSecrets() is the pure core of token-age-metrics.mjs: it decides WHICH secret ids the
// otc.fleet.token_age_hours emitter is allowed to speak for. Getting this wrong in either direction
// is a real failure -- too narrow silently loses coverage of a real idle-expiry risk (the original
// bug this monitor exists to catch), too broad emits a dishonest age for a gateway-owned or static
// credential (see token-age-metrics.mjs's header for the Xero/Mercury/Plaid/Amazon reasoning). These
// tests pin both directions.
import { test } from "node:test";
import assert from "node:assert/strict";
import { rotatingSecrets } from "../skills/token-keeper/token-age-metrics.mjs";
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
