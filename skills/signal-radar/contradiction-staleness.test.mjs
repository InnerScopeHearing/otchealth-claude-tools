// Hermetic regression gate for the contradiction-staleness detector's PURE core. No network, no Cosmos,
// no Azure, no clock coupling beyond an injected nowMs; the LLM entailment fn is INJECTED (a fake) so the
// whole scan is deterministic. Load-bearing guarantees:
//   1. extractEntityKeys does closed-vocabulary grouping + secret-id-shaped tokens (not open NER).
//   2. candidateSlice is same-entity-key, strictly-older, active-only, ring-safe, and CAPPED at <=20.
//   3. gateVerdict is the GROUNDING GATE (off-slice citation -> discarded) + MATERIALITY FLOOR
//      (only contradict / stale-with-material-drift fire; agree/supersede/paraphrase never).
//   4. recentClaimRows is the WINDOW filter (old rows excluded; ring-unsafe excluded).
//   5. scanRows caps LLM calls at MAX_LLM_CALLS and emits a NO-SILENT-TRUNCATION note when it bites.
//   6. the detector NEVER writes the ledger (it only returns Signal objects).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractEntityKeys, candidateSlice, gateVerdict, recentClaimRows, scanRows, ringSafe, NAME, OWNER,
} from "../signal-radar/detectors/contradiction-staleness.mjs";

const DAY = 86400000;
const NOW = Date.parse("2026-07-01T12:00:00Z");
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();

// ---------------------------------------- entity-key extraction ----------------------------------------
test("extractEntityKeys tags known closed-vocabulary entities as normalized keys", () => {
  const keys = extractEntityKeys("Azure AI Search stays Basic tier for iHEARtest", []);
  assert.ok(keys.includes("azure_ai_search"), "azure ai search phrase -> normKey");
  assert.ok(keys.includes("iheartest"));
});

test("extractEntityKeys catches secret-manager-id-shaped tokens", () => {
  const keys = extractEntityKeys("rotate revenuecat-secret-key and asc-api-key-p8 before launch", []);
  assert.ok(keys.includes("revenuecat-secret-key"));
  assert.ok(keys.includes("asc-api-key-p8"));
});

test("extractEntityKeys does NOT false-match an entity inside a bigger word", () => {
  const keys = extractEntityKeys("the awareness campaign shipped", []); // 'aware' inside 'awareness'
  assert.ok(!keys.includes("aware"), "must not tag 'aware' inside 'awareness'");
});

test("extractEntityKeys reads tags too", () => {
  const keys = extractEntityKeys("stays on the current tier", ["posthog", "note"]);
  assert.ok(keys.includes("posthog"));
});

// ------------------------------------------- candidate slice -------------------------------------------
test("candidateSlice returns only same-entity, strictly-older, active claim rows", () => {
  const rows = [
    { id: "20260601-001", agent: "cto", type: "fact", ts: iso(30 * DAY), text: "Azure AI Search will upgrade to S1 tier" },
    { id: "20260615-002", agent: "cto", type: "fact", ts: iso(16 * DAY), text: "PostHog is the primary observability lane" }, // different entity
    { id: "20260620-003", agent: "cto", type: "decision", ts: iso(11 * DAY), text: "Azure AI Search stays Basic tier per Matt" }, // supersedes nothing but same entity
  ];
  const newRow = { id: "20260630-004", agent: "cto", type: "fact", ts: iso(1 * DAY), text: "Azure AI Search is confirmed Basic, S1 was never executed" };
  const slice = candidateSlice(rows, newRow);
  const ids = slice.map((r) => r.id);
  assert.ok(ids.includes("20260601-001"), "same-entity older row is a candidate");
  assert.ok(ids.includes("20260620-003"), "same-entity older decision is a candidate");
  assert.ok(!ids.includes("20260615-002"), "different-entity row is excluded");
  assert.ok(!ids.includes("20260630-004"), "the new row itself is never a candidate");
});

test("candidateSlice excludes rows already SUPERSEDED (only the active claim compares)", () => {
  const rows = [
    { id: "20260601-001", agent: "cto", type: "fact", ts: iso(30 * DAY), text: "iheartest build is CFBundleVersion 43" },
    { id: "20260610-002", agent: "cto", type: "fact", ts: iso(21 * DAY), text: "iheartest build is CFBundleVersion 44", supersedes: "20260601-001" },
  ];
  const newRow = { id: "20260630-003", agent: "cto", type: "fact", ts: iso(1 * DAY), text: "iheartest current build is CFBundleVersion 47" };
  const slice = candidateSlice(rows, newRow);
  const ids = slice.map((r) => r.id);
  assert.ok(!ids.includes("20260601-001"), "superseded row is not a live claim, excluded");
  assert.ok(ids.includes("20260610-002"), "the active (superseding) row is a candidate");
});

