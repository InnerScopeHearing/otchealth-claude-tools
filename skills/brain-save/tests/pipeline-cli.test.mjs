import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { main, parseArgs } from "../brain-save.mjs";
import { combineExitCodes } from "../lib/errors.mjs";
import { _resetShapeCacheForTests } from "../lib/push.mjs";
import { createFakeBackend } from "./fake-backend.mjs";

process.env.BRAIN_SAVE_VERIFY_DELAY_MS = "0";
let STATE;
beforeEach(() => { STATE = mkdtempSync(join(tmpdir(), "bs-state-")); process.env.BRAIN_SAVE_STATE_DIR = STATE; _resetShapeCacheForTests(); });

function tmpDoc(name, text) {
  const d = mkdtempSync(join(tmpdir(), "bs-doc-"));
  const f = join(d, name);
  writeFileSync(f, text);
  return f;
}
async function run(argv, backend, needles = []) {
  const out = []; const err = [];
  const code = await main(argv, { backend, needles, now: new Date("2026-09-29T01:00:00Z") }, { stdout: (s) => out.push(s), stderr: (s) => err.push(s) });
  return { code, out: out.join("\n"), err: err.join("\n") };
}
const BODY = "# Brain save pipeline unit fixture\n\nThe synthetic fixture explains a harmless topic about widgets and gizmos.\n";
const knowledgeKeys = (be) => [...be.s3.keys()].filter((k) => k.startsWith("_KNOWLEDGE/"));

test("new document: saved, verified, registry live, by-hash alias, receipt; identical re-put is a no-op (zero writes, zero embeds)", async () => {
  const be = createFakeBackend();
  const f = tmpDoc("widgets.md", BODY);
  const r = await run(["put", f, "--kind", "research", "--app", "fleet", "--agent", "cto", "--json"], be);
  assert.equal(r.code, 0, r.out + r.err);
  const res = JSON.parse(r.out.split("\n")[0]);
  assert.equal(res.status, "saved");
  assert.equal(res.ranks.id, 1);
  assert.match(res.key, /^_KNOWLEDGE\/research\/fleet\/2026-09-29-brain-save-pipeline-unit-fixture-[0-9a-f]{8}\.md$/);
  assert.ok(be.s3.has(res.key));
  const reg = JSON.parse(be.s3.get(`_KNOWLEDGE-META/registry/${res.brain_id}.json`).text);
  assert.equal(reg.live_key, res.key);
  assert.equal(reg.versions[0].status, "live");
  const sha = createHash("sha256").update(BODY).digest("hex");
  assert.ok(be.s3.has(`_KNOWLEDGE-META/by-hash/${sha}.json`));
  assert.ok(readFileSync(join(STATE, "receipts.jsonl"), "utf8").includes(res.key));
  for (const k of ["status", "exit", "brain_id", "key", "version", "chunks", "ranks", "warnings"]) assert.ok(k in res, k);

  const before = { put: be.calls.put, putCond: be.calls.putCond, embed: be.calls.embed };
  const again = await run(["put", f, "--kind", "research", "--app", "fleet", "--agent", "cto", "--json"], be);
  assert.equal(again.code, 0);
  assert.equal(JSON.parse(again.out).status, "unchanged");
  assert.deepEqual({ put: be.calls.put, putCond: be.calls.putCond, embed: be.calls.embed }, before);
});

test("same content under a different identity is an alias (no new object)", async () => {
  const be = createFakeBackend();
  await run(["put", tmpDoc("a.md", BODY), "--kind", "research", "--app", "fleet", "--agent", "cto"], be);
  const n = knowledgeKeys(be).length;
  const r = await run(["put", tmpDoc("b.md", BODY), "--kind", "research", "--app", "fleet", "--title", "Another title for identical widget content", "--agent", "cto", "--json"], be);
  assert.equal(r.code, 0);
  assert.equal(JSON.parse(r.out).status, "alias");
  assert.equal(knowledgeKeys(be).length, n);
});

test("changed content: v2 saved and verified, THEN v1 superseded (chunks deleted, archived, registry)", async () => {
  const be = createFakeBackend();
  const f = tmpDoc("widgets.md", BODY);
  const v1 = JSON.parse((await run(["put", f, "--kind", "runbook", "--app", "fleet", "--agent", "cto", "--json"], be)).out);
  writeFileSync(f, BODY + "\nA second paragraph about gizmo calibration.\n");
  const r2 = await run(["put", f, "--kind", "runbook", "--app", "fleet", "--agent", "cto", "--json"], be);
  assert.equal(r2.code, 0, r2.out);
  const v2 = JSON.parse(r2.out);
  assert.equal(v2.version, 2);
  assert.equal(v2.brain_id, v1.brain_id);
  assert.equal(v2.superseded, v1.key);
  assert.ok(!be.s3.has(v1.key), "v1 moved out of _KNOWLEDGE/");
  assert.ok(be.s3.has(`_ARCHIVE/${v1.key}`));
  assert.equal([...be.room.values()].filter((d) => d.path.endsWith(v1.key)).length, 0, "v1 chunks deleted");
  assert.ok([...be.room.values()].some((d) => d.path.endsWith(v2.key)));
  const reg = JSON.parse(be.s3.get(`_KNOWLEDGE-META/registry/${v1.brain_id}.json`).text);
  assert.equal(reg.live_key, v2.key);
  assert.equal(reg.versions.find((v) => v.key === v1.key).status, "superseded");
  assert.match(be.s3.get(v2.key).text, new RegExp(`^supersedes: "${v1.key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"$`, "m"));
});

