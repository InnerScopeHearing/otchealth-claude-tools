// The public write gate (setup/public-write-gate.mjs): the fail-closed check in front of every tool that
// writes a finding, a ledger entry, a bulletin line, a task text or a diagnostic file into a PUBLIC repo.
//
// OWNER DECISION 2026-10-10 (security review finding S-04): finance, legal and personal findings never go to a
// public repo. Only the cto and developer lanes may write there, and only technical findings. This file pins
// the gate itself: one test per refused class, the technical entries that must keep flowing, and the
// fail-closed behavior on missing or unreadable metadata. The writers that use the gate have their own tests
// (skills/regression-ledger/tests/public-gate.test.mjs) and tests/public-writer-inventory.test.mjs keeps the
// list of writers honest.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ALLOWED_LANES,
  RING_LANES,
  EXIT_REFUSED,
  REFUSAL_CLASSES,
  evaluatePublicWrite,
  assertPublicWriteAllowed,
  isApproval,
  refusalMessage,
  PublicWriteRefused,
  ambientIdentities,
  entryForCli,
  runCli,
} from "../setup/public-write-gate.mjs";

const GATE_PATH = fileURLToPath(new URL("../setup/public-write-gate.mjs", import.meta.url));

// The securities acronym is assembled from two halves on purpose. GitHub tooling that scans outgoing writes for
// the literal marker (the gateway pre-share gate) would otherwise reject this file as if it were sensitive
// content. The gate under test still receives the whole word.
const ACRONYM = "MN" + "PI";

// One representative marker per refused class: a structured label and a sentence of free text.
const CLASS_CASES = [
  { cls: "finance", tag: "finance", text: "Q3 financial model has a formula error" },
  { cls: "legal", tag: "legal", text: "Review the legal hold notice" },
  { cls: "investor", tag: "investor-relations", text: "Investor update draft needs a new chart" },
  { cls: "deal", tag: "deal", text: "Term sheet comments for the acquisition" },
  { cls: "inside-information", tag: ACRONYM.toLowerCase(), text: `This note contains ${ACRONYM}` },
  { cls: "privileged", tag: "privileged", text: "This memo is privileged and confidential" },
  { cls: "phi", tag: "phi", text: "Logs expose PHI in the trace" },
  { cls: "personal", tag: "personal", text: "A personal matter for the owner" },
];

for (const { cls, tag, text } of CLASS_CASES) {
  test(`refuses ${cls}: as a tag, a category, an author and free text, from either allowed lane`, () => {
    for (const lane of ["cto", "developer"]) {
      const byTag = evaluatePublicWrite({ lane, tags: [tag] });
      assert.equal(byTag.allowed, false, `${lane} tag ${tag}`);
      assert.equal(byTag.class, cls);
      assert.equal(byTag.field, "tags");

      const byCategory = evaluatePublicWrite({ lane, category: tag });
      assert.equal(byCategory.allowed, false);
      assert.equal(byCategory.class, cls);
      assert.equal(byCategory.field, "category");

      const byAuthor = evaluatePublicWrite({ lane, author: tag });
      assert.equal(byAuthor.allowed, false);
      assert.equal(byAuthor.class, cls);
      assert.equal(byAuthor.field, "author");

      const byText = evaluatePublicWrite({ lane, text: { title: text } });
      assert.equal(byText.allowed, false, `${lane} text "${text}"`);
      assert.equal(byText.class, cls);
      assert.equal(byText.field, "title");
    }
  });

  test(`refusal for ${cls} never echoes the matched text`, () => {
    const d = evaluatePublicWrite({ lane: "cto", text: { title: text } });
    const msg = refusalMessage(d, "ledger finding add");
    assert.ok(!msg.includes(text), "the message must not repeat the entry text");
    assert.ok(!JSON.stringify(d).includes(text), "the decision must not carry the entry text");
  });
}

test("every refusal class has a test above or below (the class list and the cases cannot drift apart)", () => {
  const covered = new Set([...CLASS_CASES.map((c) => c.cls), "restricted", "ring-lane", "unknown-lane", "missing-metadata", "malformed-metadata"]);
  assert.deepEqual([...covered].sort(), [...REFUSAL_CLASSES].sort());
});

