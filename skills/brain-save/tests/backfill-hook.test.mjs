import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync, appendFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { main } from "../brain-save.mjs";
import { _resetShapeCacheForTests } from "../lib/push.mjs";
import { createFakeBackend } from "./fake-backend.mjs";
import { run as runHook, unsavedFiles, buildMessage, scanFolder } from "../hooks/unsaved-reminder.mjs";

process.env.BRAIN_SAVE_VERIFY_DELAY_MS = "0";
const HOOK = fileURLToPath(new URL("../hooks/unsaved-reminder.mjs", import.meta.url));
beforeEach(() => { process.env.BRAIN_SAVE_STATE_DIR = mkdtempSync(join(tmpdir(), "bs-state-")); _resetShapeCacheForTests(); });

function gitRepo() {
  const root = mkdtempSync(join(tmpdir(), "bs-repos-"));
  const repo = join(root, "demo-repo");
  mkdirSync(join(repo, "docs"), { recursive: true });
  writeFileSync(join(repo, "docs", "gizmo-runbook.md"), "# Gizmo deployment runbook for demo\n\nStep one. Step two.\n");
  const g = (...a) => execFileSync("git", ["-C", repo, ...a], { stdio: "ignore" });
  g("init", "-q"); g("config", "user.email", "t@t"); g("config", "user.name", "t"); g("add", "."); g("commit", "-qm", "init");
  return root;
}

test("backfill: every include value and path form; refuse-commons MUST refuse; resumable; post-audit clean", async () => {
  const be = createFakeBackend();
  const repos = gitRepo();
  const d = mkdtempSync(join(tmpdir(), "bs-bf-"));
  writeFileSync(join(d, "local.md"), "# Widget backfill local research note\n\nbody\n");
  writeFileSync(join(d, "mock1.html"), "<html><head><title>Widget mockup screen alpha</title></head><body>a</body></html>");
  writeFileSync(join(d, "mock2.html"), "<html><head><title>Widget mockup screen beta</title></head><body>b</body></html>");
  const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
  const manifest = [
    { path: join(d, "local.md"), kind: "research", app: "fleet", include: "yes", sha256: sha(join(d, "local.md")) },
    { path: "demo-repo@HEAD:docs/gizmo-runbook.md", kind: "runbook", app: "fleet", include: "yes", sha256: "g1" },
    { path: "https://claude.ai/artifact/SomeOtherArtifactId", kind: "artifact", app: "fleet", include: "yes" },
    { path: "https://claude.ai/artifact/7sK3KmDJmTLTrMik5ZGYoM", kind: "artifact", app: "finance", include: "refuse-commons" },
    { path: join(d, "mock1.html"), kind: "design", app: "fleet", include: "store-only", sha256: sha(join(d, "mock1.html")) },
    { path: join(d, "mock2.html"), kind: "design", app: "fleet", include: "store-only", sha256: sha(join(d, "mock2.html")) },
    { path: join(d, "review.md"), kind: "doc", app: "fleet", include: "review" },
    { path: "otchealth-cto@main:projects/moore-playbook/x.md", kind: "doc", app: "fleet", include: "hold" },
    { path: "https://claude.ai/docs/x", kind: "doc", app: "fleet", include: "export-docs" },
  ];
  const mf = join(d, "manifest.json");
  writeFileSync(mf, JSON.stringify(manifest));
  const out = [];
  const code = await main(["backfill", mf, "--repos-root", repos, "--no-fetch"], { backend: be, needles: [] }, { stdout: (s) => out.push(s), stderr: (s) => out.push(s) });
  const text = out.join("\n");
  assert.equal(code, 0, text);
  assert.match(text, /REFUSED as required/);
  assert.match(text, /NEEDS ARTIFACT READ/);
  assert.match(text, /"review-skipped":1/);
  assert.match(text, /"hold-skipped":1/);
  assert.match(text, /"export-docs-skipped":1/);
  assert.match(text, /"stored-only":2/);
  assert.match(text, /"collection-saved":1/);
  assert.match(text, /post-backfill audit: \d+ written doc\(s\) re-checked, 0 finding/);
  const repoDoc = [...be.s3.keys()].find((k) => k.startsWith("_KNOWLEDGE/runbook/fleet/"));
  assert.match(be.s3.get(repoDoc).text, /^source: "demo-repo@[0-9a-f]{7,12}:docs\/gizmo-runbook\.md"$/m);
  const collection = [...be.s3.keys()].find((k) => k.includes("collection"));
  assert.ok(collection && /Widget mockup screen alpha/.test(be.s3.get(collection).text));
  // resume: the local entry is recorded as saved and is skipped on the next run
  const out2 = [];
  await main(["backfill", mf, "--repos-root", repos, "--no-fetch"], { backend: be, needles: [] }, { stdout: (s) => out2.push(s), stderr: () => {} });
  assert.match(out2.join("\n"), /"already-done":\d/);
  // a refuse-commons entry the gate would ALLOW is a backfill failure
  writeFileSync(mf, JSON.stringify([{ path: "https://claude.ai/artifact/NotOnTheDenylist", kind: "artifact", app: "fleet", include: "refuse-commons" }]));
  const out3 = [];
  assert.equal(await main(["backfill", mf], { backend: be, needles: [] }, { stdout: (s) => out3.push(s), stderr: () => {} }), 1);
  assert.match(out3.join("\n"), /GATE FAILURE/);
});