test("verify failure: exit 3, the new version's chunks are removed, the old version stays live and untouched; a re-run retries", async () => {
  const be = createFakeBackend();
  const f = tmpDoc("widgets.md", BODY);
  const v1 = JSON.parse((await run(["put", f, "--kind", "doc", "--app", "fleet", "--title", "Widget calibration notes for fleet", "--agent", "cto", "--json"], be)).out);
  writeFileSync(f, BODY + "\nchanged text\n");
  be.fail.search = true;
  const r = await run(["put", f, "--kind", "doc", "--app", "fleet", "--title", "Widget calibration notes for fleet", "--agent", "cto", "--json"], be);
  assert.equal(r.code, 3);
  const bad = JSON.parse(r.out);
  assert.equal(bad.status, "not-searchable");
  assert.equal([...be.room.values()].filter((d) => d.path.endsWith(bad.key)).length, 0, "no half-searchable doc remains");
  assert.ok(be.s3.has(v1.key), "old version not superseded when the new one failed to verify");
  let reg = JSON.parse(be.s3.get(`_KNOWLEDGE-META/registry/${v1.brain_id}.json`).text);
  assert.equal(reg.live_key, v1.key);
  assert.equal(reg.versions.at(-1).status, "stored-unverified");
  be.fail.search = false;
  const retry = await run(["put", f, "--kind", "doc", "--app", "fleet", "--title", "Widget calibration notes for fleet", "--agent", "cto", "--json"], be);
  assert.equal(retry.code, 0, retry.out);
  assert.equal(JSON.parse(retry.out).key, bad.key);
  reg = JSON.parse(be.s3.get(`_KNOWLEDGE-META/registry/${v1.brain_id}.json`).text);
  assert.equal(reg.live_key, bad.key);
});

test("supersede failure: exit 4 with supersede_pending recorded", async () => {
  const be = createFakeBackend();
  const f = tmpDoc("widgets.md", BODY);
  const v1 = JSON.parse((await run(["put", f, "--kind", "doc", "--app", "fleet", "--title", "Widget supersede failure case", "--agent", "cto", "--json"], be)).out);
  be.fail.delKeys.add(v1.key);
  writeFileSync(f, BODY + "\nv2\n");
  const r = await run(["put", f, "--kind", "doc", "--app", "fleet", "--title", "Widget supersede failure case", "--agent", "cto", "--json"], be);
  assert.equal(r.code, 4, r.out);
  const reg = JSON.parse(be.s3.get(`_KNOWLEDGE-META/registry/${v1.brain_id}.json`).text);
  assert.equal(reg.supersede_pending, true);
});

test("a registry ETag conflict is retried once", async () => {
  const be = createFakeBackend({ putCondConflicts: 1 });
  const r = await run(["put", tmpDoc("w.md", BODY), "--kind", "doc", "--app", "fleet", "--title", "Widget etag conflict case", "--agent", "cto"], be);
  assert.equal(r.code, 0, r.out + r.err);
});

test("--dry-run runs every gate and makes zero writes and zero embedding calls", async () => {
  const be = createFakeBackend();
  const r = await run(["put", tmpDoc("w.md", BODY), "--kind", "doc", "--app", "fleet", "--title", "Widget dry run case", "--dry-run", "--json"], be);
  assert.equal(r.code, 0);
  assert.equal(JSON.parse(r.out).status, "planned");
  assert.equal(be.calls.put + be.calls.putCond + be.calls.embed + be.calls.pushDocs, 0);
  assert.equal(be.s3.size, 0);
});

