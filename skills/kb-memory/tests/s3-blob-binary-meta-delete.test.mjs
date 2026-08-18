// Tests for the three functions added to skills/kb-memory/s3-blob.mjs to unblock the CFO's two
// write-locked jobs (2026-08-18): getBufferFromS3 (binary-safe GET, needed because the two
// text-only readers — getTextFromS3/getTextMetaFromS3 — corrupt a PDF/xlsx/sqlite catalog by
// decoding the body as UTF-8 text), listBlobsMetaFromS3 (the size/lastModified-carrying listing the
// doc-indexer's oversize-OOM guard needs, without changing listBlobsFromS3's existing string[]
// contract that mem.mjs's cList() Set-merge already depends on), and deleteObjectFromS3 (parity for
// store.mjs's `rm` command). Same NEVER-real-network convention as s3-blob-write-path.test.mjs:
// every fetch-touching test stubs globalThis.fetch (save/restore).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getBufferFromS3,
  listBlobsFromS3,
  listBlobsMetaFromS3,
  deleteObjectFromS3,
  _resetCredsCacheForTests,
} from "../s3-blob.mjs";

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

// ---- getBufferFromS3: binary-safe, same 404/403 contract as the text readers -------------------
test("getBufferFromS3 returns null on a genuine 404 (does not throw)", async () => {
  const result = await withEnv(FAKE_CREDS, () =>
    withStubbedFetch(async () => ({ ok: false, status: 404, headers: new Map(), text: async () => "" }),
      () => getBufferFromS3("otchealthcfodata", "cfo-source-docs", "reconstruction-analysis/staged/nope.json")));
  assert.equal(result, null);
});
test("getBufferFromS3 THROWS on a 403 rather than reporting it as absent", async () => {
  await withEnv(FAKE_CREDS, () =>
    withStubbedFetch(async () => ({ ok: false, status: 403, headers: new Map(), text: async () => "<Error><Code>AccessDenied</Code></Error>" }),
      () => assert.rejects(() => getBufferFromS3("otchealthcfodata", "cfo-source-docs", "some.pdf"), /s3 get 403/)));
});
test("getBufferFromS3 returns the RAW bytes unmangled — a binary payload that is not valid UTF-8 round-trips exactly", async () => {
  // Bytes 0xFF 0xFE 0x00 0xFF are not a valid UTF-8 sequence; decoding-then-reencoding via .text()
  // would corrupt them. arrayBuffer()->Buffer must not.
  const raw = Buffer.from([0x25, 0x50, 0x44, 0x46, 0xff, 0xfe, 0x00, 0xff, 0x41]); // "%PDF" + junk + "A"
  const result = await withEnv(FAKE_CREDS, () =>
    withStubbedFetch(async () => ({ ok: true, status: 200, headers: new Map([["etag", '"x"']]), arrayBuffer: async () => raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) }),
      () => getBufferFromS3("otchealthcfodata", "cfo-source-docs", "batch.pdf")));
  assert.ok(Buffer.isBuffer(result));
  assert.deepEqual([...result], [...raw]);
});

// ---- listBlobsMetaFromS3: carries size + lastModified; listBlobsFromS3 stays name-only ----------
test("listBlobsMetaFromS3 returns size and lastModified alongside the relative name", async () => {
  const xml = `<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated>` +
    `<Contents><Key>otchealthcfodata/cfo-source-docs/reconstruction-analysis/staged/batch_a.json</Key><Size>4096</Size><LastModified>2026-08-18T18:00:00.000Z</LastModified></Contents>` +
    `</ListBucketResult>`;
  const result = await withEnv(FAKE_CREDS, () =>
    withStubbedFetch(async () => ({ ok: true, status: 200, text: async () => xml }),
      () => listBlobsMetaFromS3("otchealthcfodata", "cfo-source-docs", "reconstruction-analysis/staged/")));
  assert.deepEqual(result, [{ name: "reconstruction-analysis/staged/batch_a.json", size: 4096, lastModified: "2026-08-18T18:00:00.000Z" }]);
});
test("listBlobsFromS3 (name-only) still returns a plain string[] over the SAME underlying listing — mem.mjs's cList() Set-merge depends on this exact shape", async () => {
  const xml = `<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated>` +
    `<Contents><Key>otchealthcommons/company-journal/_MEMORY/_exec/cto.jsonl</Key><Size>123</Size><LastModified>2026-08-18T00:00:00.000Z</LastModified></Contents>` +
    `</ListBucketResult>`;
  const result = await withEnv(FAKE_CREDS, () =>
    withStubbedFetch(async () => ({ ok: true, status: 200, text: async () => xml }),
      () => listBlobsFromS3("otchealthcommons", "company-journal", "_MEMORY/_exec/")));
  assert.deepEqual(result, ["_MEMORY/_exec/cto.jsonl"]);
  for (const name of result) assert.equal(typeof name, "string", "must be plain strings, never {name,...} objects");
});
test("listBlobsMetaFromS3 throws loud on a listing failure rather than returning a false-empty result", async () => {
  await withEnv(FAKE_CREDS, () =>
    withStubbedFetch(async () => ({ ok: false, status: 403, text: async () => "<Error><Code>AccessDenied</Code></Error>" }),
      () => assert.rejects(() => listBlobsMetaFromS3("otchealthcfodata", "cfo-source-docs", "x/"), /s3 list 403/)));
});

// ---- deleteObjectFromS3: idempotent on 404, throws on real failure ------------------------------
test("deleteObjectFromS3 returns false when the object was already absent (idempotent, not an error)", async () => {
  const result = await withEnv(FAKE_CREDS, () =>
    withStubbedFetch(async () => ({ ok: false, status: 404, headers: new Map(), text: async () => "" }),
      () => deleteObjectFromS3("otchealthcfodata", "cfo-source-docs", "already-gone.json")));
  assert.equal(result, false);
});
test("deleteObjectFromS3 returns true on a real deletion", async () => {
  const result = await withEnv(FAKE_CREDS, () =>
    withStubbedFetch(async () => ({ ok: true, status: 204, headers: new Map(), text: async () => "" }),
      () => deleteObjectFromS3("otchealthcfodata", "cfo-source-docs", "gone-now.json")));
  assert.equal(result, true);
});
test("deleteObjectFromS3 throws on a real failure (e.g. a 403), never silently reports success", async () => {
  await withEnv(FAKE_CREDS, () =>
    withStubbedFetch(async () => ({ ok: false, status: 403, headers: new Map(), text: async () => "<Error><Code>AccessDenied</Code></Error>" }),
      () => assert.rejects(() => deleteObjectFromS3("otchealthcfodata", "cfo-source-docs", "protected.json"), /s3 delete 403/)));
});
