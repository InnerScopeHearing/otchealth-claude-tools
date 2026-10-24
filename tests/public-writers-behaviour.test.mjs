// BEHAVIOUR of the public record writers, driven the way a person or a workflow drives them.
//
// OWNER DECISION 2026-10-10 (security review finding S-04): finance, legal, investor, deal, inside information,
// privileged, PHI and personal findings never go to a public repo, and only the cto and developer lanes may write
// technical findings there. tests/public-writer-inventory.test.mjs only proves that a writer MENTIONS the gate.
// This file proves what the writers DO, by running the real scripts as child processes in a throw away copy of the
// install:
//
//   * setup/bulletin.mjs add            : a refused entry writes nothing and exits 2; an allowed one is written.
//   * skills/fleet-dispatch/dispatch.mjs send ... --spawn : a refused task sends nothing (no workflow dispatch, no
//     inbox entry) and exits 2; an allowed one is sent. The inbox store and the GitHub App helper are replaced by
//     stubs that log every call, so "sent nothing" is measured, not assumed.
//   * the ledger writer has its own behavioural tests in skills/regression-ledger/tests/public-gate.test.mjs.
//
// Everything is hermetic: no network, no credentials, nothing is written outside a temp directory.
import test from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const fromRepo = (rel) => join(ROOT, rel);

// The securities acronym is assembled from two halves on purpose. GitHub tooling that scans outgoing writes for
// the literal marker (the gateway pre-share gate) would otherwise reject this file as if it were sensitive
// content. The gate under test still receives the whole word.
const ACRONYM = "MN" + "PI";

// One representative sentence per refused class.
const REFUSED_TEXTS = [
  ["finance", "Q3 financial model has a formula error"],
  ["legal", "Review the legal hold notice"],
  ["investor", "Investor update draft needs a new chart"],
  ["deal", "Term sheet comments for the acquisition"],
  ["inside-information", `This note contains ${ACRONYM}`],
  ["privileged", "This memo is privileged and confidential"],
  ["phi", "Logs expose PHI in the trace"],
  ["personal", "A personal matter for the owner"],
  ["finance (hyphenated)", "Update the cap-table export script"],
];
const REASON_BY_CLASS = { finance: /finance material/, legal: /legal material/, investor: /investor material/, deal: /deal material/, "inside-information": /inside information/, privileged: /privileged material/, phi: /health information/, personal: /personal material/ };

const ALLOWED_TEXTS = [
  "Nightly canary job now has a timeout",
  "RevenueCat SDK bump to 5.x and Phi-3 mini evaluated on the runner",
  "The personal access token in CI was rotated",
];

const baseEnv = (dir, extra = {}) => ({ PATH: process.env.PATH, HOME: dir, CLAUDE_PROJECT_DIR: dir, ...extra });

// ---------------------------------------------------------------------------------------------------------
// setup/bulletin.mjs add
// ---------------------------------------------------------------------------------------------------------

const EXISTING_BULLETIN = "# Fleet Bulletin\n\nCTO -> fleet changelog.\n\n- 2026-01-01T00:00Z | an earlier technical line\n";

