// Adjudication round 4 (2026-09-29): correctness findings C1, C2, C3 for brain-save, end to end through main()
// or the pure verify functions, against the in-memory fake backend. Every test fails on the round-3 code.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../brain-save.mjs";
import { verifyInRoom, verifyViaGateway } from "../lib/verify.mjs";
import { EXIT, combineExitCodes } from "../lib/errors.mjs";
import { _resetShapeCacheForTests } from "../lib/push.mjs";
import { createFakeBackend } from "./fake-backend.mjs";

process.env.BRAIN_SAVE_VERIFY_DELAY_MS = "0";
beforeEach(() => { process.env.BRAIN_SAVE_STATE_DIR = mkdtempSync(join(tmpdir(), "bs4p-state-")); process.env.KB_AGENT = "cto"; _resetShapeCacheForTests(); });

const tmpDoc = (name, content) => { const f = join(mkdtempSync(join(tmpdir(), "bs4p-doc-")), name); writeFileSync(f, content); return f; };
async function run(argv, backend) {
  const out = []; const err = [];
  _resetShapeCacheForTests();
  const code = await main(argv, { backend, needles: [], now: new Date("2026-09-29T06:00:00Z") }, { stdout: (s) => out.push(s), stderr: (s) => err.push(s) });
  return { code, out: out.join("\n"), err: err.join("\n"), rows: out.filter((l) => l.startsWith("{")).map((l) => JSON.parse(l)) };
}
const BODY = "# Widget sprocket gizmo planning notes\n\nSynthetic fixture about widgets, gizmos and sprockets.\n";
const put = (f, extra = []) => ["put", f, "--kind", "research", "--app", "fleet", "--agent", "cto", "--json", ...extra];
const registries = (be) => [...be.s3.keys()].filter((k) => k.includes("/registry/")).map((k) => JSON.parse(be.s3.get(k).text));

// ---------------- C1: a proof that could not run is not a proven miss ----------------
test("C1: verifyInRoom catches a search exception INSIDE its retry loop and retries (a blip on attempt 1 still verifies)", async () => {
  const be = createFakeBackend();
  const f = tmpDoc("a.md", BODY);
  assert.equal((await run(put(f), be)).code, 0);
  const row = registries(be)[0].versions[0];
  const real = be.search.bind(be);
  let calls = 0;
  be.search = async (q) => { if (++calls === 1) throw new Error("opensearch 503"); return real(q); };
  const v = await verifyInRoom(be, { key: row.key, brainId: registries(be)[0].brain_id, title: row.title, contentSha: row.content_sha256, retries: 3, delayMs: 0 });
  assert.equal(v.ok, true, JSON.stringify(v));
  assert.equal(v.error, "");
});

test("C1: verifyInRoom never throws and reports cleanMiss=false / error when the FINAL attempt could not run", async () => {
  const be = createFakeBackend({ searchThrows: true });
  const v = await verifyInRoom(be, { key: "_KNOWLEDGE/research/fleet/2026-09-29-x-abcd1234.md", brainId: "KN-RES-1234567890", title: "Some title here", contentSha: "a".repeat(64), retries: 2, delayMs: 0 });
  assert.equal(v.ok, false);
  assert.equal(v.cleanMiss, false);
  assert.match(v.error, /opensearch 503/);
});

test("C1: search errors during verify KEEP the chunks and exit 3 with 'stored + pushed, proof could not run'", async () => {
  const be = createFakeBackend({ searchThrows: true });
  const r = await run(put(tmpDoc("a.md", BODY)), be);
  assert.equal(r.code, 3, r.out);
  assert.match(r.rows[0].message, /stored \+ pushed, proof could not run/);
  assert.ok(be.room.size > 0, "the chunks are still in the room: nothing proved them not searchable");
  assert.equal(registries(be)[0].versions[0].status, "stored-unverified");
  assert.equal(registries(be)[0].versions[0].proof, "could-not-run");
  // re-running verifies and completes it (mode "retry": no duplicate object, converges to live)
  be.fail.searchThrows = false;
  const again = await run(put(tmpDoc("a.md", BODY)), be);
  assert.equal(again.code, 0, again.out);
  assert.equal(registries(be)[0].versions.at(-1).status, "live");
});

