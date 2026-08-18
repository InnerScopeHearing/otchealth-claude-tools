// Unit tests for company-brain's backend dispatch after the Azure exit (2026-08-18).
//
// WHAT THESE PIN, and why each one is a real incident if it regresses:
//   1. THE DEFAULTS. brain.mjs is named in every per-repo CLAUDE.md's mandatory GROUND-FIRST
//      PROTOCOL as the first call for any company question, and none of SEARCH_BACKEND /
//      EMBEDDINGS_PROVIDER / LLM_PROVIDER is set anywhere in the fleet. So the DEFAULT is what
//      every seat actually gets. Azure subscription 55c84f6b is permanently gone; a default of
//      'azure'/'foundry' is a guaranteed outage on every invocation, which is exactly the bug this
//      change fixes. The defaults are the load-bearing part, so they get a test, not a comment.
//   2. THE EMBEDDING SPACE. The rooms hold ~492,557 documents embedded with text-embedding-3-large
//      at 3072 dims. A different model (Bedrock Titan/Cohere) or a `dimensions`-truncated vector
//      lands in an incompatible space, and cosine similarity between incompatible spaces still
//      returns plausible numbers -- retrieval would rank garbage while every health check stayed
//      green. This is the one failure in the system that is silent by construction.
//   3. THE RING WALL. legal-personal must stay unreachable for a non-privileged agent, and must stay
//      unreachable REGARDLESS of which search backend is selected (a wider ring is a legal
//      violation, not a bug).
//   4. LOUD FAILURE. A room that could not be searched must never be reported as a room that held
//      nothing: "No grounded results across the company brain" is read by agents as an
//      authoritative "the company has no record of this".
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveSelectors, assessSearchOutcome, chatRequestFor, selectRooms, selectLanes } from "../skills/company-brain/brain.mjs";
import * as OSR from "../skills/company-brain/opensearch-rooms.mjs";
import { _resetCachesForTests } from "../skills/kb-memory/opensearch-write.mjs";

// ─────────────────────────── 1. selector defaults ───────────────────────────

test("DEFAULTS are the LIVE options: opensearch / openai / openai (never the dead Azure estate)", () => {
  const s = resolveSelectors({}); // an empty env is exactly what every agent seat has today
  assert.equal(s.searchBackend, "opensearch");
  assert.equal(s.embeddingsProvider, "openai");
  assert.equal(s.llmProvider, "openai");
});

test("an UNSET or empty-string value falls back to the live default, not to azure/foundry", () => {
  for (const bag of [{}, { SEARCH_BACKEND: "", EMBEDDINGS_PROVIDER: "", LLM_PROVIDER: "" }, { SEARCH_BACKEND: undefined }]) {
    const s = resolveSelectors(bag);
    assert.equal(s.searchBackend, "opensearch");
    assert.equal(s.embeddingsProvider, "openai");
    assert.equal(s.llmProvider, "openai");
  }
});

test("Azure remains selectable (nothing was destroyed), and values are case/whitespace tolerant", () => {
  const s = resolveSelectors({ SEARCH_BACKEND: " Azure ", EMBEDDINGS_PROVIDER: "FOUNDRY", LLM_PROVIDER: "Foundry" });
  assert.equal(s.searchBackend, "azure");
  assert.equal(s.embeddingsProvider, "foundry");
  assert.equal(s.llmProvider, "foundry");
});

test("the three selectors are INDEPENDENT (a run is only Azure-free when all three are)", () => {
  const s = resolveSelectors({ SEARCH_BACKEND: "opensearch", EMBEDDINGS_PROVIDER: "foundry" });
  assert.equal(s.searchBackend, "opensearch");
  assert.equal(s.embeddingsProvider, "foundry", "embeddings must not be dragged along by SEARCH_BACKEND");
  assert.equal(s.llmProvider, "openai");
});

// ─────────────────────── 2. the pinned embedding space ───────────────────────

test("the embedding model and dimension are pinned to text-embedding-3-large / 3072", () => {
  assert.equal(OSR.EMBEDDING_MODEL, "text-embedding-3-large");
  assert.equal(OSR.EMBEDDING_DIMS, 3072);
});

