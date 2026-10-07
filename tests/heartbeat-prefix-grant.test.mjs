// Regression gate: the heartbeat store must work under a PREFIX-SCOPED s3:ListBucket grant.
//
// S3 answers a GET of a key that does not exist with 404 only when the caller holds a bucket-level
// s3:ListBucket that applies to that GET; otherwise it answers 403 AccessDenied, indistinguishable from a
// real denial. The grant planned for the roles that read and write otchealthcommons/company-journal/_HEARTBEAT/
// gives s3:ListBucket only under the condition s3:prefix StringLike ".../_HEARTBEAT/*", and a GET carries no
// s3:prefix, so a job that has not beaten yet reads 403. Before this fix that one 403 aborted the whole
// `check` sweep (every beat row of the silence monitor went UNREADABLE) and blocked the first-ever `beat` of a
// job (it reads before it merges), so no job could ever write its first beat.
//
// The e2e tests run the REAL setup/heartbeat.mjs, commons-store.mjs and s3-blob.mjs in a child process with a
// fake `fetch` (preloaded with --import) that models S3 under exactly that grant. No network, no AWS account.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as heartbeat from "../setup/heartbeat.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const HEARTBEAT = join(HERE, "..", "setup", "heartbeat.mjs");
const REGISTRY = JSON.parse(readFileSync(join(HERE, "..", "setup", "heartbeat-registry.json"), "utf8"));
const WATCHED = Object.keys(REGISTRY).filter((k) => !k.startsWith("_"));
const GRANT = "otchealthcommons/company-journal/_HEARTBEAT/";
const keyOf = (job) => `${GRANT}${job}.json`;

// ---- the fake S3 (serialised into the child process; it must stay self-contained) -------------------------------
function installFakeS3() {
  const cfg = JSON.parse(process.env.FAKE_S3_CONFIG || "{}");
  const GRANT_PREFIX = "otchealthcommons/company-journal/_HEARTBEAT/";
  const objects = new Map(Object.entries(cfg.objects || {}));
  const note = (o) => process.stderr.write("FAKE_S3 " + JSON.stringify(o) + "\n");
  const denied = () => new Response('<?xml version="1.0"?><Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>', { status: 403 });
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    const method = (init.method || "GET").toUpperCase();
    if (u.searchParams.get("list-type") === "2") {
      const prefix = u.searchParams.get("prefix") || "";
      note({ op: "LIST", prefix });
      // s3:ListBucket with the condition s3:prefix StringLike ".../_HEARTBEAT/*"
      if (cfg.denyList || !prefix.startsWith(GRANT_PREFIX)) return denied();
      const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
      const contents = keys.map((k) => `<Contents><Key>${k}</Key><LastModified>2026-10-07T00:00:00.000Z</LastModified><Size>${objects.get(k).length}</Size></Contents>`).join("");
      return new Response(`<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`, { status: 200 });
    }
    const key = decodeURIComponent(u.pathname.slice(1));
    if (method === "GET") {
      note({ op: "GET", key });
      if (!key.startsWith(GRANT_PREFIX) || (cfg.unreadable || []).includes(key)) return denied();
      if (objects.has(key)) return new Response(objects.get(key), { status: 200, headers: { etag: '"e"' } });
      // THE POINT OF THIS FIXTURE: with only a prefix-scoped ListBucket a missing key reads 403, not 404.
      return cfg.listBucketAppliesToGet ? new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 }) : denied();
    }
    if (method === "PUT") {
      const body = Buffer.from(init.body).toString("utf8");
      note({ op: "PUT", key, body });
      if (!key.startsWith(GRANT_PREFIX) || cfg.denyPut) return denied();
      objects.set(key, body);
      return new Response("", { status: 200, headers: { etag: '"e"' } });
    }
    return new Response("", { status: 405 });
  };
}

const scratch = mkdtempSync(join(tmpdir(), "heartbeat-fake-s3-"));
const STUB = join(scratch, "fake-s3.mjs");
writeFileSync(STUB, `(${installFakeS3.toString()})();\n`);
after(() => rmSync(scratch, { recursive: true, force: true }));

