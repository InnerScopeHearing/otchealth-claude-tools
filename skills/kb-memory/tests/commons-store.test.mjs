// Tests for skills/kb-memory/commons-store.mjs -- the shared otchealthcommons/company-journal
// facade five skills now route through (2026-08-27 S3 port: setup/heartbeat.mjs,
// fleet-dispatch/dispatch.mjs, fleet-medic/medic.mjs, sunset-protocol/protocol.mjs,
// fleet-search/search.mjs). These are cheap, hermetic, no-network tests: the module is a thin
// re-export layer over s3-blob.mjs, so the useful thing to pin here is that it targets the RIGHT
// (account, container) and offers the RIGHT shape, not to re-test s3-blob.mjs's own wire protocol
// (already covered by skills/kb-memory/tests/s3-blob-*.test.mjs and s3-mirror-table.test.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as CommonsStore from "../commons-store.mjs";
import { s3LocationFor } from "../s3-blob.mjs";

test("commons-store targets the SAME (account, container) as the MIRROR's commons row -- otchealthcommons/company-journal", () => {
  const loc = s3LocationFor("otchealthcommons", "company-journal");
  assert.ok(loc, "the commons row must exist in the MIRROR table at all");
  assert.equal(loc.bucket, "otchealth-brain-dr-55c84f6b");
  assert.equal(loc.keyPrefix, "otchealthcommons/company-journal/");
});

test("commons-store exports exactly the facade functions the five ported callers expect", () => {
  for (const fn of ["cGet", "cGetMeta", "cPut", "cPutCond", "cDel", "cList", "cListMeta", "commonsConfigured"]) {
    assert.equal(typeof CommonsStore[fn], "function", `commons-store must export ${fn}`);
  }
});

test("cPutCond builds an If-None-Match:* header when no ETag is supplied (create-only semantics)", async () => {
  // Route through the SAME s3-blob.mjs entry point cPutCond calls, but stub fetch so no network call
  // happens; assert the headers actually sent match blobwrite.mjs's condHeaders() contract.
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), headers: opts && opts.headers });
    return new Response("", { status: 201, headers: { etag: '"abc"' } });
  };
  const originalEnv = { ...process.env };
  process.env.AWS_ACCESS_KEY_ID = "AKIAUNITTESTFAKE0000";
  process.env.AWS_SECRET_ACCESS_KEY = "unit-test-fake-secret-access-key-not-real";
  delete process.env.AWS_SESSION_TOKEN;
  try {
    const { _resetCredsCacheForTests } = await import("../s3-blob.mjs");
    _resetCredsCacheForTests();
    await CommonsStore.cPutCond("_TEST/probe.json", "{}", "application/json", null);
    assert.equal(calls.length, 1, "exactly one PUT should have gone out");
    assert.equal(calls[0].headers["if-none-match"], "*", "no-etag write must be a create-only conditional PUT");
  } finally {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
    const { _resetCredsCacheForTests } = await import("../s3-blob.mjs");
    _resetCredsCacheForTests();
  }
});
