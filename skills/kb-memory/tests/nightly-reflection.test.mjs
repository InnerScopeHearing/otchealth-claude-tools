// Tests for nightly-reflection.mjs, the Phase-4 B1 pure clustering + fact-extraction shaping. Fixtures
// and a mocked ask() only -- no Cosmos, no Azure Key Vault, no real LLM call, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clusterEpisodes,
  buildDistillPrompt,
  parseDistillItems,
  distillAgent,
  DEFAULT_CLUSTER_THRESHOLD,
} from "../nightly-reflection.mjs";

const NOW = Date.parse("2026-07-15T00:00:00Z");
const HOUR = 60 * 60 * 1000;
const iso = (hoursAgo) => new Date(NOW - hoursAgo * HOUR).toISOString();

// ---------------------------- clusterEpisodes ----------------------------

test("clusterEpisodes groups near-duplicate episode text within one agent into a RECURRING cluster", () => {
  const episodes = [
    { agent: "cfo", text: "ran the xero re-consent flow for the otchealth org", ts: iso(20) },
    { agent: "cfo", text: "ran the xero re-consent flow for the otchealth organization again", ts: iso(10) },
    { agent: "cfo", text: "posted 40 transactions to xero", ts: iso(5) },
  ];
  const byAgent = clusterEpisodes(episodes);
  assert.equal(byAgent.length, 1);
  assert.equal(byAgent[0].agent, "cfo");
  const recurring = byAgent[0].clusters.filter((c) => c.recurring);
  assert.equal(recurring.length, 1, "exactly one cluster should be flagged recurring");
  assert.equal(recurring[0].count, 2);
  const single = byAgent[0].clusters.filter((c) => !c.recurring);
  assert.equal(single.length, 1);
  assert.equal(single[0].count, 1);
});

test("clusterEpisodes keeps different agents in separate buckets (never cross-agent)", () => {
  const episodes = [
    { agent: "cfo", text: "posted invoices to xero", ts: iso(1) },
    { agent: "cto", text: "deployed the gateway to azure container apps", ts: iso(1) },
  ];
  const byAgent = clusterEpisodes(episodes);
  assert.equal(byAgent.length, 2);
  assert.deepEqual(byAgent.map((b) => b.agent).sort(), ["cfo", "cto"]);
  for (const b of byAgent) assert.equal(b.clusters.length, 1);
});

test("clusterEpisodes sorts clusters largest-first so recurring topics lead", () => {
  const episodes = [
    { agent: "cto", text: "checked the depot build queue status", ts: iso(1) },
    { agent: "cto", text: "restarted the flaky ios-depot workflow run", ts: iso(23) },
    { agent: "cto", text: "restarted the flaky ios depot workflow run again", ts: iso(12) },
    { agent: "cto", text: "restarted the flaky ios depot workflow run once more", ts: iso(4) },
  ];
  const byAgent = clusterEpisodes(episodes);
  const clusters = byAgent[0].clusters;
  assert.equal(clusters[0].count, 3, "the 3-episode restart cluster should sort first");
  assert.ok(clusters[0].count >= clusters[clusters.length - 1].count);
});

test("clusterEpisodes drops rows missing agent/text and the clo-personal lane defensively", () => {
  const episodes = [
    { agent: "cfo", text: "a real episode", ts: iso(1) },
    { agent: "", text: "no agent", ts: iso(1) },
    { agent: "cto", text: "", ts: iso(1) },
    { agent: "clo-personal", text: "privileged content that must never surface here", ts: iso(1) },
    null,
  ];
  const byAgent = clusterEpisodes(episodes);
  assert.deepEqual(byAgent.map((b) => b.agent), ["cfo"]);
});

test("DEFAULT_CLUSTER_THRESHOLD matches semantic-trust's own claim-similarity bar", () => {
  assert.equal(DEFAULT_CLUSTER_THRESHOLD, 0.5);
});

// ---------------------------- buildDistillPrompt / parseDistillItems ----------------------------