/** Run the real CLI with the fake S3. Returns {status, stdout, stderr (fake-S3 notes removed), calls}. */
function run(args, cfg = {}) {
  const r = spawnSync(process.execPath, ["--import", pathToFileURL(STUB).href, HEARTBEAT, ...args], {
    encoding: "utf8",
    timeout: 60_000,
    // A minimal env on purpose: no ECS container credentials, no OTC_AWS_* pair, nothing ambient reaches the child.
    env: { PATH: process.env.PATH, AWS_REGION: "us-east-1", AWS_ACCESS_KEY_ID: "test-access-key-id", AWS_SECRET_ACCESS_KEY: "test-secret-access-key", FAKE_S3_CONFIG: JSON.stringify(cfg) },
  });
  const lines = (r.stderr || "").split("\n");
  return {
    status: r.status,
    stdout: r.stdout || "",
    stderr: lines.filter((l) => !l.startsWith("FAKE_S3 ")).join("\n"),
    calls: lines.filter((l) => l.startsWith("FAKE_S3 ")).map((l) => JSON.parse(l.slice("FAKE_S3 ".length))),
  };
}
const calls = (r, op) => r.calls.filter((c) => c.op === op);

// ---- check ------------------------------------------------------------------------------------------------------
for (const listBucketAppliesToGet of [false, true]) {
  const world = listBucketAppliesToGet ? "ListBucket applies to a GET (missing key reads 404)" : "prefix-scoped ListBucket (missing key reads 403)";

  test(`check: a registry job with no beat object does not abort the sweep -- ${world}`, () => {
    const seeded = WATCHED[0];
    const lastOk = new Date(Date.now() - 5 * 60_000).toISOString();
    const r = run(["check", "--json"], { listBucketAppliesToGet, objects: { [keyOf(seeded)]: JSON.stringify({ job: seeded, last_event: "ok", last_ok: lastOk }) } });
    assert.equal(r.status, 0, r.stderr);
    const rows = JSON.parse(r.stdout);
    assert.deepEqual(new Set(rows.map((x) => x.job)), new Set(WATCHED), "every watched registry job gets a row, beat or no beat");
    const row = rows.find((x) => x.job === seeded);
    assert.equal(row.last_event, "ok");
    assert.ok(row.ageMin >= 4 && row.ageMin <= 6, `the seeded beat is about 5 minutes old, got ${row.ageMin}`);
    for (const x of rows.filter((y) => y.job !== seeded)) assert.equal(x.ageMin, null, `${x.job} has no beat object, so no last_ok`);
    assert.deepEqual(calls(r, "GET").map((c) => c.key), [keyOf(seeded)], "only the key the listing showed is ever read");
    assert.equal(calls(r, "LIST").length, 1);
  });
}

test("check: a LISTED beat that answers 403 is a real denial and still fails loud (a 403 is never read as 'missing')", () => {
  const seeded = WATCHED[0];
  const r = run(["check", "--json"], { objects: { [keyOf(seeded)]: "{}" }, unreadable: [keyOf(seeded)] });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /\[heartbeat\] ERROR: get s3 get 403/);
  assert.equal(r.stdout.trim(), "", "no partial report is printed");
});

test("check: a failed listing fails loud (never reads as 'no beats at all')", () => {
  const r = run(["check", "--json"], { denyList: true, objects: {} });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /\[heartbeat\] ERROR: s3 list 403/);
});

// ---- beat -------------------------------------------------------------------------------------------------------
test("beat: the first-ever beat of a job succeeds when a missing key reads 403 (no deadlock before the first write)", () => {
  const r = run(["beat", "nightly-aws-dr-canary", "ok"], { objects: {} });
  assert.equal(r.status, 0, r.stderr);
  const puts = calls(r, "PUT");
  assert.equal(puts.length, 1);
  assert.equal(puts[0].key, keyOf("nightly-aws-dr-canary"));
  const beat = JSON.parse(puts[0].body);
  assert.equal(beat.job, "nightly-aws-dr-canary");
  assert.equal(beat.last_event, "ok");
  assert.ok(Date.parse(beat.last_ok), "last_ok is stamped");
  assert.equal(beat.consecutive_fail, 0);
});

