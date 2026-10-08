// Regression tests for `os-snapshot.mjs restore-drill`, the weekly OpenSearch restore proof that the
// nightly AWS DR canary runs on UTC Sundays.
//
// THE INCIDENT. The Sunday drills of 2026-09-06 and 2026-10-04 failed with
//   restore call failed: HTTP 500 {"error":{"root_cause":[{"type":"snapshot_restore_exception","reason":
//   "[otchealth-brain-s3:otchealth-brain-nightly-2026-10-04t07%3A00%3A58-h9xm48sl] snapshot does not exist"}]...
// while the canary's own opensearch-snapshot check, in the SAME run, listed that very snapshot as healthy.
// Snapshot Management names carry ':' ("...t07:00:58-..."). os-snapshot.mjs built the restore path with
// encodeURIComponent(), and since #529/#532 (2026-09-02) osFetch() percent-encodes every path segment itself,
// exactly once, so the pre-encoded %3A went out as %253A. OpenSearch decodes a path once, got the literal text
// "t07%3A00%3A58", and found no such snapshot.
//
// A SECOND, independent defect surfaced in the 2026-08-30 run: the drill restored the smallest index even
// when it was EMPTY ("live index cs-knowledge reports 0 docs -- cannot compute a meaningful tolerance").
//
// The fake cluster below decodes each path segment exactly ONCE, like the real server. That is what makes
// these tests fail on the pre-fix code with the production symptom instead of passing against a stub that is
// too forgiving. No network, no AWS credentials, no real OpenSearch domain: every fetch is intercepted, and
// the stub throws on any host or route it does not recognize.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as snap from "../skills/fleet-backup/os-snapshot.mjs";
import { osFetch } from "../skills/doc-indexer/opensearch-client.mjs";

const REPO = "otchealth-brain-s3";
// The exact snapshot id from the failing 2026-10-04 canary run.
const COLON_ID = "otchealth-brain-nightly-2026-10-04t07:00:58-h9xm48sl";
const COLON_ID_WIRE = "otchealth-brain-nightly-2026-10-04t07%3A00%3A58-h9xm48sl";
const OLDER_COLON_ID = "otchealth-brain-nightly-2026-10-03t07:00:58-k2m9q4zz";
const DOMAIN_HOST = "unit-test-brain.us-east-1.es.amazonaws.com";
const FAKE_ENV = {
  AWS_ACCESS_KEY_ID: "AKIAUNITTESTFAKE0002",
  AWS_SECRET_ACCESS_KEY: "unit-test-fake-secret-access-key-not-real",
};
const UNSET_ENV = [
  "AWS_SESSION_TOKEN", "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "OTC_AWS_ACCESS_KEY_ID", "OTC_AWS_SECRET_ACCESS_KEY", "OTC_AWS_SESSION_TOKEN",
];

/** An in-memory OpenSearch domain speaking just the REST surface the drill uses.
 *  live:      { indexName: docCount | null }  (null = a closed index, which reports no docs.count)
 *  snapshots: [{ id, endEpoch, indices: [names] }]
 *  catRows:   optional override of the _cat/snapshots listing (an id the listing shows but that cannot be resolved)
 *  restoredDocs: { indexName: docs in the snapshot copy }, defaulting to the live count */
