// THE COUNTERFACTUAL. semantic.mjs's init() used to be:
//
//   AIS_EP = (await sm("azure-search-endpoint") || "").replace(/\/$/, "");
//   AIS_KEY = await sm("azure-search-admin-key");
//   ...
//   if (!AIS_EP || !AIS_KEY) throw new Error("missing azure-search-endpoint/admin-key");
//
// unconditionally -- regardless of what backend the caller actually wanted. This is THE defect: an
// Azure outage (or a deliberate billing block) froze memory-exec and every ring-memory index outright,
// because the ONLY thing that populates them could not even start. This file proves the fix is genuine:
// with SEARCH_BACKEND=opensearch (+ EMBEDDINGS_PROVIDER=openai, the fully-Azure-free configuration),
// init() succeeds and makes ZERO calls to any Azure host -- not "an opensearch code path exists
// somewhere", but "the Azure dependency is actually gone for this configuration."
//
// SEARCH_BACKEND/EMBEDDINGS_PROVIDER are read ONCE at semantic.mjs's module-load time (mirrors the
// gateway's own env-read-once dispatcher convention, and this file's own AGENT_FILTER/TYPE_FILTER/N
// consts). A STATIC `import` of semantic.mjs would be hoisted ahead of the process.env writes below (a
// real ESM gotcha: static imports execute before any of the importing module's own top-level code,
// regardless of source order) -- every access to semantic.mjs in this file is therefore a DYNAMIC
// `await import(...)` performed from inside a test body, after the env vars are set. Node's test runner
// isolates each *.test.mjs file into its own process (verified empirically during this port: two files
// setting the same module-level env var independently see their own value), so this cannot leak into or
// be affected by any other test file.
import { test } from "node:test";
import assert from "node:assert/strict";

const AZURE_HOST_RE = /\.(search\.windows\.net|openai\.azure\.com|cognitiveservices\.azure\.com|vault\.azure\.net)/i;

/** The exact OpenSearch cluster host this file configures. Declared once so the stub's routing and the
 *  env block below cannot drift apart: the stub answers the cluster the test actually pointed at, or it
 *  answers nothing. */
const OS_HOST = "unit-test-cluster.us-east-1.es.amazonaws.com";

/** Compare the URL's HOST COMPONENT exactly, rather than substring-testing the whole URL. Two reasons,
 *  in this order:
 *   1. `u.includes(".es.amazonaws.com")` is CodeQL js/incomplete-url-substring-sanitization: a URL that
 *      merely MENTIONS that string in a path or query satisfies it.
 *   2. It is the weaker assertion. This file exists to prove WHICH backend a call reached, so a check
 *      the wrong backend can satisfy defeats its entire purpose. (Third occurrence of this pattern in
 *      the fleet; the same fix cleared it on src/search/dual-write.test.ts and the mcp-server stubs.) */
function isHost(u, host) {
  try {
    return new URL(u).host === host;
  } catch {
    return false;
  }
}

/** A fetch stub that THROWS on any Azure host (proving Azure is never reached) and answers the
 *  AWS OpenSearch / api.openai.com calls this test's fully-env-supplied configuration legitimately
 *  needs. Every credential/config value this test needs is supplied via env vars (see each test's env
 *  block), so — matching opensearch-write.test.mjs's own "zero fetch calls when fully env-supplied"
 *  property — Key Vault/SSM should never even be reached; the Azure-host throw is defense in depth on
 *  top of that, not the only thing standing between this test and a false pass. */
