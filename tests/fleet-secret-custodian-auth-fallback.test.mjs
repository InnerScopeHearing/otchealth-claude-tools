// Regression gate for fleet-secret-custodian's auth-fallback + rollback safety (Wave 3, 3.6 hardening).
//
// Context: the CTO review of "auto-merge login-match" for fleet-medic + fleet-secret-custodian found NO
// auto-merge mechanism anywhere in either skill (fleet-medic only ever writes a self-heal directive blob
// + a PostHog event; custodian.mjs never touches GitHub at all). The concrete gap found instead was in
// custodian.mjs's rotate() rollback path: after a failed readback-verify (or a failed audit-log append),
// the code called kvSetVersionEnabled(newVer.id, false) to disable the bad new secret version, but NEVER
// checked whether that disable call itself succeeded. If Key Vault auth had failed for the SAME reason
// the rotation is being rolled back (e.g. every auth path -- managed identity + SP client_credentials --
// unavailable), the disable silently no-oped and the code still recorded/implied "ROLLED_BACK", when the
// bad, unverified secret version could still be the enabled, readable one. These tests pin the fix: the
// new safeguardDisable() wrapper never reports success unless the disable is actually confirmed, and the
// underlying auth-fallback resolvers (identityToken/spToken/tokenFor) resolve cleanly to null/false when
// every path is unavailable -- never a truthy value built from a missing credential.
//
// Fully hermetic: no real Key Vault, no real ARM, no real network. Every test that needs "every auth path
// unavailable" explicitly clears the relevant env vars for its own duration (save/restore), so this file
// is correct regardless of what Azure credentials happen to be present in the ambient sandbox.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  identityToken,
  spToken,
  tokenFor,
  kvSetVersionEnabled,
  safeguardDisable,
  classify,
  ROTATABLE_BY_CUSTODIAN,
} from "../skills/fleet-secret-custodian/custodian.mjs";

// Every env var any of the three auth paths (managed identity, SP client_credentials, az-CLI/OIDC) reads.
// az-CLI has no env gate (it shells out to the `az` binary), so the "all paths fail" guarantee for that
// path rests on `az` being absent from PATH in this sandbox, same assumption every other fleet test makes.
const AUTH_ENV_KEYS = ["IDENTITY_ENDPOINT", "IDENTITY_HEADER", "AZURE_UAMI_CLIENT_ID", "AZURE_SP_TENANT_ID", "AZURE_SP_CLIENT_ID", "AZURE_SP_CLIENT_SECRET"];

