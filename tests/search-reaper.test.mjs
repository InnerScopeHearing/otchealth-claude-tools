// Regression gate for skills/search-reaper/reaper.mjs, the orphan search-document garbage
// collector for the Azure AI Search brain (otchealth-dataroom-s1). Pure network mocking
// (globalThis.fetch stubbed), same style as tests/fleet-backup-cosmos-export.test.mjs /
// tests/cosmos-auth.test.mjs — no real Azure calls here (a live read-only `scan` against
// legal-personal was run separately and its real numbers are reported in the PR description).
//
// Load-bearing guarantees pinned here (this is exactly the class of bug this tool exists to avoid
// causing while fixing another bug):
//   1. THE ERROR-IS-NOT-MISSING RULE: only a literal 404 counts as "the blob is gone". A thrown
//      network error, 401/403/429, and 5xx are all "error", never "missing" — so a bad key or a
//      throttle storm can never masquerade as evidence a live document should be deleted.
//   2. THE CANARY EXCLUSION: any path containing "CANARY" (case-insensitive) is never
//      existence-checked or deleted, full stop, even when its blob is confirmed 404.
//   3. BATCH CHUNKING at the 1000-action Azure Search docs/index limit.
//   4. 207 PARTIAL-FAILURE handling: a batch response's overall HTTP status does not tell you
//      which items failed — each item's own `status` boolean does.
//   5. DRY-RUN BY DEFAULT: reapIndex() without opts.commit never calls the delete endpoint.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CONTAINER_ACCOUNT_MAP,
  resolveContainerCredentials,
  oDataEscape,
  parseBlobUrl,
  isCanaryPath,
  buildAccountSas,
  chunkArray,
  buildDeleteBatch,
  parseIndexBatchResponse,
  headBlobExists,
  getIndexSources,
  listBlobBackedIndexes,
  iterateIndexDocs,
  evaluateIndex,
  scanIndex,
  reapIndex,
} from "../skills/search-reaper/reaper.mjs";