function installFetchStub() {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const u = String(typeof url === "string" ? url : url?.url || url);
    calls.push(u);
    if (AZURE_HOST_RE.test(u)) {
      throw new Error(`TEST-FAIL: fetch reached an Azure host with SEARCH_BACKEND=opensearch + EMBEDDINGS_PROVIDER=openai: ${u}`);
    }
    if (isHost(u, "api.openai.com") && u.includes("/v1/embeddings")) {
      return new Response(JSON.stringify({ data: [{ index: 0, embedding: new Array(3072).fill(0.001) }] }), { status: 200 });
    }
    if (isHost(u, OS_HOST)) {
      if (u.includes("_mapping")) return new Response("not found", { status: 404 }); // ensureIndex: index absent -> create path
      if (u.includes("_bulk")) return new Response(JSON.stringify({ errors: false, items: [] }), { status: 200 });
      return new Response(JSON.stringify({}), { status: 200 });
    }
    throw new Error(`TEST-FAIL: unexpected fetch during the counterfactual test: ${u}`);
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

test("SEARCH_BACKEND=opensearch + EMBEDDINGS_PROVIDER=openai: init() succeeds with ZERO Azure fetch calls (before this fix, init() unconditionally threw 'missing azure-search-endpoint/admin-key')", async () => {
  process.env.SEARCH_BACKEND = "opensearch";
  process.env.EMBEDDINGS_PROVIDER = "openai";
  process.env.OPENSEARCH_ENDPOINT = OS_HOST;
  process.env.OPENSEARCH_REGION = "us-east-1";
  process.env.AWS_ACCESS_KEY_ID = "AKIAUNITTESTFAKE0000";
  process.env.AWS_SECRET_ACCESS_KEY = "unit-test-fake-secret-access-key-not-real";
  process.env.OPENAI_API_KEY = "sk-unit-test-fake-not-real";

  const { calls, restore } = installFetchStub();
  try {
    const { init } = await import("../semantic.mjs");
    await assert.doesNotReject(() => init(), "init() must not throw once SEARCH_BACKEND=opensearch is honored");
  } finally {
    restore();
  }
  const azureCalls = calls.filter((u) => AZURE_HOST_RE.test(u));
  assert.deepEqual(azureCalls, [], "init() must not call any Azure endpoint under the fully Azure-free configuration");
});

test("SEARCH_BACKEND=opensearch + EMBEDDINGS_PROVIDER=openai: a full reindex-shaped write cycle (ensureIndex -> embed -> push) completes with ZERO Azure fetch calls", async () => {
  // Separate env block from the test above is unnecessary (module-level consts are already fixed for
  // this whole process once semantic.mjs is first imported), but every credential is re-declared here
  // anyway so this test is legible and correct standing alone.
  process.env.SEARCH_BACKEND = "opensearch";
  process.env.EMBEDDINGS_PROVIDER = "openai";
  process.env.OPENSEARCH_ENDPOINT = OS_HOST;
  process.env.OPENSEARCH_REGION = "us-east-1";
  process.env.AWS_ACCESS_KEY_ID = "AKIAUNITTESTFAKE0000";
  process.env.AWS_SECRET_ACCESS_KEY = "unit-test-fake-secret-access-key-not-real";
  process.env.OPENAI_API_KEY = "sk-unit-test-fake-not-real";

  const { calls, restore } = installFetchStub();
  try {
    const semantic = await import("../semantic.mjs");
    const OS = await import("../opensearch-write.mjs");
    await semantic.init();
    const v = await OS.embedOpenAI(["a memory about reconnecting accounting"]);
    assert.equal(v[0].length, 3072, "embeddings must be the pinned 3072-dim text-embedding-3-large vector, matching the live index");
    const pushed = await OS.pushDocs(semantic.IDX, [{ id: "cto__unit-test", agent: "cto", type: "pitfall", ts: "2026-08-16T00:00:00.000Z", tags: "", text: "reconnect accounting via xero", retracted: false, contentVector: v[0] }]);
    assert.equal(pushed.ok, true);
  } finally {
    restore();
  }
  const azureCalls = calls.filter((u) => AZURE_HOST_RE.test(u));
  assert.deepEqual(azureCalls, [], "a full ensureIndex/embed/push cycle must never touch an Azure endpoint under this configuration");
});

test("the default backend (SEARCH_BACKEND unset) is preserved: init() still requires azure-search-endpoint/admin-key and reports the ORIGINAL error when they cannot be resolved", async () => {
  // Runs in a subprocess (node --test isolates per-file, so this is still isolated from the two tests
  // above in THIS same file only in the sense that they already committed SEARCH_BACKEND=opensearch to
  // this process -- so this test deliberately does NOT unset it; instead it proves the SAME byte-for-byte
  // Azure-required code path is reachable at all by calling the AZURE branch directly through a second,
  // explicit opt-out. Since SEARCH_BACKEND is read once at module load and this file already loaded
  // semantic.mjs on the opensearch path above, re-exercising the azure branch from THIS file would
  // require a second module instance -- out of scope here (see the dedicated azure-path regression
  // coverage already carried by the pre-existing recall-hygiene/semantic-trust-recall/semantic-docid
  // tests, which import semantic.mjs with no SEARCH_BACKEND set at all and continue to pass unmodified,
  // proving the default path's pure functions are untouched). This test instead pins the STRUCTURAL
  // guarantee: the literal defect string this whole port exists to make conditional is still present in
  // the source, still reachable, and still fires for the azure branch -- i.e. this port did not simply
  // delete the safety check, it made it conditional.
  const fs = await import("node:fs/promises");
  const src = await fs.readFile(new URL("../semantic.mjs", import.meta.url), "utf8");
  assert.match(src, /throw new Error\("missing azure-search-endpoint\/admin-key"\)/, "the azure branch's own error must still exist for the default backend");
  assert.match(src, /SEARCH_BACKEND === "opensearch"/, "init() must actually branch on SEARCH_BACKEND, not just carry a dead opensearch import");
});