test("the module that actually calls the embeddings API pins the SAME model, with no dimensions truncation", () => {
  // Cross-module pin: opensearch-write.mjs (owned elsewhere) is what issues the embeddings request.
  // If its pinned model or its request body ever changes, every stored vector in the 492k-doc corpus
  // becomes unmatchable in a way that produces confident nonsense rather than an error, so this
  // deliberately fails loudly here rather than being discovered as "the brain got worse".
  const src = readFileSync(fileURLToPath(new URL("../skills/kb-memory/opensearch-write.mjs", import.meta.url)), "utf8");
  assert.match(src, /OPENAI_EMBED_MODEL\s*=\s*"text-embedding-3-large"/);
  assert.ok(!/\bdimensions\s*:/.test(src), "embeddings request must never pass OpenAI's `dimensions` truncation parameter");
});

test("assertEmbeddingSpace ACCEPTS a 3072-dim vector", () => {
  assert.equal(OSR.assertEmbeddingSpace(new Array(3072).fill(0.1)), true);
});

test("assertEmbeddingSpace REJECTS a wrong-dimension vector and names the silent-corruption risk", () => {
  for (const dims of [1536, 1024, 3071]) { // dimensions-truncated / Bedrock Titan / off-by-one
    assert.throws(
      () => OSR.assertEmbeddingSpace(new Array(dims).fill(0.1)),
      (e) => /text-embedding-3-large/.test(e.message) && /3072/.test(e.message) && /silently/.test(e.message),
      `a ${dims}-dim vector must be refused, not searched with`,
    );
  }
});

test("assertEmbeddingSpace REJECTS a non-vector instead of degrading to an empty result", () => {
  for (const bad of [null, undefined, "vector", 0, {}]) {
    assert.throws(() => OSR.assertEmbeddingSpace(bad), /not a vector/);
  }
});

// ───────────────────────────── 3. the ring wall ─────────────────────────────

const PERSONAL_INDEXES = new Set(["legal-personal", "legal-personal-memory"]);
const indexesOf = (targets) => targets.map((t) => t.index);

test("a non-privileged agent NEVER gets a personal-legal room, whatever the backend selectors say", () => {
  // selectRooms is pure and env-independent by construction; the wall is evaluated BEFORE any search
  // call, so it cannot be affected by which engine serves the query. Prove it under every selector
  // combination anyway -- this is the assertion that must never quietly become backend-dependent.
  const bags = [
    {},
    { SEARCH_BACKEND: "opensearch" },
    { SEARCH_BACKEND: "azure" },
    { SEARCH_BACKEND: "opensearch", EMBEDDINGS_PROVIDER: "openai", LLM_PROVIDER: "openai" },
  ];
  for (const bag of bags) {
    resolveSelectors(bag); // selectors resolved; room selection must be unmoved by them
    for (const agent of ["", "cto", "cfo", "clo-personal", "coo", "cro", "developer", "growth"]) {
      for (const includePersonal of [false, true]) {
        const idx = indexesOf(selectRooms({ agent, includePersonal }));
        for (const i of idx) {
          assert.ok(!PERSONAL_INDEXES.has(i), `agent='${agent}' includePersonal=${includePersonal} reached '${i}'`);
        }
      }
    }
  }
});

test("only --agent clo WITH --include-personal reaches legal-personal, and legal-personal-memory is never federated at all", () => {
  const idx = indexesOf(selectRooms({ agent: "clo", includePersonal: true }));
  assert.ok(idx.includes("legal-personal"), "the explicit privileged path must still work");
  assert.ok(!idx.includes("legal-personal-memory"), "brain.mjs federates legal-personal only; do not widen the personal ring");
});

test("diff mode's ledger-lane wall matches the room wall exactly (clo-personal lane)", () => {
  const lanes = ["cto", "cfo", "clo", "clo-personal", "coo"];
  assert.deepEqual(selectLanes(lanes, { agent: "cfo", includePersonal: true }), ["cto", "cfo", "clo", "coo"]);
  assert.deepEqual(selectLanes(lanes, { agent: "clo", includePersonal: false }), ["cto", "cfo", "clo", "coo"]);
  assert.deepEqual(selectLanes(lanes, { agent: "clo", includePersonal: true }), lanes);
});