test("buildDistillPrompt embeds the agent, the recurring tag, and the known-memory text", () => {
  const clusters = [
    { repText: "Xero OAuth needs re-consent every 60 days", count: 3, recurring: true, items: [] },
    { repText: "checked a one-off status page", count: 1, recurring: false, items: [] },
  ];
  const { system, user } = buildDistillPrompt("cfo", clusters, "the ledger already knows X", { maxItems: 5 });
  assert.match(system, /NIGHTLY memory-reflection step for agent "cfo"/);
  assert.match(system, /0 to 5 items/);
  assert.match(user, /RECURRING x3.*Xero OAuth needs re-consent/);
  assert.match(user, /single.*checked a one-off status page/);
  assert.match(user, /the ledger already knows X/);
  assert.ok(!/[–—]/.test(system + user), "no em dash or en dash in the generated prompt");
});

test("parseDistillItems parses a well-formed JSON array and enforces the type enum", () => {
  const raw = 'noise before\n[{"type":"pitfall","text":"a real lesson","share":true},{"type":"bogus","text":"dropped"},{"type":"decision","text":"","share":false}]\nnoise after';
  const items = parseDistillItems(raw);
  assert.equal(items.length, 1);
  assert.equal(items[0].type, "pitfall");
  assert.equal(items[0].text, "a real lesson");
});

test("parseDistillItems caps at maxItems", () => {
  const raw = JSON.stringify([
    { type: "remember", text: "a" }, { type: "remember", text: "b" },
    { type: "remember", text: "c" }, { type: "remember", text: "d" },
  ]);
  assert.equal(parseDistillItems(raw, { maxItems: 2 }).length, 2);
});

test("parseDistillItems fails open (returns []) on malformed JSON or a non-array", () => {
  assert.deepEqual(parseDistillItems("not json at all"), []);
  assert.deepEqual(parseDistillItems('{"not":"an array"}'), []);
  assert.deepEqual(parseDistillItems(""), []);
  assert.deepEqual(parseDistillItems(null), []);
});

// ---------------------------- distillAgent (LLM mocked via injection) ----------------------------

test("distillAgent calls the injected ask() with the built prompt and parses its JSON reply", async () => {
  const clusters = [{ repText: "Xero OAuth needs re-consent every 60 days", count: 3, recurring: true, items: [] }];
  let seenSystem = "", seenUser = "";
  const mockAsk = async (system, user) => {
    seenSystem = system; seenUser = user;
    return JSON.stringify([{ type: "pitfall", text: "Xero OAuth requires re-consent every 60 days; schedule a reminder.", share: true }]);
  };
  const items = await distillAgent("cfo", clusters, { ask: mockAsk, knownRecentText: "" });
  assert.match(seenSystem, /agent "cfo"/);
  assert.match(seenUser, /Xero OAuth needs re-consent/);
  assert.equal(items.length, 1);
  assert.equal(items[0].type, "pitfall");
  assert.equal(items[0].share, true);
});

test("distillAgent fails open (returns []) when ask() throws, and does not propagate the error", async () => {
  const clusters = [{ repText: "some pattern", count: 2, recurring: true, items: [] }];
  const items = await distillAgent("cfo", clusters, { ask: async () => { throw new Error("429 throttled"); } });
  assert.deepEqual(items, []);
});

test("distillAgent returns [] and never calls ask() when there are no clusters (nothing to distill)", async () => {
  let called = false;
  const items = await distillAgent("cfo", [], { ask: async () => { called = true; return "[]"; } });
  assert.deepEqual(items, []);
  assert.equal(called, false, "ask() must not be called when there is nothing to distill");
});

test("distillAgent throws a clear error if no ask() function is injected (programmer error, not a runtime skip)", async () => {
  const clusters = [{ repText: "x", count: 2, recurring: true, items: [] }];
  await assert.rejects(() => distillAgent("cfo", clusters, {}), /ask\(system, user\) function is required/);
});