function makeCluster({ live = {}, snapshots = [], catRows = null, restoredDocs = {} } = {}) {
  const indices = new Map(Object.entries(live));
  const calls = [];
  const reply = (status, obj) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(obj) });
  const failure = (status, type, reason) => reply(status, { error: { root_cause: [{ type, reason }], type, reason }, status });
  const find = (repo, id) => (repo === REPO ? snapshots.find((s) => s.id === id) : undefined);
  const stub = async (url, init = {}) => {
    const u = new URL(String(url));
    const method = (init.method || "GET").toUpperCase();
    calls.push({ method, host: u.hostname, wirePath: u.pathname, search: u.search, body: init.body });
    if (/^es\.[a-z0-9-]+\.amazonaws\.com$/.test(u.hostname)) return reply(200, { DomainStatus: { Endpoint: DOMAIN_HOST } });
    if (u.hostname !== DOMAIN_HOST) throw new Error(`TEST SAFETY: fetch reached unexpected host "${u.hostname}"`);
    // The server decodes each path segment exactly ONCE. That single decode is the whole bug.
    const seg = u.pathname.split("/").slice(1).map((s) => decodeURIComponent(s));

    if (method === "GET" && seg.length === 2 && seg[0] === "_cat" && seg[1] === "indices") {
      return reply(200, [...indices].map(([index, n]) => ({ index, "docs.count": n === null ? null : String(n) })));
    }
    if (method === "GET" && seg.length === 2 && seg[0] === "_snapshot") {
      return seg[1] === REPO ? reply(200, { [REPO]: { type: "s3" } }) : failure(404, "repository_missing_exception", `[${seg[1]}] missing`);
    }
    if (method === "GET" && seg.length === 3 && seg[0] === "_cat" && seg[1] === "snapshots" && seg[2] === REPO) {
      return reply(200, catRows || snapshots.map((s) => ({ id: s.id, status: "SUCCESS", end_epoch: String(s.endEpoch) })));
    }
    if (method === "GET" && seg.length === 3 && seg[0] === "_snapshot") {
      const s = find(seg[1], seg[2]);
      return s
        ? reply(200, { snapshots: [{ snapshot: s.id, state: "SUCCESS", indices: s.indices }] })
        : failure(404, "snapshot_missing_exception", `[${seg[1]}:${seg[2]}] is missing`);
    }
    if (method === "POST" && seg.length === 4 && seg[0] === "_snapshot" && seg[3] === "_restore") {
      const s = find(seg[1], seg[2]);
      if (!s) return failure(500, "snapshot_restore_exception", `[${seg[1]}:${seg[2]}] snapshot does not exist`);
      const body = JSON.parse(init.body);
      for (const name of String(body.indices).split(",")) {
        if (!s.indices.includes(name)) return failure(500, "snapshot_restore_exception", `[${seg[1]}:${seg[2]}] indices [${name}] missing`);
        const target = name.replace(new RegExp(body.rename_pattern), body.rename_replacement);
        if (indices.has(target)) return failure(500, "snapshot_restore_exception", `cannot restore index [${target}] because an open index with same name already exists in the cluster`);
        indices.set(target, restoredDocs[name] ?? live[name]);
      }
      return reply(200, { accepted: true });
    }
    if (method === "GET" && seg.length === 3 && seg[0] === "_cluster" && seg[1] === "health") {
      return indices.has(seg[2]) ? reply(200, { status: "green" }) : reply(408, { status: "red", timed_out: true });
    }
    if (method === "POST" && seg.length === 2 && seg[1] === "_count") {
      return indices.has(seg[0]) ? reply(200, { count: indices.get(seg[0]) }) : failure(404, "index_not_found_exception", `no such index [${seg[0]}]`);
    }
    if (method === "DELETE" && seg.length === 1) {
      if (!indices.has(seg[0])) return failure(404, "index_not_found_exception", `no such index [${seg[0]}]`);
      indices.delete(seg[0]);
      return reply(200, { acknowledged: true });
    }
    throw new Error(`TEST SAFETY: unrecognized request ${method} ${u.pathname}${u.search}`);
  };
  return { stub, calls, indices };
}

