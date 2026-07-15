// Unit tests for courtlistener-watch.mjs (Phase 7d). ALL network access goes through an
// injectable `fetchFn` (per the task spec: "accept an injectable fetch so tests never hit the
// network"). No test here ever calls real CourtListener, Azure Blob, a service account, or an
// LLM. The central property under test: discovered entries stage as source:'courtlistener',
// verified:false (confirm-before-page).
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeEntry, selectNewEntries, stageRows, fetchDocketEntries } from "../skills/legal/courtlistener-watch.mjs";

// ---- normalizeEntry ----

test("normalizeEntry maps a raw CourtListener docket-entry to {date, what}", () => {
  const raw = { id: 1, docket: 12345, date_filed: "2026-07-20", entry_number: 5, description: "Order granting extension of time to respond" };
  const n = normalizeEntry(raw);
  assert.equal(n.date, "2026-07-20");
  assert.equal(n.what, "Docket Entry #5: Order granting extension of time to respond");
});

test("normalizeEntry truncates a timestamped date_filed to YYYY-MM-DD", () => {
  const n = normalizeEntry({ date_filed: "2026-07-20T14:33:00Z", entry_number: 1, description: "x" });
  assert.equal(n.date, "2026-07-20");
});

test("normalizeEntry falls back to date_created when date_filed is absent", () => {
  const n = normalizeEntry({ date_created: "2026-05-01", description: "Complaint filed" });
  assert.equal(n.date, "2026-05-01");
});

test("normalizeEntry returns null for an entry with no usable date", () => {
  assert.equal(normalizeEntry({ description: "no date here" }), null);
  assert.equal(normalizeEntry({ date_filed: "not-a-date", description: "x" }), null);
  assert.equal(normalizeEntry(null), null);
  assert.equal(normalizeEntry(undefined), null);
});

test("normalizeEntry falls back to a placeholder when description is missing", () => {
  const n = normalizeEntry({ date_filed: "2026-07-20" });
  assert.match(n.what, /no description/i);
});

// ---- selectNewEntries ----

test("selectNewEntries returns only entries strictly newer than `since`", () => {
  const entries = [{ date: "2026-07-20", what: "a" }, { date: "2026-06-01", what: "b" }, { date: "2026-06-15", what: "c" }];
  const fresh = selectNewEntries(entries, "2026-06-15");
  assert.deepEqual(fresh.map((e) => e.date), ["2026-07-20"]);
});

test("selectNewEntries returns everything when `since` is null/undefined (first-ever poll)", () => {
  const entries = [{ date: "2026-07-20", what: "a" }, { date: "2026-06-01", what: "b" }];
  assert.equal(selectNewEntries(entries, null).length, 2);
  assert.equal(selectNewEntries(entries, undefined).length, 2);
});

test("selectNewEntries drops null entries defensively", () => {
  const entries = [{ date: "2026-07-20", what: "a" }, null, undefined];
  assert.equal(selectNewEntries(entries, null).length, 1);
});

// ---- stageRows: the confirm-before-page property ----

test("stageRows tags every row source:'courtlistener' and verified:false", () => {
  const entries = [{ date: "2026-07-20", what: "Order granting extension" }, { date: "2026-06-01", what: "Answer filed" }];
  const staged = stageRows(entries);
  assert.equal(staged.length, 2);
  for (const row of staged) {
    assert.equal(row.source, "courtlistener");
    assert.equal(row.verified, false);
  }
  assert.equal(staged[0].date, "2026-07-20");
  assert.equal(staged[0].what, "Order granting extension");
});

test("stageRows never marks a row verified, regardless of the source entry's own fields", () => {
  // Even if an upstream entry somehow carried a `verified` key, staging must not trust it --
  // ONLY a human confirm step (legal.mjs docket verify) may set verified:true.
  const entries = [{ date: "2026-07-20", what: "x", verified: true }];
  const staged = stageRows(entries);
  assert.equal(staged[0].verified, false);
});

// ---- fetchDocketEntries: injectable fetch, zero live network ----

