// The allow-listed rooms' freshness check (commons: _KNOWLEDGE/ + _DAILY/, BRAIN_ROOMS.indexPrefixes) used to ask
// OpenSearch "which of these due paths have chunks?" with ONE `_search` (a terms query + a terms aggregation over
// path.keyword). The canary's IAM role (otchealth-aws-dr-canary) holds es:ESHttpPost on <index>/_count ONLY and
// will not get `_search` (it can return document text, and the role runs from a public repo). The check now answers
// the same question with one exact-path `_count` per due path, a few at a time, with the same downstream result
// (which due paths have >= 1 chunk), the same statuses and messages, and the same ERROR-not-STALE rule.
//
// Stubbed-`fetch` integration tests of checkOneBrainRoomFreshness() against the REAL commons registry entry. Same
// harness convention as tests/aws-dr-canary.test.mjs (an S3 listing plus OpenSearch `_count`, nothing else
// reachable): no real network, no real AWS credentials, and the stub records every request, so "no `_search` is
// made" is an assertion on the transport, not on the source text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkOneBrainRoomFreshness, BRAIN_ROOMS } from "../skills/aws-dr-canary/canary.mjs";
import { _resetCredsCacheForTests } from "../skills/kb-memory/s3-blob.mjs";
import { _resetCachesForTests as _resetOpenSearchCachesForTests } from "../skills/kb-memory/opensearch-write.mjs";

const OS_HOST = "unit-test-opensearch.us-east-1.es.amazonaws.com";
const FAKE_ENV = {
  AWS_ACCESS_KEY_ID: "AKIAUNITTESTFAKE0001",
  AWS_SECRET_ACCESS_KEY: "unit-test-fake-secret-access-key-not-real",
  OPENSEARCH_ENDPOINT: OS_HOST,
  OPENSEARCH_REGION: "us-east-1",
};

async function withStubbedFetch(stub, run) {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try { return await run(); } finally { globalThis.fetch = original; }
}
async function withEnv(vars, run) {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; process.env[k] = vars[k]; }
  _resetCredsCacheForTests();
  _resetOpenSearchCachesForTests();
  try { return await run(); } finally {
    for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    _resetCredsCacheForTests();
    _resetOpenSearchCachesForTests();
  }
}

const NOW = Date.now();
const hoursAgo = (h) => new Date(NOW - h * 3600_000).toISOString();
// The real commons registry entry (it declares indexPrefixes, so it takes the allow-listed path), SLO pinned to 48h.
const COMMONS = { ...BRAIN_ROOMS.find((r) => r.name === "commons-company-journal"), sloHours: 48 };
const S3_PREFIX = "/otchealthcommons/company-journal/";
const PATH_PREFIX = "otchealthcommons/company-journal/";
const COUNT_PATH = "/commons-company-journal/_count";

/** `objects`: { "<key relative to the room>": ageInHours }. `count(fullPath)` answers each `_count` probe: a number
 *  (HTTP 200 `{count}`), a full `{status, ok, text}` reply, or it throws (a network-level failure). Every request is
 *  recorded in `calls`; `maxInFlight` is the highest number of `_count` requests open at once. Anything that is not an
 *  S3 listing or a POST to the commons index's `_count` gets a 404 (and a host outside S3 + OS_HOST throws). */
function makeWorld({ objects, count }) {
  const s3 = new Map(Object.entries(objects).map(([name, h]) => [`${S3_PREFIX}${name}`, hoursAgo(h)]));
  const calls = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const stub = async (url, opts = {}) => {
    const { hostname, pathname, searchParams } = new URL(String(url));
    const method = (opts.method || "GET").toUpperCase();
    calls.push({ method, host: hostname, path: pathname, body: opts.body });
    if (hostname.endsWith(".s3.us-east-1.amazonaws.com")) {
      if (searchParams.get("list-type") !== "2") return { ok: false, status: 404, text: async () => "unexpected S3 call in this test" };
      const prefix = searchParams.get("prefix") || "";
      const contents = [...s3.entries()].filter(([k]) => k.startsWith("/" + prefix))
        .map(([k, lastModified]) => `<Contents><Key>${k.slice(1)}</Key><Size>1</Size><LastModified>${lastModified}</LastModified></Contents>`).join("");
      return { ok: true, status: 200, text: async () => `<ListBucketResult>${contents}<IsTruncated>false</IsTruncated></ListBucketResult>` };
    }
    if (hostname === OS_HOST) {
      if (method !== "POST" || pathname !== COUNT_PATH) return { ok: false, status: 404, text: async () => `unexpected OpenSearch call in this test: ${method} ${pathname}` };
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        await new Promise((resolve) => setImmediate(resolve)); // let concurrent probes really overlap
        const reply = count(JSON.parse(opts.body).query?.term?.["path.keyword"]);
        if (typeof reply === "number") return { ok: true, status: 200, text: async () => JSON.stringify({ count: reply }) };
        return reply;
      } finally { inFlight--; }
    }
    throw new Error(`TEST SAFETY: fetch reached an unrecognized host "${hostname}" (${method} ${url}) -- this check must never leave S3 + the configured OpenSearch host`);
  };
  return { stub, calls, get maxInFlight() { return maxInFlight; } };
}

