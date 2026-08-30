// Counterfactual regression test for FND-20260830-ccb9's investigation: ring-memory-index-daily's
// real ECS task definition (otchealth-job-ring-memory-index-daily) sets NEITHER SEARCH_BACKEND NOR
// EMBEDDINGS_PROVIDER -- confirmed 2026-08-30 by reading the live task definition's environment
// directly (only AZURE_UAMI_CLIENT_ID / AZURE_KEYVAULT_NAME are present, both vestigial). So the
// DEFAULT this module resolves to when those two vars are absent is not a hypothetical; it is
// EXACTLY the production configuration, every single scheduled run, for all 7 rings this module
// indexes (legal-personal-memory, finance-cfo-memory, commons-{coo,cco,cro,cpo,developer}-memory).
//
// The sibling file opensearch-dispatch.test.mjs proves the DISPATCH LOGIC is correct once
// SEARCH_BACKEND=opensearch/EMBEDDINGS_PROVIDER=openai are set -- but every one of its tests sets
// both explicitly via its own setEnv() before importing the module, so it could not have caught (and
// in fact did not catch) the module's DEFAULT being wrong. That is not a flaw in that file; it is a
// different, complementary claim, and this file exists to cover the one those tests structurally
// cannot: what happens with NEITHER var set, which is what actually runs in production.
//
// Confirmed live 2026-08-30 (read-only CloudWatch Logs on a real scheduled run,
// ring-memory-index-daily/job/5e109febd888492785a0f2ca81ec858f): with the pre-fix default of
// "azure"/"foundry", every one of the 7 rings failed identically --
//   RING <label>: ERROR Failed to parse URL from /indexes/<index>?api-version=2023-11-01
// -- because the module tried to build an Azure Cognitive Search REST URL from an azure-search-endpoint
// value that could never resolve (Azure subscription 55c84f6b was permanently deleted 2026-08-13, and
// azure-search-endpoint/azure-foundry-openai-endpoint/azure-openai-endpoint do not exist in the AWS SSM
// mirror either -- verified ParameterNotFound on all three). The job still exits 0 (each ring's error is
// caught and logged per-ring, not thrown), so this was the exact silent-success shape the parent
// investigation was scoped to check for -- just in a different file/room than the one originally named.
// Live effect: finance-cfo-memory's newest document was 329.8h (13.7 days) stale and
// legal-personal-memory's was 437.1h (18.2 days) stale at investigation time, with no doc-level error
// visible anywhere except this job's own CloudWatch log.
//
// node --test isolates each *.test.mjs file into its own process (see opensearch-dispatch.test.mjs's
// own header), so this file's deliberate OMISSION of SEARCH_BACKEND/EMBEDDINGS_PROVIDER cannot be
// polluted by any other test file setting them, and vice versa.
import { test } from "node:test";
import assert from "node:assert/strict";

const AZURE_HOST_RE = /\.(search\.windows\.net|openai\.azure\.com|cognitiveservices\.azure\.com)/i;
const OS_HOST = "unit-test-cluster.us-east-1.es.amazonaws.com";

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
  globalThis.fetch = async (url) => {
    const u = String(typeof url === "string" ? url : url?.url || url);
    calls.push(u);
    if (AZURE_HOST_RE.test(u)) throw new Error(`TEST-FAIL: fetch reached an Azure Search/Foundry host with SEARCH_BACKEND/EMBEDDINGS_PROVIDER UNSET (the real production shape): ${u}`);
    if (isHost(u, "api.openai.com") && u.includes("/v1/embeddings")) return new Response(JSON.stringify({ data: [{ index: 0, embedding: new Array(3072).fill(0.001) }] }), { status: 200 });
    if (isHost(u, OS_HOST)) {
      if (u.includes("_mapping")) return new Response("not found", { status: 404 });
      return new Response(JSON.stringify({}), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

// Deliberately does NOT set SEARCH_BACKEND or EMBEDDINGS_PROVIDER -- everything else this module
// needs to resolve an OpenSearch config / an OpenAI key is provided, so the ONLY variable under test
// is what the module does with the two unset ones. Also deletes any inherited value defensively, in
// case a parent process (e.g. a local dev seat with session-start.sh's exports) leaked one in --
// production's ECS task definition has neither, and this test must reflect that exactly.
delete process.env.SEARCH_BACKEND;
delete process.env.EMBEDDINGS_PROVIDER;
process.env.OPENSEARCH_ENDPOINT = OS_HOST;
process.env.OPENSEARCH_REGION = "us-east-1";
process.env.AWS_ACCESS_KEY_ID = "AKIAUNITTESTFAKE0000";
process.env.AWS_SECRET_ACCESS_KEY = "unit-test-fake-secret-access-key-not-real";
process.env.OPENAI_API_KEY = "sk-unit-test-fake-not-real";

const DUMMY_AZURE = { AIS: "", AK: undefined, AOAI: "", AOK: undefined, DEP: "text-embedding-3-large" };

test("ensureIdx: with SEARCH_BACKEND unset (the real production task-definition shape), the module still routes to OpenSearch, never an Azure Search host", async () => {
  const { calls, restore } = installFetchStub();
  try {
    const { ensureIdx } = await import("../index-ring-memory.mjs");
    await assert.doesNotReject(() => ensureIdx(DUMMY_AZURE, "commons-developer-memory"));
  } finally {
    restore();
  }
  assert.ok(calls.some((u) => isHost(u, OS_HOST) && u.includes("commons-developer-memory")), "must have called the opensearch cluster for this index with no SEARCH_BACKEND override");
  assert.deepEqual(calls.filter((u) => AZURE_HOST_RE.test(u)), []);
});

test("embedTexts: with EMBEDDINGS_PROVIDER unset (the real production task-definition shape), the module still routes to OpenAI, never Azure Foundry", async () => {
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