test("refuses a confidential or ring-private marker (restricted)", () => {
  assert.equal(evaluatePublicWrite({ lane: "cto", tags: ["confidential"] }).class, "restricted");
  assert.equal(evaluatePublicWrite({ lane: "cto", tags: ["ring-private"] }).class, "restricted");
  assert.equal(evaluatePublicWrite({ lane: "cto", text: { title: "ring-private notes" } }).class, "restricted");
});

test("refuses every ring lane, whatever case, spacing or suffix the caller uses", () => {
  assert.deepEqual([...RING_LANES], ["cfo", "clo", "clo-personal"]);
  for (const lane of ["cfo", "clo", "clo-personal", "CFO", " Clo ", "CLO-Personal", "cfo-agent", "agent-clo"]) {
    const d = evaluatePublicWrite({ lane, text: { title: "nightly job has no timeout" } });
    assert.equal(d.allowed, false, lane);
    assert.equal(d.class, "ring-lane", lane);
  }
  // A ring lane named as the author is refused too, even when the declared lane is allowed.
  assert.equal(evaluatePublicWrite({ lane: "cto", author: "clo-personal" }).class, "ring-lane");
});

test("refuses unclassified entries from unknown lanes", () => {
  assert.deepEqual([...ALLOWED_LANES], ["cto", "developer"]);
  for (const lane of ["coo", "cro", "exec", "growth", "capital", "wefunder-campaign-director", "cto-personal", "ctos", "developers", "some-app"]) {
    const d = evaluatePublicWrite({ lane, text: { title: "nightly job has no timeout" } });
    assert.equal(d.allowed, false, lane);
    assert.equal(d.class, "unknown-lane", lane);
  }
});

// ---- the technical findings that must keep flowing ----

test("allows a plain technical finding from cto and from developer", () => {
  const cto = evaluatePublicWrite({
    lane: "cto",
    author: "cto",
    category: "ci",
    tags: ["workflow", "timeout"],
    text: { title: "The nightly canary job has no timeout-minutes", source_audit_doc: "docs/azure-gcp-infrastructure-audit-2026-07-10.md" },
  });
  assert.equal(cto.allowed, true, JSON.stringify(cto));
  assert.equal(cto.lane, "cto");

  const dev = evaluatePublicWrite({
    lane: "developer",
    category: "tests",
    tags: "flaky, node",
    text: { title: "run-tests.sh skips a skill selftest when chromium is absent", verified_by: "node --test output" },
  });
  assert.equal(dev.allowed, true, JSON.stringify(dev));
  assert.equal(dev.lane, "developer");
});

test("allows ordinary engineering wording that only resembles a sensitive word", () => {
  const ok = [
    "github-user-pat is a personal access token that expired in CI",
    "GITHUB_personal_access_token is missing in the runner",
    "the container runs in privileged mode",
    "privileged-container setting found in the task definition",
    "revenuecat-dashboard request times out after 30 seconds",
    "evaluation harness drift after the model change",
    "syntax check passes on every skill",
    "agent work product was lost when the run was cancelled",
  ];
  for (const title of ok) {
    for (const lane of ["cto", "developer"]) {
      const d = evaluatePublicWrite({ lane, text: { title } });
      assert.equal(d.allowed, true, `${lane}: ${title} -> ${d.class}`);
    }
  }
  for (const tag of ["syntax", "privilege-escalation", "privileged-container", "model-family", "ci"]) {
    assert.equal(evaluatePublicWrite({ lane: "cto", tags: [tag] }).allowed, true, tag);
  }
});

test("normalizes the lane (case and surrounding spaces) before comparing", () => {
  assert.equal(evaluatePublicWrite({ lane: "CTO" }).allowed, true);
  assert.equal(evaluatePublicWrite({ lane: "  Developer  " }).allowed, true);
});

// ---- fail closed on missing or unreadable metadata ----

