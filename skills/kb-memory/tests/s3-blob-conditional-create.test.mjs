// Tests for createObjectIfAbsentInS3 (skills/kb-memory/s3-blob.mjs), added 2026-08-27 to back the S3
// conditional-create lock skills/xero/xero-token.mjs uses to replace its dead Azure Blob
// If-None-Match lock (see that file's header comment). Same NEVER-real-network convention as the
// sibling s3-blob-*.test.mjs files in this directory: every fetch-touching test stubs
// globalThis.fetch (save/restore).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createObjectIfAbsentInS3, _resetCredsCacheForTests } from "../s3-blob.mjs";

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

test("createObjectIfAbsentInS3 sends If-None-Match: * and reports created:true on a successful (201) create", async () => {
  let captured = null;
  const result = await withEnv(FAKE_CREDS, () =>
    withStubbedFetch(async (url, opts) => {
      captured = { url: String(url), headers: opts.headers };
      return { ok: true, status: 201, headers: new Map([["etag", '"lock-etag"']]), text: async () => "" };
    }, () => createObjectIfAbsentInS3("otchealthcfodata", "cfo-source-docs", "xero-token-cache/otchealth.lock", JSON.stringify({ holder: "h1" }), "application/json")));
  assert.deepEqual(result, { created: true, etag: '"lock-etag"' });
  assert.ok(captured, "fetch must have been called");
  assert.equal(captured.headers["if-none-match"] ?? captured.headers["If-None-Match"], "*");
});

test("createObjectIfAbsentInS3 reports created:false (does NOT throw) on a 412 -- the lock is already held by someone else", async () => {
  const result = await withEnv(FAKE_CREDS, () =>
    withStubbedFetch(async () => ({ ok: false, status: 412, headers: new Map(), text: async () => "<Error><Code>PreconditionFailed</Code></Error>" }),
      () => createObjectIfAbsentInS3("otchealthcfodata", "cfo-source-docs", "xero-token-cache/otchealth.lock", "{}", "application/json")));
  assert.deepEqual(result, { created: false });
});

test("createObjectIfAbsentInS3 THROWS on a real infra failure (e.g. 403), never reports it as a held lock", async () => {
  await withEnv(FAKE_CREDS, () =>
    withStubbedFetch(async () => ({ ok: false, status: 403, headers: new Map(), text: async () => "<Error><Code>AccessDenied</Code></Error>" }),
      () => assert.rejects(
        () => createObjectIfAbsentInS3("otchealthcfodata", "cfo-source-docs", "xero-token-cache/otchealth.lock", "{}", "application/json"),
        (e) => { assert.equal(e.status, 403); return true; },
      )));
});

test("createObjectIfAbsentInS3 refuses an unmapped (account, container) pair rather than guessing a bucket", async () => {
  await assert.rejects(
    () => createObjectIfAbsentInS3("no-such-account", "no-such-container", "x.lock", "{}", "application/json"),
    /no S3 mirror mapping/,
  );
});

// ---- the concurrency invariant itself: two true contenders racing the SAME key, exactly one wins ----
test("two concurrent createObjectIfAbsentInS3 calls against the IDENTICAL key: exactly one gets created:true", async () => {
  // A minimal, stateful fake of "the S3 layer" for this one key: a Map standing in for the object
  // store. The check-and-set inside the PUT branch has no `await` between reading `store.has(key)`
  // and writing to it, so it is atomic with respect to the JS event loop no matter how many
  // "concurrent" promises are in flight -- which is exactly the property real S3's server-side
  // conditional write also provides (one authoritative store, not two racing clients guessing).
  const store = new Map();
  const attempts = [];
  const fetchStub = async (url, opts) => {
    const path = new URL(String(url)).pathname;
    const ifNoneMatch = opts.headers["if-none-match"];
    attempts.push({ path, ifNoneMatch });
    if (ifNoneMatch === "*" && store.has(path)) {
      return { ok: false, status: 412, headers: new Map(), text: async () => "conflict" };
    }
    store.set(path, opts.body);
    return { ok: true, status: 201, headers: new Map([["etag", `"etag-${store.size}"`]]), text: async () => "" };
  };
  const [a, b] = await withEnv(FAKE_CREDS, () =>
    withStubbedFetch(fetchStub, () => Promise.all([
      createObjectIfAbsentInS3("otchealthcfodata", "cfo-source-docs", "xero-token-cache/race.lock", JSON.stringify({ holder: "contender-A" }), "application/json"),
      createObjectIfAbsentInS3("otchealthcfodata", "cfo-source-docs", "xero-token-cache/race.lock", JSON.stringify({ holder: "contender-B" }), "application/json"),
    ])));
  const results = [a, b];
  const winners = results.filter((r) => r.created === true);
  const losers = results.filter((r) => r.created === false);
  assert.equal(winners.length, 1, `exactly one contender must win the lock (got ${JSON.stringify(results)})`);
  assert.equal(losers.length, 1, `exactly one contender must lose the lock (got ${JSON.stringify(results)})`);
  assert.equal(attempts.length, 2, "both contenders must have actually attempted the conditional create");
  assert.equal(store.size, 1, "the lock key must hold exactly one object, never overwritten by the loser");
});