test("the room registry uses the gateway's real index names (nothing invented)", () => {
  // Source of truth: otchealth-mcp-server src/tools/kb/search-privileged.ts INDEX_LANES and
  // src/azure/search.ts CHUNKED_ROOMS.
  const idx = new Set(indexesOf(selectRooms({ agent: "clo", includePersonal: true })));
  for (const real of ["memory-exec", "legal-company", "finance-cfo-source-docs", "commerce-commerce-source-docs", "commons-company-journal", "legal-personal"]) {
    assert.ok(idx.has(real), `missing real room '${real}'`);
  }
  assert.deepEqual(
    [...OSR.CHUNKED_ROOMS].sort(),
    ["commerce-commerce-source-docs", "commons-company-journal", "finance-cfo-source-docs", "legal-company", "legal-personal"],
    "chunked-room registry must mirror the gateway's",
  );
  assert.equal(OSR.vectorFieldFor("legal-company"), "text_vector");
  assert.equal(OSR.vectorFieldFor("memory-exec"), "contentVector");
});

// ──────────────────── 4. a search failure must be LOUD ────────────────────

test("every room failing is a hard error, NOT a 'no results' answer", () => {
  const out = assessSearchOutcome({ roomsAttempted: 5, failures: [1, 2, 3, 4, 5].map((n) => ({ room: `r${n}`, error: "boom" })), hits: 0 });
  assert.equal(out.ok, false, "must not be reported as a successful empty search");
  assert.match(out.message, /FAILED/);
  assert.match(out.message, /do not treat it as evidence/i);
});

test("partial failure + zero hits is INCONCLUSIVE, not 'no evidence found'", () => {
  const out = assessSearchOutcome({ roomsAttempted: 5, failures: [{ room: "legal", error: "503" }], hits: 0 });
  assert.equal(out.ok, false);
  assert.match(out.message, /INCONCLUSIVE/);
  assert.match(out.message, /cannot be distinguished/);
});

test("partial failure WITH hits still answers, but is labelled PARTIAL", () => {
  const out = assessSearchOutcome({ roomsAttempted: 5, failures: [{ room: "finance", error: "403" }], hits: 9 });
  assert.equal(out.ok, true);
  assert.equal(out.degraded, true);
  assert.match(out.message, /PARTIAL/);
  assert.match(out.message, /finance/, "the failed room must be named so the gap is actionable");
});

test("a clean search with zero hits IS a real negative finding (exit 0, not an error)", () => {
  const out = assessSearchOutcome({ roomsAttempted: 5, failures: [], hits: 0 });
  assert.equal(out.ok, true);
  assert.equal(out.degraded, false);
  assert.equal(out.message, "");
});

// ── searchRoom's own failure contract, against a stubbed cluster (no network) ──

function withStubbedOpenSearch(handler, fn) {
  const savedFetch = globalThis.fetch;
  const savedEnv = { ...process.env };
  process.env.OPENSEARCH_ENDPOINT = "stub.example.invalid";
  process.env.OPENSEARCH_REGION = "us-east-1";
  process.env.AWS_ACCESS_KEY_ID = "AKIATESTTESTTESTTEST"; // must not start with "prox" (the sandbox proxy placeholder guard)
  process.env.AWS_SECRET_ACCESS_KEY = "test-secret-not-a-real-credential";
  delete process.env.AWS_SESSION_TOKEN;
  delete process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI;
  delete process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI;
  _resetCachesForTests();
  globalThis.fetch = handler;
  const restore = () => {
    globalThis.fetch = savedFetch;
    for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
    Object.assign(process.env, savedEnv);
    _resetCachesForTests();
  };
  return Promise.resolve()
    .then(fn)
    .finally(restore);
}

const osResponse = (rows) => new Response(JSON.stringify({ hits: { hits: rows } }), { status: 200, headers: { "content-type": "application/json" } });
const row = (id, source) => ({ _id: id, _source: source });

test("searchRoom THROWS when the keyword half fails (never returns an empty hit list)", async () => {
  await withStubbedOpenSearch(
    async () => new Response("service unavailable", { status: 503 }),
    async () => {
      await assert.rejects(
        () => OSR.searchRoom("legal-company", { queryText: "indemnification", vector: new Array(3072).fill(0.01), top: 6 }),
        /BM25 search failed 503/,
      );
    },
  );
});

