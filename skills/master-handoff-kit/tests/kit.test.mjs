import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assembleKit, main, parseArgs, uploadToOneDrive, gateLedgerEntry } from "../kit.mjs";
import { verifyKitDir, writeKitDir, zipFolder, unzipTo, kitFolderName } from "../lib.mjs";

const fakeAwsKey = () => "AK" + "IA" + "Q3XJ7KZ2PRM4WV6N"; // runtime concat: no secret-shaped literal in the repo
const tmp = () => mkdtempSync(join(tmpdir(), "mhk-kit-"));
const BODY = "This is a perfectly ordinary design note with enough prose to clear the two hundred byte floor that the unsaved-document scanner applies, so that it is picked up as a session document. ".repeat(2);

function fakeDeps(over = {}) {
  const registry = "# Credential Registry (x)\n\n## Apple (1)\n\n| SSM parameter name | Type | Ring | Env | Added |\n|---|---|---|---|---|\n| `asc-key-id` | config non-secret | non-PHI | prod | 2026-08-13 |\n\n[vault-registry] 1 credentials, 1 services (0 PHI-BAA).\n";
  return {
    loadNeedles: async () => [],
    readLedger: async () => ({ rows: [
      { id: "L1", ts: "2026-09-01T00:00:00Z", type: "decision", text: "ship the kit" },
      { id: "L2", ts: "2026-09-02T00:00:00Z", type: "fact", text: `leaked ${fakeAwsKey()} here` },
      { id: "L3", ts: "2026-09-03T00:00:00Z", type: "correction", text: "new", was: "old" },
    ], source: "fake" }),
    readHandoff: async () => "# SUNRISE HANDOFF - DEVELOPER\nprocedure and pointers only",
    readRegistry: async () => ({ text: registry }),
    readMediaCatalog: async () => [{ app: "AWARE", version: "1.4.0", build: "1", versionFolder: "1.4.0 (1)", kind: "iphone-video", filename: "r.mp4", s3Key: "_APP-MEDIA/AWARE/1.4.0 (1)/iphone-video/r.mp4" }],
    toolkitDoc: (rel) => (rel === "dream-team/agents/developer.md" ? { text: "---\nname: developer\ndescription: The master app developer.\n---\nbody\n", source: `toolkit origin/main:${rel}` } : rel === "dream-team/DEVELOPER-PLAYBOOK.md" ? { text: "# Developer Playbook\nsection 1 and 2\n", source: `toolkit origin/main:${rel}` } : null),
    receipts: () => [], refusals: () => [],
    gitChanged: async () => [],
    tmpRoot: "/nonexistent",
    ...over,
  };
}

test("parseArgs: repeatable --include keeps order, booleans and values parse", () => {
  const a = parseArgs(["build", "--agent", "developer", "--include", "b.md", "--include", "a.md", "--dry-run", "--repos=x,y"]);
  assert.deepEqual(a.include, ["b.md", "a.md"]);
  assert.equal(a.flags["--agent"], "developer");
  assert.equal(a.flags["--dry-run"], true);
  assert.equal(a.flags["--repos"], "x,y");
  assert.throws(() => parseArgs(["build", "--agent"]), /needs a value/);
});