test("C1: an error on the FINAL attempt after earlier clean misses is still 'could not run' (chunks kept); only a clean final miss deletes", async () => {
  const be = createFakeBackend();
  const real = be.search.bind(be);
  let calls = 0;
  be.search = async () => { if (++calls <= 4) return []; throw new Error("opensearch 503"); };
  let r = await run(put(tmpDoc("a.md", BODY)), be);
  assert.equal(r.code, 3, r.out);
  assert.match(r.rows[0].message, /proof could not run/);
  assert.ok(be.room.size > 0);
  // a clean miss on every attempt: chunks ARE removed
  const be2 = createFakeBackend({ failSearch: true });
  r = await run(put(tmpDoc("a.md", BODY)), be2);
  assert.equal(r.code, 3, r.out);
  assert.match(r.rows[0].message, /its chunks were removed/);
  assert.equal(be2.room.size, 0);
  void real;
});

// ---------------- C2: the gateway proof ----------------
test("C2: a clean 'not in the top 10' miss STICKS as missing; a later transport error cannot overwrite it", async () => {
  let n = 0;
  const backend = { gatewayKbSearch: async () => { n++; if (n === 1) return { ok: true, matches: [{ path: "otchealthcommons/company-journal/_KNOWLEDGE/other.md" }] }; throw new TypeError("fetch failed"); } };
  const g = await verifyViaGateway(backend, { key: "_KNOWLEDGE/research/fleet/2026-09-29-x-abcd1234.md", brainId: "KN-RES-1234567890", title: "Some title here", contentSha: "a".repeat(64), retries: 2, delayMs: 0 });
  assert.equal(g.status, "missing", JSON.stringify(g));
  assert.match(g.reason, /not in the top 10/);
});

test("C2: a gateway ERROR fails the exit code (6) instead of a warning; skipped (no token) stays a warning; --gateway off stays an opt-out", async () => {
  let r = await run(put(tmpDoc("a.md", BODY)), createFakeBackend({ gatewayError: true }));
  assert.equal(r.code, EXIT.GATEWAY_UNPROVEN);
  assert.equal(r.rows[0].status, "gateway-unproven");
  r = await run(put(tmpDoc("a.md", BODY)), createFakeBackend({ gatewayThrows: true }));
  assert.equal(r.code, EXIT.GATEWAY_UNPROVEN);
  r = await run(put(tmpDoc("a.md", BODY)), createFakeBackend({ gatewaySkip: true }));
  assert.equal(r.code, 0, "not attempted: the room proof stands");
  assert.ok(r.rows[0].warnings.some((w) => /gateway proof skipped/.test(w)));
  r = await run(put(tmpDoc("a.md", BODY), ["--gateway", "off"]), createFakeBackend({ gatewayError: true }));
  assert.equal(r.code, 0);
});

test("C2: a gateway 'missing' still exits 3 and removes the chunks", async () => {
  const be = createFakeBackend({ gatewayMissing: true });
  const r = await run(put(tmpDoc("a.md", BODY)), be);
  assert.equal(r.code, 3, r.out);
  assert.equal(be.room.size, 0);
});

// ---------------- C3 ----------------
test("C3: --store-only exits with the DISTINCT non-zero code 5, and SKILL.md documents it", async () => {
  const be = createFakeBackend();
  const r = await run(put(tmpDoc("m.html", "<html><head><title>Widget mockup screen one</title></head><body>x</body></html>"), ["--kind", "design", "--store-only"]), be);
  assert.equal(r.code, 5, r.out);
  assert.equal(r.rows[0].exit, 5);
  assert.equal(be.calls.embed, 0);
  const skill = readFileSync(new URL("../SKILL.md", import.meta.url), "utf8");
  assert.match(skill, /\b5\b[^\n]*(store-only|NOT searchable)/i);
  assert.equal(combineExitCodes([0, 5]), 5);
  assert.equal(combineExitCodes([5, 6, 4]), 6);
  assert.equal(combineExitCodes([3, 5, 6]), 3);
});

