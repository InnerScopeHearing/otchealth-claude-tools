// Tests for the gh-app.mjs hardening (2026-07-17): bounded timeout, retry classification, and the
// session-local installation-token cache. Fully offline -- fetch is stubbed and GITHUB_APP_* creds
// are supplied via env, which wins first in cred()/loadSigningCreds()/loadInstallationId(), so no
// Key Vault or GCP Secret Manager call ever happens here. The cache directory is redirected to a
// fresh mkdtemp per test via GH_APP_TOKEN_CACHE_DIR so tests never touch a real os.tmpdir() file or
// collide with each other or with a real cached token from an actual session.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname } from "node:path";
import {
  isTokenFresh,
  shouldRetry,
  exchangeInstallationToken,
  installationToken,
  cacheFilePath,
} from "../gh-app.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const GH_APP_MJS = join(HERE, "..", "gh-app.mjs");

// A test-only "signed JWT". exchangeInstallationToken never verifies it locally (GitHub would), so
// any string works here -- keeps the retry/cache tests free of real RSA key generation.
const FAKE_JWT = "header.payload.signature";

async function withStubbedFetch(stub, run) {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try { return await run(); } finally { globalThis.fetch = original; }
}

// HARD RAIL: match the stubbed host by EXACT hostname, never substring .includes (CodeQL flags
// substring host matching as a request-forgery smell even in a test-only mock router).
function githubRouter(handler) {
  return async (url, init) => {
    const u = new URL(String(url));
    assert.equal(u.hostname, "api.github.com", `test fetch stub only expects api.github.com, got ${u.hostname}`);
    return handler(u, init);
  };
}

function githubTokenResponse(overrides = {}) {
  return {
    token: "ghs_faketoken123",
    expires_at: new Date(Date.now() + 55 * 60 * 1000).toISOString(), // ~55min out, like a real GH App token
    permissions: { contents: "write" },
    repository_selection: "selected",
    ...overrides,
  };
}

// ================================================================== pure: isTokenFresh ====
test("isTokenFresh: true with comfortable margin left, false once within the margin or past expiry", () => {
  const now = Date.parse("2026-01-01T00:00:00Z");
  const margin = 5 * 60 * 1000;
  assert.equal(isTokenFresh("2026-01-01T01:00:00Z", now, margin), true, "1h out, 5min margin -> fresh");
  assert.equal(isTokenFresh("2026-01-01T00:04:00Z", now, margin), false, "4min out, 5min margin -> NOT fresh (within margin)");
  assert.equal(isTokenFresh("2026-01-01T00:05:00Z", now, margin), false, "exactly at the margin boundary -> NOT fresh (strict >)");
  assert.equal(isTokenFresh("2025-12-31T23:00:00Z", now, margin), false, "already expired -> NOT fresh");
});

test("isTokenFresh: accepts a millisecond-epoch number as well as an ISO string", () => {
  const now = 1_000_000;
  assert.equal(isTokenFresh(now + 10 * 60 * 1000, now, 5 * 60 * 1000), true);
  assert.equal(isTokenFresh(now + 1000, now, 5 * 60 * 1000), false);
});

test("isTokenFresh: never trusts a missing or unparsable expiry", () => {
  assert.equal(isTokenFresh(undefined), false);
  assert.equal(isTokenFresh(null), false);
  assert.equal(isTokenFresh(""), false);
  assert.equal(isTokenFresh("not-a-date"), false);
});

// ================================================================== pure: shouldRetry ====
test("shouldRetry: retries network errors/timeouts regardless of any status", () => {
  assert.equal(shouldRetry(undefined, true), true);
  assert.equal(shouldRetry(500, true), true);
  assert.equal(shouldRetry(401, true), true);
});

test("shouldRetry: retries any 5xx", () => {
  for (const s of [500, 502, 503, 504, 599]) assert.equal(shouldRetry(s, false), true, `status ${s}`);
});

test("shouldRetry: NEVER retries a 4xx -- a real auth/client error must fail loud immediately", () => {
  for (const s of [400, 401, 403, 404, 422, 429]) assert.equal(shouldRetry(s, false), false, `status ${s}`);
});

test("shouldRetry: no retry on a clean 2xx/3xx (nothing to retry)", () => {
  assert.equal(shouldRetry(200, false), false);
  assert.equal(shouldRetry(301, false), false);
});

