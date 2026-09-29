// Adjudication round 3 (2026-09-29): pipeline / CLI behavior defects, end to end through main() against the
// in-memory fake backend. One test (or more) per confirmed defect: #2 identity collisions, #3 INND override
// seats, #4 privileged seats, #6 HTML <title>, #13 registry/S3/room drift, #14 deadlines, #16 base64,
// #17 input bounds.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync, openSync, ftruncateSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { main, runAudit, rebuildFromChunks, MAX_INPUT_BYTES, MAX_STORE_ONLY_BYTES } from "../brain-save.mjs";
import { prepareDoc, saveBatch } from "../lib/pipeline.mjs";
import { _resetShapeCacheForTests } from "../lib/push.mjs";
import { seatGate } from "../lib/local.mjs";
import { sha256 } from "../lib/provenance.mjs";
import { createFakeBackend } from "./fake-backend.mjs";

process.env.BRAIN_SAVE_VERIFY_DELAY_MS = "0";
let STATE;
beforeEach(() => {
  STATE = mkdtempSync(join(tmpdir(), "bs3-state-"));
  process.env.BRAIN_SAVE_STATE_DIR = STATE;
  process.env.KB_AGENT = "cto";
  delete process.env.BRAIN_SAVE_CALL_TIMEOUT_MS;
  delete process.env.BRAIN_SAVE_DEADLINE_MS;
  _resetShapeCacheForTests();
});

function tmpDoc(name, content, dir = mkdtempSync(join(tmpdir(), "bs3-doc-"))) {
  const f = join(dir, name);
  mkdirSync(join(f, ".."), { recursive: true });
  writeFileSync(f, content);
  return f;
}
async function run(argv, backend, needles = []) {
  const out = []; const err = [];
  _resetShapeCacheForTests();
  const code = await main(argv, { backend, needles, now: new Date("2026-09-29T06:00:00Z") }, { stdout: (s) => out.push(s), stderr: (s) => err.push(s) });
  return { code, out: out.join("\n"), err: err.join("\n"), rows: out.filter((l) => l.startsWith("{")).map((l) => JSON.parse(l)) };
}
const put = (f, extra = []) => ["put", ...(Array.isArray(f) ? f : [f]), "--kind", "receipt", "--app", "aware", "--agent", "cto", "--json", ...extra];
const receipt = (n) => `# AWARE build receipt\n\nBuild ${n} shipped to TestFlight. Unique token zq${n}xv appears only in this receipt. Depot run ${n}000, CFBundleVersion ${n}, archive signed, Device Farm clean.\n`;
const knowledge = (be) => [...be.s3.keys()].filter((k) => k.startsWith("_KNOWLEDGE/"));
const findable = async (be, tok) => (await be.search({ queryText: tok })).length > 0;
const registries = (be) => [...be.s3.keys()].filter((k) => k.includes("/registry/")).map((k) => JSON.parse(be.s3.get(k).text));

// ---------------- #2 identity collisions ----------------
test("round 3 #2: two DIFFERENT receipts with the same H1 no longer replace each other (second is exit 1, first stays searchable)", async () => {
  const be = createFakeBackend();
  const r57 = await run(put(tmpDoc("r57.md", receipt(57))), be);
  assert.equal(r57.code, 0, r57.out);
  const r58 = await run(put(tmpDoc("r58.md", receipt(58))), be);
  assert.equal(r58.code, 1, r58.out);
  assert.match(r58.out, /identity collision.*--supersedes KN-RCP-/s);
  assert.ok(await findable(be, "zq57xv"), "receipt 57 is still searchable");
  assert.equal(await findable(be, "zq58xv"), false, "nothing of 58 was written");
  assert.equal(knowledge(be).length, 1);
  // The explicit escape hatch: --supersedes <brain_id> makes 58 the next version.
  const again = await run(put(tmpDoc("r58b.md", receipt(58)), ["--supersedes", r57.rows[0].brain_id]), be);
  assert.equal(again.code, 0, again.out);
  assert.equal(again.rows[0].superseded, r57.rows[0].key);
  assert.ok(await findable(be, "zq58xv"));
  assert.equal(await findable(be, "zq57xv"), false);
});

