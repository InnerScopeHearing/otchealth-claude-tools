// Hermetic tests for skills/legal-deadline-pager/pager.mjs. NO live Cosmos/graph/KV/SA anywhere in this
// file: every I/O touchpoint (company decision-clock storage, the personal cooldown store, the gateway
// graph_send_email call, the heartbeat marker) is dependency-injected via runSweep()'s opts and replaced
// with an in-memory fixture/mock. This is exactly what proves the disarm + ring-safety guarantees hold
// at the code-path level, not just "the docs say so".
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveSourceVerified,
  isTightWindow,
  daysUntil,
  rowKey,
  classifyDocketRows,
  cooldownElapsed,
  isPagerEnabled,
  isHeartbeatStale,
  formatPageBody,
  runSweep,
  DEFAULT_WINDOW_DAYS,
} from "../pager.mjs";

const NOW = "2026-07-15T12:00:00.000Z";

// ============================ pure: source/verified defaulting ============================

test("resolveSourceVerified: a row with neither field defaults to manual + verified", () => {
  assert.deepEqual(resolveSourceVerified({ date: "2026-07-16", what: "x" }), { source: "manual", verified: true });
});

test("resolveSourceVerified: source=extracted + verified:false stays unverified (never silently trusted)", () => {
  assert.deepEqual(resolveSourceVerified({ source: "extracted", verified: false }), { source: "extracted", verified: false });
});

test("resolveSourceVerified: source=courtlistener + verified:true is honored as verified", () => {
  assert.deepEqual(resolveSourceVerified({ source: "courtlistener", verified: true }), { source: "courtlistener", verified: true });
});

// ============================ pure: tight window ============================

test("isTightWindow: due in 3 days is inside the default 7-day window", () => {
  assert.equal(isTightWindow({ date: "2026-07-18" }, NOW), true);
});

test("isTightWindow: due in 20 days is OUTSIDE the default 7-day window", () => {
  assert.equal(isTightWindow({ date: "2026-08-04" }, NOW), false);
});

test("isTightWindow: an already-overdue row stays inside the window (no lower bound)", () => {
  assert.equal(isTightWindow({ date: "2026-07-01" }, NOW), true);
});

test("isTightWindow: a narrower custom window excludes a row the default window would include", () => {
  assert.equal(isTightWindow({ date: "2026-07-18" }, NOW, 2), false);
});

test("daysUntil: exactly on the boundary (windowDays away) counts as tight (<=, not <)", () => {
  const d = daysUntil({ date: "2026-07-22" }, NOW); // 7 days out from 2026-07-15
  assert.equal(d, 7);
  assert.equal(isTightWindow({ date: "2026-07-22" }, NOW, DEFAULT_WINDOW_DAYS), true);
});

// ============================ pure: rowKey (opaque, stable) ============================

test("rowKey is stable for identical input and differs when any field differs", () => {
  const a = { ns: "company", id: "corp-sec-ainnova", date: "2026-07-16", what: "File X" };
  const b = { ...a };
  const c = { ...a, what: "File Y" };
  assert.equal(rowKey(a), rowKey(b));
  assert.notEqual(rowKey(a), rowKey(c));
});

test("rowKey never contains the row's cleartext content (opaque hash only)", () => {
  const k = rowKey({ ns: "personal", id: "ca-divorce", date: "2026-07-17", what: "FL-142/FL-150 disclosure due" });
  assert.doesNotMatch(k, /FL-142/);
  assert.doesNotMatch(k, /disclosure/i);
  assert.match(k, /^leg_[0-9a-f]{24}$/);
});

// ============================ pure: classifyDocketRows (window + verified filter) ============================

test("classifyDocketRows: an unverified row is never pageable, even inside the window", () => {
  const rows = [{ ns: "company", id: "m1", date: "2026-07-16", what: "x", source: "extracted", verified: false }];
  const out = classifyDocketRows(rows, NOW);
  assert.equal(out.pageable.length, 0);
  assert.equal(out.skipped.length, 1);
  assert.equal(out.skipped[0]._reason, "unverified");
});

test("classifyDocketRows: a verified row OUTSIDE the window is never pageable", () => {
  const rows = [{ ns: "company", id: "m1", date: "2026-09-01", what: "x" }]; // defaults to verified:true but far out
  const out = classifyDocketRows(rows, NOW);
  assert.equal(out.pageable.length, 0);
  assert.equal(out.skipped[0]._reason, "out-of-window");
});

test("classifyDocketRows: verified + in-window rows split correctly by namespace", () => {
  const rows = [
    { ns: "company", id: "corp-sec-ainnova", date: "2026-07-16", what: "co item" },
    { ns: "personal", id: "ca-divorce", date: "2026-07-17", what: "personal item" },
  ];
  const out = classifyDocketRows(rows, NOW);
  assert.equal(out.pageable.length, 2);
  assert.equal(out.company.length, 1);
  assert.equal(out.personal.length, 1);
  assert.equal(out.company[0].id, "corp-sec-ainnova");
  assert.equal(out.personal[0].id, "ca-divorce");
});

