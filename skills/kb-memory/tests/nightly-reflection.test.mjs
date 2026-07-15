// Tests for nightly-reflection.mjs, the Phase-4 B1 pure clustering + fact-extraction shaping. Fixtures
// and a mocked ask() only -- no Cosmos, no Azure Key Vault, no real LLM call, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clusterEpisodes,
  buildDistillPrompt,
  parseDistillItems,
  distillAgent,
  enforceRingSafeShare,
  resolveModelOverride,
  BANNED_MODELS,
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

// ---------------------------- resolveModelOverride (gpt-4.1-mini ban guard) ----------------------------

test("resolveModelOverride ignores a BANNED model override and falls back to the safe default", () => {
  const origErr = console.error; console.error = () => {}; // silence the intentional loud warn
  try {
    assert.equal(resolveModelOverride("gpt-4.1-mini", "gpt-4o", "NIGHTLY_REFLECTION_MODEL"), "gpt-4o");
    assert.equal(resolveModelOverride("  gpt-4.1-mini  ", "gpt-4o"), "gpt-4o", "trims before the ban check");
  } finally { console.error = origErr; }
});

test("resolveModelOverride honors a valid (non-banned) override and the unset default", () => {
  assert.equal(resolveModelOverride("gpt-5.1", "gpt-4o"), "gpt-5.1");
  assert.equal(resolveModelOverride("", "gpt-4o"), "gpt-4o");
  assert.equal(resolveModelOverride(undefined, "gpt-4o"), "gpt-4o");
});

test("BANNED_MODELS contains gpt-4.1-mini (the model-routing.mjs cheap tier)", () => {
  assert.ok(BANNED_MODELS.has("gpt-4.1-mini"));
});

// ---------------------------- enforceRingSafeShare (Defect 1: ring leak, --share output path) ----------------------------
// The real cross-lane vector in this file: --share publishes to the exec-team feed, readable by the
// WHOLE roster (not just MNPI-authorized agents). The distillation PROMPT already asks the model not to
// mark MNPI/PHI/privileged content share=true, but that is soft; enforceRingSafeShare is the hard
// code-level backstop and must not trust the model's own say-so.

test("enforceRingSafeShare downgrades share=true -> false on an MNPI-flagged item, keeping the item itself", () => {
  const items = [{ type: "fact", text: "INND closed a Reg D raise at a share price the board approved", share: true }];
  let logged = "";
  const out = enforceRingSafeShare("cfo", items, (m) => { logged = m; });
  assert.equal(out.length, 1, "the item itself must NOT be dropped");
  assert.equal(out[0].share, false, "share must be force-downgraded");
  assert.equal(out[0].type, "fact");
  assert.equal(out[0].text, items[0].text, "the text is preserved, only share changes");
  assert.match(logged, /downgrading share=true -> false/);
  assert.match(logged, /cfo/);
});

test("enforceRingSafeShare downgrades share=true -> false on a PHI-adjacent item", () => {
  const items = [{ type: "pitfall", text: "do not log the hearing number in analytics", share: true }];
  const out = enforceRingSafeShare("cto", items, () => {});
  assert.equal(out[0].share, false);
});

test("enforceRingSafeShare downgrades share=true -> false when the AGENT itself is a privileged lane", () => {
  // Defense in depth: clusterEpisodes already drops clo-personal episodes upstream, but this proves the
  // output gate independently enforces the same wall if distillAgent is ever reached another way.
  const items = [{ type: "fact", text: "an entirely ordinary, non-sensitive sentence", share: true }];
  const out = enforceRingSafeShare("clo-personal", items, () => {});
  assert.equal(out[0].share, false, "a privileged agent's item must never be shared, regardless of text");
});

test("enforceRingSafeShare leaves an ordinary non-sensitive share=true item UNCHANGED (no over-blocking)", () => {
  const items = [{ type: "pitfall", text: "the depot macos runner needs the Xcode 26 guard step", share: true }];
  const out = enforceRingSafeShare("cto", items, () => { throw new Error("must not log when nothing is downgraded"); });
  assert.deepEqual(out, items);
});

test("enforceRingSafeShare leaves share=false / share=undefined items unchanged and never logs for them", () => {
  const items = [
    { type: "fact", text: "INND MNPI content but share was already false", share: false },
    { type: "decision", text: "some decision with no share key at all" },
  ];
  let logCalls = 0;
  const out = enforceRingSafeShare("cfo", items, () => { logCalls++; });
  assert.deepEqual(out, items, "unshared items pass through byte-identical, even if their text is MNPI-flagged");
  assert.equal(logCalls, 0, "only an actual share=true -> false downgrade should log");
});

test("enforceRingSafeShare processes a mixed batch item-by-item (only the unsafe one is downgraded)", () => {
  const items = [
    { type: "fact", text: "the ios-depot workflow needs depot-macos-26", share: true },
    { type: "fact", text: "INND reg d raise details must stay internal", share: true },
  ];
  const out = enforceRingSafeShare("cto", items, () => {});
  assert.equal(out[0].share, true, "the ordinary item stays shared");
  assert.equal(out[1].share, false, "only the MNPI item is downgraded");
});

test("enforceRingSafeShare is safe on an empty item list", () => {
  assert.deepEqual(enforceRingSafeShare("cfo", [], () => {}), []);
  assert.deepEqual(enforceRingSafeShare("cfo", undefined, () => {}), []);
});
