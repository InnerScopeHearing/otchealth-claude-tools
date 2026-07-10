// Tests for semantic-trust/trust.mjs, the pure cross-agent corroboration + trust-decay scorer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreClaim, groupAssertions, promoteRecommendation } from "../trust.mjs";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-07-01T00:00:00Z");

test("1 agent asserting a claim is unverified with moderate-not-high trust", () => {
  const r = scoreClaim({ assertions: [{ agent: "cfo", ts: NOW - 1 * DAY }], nowMs: NOW });
  assert.equal(r.status, "unverified");
  assert.equal(r.distinctAgents, 1);
  assert.ok(r.trust > 0 && r.trust < 0.6, `expected moderate trust, got ${r.trust}`);
});

test("3 distinct agents corroborating recently is durable with high trust", () => {
  const r = scoreClaim({
    assertions: [
      { agent: "cfo", ts: NOW - 1 * DAY },
      { agent: "coo", ts: NOW - 2 * DAY },
      { agent: "cto", ts: NOW - 1 * DAY },
    ],
    nowMs: NOW,
  });
  assert.equal(r.status, "durable");
  assert.equal(r.distinctAgents, 3);
  assert.ok(r.trust >= 0.6, `expected high trust, got ${r.trust}`);
});

test("the SAME agent asserting 3 times is NOT durable (distinct-agent rule)", () => {
  const r = scoreClaim({
    assertions: [
      { agent: "cfo", ts: NOW - 5 * DAY },
      { agent: "cfo", ts: NOW - 3 * DAY },
      { agent: "cfo", ts: NOW - 1 * DAY },
    ],
    nowMs: NOW,
  });
  assert.equal(r.distinctAgents, 1);
  assert.equal(r.status, "unverified");
  assert.equal(r.corroborations, 3, "raw assertion count should still reflect all 3 rows");
});

test("a contradiction present makes the claim contested and measurably lowers trust", () => {
  const base = scoreClaim({
    assertions: [
      { agent: "cfo", ts: NOW - 1 * DAY },
      { agent: "coo", ts: NOW - 1 * DAY },
    ],
    nowMs: NOW,
  });
  const withContradiction = scoreClaim({
    assertions: [
      { agent: "cfo", ts: NOW - 1 * DAY },
      { agent: "coo", ts: NOW - 1 * DAY },
    ],
    contradictions: [{ agent: "cto", ts: NOW - 1 * DAY }],
    nowMs: NOW,
  });
  assert.notEqual(base.status, "contested");
  assert.equal(withContradiction.status, "contested");
  assert.ok(
    withContradiction.trust < base.trust,
    `expected contradicted trust (${withContradiction.trust}) < base trust (${base.trust})`
  );
});

test("old assertions decay to measurably lower trust than fresh ones with identical agent/confidence counts", () => {
  const fresh = scoreClaim({
    assertions: [
      { agent: "cfo", ts: NOW - 1 * DAY },
      { agent: "coo", ts: NOW - 1 * DAY },
    ],
    nowMs: NOW,
    halfLifeDays: 30,
  });
  const old = scoreClaim({
    assertions: [
      { agent: "cfo", ts: NOW - 95 * DAY },
      { agent: "coo", ts: NOW - 95 * DAY },
    ],
    nowMs: NOW,
    halfLifeDays: 30,
  });
  assert.ok(old.trust < fresh.trust, `expected decayed trust (${old.trust}) < fresh trust (${fresh.trust})`);
  assert.equal(fresh.distinctAgents, old.distinctAgents);
});

test("groupAssertions clusters same-subject similar-text rows across agents into one claim", () => {
  const rows = [
    { agent: "cfo", ekey: "xero-cap", evalue: "the xero core tier allows 5000 api calls per day", ts: NOW - 3 * DAY },
    { agent: "coo", ekey: "xero-cap", evalue: "xero core tier allows about 5000 api calls a day", ts: NOW - 2 * DAY },
    { agent: "cto", ekey: "xero-cap", evalue: "xero core plan caps api calls at 5000 per day", ts: NOW - 1 * DAY },
  ];
  const groups = groupAssertions(rows);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].assertions.length, 3);
  assert.equal(groups[0].contradictions.length, 0);
});

test("groupAssertions treats a same-subject dissimilar-value row as a contradiction, not a new claim", () => {
  const rows = [
    { agent: "cfo", ekey: "xero-cap", evalue: "the xero core tier allows 5000 api calls per day", ts: NOW - 3 * DAY },
    { agent: "coo", ekey: "xero-cap", evalue: "xero core tier allows 5000 api calls per day", ts: NOW - 2 * DAY },
    { agent: "cto", ekey: "xero-cap", evalue: "xero core tier allows 900 requests total not 5000", ts: NOW - 1 * DAY },
  ];
  const groups = groupAssertions(rows);
  assert.equal(groups.length, 1, "same subject stays one group with contradictions attached");
  assert.equal(groups[0].assertions.length, 2);
  assert.equal(groups[0].contradictions.length, 1);
  assert.equal(groups[0].contradictions[0].agent, "cto");
});

test("promoteRecommendation: durable + above threshold promotes", () => {
  const scored = { trust: 0.8, status: "durable" };
  const rec = promoteRecommendation(scored, { threshold: 0.75 });
  assert.equal(rec.promote, true);
  assert.equal(rec.toStatus, "semantic/durable");
});

test("promoteRecommendation: durable but below threshold does not promote", () => {
  const scored = { trust: 0.5, status: "durable" };
  const rec = promoteRecommendation(scored, { threshold: 0.75 });
  assert.equal(rec.promote, false);
  assert.equal(rec.toStatus, "durable");
});

test("promoteRecommendation: high trust number but contested status never promotes", () => {
  const scored = { trust: 0.95, status: "contested" };
  const rec = promoteRecommendation(scored, { threshold: 0.75 });
  assert.equal(rec.promote, false);
  assert.equal(rec.toStatus, "contested");
});
