// Open-room write guard (2026-10-07). REGRESSION-LEDGER tag `indexer-skip-prefixes-recurring-gap`.
//
// The room every lane can read (commons-company-journal) held 147 ring-private chunks (_JOURNAL/ 137, _VAULT/ 10) that the
// nightly canary has flagged since 2026-09-29. The cause is structural: ring-private prefixes were kept out of the room by a
// hand-maintained deny-list applied when rows are SELECTED, so every lane nobody had listed yet was exposed until it leaked.
// The fix is deny-by-default and enforced at the write: a key may enter the open room only if it is canonical, not
// deny-listed, and under the reviewed allow-set; OS.pushDocs (the one function every upsert goes through) asserts it before
// any I/O. These tests drive the REAL write path with a stubbed wire:
//   * 1, 2, 4 and 7 fail on the OLD logic because the chunk is POSTed to the room (a `_bulk` call is captured);
//   * 5 fails on the old logic because an unscoped open-room selection returned every row that was not deny-listed;
//   * 9 fails on the old tree because brain-save's source denylist lacked _VAULT; 14 because only the exact room name counted;
//   * 3 and 6 pass on both: they pin that the reviewed writers and the legacy selection are unchanged; the rest pin the verdict.
// Nothing here reads, stores or prints document content: chunk text is a fixed marker, errors carry ids/codes/prefixes only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as PR from "../skills/doc-indexer/push-rules.mjs";
import { buildChunkDocs } from "../skills/doc-indexer/chunking.mjs";
import * as OS from "../skills/kb-memory/opensearch-write.mjs";
import * as PROV from "../skills/brain-save/lib/provenance.mjs";
import { chunkDocsFor } from "../skills/brain-save/lib/push.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
// Literal live values on purpose (not imported from push-rules): test 8 pins the exported constants to them.
const ROOM = "commons-company-journal";
const ACCOUNT = "otchealthcommons";
const CONTAINER = "company-journal";
const MARKER = "ZZ-CHUNK-MARKER-ZZ";

/** Chunk docs exactly as indexer.mjs push-search and brain-save build them, for one container-relative key. */
function chunkDocs(key, n = 1) {
  const row = { path: key, entity: String(key).split("/")[0], title: "t", sha256: "0".repeat(64) };
  return buildChunkDocs(row, Array.from({ length: n }, (_, i) => `${MARKER} ${i}`), { account: ACCOUNT, container: CONTAINER, vectors: Array.from({ length: n }, () => [0.1, 0.2]), wordCount: 2 });
}

/** Run `fn(calls)` with every credential/config lookup answered from env and `fetch` replaced by a recorder, so a write that
 *  gets past the guard shows up as a captured `_bulk` POST (and a stray call to any other host fails loudly). */
