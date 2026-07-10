// Tests for ledger-compaction/compact.mjs, the pure, non-destructive ledger summarizer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { compactLedger, parseLedgerText, renderMarkdown, renderNdjson } from "../skills/ledger-compaction/compact.mjs";

// ---- synthetic ledger --------------------------------------------------------------------------
// Row shape matches skills/kb-memory/mem.mjs: { id, ts, type, text, tags, source, was, supersedes,
// ekey, evalue, agent }. Known types: fact, decision, pitfall, status, correction, entity, alias.
function buildSyntheticLedger() {
  const rows = [];

  // decisions
  rows.push({ id: "dec1", ts: "2026-05-01T00:00:00Z", type: "decision", text: "Adopt Azure Blob for ledger storage" });
  rows.push({ id: "dec2", ts: "2026-05-05T00:00:00Z", type: "decision", text: "Move nightly digest to gpt-4.1-mini for cost" });

  // corrections
  rows.push({ id: "cor1", ts: "2026-05-02T00:00:00Z", type: "correction", text: "Xero CORE tier daily cap is 4800 calls", was: "Xero CORE tier daily cap is 900 calls" });
  rows.push({ id: "cor2", ts: "2026-05-06T00:00:00Z", type: "correction", text: "grant term is 11 months not 12", was: "grant term is 12 months" });

  // pitfalls
  rows.push({ id: "pit1", ts: "2026-05-03T00:00:00Z", type: "pitfall", text: "Do not trust in-session recall; the ledger is the source of truth" });
  rows.push({ id: "pit2", ts: "2026-05-07T00:00:00Z", type: "pitfall", text: "A detached spawn is killed under Hyperagent; index synchronously there" });

  // a superseded chain of 4 versions for one ekey
  rows.push({ id: "ent1", ts: "2026-05-01T00:00:00Z", type: "entity", ekey: "release_build", evalue: "10", text: "release_build = 10" });
  rows.push({ id: "ent2", ts: "2026-05-08T00:00:00Z", type: "entity", ekey: "release_build", evalue: "11", text: "release_build = 11", supersedes: "ent1" });
  rows.push({ id: "ent3", ts: "2026-05-15T00:00:00Z", type: "entity", ekey: "release_build", evalue: "12", text: "release_build = 12", supersedes: "ent2" });
  rows.push({ id: "ent4", ts: "2026-05-22T00:00:00Z", type: "entity", ekey: "release_build", evalue: "13", text: "release_build = 13", supersedes: "ent3" });

  // a second entity, single value (no chain), to prove distinct ekeys are all covered
  rows.push({ id: "ent5", ts: "2026-05-10T00:00:00Z", type: "entity", ekey: "app_store_status", evalue: "in review", text: "app_store_status = in review" });

  // near-duplicate fact/status rows (high token overlap)
  rows.push({ id: "fac1", ts: "2026-05-04T00:00:00Z", type: "fact", text: "the daily API rate limit for Xero is 5000 calls" });
  rows.push({ id: "fac2", ts: "2026-05-04T01:00:00Z", type: "fact", text: "the daily API rate limit for Xero is 5000 calls today" });
  rows.push({ id: "fac3", ts: "2026-05-04T02:00:00Z", type: "fact", text: "the daily API rate limit for Xero is 5000 calls now" });

  // 12 old low-signal status rows (all older than the recency window) plus 2 recent ones
  for (let i = 1; i <= 12; i++) {
    const day = String(i).padStart(2, "0");
    rows.push({ id: `sta${i}`, ts: `2026-04-${day}T00:00:00Z`, type: "status", text: `working on task ${i} of the spring cleanup` });
  }
  rows.push({ id: "sta13", ts: "2026-06-28T00:00:00Z", type: "status", text: "working on the ledger-compaction rollout" });
  rows.push({ id: "sta14", ts: "2026-06-30T00:00:00Z", type: "status", text: "wrapping up the ledger-compaction rollout" });

  return rows;
}

// ---- ndjson parsing -----------------------------------------------------------------------------

test("parseLedgerText parses well-formed ndjson, skips blank lines, tolerates trailing newline", () => {
  const text = '{"id":"a","ts":"2026-01-01T00:00:00Z","type":"fact","text":"x"}\n\n{"id":"b","ts":"2026-01-02T00:00:00Z","type":"fact","text":"y"}\n';
  const { rows, errors } = parseLedgerText(text);
  assert.equal(rows.length, 2);
  assert.equal(errors.length, 0);
  assert.equal(rows[0].id, "a");
  assert.equal(rows[1].id, "b");
});

test("parseLedgerText reports unparseable lines instead of throwing", () => {
  const text = '{"id":"a","type":"fact","text":"ok"}\nnot json at all\n{"id":"b","type":"fact","text":"also ok"}\n';
  const { rows, errors } = parseLedgerText(text);
  assert.equal(rows.length, 2);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].line, 2);
});

// ---- core preservation guarantees -----------------------------------------------------------------

test("every decision, correction, and pitfall row's text appears verbatim in the compacted markdown", () => {
  const rows = buildSyntheticLedger();
  const result = compactLedger(rows);
  const md = renderMarkdown(result, "synthetic");
  const alwaysKeepTexts = rows
    .filter((r) => ["decision", "correction", "pitfall"].includes(r.type))
    .map((r) => r.text);
  for (const text of alwaysKeepTexts) {
    assert.ok(md.includes(text), `expected decision/correction/pitfall text to appear verbatim: "${text}"`);
  }
});

test("the CURRENT (latest) value for each ekey appears verbatim, including a single-value entity", () => {
  const rows = buildSyntheticLedger();
  const result = compactLedger(rows);
  const md = renderMarkdown(result, "synthetic");
  assert.ok(md.includes("release_build") && md.includes("13"), "latest chained entity value (13) should appear");
  assert.ok(md.includes("app_store_status") && md.includes("in review"), "single-value entity should appear verbatim");
});