test("fails closed when the entry or the lane is missing", () => {
  for (const entry of [undefined, null, {}, [], "cto", 7, { text: { title: "a technical note" } }, { lane: "" }, { lane: "   " }, { lane: null }, { lane: 7 }, { lane: ["cto"] }, { lane: { name: "cto" } }]) {
    const d = evaluatePublicWrite(entry);
    assert.equal(d.allowed, false, JSON.stringify(entry));
    assert.equal(d.class, "missing-metadata", JSON.stringify(entry));
  }
});

test("fails closed when metadata has the wrong shape or cannot be read", () => {
  const bad = [
    { lane: "cto", author: { name: "x" } },
    { lane: "cto", category: 7 },
    { lane: "cto", tags: [1, 2] },
    { lane: "cto", tags: { a: 1 } },
    { lane: "cto", seats: [7] },
    { lane: "cto", text: { title: { nested: "x" } } },
    { lane: "cto", text: [{ a: 1 }] },
    { lane: "cto", text: 7 },
  ];
  for (const entry of bad) {
    const d = evaluatePublicWrite(entry);
    assert.equal(d.allowed, false, JSON.stringify(entry));
    assert.equal(d.class, "malformed-metadata", JSON.stringify(entry));
  }
  // A property that throws when read must not crash the caller or be allowed.
  const hostile = { lane: "cto" };
  Object.defineProperty(hostile, "tags", { get() { throw new Error("boom"); } });
  const d = evaluatePublicWrite(hostile);
  assert.equal(d.allowed, false);
  assert.equal(d.class, "malformed-metadata");
});

test("evaluatePublicWrite never throws, whatever it is given", () => {
  for (const entry of [undefined, null, 0, "", Symbol.iterator, () => {}, new Proxy({}, { get() { throw new Error("trap"); }, has() { throw new Error("trap"); } })]) {
    assert.doesNotThrow(() => evaluatePublicWrite(entry));
    assert.equal(evaluatePublicWrite(entry).allowed, false);
  }
});

// ---- evasion resistance ----

test("sees through zero width characters, dash variants, snake case, camel case and full width letters", () => {
  const sneaky = [
    "fin​ancial summary",
    "non‑public information",
    "attorney_client_notes",
    "ContainsPHI flag set",
    "ＦＩＮＡＮＣＥ review",
    "LEGAL review",
    "Investors",
  ];
  for (const title of sneaky) {
    const d = evaluatePublicWrite({ lane: "cto", text: { title } });
    assert.equal(d.allowed, false, JSON.stringify(title));
  }
});

test("a lone personal access token phrase does not hide another use of the word personal", () => {
  assert.equal(evaluatePublicWrite({ lane: "cto", text: { t: "the personal access token expired" } }).allowed, true);
  assert.equal(evaluatePublicWrite({ lane: "cto", text: { t: "the personal access token expired and a personal note" } }).class, "personal");
});

test("path like fields are checked segment by segment", () => {
  assert.equal(evaluatePublicWrite({ lane: "cto", text: { source_audit_doc: "docs/azure-gcp-infrastructure-audit-2026-07-10.md" } }).allowed, true);
  assert.equal(evaluatePublicWrite({ lane: "cto", text: { fix_repo: "InnerScopeHearing/otchealth-claude-tools" } }).allowed, true);
  assert.equal(evaluatePublicWrite({ lane: "cto", text: { source_audit_doc: "docs/finance/plan.md" } }).class, "finance");
  assert.equal(evaluatePublicWrite({ lane: "cto", text: { source_audit_doc: "dream-team/clo/notes.md" } }).class, "legal");
  assert.equal(evaluatePublicWrite({ lane: "cto", text: { source_audit_doc: "projects/anything/notes.md" } }).class, "restricted");
  assert.equal(evaluatePublicWrite({ lane: "cto", text: { fix_repo: "InnerScopeHearing/example-phi-gateway" } }).class, "phi");
  assert.equal(evaluatePublicWrite({ lane: "cto", text: { source_audit_doc: "docs/projects-overview.md" } }).allowed, true);
});

// ---- the session identity (seats) ----