// ================================================================== exchangeInstallationToken ====
test("exchangeInstallationToken: retries on 5xx then succeeds (tiny backoff so the test stays fast)", async () => {
  let calls = 0;
  const result = await withStubbedFetch(
    githubRouter(async () => {
      calls++;
      if (calls < 3) return new Response("server trouble", { status: 502 });
      return new Response(JSON.stringify(githubTokenResponse()), { status: 200 });
    }),
    () => exchangeInstallationToken(FAKE_JWT, "12345", { retryDelaysMs: [5, 5, 5] }),
  );
  assert.equal(calls, 3, "must retry twice (502, 502) then succeed on the 3rd attempt");
  assert.equal(result.token, "ghs_faketoken123");
});

test("exchangeInstallationToken: retries a network error (fetch throws) then succeeds", async () => {
  let calls = 0;
  const result = await withStubbedFetch(
    githubRouter(async () => {
      calls++;
      if (calls === 1) throw new Error("ECONNRESET");
      return new Response(JSON.stringify(githubTokenResponse()), { status: 200 });
    }),
    () => exchangeInstallationToken(FAKE_JWT, "12345", { retryDelaysMs: [5, 5, 5] }),
  );
  assert.equal(calls, 2);
  assert.equal(result.token, "ghs_faketoken123");
});

test("exchangeInstallationToken: NEVER retries a 4xx -- fails loud on the very first attempt", async () => {
  let calls = 0;
  await withStubbedFetch(
    githubRouter(async () => { calls++; return new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 }); }),
    async () => {
      await assert.rejects(
        () => exchangeInstallationToken(FAKE_JWT, "12345", { retryDelaysMs: [5, 5, 5] }),
        /installation token 401/,
      );
    },
  );
  assert.equal(calls, 1, "a 401 must fail on the first attempt, never retried");
});

test("exchangeInstallationToken: exhausts retries and throws the last error when every attempt fails", async () => {
  let calls = 0;
  await withStubbedFetch(
    githubRouter(async () => { calls++; return new Response("down", { status: 503 }); }),
    async () => {
      await assert.rejects(
        () => exchangeInstallationToken(FAKE_JWT, "12345", { retryDelaysMs: [5, 5] }),
        /installation token 503/,
      );
    },
  );
  assert.equal(calls, 3, "3 total attempts = 1 initial + 2 retries (retryDelaysMs has 2 entries)");
});

test("exchangeInstallationToken: a stalled connection aborts at the timeout with a clear, fast error (not a multi-minute hang)", async () => {
  const start = Date.now();
  await withStubbedFetch(
    githubRouter((u, init) => new Promise((_resolve, reject) => {
      // Never resolves on its own -- only the AbortController timeout can end this, exactly the
      // reported bug shape (a stalled network path with no bound).
      init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    })),
    async () => {
      await assert.rejects(
        () => exchangeInstallationToken(FAKE_JWT, "12345", { timeoutMs: 30, retryDelaysMs: [] }),
        /timed out after 30ms/,
      );
    },
  );
  assert.ok(Date.now() - start < 2000, "must fail fast (well under 2s), never hang");
});

