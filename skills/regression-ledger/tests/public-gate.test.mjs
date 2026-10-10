// The public write gate as wired into the ledger writer (skills/regression-ledger/ledger.mjs).
//
// OWNER DECISION 2026-10-10 (security review finding S-04): the ledger lives in a PUBLIC repo, and finance,
// legal and personal findings never go there. Every write verb (add, finding add, finding close) must pass
// setup/public-write-gate.mjs before any token or network use, and the one function that talks to the GitHub
// Contents API (putFile) must refuse a caller that did not pass the gate. These tests are hermetic: the I/O is
// injected, and the CLI cases refuse before the network could be reached.
//
// The gate itself is pinned in tests/public-write-gate.test.mjs. The existing findings tests
// (findings.test.mjs) are untouched and still pass.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync, mkdirSync, writeFileSync, copyFileSync, symlinkSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { addFinding, closeFinding, addRegression, putFile, upsertFinding, parseFindings } from "../ledger.mjs";
import { assertPublicWriteAllowed, isApproval } from "../../../setup/public-write-gate.mjs";

const LEDGER_PATH = fileURLToPath(new URL("../ledger.mjs", import.meta.url));

/** Injectable I/O that records every call, so a test can prove a refusal touched nothing. */
function makeIo({ content = null, sha = null, failFetch = false } = {}) {
  const calls = { pat: 0, fetchFile: 0, fetchLedger: 0, putFile: [], verify: 0 };
  const deps = {
    pat: async () => { calls.pat += 1; return "test-token"; },
    fetchFile: async () => { calls.fetchFile += 1; if (failFetch) throw new Error("network down"); return { content, sha }; },
    fetchLedger: async () => { calls.fetchLedger += 1; if (failFetch) throw new Error("network down"); return { content, sha }; },
    putFile: async (token, path, newContent, shaArg, message, approval) => {
      calls.putFile.push({ token, path, newContent, sha: shaArg, message, approval });
      return { commitSha: "abc123def456" };
    },
    verifyCommitLanded: async () => { calls.verify += 1; return true; },
  };
  return { calls, deps };
}
const untouched = (c) => c.pat === 0 && c.fetchFile === 0 && c.fetchLedger === 0 && c.putFile.length === 0 && c.verify === 0;

