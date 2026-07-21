// Tests for regression-ledger's `finding` extension (FINDINGS-LEDGER.md tracking). Pure, no network:
// exercises the same parse/render/upsert/filter/reconcile functions the finding add/list/close/check
// CLI verbs are built on (add is upsertFinding on a new id, close is upsertFinding on an existing id
// with a mutated status, list is filterFindings, check is reconcileSummary), plus the fail-open
// contract of the async wrappers (addFinding/closeFinding/reconcileOpenFindings). For the fail-open
// tests, global.fetch is stubbed to always reject so no real GitHub API call is ever reachable, no
// matter what credentials happen to exist in the ambient sandbox; the stub is always restored in a
// finally block so it cannot leak into any other test file.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseFindings,
  renderFinding,
  upsertFinding,
  filterFindings,
  reconcileSummary,
  SEVERITIES,
  FINDING_STATUSES,
  addFinding,
  closeFinding,
  reconcileOpenFindings,
} from "../ledger.mjs";

function baseFinding(overrides = {}) {
  return {
    id: "FND-20260721-test",
    severity: "high",
    status: "open",
    title: "gateway cold-start check runs in warn-only mode fleet-wide",
    source_audit_doc: "specs/2026-07-14-AI-OS-SPEC-OF-RECORD.md",
    fix_commit: null,
    verified_by: null,
    opened: "2026-07-21T12:00:00.000Z",
    closed: null,
    ...overrides,
  };
}

// ---- pure round-trip: render -> parse ----

test("renderFinding -> parseFindings round-trips every field", () => {
  const f = baseFinding();
  const md = renderFinding(f);
  const parsed = parseFindings(md);
  assert.equal(parsed.length, 1);
  assert.deepEqual(parsed[0], f);
});

test("renderFinding placeholders parse back to null for unset fields", () => {
  const f = baseFinding({ fix_commit: null, verified_by: null, closed: null });
  const [parsed] = parseFindings(renderFinding(f));
  assert.equal(parsed.fix_commit, null);
  assert.equal(parsed.verified_by, null);
  assert.equal(parsed.closed, null);
});

test("parseFindings on empty or null content returns an empty array, never throws", () => {
  assert.deepEqual(parseFindings(""), []);
  assert.deepEqual(parseFindings(null), []);
  assert.deepEqual(parseFindings(undefined), []);
});

// ---- upsertFinding: this is what BOTH add (new id) and close (existing id) call ----

test("upsertFinding on empty content creates the doc header and appends the finding", () => {
  const { content, created } = upsertFinding("", baseFinding());
  assert.equal(created, true);
  assert.match(content, /# Findings Ledger/);
  const parsed = parseFindings(content);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].id, "FND-20260721-test");
  assert.equal(parsed[0].status, "open");
});

test("upsertFinding with an existing id updates in place (this is what close does), never duplicates", () => {
  const opened = upsertFinding("", baseFinding()).content;
  const closedFinding = baseFinding({
    status: "fixed",
    fix_commit: "abc1234",
    verified_by: "unit test",
    closed: "2026-07-21T13:00:00.000Z",
  });
  const { content, created } = upsertFinding(opened, closedFinding);
  assert.equal(created, false);
  const parsed = parseFindings(content);
  assert.equal(parsed.length, 1, "close must update the entry in place, never append a duplicate");
  assert.equal(parsed[0].status, "fixed");
  assert.equal(parsed[0].fix_commit, "abc1234");
  assert.equal(parsed[0].verified_by, "unit test");
  assert.equal(parsed[0].closed, "2026-07-21T13:00:00.000Z");
});

test("upsertFinding preserves other findings when updating one by id", () => {
  let content = upsertFinding("", baseFinding({ id: "FND-a", title: "first" })).content;
  content = upsertFinding(content, baseFinding({ id: "FND-b", title: "second", severity: "low" })).content;
  content = upsertFinding(content, baseFinding({ id: "FND-a", title: "first", status: "wontfix", closed: "2026-07-21T13:30:00.000Z" })).content;
  const parsed = parseFindings(content);
  assert.equal(parsed.length, 2);
  const a = parsed.find((f) => f.id === "FND-a");
  const b = parsed.find((f) => f.id === "FND-b");
  assert.equal(a.status, "wontfix");
  assert.equal(b.status, "open", "an unrelated finding must be untouched by another finding's close");
  assert.equal(b.severity, "low");
});

// ---- filterFindings: backs `finding list` and the id-or-source lookup in `finding check` ----