async function withStubbedFetch(stub, run) {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

function jsonResponse(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

// ============================================================== pure helpers ==============

test("oDataEscape: doubles single quotes for safe OData filter embedding", () => {
  assert.equal(oDataEscape("plain"), "plain");
  assert.equal(oDataEscape("it's a test"), "it''s a test");
  assert.equal(oDataEscape("a'''b"), "a''''''b");
});

test("parseBlobUrl: parses a real chunked-index path into account/container/blobPath", () => {
  const p = "https://otchealthlegalstore.blob.core.windows.net/personal/_TEXT/_ARCHIVE/file%20name.txt";
  const parsed = parseBlobUrl(p);
  assert.deepEqual(parsed, {
    account: "otchealthlegalstore",
    container: "personal",
    blobPath: "_TEXT/_ARCHIVE/file%20name.txt",
  });
});

test("parseBlobUrl: returns null (never throws) for a non-blob-storage or malformed URL", () => {
  assert.equal(parseBlobUrl("not a url"), null);
  assert.equal(parseBlobUrl("https://example.com/foo"), null);
  assert.equal(parseBlobUrl(""), null);
  assert.equal(parseBlobUrl(null), null);
  assert.equal(parseBlobUrl(undefined), null);
  assert.equal(parseBlobUrl(42), null);
});

test("isCanaryPath: matches CANARY case-insensitively anywhere in the path, and only then", () => {
  assert.equal(isCanaryPath("https://acct.blob.core.windows.net/c/CANARY/file.txt"), true);
  assert.equal(isCanaryPath("https://acct.blob.core.windows.net/c/canary-investigation/x.txt"), true);
  assert.equal(isCanaryPath("https://acct.blob.core.windows.net/c/CaNaRy/x.txt"), true);
  assert.equal(isCanaryPath("https://acct.blob.core.windows.net/c/normal/file.txt"), false);
  assert.equal(isCanaryPath("https://acct.blob.core.windows.net/c/canary-watch/x.txt"), true); // substring match is intentional (over-exclude, never under-exclude)
});

test("resolveContainerCredentials: returns the mapping for known containers, null for unknown", () => {
  assert.equal(resolveContainerCredentials("personal").accountFallback, "otchealthlegalstore");
  assert.equal(resolveContainerCredentials("company").accountFallback, "otchealthlegalstore");
  assert.equal(resolveContainerCredentials("cfo-source-docs").accountFallback, "otchealthcfodata");
  assert.equal(resolveContainerCredentials("commerce-source-docs").accountFallback, "otchealthcommerce");
  assert.equal(resolveContainerCredentials("company-journal").accountFallback, "otchealthcommons");
  assert.equal(resolveContainerCredentials("some-unknown-container"), null);
  assert.equal(resolveContainerCredentials(""), null);
});

test("CONTAINER_ACCOUNT_MAP: every entry has an accountSecret, keySecret, and accountFallback", () => {
  for (const [container, mapping] of Object.entries(CONTAINER_ACCOUNT_MAP)) {
    assert.ok(mapping.accountSecret, `${container} missing accountSecret`);
    assert.ok(mapping.keySecret, `${container} missing keySecret`);
    assert.ok(mapping.accountFallback, `${container} missing accountFallback`);
  }
});

test("buildAccountSas: deterministic given a fixed 'now', read-only permissions only (sp=rl)", () => {
  const now = Date.UTC(2026, 0, 1, 0, 0, 0);
  const sas1 = buildAccountSas({ account: "acct", key: Buffer.from("fakekey").toString("base64"), now });
  const sas2 = buildAccountSas({ account: "acct", key: Buffer.from("fakekey").toString("base64"), now });
  assert.equal(sas1, sas2, "same inputs must produce the same SAS (pure function)");
  const params = new URLSearchParams(sas1);
  assert.equal(params.get("sp"), "rl", "must be read+list ONLY — never write/delete on blob storage");
  assert.equal(params.get("ss"), "b");
  assert.ok(params.get("sig"), "must include a signature");
});

test("buildAccountSas: different accounts/keys/times produce different signatures", () => {
  const now = Date.now();
  const a = buildAccountSas({ account: "acct1", key: Buffer.from("key1").toString("base64"), now });
  const b = buildAccountSas({ account: "acct2", key: Buffer.from("key1").toString("base64"), now });
  assert.notEqual(a, b);
});

// ============================================================== batching / delete-response ==

test("chunkArray: chunks at the requested boundary, including an exact multiple and a remainder", () => {
  assert.deepEqual(chunkArray([1, 2, 3], 1000), [[1, 2, 3]]);
  const arr2500 = Array.from({ length: 2500 }, (_, i) => i);
  const chunks = chunkArray(arr2500, 1000);
  assert.equal(chunks.length, 3);
  assert.equal(chunks[0].length, 1000);
  assert.equal(chunks[1].length, 1000);
  assert.equal(chunks[2].length, 500);
  const arr1000 = Array.from({ length: 1000 }, (_, i) => i);
  assert.equal(chunkArray(arr1000, 1000).length, 1, "an exact multiple must not create a trailing empty batch");
  assert.equal(chunkArray([], 1000).length, 0);
});

test("buildDeleteBatch: produces one @search.action:delete entry per chunk_id, keyed correctly", () => {
  const batch = buildDeleteBatch(["a", "b", "c"]);
  assert.deepEqual(batch, {
    value: [
      { "@search.action": "delete", chunk_id: "a" },
      { "@search.action": "delete", chunk_id: "b" },
      { "@search.action": "delete", chunk_id: "c" },
    ],
  });
});

test("parseIndexBatchResponse: splits succeeded/failed on each item's own status boolean (200-shaped body)", () => {
  const body = { value: [{ key: "a", status: true, statusCode: 200 }, { key: "b", status: true, statusCode: 200 }] };
  const { succeeded, failed } = parseIndexBatchResponse(body);
  assert.deepEqual(succeeded, ["a", "b"]);
  assert.deepEqual(failed, []);
});

test("parseIndexBatchResponse: a 207 PARTIAL-FAILURE body is split per-item, not treated as all-fail or all-ok", () => {
  const body = {
    value: [
      { key: "a", status: true, statusCode: 200 },
      { key: "b", status: false, statusCode: 409, errorMessage: "conflict" },
      { key: "c", status: true, statusCode: 200 },
      { key: "d", status: false, statusCode: 503, errorMessage: "throttled" },
    ],
  };
  const { succeeded, failed } = parseIndexBatchResponse(body);
  assert.deepEqual(succeeded, ["a", "c"]);
  assert.equal(failed.length, 2);
  assert.equal(failed[0].key, "b");
  assert.equal(failed[0].errorMessage, "conflict");
  assert.equal(failed[1].key, "d");
});

test("parseIndexBatchResponse: an empty/malformed body degrades to no successes and no failures (never throws)", () => {
  assert.deepEqual(parseIndexBatchResponse({}), { succeeded: [], failed: [] });
  assert.deepEqual(parseIndexBatchResponse(null), { succeeded: [], failed: [] });
});

// ============================================================== headBlobExists: THE safety rule =

test("headBlobExists: 404 -> missing", async () => {
  const state = await headBlobExists("https://acct.blob.core.windows.net/c/b.txt", "sas=1", {
    fetchImpl: async () => ({ status: 404, ok: false }),
  });
  assert.equal(state, "missing");
});

test("headBlobExists: 200 -> exists", async () => {
  const state = await headBlobExists("https://acct.blob.core.windows.net/c/b.txt", "sas=1", {
    fetchImpl: async () => ({ status: 200, ok: true }),
  });
  assert.equal(state, "exists");
});

test("headBlobExists: 401/403/429/500 are ALL 'error', never 'missing' (the core safety invariant)", async () => {
  for (const status of [401, 403, 429, 500, 503]) {
    const state = await headBlobExists("https://acct.blob.core.windows.net/c/b.txt", "sas=1", {
      fetchImpl: async () => ({ status, ok: false }),
    });
    assert.equal(state, "error", `status ${status} must classify as 'error', not 'missing'`);
  }
});

test("headBlobExists: a thrown network error is 'error', never 'missing'", async () => {
  const state = await headBlobExists("https://acct.blob.core.windows.net/c/b.txt", "sas=1", {
    fetchImpl: async () => { throw new Error("ECONNRESET"); },
  });
  assert.equal(state, "error");
});

// ============================================================== live-shaped helpers (stubbed) ===

test("getIndexSources: joins /datasources + /indexers on dataSourceName -> targetIndexName", async () => {
  await withStubbedFetch(async (url) => {
    const u = String(url);
    if (u.includes("/datasources")) {
      return jsonResponse(200, {
        value: [
          { name: "ds-legal-personal", container: { name: "personal", query: "_TEXT" } },
          { name: "ds-legal-company", container: { name: "company", query: "_TEXT" } },
        ],
      });
    }
    if (u.includes("/indexers")) {
      return jsonResponse(200, {
        value: [
          { name: "ixr-legal-personal", dataSourceName: "ds-legal-personal", targetIndexName: "legal-personal" },
          { name: "ixr-legal-company", dataSourceName: "ds-legal-company", targetIndexName: "legal-company" },
        ],
      });
    }
    throw new Error("unexpected URL " + u);
  }, async () => {
    const sources = await getIndexSources("https://svc.search.windows.net", "key", "legal-personal");
    assert.equal(sources.length, 1);
    assert.equal(sources[0].datasource, "ds-legal-personal");
    assert.equal(sources[0].container.name, "personal");
  });
});

test("getIndexSources: an index with no matching indexer returns [] (e.g. memory-exec, not blob-backed)", async () => {
  await withStubbedFetch(async (url) => {
    const u = String(url);
    if (u.includes("/datasources")) return jsonResponse(200, { value: [] });
    if (u.includes("/indexers")) return jsonResponse(200, { value: [{ name: "ixr-x", dataSourceName: "ds-x", targetIndexName: "some-other-index" }] });
    throw new Error("unexpected URL " + u);
  }, async () => {
    const sources = await getIndexSources("https://svc.search.windows.net", "key", "memory-exec");
    assert.deepEqual(sources, []);
  });
});

test("listBlobBackedIndexes: returns the distinct set of live targetIndexName values", async () => {
  await withStubbedFetch(async () => jsonResponse(200, {
    value: [
      { targetIndexName: "legal-personal" },
      { targetIndexName: "legal-company" },
      { targetIndexName: "legal-personal" },
    ],
  }), async () => {
    const names = await listBlobBackedIndexes("https://svc.search.windows.net", "key");
    assert.deepEqual(names.sort(), ["legal-company", "legal-personal"]);
  });
});

test("iterateIndexDocs: keyset-paginates via chunk_id gt <last>, draining multiple pages with no $skip ceiling", async () => {
  const page1 = Array.from({ length: 3 }, (_, i) => ({ chunk_id: `c${i}`, path: `p${i}` }));
  const page2 = Array.from({ length: 2 }, (_, i) => ({ chunk_id: `c${i + 3}`, path: `p${i + 3}` }));
  let calls = 0;
  const seenFilters = [];
  await withStubbedFetch(async (url, init) => {
    calls++;
    const body = JSON.parse(init.body);
    seenFilters.push(body.filter || null);
    if (calls === 1) return jsonResponse(200, { value: page1 });
    if (calls === 2) return jsonResponse(200, { value: page2 });
    return jsonResponse(200, { value: [] });
  }, async () => {
    const all = [];
    for await (const page of iterateIndexDocs("https://svc.search.windows.net", "key", "idx", { pageSize: 3 })) {
      all.push(...page);
    }
    assert.equal(all.length, 5);
    assert.deepEqual(all.map((d) => d.chunk_id), ["c0", "c1", "c2", "c3", "c4"]);
    assert.equal(seenFilters[0], null, "first page has no filter");
    assert.equal(seenFilters[1], "chunk_id gt 'c2'", "second page keys off the last chunk_id of the prior page");
  });
});

test("iterateIndexDocs: a non-ok response throws with a useful message rather than silently stopping", async () => {
  await withStubbedFetch(async () => ({ ok: false, status: 500, text: async () => "boom" }), async () => {
    const gen = iterateIndexDocs("https://svc.search.windows.net", "key", "idx");
    await assert.rejects(() => gen.next(), /docs\/search idx -> 500/);
  });
});

// ============================================================== evaluateIndex / scanIndex full flow

function makeFakeIndexerStub({ docs, blobStates }) {
  // blobStates: Map<path, "exists"|"missing"|"error">
  return async (url, init) => {
    const u = String(url);
    if (u.includes("/datasources")) {
      return jsonResponse(200, { value: [{ name: "ds-x", container: { name: "personal", query: "_TEXT" } }] });
    }
    if (u.includes("/indexers")) {
      return jsonResponse(200, { value: [{ name: "ixr-x", dataSourceName: "ds-x", targetIndexName: "legal-personal" }] });
    }
    if (u.includes("/docs/search")) {
      const body = JSON.parse(init.body);
      if (!body.filter) return jsonResponse(200, { value: docs });
      return jsonResponse(200, { value: [] }); // single page for these tests
    }
    // blob HEAD check
    const path = u.split("?")[0];
    const state = blobStates.get(path) || "exists";
    if (state === "missing") return { status: 404, ok: false };
    if (state === "error") throw new Error("simulated network error");
    return { status: 200, ok: true };
  };
}

const FAKE_CREDS = async (container) => (container === "personal" ? { account: "otchealthlegalstore", key: "fakekey" } : null);

test("evaluateIndex: an index with no live indexer is reported as not blob-backed, with zero network side effects beyond the join calls", async () => {
  await withStubbedFetch(async (url) => {
    const u = String(url);
    if (u.includes("/datasources")) return jsonResponse(200, { value: [] });
    if (u.includes("/indexers")) return jsonResponse(200, { value: [] });
    throw new Error("should not reach docs/search or blob storage: " + u);
  }, async () => {
    const r = await evaluateIndex({ endpoint: "https://svc.search.windows.net", key: "key" }, "memory-exec");
    assert.equal(r.blobBacked, false);
    assert.equal(r.totalDocs, 0);
  });
});

test("evaluateIndex: classifies exists / missing / canary correctly and dedupes chunk_ids per unique path", async () => {
  const docs = [
    { chunk_id: "k1", path: "https://otchealthlegalstore.blob.core.windows.net/personal/live.txt" },
    { chunk_id: "k2", path: "https://otchealthlegalstore.blob.core.windows.net/personal/live.txt" }, // same source, 2 chunks
    { chunk_id: "k3", path: "https://otchealthlegalstore.blob.core.windows.net/personal/gone.txt" },
    { chunk_id: "k4", path: "https://otchealthlegalstore.blob.core.windows.net/personal/CANARY/watched.txt" },
  ];
  const blobStates = new Map([
    ["https://otchealthlegalstore.blob.core.windows.net/personal/live.txt", "exists"],
    ["https://otchealthlegalstore.blob.core.windows.net/personal/gone.txt", "missing"],
    // deliberately no entry for the CANARY path — if the code ever HEAD-checks it this stub
    // returns "exists" by default, so a failing exclusion would silently NOT delete it either;
    // the real assertion below is that it is never counted as missing/existing at all.
  ]);
  await withStubbedFetch(makeFakeIndexerStub({ docs, blobStates }), async () => {
    const r = await evaluateIndex(
      { endpoint: "https://svc.search.windows.net", key: "key" },
      "legal-personal",
      { resolveContainerCreds: FAKE_CREDS },
    );
    assert.equal(r.blobBacked, true);
    assert.equal(r.totalDocs, 4);
    assert.equal(r.uniquePaths, 3, "live.txt's two chunks share one path");
    assert.equal(r.existing, 1);
    assert.equal(r.missing, 1);
    assert.deepEqual(r.missingChunkIds, ["k3"]);
    assert.equal(r.canaryPaths, 1);
    assert.equal(r.canaryDocs, 1);
    assert.equal(r.errors, 0);
  });
});

test("evaluateIndex: a doc under a CANARY path that WOULD 404 is still never counted as missing and never queued for delete", async () => {
  const docs = [
    { chunk_id: "k1", path: "https://otchealthlegalstore.blob.core.windows.net/personal/CANARY/deleted-but-watched.txt" },
  ];
  const blobStates = new Map([
    ["https://otchealthlegalstore.blob.core.windows.net/personal/CANARY/deleted-but-watched.txt", "missing"],
  ]);
  await withStubbedFetch(makeFakeIndexerStub({ docs, blobStates }), async () => {
    const r = await evaluateIndex(
      { endpoint: "https://svc.search.windows.net", key: "key" },
      "legal-personal",
      { resolveContainerCreds: FAKE_CREDS },
    );
    assert.equal(r.missing, 0);
    assert.equal(r.missingChunkIds.length, 0);
    assert.equal(r.canaryPaths, 1);
    assert.equal(r.canaryDocs, 1);
  });
});

test("evaluateIndex: an existence-check ERROR is never folded into missing/missingChunkIds", async () => {
  const docs = [
    { chunk_id: "k1", path: "https://otchealthlegalstore.blob.core.windows.net/personal/flaky.txt" },
  ];
  const blobStates = new Map([
    ["https://otchealthlegalstore.blob.core.windows.net/personal/flaky.txt", "error"],
  ]);
  await withStubbedFetch(makeFakeIndexerStub({ docs, blobStates }), async () => {
    const r = await evaluateIndex(
      { endpoint: "https://svc.search.windows.net", key: "key" },
      "legal-personal",
      { resolveContainerCreds: FAKE_CREDS },
    );
    assert.equal(r.missing, 0);
    assert.equal(r.errors, 1);
    assert.deepEqual(r.missingChunkIds, []);
  });
});

test("evaluateIndex: an unresolved container credential is an error, not silently skipped as missing", async () => {
  const docs = [
    { chunk_id: "k1", path: "https://otchealthlegalstore.blob.core.windows.net/personal/x.txt" },
  ];
  await withStubbedFetch(makeFakeIndexerStub({ docs, blobStates: new Map() }), async () => {
    const r = await evaluateIndex(
      { endpoint: "https://svc.search.windows.net", key: "key" },
      "legal-personal",
      { resolveContainerCreds: async () => null }, // simulate "no credentials resolvable"
    );
    assert.equal(r.errors, 1);
    assert.equal(r.missing, 0);
  });
});

test("evaluateIndex: --prefix scopes which docs are considered at all", async () => {
  const docs = [
    { chunk_id: "k1", path: "https://otchealthlegalstore.blob.core.windows.net/personal/_TEXT/keep/a.txt" },
    { chunk_id: "k2", path: "https://otchealthlegalstore.blob.core.windows.net/personal/_TEXT/skip/b.txt" },
  ];
  await withStubbedFetch(makeFakeIndexerStub({ docs, blobStates: new Map() }), async () => {
    const r = await evaluateIndex(
      { endpoint: "https://svc.search.windows.net", key: "key" },
      "legal-personal",
      { resolveContainerCreds: FAKE_CREDS, prefix: "_TEXT/keep" },
    );
    assert.equal(r.totalDocs, 1);
  });
});

test("scanIndex: is exactly evaluateIndex under a different name (read-only surface)", async () => {
  const docs = [{ chunk_id: "k1", path: "https://otchealthlegalstore.blob.core.windows.net/personal/x.txt" }];
  await withStubbedFetch(makeFakeIndexerStub({ docs, blobStates: new Map([["https://otchealthlegalstore.blob.core.windows.net/personal/x.txt", "exists"]]) }), async () => {
    const r = await scanIndex({ endpoint: "https://svc.search.windows.net", key: "key" }, "legal-personal", { resolveContainerCreds: FAKE_CREDS });
    assert.equal(r.existing, 1);
  });
});

// ============================================================== reapIndex: dry-run + commit + batching

test("reapIndex: WITHOUT --commit, makes zero calls to the delete endpoint (docs/index) and deletes nothing", async () => {
  const docs = [
    { chunk_id: "k1", path: "https://otchealthlegalstore.blob.core.windows.net/personal/gone.txt" },
  ];
  const blobStates = new Map([["https://otchealthlegalstore.blob.core.windows.net/personal/gone.txt", "missing"]]);
  let deleteEndpointCalled = false;
  const baseStub = makeFakeIndexerStub({ docs, blobStates });
  await withStubbedFetch(async (url, init) => {
    const u = String(url);
    if (u.includes("/docs/index")) { deleteEndpointCalled = true; return jsonResponse(200, { value: [] }); }
    return baseStub(url, init);
  }, async () => {
    const r = await reapIndex(
      { endpoint: "https://svc.search.windows.net", key: "key" },
      "legal-personal",
      { resolveContainerCreds: FAKE_CREDS }, // no commit
    );
    assert.equal(r.dryRun, true);
    assert.equal(r.deleted, 0);
    assert.equal(r.missing, 1);
    assert.deepEqual(r.missingChunkIds, ["k1"]);
  });
  assert.equal(deleteEndpointCalled, false, "the delete endpoint must NEVER be called without --commit");
});

test("reapIndex: WITH --commit, deletes exactly the confirmed-missing, non-canary chunk_ids", async () => {
  const docs = [
    { chunk_id: "k1", path: "https://otchealthlegalstore.blob.core.windows.net/personal/gone.txt" },
    { chunk_id: "k2", path: "https://otchealthlegalstore.blob.core.windows.net/personal/live.txt" },
    { chunk_id: "k3", path: "https://otchealthlegalstore.blob.core.windows.net/personal/CANARY/gone-but-watched.txt" },
  ];
  const blobStates = new Map([
    ["https://otchealthlegalstore.blob.core.windows.net/personal/gone.txt", "missing"],
    ["https://otchealthlegalstore.blob.core.windows.net/personal/live.txt", "exists"],
    ["https://otchealthlegalstore.blob.core.windows.net/personal/CANARY/gone-but-watched.txt", "missing"],
  ]);
  const baseStub = makeFakeIndexerStub({ docs, blobStates });
  let deletedIds = null;
  await withStubbedFetch(async (url, init) => {
    const u = String(url);
    if (u.includes("/docs/index")) {
      const body = JSON.parse(init.body);
      deletedIds = body.value.map((v) => v.chunk_id);
      return jsonResponse(200, { value: body.value.map((v) => ({ key: v.chunk_id, status: true, statusCode: 200 })) });
    }
    return baseStub(url, init);
  }, async () => {
    const r = await reapIndex(
      { endpoint: "https://svc.search.windows.net", key: "key" },
      "legal-personal",
      { resolveContainerCreds: FAKE_CREDS, commit: true },
    );
    assert.equal(r.deleted, 1);
    assert.equal(r.deleteFailed, 0);
    assert.deepEqual(deletedIds, ["k1"], "only the confirmed-missing, non-canary chunk must be deleted — k3 (CANARY) must never appear");
  });
});

test("reapIndex: batches deletes at the 1000-action boundary across multiple docs/index calls", async () => {
  const N = 2500;
  const docs = Array.from({ length: N }, (_, i) => ({
    chunk_id: `k${i}`,
    path: `https://otchealthlegalstore.blob.core.windows.net/personal/gone-${i}.txt`,
  }));
  const blobStates = new Map(docs.map((d) => [d.path, "missing"]));
  const baseStub = makeFakeIndexerStub({ docs, blobStates });
  const batchSizes = [];
  await withStubbedFetch(async (url, init) => {
    const u = String(url);
    if (u.includes("/docs/index")) {
      const body = JSON.parse(init.body);
      batchSizes.push(body.value.length);
      return jsonResponse(200, { value: body.value.map((v) => ({ key: v.chunk_id, status: true, statusCode: 200 })) });
    }
    return baseStub(url, init);
  }, async () => {
    const r = await reapIndex(
      { endpoint: "https://svc.search.windows.net", key: "key" },
      "legal-personal",
      { resolveContainerCreds: FAKE_CREDS, commit: true },
    );
    assert.equal(r.deleted, N);
    assert.deepEqual(batchSizes, [1000, 1000, 500]);
  });
});

test("reapIndex: a 207 partial-failure delete batch is tallied correctly (some deleted, some failed)", async () => {
  const docs = [
    { chunk_id: "k1", path: "https://otchealthlegalstore.blob.core.windows.net/personal/gone1.txt" },
    { chunk_id: "k2", path: "https://otchealthlegalstore.blob.core.windows.net/personal/gone2.txt" },
  ];
  const blobStates = new Map([
    ["https://otchealthlegalstore.blob.core.windows.net/personal/gone1.txt", "missing"],
    ["https://otchealthlegalstore.blob.core.windows.net/personal/gone2.txt", "missing"],
  ]);
  const baseStub = makeFakeIndexerStub({ docs, blobStates });
  await withStubbedFetch(async (url, init) => {
    const u = String(url);
    if (u.includes("/docs/index")) {
      return jsonResponse(207, {
        value: [
          { key: "k1", status: true, statusCode: 200 },
          { key: "k2", status: false, statusCode: 409, errorMessage: "conflict" },
        ],
      });
    }
    return baseStub(url, init);
  }, async () => {
    const r = await reapIndex(
      { endpoint: "https://svc.search.windows.net", key: "key" },
      "legal-personal",
      { resolveContainerCreds: FAKE_CREDS, commit: true },
    );
    assert.equal(r.deleted, 1);
    assert.equal(r.deleteFailed, 1);
  });
});

test("reapIndex: circuit breaker aborts and deletes nothing when the error rate is abnormally high", async () => {
  const docs = Array.from({ length: 10 }, (_, i) => ({
    chunk_id: `k${i}`,
    path: `https://otchealthlegalstore.blob.core.windows.net/personal/f${i}.txt`,
  }));
  // 6/10 error, 1/10 missing, rest exist — error rate 60% > 25% threshold, and 6 >= the 5-error floor
  const blobStates = new Map();
  docs.forEach((d, i) => blobStates.set(d.path, i < 6 ? "error" : i === 6 ? "missing" : "exists"));
  const baseStub = makeFakeIndexerStub({ docs, blobStates });
  let deleteCalled = false;
  await withStubbedFetch(async (url, init) => {
    const u = String(url);
    if (u.includes("/docs/index")) { deleteCalled = true; return jsonResponse(200, { value: [] }); }
    return baseStub(url, init);
  }, async () => {
    const r = await reapIndex(
      { endpoint: "https://svc.search.windows.net", key: "key" },
      "legal-personal",
      { resolveContainerCreds: FAKE_CREDS, commit: true },
    );
    assert.equal(r.aborted, true);
    assert.equal(r.deleted, 0);
  });
  assert.equal(deleteCalled, false, "circuit breaker must prevent any delete call");
});

test("reapIndex: NEVER issues a blob-mutating HTTP verb — every *.blob.core.windows.net call is HEAD-only, and the minted SAS is read+list-only ('rl')", async () => {
  // Structural guarantee, not just a convention: this reaper deletes SEARCH INDEX documents only.
  // It is one-directional (index reaped to match blob reality; blob reality is never changed to
  // match the index) and has no blob write/delete code path anywhere in reaper.mjs at all — there
  // is no helper to call even by mistake. This test proves it at the network-call level: across a
  // full --commit reap run, every request whose URL host is a blob.core.windows.net account must
  // use method HEAD (or GET), and every SAS query string attached to such a request must carry
  // exactly sp=rl.
  const docs = [
    { chunk_id: "k1", path: "https://otchealthlegalstore.blob.core.windows.net/personal/gone.txt" },
    { chunk_id: "k2", path: "https://otchealthlegalstore.blob.core.windows.net/personal/live.txt" },
  ];
  const blobStates = new Map([
    ["https://otchealthlegalstore.blob.core.windows.net/personal/gone.txt", "missing"],
    ["https://otchealthlegalstore.blob.core.windows.net/personal/live.txt", "exists"],
  ]);
  const baseStub = makeFakeIndexerStub({ docs, blobStates });
  const blobRequests = [];
  await withStubbedFetch(async (url, init) => {
    const u = String(url);
    if (/\.blob\.core\.windows\.net\//.test(u)) {
      blobRequests.push({ url: u, method: (init && init.method) || "GET" });
    }
    if (u.includes("/docs/index")) {
      const body = JSON.parse(init.body);
      return jsonResponse(200, { value: body.value.map((v) => ({ key: v.chunk_id, status: true, statusCode: 200 })) });
    }
    return baseStub(url, init);
  }, async () => {
    const r = await reapIndex(
      { endpoint: "https://svc.search.windows.net", key: "key" },
      "legal-personal",
      { resolveContainerCreds: FAKE_CREDS, commit: true },
    );
    assert.equal(r.deleted, 1);
  });
  assert.ok(blobRequests.length > 0, "the test must actually exercise a blob-host request");
  for (const req of blobRequests) {
    assert.equal(req.method, "HEAD", `blob request must be HEAD, was ${req.method} for ${req.url}`);
    const qs = req.url.split("?")[1] || "";
    const sp = new URLSearchParams(qs).get("sp");
    assert.equal(sp, "rl", `SAS permission must be exactly "rl" (read+list only), was "${sp}" for ${req.url}`);
  }
});

test("buildAccountSas: sp is hardcoded to 'rl' with no parameter able to widen it (structural, not conventional)", () => {
  // buildAccountSas() takes no `permission`/`sp` argument at all — there is no call shape that can
  // ever request write/delete/create on blob storage from this file.
  assert.equal(buildAccountSas.length <= 1, true, "must take a single options object, no separate permission argument to smuggle a wider scope through");
  const sas = buildAccountSas({ account: "a", key: Buffer.from("k").toString("base64") });
  assert.equal(new URLSearchParams(sas).get("sp"), "rl");
});

test("reapIndex: not blob-backed (no indexer) is a clean no-op, not an error", async () => {
  await withStubbedFetch(async (url) => {
    const u = String(url);
    if (u.includes("/datasources")) return jsonResponse(200, { value: [] });
    if (u.includes("/indexers")) return jsonResponse(200, { value: [] });
    throw new Error("should not be reached: " + u);
  }, async () => {
    const r = await reapIndex({ endpoint: "https://svc.search.windows.net", key: "key" }, "memory-exec", { commit: true });
    assert.equal(r.blobBacked, false);
    assert.equal(r.deleted, 0);
  });
});