test("round 3 #2: the SAME file edited keeps updating its document (local receipt matches)", async () => {
  const be = createFakeBackend();
  const f = tmpDoc("r.md", receipt(60));
  assert.equal((await run(put(f), be)).code, 0);
  writeFileSync(f, receipt(61));
  const r = await run(put(f), be);
  assert.equal(r.code, 0, r.out);
  assert.ok(r.rows[0].superseded, "v1 superseded");
  assert.ok(await findable(be, "zq61xv"));
  assert.equal(await findable(be, "zq60xv"), false);
});

test("round 3 #2: one batch with two different documents under one identity: both exit 1, nothing of them saved, others saved", async () => {
  const be = createFakeBackend();
  const d = mkdtempSync(join(tmpdir(), "bs3-batch-"));
  tmpDoc("a.md", receipt(1), d);
  tmpDoc("b.md", receipt(2), d);
  tmpDoc("c.md", "# AWARE audio latency research\n\nA separate document about widget sprockets and audio latency.\n", d);
  const r = await run(put(d), be);
  assert.equal(r.code, 1, r.out);
  const byFile = Object.fromEntries(r.rows.map((x) => [x.file.split("/").pop(), x]));
  assert.equal(byFile["a.md"].exit, 1);
  assert.equal(byFile["b.md"].exit, 1);
  assert.match(byFile["a.md"].message, /identity collision in this batch/);
  assert.equal(byFile["c.md"].status, "saved");
  assert.equal(knowledge(be).length, 1, "only c.md");
});

test("round 3 #2: --title or --id with more than one file is exit 1 before anything is written", async () => {
  for (const flag of [["--title", "AWARE build receipt TestFlight"], ["--id", "aware-receipts"]]) {
    const be = createFakeBackend();
    const d = mkdtempSync(join(tmpdir(), "bs3-multi-"));
    for (const n of [1, 2, 3]) tmpDoc(`r${n}.md`, receipt(n), d);
    const r = await run(put(d, flag), be);
    assert.equal(r.code, 1, flag[0]);
    assert.match(r.err, new RegExp(`${flag[0]} names ONE document but 3 files`));
    assert.equal(be.s3.size + be.calls.embed, 0, flag[0]);
  }
  // one file with --title is fine
  const be = createFakeBackend();
  assert.equal((await run(put(tmpDoc("one.md", receipt(9)), ["--title", "AWARE build 9 receipt"]), be)).code, 0);
});

test("round 3 #2: a same-file RETITLE (new H1) supersedes the file's previous document; a different file sharing a body is never superseded", async () => {
  const be = createFakeBackend();
  const f = tmpDoc("draft.md", "# Widget latency draft notes\n\nFirst draft about widget sprocket latency; token dra77q.\n");
  const v1 = await run(put(f, ["--kind", "research"]), be);
  assert.equal(v1.code, 0);
  writeFileSync(f, "# Widget latency final findings\n\nFinal findings about widget sprocket latency; token fin88q.\n");
  const v2 = await run(put(f, ["--kind", "research"]), be);
  assert.equal(v2.code, 0, v2.out);
  assert.notEqual(v2.rows[0].brain_id, v1.rows[0].brain_id, "new title = new identity");
  assert.equal(v2.rows[0].superseded, v1.rows[0].key, "the old draft is superseded");
  assert.equal(await findable(be, "dra77q"), false);
  // An ALIAS receipt (same body as someone else's document) never makes that document supersedable.
  const be2 = createFakeBackend();
  const body = "# Shared widget body\n\nIdentical content about widget sprockets; token sha55q.\n";
  const owner = await run(put(tmpDoc("owner.md", body), ["--kind", "research"]), be2);
  const g = tmpDoc("copy.md", body);
  const alias = await run(put(g, ["--kind", "research", "--title", "Copy of the shared widget body"]), be2);
  assert.equal(alias.rows[0].status, "alias");
  writeFileSync(g, "# Copy of the shared widget body\n\nNow different content about gizmos; token cop66q.\n");
  const edited = await run(put(g, ["--kind", "research"]), be2);
  assert.equal(edited.code, 0, edited.out);
  assert.ok(!edited.rows[0].superseded, "the alias target is not this file's document");
  assert.ok(await findable(be2, "sha55q"), "the owner's document is still searchable");
  assert.equal(registries(be2).find((x) => x.brain_id === owner.rows[0].brain_id).live_key, owner.rows[0].key);
});