test("fetchDocketEntries parses a single-page fixture response", async () => {
  const fakeFetch = async (url, opts) => {
    assert.match(url, /docket-entries\/\?docket=12345/);
    assert.equal(opts.headers["User-Agent"], "otchealth-clo/1.0");
    return {
      ok: true,
      json: async () => ({
        count: 2, next: null,
        results: [
          { id: 1, docket: 12345, date_filed: "2026-07-20", entry_number: 5, description: "Order granting extension of time to respond" },
          { id: 2, docket: 12345, date_filed: "2026-06-01", entry_number: 3, description: "Answer filed" },
        ],
      }),
    };
  };
  const entries = await fetchDocketEntries("12345", { fetchFn: fakeFetch });
  assert.equal(entries.length, 2);
  assert.equal(entries[0].description, "Order granting extension of time to respond");
});

test("fetchDocketEntries follows pagination via `next` and aggregates all pages", async () => {
  let calls = 0;
  const fakeFetch = async (url) => {
    calls++;
    if (/cursor=2/.test(url)) {
      return { ok: true, json: async () => ({ count: 2, next: null, results: [{ date_filed: "2026-05-01", entry_number: 1, description: "Complaint filed" }] }) };
    }
    return { ok: true, json: async () => ({ count: 2, next: "https://www.courtlistener.com/api/rest/v4/docket-entries/?cursor=2", results: [{ date_filed: "2026-07-01", entry_number: 2, description: "Motion filed" }] }) };
  };
  const entries = await fetchDocketEntries("12345", { fetchFn: fakeFetch });
  assert.equal(calls, 2);
  assert.equal(entries.length, 2);
});

test("fetchDocketEntries sends the Authorization header only when a token is given", async () => {
  let seenAuth;
  const fakeFetch = async (url, opts) => { seenAuth = opts.headers.Authorization; return { ok: true, json: async () => ({ results: [], next: null }) }; };
  await fetchDocketEntries("12345", { fetchFn: fakeFetch }); // no token
  assert.equal(seenAuth, undefined);
  await fetchDocketEntries("12345", { fetchFn: fakeFetch, token: "abc123" });
  assert.equal(seenAuth, "Token abc123");
});

test("fetchDocketEntries throws on a non-ok response instead of silently returning partial data", async () => {
  const fakeFetch = async () => ({ ok: false, status: 500 });
  await assert.rejects(() => fetchDocketEntries("12345", { fetchFn: fakeFetch }), /CourtListener HTTP 500/);
});

test("fetchDocketEntries throws immediately when no docketId is given (never silently no-ops)", async () => {
  await assert.rejects(() => fetchDocketEntries(null, { fetchFn: async () => ({ ok: true, json: async () => ({ results: [] }) }) }), /docketId/);
});

test("fetchDocketEntries respects maxPages as a bound against a runaway/misconfigured docket", async () => {
  let calls = 0;
  const fakeFetch = async () => { calls++; return { ok: true, json: async () => ({ next: "https://www.courtlistener.com/api/rest/v4/docket-entries/?cursor=" + calls, results: [{ date_filed: "2026-01-01", description: "x" }] }) }; };
  const entries = await fetchDocketEntries("12345", { fetchFn: fakeFetch, maxPages: 3 });
  assert.equal(calls, 3, "must stop at maxPages even though `next` never goes null");
  assert.equal(entries.length, 3);
});

// ---- end-to-end pure pipeline (fixture-only): fetch -> normalize -> filter -> stage ----

test("end-to-end fixture: only entries filed since last_checked are staged, unverified", async () => {
  const fakeFetch = async () => ({
    ok: true,
    json: async () => ({
      next: null,
      results: [
        { docket: 999, date_filed: "2026-07-20", entry_number: 5, description: "Order granting extension of time to respond" },
        { docket: 999, date_filed: "2026-06-01", entry_number: 3, description: "Answer filed" },
      ],
    }),
  });
  const raw = await fetchDocketEntries("999", { fetchFn: fakeFetch });
  const normalized = raw.map(normalizeEntry).filter(Boolean);
  const fresh = selectNewEntries(normalized, "2026-06-15"); // matter's last_checked
  const staged = stageRows(fresh);

  assert.equal(staged.length, 1, "only the 2026-07-20 entry is newer than last_checked");
  assert.equal(staged[0].date, "2026-07-20");
  assert.equal(staged[0].source, "courtlistener");
  assert.equal(staged[0].verified, false);
});

test("importing courtlistener-watch.mjs never triggers CLI dispatch or touches the network", async () => {
  const mod = await import("../skills/legal/courtlistener-watch.mjs");
  assert.ok(typeof mod.fetchDocketEntries === "function");
  // reaching this line at all proves import did not call process.exit() or poll live CourtListener
});
