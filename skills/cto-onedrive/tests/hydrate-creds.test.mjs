// Regression gate: skills/cto-onedrive's Graph app-credential resolution must work when Azure Key
// Vault is unreachable, must never silently swallow a missing credential, and must not regress back
// to shelling out to the Key-Vault-only setup/get-secret.mjs.
//
// Context (2026-08-18). cto-onedrive.mjs used to hydrate GRAPH_MAIL_CLIENT_ID/SECRET/TENANT_ID by
// execFileSync-ing setup/get-secret.mjs, which talks to Azure Key Vault kv-otc-55c84f6bef ONLY -- no
// fallback of any kind. That vault (and the whole subscription under it) was PERMANENTLY DELETED
// 2026-08-13. Every call failed, the failure was swallowed by a bare try/catch that returned '', and
// the underlying engine then reported only "Missing env GRAPH_MAIL_TENANT_ID" -- true, but silent
// about the real cause and about the fact the credential was sitting the whole time in the AWS SSM
// mirror the evacuation created. The fix replaces that hand-rolled Key-Vault-only path with the SAME
// kvSecret() resolver every already-migrated fleet skill uses (Key Vault -> AWS SSM fallback).
//
// Fully hermetic. The first group exercises hydrateGraphCreds()'s own logic through an injected fake
// resolver (no network, no real secret store). The second group exercises the REAL kvSecret() import
// end-to-end with only fetch stubbed, so it is real proof the SSM code path resolves credentials, not
// just proof the wrapper calls whatever function it is handed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { hydrateGraphCreds, describeMissingCredsError, GRAPH_CRED_MAP } from "../cto-onedrive.mjs";

// ============================== group 1: hydrateGraphCreds() logic, injected fake resolver =========

test("hydrateGraphCreds(): resolves all three creds when none are already set", async () => {
  const calls = [];
  const fakeKv = async (id) => { calls.push(id); return `value-for-${id}`; };
  const { env, missing } = await hydrateGraphCreds({}, fakeKv);
  assert.deepEqual(missing, []);
  assert.equal(env.GRAPH_MAIL_CLIENT_ID, "value-for-graph-mail-client-id");
  assert.equal(env.GRAPH_MAIL_CLIENT_SECRET, "value-for-graph-mail-client-secret");
  assert.equal(env.GRAPH_MAIL_TENANT_ID, "value-for-graph-mail-tenant-id");
  assert.deepEqual(calls.sort(), Object.values(GRAPH_CRED_MAP).sort());
});

test("hydrateGraphCreds(): an already-set env var wins and the resolver is never called for it (explicit override honored)", async () => {
  let clientIdCalled = false;
  const fakeKv = async (id) => {
    if (id === "graph-mail-client-id") clientIdCalled = true;
    return `value-for-${id}`;
  };
  const { env, missing } = await hydrateGraphCreds({ GRAPH_MAIL_CLIENT_ID: "already-set-value" }, fakeKv);
  assert.equal(env.GRAPH_MAIL_CLIENT_ID, "already-set-value");
  assert.equal(clientIdCalled, false, "the resolver must not be consulted when the env already carries a value");
  assert.deepEqual(missing, []);
});

test("hydrateGraphCreds(): does NOT mutate the base env object it was handed", async () => {
  const base = { EXISTING: "untouched" };
  const fakeKv = async (id) => `v-${id}`;
  const { env } = await hydrateGraphCreds(base, fakeKv);
  assert.deepEqual(base, { EXISTING: "untouched" }, "base env must be left exactly as passed in");
  assert.equal(env.EXISTING, "untouched", "the returned env must still carry the caller's other vars");
  assert.notEqual(env, base, "must return a new object, not the same reference");
});

test("hydrateGraphCreds(): a credential BOTH stores fail to resolve is reported by its SECRET id (not the env var name) in `missing`, and its env var is left unset -- a loud, named gap rather than a silent empty string", async () => {
  const fakeKv = async (id) => (id === "graph-mail-client-secret" ? null : `value-for-${id}`);
  const { env, missing } = await hydrateGraphCreds({}, fakeKv);
  assert.deepEqual(missing, ["graph-mail-client-secret"]);
  assert.equal(env.GRAPH_MAIL_CLIENT_SECRET, undefined, "an unresolved credential must never become an empty-string placeholder");
  assert.equal(env.GRAPH_MAIL_CLIENT_ID, "value-for-graph-mail-client-id", "the other two credentials still resolve independently");
});

test("hydrateGraphCreds(): ALL THREE unresolved -> all three named in `missing`, in map order", async () => {
  const fakeKv = async () => null;
  const { missing } = await hydrateGraphCreds({}, fakeKv);
  assert.deepEqual(missing, Object.values(GRAPH_CRED_MAP));
});

test("describeMissingCredsError(): names every missing secret id explicitly, so the failure is diagnosable without re-reading source", () => {
  const msg = describeMissingCredsError(["graph-mail-tenant-id", "graph-mail-client-secret"]);
  assert.match(msg, /graph-mail-tenant-id/);
  assert.match(msg, /graph-mail-client-secret/);
  assert.match(msg, /FATAL/, "must read as an unambiguous failure, not an informational note");
});