// ---------------- #3 INND override seats / #4 privileged seats ----------------
const INND = "# INND Reg D offering summary\n\nINND and InnerScope are conducting a Reg D private placement. The subscription agreement, cap table, warrant coverage and valuation cap are under negotiation with an accredited investor; the term sheet has not been released.\n";
const OVR = ["--ring-override", "INND_SECURITIES: wording copied from the public 8-K press release"];

test("round 3 #3: an INND override is refused from any seat but clo / capital / exec; the --agent flag cannot elevate", async () => {
  for (const [seat, flagAgent] of [["cto", "clo"], ["cro", "cro"], ["developer", "exec"], ["", "capital"]]) {
    if (seat) process.env.KB_AGENT = seat; else delete process.env.KB_AGENT;
    const be = createFakeBackend();
    const r = await run(["put", tmpDoc("innd.md", INND), "--kind", "research", "--app", "fleet", "--agent", flagAgent, "--share", "--json", ...OVR], be);
    assert.equal(r.code, 2, `seat ${seat || "(none)"} / --agent ${flagAgent}: ${r.out}`);
    assert.match(r.out, /INND_SECURITIES can be overridden only from the clo, capital, exec seat/);
    assert.match(r.out, /route \(innd-mnpi\): INND MNPI/);
    assert.equal(be.s3.size + be.calls.embed, 0);
  }
});

test("round 3 #3: the clo / capital / exec SEAT can override an INND heuristic (clo and capital with --share); it is audited with the seat", async () => {
  for (const seat of ["clo", "capital", "exec"]) {
    process.env.KB_AGENT = seat;
    const be = createFakeBackend();
    const r = await run(["put", tmpDoc("innd.md", INND), "--kind", "research", "--app", "fleet", "--share", "--json", ...OVR], be);
    assert.equal(r.code, 0, `${seat}: ${r.out}`);
    const obj = be.s3.get(r.rows[0].key).text;
    assert.match(obj, new RegExp(`ring_override: ".*seat ${seat}, signals: INND_SECURITIES`));
    // audit re-checks the stored override against the recorded seat
    const a = await runAudit(be, { needles: [], secrets: false, ring: true, searchable: false }, { out() {} });
    assert.equal(a.findings.length, 0, seat);
  }
});

test("round 3 #4: clo-personal never writes commons (flag or KB_AGENT; --share cannot override); cfo / clo / capital need --share", async () => {
  const f = tmpDoc("n.md", "# Ordinary widget notes\n\nOrdinary engineering notes on widget sprockets and gizmos, long enough to count.\n");
  const cases = [
    [{ KB_AGENT: "cto" }, ["--agent", "clo-personal", "--share"], 2, /SEAT_NEVER_COMMONS/],
    [{ KB_AGENT: "clo-personal" }, ["--agent", "cto", "--share"], 2, /SEAT_NEVER_COMMONS/],
    [{ KB_AGENT: "cto" }, ["--agent", "cfo"], 2, /SEAT_SHARE_REQUIRED.*--share/],
    [{ KB_AGENT: "clo" }, [], 2, /SEAT_SHARE_REQUIRED/],
    [{ KB_AGENT: "capital" }, ["--agent", "cto"], 2, /SEAT_SHARE_REQUIRED/],
    [{ KB_AGENT: "cfo" }, ["--share"], 0, null],
    [{ KB_AGENT: "cto" }, ["--agent", "capital", "--share"], 0, null],
  ];
  for (const [env, extra, code, re] of cases) {
    process.env.KB_AGENT = env.KB_AGENT;
    const be = createFakeBackend();
    const r = await run(["put", f, "--kind", "research", "--app", "fleet", "--title", `Ordinary widget notes ${env.KB_AGENT} ${extra.join(" ")}`, "--json", ...extra], be);
    assert.equal(r.code, code, `${JSON.stringify(env)} ${extra.join(" ")}: ${r.err}`);
    if (re) { assert.match(r.err, re); assert.equal(be.s3.size + be.calls.embed, 0); }
  }
  assert.deepEqual(seatGate({ agent: "cto", seat: "developer" }), null);
  assert.equal(seatGate({ agent: "CLO-Personal", seat: "" }).code, "SEAT_NEVER_COMMONS");
});