// ============================ pure: cooldown ============================

test("cooldownElapsed: never paged before is always elapsed", () => {
  assert.equal(cooldownElapsed(null, NOW), true);
  assert.equal(cooldownElapsed(undefined, NOW), true);
});

test("cooldownElapsed: paged 1 hour ago, default 24h cooldown -> NOT elapsed", () => {
  assert.equal(cooldownElapsed("2026-07-15T11:00:00.000Z", NOW, 24), false);
});

test("cooldownElapsed: paged 25 hours ago, default 24h cooldown -> elapsed", () => {
  assert.equal(cooldownElapsed("2026-07-14T11:00:00.000Z", NOW, 24), true);
});

// ============================ pure: the LEGAL_PAGER_ENABLED gate ============================

test("isPagerEnabled: only the exact string '1' arms it", () => {
  assert.equal(isPagerEnabled({ LEGAL_PAGER_ENABLED: "1" }), true);
  assert.equal(isPagerEnabled({ LEGAL_PAGER_ENABLED: "true" }), false);
  assert.equal(isPagerEnabled({ LEGAL_PAGER_ENABLED: "yes" }), false);
  assert.equal(isPagerEnabled({}), false);
  assert.equal(isPagerEnabled({ LEGAL_PAGER_ENABLED: "0" }), false);
});

// ============================ pure: heartbeat staleness ============================

test("isHeartbeatStale: no prior run is stale", () => {
  assert.equal(isHeartbeatStale(null, NOW), true);
});

test("isHeartbeatStale: 10 hours ago is fresh under the default 48h budget", () => {
  assert.equal(isHeartbeatStale("2026-07-15T02:00:00.000Z", NOW), false);
});

test("isHeartbeatStale: 60 hours ago is stale under the default 48h budget", () => {
  assert.equal(isHeartbeatStale("2026-07-12T23:00:00.000Z", NOW), true);
});

// ============================ pure: email body formatting (no em/en dashes) ============================

test("formatPageBody: contains no em dash or en dash characters", () => {
  const body = formatPageBody([{ date: "2026-07-16", id: "corp-sec-ainnova", what: "File response" }], "company", NOW);
  assert.doesNotMatch(body, /[–—]/);
});

test("formatPageBody: marks a personal-namespace batch CONFIDENTIAL", () => {
  const body = formatPageBody([{ date: "2026-07-16", id: "ca-divorce", what: "FL-142 due" }], "personal", NOW);
  assert.match(body, /CONFIDENTIAL/);
});

// ============================ runSweep: dependency-injected I/O (NO live Cosmos/graph/KV/SA) ============================

function mockIo() {
  const companyDocs = new Map();
  const emailCalls = [];
  const heartbeats = [];
  let personalCooldown = {};
  return {
    companyDocs,
    emailCalls,
    heartbeats,
    personalCooldown: () => personalCooldown,
    getCompanyDoc: async (key) => companyDocs.get(key) || null,
    upsertCompanyDoc: async (doc) => { companyDocs.set(doc.id, doc); },
    getPersonalCooldown: async () => personalCooldown,
    putPersonalCooldown: async (map) => { personalCooldown = map; },
    sendEmail: async (args) => { emailCalls.push(args); return { sent: true, status: 200 }; },
    writeHeartbeat: async (info) => { heartbeats.push(info); },
  };
}

const companyRow = { ns: "company", id: "corp-sec-ainnova", date: "2026-07-16", what: "File response to motion" };
const personalRow = { ns: "personal", id: "ca-divorce", date: "2026-07-17", what: "FL-142/FL-150 disclosure due" };

test("runSweep DRY-RUN default (no --commit): graph_send_email is never called, nothing is written anywhere", async () => {
  const io = mockIo();
  const summary = await runSweep([companyRow, personalRow], NOW, { ...io });
  assert.equal(io.emailCalls.length, 0, "email must never be sent by default");
  assert.equal(io.companyDocs.size, 0, "decision-clock storage must not be touched by default");
  assert.equal(Object.keys(io.personalCooldown()).length, 0, "personal cooldown store must not be touched by default");
  assert.equal(io.heartbeats.length, 0, "heartbeat must not be written by default");
  assert.equal(summary.commit, false);
  assert.equal(summary.enabled, false);
  // dry-run still REPORTS what it would page (the "logs what it WOULD page" requirement)
  assert.equal(summary.company_to_email.length, 1);
  assert.equal(summary.personal_to_email.length, 1);
});

