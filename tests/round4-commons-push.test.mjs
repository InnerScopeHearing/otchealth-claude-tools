// Adjudication round 4 (2026-09-29): the commons push path. S1 (content gate), S2 (reviewed prefix allow-set,
// all of _JOURNAL/ + _VAULT/ never-push), N2 (normalized + case-folded skip), N3 (a `_count` reply without a
// number is never 0), N4 (--prefixes needs a value), C4 (nightly.sh failure isolation, chunked embed-failed
// exit), C5 (every due object, not only the newest), plus the indexer nits (dry-run creates nothing,
// --require-live-object fails closed after selection, --azure + --require-live-object is refused).
//
// The indexer tests run the REAL indexer.mjs CLI in a subprocess against an in-memory fake of S3, OpenSearch,
// OpenAI embeddings and SSM (tests/helpers/). No test here can reach a real service.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, existsSync, copyFileSync, chmodSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as PR from "../skills/doc-indexer/push-rules.mjs";
import * as CANARY from "../skills/aws-dr-canary/canary.mjs";
import * as PURGE from "../skills/doc-indexer/purge-ring-residue.mjs";
// Namespace imports + `need`: on the round-3 code a not-yet-existing export makes THAT test fail (with a clear
// message) instead of the whole file failing to load, so each test's fail-on-old-code status is individually visible.
const need = (mod, name) => (...a) => { if (typeof mod[name] !== "function") throw new Error(`export ${name} does not exist on the round-3 code`); return mod[name](...a); };
const { isSkippedPath, selectPushRows, RING_PRIVATE_PREFIXES } = PR;
const commonsPrefixRefusal = need(PR, "commonsPrefixRefusal"), commonsScopeRefusal = need(PR, "commonsScopeRefusal"), extractScopeArgs = need(PR, "extractScopeArgs"), normalizeRelPath = need(PR, "normalizeRelPath"), pathPrefixQuery = need(PR, "pathPrefixQuery");
const strictCount = need(CANARY, "strictCount"), pickDueObjects = need(CANARY, "pickDueObjects"), assessDueObjects = need(CANARY, "assessDueObjects"), pickNewestDueObject = CANARY.pickNewestDueObject;
const countOf = need(PURGE, "countOf"), prefixQuery = PURGE.prefixQuery;
const G = await import("../skills/doc-indexer/commons-push-gate.mjs").catch(() => ({}));
const createCommonsGate = need(G, "createCommonsGate"), gateCommonsRow = need(G, "gateCommonsRow"), loadCommonsNeedles = need(G, "loadCommonsNeedles"), formatCommonsBlock = need(G, "formatCommonsBlock");
const CommonsGateUnavailable = G.CommonsGateUnavailable || class MissingClass {};
import { runIndexer, catalogScenario, knowledgeObject, syntheticSsm } from "./helpers/indexer-harness.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SECRET = "Zq8Kd93LmNpQr7Xy2vWb5Tg4";
const CLEAN = "# Widget planning notes\n\nOrdinary engineering prose about widget sprockets and gizmos, long enough to be real text.\n";
const KEY = (n, h) => `_KNOWLEDGE/research/fleet/2026-09-29-${n}-${h}.md`;
const COMMONS = ["push-search", "--profile", "commons", "--s3", "--prefixes", "_KNOWLEDGE/,_DAILY/", "--require-live-object"];
const embedded = (r) => r.log.filter((l) => l.type === "embed");
const bulked = (r) => r.log.filter((l) => l.type === "bulk").flatMap((l) => l.paths);

