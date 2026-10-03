import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import {
  kitFolderName, kitZipName, normalizeRole, safeKitPath, relPreserve, isSensitiveRole, exportLedger, KitBuilder, gateText, gateBinary,
  binaryDecision, classifyFile, buildManifest, renderManifestMd, mdCell, sanitizeRegistryOutput, assertNamesOnly, collectRepoDocs, parseRepoDocs,
  globToRegExp, renderMediaIndex, verifyKitDir, writeKitDir, zipFolder, unzipTo, renderReadme, MAX_IMAGE_BYTES, sha256,
} from "../lib.mjs";

// A fake AWS access key id built at RUNTIME so this file carries no secret-shaped literal.
const fakeAwsKey = () => "AK" + "IA" + "Q3XJ7KZ2PRM4WV6N";
const tmp = () => mkdtempSync(join(tmpdir(), "mhk-test-"));

test("layout naming: folder and zip carry the upper-cased role and the date", () => {
  assert.equal(kitFolderName("developer", "2026-10-03"), "DEVELOPER-MASTER-HANDOFF-KIT-2026-10-03");
  assert.equal(kitZipName("cto", "2026-10-03"), "CTO-MASTER-HANDOFF-KIT-2026-10-03.zip");
  assert.equal(normalizeRole(" CFO "), "cfo");
  assert.throws(() => normalizeRole("../etc"), /invalid --agent/);
  assert.throws(() => normalizeRole(""), /invalid --agent/);
});

test("safeKitPath rejects traversal, absolute and empty paths", () => {
  assert.equal(safeKitPath("session-files/a/b.md"), "session-files/a/b.md");
  assert.equal(safeKitPath("a//b.md"), "a/b.md"); // a doubled slash is normalized, not an escape
  for (const bad of ["../x", "a/../../x", "/etc/passwd", "C:\\x", "", "a\0b"]) assert.throws(() => safeKitPath(bad), /unsafe kit path/, JSON.stringify(bad));
});