// ---------------- Stop-hook reminder ----------------
function scratch() {
  const tmpRoot = mkdtempSync(join(tmpdir(), "bs-hook-"));
  const sp = join(tmpRoot, "claude-0", "-home-user", "sess-123", "scratchpad");
  mkdirSync(sp, { recursive: true });
  return { tmpRoot, sp };
}
const big = (label) => `# ${label}\n\n${"content words here. ".repeat(20)}\n`;

test("hook: one reminder per new set, silent when already reminded, silent once saved (fast path and by hash), refused excluded, never prints content", async () => {
  const { tmpRoot, sp } = scratch();
  const secretish = "UNIQUE_BODY_MARKER_7781";
  writeFileSync(join(sp, "a.md"), big("A") + secretish);
  writeFileSync(join(sp, "b.html"), "<html>" + big("B") + "</html>");
  writeFileSync(join(sp, "tiny.md"), "x");
  mkdirSync(join(sp, "repo-copy", ".git"), { recursive: true });
  writeFileSync(join(sp, "repo-copy", "c.md"), big("C"));
  const stdin = JSON.stringify({ session_id: "sess-123", cwd: "/nonexistent", stop_hook_active: false });
  const first = await runHook(stdin, { tmpRoot });
  assert.match(first.systemMessage, /2 document\(s\)/);
  assert.match(first.systemMessage, /a\.md/);
  assert.ok(!first.systemMessage.includes(secretish));
  assert.ok(!("decision" in first));
  assert.equal(await runHook(stdin, { tmpRoot }), null, "same set: silent");
  const st = statSync(join(sp, "a.md"));
  const dir = process.env.BRAIN_SAVE_STATE_DIR;
  appendFileSync(join(dir, "receipts.jsonl"), JSON.stringify({ local_path: join(sp, "a.md"), size: st.size, mtime_ms: st.mtimeMs, raw_sha256: "x" }) + "\n");
  const bHash = createHash("sha256").update(readFileSync(join(sp, "b.html"))).digest("hex");
  appendFileSync(join(dir, "refused.jsonl"), JSON.stringify({ local_path: join(sp, "b.html"), raw_sha256: bHash, code: "BANNER" }) + "\n");
  assert.equal(await runHook(stdin, { tmpRoot }), null, "a.md saved (fast path), b.html refused by design");
  writeFileSync(join(sp, "d.md"), big("D"));
  const dHash = createHash("sha256").update(readFileSync(join(sp, "d.md"))).digest("hex");
  assert.match((await runHook(stdin, { tmpRoot })).systemMessage, /d\.md/);
  appendFileSync(join(dir, "receipts.jsonl"), JSON.stringify({ local_path: "/elsewhere/d.md", size: 0, mtime_ms: 0, raw_sha256: dHash }) + "\n");
  assert.equal(await runHook(stdin, { tmpRoot }), null, "saved by hash");
});

test("hook: ignore file, stop_hook_active, BRAIN_SAVE_REMINDER=0, malformed stdin, missing dirs", async () => {
  const { tmpRoot, sp } = scratch();
  writeFileSync(join(sp, "keep.md"), big("K"));
  writeFileSync(join(sp, "skip-me.md"), big("S"));
  writeFileSync(join(sp, ".brain-save-ignore"), "skip-*.md\n");
  assert.deepEqual(scanFolder(sp).map((f) => f.split("/").pop()), ["keep.md"]);
  assert.equal(await runHook(JSON.stringify({ session_id: "sess-123", stop_hook_active: true }), { tmpRoot }), null);
  process.env.BRAIN_SAVE_REMINDER = "0";
  assert.equal(await runHook(JSON.stringify({ session_id: "sess-123" }), { tmpRoot }), null);
  delete process.env.BRAIN_SAVE_REMINDER;
  assert.equal(await runHook("{not json", { tmpRoot }), null);
  assert.equal(await runHook(JSON.stringify({ session_id: "../../etc" }), { tmpRoot }), null);
  assert.equal(await runHook(JSON.stringify({ session_id: "nope" }), { tmpRoot: "/definitely/missing" }), null);
  assert.ok(buildMessage(["/a/1.md", "/a/2.md", "/a/3.md", "/a/4.md", "/a/5.md", "/a/6.md", "/a/7.md"]).includes("and 2 more"));
  assert.deepEqual(unsavedFiles([], [], []), []);
});

test("hook: the scan itself finishes under 1.5s on 400 files; as a process it exits 0 (also on malformed stdin)", async () => {
  const { tmpRoot, sp } = scratch();
  for (let i = 0; i < 400; i++) writeFileSync(join(sp, `f${i}.md`), big(`F${i}`));
  const t1 = Date.now();
  const msg = await runHook(JSON.stringify({ session_id: "sess-123", cwd: "/nonexistent-dir" }), { tmpRoot });
  assert.ok(Date.now() - t1 < 1500, `in-process scan took ${Date.now() - t1}ms`);
  assert.match(msg.systemMessage, /400 document\(s\)/);
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ session_id: "sess-123", cwd: "/nonexistent-dir" }), encoding: "utf8", env: { ...process.env } });
  const ms = Date.now() - t0;
  assert.equal(r.status, 0);
  assert.ok(ms < 5000, `took ${ms}ms`); // the hook's own deadline is 1.2s; node startup + a loaded CI box add overhead
  const bad = spawnSync(process.execPath, [HOOK], { input: "garbage", encoding: "utf8" });
  assert.equal(bad.status, 0);
  assert.equal(bad.stdout, "");
});
