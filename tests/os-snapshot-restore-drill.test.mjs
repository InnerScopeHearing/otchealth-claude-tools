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
// HARDENING from the independent review of the first fix (each item has its own tests below):
//   cleanup      a stale drill-<index> is deleted before the restore; the copy is deleted again on every path; a
//                delete that fails (403, transport) fails the drill and can never print PASSED
//   pick         only indices IN the newest snapshot; never a dot-prefixed system or hidden index (.tasks, ...); the
//                smallest index with 50+ docs, else the largest eligible one
//   flags        restore-drill accepts exactly --repo, --index and --dry-run; anything else stops before any call
//   aliases      the restore request carries include_aliases:false
//   --index      an explicit --index passes the same lane, dot-prefix and name-shape guard as the automatic pick
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
 *  restoredDocs: { indexName: docs in the snapshot copy }, defaulting to the live count
 *  health:    the status _cluster/health reports for any index; anything but "green" means the copy never recovers
 *  deleteFault: (indexName, nthDelete) => null | status. A status makes that DELETE fail the way FGAC would (403) and
 *             leaves the index in place; 404 means "already gone" (the index is removed, then 404 is returned)
 *  restoreFault: { status, reason } makes the restore POST itself fail */
function makeCluster({ live = {}, snapshots = [], catRows = null, restoredDocs = {}, health = "green", deleteFault = null, restoreFault = null } = {}) {
  const indices = new Map(Object.entries(live));
  const calls = [];
  let deletes = 0;
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
      if (restoreFault) return failure(restoreFault.status, "snapshot_restore_exception", restoreFault.reason);
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
      if (health !== "green") return reply(200, { status: health });
      return indices.has(seg[2]) ? reply(200, { status: "green" }) : reply(408, { status: "red", timed_out: true });
    }
    if (method === "POST" && seg.length === 2 && seg[1] === "_count") {
      return indices.has(seg[0]) ? reply(200, { count: indices.get(seg[0]) }) : failure(404, "index_not_found_exception", `no such index [${seg[0]}]`);
    }
    if (method === "DELETE" && seg.length === 1) {
      deletes += 1;
      const fault = deleteFault ? deleteFault(seg[0], deletes) : null;
      if (fault === 404) { indices.delete(seg[0]); return failure(404, "index_not_found_exception", `no such index [${seg[0]}]`); }
      if (fault) return failure(fault, "security_exception", "no permissions for [indices:admin/delete] and User [name=unit-test-role]");
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
const deleteCalls = (world) => world.calls.filter((c) => c.method === "DELETE");
/** The state-changing requests in the order they were sent, e.g. ["DELETE /drill-x", "POST /_snapshot/.../_restore", ...]. */
const writeSequence = (world) => world.calls.filter((c) => c.method !== "GET" && !/_count$/.test(c.wirePath)).map((c) => `${c.method} ${c.wirePath}`);
const passed = (logs) => logs.some((l) => /restore-drill PASSED/.test(l));

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
    live: { "memory-exec": 120, "tiny-room": 60, "big-room": 900 },
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
  // include_aliases:false: the copy must never join the live index's aliases.
  assert.deepEqual(JSON.parse(restores[0].body), {
    indices: "tiny-room", rename_pattern: "(.+)", rename_replacement: "drill-$1", include_global_state: false, include_aliases: false,
  });
  assert.ok(passed(logs), logs.join("\n"));
  assert.deepEqual(leftoverDrillIndices(world), [], "the drill index must be deleted afterwards");
  assert.ok(world.calls.some((c) => c.method === "DELETE" && c.wirePath === "/drill-tiny-room"));
  assert.ok(deleteCalls(world).every((c) => /^\/drill-[a-z0-9._-]+$/.test(c.wirePath)), "only drill- copies are ever deleted, never a live index");
});

