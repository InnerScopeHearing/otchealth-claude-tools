// Hermetic regression gate for the groundedness detector's PURE core. No network, no Azure, no clock
// coupling beyond an injected nowMs; the LLM faithfulness fn is INJECTED (a fake) so the whole scan is
// deterministic. Load-bearing guarantees:
//   1. checkableRows only selects claim-type, in-window, ring-safe rows that carry a non-empty `source`.
//   2. gateVerdict is the GROUNDING GATE (mismatched rowId -> discarded) + MATERIALITY FLOOR
//      (only unsupported / contradicted fire; supported / partial never do).
//   3. scanRows caps LLM calls at maxLlmCalls and emits a NO-SILENT-TRUNCATION note when it bites.
//   4. PHI/MNPI rows are excluded via ringSafe before any LLM call happens (defense in depth).
//   5. the detector NEVER writes the ledger (it only returns Signal objects).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkableRows, gateVerdict, scanRows, ringSafe, NAME, OWNER,
} from "../signal-radar/detectors/groundedness.mjs";

const DAY = 86400000;
const NOW = Date.parse("2026-07-01T12:00:00Z");
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();

// ------------------------------------------- checkableRows -------------------------------------------
test("checkableRows keeps in-window, claim-type, sourced, ring-safe rows only", () => {
  const rows = [
    { id: "a", agent: "cto", type: "fact", ts: iso(2 * DAY), text: "Azure AI Search stays Basic", source: "vendor pricing page: Basic tier confirmed" }, // keep
    { id: "b", agent: "cto", type: "fact", ts: iso(30 * DAY), text: "old fact", source: "some doc" }, // out of window -> drop
    { id: "c", agent: "cto", type: "fact", ts: iso(1 * DAY), text: "no source claim" }, // no source -> drop
    { id: "d", agent: "cto", type: "pitfall", ts: iso(1 * DAY), text: "a lesson", source: "postmortem doc" }, // not a claim type -> drop
    { id: "e", agent: "cfo", type: "fact", ts: iso(1 * DAY), text: "INND stock price note", source: "filing" }, // ring-unsafe -> drop
    { id: "f", agent: "medreview", type: "fact", ts: iso(1 * DAY), text: "anything", source: "chart" }, // PHI agent -> drop
  ];
  const keep = checkableRows(rows, NOW, 7).map((r) => r.id);
  assert.deepEqual(keep, ["a"]);
});

test("checkableRows tolerates a stray non-object feed line without throwing", () => {
  const rows = [null, 5, "x", { id: "a", agent: "cto", type: "fact", ts: iso(1 * DAY), text: "t", source: "s" }];
  const keep = checkableRows(rows, NOW, 7).map((r) => r.id);
  assert.deepEqual(keep, ["a"]);
});

test("checkableRows treats a blank/whitespace-only source as absent (no source, no check)", () => {
  const rows = [{ id: "a", agent: "cto", type: "fact", ts: iso(1 * DAY), text: "t", source: "   " }];
  assert.equal(checkableRows(rows, NOW, 7).length, 0);
});

// ------------------------------------------- grounding gate -------------------------------------------
const ROW = { id: "20260630-002", type: "fact", ts: iso(1 * DAY), text: "claim text", source: "source text" };

test("gateVerdict FIRES for a grounded unsupported verdict (rowId matches)", () => {
  const g = gateVerdict({ rowId: "20260630-002", label: "unsupported", reason: "goes beyond source" }, ROW);
  assert.equal(g.fires, true);
  assert.equal(g.label, "unsupported");
});

test("gateVerdict FIRES for a grounded contradicted verdict (rowId matches)", () => {
  const g = gateVerdict({ rowId: "20260630-002", label: "contradicted", reason: "conflicts" }, ROW);
  assert.equal(g.fires, true);
});

test("gateVerdict DISCARDS a verdict whose rowId does not match the row asked about (ungrounded)", () => {
  const g = gateVerdict({ rowId: "some-other-row", label: "unsupported", reason: "mixup" }, ROW);
  assert.equal(g.fires, false);
  assert.match(g.reason, /ungrounded verdict/);
});

test("gateVerdict NEVER fires for supported / partial (materiality floor)", () => {
  for (const label of ["supported", "partial", "SUPPORTED", "", "unknown"]) {
    const g = gateVerdict({ rowId: "20260630-002", label }, ROW);
    assert.equal(g.fires, false, `label '${label}' must not fire`);
  }
});

// ------------------------------- scanRows (pure core with injected check) -------------------------------
test("scanRows emits a HIGH signal for a grounded contradicted verdict and NEVER writes a ledger", async () => {
  const rows = [
    { id: "20260630-002", agent: "cto", type: "fact", ts: iso(1 * DAY), text: "Azure AI Search upgraded to S1", source: "vendor invoice: still on Basic tier as of this month" },
  ];
  const check = async (row) => ({ rowId: row.id, label: "contradicted", reason: "invoice says Basic, claim says S1" });
  const res = await scanRows(rows, check, { nowMs: NOW });
  assert.equal(res.signals.length, 1, "one contradicted signal");
  const s = res.signals[0];
  assert.equal(s.severity, "high");
  assert.equal(s.detector, NAME);
  assert.equal(s.owner, OWNER);
  assert.match(s.suggested_action, /mem\.mjs correct/, "suggested action drafts the correct command (never runs it)");
  // report-mode: the returned objects are plain Signals, no side-effect handle to any ledger.
  assert.ok(!("write" in s) && !("commit" in s));
});

