// Adjudication round 3 (2026-09-29) #1: the three CLIs' entry-point guards compared import.meta.url (the
// symlink-RESOLVED, percent-encoded URL) with `file://${process.argv[1]}`, so launched through a symlinked
// directory or a path containing a space they silently did nothing and exited 0. These tests run each CLI
// as a real process through (a) its direct path, (b) a symlinked directory whose name has a space, and
// (c) a real directory whose name has a space, and require the CLI to actually run (exit 1 on a bad input).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, symlinkSync, cpSync, mkdirSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isEntryPoint } from "../brain-save.mjs";
import { run as hookRun } from "../hooks/unsaved-reminder.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILLS = join(HERE, "..", "..");
const TMP = mkdtempSync(join(tmpdir(), "bs3 cli "));
after(() => rmSync(TMP, { recursive: true, force: true }));

// (b) a symlinked directory whose own name contains a space
const LINKED = join(TMP, "linked skills");
symlinkSync(SKILLS, LINKED);
// (c) a real (not symlinked) directory whose path contains a space: just what these CLIs import statically
const SPACED = join(TMP, "sp ace", "skills");
mkdirSync(SPACED, { recursive: true });
for (const d of ["brain-save", "doc-indexer"]) cpSync(join(SKILLS, d), join(SPACED, d), { recursive: true, filter: (s) => !s.includes("node_modules") });
// Everything else they import is linked (a linked module resolves ITS imports from its real location).
for (const d of readdirSync(SKILLS)) if (!["brain-save", "doc-indexer"].includes(d)) symlinkSync(join(SKILLS, d), join(SPACED, d));
symlinkSync(join(SKILLS, "..", "setup"), join(SPACED, "..", "setup"));
const ROOTS = { direct: SKILLS, "symlinked dir": LINKED, "space in path": SPACED };

const env = { ...process.env, KB_AGENT: "cto", BRAIN_SAVE_STATE_DIR: join(TMP, "state") };
const node = (script, args, input) => spawnSync(process.execPath, [script, ...args], { env, input, encoding: "utf8", timeout: 30000 });

test("round 3 #1: brain-save runs (exit 1 on a missing file) through a direct path, a symlinked dir and a path with a space", () => {
  for (const [how, root] of Object.entries(ROOTS)) {
    const r = node(join(root, "brain-save", "brain-save.mjs"), ["put", "/nonexistent-bs3.md", "--kind", "research", "--app", "fleet"]);
    assert.equal(r.status, 1, `${how}: exit ${r.status} stderr=${r.stderr}`);
    assert.match(r.stderr + r.stdout, /no supported files|not found/, how);
  }
});

test("round 3 #1: purge-ring-residue runs (exit 1 on a widened --prefixes) through all three launch paths", () => {
  for (const [how, root] of Object.entries(ROOTS)) {
    const r = node(join(root, "doc-indexer", "purge-ring-residue.mjs"), ["--prefixes", "not-a-ring-prefix/"]);
    assert.equal(r.status, 1, `${how}: exit ${r.status}`);
    assert.match(r.stderr, /FATAL: --prefixes may only name ring-private prefixes/, how);
  }
});

test("round 3 #1: the Stop-hook reminder runs through all three launch paths (prints its reminder)", () => {
  const sid = `bs3-${process.pid}-${Date.now()}`;
  const top = mkdtempSync(join("/tmp", "claude-bs3test-"));
  try {
    const sp = join(top, "proj", sid, "scratchpad");
    mkdirSync(sp, { recursive: true });
    writeFileSync(join(sp, "research-notes.md"), `# Widget sprocket research notes\n\n${"Ordinary research prose about widget sprockets and gizmos. ".repeat(10)}\n`);
    for (const [how, root] of Object.entries(ROOTS)) {
      const r = spawnSync(process.execPath, [join(root, "brain-save", "hooks", "unsaved-reminder.mjs")], { env: { ...env, BRAIN_SAVE_STATE_DIR: mkdtempSync(join(TMP, "hs-")) }, input: JSON.stringify({ session_id: sid, cwd: "/nonexistent" }), encoding: "utf8", timeout: 30000 });
      assert.equal(r.status, 0, how);
      assert.match(r.stdout, /"systemMessage":"brain-save: 1 document\(s\) from this session are not in the brain yet: research-notes\.md/, `${how}: ${r.stdout}`);
    }
  } finally { rmSync(top, { recursive: true, force: true }); }
});

test("round 3 #1: isEntryPoint compares the real, percent-encoded URL (unit)", () => {
  const real = join(SKILLS, "brain-save", "brain-save.mjs");
  const url = pathToFileURL(real).href;
  assert.equal(isEntryPoint(url, real), true);
  assert.equal(isEntryPoint(url, join(LINKED, "brain-save", "brain-save.mjs")), true, "through a symlinked directory");
  assert.equal(isEntryPoint(pathToFileURL(join(SPACED, "brain-save", "brain-save.mjs")).href, join(SPACED, "brain-save", "brain-save.mjs")), true, "a path with a space (%20 in the URL)");
  assert.equal(isEntryPoint(url, undefined), false);
  assert.equal(isEntryPoint(url, "/nonexistent/x.mjs"), false);
  assert.equal(isEntryPoint(url, join(HERE, "round3-cli.test.mjs")), false, "imported by another module");
});

test("round 3 #4: the Stop hook stays silent for the clo-personal, cfo, clo and capital seats", async () => {
  const sid = `bs3s-${process.pid}-${Date.now()}`;
  const top = mkdtempSync(join(TMP, "claude-seat-"));
  const sp = join(top, "proj", sid, "scratchpad");
  mkdirSync(sp, { recursive: true });
  writeFileSync(join(sp, "memo.md"), `# Seat test memo\n\n${"Ordinary prose for the reminder test. ".repeat(12)}\n`);
  const saved = { KB_AGENT: process.env.KB_AGENT, STATE: process.env.BRAIN_SAVE_STATE_DIR };
  try {
    for (const seat of ["clo-personal", "cfo", "clo", "capital", "CLO-Personal"]) {
      process.env.KB_AGENT = seat;
      process.env.BRAIN_SAVE_STATE_DIR = mkdtempSync(join(TMP, "st-"));
      assert.equal(await hookRun(JSON.stringify({ session_id: sid, cwd: "" }), { tmpRoot: TMP }), null, seat);
    }
    process.env.KB_AGENT = "developer";
    process.env.BRAIN_SAVE_STATE_DIR = mkdtempSync(join(TMP, "st-"));
    const out = await hookRun(JSON.stringify({ session_id: sid, cwd: "" }), { tmpRoot: TMP });
    assert.match(out.systemMessage, /memo\.md/, "an ordinary seat is still reminded");
  } finally {
    if (saved.KB_AGENT == null) delete process.env.KB_AGENT; else process.env.KB_AGENT = saved.KB_AGENT;
    if (saved.STATE == null) delete process.env.BRAIN_SAVE_STATE_DIR; else process.env.BRAIN_SAVE_STATE_DIR = saved.STATE;
  }
});