test("relative-path preservation: structure under the scratchpad survives, outside paths are refused", () => {
  const root = tmp();
  try {
    mkdirSync(join(root, "deep", "er"), { recursive: true });
    const f = join(root, "deep", "er", "notes.md");
    writeFileSync(f, "x");
    assert.equal(relPreserve(root, f), "deep/er/notes.md");
    assert.throws(() => relPreserve(join(root, "deep"), join(root, "other.md")), /not under/);
    // the builder keeps the preserved path verbatim under its section
    const b = new KitBuilder({ role: "cto", date: "2026-10-03" });
    assert.equal(b.add({ section: "session-files", path: `session-files/${relPreserve(root, f)}`, source: f, content: "hello" }), "session-files/deep/er/notes.md");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("path collisions never overwrite: the second file gets a ~2 suffix", () => {
  const b = new KitBuilder({ role: "cto", date: "2026-10-03" });
  const a = b.add({ section: "core", path: "01-x.md", source: "s1", content: "one" });
  const c = b.add({ section: "core", path: "01-x.md", source: "s2", content: "two" });
  assert.equal(a, "01-x.md");
  assert.equal(c, "01-x~2.md");
});

test("sensitive-role ledger rule: counts only, never text (cfo, clo, clo-personal, capital)", () => {
  const rows = [
    { id: "1", ts: "2026-01-01T00:00:00Z", type: "decision", text: "SENTINEL-MNPI-TEXT revenue is up" },
    { id: "2", ts: "2026-02-01T00:00:00Z", type: "fact", text: "SENTINEL-MNPI-TEXT second" },
  ];
  for (const role of ["cfo", "clo", "clo-personal", "capital"]) {
    assert.equal(isSensitiveRole(role), true, role);
    const ex = exportLedger({ role, rows, entryGate: () => [] });
    assert.equal(ex.sensitive, true);
    assert.equal(ex.jsonl, null);
    assert.equal(ex.rows.length, 0);
    assert.equal(ex.counts.total, 2);
    assert.equal(ex.counts.by_type.decision, 1);
    assert.ok(!ex.md.includes("SENTINEL-MNPI-TEXT"), `${role}: no ledger text in the counts-only doc`);
    assert.match(ex.md, /COUNTS ONLY/);
  }
  assert.equal(isSensitiveRole("developer"), false);
  assert.equal(isSensitiveRole("cto"), false);
});

test("non-sensitive ledger: every entry exported with id/date/type/text, latest values and corrections views present", () => {
  const rows = [
    { id: "a1", ts: "2026-03-01T00:00:00Z", type: "entity", ekey: "build.next", evalue: "44", text: "build.next = 44" },
    { id: "a2", ts: "2026-04-01T00:00:00Z", type: "entity", ekey: "build.next", evalue: "45", text: "build.next = 45", supersedes: "a1" },
    { id: "a3", ts: "2026-04-02T00:00:00Z", type: "correction", text: "use depot-macos-26", was: "depot-macos-latest" },
    { id: "a4", ts: "2026-04-03T00:00:00Z", type: "pitfall", text: "never trust a green count" },
  ];
  const ex = exportLedger({ role: "developer", rows, entryGate: () => [] });
  assert.equal(ex.sensitive, false);
  assert.equal(ex.jsonl.trim().split("\n").length, 4);
  for (const r of rows) assert.ok(ex.md.includes(r.id), `md lists ${r.id}`);
  assert.match(ex.md, /LATEST VALUES[\s\S]*build\.next` = 45/);
  assert.ok(!/LATEST VALUES[^#]*= 44/.test(ex.md), "the superseded value is not shown as current");
  assert.match(ex.md, /CORRECTIONS[\s\S]*WAS: depot-macos-latest/);
});

test("secret gate excludes a fixture with a fake AWS key shape; the withheld entry keeps id/date/type and is recorded", () => {
  const key = fakeAwsKey();
  const rows = [
    { id: "ok1", ts: "2026-05-01T00:00:00Z", type: "fact", text: "plain safe fact" },
    { id: "bad1", ts: "2026-05-02T00:00:00Z", type: "fact", text: `the key is ${key} do not keep` },
  ];
  const gate = (row) => gateText(JSON.stringify(row), { relPath: "x" }, []).findings;
  const ex = exportLedger({ role: "developer", rows, entryGate: gate });
  assert.equal(ex.redactions.length, 1);
  assert.equal(ex.redactions[0].id, "bad1");
  assert.ok(ex.redactions[0].rules.includes("layer-A:aws-access-key-id"));
  assert.ok(!ex.jsonl.includes(key) && !ex.md.includes(key), "the key never reaches the exported files");
  const stub = ex.rows.find((r) => r.id === "bad1");
  assert.equal(stub.withheld, true);
  assert.equal(stub.ts, "2026-05-02T00:00:00Z");
  assert.equal(stub.type, "fact");
});

test("withheld-entry stubs and the manifest never trip the secret gate themselves, whatever rule fired", () => {
  const rules = ["layer-A:labeled-secret-value", "layer-A:env-secret-assignment", "layer-A:aws-access-key-id", "layer-B:some-ssm-name", "PHI_DATA"];
  const rows = [{ id: "z1", ts: "2026-05-02T00:00:00Z", type: "fact", text: "x" }];
  const ex = exportLedger({ role: "developer", rows, entryGate: () => [{ kind: "secret", rules: rules.slice(0, 4), detail: "" }, { kind: "ring", rules: ["PHI_DATA"], detail: "" }] });
  assert.equal(gateText(ex.md, { relPath: "m.md" }, []).findings.filter((f) => f.kind === "secret").length, 0);
  assert.equal(gateText(ex.jsonl, { relPath: "m.jsonl" }, []).findings.filter((f) => f.kind === "secret").length, 0);
  const b = new KitBuilder({ role: "developer", date: "2026-10-03" });
  b.redactions.push(...ex.redactions);
  const md = renderManifestMd(buildManifest({ role: "developer", date: "2026-10-03", builder: b }));
  assert.equal(gateText(md, { relPath: "MANIFEST.md" }, []).findings.filter((f) => f.kind === "secret").length, 0);
});

test("a document with a fake AWS key is excluded and the exclusion is recorded in the manifest with its reason", () => {
  const key = fakeAwsKey();
  const b = new KitBuilder({ role: "cto", date: "2026-10-03" });
  assert.equal(b.addGatedText({ section: "session-files", path: "session-files/clean.md", source: "/s/clean.md", text: "# Clean\nnothing secret here at all", needles: [] }), true);
  assert.equal(b.addGatedText({ section: "session-files", path: "session-files/dirty.md", source: "/s/dirty.md", text: `# Dirty\naws key ${key}\n`, needles: [] }), false);
  assert.equal(b.files.length, 1);
  assert.equal(b.excluded.length, 1);
  assert.equal(b.excluded[0].source, "/s/dirty.md");
  assert.match(b.excluded[0].reason, /secret gate/);
  assert.ok(b.excluded[0].rules.includes("layer-A:aws-access-key-id"));
  const m = buildManifest({ role: "cto", date: "2026-10-03", builder: b });
  assert.equal(m.counts.excluded, 1);
  assert.equal(m.files[0].sha256, sha256("# Clean\nnothing secret here at all"));
  const md = renderManifestMd(m);
  assert.match(md, /dirty\.md/);
  assert.match(md, /secret gate/);
  assert.ok(!md.includes(key), "the manifest never prints the value");
  assert.ok(!JSON.stringify(m).includes(key));
});

test("layer B: a live secret value (needle) is caught even when it looks like ordinary text", async () => {
  const { buildNeedles } = await import("../../brain-save/lib/secret-gate.mjs");
  const value = "zQ8" + "vN2mKp" + "4xLr7Tw" + "Y9bC3dF6hJ1sA5";
  const needles = buildNeedles([{ name: "test-secret", value, type: "SecureString", origin: "ssm" }]);
  assert.ok(needles.length > 0);
  const g = gateText(`# notes\nthe value is ${value}\n`, { relPath: "n.md" }, needles);
  assert.equal(g.ok, false);
  assert.ok(g.findings.some((f) => f.rules.includes("layer-B:test-secret")));
});

test("binary allowlist: small images only; oversize and non-image binaries are refused with a reason", () => {
  assert.equal(binaryDecision("a.png", 1000).ok, true);
  assert.equal(binaryDecision("a.JPG", 1000).ok, true);
  assert.equal(binaryDecision("a.png", MAX_IMAGE_BYTES + 1).ok, false);
  assert.match(binaryDecision("a.png", MAX_IMAGE_BYTES + 1).reason, /over the/);
  for (const n of ["a.mp4", "a.zip", "a.pdf", "a.exe", "a"]) assert.equal(binaryDecision(n, 10).ok, false, n);
  assert.deepEqual(classifyFile("shot.png", Buffer.from([0x89, 0x50, 0x4e, 0x47])), { type: "image" });
  assert.equal(classifyFile("movie.mp4", Buffer.from([0, 1, 2, 0])).type, "rejected");
  assert.equal(classifyFile("fake.md", Buffer.from([0x61, 0, 0x62])).type, "rejected"); // NUL bytes in a .md
  assert.equal(classifyFile("notes.md", Buffer.from("# hi")).type, "text");
  const b = new KitBuilder({ role: "cto", date: "2026-10-03" });
  assert.equal(b.addGatedBinary({ section: "session-files", path: "session-files/ok.png", source: "/s/ok.png", buf: Buffer.from("PNGDATA"), needles: [] }), true);
  assert.equal(b.addGatedBinary({ section: "session-files", path: "session-files/big.png", source: "/s/big.png", buf: Buffer.alloc(MAX_IMAGE_BYTES + 1), needles: [] }), false);
  assert.equal(b.addGatedBinary({ section: "session-files", path: "session-files/v.mp4", source: "/s/v.mp4", buf: Buffer.from("x"), needles: [] }), false);
  assert.equal(b.excluded.length, 2);
  // an image whose metadata embeds a credential is caught by the latin1 scan
  assert.equal(gateBinary(Buffer.from(`\x89PNG meta ${fakeAwsKey()} end`, "latin1"), []).ok, false);
});

test("credential registry: names pass, a value-looking cell or name is rejected, the status lines are stripped", () => {
  const raw = "# Credential Registry (x)\n\n## Apple (1)\n\n| SSM parameter name | Type | Ring | Env | Added |\n|---|---|---|---|---|\n| `asc-key-id` | config non-secret | non-PHI | prod | 2026-08-13 |\n| `gw/ADMIN_REVOKE_TOKEN` | API key | non-PHI | prod | 2026-08-14 |\n\n[vault-registry] 2 credentials, 1 services (0 PHI-BAA).\n(dry: not uploaded)\n";
  const clean = sanitizeRegistryOutput(raw);
  assert.ok(!clean.includes("[vault-registry]") && !clean.includes("(dry:"));
  assert.deepEqual(assertNamesOnly(clean, []), { ok: true, problems: [] });
  const v = "Zk3jQ9" + "xP2mLw8V" + "b7Nc4Rt6Yh1Ud5Sa0Fg";
  assert.equal(assertNamesOnly(clean + `| \`${v}\` | API key | non-PHI | prod | x |\n`, []).ok, false);
  assert.equal(assertNamesOnly(clean + `| \`ok\` | API key | non-PHI | prod | \`${v}\` |\n`, []).ok, false);
  assert.equal(assertNamesOnly(clean + `| \`${fakeAwsKey()}\` | API key | non-PHI | prod | x |\n`, []).ok, false);
});

test("repo docs are read from origin/main, never the working tree", () => {
  const dir = tmp();
  try {
    const sh = (...a) => execFileSync("git", ["-C", join(dir, "myrepo"), ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    mkdirSync(join(dir, "myrepo", "docs"), { recursive: true });
    execFileSync("git", ["init", "-q", join(dir, "myrepo")]);
    sh("config", "user.email", "t@example.com"); sh("config", "user.name", "t");
    writeFileSync(join(dir, "myrepo", "CLAUDE.md"), "# main version\n");
    writeFileSync(join(dir, "myrepo", "docs", "plan.md"), "# plan on main\n");
    sh("add", "."); sh("commit", "-q", "-m", "init");
    sh("update-ref", "refs/remotes/origin/main", "HEAD");
    writeFileSync(join(dir, "myrepo", "CLAUDE.md"), "# DIRTY WORKING TREE\n"); // must NOT be read
    const { docs, missing } = collectRepoDocs({ repos: [join(dir, "myrepo")], extra: parseRepoDocs("myrepo:docs/*.md,myrepo:nope/**") });
    const byPath = Object.fromEntries(docs.map((d) => [d.path, d.buf.toString()]));
    assert.equal(byPath["CLAUDE.md"], "# main version\n");
    assert.equal(byPath["docs/plan.md"], "# plan on main\n");
    assert.ok(!("AGENTS.md" in byPath), "absent default docs are simply not present");
    assert.ok(missing.some((m) => m.pattern === "nope/**"), "an unmatched requested glob is reported");
    assert.deepEqual(docs.map((d) => d.repo), ["myrepo", "myrepo"]);
    assert.ok(/^[0-9a-f]{40}$/.test(docs[0].sha));
    assert.deepEqual(collectRepoDocs({ repos: [join(dir, "myrepo")], extra: parseRepoDocs("other:README.md") }).missing.map((m) => m.reason), ["repo not in --repos"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("glob matching and --repo-docs parsing", () => {
  assert.ok(globToRegExp("docs/**/*.md").test("docs/a/b/c.md"));
  assert.ok(globToRegExp("docs/*.md").test("docs/a.md"));
  assert.ok(!globToRegExp("docs/*.md").test("docs/a/b.md"));
  assert.deepEqual(parseRepoDocs("a:x.md, b:docs/**"), [{ repo: "a", glob: "x.md" }, { repo: "b", glob: "docs/**" }]);
  assert.throws(() => parseRepoDocs("nocolon"), /bad --repo-docs/);
});

test("media index lists OneDrive and S3 locations, not binaries", () => {
  const md = renderMediaIndex([{ app: "AWARE", version: "1.4.0", build: "1", versionFolder: "1.4.0 (1)", kind: "iphone-video", filename: "run.mp4", s3Key: "_APP-MEDIA/AWARE/1.4.0 (1)/iphone-video/run.mp4", sha256: "ab".repeat(32) }], { generatedAt: "2026-10-03T00:00:00Z" });
  assert.match(md, /5-Media\/App Screenshots and Videos\/AWARE\/1\.4\.0 \(1\)\/iphone-video\/run\.mp4/);
  assert.match(md, /_APP-MEDIA\/AWARE\/1\.4\.0 \(1\)\/iphone-video\/run\.mp4/);
  assert.match(renderMediaIndex(null), /empty or unavailable/);
});

test("README is generic, names the new agent as brand new, carries both mandates and no value", () => {
  const b = new KitBuilder({ role: "developer", date: "2026-10-03" });
  b.add({ section: "core", path: "01-brief.md", source: "x", content: "brief" });
  const md = renderReadme({ role: "developer", date: "2026-10-03", targetPlatform: "Codex", builder: b, agentDef: "---\nname: developer\ndescription: The master app developer.\n---\nbody", hasHandoff: true, hasPlaybook: true, hasLedger: true, ledgerSensitive: false });
  assert.match(md, /brand new/);
  assert.match(md, /Codex/);
  assert.match(md, /Do all the work/);
  assert.match(md, /Continuous improvement/);
  assert.match(md, /mcp\.otchealth\.app\/mcp/);
  assert.match(md, /01-brief\.md/);
  assert.match(md, /The master app developer/);
  assert.equal(gateText(md, { relPath: "00-README-START-HERE.md" }, []).findings.filter((f) => f.kind === "secret").length, 0);
});

test("zip round trip + verifyKitDir: manifest matches, tampering and an injected secret are both caught", () => {
  const dir = tmp();
  try {
    const b = new KitBuilder({ role: "cto", date: "2026-10-03" });
    b.add({ section: "core", path: "01-a.md", source: "s", content: "alpha content" });
    b.add({ section: "memories", path: "memories/cto-ledger.md", source: "s", content: "beta content" });
    const m = buildManifest({ role: "cto", date: "2026-10-03", builder: b });
    const files = [...b.files, { path: "MANIFEST.md", content: Buffer.from(renderManifestMd(m)) }, { path: "manifest.json", content: Buffer.from(JSON.stringify(m)) }];
    const folder = kitFolderName("cto", "2026-10-03");
    writeKitDir(dir, folder, files);
    const zip = join(dir, "kit.zip");
    zipFolder(dir, folder, zip);
    assert.ok(existsSync(zip));
    const out = join(dir, "x");
    unzipTo(zip, out);
    const ok = verifyKitDir(join(out, folder), []);
    assert.equal(ok.ok, true, ok.problems.join("; "));
    assert.equal(ok.checked, 4);
    // tamper: change a listed file
    writeFileSync(join(out, folder, "01-a.md"), "alpha CHANGED");
    assert.ok(verifyKitDir(join(out, folder), []).problems.some((p) => /sha256 mismatch: 01-a\.md/.test(p)));
    // an unlisted file and a planted secret
    writeFileSync(join(out, folder, "extra.md"), `leak ${fakeAwsKey()}`);
    const bad = verifyKitDir(join(out, folder), []);
    assert.ok(bad.problems.some((p) => /unlisted file in the kit: extra\.md/.test(p)));
    assert.ok(bad.problems.some((p) => /secret gate tripped on extra\.md/.test(p)));
    assert.equal(readFileSync(join(out, folder, "memories", "cto-ledger.md"), "utf8"), "beta content");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("markdown table cells escape backslashes before pipes (a trailing backslash cannot swallow the escape)", () => {
  assert.equal(mdCell("a|b"), "a\\|b");
  assert.equal(mdCell("C:\\dir\\"), "C:\\\\dir\\\\");
  assert.equal(mdCell("x\\|y"), "x\\\\\\|y"); // backslash doubled, then the pipe escaped
  assert.equal(mdCell("l1\nl2"), "l1 l2");
  const b = new KitBuilder({ role: "cto", date: "2026-10-03" });
  b.add({ section: "core", path: "01-x.md", source: "C:\\a\\b|c\\", content: "x" });
  b.exclude({ section: "core", source: "D:\\e|f\\", reason: "r|s\\" });
  const md = renderManifestMd(buildManifest({ role: "cto", date: "2026-10-03", builder: b }));
  assert.ok(md.includes("C:\\\\a\\\\b\\|c\\\\"));
  assert.ok(md.includes("D:\\\\e\\|f\\\\"));
  assert.ok(md.includes("r\\|s\\\\"));
});