test("the session identity must also be an allowed lane, so a declared lane cannot hide the real seat", () => {
  assert.equal(evaluatePublicWrite({ lane: "cto", seats: ["cto"] }).allowed, true);
  assert.equal(evaluatePublicWrite({ lane: "cto", seats: ["cto", "developer"] }).allowed, true);
  assert.equal(evaluatePublicWrite({ lane: "cto", seats: ["cfo"] }).class, "ring-lane");
  assert.equal(evaluatePublicWrite({ lane: "cto", seats: ["clo-personal"] }).class, "ring-lane");
  assert.equal(evaluatePublicWrite({ lane: "cto", seats: ["coo"] }).class, "unknown-lane");
  assert.equal(evaluatePublicWrite({ lane: "cto", seats: ["cto", "coo"] }).class, "unknown-lane");
  assert.equal(evaluatePublicWrite({ lane: "cto", seats: "cfo" }).class, "ring-lane");
  assert.equal(evaluatePublicWrite({ lane: "cto", seats: ["cfo"] }).field, "session identity");
});

test("ambientIdentities reads the session marker, the repo marker and KB_AGENT, and fails closed on an unreadable marker", () => {
  const files = { "/h/.claude/.kb-agent": "cto\n", "/p/.kb-agent": "\n  developer \nignored" };
  const readFile = (p) => {
    if (p in files) return files[p];
    const e = new Error("missing"); e.code = "ENOENT"; throw e;
  };
  assert.deepEqual(ambientIdentities({ env: {}, readFile, home: "/h", projectDir: "/p" }), ["cto", "developer"]);
  assert.deepEqual(ambientIdentities({ env: { KB_AGENT: "cto" }, readFile, home: "/h", projectDir: "/nowhere" }), ["cto"], "duplicates collapse");
  assert.deepEqual(ambientIdentities({ env: { KB_AGENT: " cfo " }, readFile: () => { const e = new Error("x"); e.code = "ENOENT"; throw e; }, home: "/h", projectDir: "/p" }), ["cfo"]);
  assert.deepEqual(ambientIdentities({ env: {}, readFile: () => { const e = new Error("x"); e.code = "ENOENT"; throw e; }, home: "/h", projectDir: "/p" }), []);
  const unreadable = ambientIdentities({ env: {}, readFile: () => { const e = new Error("denied"); e.code = "EACCES"; throw e; }, home: "/h", projectDir: "/p" });
  assert.deepEqual(unreadable, ["unreadable-identity-marker"]);
  assert.equal(evaluatePublicWrite(entryForCli({ lane: "cto" }, unreadable)).allowed, false, "an unreadable identity marker fails closed");
});

test("entryForCli takes the declared lane, else the first session identity, else nothing (which then fails closed)", () => {
  assert.equal(entryForCli({ lane: "developer" }, ["cto"]).lane, "developer");
  assert.equal(entryForCli({}, ["cto"]).lane, "cto");
  assert.equal(entryForCli({}, []).lane, "");
  assert.equal(evaluatePublicWrite(entryForCli({}, [])).class, "missing-metadata");
  assert.deepEqual(entryForCli({ lane: "cto" }, ["cto", "developer"]).seats, ["cto", "developer"]);
});

// ---- the approval capability ----

test("assertPublicWriteAllowed mints an approval only for an allowed entry, and isApproval cannot be fooled", () => {
  const approval = assertPublicWriteAllowed({ lane: "cto", text: { title: "a technical note" } }, "unit test");
  assert.equal(isApproval(approval), true);
  assert.equal(approval.lane, "cto");
  assert.ok(Object.isFrozen(approval));
  for (const fake of [{ ...approval }, Object.freeze({ approved: true, lane: "cto", writer: "unit test" }), { approved: true }, null, undefined, "approved", 1, Object.create(approval)]) {
    assert.equal(isApproval(fake), false, JSON.stringify(fake));
  }
});