test("secret refusal: exit 2, nothing written anywhere, nothing embedded, output never has the value; refusal recorded locally", async () => {
  const be = createFakeBackend();
  const secret = createHash("sha256").update("fixture-secret").digest("hex").slice(0, 32);
  const f = tmpDoc("w.md", `# Widget secret leak case\n\nthe token is ${secret} oops\n`);
  const r = await run(["put", f, "--kind", "doc", "--app", "fleet", "--agent", "cto"], be, [{ name: "vendor-api-token", needle: secret }]);
  assert.equal(r.code, 2);
  assert.match(r.out, /REFUSED \(secret\)/);
  assert.match(r.out, /vendor-api-token/);
  assert.ok(!r.out.includes(secret) && !r.err.includes(secret));
  assert.equal(be.s3.size, 0);
  assert.equal(be.calls.embed, 0);
  assert.ok(existsSync(join(STATE, "refused.jsonl")));
  assert.ok(!readFileSync(join(STATE, "refused.jsonl"), "utf8").includes(secret));
});

test("ring refusals: --ring finance (cfo-store route), a privilege banner (CLO route), a labeled SSN (PHI)", async () => {
  const be = createFakeBackend();
  const f = tmpDoc("w.md", BODY);
  let r = await run(["put", f, "--kind", "doc", "--app", "fleet", "--title", "Widget ring case", "--ring", "finance"], be);
  assert.equal(r.code, 2); assert.match(r.out, /cfo-store/);
  r = await run(["put", tmpDoc("p.md", "# Widget privileged memo case\n\nATTORNEY-CLIENT PRIVILEGED\n\ntext\n"), "--kind", "doc", "--app", "fleet"], be);
  assert.equal(r.code, 2); assert.match(r.out, /legal_blob_put/);
  r = await run(["put", tmpDoc("s.md", "# Widget intake case\n\nSSN: 212-45-6789\n"), "--kind", "doc", "--app", "fleet"], be);
  assert.equal(r.code, 2); assert.match(r.out, /BAA environment/);
  assert.equal(be.s3.size, 0);
});

test("folder: exit-code precedence (refused beats saved) and every supported file is handled; generic titles are exit 1", async () => {
  const be = createFakeBackend();
  const d = mkdtempSync(join(tmpdir(), "bs-folder-"));
  writeFileSync(join(d, "good.md"), "# Widget folder good doc\n\nfine text\n");
  writeFileSync(join(d, "bad.md"), "# Widget folder bad doc\n\nPRIVILEGED AND CONFIDENTIAL\n");
  writeFileSync(join(d, "page.html"), "<html><head><title>Widget folder html page</title></head><body><h1>Widget folder html page</h1><p>Prose.</p><script>x()</script></body></html>");
  writeFileSync(join(d, "image.png"), "not a doc");
  mkdirSync(join(d, "repo-copy", ".git"), { recursive: true });
  writeFileSync(join(d, "repo-copy", "inner.md"), "# should be skipped\n");
  writeFileSync(join(d, ".brain-save-ignore"), "ignored-*.md\n");
  writeFileSync(join(d, "ignored-one.md"), "# Widget ignored doc\n");
  const r = await run(["put", d, "--kind", "auto", "--app", "fleet", "--agent", "cto", "--json"], be);
  assert.equal(r.code, 2);
  const rows = r.out.split("\n").map((l) => JSON.parse(l));
  assert.equal(rows.length, 3, JSON.stringify(rows.map((x) => x.file)));
  assert.deepEqual(rows.map((x) => x.status).sort(), ["refused", "saved", "saved"]);
  const html = rows.find((x) => x.file.endsWith("page.html"));
  assert.ok(be.s3.has(html.key));
  assert.ok([...be.s3.keys()].some((k) => k.startsWith("_KNOWLEDGE-META/src/") && k.endsWith(".html")), "raw HTML kept under the never-indexed meta prefix");
  assert.ok(!be.s3.get(html.key).text.includes("x()"));
  const g = await run(["put", tmpDoc("README.md", "# README\n\ntext about widgets and gizmos\n"), "--kind", "doc", "--app", "fleet"], be);
  assert.equal(g.code, 1);
  assert.match(g.out, /too generic/);
  assert.equal(combineExitCodes([0, 4, 1, 3]), 3);
  assert.equal(combineExitCodes([0, 4, 1]), 1);
  assert.equal(combineExitCodes([0, 4]), 4);
});

test("--store-only keeps raw bytes under _KNOWLEDGE-META/src/, registry searchable:false, nothing embedded", async () => {
  const be = createFakeBackend();
  const r = await run(["put", tmpDoc("mock.html", "<html><head><title>Widget mockup screen one</title></head><body>x</body></html>"), "--kind", "design", "--app", "fleet", "--store-only", "--json"], be);
  // Round 4 (C3): stored-only is a DISTINCT non-zero exit (5): "stored, NOT searchable by request".
  assert.equal(r.code, 5, r.out);
  const res = JSON.parse(r.out);
  assert.equal(res.status, "stored-only");
  assert.equal(res.exit, 5);
  assert.equal(be.calls.embed, 0);
  assert.equal(knowledgeKeys(be).length, 0);
  const reg = JSON.parse(be.s3.get(`_KNOWLEDGE-META/registry/${res.brain_id}.json`).text);
  assert.equal(reg.versions[0].searchable, false);
});