test("assembleKit: layout, ordering of core docs, gates, relative paths, manifest accounting", async () => {
  const work = tmp();
  try {
    const scratch = join(work, "scratch");
    mkdirSync(join(scratch, "reports", "deep"), { recursive: true });
    writeFileSync(join(scratch, "reports", "deep", "design.md"), "# Design\n" + BODY);
    writeFileSync(join(scratch, "reports", "leaky.md"), "# Leaky\n" + BODY + `\naws key ${fakeAwsKey()}\n`);
    writeFileSync(join(scratch, "shot.png"), Buffer.from("PNGBYTES"));
    writeFileSync(join(scratch, "huge.png"), Buffer.alloc(2 * 1024 * 1024 + 10));
    const inc1 = join(work, "second.md"), inc2 = join(work, "first.md");
    writeFileSync(inc1, "# Second\n" + BODY); writeFileSync(inc2, "# First\n" + BODY);

    const res = await assembleKit({ role: "developer", date: "2026-10-03", includes: [inc1, inc2], scratch: [scratch], sessionId: "", repos: [], targetPlatform: "Codex" }, fakeDeps());
    const paths = res.files.map((f) => f.path);

    // layout
    assert.equal(res.summary.folder, "DEVELOPER-MASTER-HANDOFF-KIT-2026-10-03");
    for (const p of ["00-README-START-HERE.md", "VERIFY.md", "MANIFEST.md", "manifest.json", "handoff/HANDOFF-developer.md", "handoff/AGENT-DEFINITION-developer.md", "handoff/DEVELOPER-PLAYBOOK.md", "credentials/CREDENTIAL-REGISTRY-names-only.md", "media/MEDIA-INDEX.md", "memories/developer-ledger-full.jsonl", "memories/developer-ledger.md"]) assert.ok(paths.includes(p), `missing ${p}`);
    // core docs first, in the given order
    assert.ok(paths.includes("01-second.md") && paths.includes("02-first.md"));
    // relative paths under the scratchpad are preserved
    assert.ok(paths.includes("session-files/reports/deep/design.md"));
    assert.ok(paths.includes("session-files/shot.png"));
    // gates: leaky doc and oversize image excluded WITH reasons; nothing leaky anywhere in the kit
    assert.ok(!paths.includes("session-files/reports/leaky.md"));
    const ex = Object.fromEntries(res.summary.excluded.map((e) => [e.source.split("/").pop(), e.reason]));
    assert.match(ex["leaky.md"], /secret gate/);
    assert.match(ex["huge.png"], /over the/);
    for (const f of res.files) assert.ok(!f.content.toString("latin1").includes(fakeAwsKey()), `${f.path} leaks the fake key`);
    // ledger: 3 entries exported, the leaky one withheld and recorded
    const jsonl = res.files.find((f) => f.path === "memories/developer-ledger-full.jsonl").content.toString().trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(jsonl.length, 3);
    assert.equal(jsonl.find((r) => r.id === "L2").withheld, true);
    assert.equal(res.manifest.withheld_ledger_entries.length, 1);
    assert.equal(res.manifest.withheld_ledger_entries[0].id, "L2");
    // manifest accounts for every file (except itself) with the right hash and size
    const listed = new Set(res.manifest.files.map((f) => f.path));
    for (const f of res.files) if (f.path !== "MANIFEST.md" && f.path !== "manifest.json") assert.ok(listed.has(f.path), `${f.path} not in manifest`);
    assert.equal(res.manifest.counts.excluded, res.summary.excluded.length);
    // README mentions the platform and the media graphics rule; VERIFY reports the refusals
    const readme = res.files.find((f) => f.path === "00-README-START-HERE.md").content.toString();
    assert.match(readme, /Codex/);
    assert.match(res.files.find((f) => f.path === "VERIFY.md").content.toString(), /refused by the secret gate: [1-9]/);
    assert.match(res.files.find((f) => f.path === "media/MEDIA-INDEX.md").content.toString(), /r\.mp4/);

    // the written + zipped + extracted kit verifies clean
    const stage = join(work, "stage");
    mkdirSync(stage);
    writeKitDir(stage, res.summary.folder, res.files);
    const zip = join(work, "kit.zip");
    zipFolder(stage, res.summary.folder, zip);
    const out = join(work, "out");
    unzipTo(zip, out);
    const v = verifyKitDir(join(out, res.summary.folder), []);
    assert.equal(v.ok, true, v.problems.join("; "));
  } finally { rmSync(work, { recursive: true, force: true }); }
});