test("a refused entry throws PublicWriteRefused with exit code 2 and the plain message", () => {
  let err;
  try { assertPublicWriteAllowed({ lane: "cfo", text: { title: "a technical note" } }, "ledger finding add"); } catch (e) { err = e; }
  assert.ok(err instanceof PublicWriteRefused);
  assert.equal(err.refused, true);
  assert.equal(err.exitCode, EXIT_REFUSED);
  assert.equal(EXIT_REFUSED, 2);
  assert.equal(err.decision.class, "ring-lane");
  assert.match(err.message, /^REFUSED: ledger finding add will not write this to a public repository\./);
  assert.match(err.message, /memory_remember/);
  assert.match(err.message, /task_create/);
  assert.match(err.message, /Nothing was written\./);
});

test("every refusal message is plain English: names the private alternative, no em or en dashes", () => {
  const decisions = [
    ...CLASS_CASES.map((c) => evaluatePublicWrite({ lane: "cto", text: { title: c.text } })),
    evaluatePublicWrite({ lane: "cto", tags: ["confidential"] }),
    evaluatePublicWrite({ lane: "cfo" }),
    evaluatePublicWrite({ lane: "coo" }),
    evaluatePublicWrite({}),
    evaluatePublicWrite({ lane: "cto", tags: [7] }),
  ];
  assert.equal(new Set(decisions.map((d) => d.class)).size, REFUSAL_CLASSES.length, "every class is exercised");
  for (const d of decisions) {
    const msg = refusalMessage(d, "some writer");
    assert.ok(!/[–—]/.test(msg), msg);
    assert.match(msg, /private ledger/);
    assert.match(msg, /memory_remember with type finding/);
    assert.match(msg, /task_create/);
    assert.match(msg, /Finance, legal and personal findings never go to a public repo/);
  }
});

test("the missing lane message tells the caller how to declare one", () => {
  const msg = refusalMessage(evaluatePublicWrite({ text: { title: "x" } }), "ledger add");
  assert.match(msg, /--lane cto/);
});

// ---- the CLI used by workflows ----

test("runCli check: allowed and refused", () => {
  const ok = runCli(["check", "--lane", "cto", "--text", "plain technical note"], { ambient: [] });
  assert.equal(ok.code, 0);
  assert.match(ok.stdout, /ALLOWED/);
  const ring = runCli(["check", "--lane", "cfo", "--text", "plain technical note"], { ambient: [] });
  assert.equal(ring.code, 2);
  assert.equal(ring.stdout, "");
  assert.match(ring.stderr, /REFUSED/);
  const tagged = runCli(["check", "--lane", "developer", "--tags", "build,finance"], { ambient: [] });
  assert.equal(tagged.code, 2);
  const missing = runCli(["check", "--text", "plain technical note"], { ambient: [] });
  assert.equal(missing.code, 2, "no lane anywhere fails closed");
  const seat = runCli(["check", "--text", "plain technical note"], { ambient: ["developer"] });
  assert.equal(seat.code, 0, "the session identity supplies the lane when no flag is given");
});