test("candidateSlice caps at MAX_CANDIDATES (<=20), keeping the MOST RECENT", () => {
  const rows = [];
  for (let i = 0; i < 40; i++) {
    rows.push({ id: `2026-${String(i).padStart(3, "0")}`, agent: "cto", type: "fact", ts: iso((40 - i) * DAY + 5 * DAY), text: `depot fact number ${i}` });
  }
  const newRow = { id: "2026-999", agent: "cto", type: "fact", ts: iso(1 * DAY), text: "depot latest fact" };
  const slice = candidateSlice(rows, newRow);
  assert.equal(slice.length, 20, "hard-capped at 20");
  // the most-recent 20 (highest i) should survive; the oldest (i=0) must be dropped.
  assert.ok(!slice.some((r) => r.id === "2026-000"), "oldest candidate dropped");
  assert.ok(slice.some((r) => r.id === "2026-039"), "most-recent candidate kept");
});

test("candidateSlice drops ring-unsafe (MNPI/PHI) prior rows before they can be compared", () => {
  const rows = [
    { id: "20260601-001", agent: "cfo", type: "fact", ts: iso(30 * DAY), text: "INND share price and the Reg D raise on stripe" }, // MNPI markers
  ];
  const newRow = { id: "20260630-002", agent: "cfo", type: "fact", ts: iso(1 * DAY), text: "stripe payout schedule changed" };
  const slice = candidateSlice(rows, newRow);
  assert.equal(slice.length, 0, "the MNPI-tripping prior row is never placed in a slice");
});

// ------------------------------------------- grounding gate -------------------------------------------
const SLICE = [
  { id: "20260601-001", type: "fact", ts: iso(35 * DAY), text: "prior A" },
  { id: "20260602-002", type: "fact", ts: iso(34 * DAY), text: "prior B" },
];

test("gateVerdict FIRES for a grounded contradict verdict", () => {
  const g = gateVerdict({ label: "contradict", citedId: "20260601-001", reason: "conflict" }, SLICE);
  assert.equal(g.fires, true);
  assert.equal(g.citedRow.id, "20260601-001");
});

test("gateVerdict DISCARDS a contradict verdict whose citedId is NOT in the slice (ungrounded)", () => {
  const g = gateVerdict({ label: "contradict", citedId: "99999999-999", reason: "hallucinated" }, SLICE);
  assert.equal(g.fires, false);
  assert.match(g.reason, /ungrounded/);
});

test("gateVerdict NEVER fires for agree / supersede / paraphrase (materiality floor)", () => {
  for (const label of ["agree", "supersede", "paraphrase", "SUPERSEDE", "", "unknown"]) {
    const g = gateVerdict({ label, citedId: "20260601-001" }, SLICE);
    assert.equal(g.fires, false, `label '${label}' must not fire`);
  }
});

test("gateVerdict discards a stale verdict when the cited row is younger than the stale floor", () => {
  const freshSlice = [{ id: "20260628-001", type: "status", ts: iso(3 * DAY), text: "recent status" }];
  const g = gateVerdict({ label: "stale-with-material-drift", citedId: "20260628-001" }, freshSlice);
  assert.equal(g.fires, false, "a 3-day-old row is not stale");
  assert.match(g.reason, /stale floor/);
});

test("gateVerdict FIRES for a stale verdict when the cited row is genuinely old", () => {
  const oldSlice = [{ id: "20260501-001", type: "status", ts: iso(60 * DAY), text: "PENDING: Matt gate X" }];
  const g = gateVerdict({ label: "stale-with-material-drift", citedId: "20260501-001", reason: "moved on" }, oldSlice);
  assert.equal(g.fires, true);
});

// ------------------------------------------- window filter -------------------------------------------
test("recentClaimRows keeps in-window claim rows and drops old / ring-unsafe / non-claim rows", () => {
  const rows = [
    { id: "a", agent: "cto", type: "fact", ts: iso(2 * DAY), text: "recent posthog fact" },       // in-window claim -> keep
    { id: "b", agent: "cto", type: "fact", ts: iso(30 * DAY), text: "old posthog fact" },          // out of 7d window -> drop
    { id: "c", agent: "cto", type: "pitfall", ts: iso(1 * DAY), text: "a lesson about depot" },    // not a claim type -> drop
    { id: "d", agent: "cfo", type: "fact", ts: iso(1 * DAY), text: "INND stock price note" },      // ring-unsafe -> drop
  ];
  const keep = recentClaimRows(rows, NOW, 7).map((r) => r.id);
  assert.deepEqual(keep, ["a"]);
});