test("searchRoom degrades to keyword-only (mode='keyword') when ONLY the vector half fails", async () => {
  let call = 0;
  await withStubbedOpenSearch(
    async () => {
      call += 1;
      // call 1 = BM25 (ok), call 2 = kNN (fails, e.g. the vector field is absent on that index)
      return call === 1 ? osResponse([row("d1", { content: "a real document", path: "x/y.pdf" })]) : new Response("no such field", { status: 400 });
    },
    async () => {
      const { hits, mode } = await OSR.searchRoom("memory-exec", { queryText: "q", vector: new Array(3072).fill(0.01), top: 6 });
      assert.equal(mode, "keyword", "a degraded-but-real answer, explicitly labelled");
      assert.equal(hits.length, 1);
      assert.equal(hits[0].text, "a real document");
    },
  );
});

test("searchRoom refuses a wrong-dimension vector BEFORE querying (the guard runs at query time)", async () => {
  await withStubbedOpenSearch(
    async () => osResponse([]),
    async () => {
      await assert.rejects(
        () => OSR.searchRoom("memory-exec", { queryText: "q", vector: new Array(1536).fill(0.01), top: 6 }),
        /3072/,
      );
    },
  );
});

// ─────────────────── pure query-shaping / hit-shaping details ───────────────────

test("the vector field is excluded from _source so 3072 floats are never shipped per hit", () => {
  const bm = OSR.buildBm25Body("legal-company", { queryText: "q", size: 10 });
  const kn = OSR.buildKnnBody("legal-company", { vector: [0, 1], size: 10 });
  assert.deepEqual(bm._source.excludes, ["contentVector", "text_vector"]);
  assert.deepEqual(kn._source.excludes, ["contentVector", "text_vector"]);
  assert.ok(kn.query.knn.text_vector, "a chunked room must be queried on text_vector");
  assert.ok(OSR.buildKnnBody("memory-exec", { vector: [0, 1], size: 10 }).query.knn.contentVector, "a flat room must be queried on contentVector");
});

test("chunked rooms over-fetch then collapse to one hit per parent document", () => {
  assert.equal(OSR.fetchSizeFor("legal-company", 6), 18);
  assert.equal(OSR.fetchSizeFor("legal-company", 40), 50, "capped at 50");
  assert.equal(OSR.fetchSizeFor("memory-exec", 6), 6, "flat rooms fetch exactly top");
  const hits = [
    { score: 0.1, _parent: "docA", text: "chunk1" },
    { score: 0.9, _parent: "docA", text: "chunk2" },
    { score: 0.5, _parent: "docB", text: "other" },
  ];
  const out = OSR.collapseParents(hits, 6);
  assert.equal(out.length, 2, "one document must not flood the pool with N of its own chunks");
  assert.equal(out[0].text, "chunk2", "the best-scoring chunk survives");
});

test("shapeHit matches the Azure branch's field precedence", () => {
  const h = OSR.shapeHit("id1", { chunk: "chunk text", title: "T", parent_id: "p1", entity: "INND", agent: "cto", type: "pitfall" }, 0.3);
  assert.equal(h.text, "chunk text");
  assert.equal(h.path, "T");
  assert.equal(h.entity, "INND");
  assert.equal(h._parent, "p1");
  assert.equal(OSR.shapeHit("id2", { content: "c", text: "t" }, 0.1).text, "c", "content wins over text, as in the Azure branch");
});

// ───────────────────────────── chat provider split ─────────────────────────────

test("chatRequestFor: OpenAI addresses the model in the BODY with a bearer token", () => {
  const req = chatRequestFor({ kind: "openai", key: "sk-test", dep: "gpt-5.1" }, { messages: [], max_completion_tokens: 900 });
  assert.equal(req.url, "https://api.openai.com/v1/chat/completions");
  assert.equal(req.headers.Authorization, "Bearer sk-test");
  assert.equal(req.body.model, "gpt-5.1");
  assert.equal(req.headers["api-key"], undefined, "the Azure header must not leak onto the OpenAI request");
});

test("chatRequestFor: Azure bakes the deployment into the URL with an api-key header and no body model", () => {
  const req = chatRequestFor({ kind: "azure", ep: "https://foundry.example", key: "k", dep: "gpt-4.1" }, { messages: [] });
  assert.match(req.url, /^https:\/\/foundry\.example\/openai\/deployments\/gpt-4\.1\/chat\/completions\?/);
  assert.equal(req.headers["api-key"], "k");
  assert.equal(req.body.model, undefined, "Azure resolves the model from the URL, never the body");
});