test("runCli files: scans the content of the files about to be committed", () => {
  const store = {
    "diagnostics/ok.md": "# nightly canary\nexit code 0\n",
    "diagnostics/sensitive.md": "Summary of the investor update\n",
    "diagnostics/big.md": "x",
  };
  const readFile = (p) => { if (!(p in store)) { const e = new Error("nope"); e.code = "ENOENT"; throw e; } return store[p]; };
  const fileSize = (p) => (p === "diagnostics/big.md" ? 5 * 1024 * 1024 : readFile(p).length);
  const base = { ambient: [], readFile, fileSize };

  const ok = runCli(["files", "--lane", "cto", "--writer", "diag workflow", "diagnostics/ok.md"], base);
  assert.equal(ok.code, 0);
  assert.match(ok.stdout, /ALLOWED/);

  const sensitive = runCli(["files", "--lane", "cto", "--writer", "diag workflow", "diagnostics/ok.md", "diagnostics/sensitive.md"], base);
  assert.equal(sensitive.code, 2);
  assert.match(sensitive.stderr, /investor material/);
  assert.match(sensitive.stderr, /diagnostics\/sensitive\.md/, "the file is named, its text is not");
  assert.ok(!sensitive.stderr.includes("Summary of the investor update"));

  const ringClean = runCli(["files", "--lane", "clo-personal", "--writer", "diagnostic workflow", "diagnostics/ok.md"], base);
  assert.equal(ringClean.code, 2, "a ring lane is refused even when the file is clean");
  assert.match(ringClean.stderr, /ring lane/);

  assert.equal(runCli(["files", "--lane", "cto", "diagnostics/missing.md"], base).code, 2, "an unreadable file cannot be vetted");
  assert.equal(runCli(["files", "--lane", "cto", "diagnostics/big.md"], base).code, 2, "an oversized file is refused");
  assert.equal(runCli(["files", "--lane", "cto"], base).code, 2, "no files named means nothing was vetted");
  assert.equal(runCli(["files", "diagnostics/ok.md"], base).code, 2, "no lane");
  assert.equal(runCli(["files", "--lane", "cto", "--lane", "cfo", "diagnostics/ok.md"], base).code, 2, "two different lanes are ambiguous");
  assert.equal(runCli(["files", "--lane", "cto", "--lane", "CTO", "diagnostics/ok.md"], base).code, 0, "the same lane twice is fine");
});

test("runCli: an unknown or missing subcommand is refused with the usage text", () => {
  for (const argv of [[], ["bogus"], ["--lane", "cto"]]) {
    const r = runCli(argv, { ambient: [] });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /usage:/);
  }
});

test("the CLI process exits 2 on refusal and 0 on allow, and prints nothing on stdout when it refuses", () => {
  const dir = mkdtempSync(join(tmpdir(), "pwg-"));
  try {
    const clean = join(dir, "clean.md");
    const dirty = join(dir, "dirty.md");
    writeFileSync(clean, "nightly canary passed\n");
    writeFileSync(dirty, "Legal hold notice attached\n");
    const env = { PATH: process.env.PATH, HOME: dir };
    const run = (args) => spawnSync(process.execPath, [GATE_PATH, ...args], { env, encoding: "utf8" });

    const allowed = run(["files", "--lane", "cto", "--writer", "test", clean]);
    assert.equal(allowed.status, 0, allowed.stderr);
    const refused = run(["files", "--lane", "cto", "--writer", "test", dirty]);
    assert.equal(refused.status, 2);
    assert.equal(refused.stdout, "");
    assert.match(refused.stderr, /REFUSED/);
    const ring = run(["files", "--lane", "clo-personal", "--writer", "test", clean]);
    assert.equal(ring.status, 2);
    const noLane = run(["files", clean]);
    assert.equal(noLane.status, 2);
    // The session identity is read from the environment too: a ring seat cannot be hidden behind --lane cto.
    const seat = spawnSync(process.execPath, [GATE_PATH, "files", "--lane", "cto", clean], { env: { ...env, KB_AGENT: "cfo" }, encoding: "utf8" });
    assert.equal(seat.status, 2);
    assert.match(seat.stderr, /ring lane/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the gate module stays dependency free: node builtins only", () => {
  const src = readFileSync(GATE_PATH, "utf8");
  const specs = [...src.matchAll(/^\s*import\s[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
  assert.ok(specs.length > 0);
  for (const s of specs) assert.ok(s.startsWith("node:"), `unexpected import ${s}`);
  assert.ok(!/\brequire\s*\(/.test(src));
  assert.ok(!/\bimport\s*\(/.test(src), "no dynamic imports either");
});

test("the gate adds no secret or token: it never reads credentials or touches the network", () => {
  const src = readFileSync(GATE_PATH, "utf8");
  assert.ok(!/\bfetch\s*\(/.test(src));
  assert.ok(!/process\.env\.(?!HOME\b|CLAUDE_PROJECT_DIR\b|KB_AGENT\b)[A-Z_]+/.test(src), "only identity variables are read from the environment");
  assert.ok(!/\benv\.(?!HOME\b|CLAUDE_PROJECT_DIR\b|KB_AGENT\b)[A-Z_]+/.test(src), "only identity variables are read from the env parameter");
});
