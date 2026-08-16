// Proves ring-memory-index/index-ring-memory.mjs's SEARCH_BACKEND=opensearch dispatch (the port for the
// 7 per-ring memory indexes: legal-personal-memory, finance-cfo-memory, commons-{coo,cco,cro,cpo,
// developer}-memory) genuinely routes through opensearch-write.mjs and never touches an Azure endpoint.
//
// SEARCH_BACKEND/EMBEDDINGS_PROVIDER are read ONCE at this module's load time (same convention as
// kb-memory/semantic.mjs), so every access to index-ring-memory.mjs here is a dynamic `await import(...)`
// performed AFTER the env vars are set in each test body -- a static import would be hoisted ahead of
// those assignments (see semantic-opensearch-dispatch.test.mjs's header for the full ESM-ordering
// explanation). node --test isolates each *.test.mjs file into its own process, so this file setting
// these env vars cannot leak into or be affected by the pre-existing ring-registry.test.mjs /
// fleet-dupe-convergence.test.mjs files, which import the azure (default) path statically and continue
// to pass unmodified.
import { test } from "node:test";
import assert from "node:assert/strict";

const AZURE_HOST_RE = /\.(search\.windows\.net|openai\.azure\.com|cognitiveservices\.azure\.com)/i;

/** The exact OpenSearch cluster host this file configures (see ENV below, which is derived from it, so
 *  the stub's routing and the env the code under test actually reads cannot drift apart). */
const OS_HOST = "unit-test-cluster.us-east-1.es.amazonaws.com";

/** Compare the URL's HOST COMPONENT exactly rather than substring-testing the whole URL. Two reasons,
 *  in this order:
 *   1. `u.includes(".es.amazonaws.com")` is CodeQL js/incomplete-url-substring-sanitization: a URL that
 *      merely MENTIONS that string in a path or query satisfies it.
 *   2. It is the weaker assertion. This file exists to prove WHICH backend each dispatch reached, so a
 *      check the wrong backend can satisfy defeats its entire purpose. */
function isHost(u, host) {
  try {
    return new URL(u).host === host;
  } catch {
    return false;
  }
}

function installFetchStub() {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const u = String(typeof url === "string" ? url : url?.url || url);
    calls.push(u);
    if (AZURE_HOST_RE.test(u)) throw new Error(`TEST-FAIL: fetch reached an Azure Search/Foundry host: ${u}`);
    if (isHost(u, "api.openai.com") && u.includes("/v1/embeddings")) return new Response(JSON.stringify({ data: [{ index: 0, embedding: new Array(3072).fill(0.001) }] }), { status: 200 });
    if (isHost(u, OS_HOST)) {
      if (u.includes("_mapping")) return new Response("not found", { status: 404 });
      if (u.includes("_bulk")) return new Response(JSON.stringify({ errors: false, items: [] }), { status: 200 });
      if (u.includes("_search/scroll") || opts?.method === "DELETE") return new Response(JSON.stringify({ hits: { hits: [] } }), { status: 200 });
      if (u.includes("_search")) return new Response(JSON.stringify({ _scroll_id: "s1", hits: { hits: [] } }), { status: 200 });
      return new Response(JSON.stringify({}), { status: 200 });
    }
    // Everything else (a Key-Vault/SSM secret lookup that legitimately still fires, e.g. for
    // aws-cto-access-key-id when env creds are not fully supplied in a given test) degrades harmlessly.
    return new Response("not found", { status: 404 });
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const ENV = {
  SEARCH_BACKEND: "opensearch",
  EMBEDDINGS_PROVIDER: "openai",
  OPENSEARCH_ENDPOINT: OS_HOST,
  OPENSEARCH_REGION: "us-east-1",
  AWS_ACCESS_KEY_ID: "AKIAUNITTESTFAKE0000",
  AWS_SECRET_ACCESS_KEY: "unit-test-fake-secret-access-key-not-real",
  OPENAI_API_KEY: "sk-unit-test-fake-not-real",
};
function setEnv() { for (const [k, v] of Object.entries(ENV)) process.env[k] = v; }

// A deliberately empty/unused azure placeholder -- mirrors exactly what run()'s own azureNeeded:false
// branch constructs, proving the dispatch helpers never read it in opensearch mode.
const DUMMY_AZURE = { AIS: "", AK: undefined, AOAI: "", AOK: undefined, DEP: "text-embedding-3-large" };

test("ensureIdx: SEARCH_BACKEND=opensearch routes to OS.ensureIndex, never touches AIS/AK on the placeholder azure object", async () => {
  setEnv();
  const { calls, restore } = installFetchStub();
  try {
    const { ensureIdx } = await import("../index-ring-memory.mjs");
    await assert.doesNotReject(() => ensureIdx(DUMMY_AZURE, "commons-developer-memory"));
  } finally {
    restore();
  }
  assert.ok(calls.some((u) => isHost(u, OS_HOST) && u.includes("commons-developer-memory")), "must have called the opensearch cluster for this index");
  assert.deepEqual(calls.filter((u) => AZURE_HOST_RE.test(u)), []);
});

test("embedTexts: EMBEDDINGS_PROVIDER=openai routes to OS.embedOpenAI, ignores the azure.AOAI/AOK placeholder entirely", async () => {
  setEnv();
  const { calls, restore } = installFetchStub();
  let vecs;
  try {
    const { embedTexts } = await import("../index-ring-memory.mjs");
    vecs = await embedTexts(DUMMY_AZURE, ["a private ledger row"]);
  } finally {
    restore();
  }
  assert.equal(vecs[0].length, 3072);
  assert.ok(calls.some((u) => isHost(u, "api.openai.com") && u.includes("/v1/embeddings")));
  assert.deepEqual(calls.filter((u) => AZURE_HOST_RE.test(u)), []);
});

test("pushBatch: strips Azure's @search.action marker and sends update+doc_as_upsert to OpenSearch, for a FULL-doc row (indexRing()'s own shape -- every field always given)", async () => {
  setEnv();
  let sentBody;
  const { restore } = installFetchStub();
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes("_bulk")) { sentBody = opts.body; return new Response(JSON.stringify({ errors: false, items: [{ update: { _id: "cfom-0", status: 200 } }] }), { status: 200 }); }
    if (AZURE_HOST_RE.test(u)) throw new Error("TEST-FAIL: touched Azure: " + u);
    return new Response("{}", { status: 404 });
  };
  try {
    const { pushBatch } = await import("../index-ring-memory.mjs");
    await pushBatch(DUMMY_AZURE, "finance-cfo-memory", [{ "@search.action": "mergeOrUpload", id: "cfom-0", type: "decision", ts: "2026-08-16T00:00:00.000Z", tags: "", text: "reconcile Q3", contentVector: [0.1] }]);
  } finally {
    restore();
  }
  const lines = sentBody.trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines[0], { update: { _id: "cfom-0" } });
  assert.equal(lines[1].doc_as_upsert, true);
  assert.equal("@search.action" in lines[1].doc, false, "the Azure action marker must never leak into the OpenSearch doc body");
  assert.equal("index" in lines[0], false);
});