test("--gateway on with a missing gateway hit is exit 3; auto with no token is a warning only", async () => {
  let be = createFakeBackend({ gatewayMissing: true });
  let r = await run(["put", tmpDoc("w.md", BODY), "--kind", "doc", "--app", "fleet", "--title", "Widget gateway missing case", "--gateway", "on", "--json"], be);
  assert.equal(r.code, 3, r.out);
  be = createFakeBackend({ gatewaySkip: true });
  r = await run(["put", tmpDoc("w.md", BODY), "--kind", "doc", "--app", "fleet", "--title", "Widget gateway skip case", "--json"], be);
  assert.equal(r.code, 0, r.out);
  assert.ok(JSON.parse(r.out).warnings.some((w) => /gateway proof skipped/.test(w)));
});

test("retract: out of search, archived, registry retracted; list and audit", async () => {
  const be = createFakeBackend();
  const res = JSON.parse((await run(["put", tmpDoc("w.md", BODY), "--kind", "doc", "--app", "fleet", "--title", "Widget retract case", "--json"], be)).out);
  let l = await run(["list", "--check"], be);
  assert.equal(l.code, 0); assert.match(l.out, /1 document\(s\), 0 dark/);
  const a = await run(["audit"], be);
  assert.equal(a.code, 0, a.out); assert.match(a.out, /0 finding/);
  const r = await run(["retract", res.brain_id, "--reason", "test retraction"], be);
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal(be.room.size, 0);
  assert.ok(be.s3.has(`_ARCHIVE/${res.key}`));
  const reg = JSON.parse(be.s3.get(`_KNOWLEDGE-META/registry/${res.brain_id}.json`).text);
  assert.equal(reg.status, "retracted");
});

test("audit finds a secret in stored output (layer C) and a dark doc", async () => {
  const be = createFakeBackend();
  be.s3.set("_KNOWLEDGE/doc/fleet/2026-09-29-x-00000000.md", { text: "---\nbrain_id: \"KN-DOC-x\"\n---\n# x\n\nleaked VALUE123abcDEF456ghi\n", etag: '"1"' });
  const r = await main(["audit"], { backend: be, needles: [{ name: "vendor-key", needle: "VALUE123abcDEF456ghi" }] }, { stdout: () => {}, stderr: () => {} });
  assert.equal(r, 2);
  const out = [];
  await main(["audit", "--searchable"], { backend: be, needles: [] }, { stdout: (s) => out.push(s), stderr: () => {} });
  assert.match(out.join("\n"), /FINDING dark/);
});

test("parseArgs: value flags per command, boolean flags, --x=y form", () => {
  assert.deepEqual(parseArgs(["put", "a.md", "--kind", "research", "--dry-run", "--app=fleet"]), { cmd: "put", pos: ["a.md"], flags: { "--kind": "research", "--dry-run": true, "--app": "fleet" } });
  assert.deepEqual(parseArgs(["audit", "--ring", "--secrets"]).flags, { "--ring": true, "--secrets": true });
  assert.throws(() => parseArgs(["put", "a.md", "--kind"]), /needs a value/);
});

test("verify round 1: a failed first attempt (exit 3) is retired, not resurrected, once a newer version of the same identity is live", async () => {
  const be = createFakeBackend();
  const args = (f) => ["put", f, "--kind", "research", "--app", "fleet", "--id", "orphan-drill", "--agent", "cto", "--json"];
  be.fail.embed = true;
  const r1 = await run(args(tmpDoc("o1.md", "# Orphan drill title for the failed attempt\n\nFirst body.\n")), be);
  assert.equal(r1.code, 3);
  const k1 = JSON.parse(r1.out.split("\n")[0]).key;
  assert.ok(be.s3.has(k1), "the failed attempt's object is stored (retryable)");
  be.fail.embed = false;
  const r2 = await run(args(tmpDoc("o2.md", "# Orphan drill title for the failed attempt\n\nSecond, different body.\n")), be);
  assert.equal(r2.code, 0, r2.out + r2.err);
  const k2 = JSON.parse(r2.out.split("\n")[0]).key;
  assert.notEqual(k1, k2);
  assert.equal(be.s3.has(k1), false, "orphan object removed from the indexable _KNOWLEDGE/ prefix");
  assert.ok(be.s3.has(`_ARCHIVE/${k1}`), "orphan kept in the archive");
  const reg = JSON.parse(be.s3.get(`_KNOWLEDGE-META/registry/${JSON.parse(r2.out.split("\n")[0]).brain_id}.json`).text);
  assert.equal(reg.versions.find((v) => v.key === k1).status, "abandoned");
  assert.equal(reg.live_key, k2);
});
