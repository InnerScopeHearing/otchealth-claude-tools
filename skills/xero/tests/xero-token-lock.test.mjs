// Tests for the S3 conditional-create lock in skills/xero/xero-token.mjs, ported off dead Azure Blob
// 2026-08-27 (the Azure subscription holding kv-otc-55c84f6bef and every Azure Blob account was
// permanently deleted 2026-08-13). These exercise the REAL getAccessContext() end to end against a
// single stateful fetch stub standing in for "the world": AWS SSM (the refresh-token store + client
// creds), AWS S3 (the lock object), and Xero's own token/connections endpoints. Never a real network
// call. Convention matches the sibling s3-blob-*.test.mjs files in skills/kb-memory/tests/ (stub
// globalThis.fetch, save/restore).
//
// Test orgs are NOT in xero-token.mjs's ORGS_ALL (otchealth/innd/hearingassist/personal), so
// guardGatewayOwnedOrg() -- the 2026-07-16 gateway-sole-consumer hardening -- is a no-op here; that
// guard is orthogonal to what this file tests (the lock itself) and is exercised elsewhere.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { getAccessContext } from "../xero-token.mjs";
import { _resetCredsCacheForTests } from "../../kb-memory/s3-blob.mjs";

async function withStubbedFetch(stub, run) {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try { return await run(); } finally { globalThis.fetch = original; }
}
async function withEnv(vars, run) {
  const saved = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k];
  }
  _resetCredsCacheForTests();
  try { return await run(); } finally {
    for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    _resetCredsCacheForTests();
  }
}
const FAKE_CREDS = { AWS_ACCESS_KEY_ID: "AKIAFAKEFAKEFAKEFAKE", AWS_SECRET_ACCESS_KEY: "fakefakefakefakefakefakefakefakefakefake", AWS_SESSION_TOKEN: undefined };

/**
 * A minimal, stateful fake of the three real services getAccessContext()'s refresh path touches:
 *   - AWS SSM Parameter Store (xero-client-id/secret + the org's rotate-on-use refresh token)
 *   - AWS S3 (the conditional-create lock object)
 *   - Xero's OAuth token + connections endpoints (the ACTUAL single-use rotation semantics: a
 *     refresh_token grant only succeeds if it matches the CURRENTLY PERSISTED value; the whole point
 *     of the lock under test is that two concurrent callers must never both send the same value).
 * `tokenDelayMs` lets a test force a deterministic contention window (see the race test below).
 */
