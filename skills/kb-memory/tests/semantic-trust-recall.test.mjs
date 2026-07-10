// Tests for the semantic-trust wiring in kb-memory/semantic.mjs (rankHitsByTrust). Recall hits are
// subject-less, so the wiring is CORROBORATION-ONLY: cluster like claims across agents, score distinct-
// agent corroboration, float multi-agent memories ahead. Uses the real semantic-trust module (pure).
import { test } from "node:test";
import assert from "node:assert/strict";
import { rankHitsByTrust } from "../semantic.mjs";
import * as trust from "../../semantic-trust/trust.mjs";

const NOW = Date.parse("2026-07-02T00:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const iso = (daysAgo) => new Date(NOW - daysAgo * DAY).toISOString();

test("a claim recorded by 3 distinct agents ranks durable and floats to the front", () => {
  const hits = [
    { agent: "cfo", ts: iso(2), text: "the ledger store should use Cosmos for agent state", "@search.score": 0.9 },
    { agent: "growth", ts: iso(1), text: "a single unverified opinion about pricing tiers", "@search.score": 0.95 },
    { agent: "coo", ts: iso(3), text: "ledger store ought to use Cosmos to hold agent state", "@search.score": 0.7 },
    { agent: "cto", ts: iso(1), text: "agent state ledger store: use Cosmos", "@search.score": 0.6 },
  ];
  const { annot, order } = rankHitsByTrust(hits, trust, NOW);
  // The three Cosmos-ledger hits cluster into one durable claim and sort ahead of the lone outlier.
  assert.equal(annot[order[0]].status, "durable");
  assert.equal(annot[order[0]].distinct, 3);
  assert.equal(hits[order[order.length - 1]].agent, "growth");
  assert.equal(annot[1].status, "unverified"); // the growth outlier (hits[1]), 1 agent
  assert.equal(annot[3].status, "durable"); // the cto hit (hits[3]) is in the 3-agent cluster
});

test("the SAME agent asserting a claim twice does NOT corroborate (distinct-agent rule)", () => {
  const hits = [
    { agent: "cfo", ts: iso(1), text: "use Cosmos for the ledger", "@search.score": 0.5 },
    { agent: "cfo", ts: iso(2), text: "use Cosmos for the ledger store", "@search.score": 0.4 },
  ];
  const { annot } = rankHitsByTrust(hits, trust, NOW);
  assert.equal(annot[0].status, "unverified");
  assert.equal(annot[0].distinct, 1);
});

test("unrelated memories are NOT mislabeled as contradictions of each other", () => {
  const hits = [
    { agent: "cfo", ts: iso(1), text: "the budget for Q3 marketing is set", "@search.score": 0.9 },
    { agent: "cto", ts: iso(1), text: "the iOS build pipeline runs on Depot macOS", "@search.score": 0.8 },
  ];
  const { annot } = rankHitsByTrust(hits, trust, NOW);
  // Two different facts, each a lone assertion -> both unverified, NEITHER contested.
  assert.equal(annot[0].status, "unverified");
  assert.equal(annot[1].status, "unverified");
});

test("fail-open: a null/!shaped trust module yields no annotation and identity order", () => {
  const hits = [
    { agent: "cfo", ts: iso(1), text: "x", "@search.score": 0.5 },
    { agent: "cto", ts: iso(1), text: "y", "@search.score": 0.4 },
  ];
  for (const bad of [null, {}, { scoreClaim: 123 }]) {
    const { annot, order } = rankHitsByTrust(hits, bad, NOW);
    assert.equal(annot, null);
    assert.deepEqual(order, [0, 1]);
  }
});

test("empty hit list is handled cleanly", () => {
  const { annot, order } = rankHitsByTrust([], trust, NOW);
  assert.deepEqual(order, []);
  assert.deepEqual(annot, []);
});