async function withWire(fn) {
  const set = { OPENSEARCH_ENDPOINT: "https://os-guard-test.invalid", OPENSEARCH_REGION: "us-east-1", AWS_ACCESS_KEY_ID: "guard-test-key-id", AWS_SECRET_ACCESS_KEY: "guard-test-not-a-credential" };
  const unset = ["AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", "AWS_CONTAINER_CREDENTIALS_FULL_URI", "AWS_CONTAINER_AUTHORIZATION_TOKEN", "AWS_SESSION_TOKEN"];
  const saved = {};
  for (const k of [...Object.keys(set), ...unset]) saved[k] = process.env[k];
  Object.assign(process.env, set);
  for (const k of unset) delete process.env[k];
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || "GET", body: typeof init.body === "string" ? init.body : "" });
    if (!String(url).startsWith("https://os-guard-test.invalid/")) return new Response("unexpected host", { status: 599 });
    return new Response(JSON.stringify({ took: 1, errors: false, items: [] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  OS._resetCachesForTests();
  try { return await fn(calls); }
  finally {
    globalThis.fetch = realFetch;
    OS._resetCachesForTests();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}
const bulkWrites = (calls) => calls.filter((c) => c.method === "POST" && /\/_bulk$/.test(c.url));
const refused = (e) => e && e.name === "OpenRoomWriteRefused" && e.code === "OPEN_ROOM_WRITE_REFUSED";

// 1 ------------------------------------------------------------------------------------------------------------------------
test("pushDocs: a chunk from ANY ring-private lane, in any spelling, never reaches the open room (no _bulk call is made)", async () => {
  const keys = [
    "_JOURNAL/cfo/2026-09-01/_DIGEST.md", "_VAULT/registry.md", "_VAULT/registry.jsonl", "_MEMORY/cfo/ledger.jsonl", "_HANDOFF/clo.md", "_DISPATCH/cto/task-1.json",
    "_journal/cfo/a.md", "_Journal/cfo/a.md", "_vault/registry.md", // case variants
    "/_JOURNAL/cfo/a.md", "./_JOURNAL/cfo/a.md", "_JOURNAL//cfo/a.md", "_JOURNAL\\cfo\\a.md", // slash and backslash variants
    "_KNOWLEDGE/../_JOURNAL/cfo/a.md", "_DAILY/x/../../_VAULT/registry.md", // traversal back into a lane
  ];
  for (const key of keys) {
    await withWire(async (calls) => {
      let err = null;
      try { await OS.pushDocs(ROOM, chunkDocs(key, 2)); } catch (e) { err = e; }
      assert.ok(refused(err), `${JSON.stringify(key)} must be refused by the open-room guard (got ${err ? `${err.name}: ${err.message}` : "NO ERROR: the chunk was written"})`);
      assert.equal(bulkWrites(calls).length, 0, `${JSON.stringify(key)}: a _bulk write reached the wire`);
      assert.equal(calls.length, 0, `${JSON.stringify(key)}: the guard must throw before ANY network call`);
    });
  }
});

// 2 ------------------------------------------------------------------------------------------------------------------------
test("pushDocs: deny by default -- a lane nobody has listed yet is refused, and so is anything outside the reviewed allow-set", async () => {
  const keys = ["_BOARD/minutes.md", "_LEGAL-HOLD/matter-1.md", "_FLEET-WATCH/2026-10-07.md", "_RESEARCH/x.md", "_KNOWLEDGE-META/registry/KN-DOC-0123456789.json", "_ARCHIVE/_KNOWLEDGE/x.md", "_TEXT/_KNOWLEDGE/x.md.txt", "research/x.md", "README.md", "_knowledge/x.md", "/_KNOWLEDGE/x.md", "_KNOWLEDGE//x.md", "_KNOWLEDGE/./x.md"];
  for (const key of keys) {
    await withWire(async (calls) => {
      let err = null;
      try { await OS.pushDocs(ROOM, chunkDocs(key)); } catch (e) { err = e; }
      assert.ok(refused(err), `${JSON.stringify(key)} must be refused (got ${err ? err.message : "NO ERROR: written"})`);
      assert.equal(calls.length, 0, `${JSON.stringify(key)}: nothing may reach the wire`);
    });
  }
});

// 3 ------------------------------------------------------------------------------------------------------------------------
test("pushDocs: the reviewed writers still pass (the guard cannot lock out nightly _DAILY/ and brain-save _KNOWLEDGE/)", async () => {
  const goodKey = PROV.keyFor({ kind: "research", app: "fleet", date: "2026-10-07", slug: "guard-test", contentSha: "a".repeat(64) });
  assert.ok(PROV.parseKnowledgeKey(goodKey), "fixture key is a real brain-save key");
  for (const docs of [chunkDocs("_DAILY/2026-10-07.md", 3), chunkDocs("_KNOWLEDGE/research/fleet/2026-10-07-x-aaaaaaaa.md", 2), chunkDocsFor(goodKey, `${MARKER}\n\nsecond paragraph`)]) {
    await withWire(async (calls) => {
      const r = await OS.pushDocs(ROOM, docs);
      assert.equal(r.ok, true);
      const writes = bulkWrites(calls);
      assert.equal(writes.length, 1, "one _bulk POST");
      for (const d of docs) assert.ok(writes[0].body.includes(d.id), `chunk ${d.id} was written`);
    });
  }
});

// 4 ------------------------------------------------------------------------------------------------------------------------
test("pushDocs: one refused doc refuses the WHOLE batch (nothing is half-written), and the error names ids, codes and the top-level folder only", async () => {
  await withWire(async (calls) => {
    const good = chunkDocs("_DAILY/2026-10-07.md", 2);
    const bad = chunkDocs("_JOURNAL/ZZ-SECRET-LANE-NAME/ZZ-SECRET-FILE.md", 1);
    let err = null;
    try { await OS.pushDocs(ROOM, [...good, ...bad]); } catch (e) { err = e; }
    assert.ok(refused(err), err ? err.message : "no error");
    assert.equal(calls.length, 0, "the good docs of a refused batch are not written either");
    assert.deepEqual(err.refusals.map((r) => ({ id: r.id, code: r.code, prefix: r.prefix })), [{ id: bad[0].id, code: "RING_PRIVATE", prefix: "_JOURNAL/" }]);
    assert.match(err.message, /refusing to write 1 of 3 document\(s\) to the OPEN room commons-company-journal/);
    assert.match(err.message, /RING_PRIVATE _JOURNAL\/ x1/);
    for (const leak of [MARKER, "ZZ-SECRET-LANE-NAME", "ZZ-SECRET-FILE"]) assert.ok(!err.message.includes(leak), `the error must not carry content or a full key (${leak})`);
  });
});

// 5 ------------------------------------------------------------------------------------------------------------------------
test("selectPushRows: for the open room an unscoped selection is the reviewed allow-set, not 'every row that is not deny-listed'", () => {
  const rows = ["_JOURNAL/cfo/a.md", "_VAULT/registry.md", "_BOARD/minutes.md", "_FLEET-WATCH/2026-10-07.md", "research/x.md", "_DAILY/2026-10-07.md", "_KNOWLEDGE/research/fleet/x.md", "/_KNOWLEDGE/y.md", "_knowledge/z.md"].map((path) => ({ path }));
  assert.deepEqual(PR.selectPushRows(rows, null, { openRoom: true }).map((r) => r.path), ["_DAILY/2026-10-07.md", "_KNOWLEDGE/research/fleet/x.md"]);
  assert.deepEqual(PR.selectPushRows(rows, ["_KNOWLEDGE/", "_DAILY/"], { openRoom: true }).map((r) => r.path), ["_DAILY/2026-10-07.md", "_KNOWLEDGE/research/fleet/x.md"]);
  assert.deepEqual(PR.selectPushRows(rows, [], { openRoom: true }), [], "an empty scope still selects nothing");
  // Never widened by the scope: naming a never-listed lane in the scope does not make it eligible.
  assert.deepEqual(PR.selectPushRows(rows, ["_BOARD/"], { openRoom: true }), []);
});

// 6 ------------------------------------------------------------------------------------------------------------------------
test("selectPushRows without opts is byte-for-byte the old behavior (other rooms and the legacy scoped push are untouched)", () => {
  const rows = ["_JOURNAL/cfo/a.md", "_BOARD/minutes.md", "research/x.md", "_DAILY/2026-10-07.md", "_TEXT/x.txt"].map((path) => ({ path }));
  assert.deepEqual(PR.selectPushRows(rows, null).map((r) => r.path), ["_BOARD/minutes.md", "research/x.md", "_DAILY/2026-10-07.md"]);
  assert.deepEqual(PR.selectPushRows(rows, ["_DAILY/"]).map((r) => r.path), ["_DAILY/2026-10-07.md"]);
  assert.deepEqual(PR.selectPushRows(rows, []), []);
  assert.deepEqual(PR.selectPushRows(rows, null, {}).map((r) => r.path), PR.selectPushRows(rows, null).map((r) => r.path));
});

// 7 ------------------------------------------------------------------------------------------------------------------------
test("pushDocs: every other index is untouched by the guard (ring memory indexes and other rooms keep writing)", async () => {
  for (const index of ["memory-exec", "commons-cto-memory", "legal-personal-memory", "finance-cfo-source-docs", "commons-company-journalism"]) {
    await withWire(async (calls) => {
      const r = await OS.pushDocs(index, [{ id: "m1", agent: "cto", text: "no path on purpose" }, ...chunkDocs("_JOURNAL/cfo/a.md")]);
      assert.equal(r.ok, true, index);
      assert.equal(bulkWrites(calls).length, 1, index);
    });
  }
  // ...while a physical or versioned name derived from the open room is the open room.
  for (const index of ["commons-company-journal-v2", "commons-company-journal_restore", "Commons-Company-Journal"]) {
    await withWire(async (calls) => {
      await assert.rejects(OS.pushDocs(index, chunkDocs("_VAULT/registry.md")), refused);
      assert.equal(calls.length, 0, index);
    });
  }
});

// 8 ------------------------------------------------------------------------------------------------------------------------
test("the room constants and the allow-set are pinned, and agree with brain-save's own copies", () => {
  assert.equal(PR.COMMONS_ROOM, ROOM);
  assert.equal(PR.COMMONS_ACCOUNT, ACCOUNT);
  assert.equal(PR.COMMONS_CONTAINER, CONTAINER);
  assert.equal(PR.COMMONS_ROOM_PATH_PREFIX, `${ACCOUNT}/${CONTAINER}/`);
  assert.deepEqual([...PR.COMMONS_PUSH_ALLOWED_PREFIXES], ["_KNOWLEDGE/", "_DAILY/"], "widening the open room's allow-set is a reviewed change: update this pin in the same PR");
  assert.equal(PROV.ROOM_INDEX, PR.COMMONS_ROOM);
  assert.equal(PROV.ROOM_ACCOUNT, PR.COMMONS_ACCOUNT);
  assert.equal(PROV.ROOM_CONTAINER, PR.COMMONS_CONTAINER);
  assert.ok(PR.COMMONS_PUSH_ALLOWED_PREFIXES.includes(PROV.KNOWLEDGE_PREFIX), "brain-save writes under an allowed prefix");
  assert.equal(PROV.roomPathFor("_KNOWLEDGE/x.md"), `${PR.COMMONS_ROOM_PATH_PREFIX}_KNOWLEDGE/x.md`);
  for (const p of PR.COMMONS_PUSH_ALLOWED_PREFIXES) {
    assert.ok(!PR.SKIP_PREFIXES.includes(p), `${p} is allowed AND skip-listed`);
    assert.equal(PR.isRingPrivatePath(`${p}x.md`), false, `${p} is allowed AND ring-private`);
  }
  // brain-save's raw sources and archive keys must never be accepted.
  for (const key of [`${PROV.META_PREFIX}registry/KN-DOC-0123456789.json`, `${PROV.ARCHIVE_PREFIX}_KNOWLEDGE/x.md`, PROV.sidecarKeyFor("_KNOWLEDGE/x.md")]) assert.equal(PR.openRoomKeyVerdict(key).ok, false, key);
});

// 9 ------------------------------------------------------------------------------------------------------------------------
test("the repo's own lists of ring-private lanes agree: push-rules RING_PRIVATE_PREFIXES == brain-save ring-denylist ledger segments", () => {
  const deny = JSON.parse(readFileSync(join(HERE, "..", "skills", "brain-save", "config", "ring-denylist.json"), "utf8"));
  const ledger = Object.entries(deny.pathSegments).filter(([, ring]) => ring === "ledger").map(([seg]) => `${seg}/`).sort();
  assert.deepEqual(ledger, [...PR.RING_PRIVATE_PREFIXES].sort(), "a ring-private lane added to one list must be added to the other (the purge and the canary count RING_PRIVATE_PREFIXES; brain-save refuses sources by the denylist)");
});

// 10 -----------------------------------------------------------------------------------------------------------------------
test("openRoomKeyVerdict: codes, canonical form, and every ring-private prefix refused", () => {
  assert.deepEqual(PR.openRoomKeyVerdict("_KNOWLEDGE/research/fleet/x.md"), { ok: true, code: "OK", reason: "" });
  assert.deepEqual(PR.openRoomKeyVerdict("_DAILY/2026-10-07.md"), { ok: true, code: "OK", reason: "" });
  for (const p of PR.RING_PRIVATE_PREFIXES) {
    assert.equal(PR.openRoomKeyVerdict(`${p}x/y.md`).code, "RING_PRIVATE", p);
    assert.equal(PR.openRoomKeyVerdict(`${p.toLowerCase()}x`).code, "RING_PRIVATE", `${p} lower-cased`);
    assert.equal(PR.openRoomKeyVerdict(`/${p}x`).code, "RING_PRIVATE", `${p} with a leading slash`);
    assert.equal(PR.isRingPrivatePath(`${p}x`), true, p);
  }
  assert.equal(PR.openRoomKeyVerdict("").code, "NO_KEY");
  assert.equal(PR.openRoomKeyVerdict(null).code, "NO_KEY");
  assert.equal(PR.openRoomKeyVerdict(42).code, "NO_KEY");
  assert.equal(PR.openRoomKeyVerdict("_KNOWLEDGE-META/x").code, "SKIP_LISTED");
  assert.equal(PR.openRoomKeyVerdict("_TRASH/_KNOWLEDGE/x.md").code, "SKIP_LISTED");
  assert.equal(PR.openRoomKeyVerdict("_KNOWLEDGE//x.md").code, "NON_CANONICAL");
  assert.equal(PR.openRoomKeyVerdict("_KNOWLEDGE/./x.md").code, "NON_CANONICAL");
  assert.equal(PR.openRoomKeyVerdict("_KNOWLEDGE\\x.md").code, "NON_CANONICAL");
  assert.equal(PR.openRoomKeyVerdict("_KNOWLEDGE/../_DAILY/x.md").code, "NON_CANONICAL");
  assert.equal(PR.openRoomKeyVerdict("_knowledge/x.md").code, "NOT_ALLOWLISTED", "the allow-set is case-sensitive");
  assert.equal(PR.openRoomKeyVerdict(" _KNOWLEDGE/x.md").code, "NOT_ALLOWLISTED");
  assert.equal(PR.openRoomKeyVerdict("_KNOWLEDGE").code, "NOT_ALLOWLISTED", "a bare name is not inside the folder");
  assert.equal(PR.openRoomKeyVerdict("_BOARD/minutes.md").code, "NOT_ALLOWLISTED");
});

// 11 -----------------------------------------------------------------------------------------------------------------------
test("openRoomDocVerdict / commonsKeyOf: chunked docs, flat docs, foreign paths and a lying source_path", () => {
  assert.equal(PR.commonsKeyOf(`${PR.COMMONS_ROOM_PATH_PREFIX}_DAILY/x.md`), "_DAILY/x.md");
  assert.equal(PR.commonsKeyOf(`${PR.COMMONS_ROOM_PATH_PREFIX.toUpperCase()}_JOURNAL/x.md`), "_JOURNAL/x.md");
  assert.equal(PR.commonsKeyOf("_DAILY/x.md"), "_DAILY/x.md", "a flat room's path is already container-relative");
  assert.equal(PR.commonsKeyOf(undefined), "");
  const good = chunkDocs("_KNOWLEDGE/research/fleet/x.md")[0];
  assert.equal(PR.openRoomDocVerdict(good).ok, true);
  assert.equal(PR.openRoomDocVerdict({ ...good, path: "_KNOWLEDGE/x.md" }).ok, true, "flat shape");
  assert.equal(PR.openRoomDocVerdict({ ...good, path: `${ACCOUNT.toUpperCase()}/${CONTAINER}/_JOURNAL/x.md` }).code, "RING_PRIVATE", "a mangled-case room prefix does not hide the lane");
  assert.equal(PR.openRoomDocVerdict({ ...good, path: `${ACCOUNT}//${CONTAINER}/_KNOWLEDGE/x.md` }).code, "NON_CANONICAL");
  assert.equal(PR.openRoomDocVerdict({ ...good, path: "otchealthcfodata/cfo-source-docs/x.pdf" }).code, "NOT_ALLOWLISTED", "a foreign container's path");
  assert.equal(PR.openRoomDocVerdict({ ...good, path: `${PR.COMMONS_ROOM_PATH_PREFIX}${PR.COMMONS_ROOM_PATH_PREFIX}_JOURNAL/x.md` }).code, "NOT_ALLOWLISTED", "a doubled room prefix");
  assert.equal(PR.openRoomDocVerdict({ ...good, source_path: "_JOURNAL/cfo" }).code, "RING_PRIVATE", "path says allowed, source_path says lane");
  assert.equal(PR.openRoomDocVerdict({ ...good, source_path: "_JOURNAL" }).code, "RING_PRIVATE", "a file directly under the lane has source_path with no trailing slash");
  for (const bad of [null, undefined, 7, "x", {}, { path: "" }, { path: 5 }, { id: "a", chunk: "no path" }]) assert.equal(PR.openRoomDocVerdict(bad).code, "NO_PATH", JSON.stringify(bad));
});

// 12 -----------------------------------------------------------------------------------------------------------------------
test("assertOpenRoomWritable: a no-op for other indexes and empty batches; isOpenRoomIndex is exact for the room and its derived names only", () => {
  assert.doesNotThrow(() => PR.assertOpenRoomWritable("memory-exec", chunkDocs("_JOURNAL/x.md")));
  assert.doesNotThrow(() => PR.assertOpenRoomWritable(ROOM, []));
  assert.doesNotThrow(() => PR.assertOpenRoomWritable(ROOM, undefined));
  assert.doesNotThrow(() => PR.assertOpenRoomWritable(ROOM, chunkDocs("_DAILY/2026-10-07.md", 3)));
  assert.throws(() => PR.assertOpenRoomWritable(ROOM, [{ id: "a" }]), (e) => e instanceof PR.OpenRoomWriteRefused && e.refusals[0].code === "NO_PATH");
  for (const yes of [ROOM, "COMMONS-COMPANY-JOURNAL", ` ${ROOM} `, `${ROOM}-v2`, `${ROOM}_q`, `${ROOM}.restore`]) assert.equal(PR.isOpenRoomIndex(yes), true, yes);
  assert.equal(PR.isCommonsTarget("commons"), true);
  assert.equal(PR.isCommonsTarget("generic", `${ROOM}-v2`), true, "a derived physical name of the open room is the open room");
  assert.equal(PR.isCommonsTarget("finance", "finance-cfo-source-docs"), false);
  for (const no of ["commons-cto-memory", "memory-exec", "commons-company-journalism", "my-commons-company-journal", "", null, undefined]) assert.equal(PR.isOpenRoomIndex(no), false, String(no));
});

// 13 -----------------------------------------------------------------------------------------------------------------------
test("the purge tool shares the room definition with the guard (one definition, no drifting copy)", async () => {
  const purge = await import("../skills/doc-indexer/purge-ring-residue.mjs");
  assert.equal(purge.ROOM, PR.COMMONS_ROOM);
  assert.equal(purge.ROOM_PATH_PREFIX, PR.COMMONS_ROOM_PATH_PREFIX);
  assert.deepEqual(purge.purgePrefixes(null), [...PR.RING_PRIVATE_PREFIXES]);
});

// 14 -----------------------------------------------------------------------------------------------------------------------
test("indexer.mjs push-search: an unscoped push at a name derived from the open room is refused before any storage or network work", () => {
  const indexer = join(HERE, "..", "skills", "doc-indexer", "indexer.mjs");
  let code = 0;
  let stderr = "";
  try { execFileSync(process.execPath, [indexer, "push-search", "--profile", "generic", "--index", `${ROOM}-v2`, "--s3"], { env: { PATH: process.env.PATH, HOME: process.env.HOME }, stdio: ["ignore", "pipe", "pipe"], timeout: 30000 }); }
  catch (e) { code = e.status; stderr = String(e.stderr || ""); }
  assert.equal(code, 2, stderr);
  assert.match(stderr, /refusing an UNSCOPED commons push-search/);
});
