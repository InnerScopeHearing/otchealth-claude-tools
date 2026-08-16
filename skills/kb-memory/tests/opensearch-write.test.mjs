// Tests for skills/kb-memory/opensearch-write.mjs. NEVER makes a real network call — every test that
// touches a network path stubs globalThis.fetch (save/restore, mirroring cosmos-auth.test.mjs's own
// withStubbedFetch pattern) and this file only relies on that stub. This matters beyond style: the real
// fleet OpenSearch cluster is not reachable from an arbitrary dev sandbox (verified live during this
// port -- a bare network call to it hangs rather than failing fast, consistent with a VPC/security-group
// -restricted managed domain), so a test that forgot to stub fetch would not fail loudly, it would hang
// the whole toolkit test gate.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EMB_DIMS,
  envCreds,
  resolveAwsCredentials,
  resolveOpenSearchConfig,
  memoryIndexMapping,
  reciprocalRankFusion,
  pushDocs,
  deleteDocs,
  ensureIndex,
  scrollAll,
  existingIds,
  hybridSearch,
  embedOpenAI,
  _resetCachesForTests,
} from "../opensearch-write.mjs";

async function withStubbedFetch(stub, run) {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

async function withEnv(vars, run) {
  const saved = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    // `process.env.X = undefined` stringifies to the literal "undefined" rather than clearing the key
    // (a real Node footgun) -- a caller passing `undefined` here means "make sure this is UNSET".
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  _resetCachesForTests();
  try {
    return await run();
  } finally {
    for (const k of Object.keys(vars)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    _resetCachesForTests();
  }
}

const jsonRes = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// ────────────────────────────────────────────────────────────────────────────────────────────────
// memoryIndexMapping() — the schema this port must match field-for-field against Azure's own schema
// (semantic.mjs's/index-ring-memory.mjs's ensureIndex()) and against the ALREADY-LIVE OpenSearch index.
// ────────────────────────────────────────────────────────────────────────────────────────────────

test("memoryIndexMapping: knn enabled, contentVector at EMB_DIMS (3072), field-for-field parity with the Azure schema", () => {
  assert.equal(EMB_DIMS, 3072);
  const m = memoryIndexMapping();
  assert.equal(m.settings.index.knn, true);
  const p = m.mappings.properties;
  assert.deepEqual(Object.keys(p).sort(), ["agent", "contentVector", "id", "retracted", "tags", "text", "ts", "type"]);
  assert.equal(p.id.type, "keyword");
  assert.equal(p.type.type, "keyword");
  assert.equal(p.ts.type, "keyword");
  assert.equal(p.retracted.type, "boolean");
  assert.equal(p.agent.type, "text");
  assert.equal(p.agent.fields.keyword.type, "keyword"); // exact-match filtering on agent needs the sub-field
  assert.equal(p.contentVector.type, "knn_vector");
  assert.equal(p.contentVector.dimension, EMB_DIMS);
});

// ────────────────────────────────────────────────────────────────────────────────────────────────
// envCreds() — pure, no I/O. The "prox" placeholder guard is load-bearing: signing with it would
// produce a confusing 403 instead of an obvious "no credentials" (see aws-secret.mjs's identical guard).
// ────────────────────────────────────────────────────────────────────────────────────────────────

test("envCreds: both AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY present -> returns them, session token passthrough", async () => {
  await withEnv({ AWS_ACCESS_KEY_ID: "AKIAEXAMPLE00000000", AWS_SECRET_ACCESS_KEY: "sekrit", AWS_SESSION_TOKEN: "tok123" }, () => {
    assert.deepEqual(envCreds(), { accessKeyId: "AKIAEXAMPLE00000000", secretAccessKey: "sekrit", sessionToken: "tok123" });
  });
});

test("envCreds: missing either half -> null", async () => {
  await withEnv({ AWS_ACCESS_KEY_ID: "AKIAEXAMPLE00000000", AWS_SECRET_ACCESS_KEY: undefined }, () => {
    assert.equal(envCreds(), null);
  });
  await withEnv({ AWS_ACCESS_KEY_ID: undefined, AWS_SECRET_ACCESS_KEY: "sekrit" }, () => {
    assert.equal(envCreds(), null);
  });
});

test("envCreds: a 'prox'-prefixed access key (the sandbox proxy's non-functional placeholder) is rejected, case-insensitively", async () => {
  await withEnv({ AWS_ACCESS_KEY_ID: "proxABCDEF", AWS_SECRET_ACCESS_KEY: "sekrit" }, () => {
    assert.equal(envCreds(), null);
  });
  await withEnv({ AWS_ACCESS_KEY_ID: "PROXabcdef", AWS_SECRET_ACCESS_KEY: "sekrit" }, () => {
    assert.equal(envCreds(), null);
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────────────
// resolveAwsCredentials() / resolveOpenSearchConfig() — the counterfactual property: with everything
// supplied via env vars, resolution succeeds WITHOUT any network call at all (not "falls back to a
// mocked success", genuinely zero fetch invocations) -- the strongest form of "this does not depend on
// Key Vault/SSM being reachable."
// ────────────────────────────────────────────────────────────────────────────────────────────────

test("resolveAwsCredentials: env vars alone resolve with ZERO fetch calls", async () => {
  const calls = [];
  await withStubbedFetch(
    async (url) => { calls.push(String(url)); throw new Error("TEST-FAIL: fetch should never be called when env creds are fully set"); },
    () => withEnv({ AWS_ACCESS_KEY_ID: "AKIAEXAMPLE00000000", AWS_SECRET_ACCESS_KEY: "sekrit" }, async () => {
      const creds = await resolveAwsCredentials();
      assert.deepEqual(creds, { accessKeyId: "AKIAEXAMPLE00000000", secretAccessKey: "sekrit", sessionToken: undefined });
      assert.deepEqual(calls, []);
    }),
  );
});

test("resolveOpenSearchConfig: OPENSEARCH_ENDPOINT/REGION + AWS env creds resolve with ZERO fetch calls, and the endpoint is normalized (scheme/trailing slash stripped)", async () => {
  const calls = [];
  await withStubbedFetch(
    async (url) => { calls.push(String(url)); throw new Error("TEST-FAIL: fetch should never be called when everything is env-supplied"); },
    () =>
      withEnv(
        {
          OPENSEARCH_ENDPOINT: "https://unit-test-cluster.us-east-1.es.amazonaws.com/",
          OPENSEARCH_REGION: "us-west-2",
          AWS_ACCESS_KEY_ID: "AKIAEXAMPLE00000000",
          AWS_SECRET_ACCESS_KEY: "sekrit",
        },
        async () => {
          const cfg = await resolveOpenSearchConfig();
          assert.equal(cfg.host, "unit-test-cluster.us-east-1.es.amazonaws.com");
          assert.equal(cfg.region, "us-west-2");
          assert.equal(cfg.accessKeyId, "AKIAEXAMPLE00000000");
          assert.deepEqual(calls, []);
        },
      ),
  );
});

test("resolveOpenSearchConfig: throws a clear error when no AWS credentials are resolvable anywhere (ECS task role absent, env absent, Key Vault denied)", async () => {
  await withStubbedFetch(
    async () => new Response("not found", { status: 404 }), // every fallback tier (Key Vault etc.) fails cleanly
    () =>
      withEnv(
        { AWS_ACCESS_KEY_ID: undefined, AWS_SECRET_ACCESS_KEY: undefined, AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: undefined, AWS_CONTAINER_CREDENTIALS_FULL_URI: undefined },
        async () => {
          await assert.rejects(() => resolveOpenSearchConfig(), /no AWS credentials resolvable/);
        },
      ),
  );
});

// ────────────────────────────────────────────────────────────────────────────────────────────────
// reciprocalRankFusion() — pure math.
// ────────────────────────────────────────────────────────────────────────────────────────────────

test("reciprocalRankFusion: a doc appearing near the top of BOTH lists outranks one appearing in only one", () => {
  const bm = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const knn = [{ id: "b" }, { id: "a" }, { id: "d" }];
  const scores = reciprocalRankFusion([bm, knn]);
  const ranked = [...scores.entries()].sort((x, y) => y[1] - x[1]).map(([id]) => id);
  assert.deepEqual(ranked.slice(0, 2).sort(), ["a", "b"]); // a and b, both in both lists near the top, beat c/d
  assert.ok(scores.get("a") > scores.get("c"));
  assert.ok(scores.get("b") > scores.get("d"));
});

test("reciprocalRankFusion: hits with no id are ignored, never crash", () => {
  const scores = reciprocalRankFusion([[{ id: "a" }, { id: "" }, {}], []]);
  assert.deepEqual([...scores.keys()], ["a"]);
});

// ────────────────────────────────────────────────────────────────────────────────────────────────
// pushDocs() — THE load-bearing correctness property: bulk writes use "update"+doc_as_upsert, NEVER
// "index", for BOTH a full-field doc and a partial-field doc (the retraction-refresh shape).
// ────────────────────────────────────────────────────────────────────────────────────────────────

test("pushDocs: a FULL doc is sent as update+doc_as_upsert:true, never 'index' -- and the id is not duplicated inside the doc body", async () => {
  let sentBody, sentPath, sentContentType;
  await withStubbedFetch(
    async (url, opts) => {
      sentPath = String(url);
      sentBody = opts.body;
      sentContentType = opts.headers["content-type"];
      return jsonRes({ errors: false, items: [{ update: { _id: "cto__abc", status: 200 } }] });
    },
    () =>
      withEnv({ OPENSEARCH_ENDPOINT: "unit.us-east-1.es.amazonaws.com", OPENSEARCH_REGION: "us-east-1", AWS_ACCESS_KEY_ID: "AKIAEXAMPLE00000000", AWS_SECRET_ACCESS_KEY: "sekrit" }, async () => {
        const res = await pushDocs("memory-exec", [{ id: "cto__abc", agent: "cto", type: "pitfall", ts: "2026-08-16T00:00:00.000Z", tags: "", text: "the fix", retracted: false, contentVector: [0.1, 0.2] }]);
        assert.deepEqual(res, { ok: true, ids: ["cto__abc"], errors: [] });
      }),
  );
  assert.match(sentPath, /\/memory-exec\/_bulk$/);
  assert.equal(sentContentType, "application/x-ndjson");
  const lines = sentBody.trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines[0], { update: { _id: "cto__abc" } });
  assert.equal(lines[1].doc_as_upsert, true);
  assert.equal("id" in lines[1].doc, false, "the id must not be duplicated inside the doc body -- it is only the bulk action's _id");
  assert.equal(lines[1].doc.agent, "cto");
  assert.deepEqual(lines[1].doc.contentVector, [0.1, 0.2]);
  assert.equal("index" in lines[0], false);
  assert.equal("create" in lines[0], false);
});

test("pushDocs: a PARTIAL doc (the retraction-refresh shape -- only {retracted}) sends ONLY that field, proving the existing text/contentVector on the live doc would be preserved by OpenSearch's merge, not wiped by a would-be 'index' replace", async () => {
  let sentBody;
  await withStubbedFetch(
    async (url, opts) => { sentBody = opts.body; return jsonRes({ errors: false, items: [{ update: { _id: "cto__old", status: 200 } }] }); },
    () =>
      withEnv({ OPENSEARCH_ENDPOINT: "unit.us-east-1.es.amazonaws.com", OPENSEARCH_REGION: "us-east-1", AWS_ACCESS_KEY_ID: "AKIAEXAMPLE00000000", AWS_SECRET_ACCESS_KEY: "sekrit" }, async () => {
        await pushDocs("memory-exec", [{ id: "cto__old", retracted: true }]);
      }),
  );
  const lines = sentBody.trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines[1].doc, { retracted: true }); // no text, no contentVector, no agent -- exactly what was given
  assert.equal(lines[1].doc_as_upsert, true);
  assert.equal("index" in lines[0], false, "a partial write sent via 'index' would REPLACE the doc and destroy its embedding -- must be 'update'");
});

test("pushDocs: empty list is a no-op success without a network call", async () => {
  await withStubbedFetch(
    async () => { throw new Error("TEST-FAIL: must not fetch for an empty batch"); },
    async () => {
      const res = await pushDocs("memory-exec", []);
      assert.deepEqual(res, { ok: true, ids: [], errors: [] });
    },
  );
});

test("pushDocs: per-item bulk errors are surfaced (ok:false) with the offending id, not silently swallowed", async () => {
  await withStubbedFetch(
    async () => jsonRes({ errors: true, items: [{ update: { _id: "a", status: 200 } }, { update: { _id: "b", status: 409, error: { type: "version_conflict" } } }] }),
    () =>
      withEnv({ OPENSEARCH_ENDPOINT: "unit.us-east-1.es.amazonaws.com", OPENSEARCH_REGION: "us-east-1", AWS_ACCESS_KEY_ID: "AKIAEXAMPLE00000000", AWS_SECRET_ACCESS_KEY: "sekrit" }, async () => {
        const res = await pushDocs("memory-exec", [{ id: "a", text: "x" }, { id: "b", text: "y" }]);
        assert.equal(res.ok, false);
        assert.equal(res.errors.length, 1);
        assert.equal(res.errors[0].id, "b");
      }),
  );
});

// ────────────────────────────────────────────────────────────────────────────────────────────────
// deleteDocs()
// ────────────────────────────────────────────────────────────────────────────────────────────────

test("deleteDocs: sends a bulk 'delete' action per id", async () => {
  let sentBody;
  await withStubbedFetch(
    async (url, opts) => { sentBody = opts.body; return jsonRes({ errors: false, items: [{ delete: { _id: "x", status: 200 } }, { delete: { _id: "y", status: 200 } }] }); },
    () =>
      withEnv({ OPENSEARCH_ENDPOINT: "unit.us-east-1.es.amazonaws.com", OPENSEARCH_REGION: "us-east-1", AWS_ACCESS_KEY_ID: "AKIAEXAMPLE00000000", AWS_SECRET_ACCESS_KEY: "sekrit" }, async () => {
        const res = await deleteDocs("memory-exec", ["x", "y"]);
        assert.equal(res.ok, true);
      }),
  );
  const lines = sentBody.trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines, [{ delete: { _id: "x" } }, { delete: { _id: "y" } }]);
});

test("deleteDocs: a 404 (already-absent doc) is NOT treated as an error -- idempotent delete", async () => {
  await withStubbedFetch(
    async () => jsonRes({ errors: false, items: [{ delete: { _id: "gone", status: 404 } }] }),
    () =>
      withEnv({ OPENSEARCH_ENDPOINT: "unit.us-east-1.es.amazonaws.com", OPENSEARCH_REGION: "us-east-1", AWS_ACCESS_KEY_ID: "AKIAEXAMPLE00000000", AWS_SECRET_ACCESS_KEY: "sekrit" }, async () => {
        const res = await deleteDocs("memory-exec", ["gone"]);
        assert.deepEqual(res, { ok: true, ids: ["gone"], errors: [] });
      }),
  );
});

// ────────────────────────────────────────────────────────────────────────────────────────────────
// ensureIndex() — idempotent create-if-absent.
// ────────────────────────────────────────────────────────────────────────────────────────────────

test("ensureIndex: mapping already present -> no-op, no PUT call", async () => {
  let putCalled = false;
  await withStubbedFetch(
    async (url, opts) => {
      if (opts?.method === "PUT") putCalled = true;
      return jsonRes({ [String(url)]: { mappings: {} } });
    },
    () =>
      withEnv({ OPENSEARCH_ENDPOINT: "unit.us-east-1.es.amazonaws.com", OPENSEARCH_REGION: "us-east-1", AWS_ACCESS_KEY_ID: "AKIAEXAMPLE00000000", AWS_SECRET_ACCESS_KEY: "sekrit" }, async () => {
        const r = await ensureIndex("memory-exec");
        assert.deepEqual(r, { created: false });
      }),
  );
  assert.equal(putCalled, false);
});

test("ensureIndex: mapping absent (404) -> creates it with memoryIndexMapping()'s body", async () => {
  let putBody;
  await withStubbedFetch(
    async (url, opts) => {
      if (!opts || opts.method === undefined) return new Response("not found", { status: 404 }); // GET mapping
      if (opts.method === "PUT") { putBody = JSON.parse(opts.body); return jsonRes({ acknowledged: true }); }
      return new Response("not found", { status: 404 });
    },
    () =>
      withEnv({ OPENSEARCH_ENDPOINT: "unit.us-east-1.es.amazonaws.com", OPENSEARCH_REGION: "us-east-1", AWS_ACCESS_KEY_ID: "AKIAEXAMPLE00000000", AWS_SECRET_ACCESS_KEY: "sekrit" }, async () => {
        const r = await ensureIndex("brand-new-room-memory");
        assert.deepEqual(r, { created: true });
      }),
  );
  assert.deepEqual(putBody, memoryIndexMapping());
});

test("ensureIndex: an unexpected mapping-GET status (not 200, not 404) throws rather than blindly attempting create", async () => {
  await withStubbedFetch(
    async () => new Response("forbidden", { status: 403 }),
    () =>
      withEnv({ OPENSEARCH_ENDPOINT: "unit.us-east-1.es.amazonaws.com", OPENSEARCH_REGION: "us-east-1", AWS_ACCESS_KEY_ID: "AKIAEXAMPLE00000000", AWS_SECRET_ACCESS_KEY: "sekrit" }, async () => {
        await assert.rejects(() => ensureIndex("memory-exec"), /unexpected mapping GET status 403/);
      }),
  );
});

// ────────────────────────────────────────────────────────────────────────────────────────────────
// scrollAll() / existingIds() — full-listing pagination.
// ────────────────────────────────────────────────────────────────────────────────────────────────

test("scrollAll: paginates across 2 pages via the scroll API and clears the scroll cursor when done", async () => {
  let scrollClearCalled = false;
  let call = 0;
  await withStubbedFetch(
    async (url, opts) => {
      const u = String(url);
      if (opts.method === "DELETE") { scrollClearCalled = true; return jsonRes({ succeeded: true }); }
      call++;
      if (call === 1) {
        assert.match(u, /\/memory-exec\/_search\?scroll=2m$/);
        return jsonRes({ _scroll_id: "scroll1", hits: { hits: [{ _id: "a", _source: { agent: "cto" } }, { _id: "b", _source: { agent: "cfo" } }] } });
      }
      assert.match(u, /\/_search\/scroll$/);
      return jsonRes({ _scroll_id: "scroll1", hits: { hits: [] } }); // page 2: empty -> stop
    },
    () =>
      withEnv({ OPENSEARCH_ENDPOINT: "unit.us-east-1.es.amazonaws.com", OPENSEARCH_REGION: "us-east-1", AWS_ACCESS_KEY_ID: "AKIAEXAMPLE00000000", AWS_SECRET_ACCESS_KEY: "sekrit" }, async () => {
        const rows = await scrollAll("memory-exec", { source: ["agent"] });
        assert.deepEqual(rows, [{ id: "a", agent: "cto" }, { id: "b", agent: "cfo" }]);
      }),
  );
  assert.equal(scrollClearCalled, true);
});

test("scrollAll: source:false omits fields, id only", async () => {
  await withStubbedFetch(
    async (url, opts) => {
      if (opts.method === "DELETE") return jsonRes({});
      return jsonRes({ _scroll_id: "s1", hits: { hits: [{ _id: "x" }] } });
    },
    () =>
      withEnv({ OPENSEARCH_ENDPOINT: "unit.us-east-1.es.amazonaws.com", OPENSEARCH_REGION: "us-east-1", AWS_ACCESS_KEY_ID: "AKIAEXAMPLE00000000", AWS_SECRET_ACCESS_KEY: "sekrit" }, async () => {
        const ids = await existingIds("memory-exec");
        assert.ok(ids instanceof Set);
        assert.deepEqual([...ids], ["x"]);
      }),
  );
});

test("scrollAll: an absent index (404 on the first search) returns empty, not an error -- matches semantic.mjs's own tolerance for a first-ever run", async () => {
  await withStubbedFetch(
    async () => new Response("index_not_found_exception", { status: 404 }),
    () =>
      withEnv({ OPENSEARCH_ENDPOINT: "unit.us-east-1.es.amazonaws.com", OPENSEARCH_REGION: "us-east-1", AWS_ACCESS_KEY_ID: "AKIAEXAMPLE00000000", AWS_SECRET_ACCESS_KEY: "sekrit" }, async () => {
        assert.deepEqual(await scrollAll("brand-new-room-memory"), []);
      }),
  );
});

// ────────────────────────────────────────────────────────────────────────────────────────────────
// hybridSearch() — BM25 + kNN, RRF-merged, hit shape matches Azure's recall() contract.
// ────────────────────────────────────────────────────────────────────────────────────────────────

test("hybridSearch: merges BM25 + kNN results via RRF and returns hits shaped like the Azure hit contract", async () => {
  await withStubbedFetch(
    async (url, opts) => {
      const body = JSON.parse(opts.body);
      if (body.query?.bool) {
        // BM25 pass
        return jsonRes({ hits: { hits: [{ _id: "cto__a", _score: 5.1, _source: { agent: "cto", type: "pitfall", ts: "t1", text: "reconnect accounting via xero", tags: "" } }] } });
      }
      // kNN pass
      return jsonRes({ hits: { hits: [{ _id: "cto__a", _score: 0.9, _source: { agent: "cto", type: "pitfall", ts: "t1", text: "reconnect accounting via xero", tags: "" } }, { _id: "cfo__b", _score: 0.5, _source: { agent: "cfo", type: "decision", ts: "t2", text: "unrelated", tags: "" } }] } });
    },
    () =>
      withEnv({ OPENSEARCH_ENDPOINT: "unit.us-east-1.es.amazonaws.com", OPENSEARCH_REGION: "us-east-1", AWS_ACCESS_KEY_ID: "AKIAEXAMPLE00000000", AWS_SECRET_ACCESS_KEY: "sekrit" }, async () => {
        const hits = await hybridSearch("memory-exec", { queryText: "reconnect accounting", vector: [0.1, 0.2], top: 5 });
        assert.equal(hits.length, 2);
        assert.equal(hits[0].agent, "cto"); // appears in BOTH lists -> ranks first
        assert.ok("@search.score" in hits[0]);
        assert.equal(hits[1].agent, "cfo");
      }),
  );
});

test("hybridSearch: no vector supplied -> BM25-only, still returns hits (fail-open on a failed/absent embed)", async () => {
  await withStubbedFetch(
    async () => jsonRes({ hits: { hits: [{ _id: "cto__a", _score: 1, _source: { agent: "cto", type: "status", ts: "t1", text: "hi", tags: "" } }] } }),
    () =>
      withEnv({ OPENSEARCH_ENDPOINT: "unit.us-east-1.es.amazonaws.com", OPENSEARCH_REGION: "us-east-1", AWS_ACCESS_KEY_ID: "AKIAEXAMPLE00000000", AWS_SECRET_ACCESS_KEY: "sekrit" }, async () => {
        const hits = await hybridSearch("memory-exec", { queryText: "hi", vector: null, top: 5 });
        assert.equal(hits.length, 1);
      }),
  );
});

// ────────────────────────────────────────────────────────────────────────────────────────────────
// embedOpenAI() — pinned model, index-order-preserving.
// ────────────────────────────────────────────────────────────────────────────────────────────────

test("embedOpenAI: calls api.openai.com/v1/embeddings with the PINNED text-embedding-3-large model, no 'dimensions' param, returns vectors in input order", async () => {
  let sentUrl, sentBody, sentAuth;
  await withStubbedFetch(
    async (url, opts) => {
      sentUrl = String(url);
      sentBody = JSON.parse(opts.body);
      sentAuth = opts.headers.Authorization;
      return jsonRes({ data: [{ index: 1, embedding: [0.2] }, { index: 0, embedding: [0.1] }] }); // deliberately out of order
    },
    () =>
      withEnv({ OPENAI_API_KEY: "sk-unit-test" }, async () => {
        const vecs = await embedOpenAI(["first", "second"]);
        assert.deepEqual(vecs, [[0.1], [0.2]]); // re-sorted to input order despite the out-of-order response
      }),
  );
  assert.equal(sentUrl, "https://api.openai.com/v1/embeddings");
  assert.equal(sentBody.model, "text-embedding-3-large");
  assert.equal("dimensions" in sentBody, false);
  assert.equal(sentAuth, "Bearer sk-unit-test");
});

test("embedOpenAI: a single 429 is retried and the retry can still succeed", async () => {
  let attempts = 0;
  await withStubbedFetch(
    async () => {
      attempts++;
      if (attempts === 1) return new Response("rate limited", { status: 429 });
      return jsonRes({ data: [{ index: 0, embedding: [0.5] }] });
    },
    () => withEnv({ OPENAI_API_KEY: "sk-unit-test" }, async () => {
      const vecs = await embedOpenAI(["x"]);
      assert.deepEqual(vecs, [[0.5]]);
    }),
  );
  assert.equal(attempts, 2);
});

test("embedOpenAI: throws with no OPENAI_API_KEY resolvable", async () => {
  await withStubbedFetch(
    async () => new Response("not found", { status: 404 }),
    () => withEnv({ OPENAI_API_KEY: undefined }, async () => {
      await assert.rejects(() => embedOpenAI(["x"]), /no OPENAI_API_KEY resolvable/);
    }),
  );
});

// ---------------------------------------------------------------------------------------------
// Regression: an EMPTY ts must be OMITTED from the bulk doc, never sent as "".
//
// Live failure, 2026-08-16 frozen-room backfill: the clo-personal ring push returned
// mapper_parsing_exception "cannot parse empty date" for three ledger rows with a blank ts
// (20260630-054/055/056), losing their text AND embedding on the privileged ring. All three fleet
// memory writers build the field as `ts: entry.ts || ""`; Azure accepted it, OpenSearch does not
// when the index maps ts as `date`.
// ---------------------------------------------------------------------------------------------
test("pushDocs omits an empty ts entirely (cannot parse empty date), but preserves a real one", async () => {
  const original = globalThis.fetch;
  let sentBody = null;
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes("_bulk")) {
      sentBody = opts.body;
      return new Response(JSON.stringify({ errors: false, items: [{ update: { _id: "a", status: 200 } }, { update: { _id: "b", status: 200 } }] }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  };
  try {
    const OS = await import("../opensearch-write.mjs");
    OS._resetCachesForTests?.();
    process.env.OPENSEARCH_ENDPOINT = "unit-test-cluster.us-east-1.es.amazonaws.com";
    process.env.OPENSEARCH_REGION = "us-east-1";
    process.env.AWS_ACCESS_KEY_ID = "AKIAUNITTESTFAKE0000";
    process.env.AWS_SECRET_ACCESS_KEY = "unit-test-fake-secret-access-key-not-real";
    await OS.pushDocs("legal-personal-memory", [
      { id: "a", type: "fact", ts: "", text: "a row whose ledger ts was blank" },
      { id: "b", type: "fact", ts: "2026-08-16T00:00:00.000Z", text: "a row with a real ts" },
    ]);
  } finally {
    globalThis.fetch = original;
  }
  assert.ok(sentBody, "the bulk request must have been sent");
  const lines = sentBody.trim().split("\n").map((l) => JSON.parse(l));
  const docA = lines[1].doc;
  const docB = lines[3].doc;
  assert.equal("ts" in docA, false, "an empty ts must be OMITTED, not sent as an empty string");
  assert.equal(docA.text, "a row whose ledger ts was blank", "the rest of the row must still be written");
  assert.equal(docB.ts, "2026-08-16T00:00:00.000Z", "a real ts must be preserved untouched");
});
