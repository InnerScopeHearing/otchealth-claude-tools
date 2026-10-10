// PUBLIC WRITER INVENTORY. This repo is public. Owner decision 2026-10-10: finance, legal, investor, deal,
// inside information, privileged, PHI and personal findings never go to a public repo; they go to the private ledger
// (memory_remember with type finding, or task_create). The fail-closed gate is setup/public-write-gate.mjs.
//
// THE BUG CLASS THIS GUARDS: a gate on the writers we know about protects nothing the day someone adds a new
// writer (a new workflow that commits its output, a new script that opens issues) and forgets the gate. So this
// test does not trust a hand kept list. It SCANS the repo for files that can write to a GitHub repo and fails
// unless each one calls the gate or is listed in setup/public-writers.json with a written reason.
//
// WHAT THIS TEST IS: A TRIPWIRE, NOT A PROOF.
//   It guarantees that every file in the scanned set that matches a known way of writing to GitHub (the rule table
//   in tests/lib/public-writer-rules.mjs) either shows evidence of calling the gate or is registered, that a
//   registered file is pinned to the shapes that were reviewed (new write code added to it fails CI), that each
//   workflow step that writes calls the gate with `|| exit 1` BEFORE its first write, that the three record
//   writers call the gate in code, and that the detector itself still catches a corpus of more than a hundred
//   realistic writers and none of the look-alikes.
//   It does NOT see: a write whose verb or URL is built at run time or lives in another file; a new caller of a
//   helper that is already registered (unless the caller names a write verb itself); languages and file types it
//   does not scan; writes made from another repository, by a person, or through the gateway GitHub tools (a ring
//   lane agent can still publish to a public repo that way, and only a check inside the gateway can stop it);
//   or what a workflow prints to its public logs, artifacts and job summaries. LIMITS in the rules module pins the
//   first group as executable documentation. A new writer in any of those forms needs a human reviewer.
//
// The scan reads code, workflow and script files only. It never reads the owner handled paths (the findings ledger
// file, projects/ and dream-team/clo/), and it skips test directories and node_modules.
import test from "node:test";
import assert from "node:assert/strict";
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GATE_EVIDENCE, LIMITS, RULE_IDS, detect, firstWriteLine, gateCallLine, prepare, scanKind } from "./lib/public-writer-rules.mjs";
import { NEGATIVE, POSITIVE } from "./lib/public-writer-corpus.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
// An em dash or an en dash, built from code points so this file itself contains neither.
const DASH = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`);
const GATE = "setup/public-write-gate.mjs";
const REGISTRY_PATH = join(ROOT, "setup/public-writers.json");
const registry = JSON.parse(readFileSync(REGISTRY_PATH, "utf8"));
const exemptByFile = new Map((registry.exempt || []).map((e) => [e.file, e]));

// Paths the owner handles personally. They are never scanned, read or edited by this change.
const OWNER_HANDLED = [/^projects\//, /^dream-team\/clo\//, /^FINDINGS-LEDGER\.md$/];
const SKIP_DIR = new Set(["node_modules", ".git"]);
// Not scanned: the gate itself (it has no write capability) and the detector (its rule text names every write).
const NEVER_SCANNED = new Set([GATE]);

function* walk(dir, rel = "") {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIR.has(entry.name)) continue;
    const r = rel ? `${rel}/${entry.name}` : entry.name;
    if (OWNER_HANDLED.some((re) => re.test(entry.isDirectory() ? `${r}/` : r))) continue;
    if (entry.isDirectory()) yield* walk(join(dir, entry.name), r);
    else if (entry.isFile()) yield r; // symbolic links are not followed
  }
}

function startsWithShebang(abs) {
  let fd;
  try {
    fd = openSync(abs, "r");
    const b = Buffer.alloc(2);
    readSync(fd, b, 0, 2, 0);
    return b.toString() === "#!";
  } catch { return false; } finally { if (fd !== undefined) try { closeSync(fd); } catch { /* ignore */ } }
}

/** Every scanned file that matches at least one write rule: { kind, ext, hits, text } with comments removed. */
function detectWriters() {
  const found = new Map();
  let scanned = 0;
  for (const rel of walk(ROOT)) {
    if (NEVER_SCANNED.has(rel)) continue;
    const abs = join(ROOT, rel);
    const ext = extname(rel).toLowerCase();
    const isYaml = ext === ".yml" || ext === ".yaml";
    let yamlText = "";
    if (isYaml && !rel.includes(".github/")) { try { yamlText = readFileSync(abs, "utf8"); } catch { continue; } }
    const kind = scanKind(rel, { shebang: ext === "" && startsWithShebang(abs), yamlText });
    if (!kind) continue;
    let raw;
    try { raw = readFileSync(abs, "utf8"); } catch { continue; }
    scanned += 1;
    const hits = detect(raw, { ext, isWorkflow: kind === "workflow" });
    if (hits.length) found.set(rel, { kind, ext, hits, text: prepare(raw, ext) });
  }
  found.scanned = scanned;
  return found;
}

/** The text of each `run:` block in a workflow (block scalars and one line commands). */
function runBlocks(src) {
  const lines = src.split("\n");
  const blocks = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(/^(\s*)(-\s+)?run:\s*(.*)$/);
    if (!m) continue;
    const keyIndent = m[1].length + (m[2] ? m[2].length : 0);
    const rest = m[3].trim();
    if (/^[|>][+-]?$/.test(rest)) {
      const body = [];
      let j = i + 1;
      for (; j < lines.length; j += 1) {
        const l = lines[j];
        if (l.trim() !== "" && l.match(/^(\s*)/)[1].length <= keyIndent) break;
        body.push(l);
      }
      blocks.push(body.join("\n"));
      i = j - 1;
    } else if (rest) {
      blocks.push(rest);
    }
  }
  return blocks;
}

const WRITERS = detectWriters();

// ---- the registry ----

test("the registry is well formed: each exemption names an existing file, a real reason and the reviewed shapes", () => {
  assert.equal(registry.gate, GATE);
  assert.ok(existsSync(join(ROOT, GATE)), "the gate module exists");
  assert.ok(Array.isArray(registry.exempt));
  const seen = new Set();
  for (const e of registry.exempt) {
    assert.equal(typeof e.file, "string", "exempt entry needs a file");
    assert.ok(!seen.has(e.file), `duplicate exemption: ${e.file}`);
    seen.add(e.file);
    assert.ok(existsSync(join(ROOT, e.file)), `exempt file does not exist (remove the entry): ${e.file}`);
    assert.equal(typeof e.reason, "string");
    assert.ok(e.reason.trim().length >= 20, `an exemption needs a written reason: ${e.file}`);
    assert.ok(!DASH.test(e.reason), `no em or en dashes in a reason: ${e.file}`);
    assert.ok(Array.isArray(e.rules) && e.rules.length > 0, `an exemption lists the write shapes that were reviewed: ${e.file}`);
    for (const id of e.rules) assert.ok(RULE_IDS.includes(id), `unknown rule id "${id}" in the exemption for ${e.file}`);
    assert.ok(!OWNER_HANDLED.some((re) => re.test(e.file)), `an owner handled path cannot be listed: ${e.file}`);
  }
  assert.ok(!DASH.test(registry._about || ""), "no em or en dashes in the registry description");
  assert.match(registry._about || "", /tripwire/i, "the registry description states that this is a tripwire");
});

// ---- the scan ----

test("the scan covers the repo: workflows, scripts and source in the scanned languages, and finds the known writers", () => {
  assert.ok(WRITERS.scanned > 300, `expected to scan hundreds of files, scanned ${WRITERS.scanned}`);
  const writerKinds = new Set([...WRITERS.values()].map((w) => w.kind));
  assert.ok(writerKinds.has("workflow") && writerKinds.has("code"), "both workflows and code contain writers");
  // Calibration: the detector must see the writers we already know about, or it is not looking at the right things.
  for (const rel of [
    "skills/regression-ledger/ledger.mjs", "setup/bulletin.mjs", "skills/fleet-dispatch/dispatch.mjs", // the three record writers
    "skills/github-app/gh-app.mjs", "setup/alert-issue.mjs", "skills/agent-evals/selfrepair.mjs", // helpers and a PR opener
    ".github/workflows/autonomous-run.yml", ".github/workflows/diag-writepath-test.yml", // agent runner, gated diagnostic
  ]) {
    assert.ok(WRITERS.has(rel), `the detector should see ${rel} as a writer`);
  }
});

test("the three record writers call the gate in code (not only in comments) and cannot be exempt", () => {
  const recordWriters = ["skills/regression-ledger/ledger.mjs", "setup/bulletin.mjs", "skills/fleet-dispatch/dispatch.mjs"];
  for (const rel of recordWriters) {
    assert.ok(existsSync(join(ROOT, rel)), `${rel} exists`);
    const code = prepare(readFileSync(join(ROOT, rel), "utf8"), ".mjs");
    assert.ok(GATE_EVIDENCE.test(code), `${rel} must call the public-write gate before it writes to a public repo`);
    assert.ok(!exemptByFile.has(rel), `${rel} is a record writer and cannot be exempt`);
  }
});

test("every detected writer is gated or exempt with a reason, and an exempt file is pinned to the shapes that were reviewed", () => {
  const ungated = [];
  const drifted = [];
  for (const [rel, info] of WRITERS) {
    const ex = exemptByFile.get(rel);
    if (ex) {
      const unreviewed = info.hits.filter((h) => !ex.rules.includes(h));
      if (unreviewed.length) drifted.push(`${rel}: now also matches ${unreviewed.join("; ")}`);
      continue;
    }
    if (GATE_EVIDENCE.test(info.text)) continue;
    ungated.push(`${rel} (${info.hits.join("; ")})`);
  }
  assert.deepEqual(
    ungated,
    [],
    `These files can write to a GitHub repo but neither call ${GATE} nor appear in setup/public-writers.json.\n` +
      "This repo is public, so a writer that records findings must pass the gate first: finance, legal, investor, deal, inside information, privileged, PHI and personal findings go in the private ledger (memory_remember with type finding, or task_create), never here.\n" +
      `Gate it (a real call, not a comment), or add an exemption with a reason and the rule ids it covers, if it writes no findings or lane-tagged records:\n  - ${ungated.join("\n  - ")}`,
  );
  assert.deepEqual(
    drifted,
    [],
    "These exempt files now contain a write shape that was never reviewed. Gate the new code, or review it and add the rule id to the exemption:\n  - " + drifted.join("\n  - "),
  );
});

test("every exemption still matches a writer (a stale exemption hides nothing but should be removed)", () => {
  const stale = [];
  for (const e of registry.exempt) {
    if (!WRITERS.has(e.file)) stale.push(e.file);
  }
  assert.deepEqual(stale, [], `These exemptions no longer match any write pattern; remove them from setup/public-writers.json:\n  - ${stale.join("\n  - ")}`);
});

test("every workflow step that writes calls the gate with || exit 1 before its first write, in the same run block", () => {
  const offenders = [];
  let checked = 0;
  for (const [rel, info] of WRITERS) {
    if (info.kind !== "workflow" || exemptByFile.has(rel)) continue;
    for (const block of runBlocks(info.text)) {
      if (detect(block, { ext: "", isWorkflow: false }).length === 0) continue; // this step writes nothing
      checked += 1;
      const first = firstWriteLine(block);
      const gate = gateCallLine(block);
      if (gate < 0 || gate > first) offenders.push(`${rel}: a step writes at line ${first + 1} of its run block and ${gate < 0 ? "never calls the gate" : `only calls the gate at line ${gate + 1}`}`);
    }
  }
  assert.ok(checked >= 6, `expected to check at least the six gated push steps, checked ${checked}`);
  assert.deepEqual(
    offenders,
    [],
    "A workflow step that writes to this public repo must run `node setup/public-write-gate.mjs files --lane <lane> <file> || exit 1` earlier in the same run block, before git add, commit, push or any API write:\n  - " + offenders.join("\n  - "),
  );
});

test("a gate call in a workflow always names a lane (no lane means the gate refuses, so it would never push)", () => {
  const missing = [];
  for (const [rel, info] of WRITERS) {
    if (info.kind !== "workflow") continue;
    for (const m of info.text.matchAll(/node\s+(?:\S*\/)?setup\/public-write-gate\.mjs\s+(?:files|check)\b[^\n]*/g)) {
      if (!/--lane\s+\S+/.test(m[0])) missing.push(rel);
    }
  }
  assert.deepEqual(missing, [], "gate calls without --lane:\n  - " + missing.join("\n  - "));
});

test("the scan never reads the owner handled paths", () => {
  for (const rel of WRITERS.keys()) {
    assert.ok(!OWNER_HANDLED.some((re) => re.test(rel)), rel);
  }
  const walked = [...walk(ROOT)];
  assert.ok(!walked.some((rel) => OWNER_HANDLED.some((re) => re.test(rel))), "owner handled paths are skipped by the walker");
});

// ---- the detector: measured against a corpus, with its limits pinned ----

const extOf = (file) => extname(file).toLowerCase();
const asWorkflow = (file) => file.endsWith(".yml") || file.endsWith(".yaml");

test("the detector catches every realistic writer in the corpus (more than a hundred shapes)", () => {
  assert.ok(POSITIVE.length >= 100, `the corpus should hold at least 100 writers, holds ${POSITIVE.length}`);
  const missed = POSITIVE.filter((c) => detect(c.text, { ext: extOf(c.file), isWorkflow: asWorkflow(c.file) }).length === 0).map((c) => c.name);
  assert.deepEqual(missed, [], `the detector missed these writers:\n  - ${missed.join("\n  - ")}`);
});

test("the detector does not flag the look-alikes in the corpus (reads, comments, array pushes, other hosts)", () => {
  assert.ok(NEGATIVE.length >= 25, `the corpus should hold at least 25 look-alikes, holds ${NEGATIVE.length}`);
  const flagged = [];
  for (const c of NEGATIVE) {
    const hits = detect(c.text, { ext: extOf(c.file), isWorkflow: asWorkflow(c.file) });
    if (hits.length) flagged.push(`${c.name} <- ${hits.join("; ")}`);
  }
  assert.deepEqual(flagged, [], `the detector flagged things that are not writes:\n  - ${flagged.join("\n  - ")}`);
});

test("every rule in the table is exercised by at least one corpus writer (no dead rule)", () => {
  const hit = new Set();
  for (const c of POSITIVE) for (const id of detect(c.text, { ext: extOf(c.file), isWorkflow: asWorkflow(c.file) })) hit.add(id);
  const dead = RULE_IDS.filter((id) => !hit.has(id));
  assert.deepEqual(dead, [], `these rules match nothing in the corpus; add a writer that needs each one:\n  - ${dead.join("\n  - ")}`);
});

test("the stated limits are real: each pinned shape is still NOT detected (widen the rules, then delete the entry and update the wording)", () => {
  assert.ok(LIMITS.length >= 4);
  for (const limit of LIMITS) {
    if (limit.unscanned) {
      assert.equal(scanKind(limit.file), null, `${limit.why}: the file type is now scanned`);
      continue;
    }
    const hits = detect(limit.text, { ext: extOf(limit.file), isWorkflow: false });
    assert.deepEqual(hits, [], `This shape is now detected (${limit.why}). Delete it from LIMITS in tests/lib/public-writer-rules.mjs and update the "cannot see" wording in CLAUDE.md and setup/public-writers.json.`);
  }
});

test("scanKind: workflows, composite actions, scripts and shebang files are scanned; tests, fixtures and other types are not", () => {
  assert.equal(scanKind(".github/workflows/x.yml"), "workflow");
  assert.equal(scanKind(".github/workflows/x.yaml"), "workflow");
  assert.equal(scanKind(".github/actions/x/action.yml"), "workflow");
  assert.equal(scanKind("dream-team/golden-path/templates/golden-path/.github/workflows/ci.yml"), "workflow");
  assert.equal(scanKind("skills/x/ci.yml", { yamlText: "name: x\njobs:\n  j:\n    steps:\n      - run: echo\n" }), "workflow", "a YAML file with the shape of a workflow");
  assert.equal(scanKind("skills/x/config.yaml", { yamlText: "name: x\nitems:\n  - a\n" }), null, "other YAML is data");
  for (const f of ["a.mjs", "a.js", "a.cjs", "a.mts", "a.cts", "a.ts", "a.tsx", "a.sh", "a.bash", "a.py", "a.ps1", "a.rb", "a.mk", "package.json", "Makefile", "x/y/z.mjs"]) {
    assert.equal(scanKind(f), "code", f);
  }
  assert.equal(scanKind("skills/x/scripts/task-brief", { shebang: true }), "code", "an extensionless script with a shebang");
  assert.equal(scanKind("skills/x/LICENSE", { shebang: false }), null);
  for (const f of ["a.test.mjs", "tests/a.mjs", "skills/x/tests/a.mjs", "skills/x/__tests__/a.mjs", "skills/x/fixtures/a.sh", "skills/x/node_modules/y/a.js", "README.md", "a.go", "a.java", "a.rs", "a.json", "a.png"]) {
    assert.equal(scanKind(f), null, f);
  }
});

test("prepare drops comment-only mentions and joins continued lines, so prose is not mistaken for a command", () => {
  assert.equal(prepare("# git push origin main\nnode x.mjs", ".yml").includes("git push"), false);
  assert.equal(prepare("// git push origin main\nconst a = 1;", ".mjs").includes("git push"), false);
  assert.equal(prepare("/**\n * git push origin main\n */\nconst a = 1;", ".mjs").includes("git push"), false);
  assert.ok(prepare('const s = "/*";\nexecSync("git push");', ".mjs").includes("git push"), "a block comment opener inside a string hides nothing");
  assert.ok(prepare("curl -s \\\n  -X POST \\\n  https://x", ".sh").replace(/\s+/g, " ").includes("curl -s -X POST https://x"));
  assert.ok(detect("git push -u origin HEAD", { ext: ".sh" }).includes("git push"));
  assert.deepEqual(detect("# git push origin main\necho ok", { ext: ".sh" }), []);
});

test("firstWriteLine and gateCallLine order a step: the gate must come before the first write", () => {
  const good = "node setup/public-write-gate.mjs files --lane cto --writer w out.md || exit 1\ngit add out.md\ngit commit -m x\ngit push origin HEAD";
  assert.equal(gateCallLine(good), 0);
  assert.equal(firstWriteLine(good), 1);
  const late = "git add out.md\ngit commit -m x\nnode setup/public-write-gate.mjs files --lane cto out.md || exit 1\ngit push origin HEAD";
  assert.ok(gateCallLine(late) > firstWriteLine(late), "gate after git add is too late");
  const noExit = "node setup/public-write-gate.mjs files --lane cto out.md\ngit push origin HEAD";
  assert.equal(gateCallLine(noExit), -1, "a gate call without || exit 1 does not count");
  const api = 'curl -s -X POST -H "A: b" https://api.github.com/repos/$R/issues -d "$B"';
  assert.equal(firstWriteLine(api), 0);
  assert.equal(firstWriteLine("echo hello\nls"), -1);
});

test("GATE_EVIDENCE needs a real call: a comment or a string that only mentions the gate is not evidence", () => {
  const real = [
    ["node setup/public-write-gate.mjs files --lane cto --writer w out.md || exit 1", ".sh"],
    ["gate.assertPublicWriteAllowed(entry, 'writer');", ".mjs"],
    ["const decision = evaluatePublicWrite(entry);", ".mjs"],
    ['gate = await import("../../setup/public-write-gate.mjs");', ".mjs"],
    ['import { assertPublicWriteAllowed } from "../../setup/public-write-gate.mjs";', ".mjs"],
  ];
  for (const [text, ext] of real) assert.ok(GATE_EVIDENCE.test(prepare(text, ext)), text);
  const fake = [
    ["// this passes setup/public-write-gate.mjs first\nconst a = 1;", ".mjs"],
    ["# node setup/public-write-gate.mjs files --lane cto x || exit 1\necho ok", ".sh"],
    ["# node setup/public-write-gate.mjs files --lane cto x || exit 1\necho ok", ".yml"],
    ['const note = "the public-write-gate is documented elsewhere";', ".mjs"],
    ["/** assertPublicWriteAllowed(entry) is called by the writer */\nconst a = 1;", ".mjs"],
    ["/**\n * assertPublicWriteAllowed(entry) is called by the writer\n */\nconst a = 1;", ".mjs"],
  ];
  for (const [text, ext] of fake) assert.ok(!GATE_EVIDENCE.test(prepare(text, ext)), text);
});

test("runBlocks reads block scalars and one line commands, and stops at the next key", () => {
  assert.ok(runBlocks("steps:\n  - name: x\n    run: |\n      git add a\n      git push\n    env:\n      A: b\n")[0].includes("git push"));
  assert.ok(!runBlocks("steps:\n  - name: x\n    run: |\n      git add a\n    env:\n      A: git push\n")[0].includes("git push"));
  assert.deepEqual(runBlocks("steps:\n  - run: echo hi\n"), ["echo hi"]);
});