// ---------------- S2 / N2: pure rules ----------------
test("S2: only _KNOWLEDGE/ and _DAILY/ are accepted commons prefixes; anything else (wider, sibling, case variant) is refused", () => {
  assert.deepEqual([...PR.COMMONS_PUSH_ALLOWED_PREFIXES], ["_KNOWLEDGE/", "_DAILY/"]);
  assert.equal(commonsPrefixRefusal(["_KNOWLEDGE/", "_DAILY/"]), "");
  assert.equal(commonsPrefixRefusal("_KNOWLEDGE/"), "");
  assert.equal(commonsPrefixRefusal([]), "", "an empty allow-list selects nothing");
  for (const bad of ["_", "_RESEARCH/", "_JOURNAL/", "_knowledge/", "_KNOWLEDGE", "_KNOWLEDGE/research/", "_DAILY/,_NOTION/", "_KNOWLEDGE/,../"]) {
    assert.match(commonsPrefixRefusal(bad), /refusing commons push-search prefix/, JSON.stringify(bad));
  }
  assert.match(commonsScopeRefusal("commons", ["_RESEARCH/"]), /_RESEARCH\//);
  assert.match(commonsScopeRefusal("commons", null), /UNSCOPED/);
  assert.equal(commonsScopeRefusal("finance", ["_anything/"]), "", "other rooms keep their legacy scoping");
});

test("S2: ALL of _JOURNAL/ and _VAULT/ are never-push (the per-lane list is gone); every ring-private prefix is skipped", () => {
  assert.deepEqual([...RING_PRIVATE_PREFIXES].sort(), ["_DISPATCH/", "_HANDOFF/", "_JOURNAL/", "_MEMORY/", "_VAULT/"]);
  for (const lane of ["cto", "coo", "developer", "cfo", "clo-personal"]) assert.equal(isSkippedPath(`_JOURNAL/${lane}/2026-09-29/_DIGEST.md`), true, lane);
  assert.equal(isSkippedPath("_VAULT/registry.md"), true);
});

test("N2: the skip check normalizes (leading /, ./, //, .. segments) and case-folds before prefix matching", () => {
  for (const p of ["/_MEMORY/x.md", "./_MEMORY/x.md", "_MEMORY//x.md", "_memory/x.md", "_Memory/x.md", "_KNOWLEDGE/../_MEMORY/x.md", "//_journal/cto/x.md", "_KNOWLEDGE-META/registry/x.json", "_knowledge-meta/x", "_ARCHIVE/y", "_TEXT/y"]) assert.equal(isSkippedPath(p), true, p);
  for (const p of ["_KNOWLEDGE/research/fleet/x.md", "_DAILY/2026-09-29.md", "_NOTION/page.md"]) assert.equal(isSkippedPath(p), false, p);
  assert.equal(normalizeRelPath("/a//b/./c/../d"), "a/b/d");
  // selection: the allow-list matches the path AS STORED and case-sensitively; spelling variants never ride in
  const rows = ["_KNOWLEDGE/a.md", "/_KNOWLEDGE/b.md", "_KNOWLEDGE//c.md", "_knowledge/d.md", "_DAILY/e.md", "_KNOWLEDGE/../_MEMORY/f.md"].map((path) => ({ path }));
  assert.deepEqual(selectPushRows(rows, ["_KNOWLEDGE/", "_DAILY/"]).map((r) => r.path), ["_KNOWLEDGE/a.md", "_DAILY/e.md"]);
});

// ---------------- N4: --prefixes needs a value ----------------
test("N4: extractScopeArgs never swallows the next flag and never runs unscoped on a bad --prefixes", () => {
  for (const argv of [["push-search", "--prefixes"], ["push-search", "--prefixes", "--s3"], ["push-search", "--prefix", "--dry-run"], ["x", "--s3", "--prefixes"]]) {
    assert.match(extractScopeArgs(argv).error, /needs a value/, JSON.stringify(argv));
  }
  assert.deepEqual(extractScopeArgs(["push-search", "--prefixes", "_KNOWLEDGE/,_DAILY/", "--s3"]), { argv: ["push-search", "--s3"], prefixes: "_KNOWLEDGE/,_DAILY/", prefix: "", error: "" });
  assert.equal(extractScopeArgs(["push-search", "--prefixes=_KNOWLEDGE/"]).prefixes, "_KNOWLEDGE/", "the = form is honored, not silently ignored");
  assert.equal(extractScopeArgs(["push-search", "--s3"]).prefixes, null);
});

test("N4: the real CLI exits 2 with no I/O on `--prefixes` last, `--prefixes --s3`, a disallowed prefix, and --azure + --require-live-object", () => {
  for (const [args, re] of [
    [["push-search", "--profile", "commons", "--s3", "--prefixes"], /--prefixes needs a value/],
    [["push-search", "--profile", "commons", "--prefixes", "--s3"], /--prefixes needs a value/],
    [["push-search", "--profile", "commons", "--s3", "--prefixes", "_KNOWLEDGE/,_RESEARCH/"], /refusing commons push-search prefix\(es\) \[_RESEARCH\/\]/],
    [["push-search", "--profile", "commons", "--s3", "--prefixes", "_"], /refusing commons push-search prefix/],
    [["push-search", "--profile", "commons", "--azure", "--prefixes", "_KNOWLEDGE/", "--require-live-object"], /only enforced on the s3 storage backend/],
    [["push-search", "--profile", "finance", "--azure", "--require-live-object"], /only enforced on the s3 storage backend/],
  ]) {
    const r = runIndexer(args, catalogScenario([]));
    assert.equal(r.code, 2, `${args.join(" ")}\n${r.stderr}`);
    assert.match(r.stderr, re);
    assert.equal(r.log.length, 0, `refused before ANY I/O (ssm/s3/opensearch/embedding): ${JSON.stringify(r.log)}`);
  }
});

// ---------------- S1: the content gate ----------------
test("S1: gateCommonsRow blocks secrets (layer A shape and layer B value), ring signals, and unproven _KNOWLEDGE/ rows; never carries a value", () => {
  const needles = [{ name: "/otchealth/widget-live-token", needle: SECRET }];
  const good = KEY("good-doc", "aaaaaaaa");
  assert.equal(gateCommonsRow({ path: good, text: knowledgeObject(good, CLEAN), needles }).ok, true);
  assert.equal(gateCommonsRow({ path: "_DAILY/2026-09-29.md", text: "# Digest\n\nShipped widgets today and wrote some notes about them.\n", needles }).ok, true);
  const sec = gateCommonsRow({ path: good, text: knowledgeObject(good, `${CLEAN}\nToken: ${SECRET}\n`), needles });
  assert.equal(sec.ok, false);
  assert.ok(sec.reasons.some((r) => r.kind === "secret" && r.rules.includes("layer-B:/otchealth/widget-live-token")));
  const line = formatCommonsBlock(good, sec.reasons);
  assert.ok(line.includes(good) && !line.includes(SECRET), "path + rule name only");
  const ring = gateCommonsRow({ path: good, text: knowledgeObject(good, `ATTORNEY-CLIENT PRIVILEGED\n\n${CLEAN}`), needles });
  assert.ok(ring.reasons.some((r) => r.kind === "ring" && r.rules.includes("BANNER")));
  const noProv = gateCommonsRow({ path: good, text: CLEAN, needles });
  assert.deepEqual(noProv.reasons.map((r) => r.rules[0]), ["no-brain-save-provenance"]);
  assert.ok(gateCommonsRow({ path: "_KNOWLEDGE/notes.md", text: knowledgeObject(good, CLEAN), needles }).reasons.some((r) => r.rules.includes("not-a-brain-save-key")), "a hand-dropped _KNOWLEDGE/ key");
  assert.ok(gateCommonsRow({ path: good, text: knowledgeObject(good, CLEAN, { saved_by: "someone else" }), needles }).reasons.some((r) => r.rules.includes("no-brain-save-provenance")));
  // an encoded secret in the sidecar is caught too (S4 through the same gate)
  assert.equal(gateCommonsRow({ path: "_DAILY/x.md", text: `# Digest\n\nblob ${Buffer.from(`k:${SECRET}`).toString("base64")}\n`, needles }).ok, false);
});

test("S1: the gate refuses to exist without needles (never fail open); loadCommonsNeedles maps every loader failure to CommonsGateUnavailable (exit 2)", async () => {
  assert.throws(() => createCommonsGate({ needles: [] }), CommonsGateUnavailable);
  assert.throws(() => createCommonsGate({}), CommonsGateUnavailable);
  for (const loader of [async () => { throw new Error("SSM enumeration failed"); }, async () => ({ needles: [] }), async () => [], async () => null]) {
    await assert.rejects(() => loadCommonsNeedles({ loader }), (e) => e instanceof CommonsGateUnavailable && e.exit === 2 && /could not be loaded/.test(e.message));
  }
  assert.equal((await loadCommonsNeedles({ loader: async () => ({ needles: [{ name: "n", needle: "x".repeat(20) }] }) })).length, 1);
  const g = createCommonsGate({ needles: [{ name: "/otchealth/widget-live-token", needle: SECRET }], log: () => {} });
  assert.equal(g.allow("_DAILY/ok.md", "# Digest\n\nordinary notes about widgets and sprockets today.\n"), true);
  assert.equal(g.exitCode(), 0);
  assert.equal(g.allow("_DAILY/bad.md", `# Digest\n\nSECRET=${SECRET}\n`), false);
  assert.equal(g.exitCode(), 1, "a blocked row makes the run exit non-zero");
  assert.equal(g.state.blocked, 1);
});

test("S1 (real indexer.mjs): secret / privileged / forged rows are skipped BEFORE embedding, logged by path and rule only, and the run exits non-zero", () => {
  const good = KEY("good-doc", "aaaaaaaa"), forged = KEY("forged-doc", "bbbbbbbb"), sec = KEY("secret-doc", "cccccccc"), priv = KEY("priv-doc", "dddddddd");
  const sc = catalogScenario([
    { path: good, sidecar: knowledgeObject(good, CLEAN) },
    { path: "_DAILY/2026-09-29.md", sidecar: "# Daily digest\n\nShipped a widget today; nothing else of note happened here at all.\n" },
    { path: forged, sidecar: CLEAN },
    { path: sec, sidecar: knowledgeObject(sec, `${CLEAN}\nDeploy token: ${SECRET}\n`) },
    { path: priv, sidecar: knowledgeObject(priv, `ATTORNEY-CLIENT PRIVILEGED\n\nPatient SSN: 512-34-6789.\n${CLEAN}`) },
  ], { secret: SECRET });
  const r = runIndexer(COMMONS, sc);
  assert.equal(r.code, 1, r.stderr);
  assert.deepEqual([...new Set(bulked(r))].sort(), [`otchealthcommons/company-journal/${good}`, "otchealthcommons/company-journal/_DAILY/2026-09-29.md"].sort(), "only the two clean rows reached the room");
  const texts = embedded(r).flatMap((e) => e.texts).join("|");
  assert.equal(embedded(r).reduce((n, e) => n + e.n, 0), 2, "exactly two chunks were embedded: the blocked rows never reached the OpenAI processor");
  assert.ok(!/SSN|ATTORNEY|Deploy token/.test(texts));
  assert.match(r.stderr, new RegExp(`BLOCKED by the commons content gate -- ${sec}: secret \\[[^\\]]*layer-B:widget-live-token\\]`));
  assert.match(r.stderr, new RegExp(`${priv}: ring \\[BANNER, PHI_DATA\\]`));
  assert.match(r.stderr, new RegExp(`${forged}: provenance \\[no-brain-save-provenance\\]`));
  assert.match(r.stderr, /3 blocked/);
  for (const stream of [r.stdout, r.stderr, JSON.stringify(r.log)]) assert.ok(!stream.includes(SECRET), "the secret value never appears anywhere");
});

test("S1 (real indexer.mjs): a clean run exits 0; secret needles that cannot be loaded refuse the WHOLE push (exit 2) before any S3 read or embedding", () => {
  const good = KEY("good-doc", "aaaaaaaa");
  const rows = [{ path: good, sidecar: knowledgeObject(good, CLEAN) }, { path: "_DAILY/2026-09-29.md", sidecar: "# Daily digest\n\nShipped a widget today; nothing else of note happened here at all.\n" }];
  const ok = runIndexer(COMMONS, catalogScenario(rows));
  assert.equal(ok.code, 0, ok.stderr);
  assert.match(ok.stderr, /2 row\(s\) checked, 0 blocked/);
  const refused = runIndexer(COMMONS, { ...catalogScenario(rows), ssm: [] });
  assert.equal(refused.code, 2, refused.stderr);
  assert.match(refused.stderr, /live secret-value set could not be loaded/);
  assert.equal(refused.log.filter((l) => l.type === "embed" || l.type === "bulk" || String(l.type).startsWith("s3")).length, 0, "nothing read, embedded or written");
  const tiny = runIndexer(COMMONS, { ...catalogScenario(rows), ssm: syntheticSsm().slice(0, 5) });
  assert.equal(tiny.code, 2, "a truncated enumeration is refused too");
  assert.equal(tiny.log.filter((l) => l.type === "embed" || l.type === "bulk").length, 0);
});

// ---------------- indexer nits ----------------
test("nit (real indexer.mjs): --dry-run never creates or alters the index, and reports what the gate would block", () => {
  const good = KEY("good-doc", "aaaaaaaa"), sec = KEY("secret-doc", "cccccccc");
  const rows = [{ path: good, sidecar: knowledgeObject(good, CLEAN) }, { path: sec, sidecar: knowledgeObject(sec, `${CLEAN}\nDeploy token: ${SECRET}\n`) }];
  for (const shape of ["absent", "unknown"]) {
    const r = runIndexer([...COMMONS, "--dry-run"], { ...catalogScenario(rows, { secret: SECRET }), osShape: shape });
    assert.equal(r.log.filter((l) => l.type === "os-create" || l.type === "os-mapping-put").length, 0, `shape ${shape}: nothing created or altered`);
    assert.equal(r.log.filter((l) => l.type === "embed" || l.type === "bulk").length, 0);
    assert.match(r.stdout + r.stderr, /would push: _KNOWLEDGE\/research\/fleet\/2026-09-29-good-doc-aaaaaaaa\.md/);
    assert.match(r.stderr, /BLOCKED by the commons content gate/);
    assert.equal(r.code, 1, "a would-be block is a non-zero dry run too");
  }
  const chunked = runIndexer([...COMMONS, "--dry-run"], catalogScenario([rows[0]]));
  assert.equal(chunked.code, 0, chunked.stderr);
  assert.match(chunked.stdout, /would push 1 new document/);
  assert.equal(chunked.log.filter((l) => l.type === "embed" || l.type === "bulk").length, 0);
});

test("nit (real indexer.mjs): a non-404 HEAD error fails the run CLOSED after selection: nothing embedded, nothing written, clear message", () => {
  const a = KEY("good-doc", "aaaaaaaa"), b = KEY("other-doc", "eeeeeeee");
  const sc = catalogScenario([{ path: a, sidecar: knowledgeObject(a, CLEAN) }, { path: b, sidecar: knowledgeObject(b, CLEAN) }]);
  sc.s3Status = { [b]: 500 };
  const r = runIndexer(COMMONS, sc);
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.stderr, /could not confirm 1 source object\(s\).*FAILED CLOSED after selection.*nothing was embedded, nothing was written/s);
  assert.match(r.stderr, new RegExp(b));
  assert.equal(r.log.filter((l) => l.type === "embed" || l.type === "bulk").length, 0, "no partial write: the healthy row was not pushed either");
  // a genuine 404 (source gone) is skipped, not an error
  const gone = catalogScenario([{ path: a, sidecar: knowledgeObject(a, CLEAN) }, { path: b, sidecar: knowledgeObject(b, CLEAN), object: false }]);
  const r2 = runIndexer(COMMONS, gone);
  assert.equal(r2.code, 0, r2.stderr);
  assert.deepEqual([...new Set(bulked(r2))], [`otchealthcommons/company-journal/${a}`]);
  assert.match(r2.stdout, /1 gone-source skipped/);
});

