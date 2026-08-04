// Regression gate for skills/fleet-backup/cosmos-export.mjs, the DIRECT Cosmos REST client that
// closes DR gap #8 (memory / events / decisions_pending had ZERO backup coverage -- see
// backup.mjs's own "GAP-8" header note). Pure network mocking (globalThis.fetch stubbed), same style
// as tests/cosmos-auth.test.mjs / tests/fleet-medic.test.mjs -- no real Cosmos calls here (those are
// covered by a live, independently-verified run against production, see the PR description).
//
// Load-bearing guarantees pinned here (this is exactly the class of bug this module exists to avoid
// -- see backup.mjs's `fetchOffloaded` / FND-20260728-b8a0 history for the real-world precedent of a
// pagination contract mismatch silently truncating an export to "0 rows, reported as a success"):
//   1. a single page with no continuation token returns exactly that page's docs, nothing dropped,
//      nothing duplicated.
//   2. a MULTI-PAGE response (continuation token present) is drained to exhaustion and reassembled
//      into ONE array -- this is the exact shape of bug class that already bit this repo once
//      (fetchOffloaded's 0-vs-1-indexed / has_more-vs-no-such-field mismatch): if this file ever
//      stops walking x-ms-continuation correctly, this test catches it immediately.
//   3. MULTIPLE PARTITION-KEY RANGES are each drained independently and the results are concatenated
//      -- a query against a partitioned container is not complete until every pk-range's own
//      continuation chain is exhausted, not just the first one.
//   4. there is NO row cap anywhere in queryContainerAll -- unlike kb-memory's queryMemory (capped at
//      5000 for its own bounded use case), a DR export must never silently stop early.
//   5. a non-2xx response at ANY point (pkranges call, first page, or a LATER page mid-drain) throws
//      -- this module NEVER degrades to "return what we got so far" the way the pre-fix
//      fetchOffloaded silently did.
//   6. the container allowlist is enforced -- an unknown container name (including "tasks", which is
//      deliberately NOT in this module's allowlist; it stays on the gateway path in backup.mjs) is
//      rejected before any network call is made.
//   7. isCosmosConfigured()/the "not configured" error path degrade cleanly when no credentials are
//      resolvable, rather than throwing an unrelated error deep in a fetch call.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  COSMOS_CONTAINERS,
  isCosmosConfigured,
  queryContainerAll,
  dumpContainer,
  _resetConfigForTests,
} from "../skills/fleet-backup/cosmos-export.mjs";

const FAKE_ENDPOINT = "https://fake-cosmos.example.invalid:443/";
const FAKE_KEY = "c3VwZXItc2VjcmV0LW1hc3Rlci1rZXktbm90LXJlYWw="; // base64, matches cosmos-auth.test.mjs's fixture shape
const FAKE_DB = "agent-state";

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
  const prev = {};
  for (const k of Object.keys(vars)) prev[k] = process.env[k];
  Object.assign(process.env, vars);
  _resetConfigForTests();
  try {
    return await run();
  } finally {
    for (const k of Object.keys(vars)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
    _resetConfigForTests();
  }
}

const REAL_ENV = { COSMOS_ENDPOINT: FAKE_ENDPOINT, COSMOS_KEY: FAKE_KEY, COSMOS_DB: FAKE_DB };

beforeEach(() => {
  _resetConfigForTests();
});

function jsonResponse(status, body, headers = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    text: async () => JSON.stringify(body),
  };
}

// ---------------------------------------------------------------- container allowlist ----
test("COSMOS_CONTAINERS: exposes exactly memory/events/decisions_pending with their real partition-key field names", () => {
  assert.deepEqual(Object.keys(COSMOS_CONTAINERS).sort(), ["decisions_pending", "events", "memory"]);
  assert.equal(COSMOS_CONTAINERS.memory.pk, "agent");
  assert.equal(COSMOS_CONTAINERS.events.pk, "task_id");
  assert.equal(COSMOS_CONTAINERS.decisions_pending.pk, "owner");
});

