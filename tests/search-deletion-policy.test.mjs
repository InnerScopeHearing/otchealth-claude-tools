// Regression gate for setup/search-deletion-policy.mjs, the fix for a fleet-wide correctness bug:
// every one of otchealth-dataroom-s1's 18 blob-backed datasources had dataDeletionDetectionPolicy:
// null, so deleting a source blob never removed its search document.
//
// Load-bearing guarantees pinned here:
//   1. dry-run-by-default: runApply()/applyDatasource() without commit=true never issues a PUT or a
//      storage PATCH, even when the live state is wrong and would otherwise need fixing.
//   2. connectionString-preservation: buildPutBody() ALWAYS forces credentials.connectionString to
//      the literal "<unchanged>" sentinel, regardless of what the GET response's own (redacted)
//      connectionString value was (null, undefined, or even a stray real-looking string) -- this is
//      the one bug class that would silently corrupt a live datasource's connection to blob storage.
//   3. idempotency: a datasource that already carries the correct deletion policy is never PUT again,
//      commit or not -- re-running apply on a clean fleet is a true no-op (zero PUT calls).
//   4. field preservation: buildPutBody() changes ONLY credentials and dataDeletionDetectionPolicy;
//      container (including container.query), type, description, encryptionKey,
//      dataChangeDetectionPolicy, and name pass through byte-for-byte from the GET response, and the
//      read-only @odata.context/@odata.etag response fields are stripped (not valid request fields).
//   5. account-readiness gating: a datasource is never PUT if its backing storage account's
//      soft-delete plan did not land in "already enabled" or "enabled this run" -- prevents writing a
//      deletion policy that Azure Search would reject or that would silently no-op.
//
// Fully hermetic: no real Key Vault, ARM, or Azure Search network calls. globalThis.fetch is stubbed
// per test (same style as tests/fleet-backup-cosmos-export.test.mjs / tests/cosmos-auth.test.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DELETION_POLICY,
  UNCHANGED_CONNECTION_STRING,
  hasCorrectDeletionPolicy,
  buildPutBody,
  indexerNameFor,
  accountsInManifest,
  applyDatasource,
  ensureAccountSoftDelete,
} from "../setup/search-deletion-policy.mjs";

async function withStubbedFetch(stub, run) {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try { return await run(); } finally { globalThis.fetch = original; }
}