test("round 3 #4: backfill applies the same seat gate", async () => {
  process.env.KB_AGENT = "clo-personal";
  const m = tmpDoc("m.json", JSON.stringify([{ path: tmpDoc("x.md", "# Some widget research\n\nSome widget research notes, long enough.\n"), app: "fleet", kind: "research", include: "yes" }]));
  const r = await run(["backfill", m, "--dry-run"], createFakeBackend());
  assert.equal(r.code, 2);
  assert.match(r.err, /SEAT_NEVER_COMMONS/);
});

// ---------------- #6 HTML <title> ----------------
test("round 3 #6: an HTML page's <title> is searchable even when the body never says it", async () => {
  const be = createFakeBackend();
  const html = `<!doctype html><html><head><title>Vellichor Anchoritefox Ledgerpage</title></head><body><h1>Completely different heading here</h1><p>Body prose about the widget sprocket gizmo roadmap for the next quarter.</p></body></html>`;
  const r = await run(["put", tmpDoc("page.html", html), "--kind", "artifact", "--app", "fleet", "--agent", "cto", "--json"], be);
  assert.equal(r.code, 0, r.out);
  assert.match(be.s3.get(r.rows[0].key).text, /Page title: Vellichor Anchoritefox Ledgerpage/);
  const v = await run(["verify", "Vellichor Anchoritefox Ledgerpage", "--gateway", "off", "--expect", r.rows[0].key], be);
  assert.equal(v.code, 0, v.out);
  assert.match(v.out, /room rank 1/);
});

// ---------------- #13 drift between registry, S3 and room ----------------
test("round 3 #13a: a crash between the push and the live registry write leaves a PENDING version that the next version retires", async () => {
  const be = createFakeBackend();
  const f = tmpDoc("g.md", "# Gap probe widget document\n\nVersion one text about widget sprockets; unique token vone77q.\n");
  // Simulate the kill: every registry write AFTER the pending entry fails (the process dies before "live").
  const origPutCond = be.putCond;
  let registryWrites = 0;
  be.putCond = async (key, ...rest) => { if (key.includes("/registry/") && ++registryWrites > 1) { const e = new Error("killed"); e.status = 500; throw e; } return origPutCond(key, ...rest); };
  const crashed = await run(put(f, ["--kind", "research", "--app", "fleet"]), be);
  assert.notEqual(crashed.code, 0);
  be.putCond = origPutCond;
  const reg = registries(be)[0];
  assert.equal(reg.versions[0].status, "stored-unverified", "the pending entry landed before any chunk");
  assert.ok(await findable(be, "vone77q"), "(the crashed version's chunks exist)");
  writeFileSync(f, "# Gap probe widget document\n\nVersion two text about widget sprockets; unique token vtwo88q.\n");
  const r = await run(put(f, ["--kind", "research", "--app", "fleet"]), be);
  assert.equal(r.code, 0, r.out);
  assert.ok(await findable(be, "vtwo88q"));
  assert.equal(await findable(be, "vone77q"), false, "the orphan was retired");
  const a = await runAudit(be, { needles: [], secrets: false, ring: false, searchable: true }, { out() {} });
  assert.equal(a.findings.length, 0, JSON.stringify(a.findings));
});

test("round 3 #13a: audit flags a searchable object its registry does not know (legacy crash state); --repair retires it", async () => {
  const be = createFakeBackend();
  const f = tmpDoc("g.md", "# Gap probe widget document\n\nVersion one text about widget sprockets; unique token vone77q.\n");
  await run(put(f, ["--kind", "research", "--app", "fleet"]), be);
  for (const k of [...be.s3.keys()]) if (k.includes("/registry/") || k.includes("/by-hash/")) be.s3.delete(k);
  writeFileSync(f, "# Gap probe widget document\n\nVersion two text about widget sprockets; unique token vtwo88q.\n");
  assert.equal((await run(put(f, ["--kind", "research", "--app", "fleet"]), be)).code, 0);
  const a = await run(["audit", "--searchable"], be);
  assert.equal(a.code, 3, a.out);
  assert.match(a.out, /FINDING unregistered-live: _KNOWLEDGE\/research\/fleet\/.*live is _KNOWLEDGE/);
  const fix = await run(["audit", "--searchable", "--repair"], be);
  assert.match(fix.out, /retired unregistered searchable version/);
  assert.equal(await findable(be, "vone77q"), false);
  const abandoned = registries(be)[0].versions.find((v) => v.status === "abandoned");
  assert.ok(abandoned && /unregistered searchable version/.test(abandoned.abandoned_reason) && abandoned.archived_key.startsWith("_ARCHIVE/"), "the retired version is recorded in the registry");
  assert.ok(await findable(be, "vtwo88q"));
  assert.equal((await run(["audit", "--searchable"], be)).code, 0);
});