test("restore-drill skips an EMPTY index (the 2026-08-30 failure: live index cs-knowledge reports 0 docs)", async () => {
  // A snapshot id with no special characters, so only the index selection is under test here.
  const world = makeCluster({
    live: { "cs-knowledge": 0, "tiny-room": 60, "big-room": 900 },
    snapshots: [{ id: "manual-snapshot-1", endEpoch: 1790000000, indices: ["cs-knowledge", "tiny-room", "big-room"] }],
  });
  const { error, logs } = await runDrill(world);
  assert.equal(error, null, error && error.message);
  assert.equal(JSON.parse(restoreCalls(world)[0].body).indices, "tiny-room");
  assert.ok(passed(logs));
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
    live: { "tiny-room": 60, "big-room": 900 },
    snapshots: [{ id: COLON_ID, endEpoch: 1790000000, indices: ["tiny-room", "big-room"] }],
  });
  const { error } = await runDrill(world, ["--repo", REPO, "--index", "big-room"]);
  assert.equal(error, null, error && error.message);
  const body = JSON.parse(restoreCalls(world)[0].body);
  assert.equal(body.indices, "big-room");
  assert.equal(body.rename_replacement, "drill-$1");
  assert.equal(body.include_aliases, false);
  assert.deepEqual(leftoverDrillIndices(world), []);
});