function jsonResponse(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

const LIVE_DS_NO_POLICY = {
  "@odata.context": "https://otchealth-dataroom-s1.search.windows.net/$metadata#datasources/$entity",
  "@odata.etag": "\"0x8DEE92E3949BACC\"",
  name: "ds-commons-journal",
  description: null,
  type: "azureblob",
  subtype: null,
  credentials: { connectionString: null },
  container: { name: "company-journal", query: "_TEXT/_JOURNAL/" },
  dataChangeDetectionPolicy: null,
  dataDeletionDetectionPolicy: null,
  encryptionKey: null,
};

const LIVE_DS_CORRECT = {
  ...LIVE_DS_NO_POLICY,
  dataDeletionDetectionPolicy: { "@odata.type": "#Microsoft.Azure.Search.NativeBlobSoftDeleteDeletionDetectionPolicy" },
};

// ============================================================== hasCorrectDeletionPolicy ====
test("hasCorrectDeletionPolicy: null policy is not correct", () => {
  assert.equal(hasCorrectDeletionPolicy(LIVE_DS_NO_POLICY), false);
});

test("hasCorrectDeletionPolicy: matching @odata.type is correct even with extra fields", () => {
  assert.equal(hasCorrectDeletionPolicy(LIVE_DS_CORRECT), true);
  assert.equal(hasCorrectDeletionPolicy({ ...LIVE_DS_CORRECT, dataDeletionDetectionPolicy: { "@odata.type": DELETION_POLICY["@odata.type"], somethingElse: 1 } }), true);
});

test("hasCorrectDeletionPolicy: a DIFFERENT policy type (e.g. SoftDeleteColumnDeletionDetectionPolicy) is not correct", () => {
  const wrong = { ...LIVE_DS_NO_POLICY, dataDeletionDetectionPolicy: { "@odata.type": "#Microsoft.Azure.Search.SoftDeleteColumnDeletionDetectionPolicy", softDeleteColumnName: "isDeleted", softDeleteMarkerValue: "true" } };
  assert.equal(hasCorrectDeletionPolicy(wrong), false);
});

// ============================================================== buildPutBody: connectionString ====
test("buildPutBody: forces connectionString to the <unchanged> sentinel regardless of GET's own value (null)", () => {
  const body = buildPutBody(LIVE_DS_NO_POLICY);
  assert.equal(body.credentials.connectionString, UNCHANGED_CONNECTION_STRING);
});

test("buildPutBody: forces <unchanged> even if the GET response somehow carried a real-looking connectionString (defense in depth)", () => {
  const withRealLooking = { ...LIVE_DS_NO_POLICY, credentials: { connectionString: "DefaultEndpointsProtocol=https;AccountName=x;AccountKey=REALKEY==" } };
  const body = buildPutBody(withRealLooking);
  assert.equal(body.credentials.connectionString, UNCHANGED_CONNECTION_STRING);
  assert.doesNotMatch(JSON.stringify(body), /REALKEY/, "the real key must never be echoed into the PUT body");
});

// ============================================================== buildPutBody: field preservation ====
test("buildPutBody: preserves container (name + query), type, description, encryptionKey, name byte-for-byte", () => {
  const body = buildPutBody(LIVE_DS_NO_POLICY);
  assert.deepEqual(body.container, { name: "company-journal", query: "_TEXT/_JOURNAL/" });
  assert.equal(body.type, "azureblob");
  assert.equal(body.description, null);
  assert.equal(body.encryptionKey, null);
  assert.equal(body.name, "ds-commons-journal");
});

test("buildPutBody: does NOT touch dataChangeDetectionPolicy (task scope is deletion policy only)", () => {
  const withChangePolicy = { ...LIVE_DS_NO_POLICY, dataChangeDetectionPolicy: { "@odata.type": "#Microsoft.Azure.Search.HighWaterMarkChangeDetectionPolicy", highWaterMarkColumnName: "_ts" } };
  const body = buildPutBody(withChangePolicy);
  assert.deepEqual(body.dataChangeDetectionPolicy, withChangePolicy.dataChangeDetectionPolicy);
});

test("buildPutBody: strips @odata.context and @odata.etag (not valid request fields)", () => {
  const body = buildPutBody(LIVE_DS_NO_POLICY);
  assert.equal("@odata.context" in body, false);
  assert.equal("@odata.etag" in body, false);
});

test("buildPutBody: sets dataDeletionDetectionPolicy to the desired policy (default: NativeBlobSoftDeleteDeletionDetectionPolicy)", () => {
  const body = buildPutBody(LIVE_DS_NO_POLICY);
  assert.deepEqual(body.dataDeletionDetectionPolicy, DELETION_POLICY);
});

test("buildPutBody: only credentials + dataDeletionDetectionPolicy differ from the input's other keys; every other key name is present unchanged", () => {
  const body = buildPutBody(LIVE_DS_NO_POLICY);
  for (const k of ["name", "description", "type", "subtype", "container", "dataChangeDetectionPolicy", "encryptionKey"]) {
    assert.deepEqual(body[k], LIVE_DS_NO_POLICY[k], `field ${k} must be preserved`);
  }
});

// ============================================================== indexerNameFor ====
test("indexerNameFor: ds- prefix maps to ixr- prefix (fleet's live 1:1 naming convention)", () => {
  assert.equal(indexerNameFor("ds-commons-journal"), "ixr-commons-journal");
  assert.equal(indexerNameFor("ds-legal-personal"), "ixr-legal-personal");
  assert.equal(indexerNameFor("ds-finance-cfo-source-docs"), "ixr-finance-cfo-source-docs");
});

// ============================================================== accountsInManifest ====
test("accountsInManifest: dedupes and preserves first-seen order", () => {
  const manifest = { datasources: [
    { name: "a", storageAccount: "acct1" },
    { name: "b", storageAccount: "acct2" },
    { name: "c", storageAccount: "acct1" },
  ] };
  assert.deepEqual(accountsInManifest(manifest), ["acct1", "acct2"]);
});

// ============================================================== applyDatasource: dry-run-by-default ====
test("applyDatasource: dry-run reads current state (GET) but issues NO PUT even when policy is wrong", async () => {
  const calls = [];
  const stub = async (url, opts) => {
    calls.push({ url: String(url), method: opts?.method || "GET" });
    if ((opts?.method || "GET") === "GET") return jsonResponse(200, LIVE_DS_NO_POLICY);
    throw new Error("PUT must never be called in dry-run");
  };
  const result = await withStubbedFetch(stub, () =>
    applyDatasource("https://fake.search.windows.net", "fakekey", { name: "ds-commons-journal", storageAccount: "otchealthcommons" }, { commit: false }),
  );
  assert.equal(result.action, "would-fix");
  assert.equal(calls.filter((c) => c.method === "PUT").length, 0);
  assert.equal(calls.filter((c) => c.method === "GET").length, 1);
});

test("applyDatasource: commit=true with wrong policy issues exactly one PUT with connectionString <unchanged>", async () => {
  const calls = [];
  const stub = async (url, opts) => {
    const method = opts?.method || "GET";
    calls.push({ url: String(url), method, body: opts?.body ? JSON.parse(opts.body) : null });
    if (method === "GET") return jsonResponse(200, LIVE_DS_NO_POLICY);
    if (method === "PUT") return jsonResponse(200, { ...LIVE_DS_NO_POLICY, dataDeletionDetectionPolicy: DELETION_POLICY });
    throw new Error("unexpected method " + method);
  };
  const result = await withStubbedFetch(stub, () =>
    applyDatasource("https://fake.search.windows.net", "fakekey", { name: "ds-commons-journal", storageAccount: "otchealthcommons" }, { commit: true, accountReady: true }),
  );
  assert.equal(result.action, "fixed");
  const puts = calls.filter((c) => c.method === "PUT");
  assert.equal(puts.length, 1);
  assert.equal(puts[0].body.credentials.connectionString, UNCHANGED_CONNECTION_STRING);
  assert.deepEqual(puts[0].body.dataDeletionDetectionPolicy, DELETION_POLICY);
});

// ============================================================== applyDatasource: idempotency ====
test("applyDatasource: idempotent -- a datasource already correct issues ZERO PUT calls, commit or not", async () => {
  for (const commit of [false, true]) {
    const calls = [];
    const stub = async (url, opts) => {
      const method = opts?.method || "GET";
      calls.push(method);
      if (method === "GET") return jsonResponse(200, LIVE_DS_CORRECT);
      throw new Error("must not write when already correct");
    };
    const result = await withStubbedFetch(stub, () =>
      applyDatasource("https://fake.search.windows.net", "fakekey", { name: "ds-commons-journal", storageAccount: "otchealthcommons" }, { commit, accountReady: true }),
    );
    assert.equal(result.action, "noop");
    assert.equal(calls.filter((m) => m === "PUT").length, 0);
  }
});

test("applyDatasource: re-running commit=true twice in a row is a clean no-op the second time (full idempotency, not just a single-call check)", async () => {
  let live = { ...LIVE_DS_NO_POLICY };
  const putCalls = [];
  const stub = async (url, opts) => {
    const method = opts?.method || "GET";
    if (method === "GET") return jsonResponse(200, live);
    if (method === "PUT") {
      putCalls.push(1);
      live = { ...live, dataDeletionDetectionPolicy: JSON.parse(opts.body).dataDeletionDetectionPolicy };
      return jsonResponse(200, live);
    }
    throw new Error("unexpected");
  };
  const entry = { name: "ds-commons-journal", storageAccount: "otchealthcommons" };
  const first = await withStubbedFetch(stub, () => applyDatasource("https://fake.search.windows.net", "fakekey", entry, { commit: true, accountReady: true }));
  const second = await withStubbedFetch(stub, () => applyDatasource("https://fake.search.windows.net", "fakekey", entry, { commit: true, accountReady: true }));
  assert.equal(first.action, "fixed");
  assert.equal(second.action, "noop");
  assert.equal(putCalls.length, 1, "exactly one PUT across both runs");
});

// ============================================================== applyDatasource: account-readiness gate ====
test("applyDatasource: skips (no PUT) when accountReady=false, even with commit=true and a wrong policy", async () => {
  const calls = [];
  const stub = async (url, opts) => {
    const method = opts?.method || "GET";
    calls.push(method);
    if (method === "GET") return jsonResponse(200, LIVE_DS_NO_POLICY);
    throw new Error("must not PUT when the backing account is not soft-delete-ready");
  };
  const result = await withStubbedFetch(stub, () =>
    applyDatasource("https://fake.search.windows.net", "fakekey", { name: "ds-legal-personal", storageAccount: "otchealthlegalstore" }, { commit: true, accountReady: false }),
  );
  assert.equal(result.action, "blocked");
  assert.equal(calls.filter((m) => m === "PUT").length, 0);
});

test("applyDatasource: missing datasource (404 on GET) reports error and makes no PUT", async () => {
  const stub = async (url, opts) => {
    const method = opts?.method || "GET";
    if (method === "GET") return jsonResponse(404, {});
    throw new Error("must not PUT a nonexistent datasource");
  };
  const result = await withStubbedFetch(stub, () =>
    applyDatasource("https://fake.search.windows.net", "fakekey", { name: "ds-nonexistent", storageAccount: "otchealthcommons" }, { commit: true, accountReady: true }),
  );
  assert.equal(result.action, "error");
});

// ============================================================== ensureAccountSoftDelete ====
// resolveStorageAccountId tries a direct RG-scoped GET on the account first (fast path when a
// resourceGroup hint is supplied), THEN blobServices/default. This stub answers both.
function accountResolveStub(accountName, resourceGroup, extraGet) {
  const acctId = `/subscriptions/sub1/resourceGroups/${resourceGroup}/providers/Microsoft.Storage/storageAccounts/${accountName}`;
  return async (url, opts) => {
    const u = String(url);
    const method = opts?.method || "GET";
    if (method === "GET" && u.endsWith(`storageAccounts/${accountName}?api-version=2023-01-01`)) {
      return jsonResponse(200, { id: acctId, name: accountName });
    }
    if (u.includes("blobServices/default")) return extraGet(u, method, opts);
    throw new Error("unexpected call " + method + " " + u);
  };
}

test("ensureAccountSoftDelete: dry-run (commit=false) on a disabled account reports would-enable and issues no PATCH", async () => {
  const calls = [];
  const stub = accountResolveStub("otchealthlegalstore", "rg1", (u, method) => {
    calls.push(method);
    if (method === "GET") return jsonResponse(200, { properties: { deleteRetentionPolicy: { enabled: false } } });
    throw new Error("must not PATCH in dry-run");
  });
  const result = await withStubbedFetch(stub, () => ensureAccountSoftDelete("tok", "sub1", "otchealthlegalstore", "rg1", 14, { commit: false }));
  assert.equal(result.action, "would-enable");
  assert.equal(calls.filter((m) => m === "PATCH").length, 0);
});

test("ensureAccountSoftDelete: already-enabled account is a no-op even with commit=true", async () => {
  const calls = [];
  const stub = accountResolveStub("otchealthcommons", "otchealth-automation-rg", (u, method) => {
    calls.push(method);
    if (method === "GET") return jsonResponse(200, { properties: { deleteRetentionPolicy: { enabled: true, days: 14 } } });
    throw new Error("must not PATCH an already-enabled account");
  });
  const result = await withStubbedFetch(stub, () => ensureAccountSoftDelete("tok", "sub1", "otchealthcommons", "otchealth-automation-rg", 14, { commit: true }));
  assert.equal(result.action, "noop");
  assert.equal(calls.filter((m) => m === "PATCH").length, 0);
});

test("ensureAccountSoftDelete: commit=true on a disabled account issues exactly one PATCH with the correct retention body", async () => {
  const patchBodies = [];
  const stub = accountResolveStub("otchealthcfodata", "otchealth-automation-rg", (u, method, opts) => {
    if (method === "GET") return jsonResponse(200, { properties: { deleteRetentionPolicy: { enabled: false } } });
    if (method === "PATCH") { patchBodies.push(JSON.parse(opts.body)); return jsonResponse(200, {}); }
    throw new Error("unexpected");
  });
  const result = await withStubbedFetch(stub, () => ensureAccountSoftDelete("tok", "sub1", "otchealthcfodata", "otchealth-automation-rg", 14, { commit: true }));
  assert.equal(result.action, "enabled");
  assert.equal(patchBodies.length, 1);
  assert.deepEqual(patchBodies[0], { properties: { deleteRetentionPolicy: { enabled: true, days: 14 } } });
});

test("ensureAccountSoftDelete: falls back to a subscription-wide list when the resourceGroup hint 404s", async () => {
  const calls = [];
  const stub = async (url, opts) => {
    const u = String(url);
    const method = opts?.method || "GET";
    calls.push(method + " " + u);
    if (method === "GET" && u.endsWith("storageAccounts/otchealthcommerce?api-version=2023-01-01")) {
      return jsonResponse(404, {}); // wrong RG hint
    }
    if (method === "GET" && u.includes("providers/Microsoft.Storage/storageAccounts?api-version")) {
      return jsonResponse(200, { value: [{ name: "otchealthcommerce", id: "/subscriptions/sub1/resourceGroups/otchealth-automation-rg/providers/Microsoft.Storage/storageAccounts/otchealthcommerce" }] });
    }
    if (u.includes("blobServices/default") && method === "GET") {
      return jsonResponse(200, { properties: { deleteRetentionPolicy: { enabled: true, days: 14 } } });
    }
    throw new Error("unexpected " + method + " " + u);
  };
  const result = await withStubbedFetch(stub, () => ensureAccountSoftDelete("tok", "sub1", "otchealthcommerce", "wrong-rg", 14, { commit: true }));
  assert.equal(result.action, "noop");
});