test("dumpContainer(): rejects an unknown container name BEFORE any network call (path-injection guard)", async () => {
  let fetchCalled = false;
  await withEnv(REAL_ENV, async () => {
    await withStubbedFetch(
      async () => { fetchCalled = true; return jsonResponse(200, {}); },
      async () => {
        await assert.rejects(() => dumpContainer("tasks"), /unknown container "tasks"/);
        await assert.rejects(() => dumpContainer("../../etc/passwd"), /unknown container/);
        await assert.rejects(() => dumpContainer("memory_evil"), /unknown container/);
      },
    );
  });
  assert.equal(fetchCalled, false, "must reject before ever calling fetch");
});

// ---------------------------------------------------------------- config resolution ----
test("isCosmosConfigured(): false when no credentials resolve anywhere (env unset, Key Vault stubbed to deny)", async () => {
  await withEnv({ COSMOS_ENDPOINT: "", COSMOS_KEY: "", COSMOS_DB: "" }, async () => {
    delete process.env.COSMOS_ENDPOINT;
    delete process.env.COSMOS_KEY;
    delete process.env.COSMOS_DB;
    _resetConfigForTests();
    await withStubbedFetch(
      async () => ({ ok: false, status: 401, json: async () => ({}), text: async () => "" }),
      async () => {
        assert.equal(await isCosmosConfigured(), false);
      },
    );
  });
});

test("isCosmosConfigured(): true once COSMOS_ENDPOINT/COSMOS_KEY are set via env (no network call needed)", async () => {
  await withEnv(REAL_ENV, async () => {
    assert.equal(await isCosmosConfigured(), true);
  });
});

test("queryContainerAll(): throws a clear 'not configured' error rather than a confusing fetch/auth error when no credentials resolve", async () => {
  await withEnv({}, async () => {
    delete process.env.COSMOS_ENDPOINT;
    delete process.env.COSMOS_KEY;
    _resetConfigForTests();
    await withStubbedFetch(
      async () => ({ ok: false, status: 401, json: async () => ({}), text: async () => "" }),
      () => assert.rejects(() => dumpContainer("memory"), /not configured/),
    );
  });
});

// ---------------------------------------------------------------- pagination correctness ----
test("queryContainerAll(): single pk-range, single page (no continuation) -- returns exactly that page's docs", async () => {
  await withEnv(REAL_ENV, async () => {
    const calls = [];
    const rows = await withStubbedFetch(
      async (url, init) => {
        calls.push(String(url));
        if (String(url).endsWith("/pkranges")) {
          return jsonResponse(200, { PartitionKeyRanges: [{ id: "0" }] });
        }
        return jsonResponse(200, { Documents: [{ id: "a" }, { id: "b" }] }); // no x-ms-continuation header
      },
      () => dumpContainer("memory"),
    );
    assert.deepEqual(rows.map((r) => r.id), ["a", "b"]);
    // exactly one pkranges call + one docs call, no extra pages fetched
    assert.equal(calls.filter((u) => u.endsWith("/pkranges")).length, 1);
    assert.equal(calls.filter((u) => u.endsWith("/docs")).length, 1);
  });
});