// ------------------------------- scanRows (pure core with injected entail) -------------------------------
test("scanRows emits a HIGH signal for a grounded contradiction and NEVER writes a ledger", async () => {
  const rows = [
    { id: "20260601-001", agent: "cto", type: "fact", ts: iso(30 * DAY), text: "Azure AI Search will upgrade to the S1 tier" },
    { id: "20260630-002", agent: "cto", type: "correction", ts: iso(1 * DAY), text: "Azure AI Search stays Basic; S1 was never executed" },
  ];
  // fake entailer: for the new correction, cite the prior fact as a contradiction (grounded).
  const entail = async (newRow, slice) => {
    if (newRow.id === "20260630-002") return { label: "contradict", citedId: slice[slice.length - 1].id, reason: "flip" };
    return { label: "agree", citedId: null };
  };
  const res = await scanRows(rows, entail, { nowMs: NOW });
  assert.equal(res.signals.length, 1, "one contradiction signal");
  const s = res.signals[0];
  assert.equal(s.severity, "high");
  assert.equal(s.detector, NAME);
  assert.equal(s.owner, OWNER);
  assert.match(s.suggested_action, /mem\.mjs correct/, "suggested action drafts the correct command (never runs it)");
  // report-mode: the returned objects are plain Signals, no side-effect handle to any ledger.
  assert.ok(!("write" in s) && !("commit" in s));
});

test("scanRows DISCARDS an ungrounded (hallucinated) contradiction verdict", async () => {
  const rows = [
    { id: "20260601-001", agent: "cto", type: "fact", ts: iso(30 * DAY), text: "depot is the ios build path" },
    { id: "20260630-002", agent: "cto", type: "fact", ts: iso(1 * DAY), text: "depot macos runner is depot-macos-26" },
  ];
  const entail = async () => ({ label: "contradict", citedId: "does-not-exist", reason: "made up" });
  const res = await scanRows(rows, entail, { nowMs: NOW });
  assert.equal(res.signals.length, 0, "ungrounded verdict never becomes a signal");
});

test("scanRows only fires contradict/stale, never agree/supersede", async () => {
  const rows = [
    { id: "20260601-001", agent: "cto", type: "fact", ts: iso(30 * DAY), text: "flatstick build is CFBundleVersion 16" },
    { id: "20260630-002", agent: "cto", type: "fact", ts: iso(1 * DAY), text: "flatstick build is CFBundleVersion 17" },
  ];
  const entail = async (newRow, slice) => ({ label: "supersede", citedId: slice[0].id }); // normal bump
  const res = await scanRows(rows, entail, { nowMs: NOW });
  assert.equal(res.signals.length, 0, "a normal version bump (supersede) does not fire");
});

test("scanRows caps LLM calls at maxLlmCalls and adds a NO-SILENT-TRUNCATION note", async () => {
  // build many recent same-entity rows so each has a prior slice and thus triggers an entail call.
  const rows = [];
  for (let i = 0; i < 10; i++) {
    rows.push({ id: `20260625-${String(i).padStart(3, "0")}`, agent: "cto", type: "fact", ts: iso((6 * DAY) - i * 3600000), text: `cosmos fact iteration ${i}` });
  }
  let calls = 0;
  const entail = async () => { calls++; return { label: "agree", citedId: null }; };
  const res = await scanRows(rows, entail, { nowMs: NOW, maxLlmCalls: 3 });
  assert.equal(res.truncated, true, "truncated flag set");
  assert.ok(calls <= 3, "no more than the cap of entail calls were made");
  assert.ok(res.notes.some((n) => /TRUNCATED/.test(n)), "a no-silent-truncation note is present");
});

test("scanRows with no recent rows returns empty + a note (fail-quiet)", async () => {
  const rows = [{ id: "20260101-001", agent: "cto", type: "fact", ts: iso(100 * DAY), text: "ancient depot fact" }];
  const called = { n: 0 };
  const entail = async () => { called.n++; return { label: "agree" }; };
  const res = await scanRows(rows, entail, { nowMs: NOW });
  assert.equal(res.signals.length, 0);
  assert.equal(called.n, 0, "no entail call when nothing is in-window");
  assert.ok(res.notes.some((n) => /no ring-safe claim rows/.test(n)));
});

test("ringSafe rejects MNPI + PHI rows, accepts benign infra rows", () => {
  assert.equal(ringSafe({ agent: "cto", text: "depot runner depot-macos-26" }), true);
  assert.equal(ringSafe({ agent: "cfo", text: "INND reg D raise, share price" }), false);
  assert.equal(ringSafe({ agent: "medreview", text: "anything" }), false, "PHI agent excluded");
  assert.equal(ringSafe({ agent: "cto", text: "the patient audiogram hearing number" }), false, "PHI markers excluded");
});
