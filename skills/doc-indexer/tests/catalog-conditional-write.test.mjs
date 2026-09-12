import { test } from "node:test";
import assert from "node:assert/strict";
import { writeCatalogIfChanged } from "../catalog-conditional-write.mjs";

test("unchanged catalog bytes do not issue a write or create another source version", async () => {
  let calls = 0;
  const snapshot = { body: Buffer.from('{"path":"a"}\n'), etag: '"source-etag"', versionId: "v1" };
  const result = await writeCatalogIfChanged({
    snapshot,
    next: Buffer.from('{"path":"a"}\n'),
    write: async () => { calls++; return { etag: '"unexpected"' }; },
  });
  assert.equal(calls, 0);
  assert.equal(result.written, false);
  assert.equal(result.snapshot, snapshot);
});

test("changed catalog bytes use the source read ETag as a conditional update", async () => {
  let received;
  const next = Buffer.from('{"path":"changed"}\n');
  const result = await writeCatalogIfChanged({
    snapshot: { body: Buffer.from('{"path":"old"}\n'), etag: '"prior"', versionId: "v1" },
    next,
    write: async (body, headers) => { received = { body, headers }; return { etag: '"next"', versionId: "v2" }; },
  });
  assert.deepEqual(received, { body: next, headers: { "If-Match": '"prior"' } });
  assert.deepEqual(result, { written: true, snapshot: { body: next, etag: '"next"', versionId: "v2" } });
});

test("an absent catalog is created conditionally, never by an unconditional overwrite", async () => {
  let headers;
  await writeCatalogIfChanged({
    snapshot: { body: null, etag: null, versionId: null },
    next: Buffer.from('{"path":"first"}\n'),
    write: async (_body, actualHeaders) => { headers = actualHeaders; return { etag: '"first"', versionId: "v1" }; },
  });
  assert.deepEqual(headers, { "If-None-Match": "*" });
});

test("a changed catalog without the source ETag fails before any unsafe write", async () => {
  let calls = 0;
  await assert.rejects(() => writeCatalogIfChanged({
    snapshot: { body: Buffer.from('{"path":"old"}\n'), etag: null, versionId: "v1" },
    next: Buffer.from('{"path":"changed"}\n'),
    write: async () => { calls++; return { etag: '"new"' }; },
  }), /catalog_write_etag_missing/);
  assert.equal(calls, 0);
});