async function withEnvCleared(keys, run) {
  const saved = {};
  for (const k of keys) { saved[k] = process.env[k]; delete process.env[k]; }
  try {
    return await run();
  } finally {
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}

async function withStubbedFetch(stub, run) {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try { return await run(); } finally { globalThis.fetch = original; }
}

// ============================== auth-fallback resolvers: all paths absent -> null/false, no network ==
test("identityToken(): no IDENTITY_ENDPOINT/IDENTITY_HEADER -> null without ever calling fetch", async () => {
  await withEnvCleared(AUTH_ENV_KEYS, async () => {
    let fetchCalled = false;
    const tok = await withStubbedFetch(async () => { fetchCalled = true; return { ok: false }; }, () => identityToken("https://vault.azure.net"));
    assert.equal(tok, null);
    assert.equal(fetchCalled, false, "must bail on missing env before attempting a network call");
  });
});

test("spToken(): no AZURE_SP_* -> null without ever calling fetch", async () => {
  await withEnvCleared(AUTH_ENV_KEYS, async () => {
    let fetchCalled = false;
    const tok = await withStubbedFetch(async () => { fetchCalled = true; return { ok: false }; }, () => spToken("https://vault.azure.net"));
    assert.equal(tok, null);
    assert.equal(fetchCalled, false, "must bail on missing env before attempting a network call");
  });
});

test("tokenFor(): every path's env absent -> null (the az-CLI path fails closed too, since az is not on PATH in this sandbox)", async () => {
  await withEnvCleared(AUTH_ENV_KEYS, async () => {
    const tok = await tokenFor("https://vault.azure.net");
    assert.equal(tok, null);
  });
});

test("tokenFor(): a stubbed-denied network still resolves null (never a truthy token from a rejected credential)", async () => {
  await withEnvCleared(AUTH_ENV_KEYS, async () => {
    const tok = await withStubbedFetch(async () => ({ ok: false, status: 401, json: async () => ({}) }), () => tokenFor("https://vault.azure.net"));
    assert.equal(tok, null);
  });
});

// ============================== kvSetVersionEnabled: never silently "succeeds" with no credential =====
test("kvSetVersionEnabled(): every auth path unavailable -> false (never attempts the PATCH, never assumes success)", async () => {
  await withEnvCleared(AUTH_ENV_KEYS, async () => {
    const ok = await kvSetVersionEnabled("https://kv-otc-55c84f6bef.vault.azure.net/secrets/fake-secret/fakever", false);
    assert.equal(ok, false);
  });
});

// ============================== safeguardDisable: the fail-safe rollback wrapper ========================
test("safeguardDisable(): every auth path unavailable -> {disabled:false, reason} -- the caller can never mistake this for a completed rollback", async () => {
  await withEnvCleared(AUTH_ENV_KEYS, async () => {
    const sg = await safeguardDisable("https://kv-otc-55c84f6bef.vault.azure.net/secrets/fake-secret/fakever", "test version");
    assert.equal(sg.disabled, false);
    assert.ok(sg.reason && sg.reason.length > 0, "a false disable must always carry a non-empty reason for the audit trail");
  });
});

test("safeguardDisable(): a missing version id fails closed immediately with an explicit reason (never silently a no-op success)", async () => {
  const sg = await safeguardDisable(null, "test version");
  assert.deepEqual(sg, { disabled: false, reason: "no version id to disable" });
});

test("safeguardDisable(): a genuinely successful disable reports {disabled:true, reason:null} (positive case, so the negative case above is meaningful)", async () => {
  await withEnvCleared(AUTH_ENV_KEYS, async () => {
    process.env.AZURE_SP_TENANT_ID = "t"; process.env.AZURE_SP_CLIENT_ID = "c"; process.env.AZURE_SP_CLIENT_SECRET = "s";
    const sg = await withStubbedFetch(async (url) => {
      const u = String(url);
      if (u.includes("login.microsoftonline.com")) return { ok: true, json: async () => ({ access_token: "fake-token" }) };
      if (u.includes(".vault.azure.net/")) return { ok: true, json: async () => ({}) };
      throw new Error("unexpected fetch to " + u);
    }, () => safeguardDisable("https://kv-otc-55c84f6bef.vault.azure.net/secrets/fake-secret/fakever", "test version"));
    assert.deepEqual(sg, { disabled: true, reason: null });
  });
});

// ============================== classify(): fail-closed default for the rotation gate ===================
test("classify(): an unrecognized secret name is 'unknown' and is NEVER in the custodian-rotatable set (fail-closed default -- a new secret is never guessed as safe to auto-rotate)", () => {
  const cls = classify("some-brand-new-secret-nobody-has-classified-yet");
  assert.equal(cls.category, "unknown");
  assert.equal(ROTATABLE_BY_CUSTODIAN.has(cls.category), false);
});

test("classify(): only a-azure-native is in ROTATABLE_BY_CUSTODIAN (Tier-1 autonomous scope; everything else -- including owner-token-keeper and tier3-out-of-scope -- is refused)", () => {
  assert.deepEqual([...ROTATABLE_BY_CUSTODIAN], ["a-azure-native"]);
  assert.equal(ROTATABLE_BY_CUSTODIAN.has(classify("xero-refresh-token-otchealth").category), false);
  assert.equal(ROTATABLE_BY_CUSTODIAN.has(classify("asc-api-key-p8").category), false);
});