test("restore-drill --dry-run resolves the snapshot BY ID and the index, and changes nothing", async () => {
  const world = makeCluster({
    live: { "tiny-room": 60, "big-room": 900 },
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

test("restore-drill --index reports an index that is not in the newest snapshot, without attempting a restore", async () => {
  const world = makeCluster({
    live: { "tiny-room": 60, "big-room": 900 },
    snapshots: [{ id: COLON_ID, endEpoch: 1790000000, indices: ["big-room"] }],
  });
  const { error } = await runDrill(world, ["--repo", REPO, "--index", "tiny-room"]);
  assert.ok(error, "must fail");
  assert.match(error.message, /index "tiny-room" is not in snapshot/);
  assert.equal(restoreCalls(world).length, 0);
  assert.equal(deleteCalls(world).length, 0, "nothing is cleared or created before the membership check passes");
});

// ---------- pick: only indices IN the snapshot, never a dot-prefixed index, the 50-doc floor ----------

test("restore-drill auto-pick skips an index that is NEWER than the snapshot and drills one the snapshot holds", async () => {
  // new-room (60 docs) is the smallest eligible index live, but it was created after the snapshot was taken.
  const world = makeCluster({
    live: { "new-room": 60, "memory-exec": 120, "big-room": 900 },
    snapshots: [{ id: COLON_ID, endEpoch: 1790000000, indices: ["memory-exec", "big-room"] }],
  });
  const { error, logs } = await runDrill(world);
  assert.equal(error, null, error && error.message);
  assert.equal(JSON.parse(restoreCalls(world)[0].body).indices, "memory-exec");
  assert.ok(passed(logs), logs.join("\n"));
  assert.deepEqual(leftoverDrillIndices(world), []);
});

test("restore-drill fails clearly, before any restore, when no eligible index is in the snapshot", async () => {
  const world = makeCluster({
    live: { "new-room": 60 },
    snapshots: [{ id: COLON_ID, endEpoch: 1790000000, indices: ["some-other-room"] }],
  });
  const { error } = await runDrill(world);
  assert.ok(error, "must fail");
  assert.match(error.message, /no non-empty non-privileged index that is also in snapshot/);
  assert.equal(restoreCalls(world).length, 0);
  assert.equal(deleteCalls(world).length, 0);
});

test("restore-drill never drills a dot-prefixed system or hidden index, even when it is the smallest eligible one", async () => {
  // Each dot index is above the 50-doc floor and smaller than tiny-room, so only the dot-prefix rule keeps them out.
  const dot = { ".tasks": 55, ".ism-config": 56, ".ql-datasources": 57, ".ml-config": 58 };
  const world = makeCluster({
    live: { ...dot, "tiny-room": 60, "big-room": 900 },
    snapshots: [{ id: COLON_ID, endEpoch: 1790000000, indices: [...Object.keys(dot), "tiny-room", "big-room"] }],
  });
  const { error, logs } = await runDrill(world);
  assert.equal(error, null, error && error.message);
  assert.equal(JSON.parse(restoreCalls(world)[0].body).indices, "tiny-room");
  assert.ok(passed(logs), logs.join("\n"));
  assert.ok(!world.calls.some((c) => c.method !== "GET" && /\/drill-\./.test(c.wirePath)), "no drill-.* name may ever be touched");
  assert.deepEqual([...world.indices.keys()].filter((n) => n.startsWith(".")).sort(), Object.keys(dot).sort(), "hidden indices are left alone");
});

test("restore-drill with only dot-prefixed indices fails clearly instead of drilling a system index", async () => {
  const world = makeCluster({
    live: { ".tasks": 80, ".ism-config": 90 },
    snapshots: [{ id: COLON_ID, endEpoch: 1790000000, indices: [".tasks", ".ism-config"] }],
  });
  const { error } = await runDrill(world);
  assert.ok(error, "must fail");
  assert.match(error.message, /no non-empty non-privileged index/);
  assert.equal(restoreCalls(world).length, 0);
});

test("restore-drill drills the smallest index with 50+ docs, not a smaller one that makes the 95% rule fragile", async () => {
  const world = makeCluster({
    live: { "tiny-room": 5, "mid-room": 60, "big-room": 900 },
    snapshots: [{ id: COLON_ID, endEpoch: 1790000000, indices: ["tiny-room", "mid-room", "big-room"] }],
  });
  const { error, logs } = await runDrill(world);
  assert.equal(error, null, error && error.message);
  assert.equal(JSON.parse(restoreCalls(world)[0].body).indices, "mid-room");
  assert.ok(passed(logs), logs.join("\n"));
  assert.ok(!logs.some((l) => /NOTE: no eligible index/.test(l)), "no fallback note when the floor is met");
});

test("restore-drill with no index at the 50-doc floor drills the LARGEST eligible one and says so", async () => {
  const world = makeCluster({
    live: { "tiny-room": 5, "small-room": 30, "cs-knowledge": 0 },
    snapshots: [{ id: COLON_ID, endEpoch: 1790000000, indices: ["tiny-room", "small-room", "cs-knowledge"] }],
  });
  const { error, logs } = await runDrill(world);
  assert.equal(error, null, error && error.message);
  assert.equal(JSON.parse(restoreCalls(world)[0].body).indices, "small-room");
  assert.ok(logs.some((l) => /NOTE: no eligible index has 50\+ docs/.test(l)), logs.join("\n"));
  assert.ok(passed(logs));
});

test("restore-drill --dry-run applies the same pick (snapshot membership, no dot index) and stays read-only", async () => {
  const world = makeCluster({
    live: { ".tasks": 55, "new-room": 58, "tiny-room": 60, "big-room": 900 },
    snapshots: [{ id: COLON_ID, endEpoch: 1790000000, indices: [".tasks", "tiny-room", "big-room"] }],
  });
  const { error, logs } = await runDrill(world, ["--repo", REPO, "--dry-run"]);
  assert.equal(error, null, error && error.message);
  assert.deepEqual(world.calls.filter((c) => c.method !== "GET"), []);
  assert.ok(logs.some((l) => /DRY RUN/.test(l) && /contains "tiny-room"/.test(l) && /as "drill-tiny-room"/.test(l)), logs.join("\n"));
});

// ---------- cleanup: a stale copy, a failed delete, an unhealthy copy ----------

test("a STALE drill-<index> left by an earlier run is deleted BEFORE the restore, and the drill then passes (the stuck-index case)", async () => {
  // Without the pre-clean the restore onto an open index of the same name fails for every later run:
  // "cannot restore index [drill-tiny-room] because an open index with same name already exists in the cluster".
  const world = makeCluster({
    live: { "tiny-room": 60, "big-room": 900, "drill-tiny-room": 7 },
    snapshots: [{ id: COLON_ID, endEpoch: 1790000000, indices: ["tiny-room", "big-room"] }],
  });
  const { error, logs } = await runDrill(world);
  assert.equal(error, null, error && error.message);
  assert.deepEqual(writeSequence(world), [
    "DELETE /drill-tiny-room",
    `POST /_snapshot/${REPO}/${COLON_ID_WIRE}/_restore`,
    "DELETE /drill-tiny-room",
  ]);
  assert.ok(logs.some((l) => /removed a stale "drill-tiny-room"/.test(l)), logs.join("\n"));
  assert.ok(passed(logs));
  assert.deepEqual(leftoverDrillIndices(world), []);
  assert.deepEqual([...world.indices.keys()].sort(), ["big-room", "tiny-room"], "the live indices are untouched");
});

test("without a stale copy the pre-clean DELETE is a harmless 404, and the drill still deletes the copy it made", async () => {
  const world = makeCluster({
    live: { "tiny-room": 60 },
    snapshots: [{ id: COLON_ID, endEpoch: 1790000000, indices: ["tiny-room"] }],
  });
  const { error, logs } = await runDrill(world);
  assert.equal(error, null, error && error.message);
  assert.equal(deleteCalls(world).length, 2, "one DELETE before the restore (404), one after");
  assert.ok(!logs.some((l) => /stale/.test(l)));
  assert.ok(passed(logs));
});

test("a stale copy that cannot be deleted (403) stops the drill BEFORE it restores anything, and never prints PASSED", async () => {
  const world = makeCluster({
    live: { "tiny-room": 60, "drill-tiny-room": 7 },
    snapshots: [{ id: COLON_ID, endEpoch: 1790000000, indices: ["tiny-room"] }],
    deleteFault: () => 403,
  });
  const { error, logs } = await runDrill(world);
  assert.ok(error, "must fail");
  assert.match(error.message, /could not clear "drill-tiny-room" before restoring/);
  assert.match(error.message, /HTTP 403/);
  assert.equal(restoreCalls(world).length, 0, "nothing may be restored when the identity cannot clean up after itself");
  assert.ok(!passed(logs));
});

test("a cleanup DELETE that fails (403) after a good restore FAILS the drill loudly and never prints PASSED", async () => {
  const world = makeCluster({
    live: { "tiny-room": 60 },
    snapshots: [{ id: COLON_ID, endEpoch: 1790000000, indices: ["tiny-room"] }],
    // DELETE #1 is the pre-clean (a plain 404: nothing stale). DELETE #2 is the cleanup, which is denied.
    deleteFault: (name, nth) => (nth >= 2 ? 403 : null),
  });
  const { error, logs } = await runDrill(world);
  assert.ok(error, "a drill that leaves its copy behind must fail");
  assert.match(error.message, /left "drill-tiny-room" behind/);
  assert.match(error.message, /HTTP 403/);
  assert.ok(!passed(logs), logs.join("\n"));
  assert.deepEqual(leftoverDrillIndices(world), ["drill-tiny-room"], "the copy really is still there");
});

test("a cleanup DELETE that returns 404 (the copy is already gone) is not a failure", async () => {
  const world = makeCluster({
    live: { "tiny-room": 60 },
    snapshots: [{ id: COLON_ID, endEpoch: 1790000000, indices: ["tiny-room"] }],
    deleteFault: (name, nth) => (nth === 2 ? 404 : null),
  });
  const { error, logs } = await runDrill(world);
  assert.equal(error, null, error && error.message);
  assert.ok(passed(logs), logs.join("\n"));
  assert.deepEqual(leftoverDrillIndices(world), []);
});

test("a copy that never becomes healthy is still deleted, and the drill fails with the health error", async () => {
  const world = makeCluster({
    live: { "tiny-room": 60 },
    snapshots: [{ id: COLON_ID, endEpoch: 1790000000, indices: ["tiny-room"] }],
    health: "red",
  });
  const { error, logs } = await runDrill(world);
  assert.ok(error, "must fail");
  assert.match(error.message, /did not reach a healthy status/);
  assert.ok(!passed(logs));
  assert.equal(deleteCalls(world).length, 2, "pre-clean plus the cleanup that the failure path must still run");
  assert.deepEqual(leftoverDrillIndices(world), [], "the failure path must not leave the copy behind");
});

test("a restore call that fails is reported as itself, and the cleanup still runs", async () => {
  const world = makeCluster({
    live: { "tiny-room": 60 },
    snapshots: [{ id: COLON_ID, endEpoch: 1790000000, indices: ["tiny-room"] }],
    restoreFault: { status: 500, reason: "node left the cluster" },
  });
  const { error, logs } = await runDrill(world);
  assert.ok(error, "must fail");
  assert.match(error.message, /^restore call failed: HTTP 500/);
  assert.ok(!passed(logs));
  assert.equal(deleteCalls(world).length, 2);
  assert.deepEqual(leftoverDrillIndices(world), []);
});

test("when the drill fails AND the cleanup fails, the error reports both (and still never says PASSED)", async () => {
  const world = makeCluster({
    live: { "tiny-room": 60 },
    snapshots: [{ id: COLON_ID, endEpoch: 1790000000, indices: ["tiny-room"] }],
    health: "red",
    deleteFault: (name, nth) => (nth >= 2 ? 403 : null),
  });
  const { error, logs } = await runDrill(world);
  assert.ok(error, "must fail");
  assert.match(error.message, /left "drill-tiny-room" behind/);
  assert.match(error.message, /HTTP 403/);
  assert.match(error.message, /also failed: drill index "drill-tiny-room" did not reach a healthy status/);
  assert.ok(!passed(logs));
});

test("a failed 95% assertion plus a failed cleanup reports the leftover copy rather than hiding it", async () => {
  const world = makeCluster({
    live: { "tiny-room": 100 },
    restoredDocs: { "tiny-room": 50 },
    snapshots: [{ id: COLON_ID, endEpoch: 1790000000, indices: ["tiny-room"] }],
    deleteFault: (name, nth) => (nth >= 2 ? 403 : null),
  });
  const { error, logs } = await runDrill(world);
  assert.ok(error, "must fail");
  assert.match(error.message, /left "drill-tiny-room" behind/);
  assert.ok(!passed(logs));
});

// ---------- flags: exactly --repo, --index and --dry-run, validated before any call ----------

const BAD_ARGV = [
  ["--dryrun"], ["--dry_run"], ["--dry-run=true"], ["--dry-run=1"], ["--DRY-RUN"], ["-n"], ["-dry-run"], ["--dry-run", "true"],
  ["dry-run"], ["--force"], ["--dry-run", "--force"], ["--repo=otchealth-brain-s3"], ["--index=tiny-room"],
  ["--repo"], ["--index"], ["--index", "--dry-run"], ["--repo", "-x"],
  ["--dry-run", "--dry-run"], ["--index", "tiny-room", "--index", "big-room"], [""], ["--dry-run", ""],
];

test("parseRestoreDrillArgs accepts exactly --repo <value>, --index <value> and --dry-run", () => {
  const none = snap.parseRestoreDrillArgs([]);
  assert.equal(none.index, null);
  assert.equal(none.dryRun, false);
  assert.deepEqual(snap.parseRestoreDrillArgs(["--dry-run"]).dryRun, true);
  assert.deepEqual(
    snap.parseRestoreDrillArgs(["--repo", "r1", "--index", "tiny-room", "--dry-run"]),
    { repo: "r1", index: "tiny-room", dryRun: true },
  );
  assert.deepEqual(
    snap.parseRestoreDrillArgs(["--dry-run", "--index", "tiny-room", "--repo", "r1"]),
    { repo: "r1", index: "tiny-room", dryRun: true },
    "flag order does not matter",
  );
});

test("parseRestoreDrillArgs rejects every spelling that is not exactly an accepted flag", () => {
  for (const argv of BAD_ARGV) {
    assert.throws(() => snap.parseRestoreDrillArgs(argv), /^Error: restore-drill: .*nothing was run/, JSON.stringify(argv));
  }
});

for (const argv of [["--dryrun"], ["--dry_run"], ["--dry-run=true"], ["-n"], ["--repo", REPO, "--dry-run", "--force"], ["dry-run"]]) {
  test(`restore-drill ${JSON.stringify(argv)} stops BEFORE any network call and writes nothing (it must not fall through to a real restore)`, async () => {
    // A healthy cluster with a restorable index: an argv that falls through to the real drill would restore and PASS.
    const world = makeCluster({
      live: { "tiny-room": 60 },
      snapshots: [{ id: COLON_ID, endEpoch: 1790000000, indices: ["tiny-room"] }],
    });
    const { error, logs } = await runDrill(world, argv);
    assert.ok(error, "must fail");
    assert.match(error.message, /restore-drill: /);
    assert.deepEqual(world.calls, [], "not one request, read or write, before the arguments are vetted");
    assert.ok(!passed(logs));
    assert.deepEqual([...world.indices.keys()], ["tiny-room"]);
  });
}

// ---------- an explicit --index passes the same guard as the automatic pick ----------

for (const bad of [".tasks", ".ism-config", "legal-personal", "legal-company", "finance-cfo-source-docs", "phi-notes", "drill-tiny-room", "*", "tiny-room,big-room", "Tiny-Room"]) {
  test(`restore-drill --index ${JSON.stringify(bad)} is refused BEFORE any network call`, async () => {
    // Where the name could really be an index, put it in the cluster AND in the snapshot, so that an unguarded drill
    // would go ahead and restore it.
    const couldExist = /^[a-z0-9.][a-z0-9._-]*$/.test(bad);
    const world = makeCluster({
      live: { "tiny-room": 60, ...(couldExist ? { [bad]: 60 } : {}) },
      snapshots: [{ id: COLON_ID, endEpoch: 1790000000, indices: ["tiny-room", ...(couldExist ? [bad] : [])] }],
    });
    const { error, logs } = await runDrill(world, ["--repo", REPO, "--index", bad]);
    assert.ok(error, "must fail");
    assert.match(error.message, /--index refused: .*nothing was run/);
    assert.deepEqual(world.calls, [], "the guard is a pure name check, so no request may precede it");
    assert.ok(!passed(logs));
  });
}

// ---------- the 95% tolerance ----------

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

// ---------- pickDrillIndex and drillSourceRefusal (pure) ----------

const row = (index, docs) => ({ index, docs, lane: snap.classifyIndexLane(index) });

test("pickDrillIndex: the smallest NON-EMPTY index at the 50-doc floor, compared numerically", () => {
  assert.equal(snap.pickDrillIndex([row("cs-knowledge", "0"), row("tiny-room", "60"), row("big-room", "900")]), "tiny-room");
  assert.equal(snap.pickDrillIndex([row("a-room", "100"), row("b-room", "90")]), "b-room", "90 < 100 numerically, not as strings");
  assert.equal(snap.pickDrillIndex([row("a-room", "100"), row("b-room", "9000")]), "a-room");
});

test("pickDrillIndex: never picks a privileged, system, dot-prefixed, leftover-drill, closed or empty index", () => {
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

test("pickDrillIndex: skips EVERY dot-prefixed index (.tasks, .ism-config, .ql-datasources, .ml-config), even above the floor", () => {
  const dots = [row(".tasks", "55"), row(".ism-config", "56"), row(".ql-datasources", "57"), row(".ml-config", "58"), row(".kibana_1", "59")];
  // classifyIndexLane() only calls the .opendistro/.opensearch/.kibana/.plugins prefixes "system", so the others reach the pick as
  // "non-privileged"; this is exactly the hazard the dot-prefix rule closes.
  assert.equal(snap.classifyIndexLane(".tasks"), "non-privileged");
  assert.equal(snap.pickDrillIndex([...dots, row("tiny-room", "60")]), "tiny-room");
  assert.equal(snap.pickDrillIndex(dots), null, "only hidden indices means nothing to drill");
});

test("pickDrillIndex: with a snapshot index list it only picks an index the snapshot holds", () => {
  const rows = [row("new-room", "60"), row("memory-exec", "120"), row("big-room", "900")];
  assert.equal(snap.pickDrillIndex(rows), "new-room", "no list given: unchanged behavior");
  assert.equal(snap.pickDrillIndex(rows, ["memory-exec", "big-room"]), "memory-exec", "new-room is newer than the snapshot");
  assert.equal(snap.pickDrillIndex(rows, ["big-room"]), "big-room");
  assert.equal(snap.pickDrillIndex(rows, ["something-else"]), null, "nothing eligible is in the snapshot");
  assert.equal(snap.pickDrillIndex(rows, []), null);
  assert.equal(snap.pickDrillIndex(rows, null), "new-room", "an unknown snapshot content (not an array) does not filter");
});

test("pickDrillIndex: the 50-doc floor is inclusive, and a smaller index never beats one that meets it", () => {
  assert.equal(snap.MIN_DRILL_DOCS, 50);
  assert.equal(snap.pickDrillIndex([row("a-room", "5"), row("b-room", "60"), row("c-room", "900")]), "b-room");
  assert.equal(snap.pickDrillIndex([row("a-room", "49"), row("b-room", "50")]), "b-room", "49 is below the floor, 50 meets it");
  assert.equal(snap.pickDrillIndex([row("a-room", "50"), row("b-room", "51")]), "a-room", "50 meets the floor and is the smaller");
});

test("pickDrillIndex: below the floor it falls back to the LARGEST eligible index, ties by name", () => {
  assert.equal(snap.pickDrillIndex([row("a-room", "5"), row("b-room", "30"), row("c-room", "49")]), "c-room");
  assert.equal(snap.pickDrillIndex([row("b-room", "7"), row("a-room", "7")]), "a-room");
  assert.equal(snap.pickDrillIndex([row("a-room", "10"), row("b-room", "9")]), "a-room", "10 > 9 numerically, not as strings");
});

test("pickDrillIndex: ties at the floor break by name, and nothing eligible gives null", () => {
  assert.equal(snap.pickDrillIndex([row("b-room", "70"), row("a-room", "70")]), "a-room");
  assert.equal(snap.pickDrillIndex([row("cs-knowledge", "0")]), null);
  assert.equal(snap.pickDrillIndex([]), null);
  assert.equal(snap.pickDrillIndex(undefined), null);
});

test("pickDrillIndex: an index whose name carries a privileged-ring term is never picked, whatever lane it reports", () => {
  // classifyIndexLane() does not look at the never-mirror terms (phi, medreview), the nightly snapshot pattern does.
  assert.equal(snap.classifyIndexLane("phi-notes"), "non-privileged");
  assert.equal(snap.pickDrillIndex([row("phi-notes", "60"), row("medreview-queue", "70"), row("tiny-room", "80")]), "tiny-room");
});

test("drillSourceRefusal: ordinary room indices pass", () => {
  for (const ok of ["memory-exec", "commons-company-journal", "commerce-commerce-source-docs", "cs-knowledge", "tiny-room", "a.b_c-1", "room2"]) {
    assert.equal(snap.drillSourceRefusal(ok), null, ok);
  }
});

test("drillSourceRefusal: refuses dot-prefixed, drill-, privileged, never-mirror and non-concrete names with a reason", () => {
  const refused = {
    ".tasks": /dot-prefixed/, ".ism-config": /dot-prefixed/, ".ql-datasources": /dot-prefixed/, ".ml-config": /dot-prefixed/,
    ".opendistro-ism-config": /dot-prefixed/, ".kibana_1": /dot-prefixed/,
    "drill-tiny-room": /drill copy/,
    "legal-personal": /personal-legal lane/, "legal-company": /finance-company-legal lane/, "finance-cfo-source-docs": /finance-company-legal lane/,
    "phi-notes": /privileged-ring term/, "medreview-queue": /privileged-ring term/,
    "*": /not a single concrete index name/, "tiny-room,big-room": /not a single concrete index name/, "tiny*": /not a single concrete index name/,
    "Tiny-Room": /not a single concrete index name/, "tiny room": /not a single concrete index name/, "_hidden": /not a single concrete index name/,
    "": /not a single concrete index name/,
  };
  for (const [name, why] of Object.entries(refused)) assert.match(snap.drillSourceRefusal(name) || "", why, JSON.stringify(name));
  for (const notAString of [undefined, null, 5, {}]) assert.ok(snap.drillSourceRefusal(notAString), String(notAString));
});