test("beat: an existing beat is read and merged (a `start` keeps the previous last_ok)", () => {
  const prior = { job: "nightly-eval", last_event: "ok", last_ok: "2026-10-06T05:00:00.000Z", consecutive_fail: 0 };
  const r = run(["beat", "nightly-eval", "start"], { objects: { [keyOf("nightly-eval")]: JSON.stringify(prior) } });
  assert.equal(r.status, 0, r.stderr);
  const beat = JSON.parse(calls(r, "PUT")[0].body);
  assert.equal(beat.last_ok, prior.last_ok, "the proof of life from the last good run survives a start beat");
  assert.equal(beat.last_event, "start");
  assert.ok(Date.parse(beat.last_start));
  assert.equal(calls(r, "LIST").length, 0, "the listing is only consulted after a 403");
});

test("beat: a missing key that reads 404 (ListBucket applies to the GET) still works and never lists", () => {
  const r = run(["beat", "nightly-eval", "ok"], { listBucketAppliesToGet: true, objects: {} });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(calls(r, "PUT").length, 1);
  assert.equal(calls(r, "LIST").length, 0);
});

test("beat: a LISTED beat that answers 403 is a real denial: loud, and the unreadable state is never overwritten", () => {
  const r = run(["beat", "nightly-eval", "ok"], { objects: { [keyOf("nightly-eval")]: "{}" }, unreadable: [keyOf("nightly-eval")] });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /\[heartbeat\] ERROR: get s3 get 403/);
  assert.equal(calls(r, "PUT").length, 0);
});

test("beat: a 403 whose listing also fails is still loud (the denial, not the listing error, is reported) and writes nothing", () => {
  const r = run(["beat", "nightly-eval", "ok"], { denyList: true, objects: {} });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /\[heartbeat\] ERROR: get s3 get 403/);
  assert.equal(calls(r, "PUT").length, 0);
});

test("beat: a denied PUT is loud (the beat step stays fatal on purpose)", () => {
  const r = run(["beat", "nightly-eval", "ok"], { denyPut: true, objects: {} });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /\[heartbeat\] ERROR: s3 put 403/);
});

// ---- readBeat (the pure decision, no child process) ---------------------------------------------------------------
const forbidden = () => new Error("s3 get 403 (refusing to report a missing object as empty): <Error><Code>AccessDenied</Code></Error>");

test("isForbiddenGet matches only the 403 GET shape s3-blob.mjs throws", () => {
  assert.equal(heartbeat.isForbiddenGet(forbidden()), true);
  assert.equal(heartbeat.isForbiddenGet(new Error("s3 get 500 (refusing to report a missing object as empty): oops")), false);
  assert.equal(heartbeat.isForbiddenGet(new Error("s3 put 403: denied")), false);
  assert.equal(heartbeat.isForbiddenGet(new Error("s3 list 403 (refusing to report a failed listing as empty): denied")), false);
  assert.equal(heartbeat.isForbiddenGet(null), false);
});

test("readBeat: 403 + absent from the listing is 'no beat yet'; 403 + listed, a failing listing, or any other error is loud", async () => {
  const listed = (names) => async () => names;
  assert.equal(await heartbeat.readBeat("a", { get: async () => { throw forbidden(); }, list: listed(["b.json"]) }), null);
  await assert.rejects(heartbeat.readBeat("a", { get: async () => { throw forbidden(); }, list: listed(["a.json"]) }), /^Error: get s3 get 403/);
  await assert.rejects(heartbeat.readBeat("a", { get: async () => { throw forbidden(); }, list: async () => { throw new Error("s3 list 500: boom"); } }), /^Error: get s3 get 403/);
  let listedCalls = 0;
  await assert.rejects(heartbeat.readBeat("a", { get: async () => { throw new Error("s3 get 500 (refusing to report a missing object as empty): boom"); }, list: async () => { listedCalls++; return []; } }), /^Error: get s3 get 500/);
  assert.equal(listedCalls, 0, "a non-403 failure never triggers a listing");
});

test("readBeat: 404 (null) and a corrupt body read as no beat; a good body is parsed", async () => {
  const never = async () => { throw new Error("must not list"); };
  assert.equal(await heartbeat.readBeat("a", { get: async () => null, list: never }), null);
  assert.equal(await heartbeat.readBeat("a", { get: async () => "{not json", list: never }), null);
  assert.deepEqual(await heartbeat.readBeat("a", { get: async (name) => { assert.equal(name, "_HEARTBEAT/a.json"); return '{"job":"a"}'; }, list: never }), { job: "a" });
});