// ================================================================== installationToken: cache ====
function withTempCacheDir(run) {
  const dir = mkdtempSync(join(tmpdir(), "gh-app-token-test-"));
  const saved = {
    GH_APP_TOKEN_CACHE_DIR: process.env.GH_APP_TOKEN_CACHE_DIR,
    GITHUB_APP_INSTALLATION_ID: process.env.GITHUB_APP_INSTALLATION_ID,
    GITHUB_APP_ID: process.env.GITHUB_APP_ID,
    GITHUB_APP_PRIVATE_KEY: process.env.GITHUB_APP_PRIVATE_KEY,
  };
  process.env.GH_APP_TOKEN_CACHE_DIR = dir;
  process.env.GITHUB_APP_INSTALLATION_ID = "999999";
  process.env.GITHUB_APP_ID = "test-app-id";
  // Only ever needed on an actual mint (a cache miss); any non-empty string is fine for the tests
  // that never reach appJwt(), and the "cache HIT never touches the key" test relies on this being
  // an INVALID key on purpose.
  process.env.GITHUB_APP_PRIVATE_KEY = TEST_PEM;
  return (async () => {
    try {
      return await run(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  })();
}

// A real (throwaway, test-only) RSA key so appJwt()'s crypto.createSign(...).sign() succeeds on the
// cache-MISS/actual-mint tests below. Generated once at module load; gh-app.mjs itself never sees
// this key, it only exists to make the test's fake "mint" path exercise real RSA signing.
const { privateKey: TEST_PEM } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

test("installationToken: cache MISS mints once and persists a chmod-600 cache file keyed by installation id", async () => {
  await withTempCacheDir(async (dir) => {
    let calls = 0;
    const t = await withStubbedFetch(
      githubRouter(async () => { calls++; return new Response(JSON.stringify(githubTokenResponse()), { status: 200 }); }),
      () => installationToken(),
    );
    assert.equal(calls, 1);
    assert.equal(t.token, "ghs_faketoken123");
    const file = cacheFilePath("999999");
    assert.ok(file.startsWith(dir), "cache file must live under GH_APP_TOKEN_CACHE_DIR");
    assert.ok(existsSync(file), "cache file must exist after a mint");
    const mode = statSync(file).mode & 0o777;
    assert.equal(mode, 0o600, "cache file must be chmod 600");
    const persisted = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(persisted.token, "ghs_faketoken123");
  });
});

test("installationToken: cache HIT reuses the token with zero additional fetch calls and never touches the signing key", async () => {
  await withTempCacheDir(async () => {
    let calls = 0;
    const router = githubRouter(async () => { calls++; return new Response(JSON.stringify(githubTokenResponse()), { status: 200 }); });
    await withStubbedFetch(router, () => installationToken()); // primes the cache
    assert.equal(calls, 1);
    // Break the signing key so a mint (if attempted) would throw when appJwt() tries to sign with
    // it -- proves the cache-hit path never resolves signing creds, not just that it happens to
    // skip the network call.
    process.env.GITHUB_APP_PRIVATE_KEY = "not-a-real-key";
    const t2 = await withStubbedFetch(router, () => installationToken());
    assert.equal(calls, 1, "a fresh cache hit must not call fetch again");
    assert.equal(t2.token, "ghs_faketoken123");
  });
});

test("installationToken: --no-cache always mints fresh and never reads or writes the cache", async () => {
  await withTempCacheDir(async () => {
    let calls = 0;
    const router = githubRouter(async () => { calls++; return new Response(JSON.stringify(githubTokenResponse()), { status: 200 }); });
    await withStubbedFetch(router, () => installationToken({ noCache: true }));
    await withStubbedFetch(router, () => installationToken({ noCache: true }));
    assert.equal(calls, 2, "noCache must mint on every call, ignoring any existing cache");
    assert.equal(existsSync(cacheFilePath("999999")), false, "noCache must never write a cache file");
  });
});

test("installationToken: a stale cached token (within the 5min reuse margin) triggers a fresh mint", async () => {
  await withTempCacheDir(async () => {
    // Pre-seed a cache file that is technically not-yet-expired but inside the reuse margin.
    const file = cacheFilePath("999999");
    writeFileSync(file, JSON.stringify(githubTokenResponse({ token: "ghs_stale", expires_at: new Date(Date.now() + 60 * 1000).toISOString() })), { mode: 0o600 });
    let calls = 0;
    const t = await withStubbedFetch(
      githubRouter(async () => { calls++; return new Response(JSON.stringify(githubTokenResponse({ token: "ghs_fresh" })), { status: 200 }); }),
      () => installationToken(),
    );
    assert.equal(calls, 1, "a stale (within-margin) cache entry must not be reused");
    assert.equal(t.token, "ghs_fresh");
  });
});

// ================================================================== CLI contract / isMain guard ====
test("CLI: unknown command still exits 2 with the usage line (the isMain guard didn't break direct invocation)", () => {
  try {
    execFileSync("node", [GH_APP_MJS, "bogus-command"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    assert.fail("expected a non-zero exit");
  } catch (e) {
    assert.equal(e.status, 2);
    assert.match(e.stderr, /commands: token \| verify/);
  }
});

test("sanity: importing gh-app.mjs for these tests does not itself dispatch a CLI command", () => {
  // If this file's top-level `if (isMain)` block ever ran during `import`, the module load above
  // would already have called process.exit(2) (no argv command) and this test would never run.
  assert.equal(typeof isTokenFresh, "function");
  assert.equal(pathToFileURL(GH_APP_MJS).href.endsWith("gh-app.mjs"), true);
});