// ============================== group 2: REAL kvSecret() end to end, only fetch stubbed =============
// Proves the wrapper is wired to the actual shared resolver (not just to whatever fake a unit test
// hands it), and that credential resolution genuinely succeeds via the AWS SSM leg when the Key Vault
// leg has no credential to authenticate with -- the exact post-evacuation shape.

const AZURE_AUTH_KEYS = ["IDENTITY_ENDPOINT", "IDENTITY_HEADER", "AZURE_UAMI_CLIENT_ID", "AZURE_SP_TENANT_ID", "AZURE_SP_CLIENT_ID", "AZURE_SP_CLIENT_SECRET"];
const AWS_AUTH_KEYS = ["AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", "AWS_CONTAINER_CREDENTIALS_FULL_URI", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "OTC_AWS_ACCESS_KEY_ID", "OTC_AWS_SECRET_ACCESS_KEY", "OTC_AWS_SESSION_TOKEN"];
const ALL_KEYS = [...AZURE_AUTH_KEYS, ...AWS_AUTH_KEYS, "SECRET_BACKEND"];

async function withEnv(overrides, run) {
  const saved = {};
  for (const k of ALL_KEYS) saved[k] = process.env[k];
  for (const k of ALL_KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(overrides)) process.env[k] = v;
  try {
    return await run();
  } finally {
    for (const k of ALL_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

async function withStubbedFetch(stub, run) {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

// A GetParameter request body looks like {"Name":"/otchealth/<id>","WithDecryption":true}.
function ssmValueFor(name) {
  const id = name.replace(/^\/otchealth\//, "");
  return `ssm-value-for-${id}`;
}
const ssmOnlyStub = async (url, opts) => {
  const u = String(url);
  if (u.includes("ssm.")) {
    const body = JSON.parse(opts.body);
    return { status: 200, ok: true, text: async () => JSON.stringify({ Parameter: { Value: ssmValueFor(body.Name) } }) };
  }
  throw new Error("unexpected fetch (Key Vault has no credential to authenticate with) to " + u);
};

test("hydrateGraphCreds() with the REAL kvSecret resolver: resolves all three creds via the AWS SSM leg when Key Vault has no usable credential (the live post-evacuation shape)", async () => {
  await withEnv({ AWS_ACCESS_KEY_ID: "AKIAFAKE", AWS_SECRET_ACCESS_KEY: "fakefakefakefakefakefakefakefakefakefake" }, async () => {
    const { env, missing } = await withStubbedFetch(ssmOnlyStub, () => hydrateGraphCreds({}));
    assert.deepEqual(missing, []);
    assert.equal(env.GRAPH_MAIL_CLIENT_ID, "ssm-value-for-graph-mail-client-id");
    assert.equal(env.GRAPH_MAIL_CLIENT_SECRET, "ssm-value-for-graph-mail-client-secret");
    assert.equal(env.GRAPH_MAIL_TENANT_ID, "ssm-value-for-graph-mail-tenant-id");
  });
});

test("hydrateGraphCreds() with the REAL kvSecret resolver: BOTH stores unreachable -> all three named in `missing`, no thrown exception, no partially-hydrated env", async () => {
  await withEnv({}, async () => {
    // No AWS creds either -> the SSM leg's ssmCall() sees no credential and returns status 0 without
    // ever needing fetch; the Key Vault leg has no token either. Nothing should call fetch at all.
    const { env, missing } = await withStubbedFetch(async (url) => { throw new Error("must not be called: neither store has a credential to authenticate with, url=" + url); }, () => hydrateGraphCreds({}));
    assert.deepEqual(missing.sort(), Object.values(GRAPH_CRED_MAP).sort());
    assert.equal(env.GRAPH_MAIL_CLIENT_ID, undefined);
    assert.equal(env.GRAPH_MAIL_CLIENT_SECRET, undefined);
    assert.equal(env.GRAPH_MAIL_TENANT_ID, undefined);
  });
});

// ============================== counterfactual: pins the fix against silent reintroduction ===========

test("the SHIPPED cto-onedrive.mjs resolves credentials via the shared kvSecret() resolver, not by shelling out to the Key-Vault-only setup/get-secret.mjs", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../cto-onedrive.mjs", import.meta.url), "utf8");
  // Strip full-line comments before the negative checks: the header comment DESCRIBES the old
  // get-secret.mjs path (for context on why the fix exists), which would otherwise false-positive
  // this exact guard the moment someone documents the history it is meant to prevent recurring.
  const code = src.replace(/^\s*\/\/.*$/gm, "");
  assert.match(src, /from ['"]\.\.\/kb-memory\/azure-secret\.mjs['"]/, "must import the shared kvSecret resolver");
  assert.match(src, /kvSecret\(/, "must actually call kvSecret");
  assert.doesNotMatch(code, /get-secret\.mjs/, "must not reintroduce the Key-Vault-only setup/get-secret.mjs path in executable code");
  assert.doesNotMatch(code, /execFileSync/, "must not reintroduce the subprocess-per-secret hydration this fix removed");
});