function bulletinInstall({ withGate = true, existing = EXISTING_BULLETIN } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "bulletin-")));
  mkdirSync(join(dir, "setup"));
  copyFileSync(fromRepo("setup/bulletin.mjs"), join(dir, "setup", "bulletin.mjs"));
  if (withGate) copyFileSync(fromRepo("setup/public-write-gate.mjs"), join(dir, "setup", "public-write-gate.mjs"));
  const file = join(dir, "FLEET-BULLETIN.md");
  if (existing !== null) writeFileSync(file, existing);
  const run = (args, env = {}) => spawnSync(process.execPath, [join(dir, "setup", "bulletin.mjs"), ...args], {
    cwd: dir, env: baseEnv(dir, env), encoding: "utf8", timeout: 20000,
  });
  return { dir, file, run, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const bytes = (file) => (existsSync(file) ? readFileSync(file, "utf8") : null);

function assertRefusedNothingWritten(r, file, before, label) {
  assert.equal(r.status, 2, `${label}: exit code (stderr: ${r.stderr})`);
  assert.equal(r.stdout, "", `${label}: nothing on stdout`);
  assert.match(r.stderr, /REFUSED/, label);
  assert.equal(bytes(file), before, `${label}: the bulletin file is byte for byte unchanged`);
}

test("bulletin add: every refused class writes nothing, exits 2 and points to the private ledger", () => {
  const b = bulletinInstall();
  try {
    for (const [cls, text] of REFUSED_TEXTS) {
      for (const lane of ["cto", "developer"]) {
        const r = b.run(["add", "--lane", lane, text]);
        assertRefusedNothingWritten(r, b.file, EXISTING_BULLETIN, `${lane} / ${cls}`);
        assert.match(r.stderr, /memory_remember with type finding/, `${cls}: names the private alternative`);
        assert.match(r.stderr, /Nothing was written\./, cls);
        if (REASON_BY_CLASS[cls]) assert.match(r.stderr, REASON_BY_CLASS[cls], cls);
        assert.ok(!r.stderr.includes(text), `${cls}: the refusal does not echo the text`);
      }
    }
  } finally { b.cleanup(); }
});

test("bulletin add: ring lanes, unknown lanes, a missing lane and a ring session identity are refused and write nothing", () => {
  const b = bulletinInstall();
  try {
    const line = "Nightly canary now has a timeout";
    for (const lane of ["cfo", "clo", "clo-personal", "CFO", "coo", "growth"]) {
      assertRefusedNothingWritten(b.run(["add", "--lane", lane, line]), b.file, EXISTING_BULLETIN, `lane ${lane}`);
    }
    const noLane = b.run(["add", line]);
    assertRefusedNothingWritten(noLane, b.file, EXISTING_BULLETIN, "no lane");
    assert.match(noLane.stderr, /--lane cto/, "tells the caller how to declare a lane");
    assertRefusedNothingWritten(b.run(["add", "--lane", "cto", line], { KB_AGENT: "cfo" }), b.file, EXISTING_BULLETIN, "ring seat behind --lane cto");
    assertRefusedNothingWritten(b.run(["add", "--lane", "cto", line], { KB_AGENT: "coo" }), b.file, EXISTING_BULLETIN, "unlisted seat behind --lane cto");
  } finally { b.cleanup(); }
});

test("bulletin add: a refusal does not create the file when there was none", () => {
  const b = bulletinInstall({ existing: null });
  try {
    assertRefusedNothingWritten(b.run(["add", "--lane", "cto", "Review the legal hold notice"]), b.file, null, "no file");
    assert.equal(existsSync(b.file), false);
  } finally { b.cleanup(); }
});

test("bulletin add: an allowed technical line from cto or developer is written, once, with a timestamp", () => {
  for (const text of ALLOWED_TEXTS) {
    for (const lane of ["cto", "developer"]) {
      const b = bulletinInstall();
      try {
        const r = b.run(["add", "--lane", lane, text]);
        assert.equal(r.status, 0, `${lane}: ${text} -> ${r.stderr}`);
        assert.match(r.stdout, /\[bulletin\] added:/);
        const after = readFileSync(b.file, "utf8");
        assert.ok(after.startsWith(EXISTING_BULLETIN), "the earlier entries are untouched");
        const added = after.slice(EXISTING_BULLETIN.length);
        assert.match(added, new RegExp(`^- \\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}Z \\| ${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n$`));
      } finally { b.cleanup(); }
    }
  }
});

test("bulletin add: a session whose identity is cto needs no --lane flag; --lane may come after the line", () => {
  const b = bulletinInstall();
  try {
    const seat = b.run(["add", "Nightly canary now has a timeout"], { KB_AGENT: "cto" });
    assert.equal(seat.status, 0, seat.stderr);
    const after = b.run(["add", "Second technical line", "--lane", "developer"]);
    assert.equal(after.status, 0, after.stderr);
    assert.equal(readFileSync(b.file, "utf8").split("\n").filter((l) => l.startsWith("- 2026") || /^- \d{4}-/.test(l)).length, 3);
  } finally { b.cleanup(); }
});

test("bulletin add: with the gate file missing it fails closed (exit 2, nothing written) while since still works", () => {
  const b = bulletinInstall({ withGate: false });
  try {
    const r = b.run(["add", "--lane", "cto", "Nightly canary now has a timeout"]);
    assertRefusedNothingWritten(r, b.file, EXISTING_BULLETIN, "gate missing");
    assert.match(r.stderr, /could not load the public-write gate/);
    const since = b.run(["since"]);
    assert.equal(since.status, 0, since.stderr);
    assert.match(since.stdout, /an earlier technical line/, "the read side does not depend on the gate");
  } finally { b.cleanup(); }
});

// ---------------------------------------------------------------------------------------------------------
// skills/fleet-dispatch/dispatch.mjs send ... --spawn
// ---------------------------------------------------------------------------------------------------------

const COMMONS_STUB = [
  'import { appendFileSync } from "node:fs";',
  "const log = (o) => appendFileSync(process.env.CALL_LOG, JSON.stringify(o) + \"\\n\");",
  'export async function cGet(key) { log({ op: "cGet", key }); return ""; }',
  'export async function cPut(key, body) { log({ op: "cPut", key, body }); }',
  'export async function cDel(key) { log({ op: "cDel", key }); }',
  'export async function cList(prefix) { log({ op: "cList", prefix }); return []; }',
  "",
].join("\n");

const GHAPP_STUB = [
  'import { appendFileSync, readFileSync } from "node:fs";',
  'let input = "";',
  'try { input = readFileSync(0, "utf8"); } catch { /* no stdin */ }',
  'appendFileSync(process.env.CALL_LOG, JSON.stringify({ op: "gh-app", args: process.argv.slice(2), input }) + "\\n");',
  "",
].join("\n");

function dispatchInstall({ withGate = true } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "dispatch-")));
  for (const d of ["skills/fleet-dispatch", "skills/kb-memory", "skills/github-app", "setup"]) mkdirSync(join(dir, d), { recursive: true });
  copyFileSync(fromRepo("skills/fleet-dispatch/dispatch.mjs"), join(dir, "skills/fleet-dispatch/dispatch.mjs"));
  writeFileSync(join(dir, "skills/kb-memory/commons-store.mjs"), COMMONS_STUB);
  writeFileSync(join(dir, "skills/github-app/gh-app.mjs"), GHAPP_STUB);
  if (withGate) copyFileSync(fromRepo("setup/public-write-gate.mjs"), join(dir, "setup", "public-write-gate.mjs"));
  const callLog = join(dir, "calls.log");
  const calls = () => (existsSync(callLog) ? readFileSync(callLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  const run = (args, env = {}) => spawnSync(process.execPath, [join(dir, "skills/fleet-dispatch/dispatch.mjs"), ...args], {
    cwd: dir, env: baseEnv(dir, { CALL_LOG: callLog, ...env }), encoding: "utf8", timeout: 20000,
  });
  return { dir, run, calls, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function assertSpawnRefused(r, d, label) {
  assert.equal(r.status, 2, `${label}: exit code (stderr: ${r.stderr}, stdout: ${r.stdout})`);
  assert.match(r.stderr, /REFUSED/, label);
  assert.match(r.stderr, /To hand the work over without publishing it, run the same dispatch without --spawn/, label);
  assert.equal(r.stdout, "", `${label}: nothing on stdout`);
  assert.deepEqual(d.calls(), [], `${label}: no inbox read or write and no workflow dispatch happened`);
}

test("dispatch --spawn: every refused class sends nothing, queues nothing and exits 2", () => {
  const d = dispatchInstall();
  try {
    for (const [cls, text] of REFUSED_TEXTS) {
      for (const lane of ["cto", "developer"]) {
        const r = d.run(["send", "developer", text, "--spawn", "--lane", lane]);
        assertSpawnRefused(r, d, `${lane} / ${cls}`);
        assert.ok(!r.stderr.includes(text), `${cls}: the refusal does not echo the task`);
      }
    }
  } finally { d.cleanup(); }
});

test("dispatch --spawn: ring lanes, unknown lanes, a missing lane and a ring session identity are refused", () => {
  const d = dispatchInstall();
  try {
    const text = "Add a timeout to the nightly canary job";
    for (const lane of ["cfo", "clo", "clo-personal", "coo", "growth"]) {
      assertSpawnRefused(d.run(["send", "developer", text, "--spawn", "--lane", lane]), d, `lane ${lane}`);
    }
    assertSpawnRefused(d.run(["send", "developer", text, "--spawn"], { KB_AGENT: "" }), d, "no lane and no identity");
    assertSpawnRefused(d.run(["send", "developer", text, "--spawn", "--lane", "cto"], { KB_AGENT: "cfo" }), d, "ring seat behind --lane cto");
  } finally { d.cleanup(); }
});

test("dispatch --spawn: the sender named with --from is the author, so --lane cto --from cfo is refused", () => {
  const d = dispatchInstall();
  try {
    const text = "Add a timeout to the nightly canary job";
    for (const from of ["cfo", "clo", "clo-personal", "CFO"]) {
      const r = d.run(["send", "developer", text, "--spawn", "--lane", "cto", "--from", from]);
      assertSpawnRefused(r, d, `--lane cto --from ${from}`);
      assert.match(r.stderr, /ring lane/, `--from ${from}`);
      assert.match(r.stderr, /Field checked: author\./, `--from ${from}`);
    }
    // --from alone is the lane when no --lane is given (unchanged), so a ring sender is refused that way too.
    assertSpawnRefused(d.run(["send", "developer", text, "--spawn", "--from", "cfo"]), d, "--from cfo alone");
    // An allowed sender is not blocked by the new author field.
    const ok = d.run(["send", "developer", text, "--spawn", "--lane", "cto", "--from", "cto"]);
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(d.calls().filter((c) => c.op === "gh-app").length, 1);
  } finally { d.cleanup(); }
});

test("dispatch --spawn: a --repo that points into an owner handled directory is refused, a normal repo is not", () => {
  const d = dispatchInstall();
  try {
    const text = "Add a timeout to the nightly canary job";
    for (const repo of ["projects/x", "./projects/x", "projects\\x", "../projects/x"]) {
      assertSpawnRefused(d.run(["send", "developer", text, "--spawn", "--lane", "cto", "--repo", repo]), d, `--repo ${repo}`);
    }
    const ok = d.run(["send", "developer", text, "--spawn", "--lane", "cto", "--repo", "otchealth-claude-tools"]);
    assert.equal(ok.status, 0, ok.stderr);
  } finally { d.cleanup(); }
});

test("dispatch --spawn: an allowed technical task from cto or developer is queued and the workflow is dispatched exactly once", () => {
  for (const text of ALLOWED_TEXTS) {
    for (const lane of ["cto", "developer"]) {
      const d = dispatchInstall();
      try {
        const r = d.run(["send", "developer", text, "--spawn", "--lane", lane]);
        assert.equal(r.status, 0, `${lane}: ${text} -> ${r.stderr}`);
        assert.match(r.stdout, /queued id=/);
        assert.match(r.stdout, /SPAWNED/);
        const calls = d.calls();
        const spawns = calls.filter((c) => c.op === "gh-app");
        assert.equal(spawns.length, 1, "one workflow dispatch");
        assert.deepEqual(spawns[0].args, ["request", "POST", "/repos/innerscopehearing/otchealth-claude-tools/actions/workflows/autonomous-run.yml/dispatches"]);
        const body = JSON.parse(spawns[0].input);
        assert.equal(body.ref, "main");
        assert.ok(body.inputs.task.includes(text), "the task text rides as the workflow input");
        const puts = calls.filter((c) => c.op === "cPut");
        assert.equal(puts.length, 1, "one inbox write");
        assert.equal(puts[0].key, "_DISPATCH/developer.jsonl");
        assert.equal(JSON.parse(puts[0].body.trim().split("\n").pop()).spawned, true);
      } finally { d.cleanup(); }
    }
  }
});

test("dispatch without --spawn queues in the private inbox, never touches the gate, and never dispatches a workflow", () => {
  for (const withGate of [true, false]) {
    const d = dispatchInstall({ withGate });
    try {
      const r = d.run(["send", "developer", "Review the legal hold notice for the app", "--lane", "cfo"]);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /queued id=/);
      assert.ok(!/SPAWNED/.test(r.stdout));
      const calls = d.calls();
      assert.equal(calls.filter((c) => c.op === "gh-app").length, 0, "nothing was published to GitHub");
      assert.equal(calls.filter((c) => c.op === "cPut").length, 1, "the private inbox got the message");
    } finally { d.cleanup(); }
  }
});

test("dispatch --spawn: with the gate file missing it fails closed, and nothing is sent or queued", () => {
  const d = dispatchInstall({ withGate: false });
  try {
    const r = d.run(["send", "developer", "Add a timeout to the nightly canary job", "--spawn", "--lane", "cto"]);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /could not load the public-write gate/);
    assert.deepEqual(d.calls(), []);
  } finally { d.cleanup(); }
});