test("pushBatch: an empty batch is a no-op, no network call at all (matches the pre-existing Azure push's own `if (value.length)` guard)", async () => {
  setEnv();
  const { calls, restore } = installFetchStub();
  try {
    const { pushBatch } = await import("../index-ring-memory.mjs");
    await pushBatch(DUMMY_AZURE, "commons-coo-memory", []);
  } finally {
    restore();
  }
  assert.deepEqual(calls, []);
});

test("run(): with SEARCH_BACKEND=opensearch + EMBEDDINGS_PROVIDER=openai and a filter matching zero rings, the azureNeeded skip guard makes ZERO fetch calls at all -- not merely zero calls whose URL happens to spell out a secret name", async () => {
  // Pattern-matching the secret NAME in the URL is NOT a reliable signal here: kvSecret()'s own
  // multi-tier auth (managed identity / SP / az-CLI) resolves an OAuth TOKEN FIRST, via
  // login.microsoftonline.com, an endpoint that never mentions the secret name at all -- confirmed by
  // tracing the real call sequence while building this test (7 azure-search-*/azure-foundry-* sm() calls
  // produced 7 login.microsoftonline.com auth attempts + 7 ssm.us-east-1.amazonaws.com attempts, ZERO of
  // which contain a matchable secret-name substring, even though every one of them is exactly the
  // unwanted resolution attempt this guard exists to skip). Asserting the raw CALL COUNT is the
  // unambiguous, unspoofable signal: with zero matching rings and the fully Azure-free configuration,
  // NOTHING in this call graph has any reason to fetch anything at all.
  setEnv();
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => { calls++; return new Response("{}", { status: 404 }); };
  let out;
  try {
    const { run } = await import("../index-ring-memory.mjs");
    out = await run("this-label-matches-no-ring");
  } finally {
    globalThis.fetch = original;
  }
  assert.deepEqual(out, []);
  assert.equal(calls, 0, "azureNeeded should have skipped Azure secret resolution entirely, and zero rings means no ledger reads either");
});

test("reconcileFleetDupes: SEARCH_BACKEND=opensearch scrolls memory-exec via OpenSearch and deletes via OS.deleteDocs, never touching an Azure Search endpoint", async () => {
  setEnv();
  const { calls, restore } = installFetchStub();
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    calls.push(u);
    if (AZURE_HOST_RE.test(u)) throw new Error("TEST-FAIL: touched Azure: " + u);
    if (u.includes("_search/scroll") || opts?.method === "DELETE") return new Response(JSON.stringify({ hits: { hits: [] } }), { status: 200 });
    if (u.includes("_bulk")) return new Response(JSON.stringify({ errors: false, items: [{ delete: { _id: "fleet__old__x", status: 200 } }] }), { status: 200 });
    if (u.includes("/memory-exec/_search")) {
      // one page: a converged doc (agent+ts) and its pre-fix fleet__ duplicate sharing the same (agent,ts)
      return new Response(JSON.stringify({ _scroll_id: "s1", hits: { hits: [
        { _id: "coo__real-id", _source: { agent: "coo", ts: "2026-08-01T00:00:00.000Z" } },
        { _id: "fleet__old__x", _source: { agent: "coo", ts: "2026-08-01T00:00:00.000Z" } },
      ] } }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  };
  let result;
  try {
    const { reconcileFleetDupes } = await import("../index-ring-memory.mjs");
    result = await reconcileFleetDupes({ apply: true });
  } finally {
    restore();
  }
  assert.equal(result.total, 2);
  assert.equal(result.toDelete, 1); // the fleet__old__x duplicate, since coo__real-id already holds the same (agent,ts)
  assert.equal(result.kept, 0);
  assert.equal(result.apply, true);
});