test("assembleKit: session discovery by session id finds <tmp>/claude-*/<project>/<id>/scratchpad and skips documents already in the brain", async () => {
  const root = tmp();
  try {
    const sid = "11111111-2222-3333-4444-555555555555";
    const sp = join(root, "claude-0", "proj", sid, "scratchpad");
    mkdirSync(join(sp, "sub"), { recursive: true });
    const saved = join(sp, "sub", "saved.md"), fresh = join(sp, "sub", "fresh.md");
    writeFileSync(saved, "# Saved\n" + BODY); writeFileSync(fresh, "# Fresh\n" + BODY);
    const { createHash } = await import("node:crypto");
    const sha = createHash("sha256").update(readFileSync(saved)).digest("hex");
    const res = await assembleKit({ role: "cto", date: "2026-10-03", sessionId: sid, repos: [], includes: [] }, fakeDeps({ tmpRoot: root, receipts: () => [{ raw_sha256: sha, local_path: saved, size: 1, mtime_ms: 1 }] }));
    const paths = res.files.map((f) => f.path);
    assert.ok(paths.includes("session-files/sub/fresh.md"));
    assert.ok(!paths.includes("session-files/sub/saved.md"), "a document with a brain-save receipt is not re-exported");
    assert.ok(res.summary.notes.some((n) => /already saved to the brain/.test(n)));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("assembleKit: a SENSITIVE role exports counts only and no ledger text; no entry text anywhere in the kit", async () => {
  const deps = fakeDeps({ readLedger: async () => ({ rows: [{ id: "c1", ts: "2026-09-01T00:00:00Z", type: "decision", text: "SENTINEL-CFO-MNPI-TEXT" }, { id: "c2", ts: "2026-09-02T00:00:00Z", type: "fact", text: "SENTINEL-CFO-MNPI-TEXT 2" }], source: "fake" }) });
  const res = await assembleKit({ role: "cfo", date: "2026-10-03", includes: [], repos: [] }, deps);
  const paths = res.files.map((f) => f.path);
  assert.ok(paths.includes("memories/cfo-ledger-COUNTS-ONLY.md"));
  assert.ok(!paths.some((p) => /ledger-full|cfo-ledger\.md/.test(p)));
  for (const f of res.files) assert.ok(!f.content.toString().includes("SENTINEL-CFO-MNPI-TEXT"), `${f.path} carries ledger text`);
  assert.match(res.files.find((f) => f.path === "memories/cfo-ledger-COUNTS-ONLY.md").content.toString(), /entries: 2/);
});

test("assembleKit: unavailable ledger, registry and catalog are recorded, never silent", async () => {
  const deps = fakeDeps({ readLedger: async () => ({ rows: null, reason: "s3 down" }), readRegistry: async () => ({ text: null, reason: "vault-registry exited 3" }), readMediaCatalog: async () => null });
  const res = await assembleKit({ role: "developer", date: "2026-10-03", includes: [], repos: [] }, deps);
  const reasons = res.summary.excluded.map((e) => `${e.section}:${e.reason}`).join("\n");
  assert.match(reasons, /memories:ledger unavailable: s3 down/);
  assert.match(reasons, /credentials:registry unavailable: vault-registry exited 3/);
  assert.ok(res.summary.notes.some((n) => /catalog was unavailable/.test(n)));
  assert.ok(!res.files.some((f) => f.path.startsWith("credentials/")));
});

test("assembleKit: a registry that carries a value is refused whole", async () => {
  const v = "Zk3jQ9" + "xP2mLw8V" + "b7Nc4Rt6Yh1Ud5Sa0Fg";
  const reg = `# Credential Registry (x)\n\n| SSM parameter name | Type | Ring | Env | Added |\n|---|---|---|---|---|\n| \`ok-name\` | API key | non-PHI | prod | \`${v}\` |\n`;
  const res = await assembleKit({ role: "developer", date: "2026-10-03", includes: [], repos: [] }, fakeDeps({ readRegistry: async () => ({ text: reg }) }));
  assert.ok(!res.files.some((f) => f.path.startsWith("credentials/")));
  assert.match(res.summary.excluded.find((e) => e.section === "credentials").reason, /names-only assertion failed/);
});

test("gateLedgerEntry: secret shapes anywhere in the row (tags, source, text) trip the gate", () => {
  assert.deepEqual(gateLedgerEntry({ id: "x", type: "fact", text: "fine" }, "developer", []), []);
  const f = gateLedgerEntry({ id: "x", type: "fact", text: "fine", source: `see ${fakeAwsKey()}` }, "developer", []);
  assert.equal(f[0].kind, "secret");
});

test("--dry-run writes nothing and uploads nothing, prints the counts; a bad role is rejected", async () => {
  const out = join(tmp(), "should-not-exist");
  const lines = [];
  const orig = console.log; console.log = (...a) => lines.push(a.join(" "));
  let code;
  try { code = await main(["build", "--agent", "developer", "--dry-run", "--out", out], fakeDeps()); } finally { console.log = orig; }
  assert.equal(code, 0);
  assert.ok(!existsSync(out), "dry run must not create the output dir");
  assert.match(lines.join("\n"), /DRY RUN developer/);
  assert.match(lines.join("\n"), /files per section:/);
  assert.match(lines.join("\n"), /ledger entry L2 .*withheld: secret gate/);
  const e = console.error; console.error = () => {};
  try { await assert.rejects(() => main(["build", "--agent", "../bad", "--dry-run"], fakeDeps()), /invalid --agent/); } finally { console.error = e; }
});

test("build --no-upload then verify <zip>: PASS, and FAIL (exit 1/2) once the zip content is altered", async () => {
  const work = tmp();
  const orig = console.log; console.log = () => {};
  try {
    const code = await main(["build", "--agent", "developer", "--no-upload", "--out", work], fakeDeps());
    assert.equal(code, 0);
    const zip = join(work, "DEVELOPER-MASTER-HANDOFF-KIT-" + new Date().toISOString().slice(0, 10) + ".zip");
    assert.ok(existsSync(zip), "zip written");
    assert.equal(await main(["verify", zip], fakeDeps()), 0);
    // rebuild a tampered zip: unzip, plant a secret in an unlisted-file position, re-zip
    const x = join(work, "x"); unzipTo(zip, x);
    const folder = readdirSync(x)[0];
    writeFileSync(join(x, folder, "planted.md"), `oops ${fakeAwsKey()}`);
    const bad = join(work, "bad.zip"); zipFolder(x, folder, bad);
    assert.equal(await main(["verify", bad], fakeDeps()), 2);
    assert.equal(await main(["verify", join(work, "missing.zip")], fakeDeps()).catch(() => 1), 1);
  } finally { console.log = orig; rmSync(work, { recursive: true, force: true }); }
});

test("uploadToOneDrive: mkdir, upload every file, then verify by listing; a size mismatch or missing file throws", async () => {
  const work = tmp();
  try {
    const a = join(work, "kit.zip"), b = join(work, "00-README-START-HERE.md"), c = join(work, "MANIFEST.md");
    writeFileSync(a, "ZIPDATA"); writeFileSync(b, "readme"); writeFileSync(c, "manifest");
    const uploads = [], made = [];
    const uploader = async (path, buf) => { uploads.push([path, buf.length]); };
    const lsOk = () => ({ status: 0, out: "CTO Incoming/x: 3 item(s)\n  -          7  2026-10-03  kit.zip\n  -          6  2026-10-03  00-README-START-HERE.md\n  -          8  2026-10-03  MANIFEST.md\n", err: "" });
    const files = [{ name: "kit.zip", path: a }, { name: "00-README-START-HERE.md", path: b }, { name: "MANIFEST.md", path: c }];
    const r = await uploadToOneDrive({ folderPath: "CTO Incoming/x", localFiles: files, uploader, lister: lsOk, mkdir: (p) => { made.push(p); return { status: 0, out: "", err: "" }; } });
    assert.deepEqual(made, ["CTO Incoming/x"]);
    assert.deepEqual(uploads.map((u) => u[0]), ["CTO Incoming/x/kit.zip", "CTO Incoming/x/00-README-START-HERE.md", "CTO Incoming/x/MANIFEST.md"]);
    assert.equal(r.files.length, 3);
    const lsBadSize = () => ({ status: 0, out: "  -          9  2026-10-03  kit.zip\n  -          6  2026-10-03  00-README-START-HERE.md\n  -          8  2026-10-03  MANIFEST.md\n", err: "" });
    await assert.rejects(() => uploadToOneDrive({ folderPath: "f", localFiles: files, uploader, lister: lsBadSize, mkdir: () => ({ status: 0, out: "", err: "" }) }), /OneDrive size 9 != local 7/);
    const lsMissing = () => ({ status: 0, out: "  -          6  2026-10-03  00-README-START-HERE.md\n", err: "" });
    await assert.rejects(() => uploadToOneDrive({ folderPath: "f", localFiles: files, uploader, lister: lsMissing, mkdir: () => ({ status: 0, out: "", err: "" }) }), /missing from the OneDrive folder listing/);
    await assert.rejects(() => uploadToOneDrive({ folderPath: "f", localFiles: files, uploader, lister: lsOk, mkdir: () => ({ status: 1, out: "", err: "boom" }) }), /mkdir .* failed/);
  } finally { rmSync(work, { recursive: true, force: true }); }
});

test("kitFolderName stays consistent with what assembleKit writes", async () => {
  const res = await assembleKit({ role: "cto", date: "2026-01-02", includes: [], repos: [] }, fakeDeps());
  assert.equal(res.summary.folder, kitFolderName("cto", "2026-01-02"));
  assert.ok(res.manifest.kit === res.summary.folder);
});
