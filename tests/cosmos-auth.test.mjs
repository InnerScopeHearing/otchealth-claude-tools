// Regression + safety gate for skills/kb-memory/cosmos-auth.mjs, the shared Cosmos
// Authorization-header builder for the 4 background-job Cosmos REST clients (cosmos-memory-read.mjs,
// decision-clock/cosmos-client.mjs, signal-radar/common.mjs, doc-indexer/job/agent-state-janitor.mjs).
// Every case here passes an explicit `env` object rather than mutating process.env, so this file is
// fully hermetic (no real network, no global state leaking across cases) regardless of whether
// node:test happens to run *.test.mjs files in-process or as separate subprocesses.
//
// Load-bearing guarantees pinned here:
//   1. key mode (COSMOS_AUTH_MODE unset, the default, or any non-'aad' value) is BYTE-FOR-BYTE the
//      pre-existing master-key HMAC header every one of the 4 job clients built inline before this
//      file existed -- the #1 requirement, since these are live cron jobs.
//   2. aad mode (COSMOS_AUTH_MODE=aad + an identity sidecar present) mints via IDENTITY_ENDPOINT and
//      returns the type=aad&ver=1.0&sig=<raw token> shape, caching the token across calls.
//   3. aad mode with the sidecar present but the mint itself failing throws loudly -- never silently
//      falls back to the key (masking a real RBAC/config problem would be worse than a hard failure).
//   4. the dual-context fallback: aad mode requested but no identity sidecar at all (an interactive
//      dev session, not a job) falls back to key mode and never touches the network.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  keyAuthToken,
  aadAuthToken,
  resolveAuthMode,
  hasIdentitySidecar,
  cosmosAuthHeader,
  _resetAadTokenCacheForTests,
} from "../skills/kb-memory/cosmos-auth.mjs";

const FIXED_VERB = "GET";
const FIXED_RESTYPE = "docs";
const FIXED_RESOURCE_LINK = "dbs/agent-state/colls/memory/docs/testid123";
const FIXED_DATE = "Wed, 01 Jan 2026 00:00:00 GMT";
const FIXED_MASTER_KEY = "c3VwZXItc2VjcmV0LW1hc3Rlci1rZXktbm90LXJlYWw="; // base64("super-secret-master-key-not-real")
// Independently precomputed (node:crypto, verb/resType/resourceLink/date/key exactly as above) --
// a TRUE pin, not just "equals whatever the module under test currently produces".
const PINNED_KEY_MODE_HEADER = "type%3Dmaster%26ver%3D1.0%26sig%3D%2FkItSFTY6t9Vnrl%2F%2Flx7QlaYdluMF3EDDha42Ye09Zg%3D";
const DEFAULT_JOBS_UAMI_CLIENT_ID = "01b82248-86b1-4237-a8f3-8317cf9d5f33"; // id-otc-jobs-kv