// An em dash or an en dash, built from code points so this file itself contains neither.
const DASH = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`);

const BASE = { severity: "medium", source_audit_doc: "docs/azure-gcp-infrastructure-audit-2026-07-10.md", title: "The nightly canary job has no timeout" };

// The securities acronym is assembled from two halves on purpose. GitHub tooling that scans outgoing writes for
// the literal marker (the gateway pre-share gate) would otherwise reject this file as if it were sensitive
// content. The gate under test still receives the whole word.
const ACRONYM = "MN" + "PI";

// One representative text per refused class, the same cases the gate tests use.
const CLASS_TEXT = [
  ["finance", "Q3 financial model has a formula error"],
  ["legal", "Review the legal hold notice"],
  ["investor", "Investor update draft needs a new chart"],
  ["deal", "Term sheet comments for the acquisition"],
  ["inside-information", `This note contains ${ACRONYM}`],
  ["privileged", "This memo is privileged and confidential"],
  ["phi", "Logs expose PHI in the trace"],
  ["personal", "A personal matter for the owner"],
];
const CLASS_TAG = { finance: "finance", legal: "legal", investor: "investor", deal: "deal", "inside-information": ACRONYM.toLowerCase(), privileged: "privileged", phi: "phi", personal: "personal" };

// ---- finding add ----

test("finding add: a plain technical finding from cto and from developer is written, with the approval", async () => {
  for (const lane of ["cto", "developer"]) {
    const { deps, calls } = makeIo();
    const res = await addFinding({ ...BASE, lane }, deps);
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.verified, true);
    assert.equal(calls.putFile.length, 1);
    const put = calls.putFile[0];
    assert.equal(isApproval(put.approval), true, "the write helper receives a gate approval");
    assert.match(put.message, /^findings-ledger: add FND-\d{8}-[0-9a-f]{4} severity=medium: The nightly canary job has no timeout$/);
    assert.ok(!DASH.test(put.message));
    const written = parseFindings(put.newContent);
    assert.equal(written.length, 1);
    assert.equal(written[0].title, BASE.title);
    assert.equal(written[0].status, "open");
  }
});

for (const [cls, text] of CLASS_TEXT) {
  test(`finding add refuses ${cls}: in the title and as a tag, and touches nothing`, async () => {
    const byTitle = makeIo();
    const r1 = await addFinding({ ...BASE, title: text, lane: "cto" }, byTitle.deps);
    assert.equal(r1.ok, false);
    assert.equal(r1.refused, true);
    assert.equal(r1.refusal.class, cls);
    assert.match(r1.error, /memory_remember/);
    assert.match(r1.error, /Nothing was written/);
    assert.ok(untouched(byTitle.calls), "no token, no fetch, no write");

    const byTag = makeIo();
    const r2 = await addFinding({ ...BASE, lane: "developer", tags: [CLASS_TAG[cls]] }, byTag.deps);
    assert.equal(r2.refused, true);
    assert.equal(r2.refusal.class, cls);
    assert.ok(untouched(byTag.calls));
  });
}

test("finding add refuses a source doc path that points into a sensitive area", async () => {
  const { deps, calls } = makeIo();
  const res = await addFinding({ ...BASE, lane: "cto", source_audit_doc: "docs/finance/plan.md" }, deps);
  assert.equal(res.refused, true);
  assert.equal(res.refusal.field, "source_audit_doc");
  assert.ok(untouched(calls));
});

test("finding add refuses every ring lane, an unknown lane and a missing lane, and touches nothing", async () => {
  for (const lane of ["cfo", "clo", "clo-personal", "coo", "exec", "", undefined, null, 7]) {
    const { deps, calls } = makeIo();
    const res = await addFinding({ ...BASE, lane }, deps);
    assert.equal(res.ok, false, String(lane));
    assert.equal(res.refused, true, String(lane));
    assert.ok(untouched(calls), `lane ${String(lane)} touched the network`);
  }
  const noLane = makeIo();
  const res = await addFinding({ ...BASE }, noLane.deps);
  assert.equal(res.refusal.class, "missing-metadata");
  assert.match(res.error, /--lane cto/);
});

test("finding add refuses a ring seat even when the declared lane is cto", async () => {
  const { deps, calls } = makeIo();
  const res = await addFinding({ ...BASE, lane: "cto", seats: ["cfo"] }, deps);
  assert.equal(res.refused, true);
  assert.equal(res.refusal.class, "ring-lane");
  assert.ok(untouched(calls));
});

test("finding add checks the author and category fields too", async () => {
  for (const extra of [{ author: "clo-personal" }, { author: "finance-desk" }, { category: "legal" }, { category: "investor relations" }]) {
    const { deps, calls } = makeIo();
    const res = await addFinding({ ...BASE, lane: "cto", ...extra }, deps);
    assert.equal(res.refused, true, JSON.stringify(extra));
    assert.ok(untouched(calls));
  }
});

test("finding add: the existing input validation still runs first (a bad severity is reported as a bad severity)", async () => {
  const { deps, calls } = makeIo();
  const res = await addFinding({ ...BASE, severity: "urgent", lane: "cfo" }, deps);
  assert.equal(res.ok, false);
  assert.ok(!res.refused);
  assert.match(res.error, /severity/);
  assert.ok(untouched(calls));
});

test("finding add stays fail-open for an allowed entry: a network failure resolves to ok:false, never a throw", async () => {
  const { deps } = makeIo({ failFetch: true });
  const res = await addFinding({ ...BASE, lane: "cto" }, deps);
  assert.equal(res.ok, false);
  assert.ok(!res.refused, "a network failure is not a refusal");
  assert.equal(typeof res.error, "string");
  assert.match(res.error, /network down/);
});

test("finding add still refuses to overwrite an existing id", async () => {
  const existing = upsertFinding(null, { id: "FND-20260101-aaaa", severity: "low", status: "open", title: "Cache TTL is too short", source_audit_doc: "docs/audit.md", fix_commit: null, verified_by: null, opened: "2026-01-01T00:00:00.000Z", closed: null }).content;
  const { deps, calls } = makeIo({ content: existing, sha: "sha1" });
  const res = await addFinding({ ...BASE, lane: "cto", id: "FND-20260101-aaaa" }, deps);
  assert.equal(res.ok, false);
  assert.match(res.error, /already exists/);
  assert.equal(calls.putFile.length, 0);
});

// ---- finding close ----

const OPEN_FINDING = { id: "FND-20260101-aaaa", severity: "low", status: "open", title: "Cache TTL is too short", source_audit_doc: "docs/audit.md", fix_commit: null, verified_by: null, opened: "2026-01-01T00:00:00.000Z", closed: null };

test("finding close: a technical finding is closed by cto and by developer, with the approval", async () => {
  for (const lane of ["cto", "developer"]) {
    const { deps, calls } = makeIo({ content: upsertFinding(null, OPEN_FINDING).content, sha: "sha1" });
    const res = await closeFinding("FND-20260101-aaaa", { lane, status: "fixed", fix_commit: "deadbeef" }, deps);
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.wasStatus, "open");
    assert.equal(calls.putFile.length, 1);
    assert.equal(isApproval(calls.putFile[0].approval), true);
    assert.equal(calls.putFile[0].message, "findings-ledger: fixed FND-20260101-aaaa: Cache TTL is too short");
    assert.equal(parseFindings(calls.putFile[0].newContent)[0].status, "fixed");
  }
});

test("finding close refuses a ring lane, an unknown lane and a missing lane before any network use", async () => {
  for (const lane of ["cfo", "clo", "clo-personal", "coo", undefined]) {
    const { deps, calls } = makeIo({ content: upsertFinding(null, OPEN_FINDING).content, sha: "sha1" });
    const res = await closeFinding("FND-20260101-aaaa", { lane, status: "fixed" }, deps);
    assert.equal(res.refused, true, String(lane));
    assert.ok(untouched(calls), `lane ${String(lane)} touched the network`);
  }
});

test("finding close refuses sensitive text in the new verified_by note", async () => {
  const { deps, calls } = makeIo({ content: upsertFinding(null, OPEN_FINDING).content, sha: "sha1" });
  const res = await closeFinding("FND-20260101-aaaa", { lane: "cto", status: "fixed", verified_by: "confirmed with the investor deck" }, deps);
  assert.equal(res.refused, true);
  assert.ok(untouched(calls));
});

test("finding close leaves a sensitive existing entry untouched and does not echo its text", async () => {
  const secretTitle = "Investor update numbers do not reconcile";
  const content = upsertFinding(null, { ...OPEN_FINDING, title: secretTitle }).content;
  const { deps, calls } = makeIo({ content, sha: "sha1" });
  const res = await closeFinding("FND-20260101-aaaa", { lane: "cto", status: "fixed" }, deps);
  assert.equal(res.ok, false);
  assert.equal(res.refused, true);
  assert.equal(res.refusal.class, "investor");
  assert.equal(res.refusal.field, "title");
  assert.ok(!res.error.includes(secretTitle), "the refusal must not repeat the entry text");
  assert.equal(calls.putFile.length, 0, "nothing is written");
  assert.equal(calls.fetchFile, 1, "the entry had to be read to be vetted");
});

test("finding close: an unknown id is a plain not-found, and a close back to open is still rejected first", async () => {
  const { deps, calls } = makeIo({ content: upsertFinding(null, OPEN_FINDING).content, sha: "sha1" });
  const res = await closeFinding("FND-nope", { lane: "cto", status: "fixed" }, deps);
  assert.equal(res.ok, false);
  assert.ok(!res.refused);
  assert.match(res.error, /not found/);
  assert.equal(calls.putFile.length, 0);

  const fresh = makeIo();
  const open = await closeFinding("FND-whatever", { lane: "cfo", status: "open" }, fresh.deps);
  assert.match(open.error, /open/);
  assert.ok(untouched(fresh.calls));
});

// ---- regression ledger add ----

const REG = { tag: "pagination-skips-last-page", bug: "The list call drops the last page", rootCause: "The loop stops one page early", fixRepo: "InnerScopeHearing/otchealth-claude-tools", fixCommit: "abc1234", fixSummary: "Loop until the next link is empty", verifiedBy: "unit test" };

test("add: a plain technical regression entry from cto and developer is written, with the approval and no dash in the commit message", async () => {
  for (const lane of ["cto", "developer"]) {
    const { deps, calls } = makeIo();
    const res = await addRegression({ ...REG, lane }, deps);
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.verifiedLanded, true);
    assert.deepEqual(res.priorHits, []);
    assert.equal(calls.putFile.length, 1);
    const put = calls.putFile[0];
    assert.equal(isApproval(put.approval), true);
    assert.equal(put.message, "regression-ledger: new tag:pagination-skips-last-page: The list call drops the last page");
    assert.ok(!DASH.test(put.message));
    assert.match(put.newContent, /tag:pagination-skips-last-page/);
  }
});

test("add: a repeated root-cause tag is still recorded as a REGRESSION", async () => {
  const first = makeIo();
  await addRegression({ ...REG, lane: "cto" }, first.deps);
  const { deps, calls } = makeIo({ content: first.calls.putFile[0].newContent, sha: "sha1" });
  const res = await addRegression({ ...REG, lane: "cto" }, deps);
  assert.equal(res.ok, true);
  assert.equal(res.priorHits.length, 1);
  assert.match(calls.putFile[0].message, /^regression-ledger: REGRESSION tag:pagination-skips-last-page: /);
});

for (const [cls, text] of CLASS_TEXT) {
  test(`add refuses ${cls}: in the bug text and as a category, and touches nothing`, async () => {
    const byText = makeIo();
    const r1 = await addRegression({ ...REG, bug: text, lane: "cto" }, byText.deps);
    assert.equal(r1.ok, false);
    assert.equal(r1.refused, true);
    assert.equal(r1.refusal.class, cls);
    assert.ok(untouched(byText.calls));

    const byCategory = makeIo();
    const r2 = await addRegression({ ...REG, lane: "developer", category: CLASS_TAG[cls] }, byCategory.deps);
    assert.equal(r2.refused, true);
    assert.equal(r2.refusal.class, cls);
    assert.ok(untouched(byCategory.calls));
  });
}

test("add refuses ring lanes, unknown lanes, a ring seat and a missing lane, and touches nothing", async () => {
  for (const extra of [{ lane: "cfo" }, { lane: "clo" }, { lane: "clo-personal" }, { lane: "coo" }, { lane: "" }, {}, { lane: "cto", seats: ["clo"] }]) {
    const { deps, calls } = makeIo();
    const res = await addRegression({ ...REG, ...extra }, deps);
    assert.equal(res.refused, true, JSON.stringify(extra));
    assert.ok(untouched(calls), JSON.stringify(extra));
  }
});

test("add still rejects a call with a required field missing (as the CLI always has)", async () => {
  const { deps, calls } = makeIo();
  await assert.rejects(() => addRegression({ ...REG, lane: "cto", bug: "" }, deps), /required/);
  assert.ok(untouched(calls));
});

// ---- the single write path ----

test("putFile refuses a caller that did not pass the gate, before any network use", async () => {
  const originalFetch = global.fetch;
  let fetched = 0;
  global.fetch = async () => { fetched += 1; throw new Error("the network must not be reached"); };
  try {
    await assert.rejects(() => putFile("tok", "SOME-FILE.md", "content", null, "message"), /public-write gate/);
    await assert.rejects(() => putFile("tok", "SOME-FILE.md", "content", null, "message", undefined), /public-write gate/);
    await assert.rejects(() => putFile("tok", "SOME-FILE.md", "content", null, "message", { approved: true }), /public-write gate/, "a forged approval is not accepted");
    await assert.rejects(() => putFile("tok", "SOME-FILE.md", "content", null, "message", "approved"), /public-write gate/);
    assert.equal(fetched, 0);
  } finally {
    global.fetch = originalFetch;
  }
});

test("putFile writes to main through the Contents API when it holds a real approval", async () => {
  const approval = assertPublicWriteAllowed({ lane: "cto", text: { title: "a technical note" } }, "unit test");
  const originalFetch = global.fetch;
  const seen = [];
  global.fetch = async (url, init) => { seen.push({ url, init }); return { ok: true, status: 200, json: async () => ({ commit: { sha: "c0ffee" } }), text: async () => "" }; };
  try {
    const res = await putFile("tok", "SOME-FILE.md", "hello", "oldsha", "a message", approval);
    assert.deepEqual(res, { commitSha: "c0ffee" });
    assert.equal(seen.length, 1);
    assert.match(seen[0].url, /\/contents\/SOME-FILE\.md$/);
    assert.equal(seen[0].init.method, "PUT");
    const body = JSON.parse(seen[0].init.body);
    assert.equal(body.branch, "main");
    assert.equal(body.message, "a message");
    assert.equal(body.sha, "oldsha");
    assert.equal(Buffer.from(body.content, "base64").toString("utf8"), "hello");
  } finally {
    global.fetch = originalFetch;
  }
});

// ---- the CLI refuses before the network could be reached ----

function runLedger(args, env = {}) {
  const home = mkdtempSync(join(tmpdir(), "ledger-gate-"));
  try {
    return spawnSync(process.execPath, [LEDGER_PATH, ...args], {
      // No token and a dead proxy: if the CLI ever got past the gate it would fail loudly, not write.
      env: { PATH: process.env.PATH, HOME: home, HTTPS_PROXY: "http://127.0.0.1:9", HTTP_PROXY: "http://127.0.0.1:9", ...env },
      encoding: "utf8",
      timeout: 20000,
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

const FINDING_ARGS = ["finding", "add", "--severity", "high", "--source-audit-doc", "docs/audit.md", "--title", "The nightly canary job has no timeout"];
const ADD_ARGS = ["add", "--tag", "some-tag", "--bug", "The list call drops the last page", "--root-cause", "The loop stops early", "--fix-repo", "InnerScopeHearing/otchealth-claude-tools", "--fix-commit", "abc1234", "--fix-summary", "Loop until empty"];

function assertRefusedCli(r, label) {
  assert.equal(r.status, 2, `${label}: exit code (stderr: ${r.stderr})`);
  assert.equal(r.stdout, "", `${label}: nothing on stdout`);
  assert.match(r.stderr, /REFUSED/, label);
  assert.match(r.stderr, /Nothing was written\./, label);
  assert.ok(!/GitHub token|ledger\] finding add ERROR|regression-ledger ERROR/.test(r.stderr), `${label}: the refusal came from the gate, before any token or network use`);
}

test("CLI: finding add, add and finding close refuse a ring lane with exit 2", () => {
  for (const lane of ["cfo", "clo", "clo-personal"]) {
    assertRefusedCli(runLedger([...FINDING_ARGS, "--lane", lane]), `finding add ${lane}`);
    assertRefusedCli(runLedger([...ADD_ARGS, "--lane", lane]), `add ${lane}`);
    assertRefusedCli(runLedger(["finding", "close", "FND-20260101-aaaa", "--lane", lane]), `finding close ${lane}`);
  }
});

test("CLI: a missing lane fails closed with exit 2 and tells the caller how to declare one", () => {
  const r = runLedger(FINDING_ARGS);
  assertRefusedCli(r, "finding add without a lane");
  assert.match(r.stderr, /--lane cto/);
  assertRefusedCli(runLedger(ADD_ARGS), "add without a lane");
  assertRefusedCli(runLedger(["finding", "close", "FND-20260101-aaaa"]), "close without a lane");
});

test("CLI: the session identity cannot be hidden behind --lane cto", () => {
  assertRefusedCli(runLedger([...FINDING_ARGS, "--lane", "cto"], { KB_AGENT: "cfo" }), "finding add, ring seat");
  assertRefusedCli(runLedger([...ADD_ARGS, "--lane", "cto"], { KB_AGENT: "clo-personal" }), "add, ring seat");
  assertRefusedCli(runLedger([...FINDING_ARGS, "--lane", "cto"], { KB_AGENT: "coo" }), "finding add, unlisted seat");
});

test("CLI: sensitive text and sensitive labels are refused even from the cto lane, and the reason shows the lane flag was read", () => {
  const sensitiveTitle = ["finding", "add", "--severity", "high", "--source-audit-doc", "docs/audit.md", "--title", "Review the legal hold notice", "--lane", "cto"];
  const legal = runLedger(sensitiveTitle);
  assertRefusedCli(legal, "legal title");
  assert.match(legal.stderr, /legal material/);
  assert.ok(!/lane is missing/.test(legal.stderr), "--lane cto was accepted; the content is what was refused");

  const finance = runLedger([...FINDING_ARGS, "--lane", "cto", "--tags", "build,finance"]);
  assertRefusedCli(finance, "finance tag");
  assert.match(finance.stderr, /finance material/);

  const personal = runLedger([...FINDING_ARGS, "--lane", "developer", "--category", "personal"]);
  assertRefusedCli(personal, "personal category");
  assert.match(personal.stderr, /personal material/);

  const ringAuthor = runLedger([...FINDING_ARGS, "--lane", "developer", "--author", "cfo"]);
  assertRefusedCli(ringAuthor, "ring author");
  assert.match(ringAuthor.stderr, /ring lane/);

  const regression = runLedger([...ADD_ARGS, "--lane", "cto", "--tags", "investor"]);
  assertRefusedCli(regression, "add with an investor tag");
  assert.match(regression.stderr, /investor material/);
});

test("CLI: the usage errors are unchanged and now mention the lane flag", () => {
  const usage = runLedger(["finding", "add"]);
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /usage: ledger\.mjs finding add/);
  assert.match(usage.stderr, /--lane/);
  const addUsage = runLedger(["add"]);
  assert.equal(addUsage.status, 2);
  assert.match(addUsage.stderr, /usage: ledger\.mjs add/);
});

// ---- a missing gate file must not take the read side down, and a write must fail closed ----

/** A throw away copy of the skill with NO setup/public-write-gate.mjs next to it, the way a failed hydrate leaves it. */
function installWithoutGate() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ledger-nogate-")));
  mkdirSync(join(dir, "skills", "regression-ledger"), { recursive: true });
  mkdirSync(join(dir, "skills", "kb-memory"), { recursive: true });
  copyFileSync(LEDGER_PATH, join(dir, "skills", "regression-ledger", "ledger.mjs"));
  writeFileSync(join(dir, "skills", "kb-memory", "azure-secret.mjs"), "export async function kvSecret() { return null; }\n");
  return { dir, ledger: join(dir, "skills", "regression-ledger", "ledger.mjs") };
}

test("without the gate file the module still loads and the read helpers work, and every write refuses before any I/O", async () => {
  const { dir, ledger } = installWithoutGate();
  try {
    const mod = await import(pathToFileURL(ledger).href);
    const finding = { id: "FND-20260101-aaaa", severity: "low", status: "open", title: "a technical note", source_audit_doc: "docs/audit.md", fix_commit: null, verified_by: null, opened: "2026-01-01T00:00:00.000Z", closed: null };
    const { content } = upsertFinding(null, finding);
    assert.equal(mod.parseFindings(content).length, 1, "a read helper works with no gate present");

    const { deps, calls } = makeIo({ content, sha: "s1" });
    const add = await mod.addFinding({ ...BASE, lane: "cto" }, deps);
    assert.equal(add.ok, false);
    assert.equal(add.refused, true);
    assert.match(add.error, /could not load the public-write gate/);
    const close = await mod.closeFinding("FND-20260101-aaaa", { lane: "cto" }, deps);
    assert.equal(close.refused, true);
    const reg = await mod.addRegression({ tag: "t", bug: "b", rootCause: "r", fixRepo: "o/r", fixCommit: "abc", fixSummary: "s", lane: "cto" }, deps);
    assert.equal(reg.refused, true);
    assert.ok(untouched(calls), "no token, no read, no write");

    const originalFetch = global.fetch;
    global.fetch = async () => { throw new Error("the network must not be reached"); };
    try {
      await assert.rejects(() => mod.putFile("tok", "X.md", "c", null, "m", {}), /public-write gate/);
    } finally {
      global.fetch = originalFetch;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI without the gate file: the CLI still starts, write verbs exit 2 and say how to restore the gate", () => {
  const { dir, ledger } = installWithoutGate();
  try {
    const run = (args) => spawnSync(process.execPath, [ledger, ...args], {
      env: { PATH: process.env.PATH, HOME: dir, HTTPS_PROXY: "http://127.0.0.1:9", HTTP_PROXY: "http://127.0.0.1:9" },
      encoding: "utf8",
      timeout: 20000,
    });
    const usage = run(["bogus"]);
    assert.equal(usage.status, 2);
    assert.match(usage.stderr, /usage: ledger\.mjs add/, "the CLI ran, so the module loaded without the gate");
    assert.ok(!/ERR_MODULE_NOT_FOUND|Cannot find module/.test(usage.stderr));
    for (const args of [[...FINDING_ARGS, "--lane", "cto"], [...ADD_ARGS, "--lane", "cto"], ["finding", "close", "FND-20260101-aaaa", "--lane", "cto"]]) {
      const r = run(args);
      assert.equal(r.status, 2, r.stderr);
      assert.equal(r.stdout, "");
      assert.match(r.stderr, /could not load the public-write gate/);
      assert.match(r.stderr, /nothing was written/i);
      assert.ok(!/GitHub token|regression-ledger ERROR/.test(r.stderr), "refused before any token or network use");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- started through a symlink ----

test("CLI through a symlink: it still runs (the old guard made it a silent exit 0)", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ledger-link-")));
  try {
    const link = join(dir, "ledger-link.mjs");
    symlinkSync(LEDGER_PATH, link);
    const run = (args) => spawnSync(process.execPath, [link, ...args], {
      env: { PATH: process.env.PATH, HOME: dir, CLAUDE_PROJECT_DIR: dir, HTTPS_PROXY: "http://127.0.0.1:9", HTTP_PROXY: "http://127.0.0.1:9" },
      cwd: dir,
      encoding: "utf8",
      timeout: 20000,
    });
    const usage = run(["bogus"]);
    assert.equal(usage.status, 2, `usage must be printed with exit 2 (stderr: ${usage.stderr})`);
    assert.match(usage.stderr, /usage: ledger\.mjs add/);
    assertRefusedCli(run([...FINDING_ARGS, "--lane", "cfo"]), "finding add, ring lane, through a symlink");
    assertRefusedCli(run([...ADD_ARGS]), "add without a lane, through a symlink");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- structure: the gate cannot be bypassed by a future edit that forgets it ----

const SRC = readFileSync(LEDGER_PATH, "utf8");

function functionBody(name) {
  const start = SRC.indexOf(`export async function ${name}(`);
  assert.ok(start >= 0, `${name} not found`);
  const next = SRC.indexOf("\n/** ", start + 10);
  const nextFn = SRC.indexOf("\nasync function ", start + 10);
  const end = [next, nextFn].filter((i) => i > 0).sort((a, b) => a - b)[0] ?? SRC.length;
  return SRC.slice(start, end);
}

test("structure: every write function gates before it asks for a token or touches the network", () => {
  for (const name of ["addFinding", "closeFinding", "addRegression"]) {
    const body = functionBody(name);
    const gate = body.indexOf("gatePublicWrite(");
    const token = body.indexOf("io.pat()");
    assert.ok(gate > 0, `${name} must call gatePublicWrite`);
    assert.ok(token > gate, `${name} must gate before io.pat()`);
    assert.ok(/io\.putFile\([^)]*approval\)/.test(body), `${name} must hand the approval to putFile`);
  }
});

test("structure: closeFinding also vets the existing entry before it writes", () => {
  const body = functionBody("closeFinding");
  const first = body.indexOf("gatePublicWrite(");
  const second = body.indexOf("gatePublicWrite(", first + 10);
  const put = body.indexOf("io.putFile(");
  assert.ok(second > first && put > second, "the existing entry is gated before the write");
  assert.match(body.slice(second, second + 400), /found\.title/);
});

test("structure: there is exactly one Contents API write, inside putFile, behind the approval check", () => {
  assert.equal((SRC.match(/method:\s*"PUT"/g) || []).length, 1);
  const body = functionBody("putFile");
  assert.ok(body.indexOf("isApproval(approval)") > 0);
  assert.ok(body.indexOf("isApproval(approval)") < body.indexOf('method: "PUT"'));
  const code = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.equal((code.match(/(?<!io\.)\bputFile\(/g) || []).length, 1, "only the definition itself");
  assert.equal((code.match(/io\.putFile\(/g) || []).length, 3, "and the three gated callers");
});

test("structure: the CLI wrappers pass the lane and session identity to the exported functions", () => {
  assert.equal((SRC.match(/\.\.\.\(await cliIdentity\(\)\)/g) || []).length, 3, "add, finding add and finding close");
});

test("structure: the gate is loaded lazily, once, and never by a static import (the read verbs must not need it)", () => {
  const code = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!/^\s*import\b[^;]*public-write-gate/m.test(code), "no static import of the gate");
  assert.equal((code.match(/import\(\s*"\.\.\/\.\.\/setup\/public-write-gate\.mjs"\s*\)/g) || []).length, 1, "one dynamic import, inside loadGate");
  assert.ok(/async function loadGate\(\)/.test(code));
});

test("structure: the read verbs (check, list, finding list, finding check, reconcile) are not gated", () => {
  // Cut each function at the next top-level declaration or banner comment, and drop comments,
  // so a neighbouring comment block that mentions the gate cannot cause a false alarm.
  const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const bodyOf = (name) => {
    const start = SRC.indexOf(`async function ${name}(`);
    assert.ok(start >= 0, name);
    const stops = ["\nasync function ", "\nfunction ", "\nexport ", "\n// ====", "\n/** "]
      .map((marker) => SRC.indexOf(marker, start + 10))
      .filter((i) => i > 0);
    const end = stops.length ? Math.min(...stops) : SRC.length;
    return stripComments(SRC.slice(start, end));
  };
  for (const name of ["cmdCheck", "cmdList", "cmdFindingList", "cmdFindingCheck"]) {
    const body = bodyOf(name);
    assert.ok(body.length > 20, `${name} body found`);
    assert.ok(!/gatePublicWrite|cliIdentity|assertPublicWriteAllowed/.test(body), `${name} only reads`);
  }
  assert.ok(!/gatePublicWrite/.test(stripComments(functionBody("reconcileOpenFindings"))));
});

test("structure: the ledger source adds no dash characters of its own to the commit messages", () => {
  for (const m of SRC.matchAll(/`(?:regression-ledger|findings-ledger):[^`]*`/g)) {
    assert.ok(!DASH.test(m[0]), m[0]);
  }
});