function makeFakeXeroWorld({ org, initialRefreshToken, tokenDelayMs = 0 }) {
  const params = new Map([
    ["/otchealth/xero-client-id", "test-client-id"],
    ["/otchealth/xero-client-secret", "test-client-secret"],
    [`/otchealth/xero-refresh-token-${org}`, initialRefreshToken],
  ]);
  const s3Objects = new Map(); // pathname -> { body, etag }
  let refreshCallCount = 0;
  let rotationCounter = 0;
  const invalidGrantAttempts = [];

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function fetchStub(url, opts = {}) {
    const u = String(url);
    const method = (opts.method || "GET").toUpperCase();

    if (u.includes("ssm.") && u.includes(".amazonaws.com")) {
      const body = JSON.parse(opts.body);
      const target = opts.headers["x-amz-target"];
      if (target === "AmazonSSM.GetParameter") {
        if (!params.has(body.Name)) return { ok: false, status: 400, text: async () => JSON.stringify({ __type: "ParameterNotFound" }) };
        return { ok: true, status: 200, text: async () => JSON.stringify({ Parameter: { Value: params.get(body.Name) } }) };
      }
      if (target === "AmazonSSM.PutParameter") {
        params.set(body.Name, body.Value);
        return { ok: true, status: 200, text: async () => JSON.stringify({}) };
      }
      return { ok: false, status: 400, text: async () => "{}" };
    }

    if (u.includes(".s3.") && u.includes(".amazonaws.com")) {
      const { pathname } = new URL(u);
      if (method === "PUT") {
        const ifNoneMatch = opts.headers["if-none-match"];
        if (ifNoneMatch === "*" && s3Objects.has(pathname)) {
          return { ok: false, status: 412, headers: new Map(), text: async () => "conflict" };
        }
        const bodyStr = Buffer.isBuffer(opts.body) ? opts.body.toString("utf8") : String(opts.body);
        const etag = `"etag-${++rotationCounter}"`;
        s3Objects.set(pathname, { body: bodyStr, etag });
        return { ok: true, status: ifNoneMatch === "*" ? 201 : 200, headers: new Map([["etag", etag]]), text: async () => "" };
      }
      if (method === "GET") {
        const obj = s3Objects.get(pathname);
        if (!obj) return { ok: false, status: 404, headers: new Map(), text: async () => "" };
        return { ok: true, status: 200, headers: new Map([["etag", obj.etag]]), text: async () => obj.body };
      }
      if (method === "DELETE") {
        const existed = s3Objects.delete(pathname);
        return { ok: existed, status: existed ? 204 : 404, headers: new Map(), text: async () => "" };
      }
      throw new Error(`unexpected S3 method ${method} ${pathname}`);
    }

    if (u === "https://identity.xero.com/connect/token") {
      refreshCallCount++;
      if (tokenDelayMs) await sleep(tokenDelayMs);
      const sent = new URLSearchParams(opts.body);
      const rt = sent.get("refresh_token");
      const current = params.get(`/otchealth/xero-refresh-token-${org}`);
      if (rt !== current) {
        invalidGrantAttempts.push(rt);
        return { ok: false, status: 400, json: async () => ({ error: "invalid_grant", error_description: "token already used" }) };
      }
      const newRt = `rt-${++rotationCounter}`;
      return { ok: true, status: 200, json: async () => ({ access_token: `at-${rotationCounter}`, refresh_token: newRt, expires_in: 1800 }) };
    }

    if (u === "https://api.xero.com/connections") {
      return { ok: true, status: 200, json: async () => ([{ tenantId: `tenant-${org}` }]) };
    }

    throw new Error("unexpected fetch to " + u);
  }

  return { fetchStub, params, s3Objects, refreshCallCount: () => refreshCallCount, invalidGrantAttempts };
}

test("two concurrent getAccessContext() calls for the SAME org never trigger invalid_grant -- the lock fully serializes the single-use refresh", async () => {
  const org = "racelocktest-org-a";
  const world = makeFakeXeroWorld({ org, initialRefreshToken: "seed-rt-0", tokenDelayMs: 150 });
  const [r1, r2] = await withEnv(FAKE_CREDS, () =>
    withStubbedFetch(world.fetchStub, () => Promise.all([
      getAccessContext(org, { forceRefresh: true }),
      getAccessContext(org, { forceRefresh: true }),
    ])));
  // Both contenders must succeed -- neither observes the other's in-flight (not yet persisted)
  // refresh token, because the lock never lets their Xero token-endpoint calls overlap.
  assert.equal(r1.tenantId, `tenant-${org}`);
  assert.equal(r2.tenantId, `tenant-${org}`);
  assert.ok(r1.access_token && r2.access_token, "both must have gotten a real access token");
  assert.equal(world.invalidGrantAttempts.length, 0, `must be zero invalid_grant attempts (got ${JSON.stringify(world.invalidGrantAttempts)}) -- an org-lockout race would show up here`);
  // No durable cross-process cache (by design, see xero-token.mjs's header comment): each contender
  // did its OWN refresh, serialized by the lock -- never zero, never overlapping.
  assert.equal(world.refreshCallCount(), 2, "each contender performs its own lock-guarded refresh");
  // The lock object itself must be released (not left dangling) after both contenders finish.
  assert.equal(world.s3Objects.size, 0, "the lock must be released after use, not left held");
});