async function withStubbedFetch(stub, run) {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

// ---------------------------------------------------------------- pure helpers ----
test("keyAuthToken(): pinned master-key HMAC header for fixed inputs (regression pin -- changing this changes the wire auth format every job Cosmos client relies on)", () => {
  assert.equal(keyAuthToken(FIXED_VERB, FIXED_RESTYPE, FIXED_RESOURCE_LINK, FIXED_DATE, FIXED_MASTER_KEY), PINNED_KEY_MODE_HEADER);
});

test("aadAuthToken(): url-encodes type=aad&ver=1.0&sig=<token> with the raw token bytes verbatim, no HMAC", () => {
  assert.equal(aadAuthToken("abc.def-123"), "type%3Daad%26ver%3D1.0%26sig%3Dabc.def-123");
});

test("resolveAuthMode(): only exactly 'aad' (case-insensitive) resolves to aad; every other value (unset, 'key', typo'd) is key", () => {
  assert.equal(resolveAuthMode({}), "key");
  assert.equal(resolveAuthMode(undefined), "key");
  assert.equal(resolveAuthMode({ COSMOS_AUTH_MODE: "aad" }), "aad");
  assert.equal(resolveAuthMode({ COSMOS_AUTH_MODE: "AAD" }), "aad");
  assert.equal(resolveAuthMode({ COSMOS_AUTH_MODE: "key" }), "key");
  assert.equal(resolveAuthMode({ COSMOS_AUTH_MODE: "master" }), "key");
});

test("hasIdentitySidecar(): true only when BOTH IDENTITY_ENDPOINT and IDENTITY_HEADER are present", () => {
  assert.equal(hasIdentitySidecar({}), false);
  assert.equal(hasIdentitySidecar({ IDENTITY_ENDPOINT: "x" }), false);
  assert.equal(hasIdentitySidecar({ IDENTITY_HEADER: "y" }), false);
  assert.equal(hasIdentitySidecar({ IDENTITY_ENDPOINT: "x", IDENTITY_HEADER: "y" }), true);
});

// ---------------------------------------------------------------- key mode (#1: inert by default) ----
test("cosmosAuthHeader(): COSMOS_AUTH_MODE unset reproduces the pinned key-mode header exactly -- byte-for-byte the pre-existing behavior of all 4 job Cosmos clients", async () => {
  const header = await cosmosAuthHeader({
    verb: FIXED_VERB, resType: FIXED_RESTYPE, resourceLink: FIXED_RESOURCE_LINK, date: FIXED_DATE, masterKey: FIXED_MASTER_KEY,
    env: {},
  });
  assert.equal(header, PINNED_KEY_MODE_HEADER);
});

test("cosmosAuthHeader(): stays key mode for 'key', mixed case, and any unrecognized/typo'd COSMOS_AUTH_MODE value", async () => {
  for (const mode of ["key", "KEY", "", "master", "typo", undefined]) {
    const header = await cosmosAuthHeader({
      verb: FIXED_VERB, resType: FIXED_RESTYPE, resourceLink: FIXED_RESOURCE_LINK, date: FIXED_DATE, masterKey: FIXED_MASTER_KEY,
      env: { COSMOS_AUTH_MODE: mode },
    });
    assert.equal(header, PINNED_KEY_MODE_HEADER, `mode=${JSON.stringify(mode)} must stay key-mode`);
  }
});

// ---------------------------------------------------------------- aad mode (#2: the new path) ----
test("cosmosAuthHeader(): aad mode with an identity sidecar present mints via IDENTITY_ENDPOINT and returns type=aad&ver=1.0&sig=<token>, caching the token across calls", async () => {
  _resetAadTokenCacheForTests();
  const FAKE_TOKEN = "fake.managed.identity.access.token.abc123";
  let identityCalls = 0;
  let capturedUrl = "";
  let capturedHeaders = {};
  const env = {
    COSMOS_AUTH_MODE: "aad",
    IDENTITY_ENDPOINT: "http://fake-identity.example.invalid/msi/token",
    IDENTITY_HEADER: "fake-identity-header-secret",
  };
  await withStubbedFetch(
    async (url, init) => {
      identityCalls++;
      capturedUrl = String(url);
      capturedHeaders = (init && init.headers) || {};
      return new Response(
        JSON.stringify({ access_token: FAKE_TOKEN, expires_on: String(Math.floor(Date.now() / 1000) + 3600) }),
        { status: 200 },
      );
    },
    async () => {
      const header1 = await cosmosAuthHeader({ verb: FIXED_VERB, resType: FIXED_RESTYPE, resourceLink: FIXED_RESOURCE_LINK, date: FIXED_DATE, masterKey: "unused-in-aad-mode", env });
      assert.equal(header1, aadAuthToken(FAKE_TOKEN));
      assert.ok(header1.startsWith("type%3Daad%26ver%3D1.0%26sig%3D"), "must be aad-shaped");
      assert.ok(!header1.startsWith("type%3Dmaster"), "must never be the master-key shape in aad mode");
      assert.ok(header1.includes(FAKE_TOKEN), "sig must carry the raw token bytes verbatim, not an HMAC digest");

      assert.equal(identityCalls, 1);
      assert.ok(capturedUrl.startsWith(env.IDENTITY_ENDPOINT), "must call this process's own IDENTITY_ENDPOINT");
      assert.ok(capturedUrl.includes("resource=https%3A%2F%2Fcosmos.azure.com"), "must request the first-party Cosmos resource, not a per-account audience");
      assert.ok(capturedUrl.includes(`client_id=${DEFAULT_JOBS_UAMI_CLIENT_ID}`), "must default to the jobs UAMI client id (id-otc-jobs-kv)");
      assert.equal(capturedHeaders["X-IDENTITY-HEADER"], "fake-identity-header-secret");

      // second call must reuse the cached token -- exactly one identity-token mint for two calls
      const header2 = await cosmosAuthHeader({ verb: FIXED_VERB, resType: FIXED_RESTYPE, resourceLink: FIXED_RESOURCE_LINK, date: FIXED_DATE, masterKey: "unused-in-aad-mode", env });
      assert.equal(header2, header1);
      assert.equal(identityCalls, 1, "the second call must reuse the in-module cached token");
    },
  );
  _resetAadTokenCacheForTests();
});

test("cosmosAuthHeader(): aad mode honors an AZURE_JOBS_UAMI_CLIENT_ID override instead of the default jobs UAMI client id", async () => {
  _resetAadTokenCacheForTests();
  let capturedUrl = "";
  const overrideId = "11111111-2222-3333-4444-555555555555";
  const env = {
    COSMOS_AUTH_MODE: "aad",
    IDENTITY_ENDPOINT: "http://fake-identity.example.invalid/msi/token",
    IDENTITY_HEADER: "h",
    AZURE_JOBS_UAMI_CLIENT_ID: overrideId,
  };
  await withStubbedFetch(
    async (url) => {
      capturedUrl = String(url);
      return new Response(JSON.stringify({ access_token: "tok", expires_on: String(Math.floor(Date.now() / 1000) + 3600) }), { status: 200 });
    },
    async () => {
      await cosmosAuthHeader({ verb: FIXED_VERB, resType: FIXED_RESTYPE, resourceLink: FIXED_RESOURCE_LINK, date: FIXED_DATE, masterKey: "unused", env });
    },
  );
  assert.ok(capturedUrl.includes(`client_id=${overrideId}`));
  assert.ok(!capturedUrl.includes(DEFAULT_JOBS_UAMI_CLIENT_ID));
  _resetAadTokenCacheForTests();
});

// ---------------------------------------------------------------- #3: fail loud, never silent-fallback ----
test("cosmosAuthHeader(): aad mode with the sidecar present but the token mint FAILS throws a clear cosmos-auth error and never silently falls back to the key", async () => {
  _resetAadTokenCacheForTests();
  let identityCalls = 0;
  const env = {
    COSMOS_AUTH_MODE: "aad",
    IDENTITY_ENDPOINT: "http://fake-identity.example.invalid/msi/token",
    IDENTITY_HEADER: "fake-identity-header-secret",
  };
  await withStubbedFetch(
    async () => {
      identityCalls++;
      return new Response('{"error":"identity_unavailable"}', { status: 403 });
    },
    async () => {
      await assert.rejects(
        () => cosmosAuthHeader({ verb: FIXED_VERB, resType: FIXED_RESTYPE, resourceLink: FIXED_RESOURCE_LINK, date: FIXED_DATE, masterKey: FIXED_MASTER_KEY, env }),
        (err) => {
          assert.match(err.message, /cosmos-auth/);
          assert.match(err.message, /403/);
          return true;
        },
      );
    },
  );
  assert.equal(identityCalls, 1, "a non-retryable 403 should mean exactly one identity-token attempt, and the failure must not be retried into a fallback");
  _resetAadTokenCacheForTests();
});

// ---------------------------------------------------------------- #4: dual-context fallback ----
test("cosmosAuthHeader(): dual-context fallback -- COSMOS_AUTH_MODE=aad but no identity sidecar at all (interactive/dev session) falls back to key mode and never touches the network", async () => {
  _resetAadTokenCacheForTests();
  let fetchCalls = 0;
  await withStubbedFetch(
    async () => {
      fetchCalls++;
      throw new Error("must not be called in the fallback path");
    },
    async () => {
      const header = await cosmosAuthHeader({
        verb: FIXED_VERB, resType: FIXED_RESTYPE, resourceLink: FIXED_RESOURCE_LINK, date: FIXED_DATE, masterKey: FIXED_MASTER_KEY,
        env: { COSMOS_AUTH_MODE: "aad" }, // no IDENTITY_ENDPOINT / IDENTITY_HEADER at all
      });
      assert.equal(header, PINNED_KEY_MODE_HEADER, "must fall back to the exact same key-mode header");
    },
  );
  assert.equal(fetchCalls, 0, "the fallback path must never touch the network");
});

test("cosmosAuthHeader(): dual-context fallback also applies with only ONE of IDENTITY_ENDPOINT/IDENTITY_HEADER set (a partial sidecar is not a sidecar)", async () => {
  _resetAadTokenCacheForTests();
  let fetchCalls = 0;
  await withStubbedFetch(
    async () => {
      fetchCalls++;
      throw new Error("must not be called");
    },
    async () => {
      const header = await cosmosAuthHeader({
        verb: FIXED_VERB, resType: FIXED_RESTYPE, resourceLink: FIXED_RESOURCE_LINK, date: FIXED_DATE, masterKey: FIXED_MASTER_KEY,
        env: { COSMOS_AUTH_MODE: "aad", IDENTITY_ENDPOINT: "http://only-endpoint.invalid" },
      });
      assert.equal(header, PINNED_KEY_MODE_HEADER);
    },
  );
  assert.equal(fetchCalls, 0);
});