test("runSweep --commit WITHOUT LEGAL_PAGER_ENABLED: tracking writes happen, email stays disarmed", async () => {
  const io = mockIo();
  const summary = await runSweep([companyRow, personalRow], NOW, { ...io, commit: true, enabled: false });
  assert.equal(io.emailCalls.length, 0, "email must stay disarmed without the env kill-switch, even with --commit");
  assert.equal(summary.commit, true);
  assert.equal(summary.enabled, false);
  assert.equal(io.companyDocs.size, 1, "company tracking should sync into decision-clock storage under --commit");
  assert.equal(io.heartbeats.length, 1, "heartbeat should update under --commit");
});

test("runSweep --commit + LEGAL_PAGER_ENABLED=1 (enabled:true): graph_send_email IS called, once per namespace, with the configured recipient", async () => {
  const io = mockIo();
  const summary = await runSweep([companyRow, personalRow], NOW, { ...io, commit: true, enabled: true, recipient: "matthew@innd.com" });
  assert.equal(io.emailCalls.length, 2);
  for (const call of io.emailCalls) assert.equal(call.recipient, "matthew@innd.com");
  assert.deepEqual(io.emailCalls.map((c) => c.namespace).sort(), ["company", "personal"]);
  assert.equal(summary.emails.filter((e) => e.sent).length, 2);
});

test("runSweep: a personal-namespace row NEVER reaches the shared decision-clock store, even when armed", async () => {
  const io = mockIo();
  await runSweep([personalRow], NOW, { ...io, commit: true, enabled: true });
  assert.equal(io.companyDocs.size, 0, "personal rows must never be upserted into decisions_pending (a shared, fleet-queryable store)");
  const keys = Object.keys(io.personalCooldown());
  assert.equal(keys.length, 1, "personal cooldown DOES persist, but only in the private personal-namespace store");
  assert.doesNotMatch(keys[0], /FL-142/);
  assert.doesNotMatch(keys[0], /disclosure/i);
});

test("runSweep: a company-namespace row never touches the personal cooldown store", async () => {
  const io = mockIo();
  await runSweep([companyRow], NOW, { ...io, commit: true, enabled: true });
  assert.equal(Object.keys(io.personalCooldown()).length, 0);
  assert.equal(io.companyDocs.size, 1);
});

test("runSweep: unverified rows are excluded from both tracking and paging", async () => {
  const io = mockIo();
  const unverified = { ns: "company", id: "m2", date: "2026-07-16", what: "auto-extracted, unconfirmed", source: "extracted", verified: false };
  const summary = await runSweep([unverified], NOW, { ...io, commit: true, enabled: true });
  assert.equal(io.companyDocs.size, 0);
  assert.equal(io.emailCalls.length, 0);
  assert.equal(summary.pageable_company, 0);
});

test("runSweep: out-of-window rows are excluded from both tracking and paging", async () => {
  const io = mockIo();
  const farOut = { ns: "company", id: "m3", date: "2026-12-25", what: "far future deadline" };
  const summary = await runSweep([farOut], NOW, { ...io, commit: true, enabled: true });
  assert.equal(io.companyDocs.size, 0);
  assert.equal(io.emailCalls.length, 0);
  assert.equal(summary.pageable_company, 0);
});

test("runSweep: cooldown prevents a second page of the same deadline within the window", async () => {
  const io = mockIo();
  await runSweep([companyRow], NOW, { ...io, commit: true, enabled: true });
  assert.equal(io.emailCalls.length, 1);
  // a second sweep 1 hour later (well inside the default 24h cooldown) must not re-page
  const later = "2026-07-15T13:00:00.000Z";
  const summary2 = await runSweep([companyRow], later, { ...io, commit: true, enabled: true });
  assert.equal(io.emailCalls.length, 1, "cooldown must suppress the repeat page");
  assert.equal(summary2.company_to_email.length, 0);
});

test("runSweep: after the cooldown window elapses, the same deadline pages again", async () => {
  const io = mockIo();
  await runSweep([companyRow], NOW, { ...io, commit: true, enabled: true });
  assert.equal(io.emailCalls.length, 1);
  const muchLater = "2026-07-16T13:00:00.000Z"; // > 24h later
  await runSweep([companyRow], muchLater, { ...io, commit: true, enabled: true });
  assert.equal(io.emailCalls.length, 2, "a fresh page should fire once the cooldown has elapsed");
});

test("runSweep: no pageable rows at all sends no email and still updates the heartbeat under --commit", async () => {
  const io = mockIo();
  const summary = await runSweep([], NOW, { ...io, commit: true, enabled: true });
  assert.equal(io.emailCalls.length, 0);
  assert.equal(io.heartbeats.length, 1);
  assert.equal(summary.rows_seen, 0);
});