/** Run restore-drill against a fake cluster. Never throws: returns { error, logs }. */
async function runDrill(world, argv = ["--repo", REPO]) {
  const logs = [];
  const real = { log: console.log, fetch: globalThis.fetch, setTimeout: globalThis.setTimeout };
  const savedEnv = {};
  for (const k of [...Object.keys(FAKE_ENV), ...UNSET_ENV]) savedEnv[k] = process.env[k];
  for (const k of UNSET_ENV) delete process.env[k];
  Object.assign(process.env, FAKE_ENV);
  console.log = (...a) => { logs.push(a.join(" ")); };
  globalThis.fetch = world.stub;
  // The drill sleeps 2s between recovery polls; skip that wait. Every other timer keeps its real delay.
  globalThis.setTimeout = (fn, ms, ...a) => real.setTimeout(fn, ms === 2000 ? 0 : ms, ...a);
  try {
    let error = null;
    try { await snap.cmdRestoreDrill(argv); } catch (e) { error = e; }
    return { error, logs };
  } finally {
    console.log = real.log;
    globalThis.fetch = real.fetch;
    globalThis.setTimeout = real.setTimeout;
    for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

const restoreCalls = (world) => world.calls.filter((c) => c.method === "POST" && c.wirePath.endsWith("/_restore"));
const leftoverDrillIndices = (world) => [...world.indices.keys()].filter((n) => n.startsWith("drill-"));

// ---------- the root cause, pinned at the signer/transport boundary ----------

test("root cause: a pre-encoded snapshot id reaches OpenSearch double-encoded and is 'snapshot does not exist'; a RAW segment resolves", async () => {
  const world = makeCluster({
    live: { "tiny-room": 5 },
    snapshots: [{ id: COLON_ID, endEpoch: 1790000000, indices: ["tiny-room"] }],
  });
  const cfg = { host: DOMAIN_HOST, region: "us-east-1", accessKeyId: FAKE_ENV.AWS_ACCESS_KEY_ID, secretAccessKey: FAKE_ENV.AWS_SECRET_ACCESS_KEY };
  const body = JSON.stringify({ indices: "tiny-room", rename_pattern: "(.+)", rename_replacement: "drill-$1", include_global_state: false });
  const real = globalThis.fetch;
  globalThis.fetch = world.stub;
  try {
    // What os-snapshot.mjs sent before the fix.
    const bad = await osFetch(cfg, { method: "POST", path: `/_snapshot/${REPO}/${encodeURIComponent(COLON_ID)}/_restore`, body });
    const badText = await bad.text();
    assert.equal(bad.status, 500);
    assert.match(badText, /snapshot does not exist/);
    assert.ok(badText.includes("t07%3A00%3A58"), "the server must see the literal percent text, as in the production log");
    assert.ok(world.calls.at(-1).wirePath.includes("%253A"), "a pre-encoded id goes out double-encoded");

    // What it sends now: the id as one RAW path segment, encoded exactly once by osFetch().
    const good = await osFetch(cfg, { method: "POST", path: ["_snapshot", REPO, COLON_ID, "_restore"], body });
    assert.equal(good.status, 200);
    assert.equal(world.calls.at(-1).wirePath, `/_snapshot/${REPO}/${COLON_ID_WIRE}/_restore`);
    assert.ok(!world.calls.at(-1).wirePath.includes("%25"), "a RAW segment must be encoded once, never twice");
  } finally {
    globalThis.fetch = real;
  }
});

test("os-snapshot.mjs never pre-encodes a path segment (osFetch encodes each segment exactly once)", () => {
  const src = readFileSync(new URL("../skills/fleet-backup/os-snapshot.mjs", import.meta.url), "utf8");
  const code = src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  assert.doesNotMatch(
    code,
    /encodeURIComponent\s*\(\s*[A-Za-z_$]/,
    "os-snapshot.mjs must pass RAW path segments (an array) to osJsonCall(); a pre-encoded ':' becomes %253A on the wire and OpenSearch reports 'snapshot does not exist'",
  );
});

// ---------- the drill, end to end against the fake cluster ----------

test("restore-drill restores the NEWEST snapshot whose id contains ':' and PASSES (the 2026-09-06 and 2026-10-04 failure)", async () => {
  const world = makeCluster({
    live: { "memory-exec": 120, "tiny-room": 5, "big-room": 900 },
    snapshots: [
      { id: OLDER_COLON_ID, endEpoch: 1789900000, indices: ["memory-exec", "tiny-room", "big-room"] },
      { id: COLON_ID, endEpoch: 1790000000, indices: ["memory-exec", "tiny-room", "big-room"] },
    ],
  });
  const { error, logs } = await runDrill(world);
  assert.equal(error, null, error && error.message);
  const restores = restoreCalls(world);
  assert.equal(restores.length, 1);
  assert.equal(restores[0].wirePath, `/_snapshot/${REPO}/${COLON_ID_WIRE}/_restore`);
  assert.ok(!restores[0].wirePath.includes("%25"), "snapshot id must be encoded exactly once");
  assert.deepEqual(JSON.parse(restores[0].body), { indices: "tiny-room", rename_pattern: "(.+)", rename_replacement: "drill-$1", include_global_state: false });
  assert.ok(logs.some((l) => /restore-drill PASSED/.test(l)), logs.join("\n"));
  assert.deepEqual(leftoverDrillIndices(world), [], "the drill index must be deleted afterwards");
  assert.ok(world.calls.some((c) => c.method === "DELETE" && c.wirePath === "/drill-tiny-room"));
});

test("restore-drill skips an EMPTY index (the 2026-08-30 failure: live index cs-knowledge reports 0 docs)", async () => {
  // A snapshot id with no special characters, so only the index selection is under test here.
  const world = makeCluster({
    live: { "cs-knowledge": 0, "tiny-room": 5, "big-room": 900 },
    snapshots: [{ id: "manual-snapshot-1", endEpoch: 1790000000, indices: ["cs-knowledge", "tiny-room", "big-room"] }],
  });
  const { error, logs } = await runDrill(world);
  assert.equal(error, null, error && error.message);
  assert.equal(JSON.parse(restoreCalls(world)[0].body).indices, "tiny-room");
  assert.ok(logs.some((l) => /restore-drill PASSED/.test(l)));
  assert.deepEqual(leftoverDrillIndices(world), []);
});

test("restore-drill with only empty non-privileged indices fails clearly, before any restore", async () => {
  const world = makeCluster({
    live: { "cs-knowledge": 0, "legal-personal": 3 },
    snapshots: [{ id: COLON_ID, endEpoch: 1790000000, indices: ["cs-knowledge"] }],
  });
  const { error } = await runDrill(world);
  assert.ok(error, "must fail");
  assert.match(error.message, /no non-empty non-privileged index/);
  assert.equal(restoreCalls(world).length, 0);
});

test("restore-drill --index restores exactly the named index under the drill- prefix", async () => {
  const world = makeCluster({
    live: { "tiny-room": 5, "big-room": 900 },
    snapshots: [{ id: COLON_ID, endEpoch: 1790000000, indices: ["tiny-room", "big-room"] }],
  });
  const { error } = await runDrill(world, ["--repo", REPO, "--index", "big-room"]);
  assert.equal(error, null, error && error.message);
  const body = JSON.parse(restoreCalls(world)[0].body);
  assert.equal(body.indices, "big-room");
  assert.equal(body.rename_replacement, "drill-$1");
  assert.deepEqual(leftoverDrillIndices(world), []);
});

test("restore-drill --dry-run resolves the snapshot BY ID and the index, and changes nothing", async () => {
  const world = makeCluster({
    live: { "tiny-room": 5, "big-room": 900 },
    snapshots: [{ id: COLON_ID, endEpoch: 1790000000, indices: ["tiny-room", "big-room"] }],
  });
  const { error, logs } = await runDrill(world, ["--repo", REPO, "--dry-run"]);
  assert.equal(error, null, error && error.message);
  assert.deepEqual(world.calls.filter((c) => c.method !== "GET"), [], "a dry run must issue only GETs");
  assert.ok(
    world.calls.some((c) => c.method === "GET" && c.wirePath === `/_snapshot/${REPO}/${COLON_ID_WIRE}`),
    "the dry run must address the snapshot by id exactly the way the restore does",
  );
  assert.ok(logs.some((l) => /DRY RUN/.test(l) && l.includes(COLON_ID) && /tiny-room/.test(l)), logs.join("\n"));
  assert.deepEqual([...world.indices.keys()].sort(), ["big-room", "tiny-room"]);
});

test("restore-drill reports an id that _cat/snapshots lists but cannot be resolved BEFORE attempting a restore", async () => {
  const world = makeCluster({
    live: { "tiny-room": 5 },
    snapshots: [],
    catRows: [{ id: "ghost-snapshot", status: "SUCCESS", end_epoch: "1790000000" }],
  });
  const { error } = await runDrill(world);
  assert.ok(error, "must fail");
  assert.match(error.message, /"ghost-snapshot" \(as listed by _cat\/snapshots\) does not resolve by id/);
  assert.match(error.message, /HTTP 404/);
  assert.equal(restoreCalls(world).length, 0);
});

test("restore-drill reports an index that is not in the newest snapshot, without attempting a restore", async () => {
  const world = makeCluster({
    live: { "tiny-room": 5, "big-room": 900 },
    snapshots: [{ id: COLON_ID, endEpoch: 1790000000, indices: ["big-room"] }],
  });
  const { error } = await runDrill(world);
  assert.ok(error, "must fail");
  assert.match(error.message, /index "tiny-room" is not in snapshot/);
  assert.equal(restoreCalls(world).length, 0);
});

test("restore-drill still fails below the 95% tolerance, and the drill index is deleted BEFORE the assertion", async () => {
  const world = makeCluster({
    live: { "tiny-room": 100 },
    restoredDocs: { "tiny-room": 50 },
    snapshots: [{ id: COLON_ID, endEpoch: 1790000000, indices: ["tiny-room"] }],
  });
  const { error } = await runDrill(world);
  assert.ok(error, "must fail");
  assert.match(error.message, /restored 50 docs vs live 100/);
  assert.deepEqual(leftoverDrillIndices(world), []);
});

test("restore-drill passes when the snapshot copy is within tolerance of the live index", async () => {
  const world = makeCluster({
    live: { "tiny-room": 100 },
    restoredDocs: { "tiny-room": 96 }, // the snapshot is up to 24h older than the live index
    snapshots: [{ id: COLON_ID, endEpoch: 1790000000, indices: ["tiny-room"] }],
  });
  const { error, logs } = await runDrill(world);
  assert.equal(error, null, error && error.message);
  assert.ok(logs.some((l) => /drill-tiny-room=96 docs, live tiny-room=100 docs/.test(l)), logs.join("\n"));
});

// ---------- pickDrillIndex (pure) ----------

const row = (index, docs) => ({ index, docs, lane: snap.classifyIndexLane(index) });

test("pickDrillIndex: the smallest NON-EMPTY non-privileged index, compared numerically", () => {
  assert.equal(snap.pickDrillIndex([row("cs-knowledge", "0"), row("tiny-room", "5"), row("big-room", "900")]), "tiny-room");
  assert.equal(snap.pickDrillIndex([row("a-room", "10"), row("b-room", "9")]), "b-room", "9 < 10 numerically, not as strings");
});

test("pickDrillIndex: never picks a privileged, system, leftover-drill, closed or empty index", () => {
  assert.equal(
    snap.pickDrillIndex([
      row("legal-personal", "1"), row("legal-company", "2"), row("finance-cfo-source-docs", "3"),
      row(".opendistro-ism-config", "1"), row("drill-tiny-room", "4"),
      row("closed-room", null), row("closed-room-2", undefined), row("cs-knowledge", "0"),
      row("big-room", "900"),
    ]),
    "big-room",
  );
});

test("pickDrillIndex: ties break by name, and nothing eligible gives null", () => {
  assert.equal(snap.pickDrillIndex([row("b-room", "7"), row("a-room", "7")]), "a-room");
  assert.equal(snap.pickDrillIndex([row("cs-knowledge", "0")]), null);
  assert.equal(snap.pickDrillIndex([]), null);
  assert.equal(snap.pickDrillIndex(undefined), null);
});