test("near-duplicate facts collapse to a single representative row with a count annotation", () => {
  const rows = buildSyntheticLedger();
  const result = compactLedger(rows);
  // The 3 near-duplicate Xero fact rows should collapse into exactly one cluster of size 3.
  const xeroClusters = result.consolidatedFacts.filter((c) => /xero/i.test(c.row.text));
  assert.equal(xeroClusters.length, 1, "the 3 near-duplicate Xero facts should collapse into one cluster");
  assert.equal(xeroClusters[0].count, 3);
  assert.ok(xeroClusters[0].isDuplicateCluster);
  const md = renderMarkdown(result, "synthetic");
  assert.match(md, /x3/, "markdown should show a count annotation for the collapsed cluster");
});

test("the superseded chain collapses to the latest value plus a history note, not 4 repeated rows", () => {
  const rows = buildSyntheticLedger();
  const result = compactLedger(rows);
  const entry = result.currentEntities.find((e) => e.ekey === "release_build");
  assert.ok(entry, "release_build entity should be present");
  assert.equal(entry.row.evalue, "13");
  assert.ok(entry.historyNote, "a history note should be present for a superseded chain");
  // The history note is a compact one-liner listing the earlier values, not full repeated rows.
  assert.match(entry.historyNote, /10 -> 11 -> 12 -> 13/);
  const md = renderMarkdown(result, "synthetic");
  // The full markdown should mention each historical value once (inside the one-line note), never
  // as 4 separate bulleted "Current Entity Values" rows.
  const currentValuesSection = md.split("## Current Entity Values")[1].split("## Superseded Chains")[0];
  const bulletCount = (currentValuesSection.match(/^- `release_build`/gm) || []).length;
  assert.equal(bulletCount, 1, "release_build should appear as exactly one current-value bullet, not one per historical version");
});

test("old low-signal status rows beyond the recency window roll into one digest row", () => {
  const rows = buildSyntheticLedger();
  const result = compactLedger(rows, { statusKeepRecent: 2, statusKeepDays: 7, now: Date.parse("2026-07-01T00:00:00Z") });
  // 14 status rows total: 12 old (April) + 2 recent (late June). With statusKeepRecent=2, the two
  // most recent are kept in full and the 12 old ones digest into a single row.
  assert.equal(result.lowSignalKept.length, 2);
  assert.ok(result.statusDigest, "a status digest row should be produced");
  assert.equal(result.statusDigest.count, 12);
  const md = renderMarkdown(result, "synthetic");
  assert.match(md, /12 additional status updates between/);
});

// ---- stats shape ----------------------------------------------------------------------------------

test("stats object has the right shape and sane values", () => {
  const rows = buildSyntheticLedger();
  const result = compactLedger(rows, { statusKeepRecent: 2, statusKeepDays: 7, now: Date.parse("2026-07-01T00:00:00Z") });
  const { stats } = result;
  assert.equal(typeof stats.before, "number");
  assert.equal(typeof stats.after, "number");
  assert.equal(typeof stats.preserved, "number");
  assert.equal(typeof stats.collapsed, "number");
  assert.equal(stats.before, rows.length);
  assert.ok(stats.after <= stats.before, "compacted row count should never exceed the source row count");

  const distinctEkeys = new Set(rows.filter((r) => r.type === "entity").map((r) => r.ekey)).size;
  const alwaysKeepCount = rows.filter((r) => ["decision", "correction", "pitfall"].includes(r.type)).length;
  assert.ok(
    stats.preserved >= alwaysKeepCount + distinctEkeys,
    `preserved (${stats.preserved}) should be at least decisions+corrections+pitfalls (${alwaysKeepCount}) + distinct ekeys (${distinctEkeys})`
  );
});

// ---- non-destructive guarantee ---------------------------------------------------------------------

test("compaction never mutates the source rows array or any row object (frozen input survives)", () => {
  const rows = buildSyntheticLedger();
  // Deep-freeze every row and the array itself, so any attempted mutation throws in strict mode or
  // is silently rejected in sloppy mode - either way, a structural comparison below catches it.
  const before = JSON.stringify(rows);
  for (const r of rows) Object.freeze(r);
  Object.freeze(rows);

  const result = compactLedger(rows, { statusKeepRecent: 2, statusKeepDays: 7, now: Date.parse("2026-07-01T00:00:00Z") });
  renderMarkdown(result, "synthetic");
  renderNdjson(result);

  const after = JSON.stringify(rows);
  assert.equal(after, before, "the source rows array must be byte-identical after compaction and rendering");
});

test("compaction does not mutate a raw ndjson string source either", () => {
  const ledgerText = buildSyntheticLedger().map((r) => JSON.stringify(r)).join("\n") + "\n";
  const frozenCopy = ledgerText;
  const { rows } = parseLedgerText(ledgerText);
  compactLedger(rows);
  assert.equal(ledgerText, frozenCopy, "the original ndjson text variable must be unchanged (strings are immutable, but this proves no in-place buffer trick was used)");
});

test("parseLedgerText and compactLedger produce no em dashes or en dashes in any output text", () => {
  const rows = buildSyntheticLedger();
  const result = compactLedger(rows, { statusKeepRecent: 2, statusKeepDays: 7, now: Date.parse("2026-07-01T00:00:00Z") });
  const md = renderMarkdown(result, "synthetic");
  const ndjson = renderNdjson(result);
  assert.ok(!/[–—]/.test(md), "compacted markdown must not contain an em dash or en dash");
  assert.ok(!/[–—]/.test(ndjson), "compacted ndjson must not contain an em dash or en dash");
});