const run = (world, room = COMMONS) => withEnv(FAKE_ENV, () => withStubbedFetch(world.stub, () => checkOneBrainRoomFreshness(room)));
const osCalls = (world) => world.calls.filter((c) => c.host === OS_HOST);
const probedPaths = (world) => osCalls(world).map((c) => JSON.parse(c.body).query.term["path.keyword"]).sort();
const forbidden = (status, text = "Forbidden") => ({ ok: false, status, text: async () => text });

/** The transport-level guarantee: the only OpenSearch requests are POST <index>/_count with a bare
 *  `{query:{term:{"path.keyword": <one exact path>}}}` body (no aggs, no size, no hit list) -- never a `_search`. */
function assertCountOnly(world) {
  const os = osCalls(world);
  assert.ok(os.length > 0, "expected at least one OpenSearch request");
  assert.ok(!world.calls.some((c) => /_search/.test(c.path)), "no request may target _search");
  for (const c of os) {
    assert.equal(c.method, "POST");
    assert.equal(c.path, COUNT_PATH);
    const body = JSON.parse(c.body);
    assert.deepEqual(Object.keys(body), ["query"], "a _count body carries a query and nothing else");
    assert.deepEqual(Object.keys(body.query), ["term"]);
    assert.deepEqual(Object.keys(body.query.term), ["path.keyword"]);
    assert.equal(typeof body.query.term["path.keyword"], "string");
  }
}

const DUE = [ // newest first: the order pickDueObjects() puts them in
  "_KNOWLEDGE/research/fleet/2026-09-26-beta-22222222.md",
  "_DAILY/2026-09-25.md",
  "_KNOWLEDGE/research/fleet/2026-09-20-alpha-11111111.md",
];
const OBJECTS = {
  [DUE[0]]: 100,
  [DUE[1]]: 120,
  [DUE[2]]: 200,
  "_KNOWLEDGE/research/fleet/2026-10-05-new-33333333.md": 5, // inside the 48h SLO: not due yet, never probed
  "_KNOWLEDGE/design/mock.png": 130, // not an indexable text object
  "_TEXT/_KNOWLEDGE/research/fleet/alpha.md.txt": 110, // pipeline bookkeeping
  "_JOURNAL/cfo/2026-09-01/_DIGEST.md": 300, // ring-private and outside the allow-list: must never be probed
  "_MEMORY/_exec/cto.md": 300,
};

test("all due objects present -> OK; one exact-path _count per due path, nothing outside the allow-list probed, no _search", async () => {
  const world = makeWorld({ objects: OBJECTS, count: () => 3 });
  const r = await run(world);
  assert.equal(r.name, "brain-room-commons-company-journal");
  assert.equal(r.status, "OK");
  assert.match(r.detail, /^all 3 due object\(s\), each past the 48h SLO, are present in the index by exact path match \(newest overall: "_KNOWLEDGE\/research\/fleet\/2026-10-05-new-33333333\.md", \d+\.\dh old, informational\)$/);
  assert.deepEqual(probedPaths(world), DUE.map((n) => `${PATH_PREFIX}${n}`).sort());
  assert.ok(world.calls.some((c) => c.host.endsWith(".s3.us-east-1.amazonaws.com")), "must have listed S3");
  assertCountOnly(world);
});