test("round 3 #13a: an unregistered searchable object with NO live version is adopted by --repair", async () => {
  const be = createFakeBackend();
  const r = await run(put(tmpDoc("o.md", "# Orphan widget document\n\nOrphan text about widget sprockets; unique token orph11q.\n"), ["--kind", "research", "--app", "fleet"]), be);
  for (const k of [...be.s3.keys()]) if (k.includes("/registry/")) be.s3.delete(k);
  assert.match((await run(["audit", "--searchable"], be)).out, /unregistered-live: .* does not exist/);
  await run(["audit", "--searchable", "--repair"], be);
  const reg = registries(be)[0];
  assert.equal(reg.live_key, r.rows[0].key);
  assert.equal(reg.versions[0].status, "live");
  assert.equal((await run(["audit", "--searchable"], be)).code, 0);
});

test("round 3 #13b: a re-put restores a deleted live S3 object (not UNCHANGED exit 0 without it); audit flags live-missing and --repair restores", async () => {
  const be = createFakeBackend();
  const g = tmpDoc("b.md", "# Audit gap probe two widget\n\nSome text about widget sprockets; unique token bthree99q and more words.\n");
  const first = await run(put(g, ["--kind", "research", "--app", "fleet"]), be);
  const key = first.rows[0].key;
  be.s3.delete(key);
  const a = await run(["audit", "--searchable"], be);
  assert.equal(a.code, 3);
  assert.match(a.out, new RegExp(`FINDING live-missing: ${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  const again = await run(put(g, ["--kind", "research", "--app", "fleet"]), be);
  assert.equal(again.code, 0, again.out);
  assert.equal(again.rows[0].status, "saved");
  assert.ok(again.rows[0].warnings.some((w) => /NO stored S3 object/.test(w)));
  assert.ok(be.s3.has(key), "object restored");
  assert.equal((await run(["audit", "--searchable"], be)).code, 0);
  // --repair without a re-put: rebuilt from the room's own chunks (sha256-verified)
  const before = be.s3.get(key).text;
  be.s3.delete(key);
  const fix = await run(["audit", "--searchable", "--repair"], be);
  assert.match(fix.out, /restored missing live object \S+ \(rebuilt from 1 chunk\(s\), sha256 verified\)/);
  assert.equal(be.s3.get(key).text, before);
});

test("round 3 #13b: rebuildFromChunks reassembles overlapping chunks exactly and refuses a hash mismatch", () => {
  const text = Array.from({ length: 400 }, (_, i) => `line ${i} about widget sprockets and gizmos`).join("\n");
  const docs = [];
  // chunk exactly like push.mjs (2000/200) through its own helper
  return import("../lib/push.mjs").then(({ chunkDocsFor }) => {
    for (const d of chunkDocsFor("_KNOWLEDGE/research/fleet/x.md", text)) docs.push({ id: d.id, chunk: d.chunk, content_hash: d.content_hash });
    assert.ok(docs.length > 3);
    assert.equal(rebuildFromChunks(docs.reverse()), text);
    assert.equal(rebuildFromChunks(docs.map((d) => ({ ...d, content_hash: sha256("other") }))), "");
    assert.equal(rebuildFromChunks(docs.slice(1)), "", "a missing chunk is not rebuilt");
  });
});

// ---------------- #14 deadlines ----------------
test("round 3 #14: a black-holed dependency ends the put in bounded time: before storing -> exit 1, after storing -> exit 3", async () => {
  process.env.BRAIN_SAVE_CALL_TIMEOUT_MS = "150";
  const hang = () => new Promise(() => {});
  // S3 black-holed from the first call: nothing stored
  let be = createFakeBackend();
  be.get = hang;
  let t0 = Date.now();
  let r = await run(put(tmpDoc("d.md", receipt(70))), be);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /timed out after 150 ms/);
  assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0} ms`);
  // the room's search black-holed: stored, verify cannot finish -> exit 3 (and the chunk cleanup is bounded too)
  be = createFakeBackend();
  be.search = hang;
  t0 = Date.now();
  r = await run(put(tmpDoc("d.md", receipt(71))), be);
  assert.equal(r.code, 3, r.out);
  assert.match(r.out, /room proof could not run: search\(\) timed out/);
  assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0} ms`);
  // the gateway black-holed with --gateway on: exit 3 after ONE timeout (no retry storm)
  be = createFakeBackend();
  let gatewayCalls = 0;
  be.gatewayKbSearch = () => { gatewayCalls++; return hang(); };
  t0 = Date.now();
  r = await run(put(tmpDoc("d.md", receipt(72)), ["--gateway", "on"]), be);
  assert.equal(r.code, 3, r.out);
  assert.equal(gatewayCalls, 1, "a timed-out gateway call ends the gateway proof (no retries into a black hole)");
  assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms`);
});

