// W1-5: freshness SLOs for the fleet's PostHog telemetry streams (eval_result, $ai_generation,
// agent_session, medic_dispatch). Mirrors tests/azure-canary-freshness.test.mjs's own assessFreshness
// guards, for the PostHog-stream sibling check (skills/azure-canary/stream-freshness.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { assessStreamFreshness, newestStreamEventTs } from "../skills/azure-canary/stream-freshness.mjs";

const EVAL_RESULT = { stream: "eval_result", max_age_h: 30 };
const MEDIC_DISPATCH = { stream: "medic_dispatch", max_age_h: 168 };
const NOW = Date.parse("2026-07-17T22:00:00Z");

test("assessStreamFreshness: a recent event is FRESH", () => {
  const v = assessStreamFreshness(EVAL_RESULT, "2026-07-17T08:40:26.037Z", NOW); // ~13.3h old, SLO 30h
  assert.equal(v.state, "FRESH");
  assert.ok(v.ageH > 13 && v.ageH < 14);
});

test("assessStreamFreshness: THE REAL 2026-07-17 INCIDENT -- ~368h silence on a 30h SLO is STALE", () => {
  // $ai_generation / agent_session's actual last-seen timestamp the day this check was built.
  const v = assessStreamFreshness(EVAL_RESULT, "2026-07-02T14:08:34.862Z", NOW);
  assert.equal(v.state, "STALE");
  assert.ok(v.ageH > 300, "must reflect the true multi-day gap, not just 'somewhat old'");
});

test("assessStreamFreshness: medic_dispatch's looser 168h SLO still catches its real ~332h gap", () => {
  const v = assessStreamFreshness(MEDIC_DISPATCH, "2026-07-04T02:00:13.682Z", NOW);
  assert.equal(v.state, "STALE");
  assert.ok(v.ageH > 168);
});

test("assessStreamFreshness: medic_dispatch does NOT page on a merely-quiet week (zero dispatches is healthy)", () => {
  // 5 days of silence is well within the 168h (7-day) SLO -- a healthy fleet with nothing to dispatch.
  const fiveDaysAgo = new Date(NOW - 5 * 24 * 3_600_000).toISOString();
  const v = assessStreamFreshness(MEDIC_DISPATCH, fiveDaysAgo, NOW);
  assert.equal(v.state, "FRESH", "medic_dispatch must not cry wolf on a quiet-but-healthy week");
});

test("assessStreamFreshness: a stream that has NEVER fired (null newest) is NO_DATA, not FRESH", () => {
  assert.equal(assessStreamFreshness(EVAL_RESULT, null, NOW).state, "NO_DATA");
  assert.equal(assessStreamFreshness(EVAL_RESULT, "not-a-date", NOW).state, "NO_DATA");
});

test("assessStreamFreshness: exactly at the SLO boundary is still FRESH (<=)", () => {
  const boundary = new Date(NOW - EVAL_RESULT.max_age_h * 3_600_000).toISOString();
  assert.equal(assessStreamFreshness(EVAL_RESULT, boundary, NOW).state, "FRESH");
});

test("expected-streams.json registers all four W1-5 streams with a positive max_age_h and medic_dispatch is the loosest", () => {
  const registry = JSON.parse(readFileSync(new URL("../setup/expected-streams.json", import.meta.url), "utf8"));
  const names = registry.streams.map((s) => s.stream);
  for (const required of ["eval_result", "$ai_generation", "agent_session", "medic_dispatch"]) {
    assert.ok(names.includes(required), `expected-streams.json must register ${required}`);
  }
  for (const s of registry.streams) {
    assert.ok(Number(s.max_age_h) > 0, `${s.stream} must declare a positive max_age_h`);
    assert.ok(s.note && s.note.length > 20, `${s.stream} must document WHY its SLO is set the way it is`);
  }
  const byName = Object.fromEntries(registry.streams.map((s) => [s.stream, s.max_age_h]));
  assert.ok(
    byName.medic_dispatch > byName.eval_result,
    "medic_dispatch fires only on anomaly (zero is healthy) so its SLO must be looser than the near-continuous streams, or it will cry wolf on a healthy quiet week",
  );
});

// newestStreamEventTs: exercised via its injected fetchImpl (never a live network call in a unit test).
// Mock-fetch router matches the target host by EXACT hostname (URL.hostname === '...'), never a
// substring .includes check (CodeQL: a substring match on a host is spoofable, e.g. "us.posthog.com.evil.com").
function mockFetch(responder) {
  return async (url, opts) => {
    const u = new URL(url);
    if (u.hostname !== "us.posthog.com") throw new Error(`unexpected host in test: ${u.hostname}`);
    return responder(url, opts);
  };
}

test("newestStreamEventTs: normalizes PostHog's ClickHouse DateTime64 (space, no Z) to strict ISO", async () => {
  const fetchImpl = mockFetch(async () => ({
    ok: true,
    json: async () => ({ results: [["2026-07-17 08:40:26.037000", 428]] }),
  }));
  const { newestIso, count } = await newestStreamEventTs("eval_result", { key: "x", projectId: "479484", fetchImpl });
  assert.equal(newestIso, "2026-07-17T08:40:26.037Z");
  assert.equal(count, 428);
});

test("newestStreamEventTs: a stream with zero events in the window returns newestIso=null", async () => {
  const fetchImpl = mockFetch(async () => ({ ok: true, json: async () => ({ results: [[null, 0]] }) }));
  const { newestIso, count } = await newestStreamEventTs("medic_dispatch", { key: "x", projectId: "479484", fetchImpl });
  assert.equal(newestIso, null);
  assert.equal(count, 0);
});

test("newestStreamEventTs: a non-OK response throws (caller classifies as QUERY_ERROR, never silently null)", async () => {
  const fetchImpl = mockFetch(async () => ({ ok: false, status: 500, text: async () => "internal error" }));
  await assert.rejects(() => newestStreamEventTs("eval_result", { key: "x", projectId: "479484", fetchImpl }), /posthog query eval_result -> 500/);
});