test("a due object past its SLO with zero chunks -> STALE naming it, even when a newer due object is present", async () => {
  const missing = DUE[2]; // the OLDEST due object; the two newer ones are indexed
  const world = makeWorld({ objects: OBJECTS, count: (p) => (p === `${PATH_PREFIX}${missing}` ? 0 : 4) });
  const r = await run(world);
  assert.equal(r.status, "STALE");
  assert.match(r.detail, /^1 of 3 due object\(s\), each past the 48h SLO, have ZERO chunks in the index by exact path match: _KNOWLEDGE\/research\/fleet\/2026-09-20-alpha-11111111\.md \(newest overall:/);
  assert.ok(!r.detail.includes("beta-22222222") && !r.detail.includes("2026-09-25"), "present objects are not named");
  assertCountOnly(world);
});

test("a 403 on one _count -> ERROR for the whole room, never OK or STALE, even though another due path is genuinely missing", async () => {
  const world = makeWorld({
    objects: OBJECTS,
    count: (p) => (p.endsWith("2026-09-25.md") ? forbidden(403) : p.endsWith("alpha-11111111.md") ? 0 : 5),
  });
  const r = await run(world);
  assert.equal(r.status, "ERROR");
  assert.match(r.detail, /^cannot check \(OpenSearch _count HTTP 403 for index "commons-company-journal"\): Forbidden$/);
  assert.ok(!/_search|ZERO chunks/.test(r.detail), "the missing alpha object must not be judged once a probe could not run");
  assertCountOnly(world);
});

test("a _count reply without a numeric count (empty object, string, non-JSON page) -> ERROR, never read as 0", async () => {
  for (const text of ["{}", '{"count":"3"}', "<html>502 Bad Gateway</html>", "null"]) {
    const world = makeWorld({
      objects: OBJECTS,
      count: (p) => (p.endsWith("beta-22222222.md") ? { ok: true, status: 200, text: async () => text } : 0),
    });
    const r = await run(world);
    assert.equal(r.status, "ERROR", text);
    assert.match(r.detail, /^cannot check \(OpenSearch _count against "commons-company-journal": response carried no numeric count/, text);
    assertCountOnly(world);
  }
});

test("a network exception on one _count -> ERROR (cannot check), not STALE", async () => {
  const world = makeWorld({
    objects: OBJECTS,
    count: (p) => { if (p.endsWith("2026-09-25.md")) throw new Error("simulated opensearch connection reset"); return 0; },
  });
  const r = await run(world);
  assert.equal(r.status, "ERROR");
  assert.match(r.detail, /^cannot check \(OpenSearch _count against "commons-company-journal" failed\): simulated opensearch connection reset$/);
});

test("probes run with small bounded concurrency, and the due cap is unchanged: the 200 newest of 230 due objects, no more", async () => {
  const objects = {};
  for (let i = 0; i < 230; i++) objects[`_KNOWLEDGE/bulk/2026-08-01-doc${String(i).padStart(3, "0")}-${String(i).padStart(8, "0")}.md`] = 100 + i; // doc000 newest ... doc229 oldest
  const world = makeWorld({ objects, count: () => 1 });
  const r = await run(world);
  assert.equal(r.status, "OK");
  assert.match(r.detail, /^all 200 due object\(s\) \(the 200 newest of 230 due\), each past the 48h SLO, are present in the index by exact path match/);
  const probed = probedPaths(world);
  assert.equal(probed.length, 200, "exactly one _count per capped due path");
  assert.deepEqual(probed, Object.keys(objects).slice(0, 200).map((n) => `${PATH_PREFIX}${n}`).sort(), "the 30 oldest due objects are beyond the cap");
  assert.ok(world.maxInFlight > 1, `probes should overlap (max in flight ${world.maxInFlight})`);
  assert.ok(world.maxInFlight <= 5, `at most 5 probes in flight, saw ${world.maxInFlight}`);
  assertCountOnly(world);
});

test("a systematic failure (403 on every _count) stops after the first in-flight batch instead of probing every due path", async () => {
  const objects = {};
  for (let i = 0; i < 40; i++) objects[`_KNOWLEDGE/bulk/2026-08-01-doc${String(i).padStart(3, "0")}-${String(i).padStart(8, "0")}.md`] = 100 + i;
  const world = makeWorld({ objects, count: () => forbidden(403) });
  const r = await run(world);
  assert.equal(r.status, "ERROR");
  assert.match(r.detail, /HTTP 403/);
  assert.ok(osCalls(world).length <= 5, `expected at most one batch of in-flight probes, got ${osCalls(world).length}`);
});

test("canary.mjs no longer imports or calls osSearch (the canary role has no _search grant)", () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "skills", "aws-dr-canary", "canary.mjs"), "utf8");
  assert.doesNotMatch(src, /\bosSearch\b/);
});
