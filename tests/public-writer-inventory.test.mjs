// PUBLIC WRITER INVENTORY. This repo is public. Owner decision 2026-10-10: finance, legal, investor, deal,
// inside information, privileged, PHI and personal findings never go to a public repo; they go to the private ledger
// (memory_remember with type finding, or task_create). The fail-closed gate is setup/public-write-gate.mjs.
//
// THE BUG CLASS THIS GUARDS: a gate on the writers we know about protects nothing the day someone adds a new
// writer (a new workflow that commits its output, a new script that opens issues) and forgets the gate. So
// this test does not trust a hand-kept list. It SCANS the repo for code that can write to a public GitHub repo
// and fails unless each writer is either gated or listed in setup/public-writers.json with a written reason.
//
//   1. The three record writers (the ledger, the fleet bulletin, fleet dispatch --spawn) reference the gate.
//   2. Every workflow that commits and pushes calls the gate, with `|| exit 1`, BEFORE its first git add,
//      commit or push, in the same `run:` block (the default shell does not stop on a failed pipe or an
//      ignored status, so the explicit `|| exit 1` is what makes the refusal real).
//   3. Every other detected writer is gated or exempt with a reason; exemptions must still match the code.
//
// The scan reads code and workflow files only. It skips the owner handled paths (the findings ledger file,
// projects/ and dream-team/clo/) so it never opens them, and it skips test directories.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
// An em dash or an en dash, built from code points so this file itself contains neither.
const DASH = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`);
const GATE = "setup/public-write-gate.mjs";
const MARKER = "public-write-gate";
const REGISTRY_PATH = join(ROOT, "setup/public-writers.json");
const registry = JSON.parse(readFileSync(REGISTRY_PATH, "utf8"));
const exemptByFile = new Map((registry.exempt || []).map((e) => [e.file, e]));

// Paths the owner handles personally. They are never scanned, read or edited by this change.
const OWNER_HANDLED = [/^projects\//, /^dream-team\/clo\//];
const SKIP_DIR = new Set(["node_modules", ".git"]);
const CODE_EXT = new Set([".mjs", ".js", ".cjs", ".ts", ".sh", ".py"]);

function* walk(dir, rel = "") {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIR.has(entry.name)) continue;
    const abs = join(dir, entry.name);
    const r = rel ? `${rel}/${entry.name}` : entry.name;
    if (OWNER_HANDLED.some((re) => re.test(entry.isDirectory() ? `${r}/` : r))) continue;
    if (entry.isDirectory()) yield* walk(abs, r);
    else yield r;
  }
}

/** Drop whole-line comments so prose that merely mentions a command is not mistaken for the command. */
function stripLineComments(text, ext) {
  const hash = ext === ".yml" || ext === ".yaml" || ext === ".sh" || ext === ".py";
  return text.replace(hash ? /^[ \t]*#.*$/gm : /^[ \t]*\/\/.*$/gm, "");
}

const WORKFLOW_WRITES = [
  [/\bgit\s+push\b/, "git push"],
  [/\bgh\s+(?:pr|issue)\s+(?:create|comment)\b/, "gh pr or issue write"],
  [/\bgh\s+api\b[^\n]*(?:-X|--method)\s*(?:POST|PUT|PATCH|DELETE)\b/i, "gh api write"],
  [/createOrUpdateFileContents|issues\.(?:create|createComment|update|updateComment)\b|pulls\.create\b|git\.(?:createCommit|updateRef)\b/, "octokit write"],
  [/--github-issue\b/, "pager issue channel"],
  [/peter-evans\/create-pull-request|stefanzweifel\/git-auto-commit-action|EndBug\/add-and-commit|ad-m\/github-push-action/, "push action"],
];
const CODE_WRITES = [
  [/\bgit\s+push\b/, "git push"],
  [/\[\s*["']push["']\s*,/, "spawned git push"],
  [/\bgh\s+(?:pr|issue)\s+(?:create|comment)\b/, "gh pr or issue write"],
  [/\bgh\s+api\b[^\n]*(?:-X|--method)\s*(?:POST|PUT|PATCH|DELETE)\b/i, "gh api write"],
  [/createOrUpdateFileContents|issues\.(?:create|createComment|update|updateComment)\b|pulls\.create\b/, "octokit write"],
];

/** Every workflow and code file that can write to a GitHub repo, with what matched. */
function detectWriters() {
  const found = new Map();
  for (const rel of walk(ROOT)) {
    const ext = extname(rel);
    const isWorkflow = rel.startsWith(".github/workflows/") && (ext === ".yml" || ext === ".yaml");
    if (!isWorkflow && !CODE_EXT.has(ext)) continue;
    if (/\.test\.mjs$/.test(rel) || /(^|\/)(?:tests?|__tests__|fixtures?)\//.test(rel)) continue;
    if (rel === GATE) continue; // the gate itself has no write capability
    let text;
    try { text = stripLineComments(readFileSync(join(ROOT, rel), "utf8"), ext); } catch { continue; }
    const hits = [];
    for (const [re, label] of isWorkflow ? WORKFLOW_WRITES : CODE_WRITES) if (re.test(text)) hits.push(label);
    if (!isWorkflow) {
      if (/\/contents\//.test(text) && /["']PUT["']/.test(text)) hits.push("contents API PUT");
      if (/\/(?:issues|pulls)\b/.test(text) && /method:\s*["']POST["']/.test(text)) hits.push("issues or pulls POST");
      if (/["']request["']\s*,\s*["'](?:POST|PUT|PATCH|DELETE)["']/.test(text)) hits.push("gh-app request write");
    }
    if (hits.length) found.set(rel, { isWorkflow, hits, text });
  }
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
const GATE_CALL = /node\s+(?:\S*\/)?setup\/public-write-gate\.mjs\s+(?:files|check)\b[^\n]*\|\|\s*exit\s+1\b/;

test("the registry is well formed: each exemption names an existing file and gives a real reason", () => {
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
  }
  assert.ok(!DASH.test(registry._about || ""), "no em or en dashes in the registry description");
});

test("the three record writers reference the public-write gate in code, not only in comments", () => {
  const recordWriters = ["skills/regression-ledger/ledger.mjs", "setup/bulletin.mjs", "skills/fleet-dispatch/dispatch.mjs"];
  for (const rel of recordWriters) {
    assert.ok(existsSync(join(ROOT, rel)), `${rel} exists`);
    const code = stripLineComments(readFileSync(join(ROOT, rel), "utf8"), ".mjs");
    assert.ok(code.includes(MARKER), `${rel} must call the public-write gate before it writes to a public repo`);
    assert.ok(!exemptByFile.has(rel), `${rel} is a record writer and cannot be exempt`);
  }
});

test("every detected writer is gated or exempt with a reason", () => {
  const ungated = [];
  for (const [rel, info] of WRITERS) {
    if (exemptByFile.has(rel)) continue;
    if (info.text.includes(MARKER)) continue;
    ungated.push(`${rel} (${info.hits.join(", ")})`);
  }
  assert.deepEqual(
    ungated,
    [],
    `These files can write to a GitHub repo but neither call ${GATE} nor appear in setup/public-writers.json.\n` +
      `This repo is public, so a writer that records findings must pass the gate first: finance, legal, investor, deal, inside information, privileged, PHI and personal findings go in the private ledger (memory_remember with type finding, or task_create), never here.\n` +
      `Gate it, or add an exemption with a reason if it writes no findings or lane-tagged records:\n  - ${ungated.join("\n  - ")}`,
  );
});

test("every exemption still matches a writer (a stale exemption hides nothing but should be removed)", () => {
  const stale = [];
  for (const e of registry.exempt) {
    if (!WRITERS.has(e.file)) stale.push(e.file);
  }
  assert.deepEqual(stale, [], `These exemptions no longer match any write pattern; remove them from setup/public-writers.json:\n  - ${stale.join("\n  - ")}`);
});

test("every workflow step that commits and pushes calls the gate with || exit 1 before its first git add, commit or push", () => {
  const offenders = [];
  let checked = 0;
  for (const [rel, info] of WRITERS) {
    if (!info.isWorkflow || exemptByFile.has(rel)) continue;
    for (const block of runBlocks(info.text)) {
      if (!/\bgit\s+push\b/.test(block)) continue;
      checked += 1;
      const firstWrite = block.search(/\bgit\s+(?:add|commit|push)\b/);
      const gate = block.match(GATE_CALL);
      if (!gate || gate.index > firstWrite) offenders.push(rel);
    }
  }
  assert.ok(checked >= 6, `expected to check at least the six gated push steps, checked ${checked}`);
  assert.deepEqual(
    [...new Set(offenders)],
    [],
    "A workflow that pushes to this public repo must run `node setup/public-write-gate.mjs files --lane <lane> <file> || exit 1` earlier in the same run block, before git add, commit or push:\n  - " +
      [...new Set(offenders)].join("\n  - "),
  );
});

test("a gate call in a workflow always names a lane (no lane means the gate refuses, so it would never push)", () => {
  const missing = [];
  for (const [rel, info] of WRITERS) {
    if (!info.isWorkflow) continue;
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

test("the detector works: a plain writer is found, a comment-only mention is not", () => {
  assert.equal(stripLineComments("# git push origin main\nnode x.mjs", ".yml").includes("git push"), false);
  assert.equal(stripLineComments("// git push origin main\nconst a = 1;", ".mjs").includes("git push"), false);
  assert.ok(WORKFLOW_WRITES.some(([re]) => re.test("git push -u origin HEAD")));
  assert.ok(runBlocks("steps:\n  - name: x\n    run: |\n      git add a\n      git push\n    env:\n      A: b\n")[0].includes("git push"));
  assert.ok(!runBlocks("steps:\n  - name: x\n    run: |\n      git add a\n    env:\n      A: git push\n")[0].includes("git push"));
});