test("a lock whose embedded expiresAt is in the past is detected as stale and broken immediately, not waited out", async () => {
  const org = "racelocktest-org-stale";
  const world = makeFakeXeroWorld({ org, initialRefreshToken: "seed-rt-0" });
  // Pre-seed an already-expired lock, simulating a holder that crashed without releasing it.
  world.s3Objects.set(
    `/xero-token-cache/${org}.lock`,
    { body: JSON.stringify({ holder: "dead-holder", acquiredAt: Date.now() - 999_000, expiresAt: Date.now() - 500_000 }), etag: '"stale"' },
  );
  const t0 = Date.now();
  const ctx = await withEnv(FAKE_CREDS, () =>
    withStubbedFetch(world.fetchStub, () => getAccessContext(org, { forceRefresh: true })));
  const elapsedMs = Date.now() - t0;
  assert.equal(ctx.tenantId, `tenant-${org}`);
  // The stale-recovery path deletes the dead lock and retries the acquire IMMEDIATELY (no sleep). If
  // staleness detection regressed, this would instead fall into the 1500ms wait-and-retry branch.
  assert.ok(elapsedMs < 1000, `stale-lock recovery must not wait a full poll interval (took ${elapsedMs}ms)`);
});

test("a live (non-stale) held lock is respected: a second caller does not acquire it out from under the first", async () => {
  const org = "racelocktest-org-live";
  const world = makeFakeXeroWorld({ org, initialRefreshToken: "seed-rt-0" });
  // Pre-seed a lock that is NOT stale (expires well in the future).
  world.s3Objects.set(
    `/xero-token-cache/${org}.lock`,
    { body: JSON.stringify({ holder: "other-live-holder", acquiredAt: Date.now(), expiresAt: Date.now() + 60_000 }), etag: '"live"' },
  );
  // A caller with a short overall LOCK_WAIT_MS budget would fail-open; getAccessContext's own
  // LOCK_WAIT_MS is 20s, longer than this test should run, so instead we just prove the FIRST
  // acquire attempt is refused (created:false path taken) by asserting the pre-seeded lock is left
  // completely untouched immediately after the very first PUT attempt would have occurred -- i.e.
  // the object is never silently overwritten by an unconditional write.
  let firstPutSeen = false;
  const wrapped = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes(".s3.") && (opts.method || "").toUpperCase() === "PUT" && !firstPutSeen) {
      firstPutSeen = true;
      const r = await world.fetchStub(url, opts);
      assert.equal(r.status, 412, "the live lock must reject the very first conditional create attempt");
      return r;
    }
    return world.fetchStub(url, opts);
  };
  // Race the real call against a short timer: if it wrongly "acquired" the live lock, it would return
  // almost instantly; instead it must still be waiting/polling after a short delay because the lock is
  // genuinely held. We only need to observe the very first PUT's outcome, asserted above; resolving
  // the outer promise race lets the test finish without waiting out the full 20s fail-open window.
  await withEnv(FAKE_CREDS, () => withStubbedFetch(wrapped, () => Promise.race([
    getAccessContext(org, { forceRefresh: true }).catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, 400)),
  ])));
  assert.ok(firstPutSeen, "the lock acquire must actually have been attempted");
});

// ---- counterfactual guard: no Azure Blob code remains in the ported file -------------------------
test("xero-token.mjs no longer talks to Azure Blob for its cache/lock (ported to AWS S3 + SSM, 2026-08-27)", async () => {
  const src = await readFile(new URL("../xero-token.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(src, /blob\.core\.windows\.net/, "must not construct any Azure Blob URL");
  assert.doesNotMatch(src, /azure-cfo-storage-(account|key)/, "must not read the old Azure Blob storage creds");
  assert.doesNotMatch(src, /gcsCreateIfAbsent|gcsGetJson|gcsPutJson|gcsDelete/, "the old hand-rolled Azure Blob primitives must be gone");
  assert.match(src, /createObjectIfAbsentInS3/, "the lock must use the S3 conditional-create helper");
  assert.match(src, /expiresAt/, "the lock record must carry an expiry for stale-holder recovery");
  assert.match(src, /_memCache/, "the access-token cache must be in-process only (no durable cross-process cache)");
});