test("queryContainerAll(): MULTI-PAGE single pk-range -- drains x-ms-continuation to exhaustion and reassembles every page (the exact bug class that already bit this repo once)", async () => {
  await withEnv(REAL_ENV, async () => {
    // 3 pages of 2 docs each, chained by continuation tokens; the 3rd page has none -> stop.
    const pages = [
      { docs: [{ id: "p1a" }, { id: "p1b" }], cont: "TOKEN-2" },
      { docs: [{ id: "p2a" }, { id: "p2b" }], cont: "TOKEN-3" },
      { docs: [{ id: "p3a" }, { id: "p3b" }], cont: null },
    ];
    let pageIdx = 0;
    const seenContinuationsSent = [];
    const rows = await withStubbedFetch(
      async (url, init) => {
        if (String(url).endsWith("/pkranges")) return jsonResponse(200, { PartitionKeyRanges: [{ id: "0" }] });
        seenContinuationsSent.push((init.headers || {})["x-ms-continuation"] ?? null);
        const p = pages[pageIdx++];
        return jsonResponse(200, { Documents: p.docs }, p.cont ? { "x-ms-continuation": p.cont } : {});
      },
      () => dumpContainer("memory"),
    );
    assert.deepEqual(rows.map((r) => r.id), ["p1a", "p1b", "p2a", "p2b", "p3a", "p3b"], "all 3 pages reassembled in order, nothing dropped, nothing duplicated");
    assert.equal(pageIdx, 3, "must fetch exactly 3 pages -- not stop early (0-vs-1-indexed style bug), not loop past exhaustion");
    // the SECOND request must present the token the FIRST response returned, etc. -- this is the
    // exact contract mismatch class (page N+1 not actually keyed off page N's real continuation
    // value) that silently truncated a different gateway-mediated export in this repo before.
    assert.deepEqual(seenContinuationsSent, [null, "TOKEN-2", "TOKEN-3"]);
  });
});

test("queryContainerAll(): MULTIPLE pk-ranges are each drained independently and results concatenated (a single continuation token is only valid WITHIN the pk-range that issued it)", async () => {
  await withEnv(REAL_ENV, async () => {
    const perRangeCalls = {};
    const rows = await withStubbedFetch(
      async (url, init) => {
        if (String(url).endsWith("/pkranges")) {
          return jsonResponse(200, { PartitionKeyRanges: [{ id: "0" }, { id: "1" }] });
        }
        const rid = (init.headers || {})["x-ms-documentdb-partitionkeyrangeid"];
        perRangeCalls[rid] = (perRangeCalls[rid] || 0) + 1;
        if (rid === "0") {
          // range 0: 2 pages
          if (perRangeCalls[rid] === 1) return jsonResponse(200, { Documents: [{ id: "r0-a" }] }, { "x-ms-continuation": "R0-TOKEN-2" });
          return jsonResponse(200, { Documents: [{ id: "r0-b" }] });
        }
        // range 1: 1 page
        return jsonResponse(200, { Documents: [{ id: "r1-a" }] });
      },
      () => dumpContainer("events"),
    );
    assert.deepEqual(rows.map((r) => r.id).sort(), ["r0-a", "r0-b", "r1-a"].sort());
    assert.equal(perRangeCalls["0"], 2, "range 0's own continuation chain must be fully drained");
    assert.equal(perRangeCalls["1"], 1, "range 1 has only 1 page");
  });
});

test("queryContainerAll(): NO row cap -- a large number of pages is fully drained, not truncated at any fixed size (unlike kb-memory's bounded queryMemory)", async () => {
  await withEnv(REAL_ENV, async () => {
    const TOTAL_PAGES = 40; // well past any plausible accidental small cap (25/50/100/etc.)
    let pageIdx = 0;
    const rows = await withStubbedFetch(
      async (url, init) => {
        if (String(url).endsWith("/pkranges")) return jsonResponse(200, { PartitionKeyRanges: [{ id: "0" }] });
        const i = pageIdx++;
        const isLast = i === TOTAL_PAGES - 1;
        return jsonResponse(200, { Documents: [{ id: `doc-${i}` }] }, isLast ? {} : { "x-ms-continuation": `tok-${i + 1}` });
      },
      () => dumpContainer("decisions_pending"),
    );
    assert.equal(rows.length, TOTAL_PAGES);
    assert.equal(rows[0].id, "doc-0");
    assert.equal(rows[TOTAL_PAGES - 1].id, `doc-${TOTAL_PAGES - 1}`);
  });
});

