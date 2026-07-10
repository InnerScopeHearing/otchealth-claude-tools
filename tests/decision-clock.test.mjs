// Regression gate for decision-clock's pure classifier + nudge-batcher. Pure functions, fully
// hermetic (no Cosmos, no fleet-dispatch). Load-bearing guarantees: (1) overdue is detected correctly
// relative to `now`; (2) a near-due item (within the window) is flagged BEFORE it goes overdue; (3) a
// closed row never resurfaces; (4) batchNudges groups by owner into ONE message per owner (never
// one-per-item spam) and excludes healthy/open-with-plenty-of-runway rows.
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyRow, batchNudges, DEFAULT_SLA_DAYS } from "../skills/decision-clock/decision.mjs";

const NOW = "2026-07-01T12:00:00Z";

test("a row past its expected_by is OVERDUE with the correct day count", () => {
  const row = { status: "open", expected_by: "2026-06-25T12:00:00Z" };
  const c = classifyRow(row, NOW);
  assert.equal(c.status, "overdue");
  assert.equal(Math.round(c.daysOverdue), 6);
});

test("a row due within the near-due window (default 2 days) is NEAR-DUE, not overdue", () => {
  const row = { status: "open", expected_by: "2026-07-02T12:00:00Z" }; // 1 day out
  const c = classifyRow(row, NOW);
  assert.equal(c.status, "near-due");
  assert.ok(c.daysUntilDue > 0 && c.daysUntilDue <= 2);
});

test("a row with plenty of runway stays OPEN", () => {
  const row = { status: "open", expected_by: "2026-07-20T12:00:00Z" }; // 19 days out
  const c = classifyRow(row, NOW);
  assert.equal(c.status, "open");
});

test("a CLOSED row is always closed regardless of expected_by", () => {
  const row = { status: "closed", expected_by: "2020-01-01T00:00:00Z" };
  const c = classifyRow(row, NOW);
  assert.equal(c.status, "closed");
});

test("the near-due window is configurable via opts.nearDueDays", () => {
  const row = { status: "open", expected_by: "2026-07-05T12:00:00Z" }; // 4 days out
  assert.equal(classifyRow(row, NOW).status, "open"); // default window (2d) doesn't catch it
  assert.equal(classifyRow(row, NOW, { nearDueDays: 5 }).status, "near-due"); // widened window does
});

test("batchNudges groups multiple overdue rows for the SAME owner into ONE message", () => {
  const rows = [
    { id: "a", owner: "cto", category: "rotate-secret", text: "rotate X", _class: { status: "overdue", daysOverdue: 3 } },
    { id: "b", owner: "cto", category: "matt-gate", text: "gate Y", _class: { status: "overdue", daysOverdue: 10 } },
    { id: "c", owner: "cfo", category: "review", text: "review Z", _class: { status: "near-due", daysUntilDue: 1 } },
  ];
  const nudges = batchNudges(rows);
  assert.equal(nudges.length, 2, "one nudge per owner, not per row");
  const cto = nudges.find((n) => n.owner === "cto");
  assert.equal(cto.count, 2);
  assert.match(cto.message, /rotate X/);
  assert.match(cto.message, /gate Y/);
  // most-overdue item sorts first within the owner's batched message
  assert.ok(cto.message.indexOf("gate Y") < cto.message.indexOf("rotate X"));
});

test("batchNudges excludes healthy/open rows with runway (no nudge-worthy items -> no owner entry)", () => {
  const rows = [{ id: "a", owner: "cto", category: "review", text: "fine", _class: { status: "open" } }];
  assert.equal(batchNudges(rows).length, 0);
});

test("DEFAULT_SLA_DAYS has the documented category defaults", () => {
  assert.equal(DEFAULT_SLA_DAYS["rotate-secret"], 14);
  assert.equal(DEFAULT_SLA_DAYS["matt-gate"], 3);
  assert.equal(DEFAULT_SLA_DAYS["review"], 7);
  assert.equal(DEFAULT_SLA_DAYS.default, 7);
});