test("filterFindings filters by status, severity, and case-insensitive source substring", () => {
  const findings = [
    baseFinding({ id: "1", status: "open", severity: "critical", source_audit_doc: "audits/AI-OS-2026-07-14.md" }),
    baseFinding({ id: "2", status: "fixed", severity: "low", source_audit_doc: "audits/other-audit.md" }),
    baseFinding({ id: "3", status: "open", severity: "medium", source_audit_doc: "audits/ai-os-followup.md" }),
  ];
  assert.equal(filterFindings(findings, { status: "open" }).length, 2);
  assert.equal(filterFindings(findings, { severity: "critical" }).length, 1);
  assert.deepEqual(filterFindings(findings, { source: "ai-os" }).map((f) => f.id).sort(), ["1", "3"]);
  assert.equal(filterFindings(findings, { id: "2" }).length, 1);
  assert.equal(filterFindings(findings, {}).length, 3, "no filters means everything passes through");
});

// ---- reconcileSummary: the whole of what an audit / "PR done" gate needs ----

test("reconcileSummary reports open count, per-severity tally, and the clean flag", () => {
  const findings = [
    baseFinding({ id: "1", status: "open", severity: "critical" }),
    baseFinding({ id: "2", status: "open", severity: "critical" }),
    baseFinding({ id: "3", status: "fixed", severity: "high" }),
    baseFinding({ id: "4", status: "open", severity: "low" }),
  ];
  const s = reconcileSummary(findings);
  assert.equal(s.total, 4);
  assert.equal(s.openCount, 3);
  assert.equal(s.bySeverity.critical, 2);
  assert.equal(s.bySeverity.low, 1);
  assert.equal(s.bySeverity.high, 0);
  assert.equal(s.clean, false);
});

test("reconcileSummary.clean is true only when nothing is open", () => {
  const findings = [baseFinding({ id: "1", status: "fixed" }), baseFinding({ id: "2", status: "wontfix" })];
  assert.equal(reconcileSummary(findings).clean, true);
  assert.equal(reconcileSummary([]).clean, true);
});

test("SEVERITIES and FINDING_STATUSES expose exactly the schema's allowed values", () => {
  assert.deepEqual([...SEVERITIES].sort(), ["critical", "high", "low", "medium"]);
  assert.deepEqual([...FINDING_STATUSES].sort(), ["fixed", "open", "wontfix"]);
});

// ---- fail-fast validation (no network needed to reject bad input) ----

test("addFinding validates severity before touching the network", async () => {
  const res = await addFinding({ severity: "urgent", source_audit_doc: "x.md", title: "x" });
  assert.equal(res.ok, false);
  assert.match(res.error, /severity/);
});

test("addFinding requires source_audit_doc and title before touching the network", async () => {
  const noSource = await addFinding({ severity: "high", title: "x" });
  assert.equal(noSource.ok, false);
  assert.match(noSource.error, /source_audit_doc/);

  const noTitle = await addFinding({ severity: "high", source_audit_doc: "x.md" });
  assert.equal(noTitle.ok, false);
  assert.match(noTitle.error, /title/);
});

test("closeFinding rejects an attempt to close back to status open, before touching the network", async () => {
  const res = await closeFinding("FND-whatever", { status: "open" });
  assert.equal(res.ok, false);
  assert.match(res.error, /open/);
});

// ---- fail-open contract: a network failure must never throw into the caller ----

test("addFinding fails open (returns ok:false, never throws) when the network is unreachable", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => { throw new Error("network disabled for this test"); };
  try {
    const res = await addFinding({ severity: "high", source_audit_doc: "x.md", title: "x" });
    assert.equal(res.ok, false);
    assert.equal(typeof res.error, "string");
  } finally {
    global.fetch = originalFetch;
  }
});

test("closeFinding fails open when the network is unreachable", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => { throw new Error("network disabled for this test"); };
  try {
    const res = await closeFinding("FND-doesnt-matter", { status: "fixed" });
    assert.equal(res.ok, false);
    assert.equal(typeof res.error, "string");
  } finally {
    global.fetch = originalFetch;
  }
});

test("reconcileOpenFindings fails open (ok:false, clean:true) when the network is unreachable, never throws", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => { throw new Error("network disabled for this test"); };
  try {
    const res = await reconcileOpenFindings();
    assert.equal(res.ok, false);
    assert.equal(res.clean, true, "fail-open: an unreachable ledger must never assert a blocking finding");
    assert.equal(typeof res.error, "string");
  } finally {
    global.fetch = originalFetch;
  }
});

test("reconcileOpenFindings fails open the same way when scoped to an id or source", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => { throw new Error("network disabled for this test"); };
  try {
    const res = await reconcileOpenFindings("some-source-doc.md");
    assert.equal(res.ok, false);
    assert.equal(res.clean, true);
  } finally {
    global.fetch = originalFetch;
  }
});