test("scanRows emits a MEDIUM signal for a grounded unsupported verdict", async () => {
  const rows = [
    { id: "20260630-003", agent: "cto", type: "fact", ts: iso(1 * DAY), text: "the vendor guarantees 99.99% uptime forever", source: "vendor pricing page mentions Basic tier SLA of 99.9% during business hours" },
  ];
  const check = async (row) => ({ rowId: row.id, label: "unsupported", reason: "claim overstates the SLA" });
  const res = await scanRows(rows, check, { nowMs: NOW });
  assert.equal(res.signals.length, 1);
  assert.equal(res.signals[0].severity, "medium");
});

test("scanRows classifies a supported claim as GROUNDED (no signal)", async () => {
  const rows = [
    { id: "20260630-004", agent: "cto", type: "fact", ts: iso(1 * DAY), text: "Azure AI Search stays on Basic tier", source: "vendor pricing page: current plan is Basic tier" },
  ];
  const check = async (row) => ({ rowId: row.id, label: "supported", reason: "directly stated" });
  const res = await scanRows(rows, check, { nowMs: NOW });
  assert.equal(res.signals.length, 0, "a supported claim never fires");
});

test("scanRows classifies a partial (reasonable paraphrase) claim as GROUNDED (no signal)", async () => {
  const rows = [
    { id: "20260630-005", agent: "cto", type: "fact", ts: iso(1 * DAY), text: "the release shipped successfully", source: "CI log: build 47 passed all checks and was deployed to prod at 14:02 UTC" },
  ];
  const check = async (row) => ({ rowId: row.id, label: "partial", reason: "reasonable summary" });
  const res = await scanRows(rows, check, { nowMs: NOW });
  assert.equal(res.signals.length, 0, "a reasonable paraphrase never fires");
});

test("scanRows DISCARDS an ungrounded (mismatched rowId) verdict", async () => {
  const rows = [
    { id: "20260630-006", agent: "cto", type: "fact", ts: iso(1 * DAY), text: "claim", source: "source" },
  ];
  const check = async () => ({ rowId: "not-this-row", label: "contradicted", reason: "made up" });
  const res = await scanRows(rows, check, { nowMs: NOW });
  assert.equal(res.signals.length, 0, "ungrounded verdict never becomes a signal");
});

test("scanRows skips rows with no source entirely (never calls the checker on them)", async () => {
  const rows = [
    { id: "a", agent: "cto", type: "fact", ts: iso(1 * DAY), text: "no source here" },
    { id: "b", agent: "cto", type: "fact", ts: iso(1 * DAY), text: "has a source", source: "some doc excerpt" },
  ];
  let calls = 0;
  const check = async (row) => { calls++; return { rowId: row.id, label: "supported" }; };
  const res = await scanRows(rows, check, { nowMs: NOW });
  assert.equal(calls, 1, "only the sourced row triggers a check call (cost-bound: no-source rows are free)");
});

test("scanRows caps LLM calls at maxLlmCalls and adds a NO-SILENT-TRUNCATION note (cost-bound truncation)", async () => {
  const rows = [];
  for (let i = 0; i < 10; i++) {
    rows.push({ id: `20260625-${String(i).padStart(3, "0")}`, agent: "cto", type: "fact", ts: iso((6 * DAY) - i * 3600000), text: `claim ${i}`, source: `source excerpt ${i}` });
  }
  let calls = 0;
  const check = async (row) => { calls++; return { rowId: row.id, label: "supported" }; };
  const res = await scanRows(rows, check, { nowMs: NOW, maxLlmCalls: 3 });
  assert.equal(res.truncated, true, "truncated flag set");
  assert.ok(calls <= 3, "no more than the cap of check calls were made (bounded gpt tier, <=40 in prod, <=3 here)");
  assert.ok(res.notes.some((n) => /TRUNCATED/.test(n)), "a no-silent-truncation note is present");
});

test("scanRows with no eligible rows returns empty + a note (fail-quiet)", async () => {
  const rows = [{ id: "20260101-001", agent: "cto", type: "fact", ts: iso(100 * DAY), text: "ancient claim", source: "ancient source" }];
  const called = { n: 0 };
  const check = async (row) => { called.n++; return { rowId: row.id, label: "supported" }; };
  const res = await scanRows(rows, check, { nowMs: NOW });
  assert.equal(res.signals.length, 0);
  assert.equal(called.n, 0, "no check call when nothing is in-window");
  assert.ok(res.notes.some((n) => /no ring-safe sourced claim rows/.test(n)));
});

// ------------------------------------------- ringSafe / PHI exclusion -------------------------------------------
test("ringSafe rejects MNPI + PHI rows, accepts benign infra rows", () => {
  assert.equal(ringSafe({ agent: "cto", text: "depot runner depot-macos-26", source: "ci config" }), true);
  assert.equal(ringSafe({ agent: "cfo", text: "INND reg D raise, share price", source: "filing" }), false);
  assert.equal(ringSafe({ agent: "medreview", text: "anything", source: "chart" }), false, "PHI agent excluded");
  assert.equal(ringSafe({ agent: "cto", text: "the patient audiogram hearing number", source: "note" }), false, "PHI markers excluded");
});

test("ringSafe also inspects the source field itself for MNPI/PHI markers (defense in depth)", () => {
  // claim text alone looks benign, but the cited SOURCE carries a PHI/MNPI marker - must still be excluded
  // so that text is never sent through the LLM prompt via the source field either.
  assert.equal(ringSafe({ agent: "cto", text: "a routine infra note", source: "patient diagnosis details" }), false);
  assert.equal(ringSafe({ agent: "cto", text: "a routine infra note", source: "INND stock price update" }), false);
});