// ---------------------------------------------------------------- fail-loud, never partial ----
test("queryContainerAll(): a non-2xx on the FIRST page throws (never returns an empty array as if the container were genuinely empty)", async () => {
  await withEnv(REAL_ENV, async () => {
    await withStubbedFetch(
      async (url) => {
        if (String(url).endsWith("/pkranges")) return jsonResponse(200, { PartitionKeyRanges: [{ id: "0" }] });
        return jsonResponse(500, { message: "internal error" });
      },
      () => assert.rejects(() => dumpContainer("memory"), /HTTP 500/),
    );
  });
});

test("queryContainerAll(): a non-2xx on a LATER page (mid-drain) throws -- never silently returns the partial rows collected so far", async () => {
  await withEnv(REAL_ENV, async () => {
    let call = 0;
    await withStubbedFetch(
      async (url) => {
        if (String(url).endsWith("/pkranges")) return jsonResponse(200, { PartitionKeyRanges: [{ id: "0" }] });
        call++;
        if (call === 1) return jsonResponse(200, { Documents: [{ id: "ok-page-1" }] }, { "x-ms-continuation": "tok-2" });
        return jsonResponse(503, { message: "throttled" }); // page 2 fails
      },
      () => assert.rejects(() => dumpContainer("memory"), /HTTP 503/),
    );
  });
});

test("queryContainerAll(): a failed pkranges call throws immediately (never silently treats the container as having zero pk-ranges / zero docs)", async () => {
  await withEnv(REAL_ENV, async () => {
    await withStubbedFetch(
      async (url) => (String(url).endsWith("/pkranges") ? jsonResponse(403, { message: "forbidden" }) : jsonResponse(200, { Documents: [] })),
      () => assert.rejects(() => dumpContainer("memory"), /pkranges memory/),
    );
  });
});

// ---------------------------------------------------------------- custom query / pageSize plumbing ----
test("queryContainerAll(): a custom query string and parameters are forwarded verbatim in the request body", async () => {
  await withEnv(REAL_ENV, async () => {
    let seenBody = null;
    await withStubbedFetch(
      async (url, init) => {
        if (String(url).endsWith("/pkranges")) return jsonResponse(200, { PartitionKeyRanges: [{ id: "0" }] });
        seenBody = JSON.parse(init.body);
        return jsonResponse(200, { Documents: [] });
      },
      () => queryContainerAll("decisions_pending", "SELECT VALUE COUNT(1) FROM c WHERE c.owner = @owner", [{ name: "@owner", value: "cto" }]),
    );
    assert.equal(seenBody.query, "SELECT VALUE COUNT(1) FROM c WHERE c.owner = @owner");
    assert.deepEqual(seenBody.parameters, [{ name: "@owner", value: "cto" }]);
  });
});

test("queryContainerAll(): a custom pageSize is forwarded as x-ms-max-item-count on every page request", async () => {
  await withEnv(REAL_ENV, async () => {
    const seenMaxItemCounts = [];
    await withStubbedFetch(
      async (url, init) => {
        if (String(url).endsWith("/pkranges")) return jsonResponse(200, { PartitionKeyRanges: [{ id: "0" }] });
        seenMaxItemCounts.push((init.headers || {})["x-ms-max-item-count"]);
        return jsonResponse(200, { Documents: [] });
      },
      () => queryContainerAll("memory", "SELECT * FROM c", [], { pageSize: 37 }),
    );
    assert.deepEqual(seenMaxItemCounts, ["37"]);
  });
});

test("dumpContainer(): issues 'SELECT * FROM c' with no parameters", async () => {
  await withEnv(REAL_ENV, async () => {
    let seenBody = null;
    await withStubbedFetch(
      async (url, init) => {
        if (String(url).endsWith("/pkranges")) return jsonResponse(200, { PartitionKeyRanges: [{ id: "0" }] });
        seenBody = JSON.parse(init.body);
        return jsonResponse(200, { Documents: [] });
      },
      () => dumpContainer("events"),
    );
    assert.equal(seenBody.query, "SELECT * FROM c");
    assert.deepEqual(seenBody.parameters, []);
  });
});