test("C3: an --app correction with identical content is a NEW version that re-keys and re-pushes (was 'unchanged', exit 0)", async () => {
  const be = createFakeBackend();
  const f = tmpDoc("a.md", BODY);
  const first = await run(["put", f, "--kind", "research", "--app", "fleet", "--id", "app-correction", "--agent", "cto", "--json"], be);
  assert.equal(first.code, 0, first.out);
  const second = await run(["put", f, "--kind", "research", "--app", "growth", "--id", "app-correction", "--agent", "cto", "--json"], be);
  assert.equal(second.code, 0, second.out);
  assert.equal(second.rows[0].status, "saved");
  assert.match(second.rows[0].key, /\/growth\//);
  assert.notEqual(second.rows[0].key, first.rows[0].key);
  const reg = registries(be)[0];
  assert.equal(reg.live_key, second.rows[0].key);
  assert.equal(reg.app, "growth");
  assert.equal(be.s3.has(first.rows[0].key), false, "the old-app object left _KNOWLEDGE/");
  assert.equal([...be.room.values()].some((d) => d.path.includes(first.rows[0].key)), false);
});

test("C3: a corrected --source identity is a new version; a new commit sha alone is not", async () => {
  const be = createFakeBackend();
  const f = tmpDoc("a.md", BODY);
  const args = (src) => ["put", f, "--kind", "research", "--app", "fleet", "--id", "src-correction", "--source", src, "--agent", "cto", "--json"];
  assert.equal((await run(args("otchealth-cto@aaa111:docs/a.md"), be)).code, 0);
  const sameFile = await run(args("otchealth-cto@bbb222:docs/a.md"), be);
  assert.equal(sameFile.rows[0].status, "unchanged", "the commit sha is not part of the source identity");
  const moved = await run(args("otchealth-cto@bbb222:docs/moved.md"), be);
  assert.equal(moved.rows[0].status, "saved", moved.out);
  assert.match(be.s3.get(moved.rows[0].key).text, /source: "otchealth-cto@bbb222:docs\/moved\.md"/);
});

test("C3: an ALIAS records the new document's identity metadata (registry alias_of), zero-write on an identical repeat", async () => {
  const be = createFakeBackend();
  const f = tmpDoc("a.md", BODY);
  const a = await run(put(f), be);
  assert.equal(a.code, 0);
  const f2 = tmpDoc("copy.md", BODY); // a DIFFERENT file with identical content (the same file re-saved under a new title is a title correction, not an alias)
  const b = await run(put(f2, ["--title", "Beta title for the aliased copy"]), be);
  assert.equal(b.code, 0, b.out);
  assert.equal(b.rows[0].status, "alias");
  const regB = registries(be).find((r) => r.title === "Beta title for the aliased copy");
  assert.ok(regB, "the alias identity is recorded");
  assert.equal(regB.alias_of, a.rows[0].brain_id);
  assert.equal(regB.alias_key, a.rows[0].key);
  assert.equal(regB.app, "fleet");
  const puts = be.calls.put + be.calls.putCond;
  const again = await run(put(f2, ["--title", "Beta title for the aliased copy"]), be);
  assert.equal(again.rows[0].status, "alias");
  assert.equal(be.calls.put + be.calls.putCond, puts, "an identical repeat writes nothing");
});

test("C3: a FAILED retireOrphans exits non-zero (4) instead of a warning", async () => {
  const be = createFakeBackend({ failSearch: true });
  const first = await run(["put", tmpDoc("a.md", BODY), "--kind", "research", "--app", "fleet", "--id", "orphan-cleanup", "--agent", "cto", "--json"], be);
  assert.equal(first.code, 3, first.out);
  const orphanKey = first.rows[0].key;
  assert.ok(be.s3.has(orphanKey), "the failed attempt's object is still under _KNOWLEDGE/");
  be.fail.search = false;
  be.fail.delKeys.add(orphanKey);
  const second = await run(["put", tmpDoc("b.md", BODY.replace("planning", "roadmap")), "--kind", "research", "--app", "fleet", "--id", "orphan-cleanup", "--agent", "cto", "--json"], be);
  assert.equal(second.code, EXIT.SUPERSEDE_PENDING, second.out);
  assert.match(second.rows[0].message, /orphan cleanup is incomplete/);
});