test("C4 (real indexer.mjs): a document that failed to embed makes the chunked push exit non-zero", () => {
  const a = KEY("good-doc", "aaaaaaaa");
  const r = runIndexer(COMMONS, { ...catalogScenario([{ path: a, sidecar: knowledgeObject(a, CLEAN) }]), embedFail: true });
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.stderr, /failed to embed and were NOT pushed/);
  assert.equal(bulked(r).length, 0);
});

// ---------------- C4: nightly.sh ----------------
function runNightly({ pushExit, env = {} }) {
  const root = mkdtempSync(join(tmpdir(), "nightly-"));
  const log = join(root, "steps.log");
  writeFileSync(log, "");
  const stub = (rel, body) => { const p = join(root, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, `import { appendFileSync } from "node:fs";\nconst a = process.argv.slice(2).join(" ");\nappendFileSync(${JSON.stringify(log)}, ${JSON.stringify(rel)} + " " + a + "\\n");\n${body || ""}\n`); };
  stub("skills/daily-digest/digest.mjs");
  stub("skills/cfo-store/store.mjs");
  stub("skills/vault-sync/vault-registry.mjs");
  stub("skills/doc-indexer/indexer.mjs", `if (a.startsWith("push-search")) process.exit(${pushExit});`);
  stub("skills/doc-indexer/enrich.mjs");
  stub("skills/kb-memory/semantic.mjs");
  stub("setup/heartbeat.mjs");
  stub("setup/image-drift.mjs");
  stub("setup/drift-recon.mjs");
  mkdirSync(join(root, "skills/doc-indexer/job"), { recursive: true });
  copyFileSync(join(ROOT, "skills/doc-indexer/job/nightly.sh"), join(root, "skills/doc-indexer/job/nightly.sh"));
  chmodSync(join(root, "skills/doc-indexer/job/nightly.sh"), 0o755);
  const r = spawnSync("sh", [join(root, "skills/doc-indexer/job/nightly.sh")], { env: { PATH: process.env.PATH, HOME: root, ...env }, encoding: "utf8", timeout: 30000 });
  return { code: r.status, out: r.stdout + r.stderr, steps: readFileSync(log, "utf8").split("\n").filter(Boolean) };
}
test("C4: a failed commons push does NOT abort the remaining nightly steps, and the job exits non-zero at the end", () => {
  const r = runNightly({ pushExit: 3, env: { COMMONS_PUSH_PREFIXES: "_KNOWLEDGE/,_DAILY/" } });
  assert.equal(r.code, 3, r.out);
  assert.ok(r.steps.some((s) => s.startsWith("skills/doc-indexer/indexer.mjs push-search")), "the push ran");
  assert.ok(r.steps.some((s) => s.startsWith("skills/kb-memory/semantic.mjs")), "the memory reindex still ran");
  assert.ok(r.steps.some((s) => s.startsWith("setup/heartbeat.mjs")), "the fleet watcher still ran");
  assert.ok(r.steps.some((s) => /skills\/cfo-store\/store\.mjs.*_FLEET-WATCH/.test(s)), "the fleet-watch stage still ran");
  assert.match(r.out, /commons push-search FAILED \(exit 3\)/);
  assert.match(r.out, /FAILED: the commons push-search exited 3/);
  assert.ok(!/done: /.test(r.out), "no 'done' line on a failed run");
});
test("C4: arming is unambiguous (SKIP_PUSH_SEARCH=1 skips, unset prefixes skip, both skips name BOTH arming controls); a healthy push exits 0", () => {
  const skip = runNightly({ pushExit: 9, env: { SKIP_PUSH_SEARCH: "1", COMMONS_PUSH_PREFIXES: "_KNOWLEDGE/,_DAILY/" } });
  assert.equal(skip.code, 0, skip.out);
  assert.ok(!skip.steps.some((s) => s.includes("push-search")));
  assert.match(skip.out, /SKIP_PUSH_SEARCH removed AND COMMONS_PUSH_PREFIXES set/);
  const unset = runNightly({ pushExit: 9, env: {} });
  assert.equal(unset.code, 0, unset.out);
  assert.ok(!unset.steps.some((s) => s.includes("push-search")));
  assert.match(unset.out, /arming needs SKIP_PUSH_SEARCH removed AND COMMONS_PUSH_PREFIXES set/);
  const healthy = runNightly({ pushExit: 0, env: { COMMONS_PUSH_PREFIXES: "_KNOWLEDGE/,_DAILY/" } });
  assert.equal(healthy.code, 0, healthy.out);
  assert.ok(healthy.steps.some((s) => /push-search --profile commons --s3 --prefixes _KNOWLEDGE\/,_DAILY\/ --require-live-object/.test(s)));
  assert.match(healthy.out, /done: /);
  const doc = readFileSync(join(ROOT, "skills/brain-save/SKILL.md"), "utf8");
  assert.match(doc, /remove `SKIP_PUSH_SEARCH` from the task definition AND set\s+`COMMONS_PUSH_PREFIXES/);
});

// ---------------- N3 ----------------
test("N3: a `_count` reply without a numeric count is an ERROR, never 0 (canary and purge)", () => {
  for (const res of [{ ok: true, json: {} }, { ok: true, json: { count: null } }, { ok: true, json: { count: "0" } }, { ok: true, json: null }, { ok: true, json: { count: -1 } }, undefined]) {
    assert.throws(() => strictCount(res, "x"), /no numeric count/, JSON.stringify(res));
    assert.throws(() => countOf(res, "x"), /no numeric count/, JSON.stringify(res));
  }
  assert.equal(strictCount({ ok: true, json: { count: 0 } }), 0);
  assert.equal(countOf({ ok: true, json: { count: 17 } }, "x"), 17);
});

test("N2: purge and canary residue queries are case-insensitive prefix queries on the whole room path", () => {
  assert.deepEqual(prefixQuery("_JOURNAL/"), { prefix: { "path.keyword": { value: "otchealthcommons/company-journal/_JOURNAL/", case_insensitive: true } } });
  assert.deepEqual(pathPrefixQuery("a/b/"), { prefix: { "path.keyword": { value: "a/b/", case_insensitive: true } } });
  const canary = readFileSync(join(ROOT, "skills/aws-dr-canary/canary.mjs"), "utf8");
  assert.match(canary, /osCount\(cfg, RING_RESIDUE_ROOM\.index, pathPrefixQuery\(/);
  assert.ok(!/Number\(res\.json\??\.count \?\? 0\)/.test(canary), "no `Number(count ?? 0)` left in the canary");
});

// ---------------- C5 ----------------
const NOW = Date.parse("2026-09-29T12:00:00Z");
const hoursAgo = (h) => new Date(NOW - h * 3600000).toISOString();
test("C5: EVERY object past the SLO is checked (newest first, bounded), not only the newest; a missing older one is STALE", () => {
  const blobs = [
    { name: "_KNOWLEDGE/research/a/2026-09-26-y-22222222.md", lastModified: hoursAgo(60) },
    { name: "_KNOWLEDGE/research/a/2026-09-20-x-11111111.md", lastModified: hoursAgo(200) },
    { name: "_KNOWLEDGE/research/a/2026-09-29-z-33333333.md", lastModified: hoursAgo(5) },
    { name: "_DAILY/2026-09-25.md", lastModified: hoursAgo(90) },
    { name: "_JOURNAL/cfo/x.md", lastModified: hoursAgo(100) },
    { name: "_TEXT/_DAILY/2026-09-25.md.txt", lastModified: hoursAgo(90) },
  ];
  const r = pickDueObjects(blobs, ["_KNOWLEDGE/", "_DAILY/"], 48, NOW);
  assert.deepEqual(r.due.map((b) => b.name), ["_KNOWLEDGE/research/a/2026-09-26-y-22222222.md", "_DAILY/2026-09-25.md", "_KNOWLEDGE/research/a/2026-09-20-x-11111111.md"]);
  assert.equal(r.totalDue, 3);
  assert.equal(pickNewestDueObject(blobs, ["_KNOWLEDGE/", "_DAILY/"], 48, NOW).due.name, r.due[0].name, "the legacy picker only ever saw the first");
  // bounded
  const many = Array.from({ length: 300 }, (_, i) => ({ name: `_KNOWLEDGE/r/a/2026-08-01-d${i}-${String(i).padStart(8, "0")}.md`, lastModified: hoursAgo(100 + i) }));
  const capped = pickDueObjects(many, ["_KNOWLEDGE/"], 48, NOW);
  assert.equal(capped.due.length, 200);
  assert.equal(capped.totalDue, 300);
  // judged: the OLDER object has no chunks while the newest due one does -> STALE naming the missing one
  const names = r.due.map((b) => b.name);
  const stale = assessDueObjects({ dueNames: names, presentNames: [names[0], names[2]], totalDue: 3, sloHours: 48 });
  assert.equal(stale.state, "STALE");
  assert.match(stale.reason, /1 of 3 due object\(s\).*_DAILY\/2026-09-25\.md/);
  assert.equal(assessDueObjects({ dueNames: names, presentNames: names, totalDue: 3, sloHours: 48 }).state, "OK");
  assert.match(assessDueObjects({ dueNames: names, presentNames: names, totalDue: 300, sloHours: 48 }).reason, /the 3 newest of 300 due/);
});

test("Dockerfile ships brain-save (the commons gate imports it)", () => {
  assert.match(readFileSync(join(ROOT, "skills/doc-indexer/job/Dockerfile"), "utf8"), /^COPY skills\/brain-save\/ \/app\/skills\/brain-save\/\s*$/m);
  assert.ok(existsSync(join(ROOT, "skills/brain-save/lib/object-gate.mjs")));
});
