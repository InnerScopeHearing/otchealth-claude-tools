// Unit tests for the legal.mjs docket-row schema addition (Phase 7b/7d): source/verified fields,
// backward compat for rows written before this change, and the pure due/overdue predicate that
// `docket due` runs on. Pure functions only -- no live Azure Blob call, matching the fixture/mock
// only constraint (importing legal.mjs must never touch the network; see legal-import-safety
// below for that specific guarantee).
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeDocketRow, buildDocketRow, dueWindow, dueRow } from "../skills/legal/legal.mjs";

test("normalizeDocketRow: a legacy row with neither field defaults to manual/verified:true", () => {
  const legacy = { date: "2026-07-15", what: "FL-142/FL-150 disclosure due", added: "2026-06-18" };
  const n = normalizeDocketRow(legacy);
  assert.equal(n.source, "manual");
  assert.equal(n.verified, true);
  // original fields are preserved untouched
  assert.equal(n.date, "2026-07-15");
  assert.equal(n.what, "FL-142/FL-150 disclosure due");
  assert.equal(n.added, "2026-06-18");
});

test("normalizeDocketRow: an explicit source/verified on disk is preserved, not overwritten", () => {
  const staged = { date: "2026-08-01", what: "Docket Entry #5: Order granting extension", source: "courtlistener", verified: false };
  const n = normalizeDocketRow(staged);
  assert.equal(n.source, "courtlistener");
  assert.equal(n.verified, false);
});

test("normalizeDocketRow: verified:false must never be coerced to true", () => {
  const n = normalizeDocketRow({ date: "2026-08-01", what: "x", source: "extracted", verified: false });
  assert.equal(n.verified, false, "an explicit false must survive normalization exactly");
});

test("buildDocketRow: no source/verified given -> defaults to manual/true (docket add's original behavior)", () => {
  const row = buildDocketRow({ date: "2026-07-15", what: "hearing" });
  assert.equal(row.source, "manual");
  assert.equal(row.verified, true);
  assert.ok(row.added, "added is auto-stamped when not given");
});

test("buildDocketRow: explicit verified:false persists as false, not omitted/defaulted", () => {
  const row = buildDocketRow({ date: "2026-07-15", what: "staged candidate", source: "extracted", verified: false });
  assert.equal(row.verified, false);
  assert.equal(row.source, "extracted");
  // the field must actually be present (not just falsy-by-absence), so a later normalizeDocketRow
  // read never silently flips it back to true
  assert.ok("verified" in row);
});

test("buildDocketRow: an explicit `added` timestamp is respected (not overwritten with today)", () => {
  const row = buildDocketRow({ date: "2026-07-15", what: "x", added: "2020-01-01" });
  assert.equal(row.added, "2020-01-01");
});

test("dueWindow: computes cutoff and today from an injected `now` (deterministic, no live clock)", () => {
  const w = dueWindow(30, new Date("2026-07-15T00:00:00Z"));
  assert.equal(w.today, "2026-07-15");
  assert.equal(w.cutoff, "2026-08-14");
});

test("dueRow: a row past the cutoff horizon is excluded (returns null)", () => {
  const w = dueWindow(30, new Date("2026-07-15T00:00:00Z"));
  const row = dueRow("company", "ainnova-deal", { date: "2027-01-01", what: "far future" }, w);
  assert.equal(row, null);
});

test("dueRow: a row within the horizon is included, normalized, and flagged overdue correctly", () => {
  const w = dueWindow(30, new Date("2026-07-15T00:00:00Z"));
  const future = dueRow("company", "m1", { date: "2026-07-20", what: "not yet due" }, w);
  assert.equal(future.overdue, false);
  assert.equal(future.source, "manual"); // normalized default
  assert.equal(future.verified, true);

  const past = dueRow("company", "m1", { date: "2026-07-01", what: "already overdue" }, w);
  assert.equal(past.overdue, true);
});

test("dueRow: carries the ns + matter id through onto the display row", () => {
  const w = dueWindow(30, new Date("2026-07-15T00:00:00Z"));
  const row = dueRow("personal", "ca-divorce", { date: "2026-07-15", what: "FL-142/FL-150 disclosure due" }, w);
  assert.equal(row.ns, "personal");
  assert.equal(row.id, "ca-divorce");
});

// "docket due still works": simulate the CLI loop's per-matter/per-row pass (the same shape
// `docket due` builds), across a mix of legacy manual rows and new unverified staged candidates,
// and prove the resulting due-list is exactly what a CLO would expect to see.
test("docket due still works end to end (pure simulation, no live blob): mixed legacy + staged rows", () => {
  const matters = [
    { ns: "company", id: "ga-flsa-backwage", docket: [
      { date: "2026-07-10", what: "response deadline" }, // legacy row, no source/verified on disk
      { date: "2026-09-01", what: "way out of window" },
    ] },
    { ns: "personal", id: "ca-divorce", docket: [
      { date: "2026-07-20", what: "Docket Entry #5: Order granting extension", source: "courtlistener", verified: false },
      { date: "2026-08-01", what: "confirmed by CLO", source: "extracted", verified: true },
    ] },
  ];
  const w = dueWindow(30, new Date("2026-07-15T00:00:00Z"));
  const rows = [];
  for (const m of matters) for (const d of m.docket) { const r = dueRow(m.ns, m.id, d, w); if (r) rows.push(r); }
  rows.sort((a, b) => (a.date < b.date ? -1 : 1));

  assert.equal(rows.length, 3, "the far-future row (2026-09-01) must be excluded by the 30-day window");
  assert.deepEqual(rows.map((r) => r.date), ["2026-07-10", "2026-07-20", "2026-08-01"]);

  const legacyRow = rows.find((r) => r.id === "ga-flsa-backwage");
  assert.equal(legacyRow.source, "manual");
  assert.equal(legacyRow.verified, true);
  assert.equal(legacyRow.overdue, true, "2026-07-10 is before today (2026-07-15)");

  const stagedRow = rows.find((r) => r.what.includes("Docket Entry #5"));
  assert.equal(stagedRow.source, "courtlistener");
  assert.equal(stagedRow.verified, false, "an unstaged CourtListener candidate must stay unverified until confirmed");

  const confirmedRow = rows.find((r) => r.what === "confirmed by CLO");
  assert.equal(confirmedRow.source, "extracted");
  assert.equal(confirmedRow.verified, true);
});

// Import-safety guarantee that every helper above (and every skill built on top of legal.mjs)
// relies on: loading the module must never run the CLI dispatch (no process.exit, no network).
// If this regresses, deadline-extract.mjs / courtlistener-watch.mjs would crash the moment they
// `import` legal.mjs.
test("importing legal.mjs never triggers CLI dispatch or exits the process", async () => {
  const mod = await import("../skills/legal/legal.mjs");
  assert.ok(typeof mod.docketAdd === "function");
  assert.ok(typeof mod.docketAddMany === "function");
  assert.ok(typeof mod.docketVerify === "function");
  assert.ok(typeof mod.getMatter === "function");
  assert.ok(typeof mod.putMatter === "function");
  // reaching this line at all proves import did not call process.exit()
});