test("round 3 #14: the overall put budget (BRAIN_SAVE_DEADLINE_MS) ends a slow put", async () => {
  process.env.BRAIN_SAVE_DEADLINE_MS = "300";
  process.env.BRAIN_SAVE_CALL_TIMEOUT_MS = "10000";
  const be = createFakeBackend();
  const slow = be.embed;
  be.embed = async (t) => { await new Promise((res) => setTimeout(res, 200)); return slow(t); };
  const t0 = Date.now();
  const r = await run(put(tmpDoc("d.md", receipt(73))), be);
  assert.ok([1, 3].includes(r.code), `exit ${r.code}: ${r.out}`);
  assert.match(r.out, /deadline|timed out/);
  assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0} ms`);
});

// ---------------- #16 base64 / #17 input bounds ----------------
test("round 3 #16: a WRAPPED data URI is stripped (no junk chunks); a fenced base64 dump is exit 1", async () => {
  const wrap = randomBytes(60000).toString("base64").match(/.{1,76}/g).join("\n");
  let be = createFakeBackend();
  let r = await run(put(tmpDoc("s.md", `# Screenshot notes widget\n\nSee image.\n\n![shot](data:image/png;base64,\n${wrap})\n\nAfter the image, prose continues about widgets.\n`), ["--kind", "research", "--app", "fleet"]), be);
  assert.equal(r.code, 0, r.out);
  assert.equal(r.rows[0].chunks, 1);
  assert.match(be.s3.get(r.rows[0].key).text, /prose continues about widgets/);
  be = createFakeBackend();
  r = await run(put(tmpDoc("f.md", `# Screenshot notes widget\n\nSee image.\n\n\`\`\`\n${wrap}\n\`\`\`\n`), ["--kind", "research", "--app", "fleet"]), be);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /% base64/);
  assert.equal(be.s3.size + be.calls.embed, 0);
  // --store-only keeps raw bytes and is not blocked by the base64 share
  be = createFakeBackend();
  r = await run(put(tmpDoc("f2.md", `# Screenshot notes widget raw\n\n\`\`\`\n${wrap}\n\`\`\`\n`), ["--kind", "research", "--app", "fleet", "--store-only"]), be);
  assert.equal(r.code, 0, r.out);
});

test("round 3 #17: zero-width-only text is empty (exit 1); oversize inputs are refused by size BEFORE they are read", async () => {
  const be = createFakeBackend();
  const r = await run(put(tmpDoc("z.md", "​".repeat(40) + "﻿­"), ["--title", "Zero width probe widget sprocket"]), be);
  assert.equal(r.code, 1);
  assert.match(r.out, /only 0 character/);
  for (const [extra, limit] of [[[], MAX_INPUT_BYTES], [["--store-only"], MAX_STORE_ONLY_BYTES]]) {
    const f = join(mkdtempSync(join(tmpdir(), "bs3-big-")), "big.md");
    const fd = openSync(f, "w"); ftruncateSync(fd, limit + 1); closeSync(fd); // sparse: never actually read
    const b = createFakeBackend();
    const x = await run(put(f, ["--title", "Oversize probe widget sprocket", ...extra]), b);
    assert.equal(x.code, 1, extra.join(" "));
    assert.match(x.out, /MB; the (put|--store-only) limit is/);
    assert.equal(b.s3.size, 0);
  }
});
