// Pure-function tests for growth-room's composition layer — no network calls, matches the fleet's
// convention (daily-digest.mjs's digestQueryOk, cfo-reconstruction's pure exports) of keeping the
// shape-and-format logic testable in isolation from the live API pulls.
import { test } from "node:test";
import assert from "node:assert/strict";
import { APPS, composeMarkdown, fmtNum, fmtMoney, fmtPct } from "../growth-room.mjs";

test("APPS registry excludes MedReview (PHI ring)", () => {
  assert.ok(!APPS.some((a) => a.posthogProjectId === "468398"), "MedReview's PHI-hardened PostHog project must never appear in the growth-room registry");
  assert.ok(!APPS.some((a) => /medreview/i.test(a.key) || /medreview/i.test(a.name)));
});

test("APPS registry has no duplicate keys or posthog project ids", () => {
  const keys = APPS.map((a) => a.key);
  const pids = APPS.map((a) => a.posthogProjectId);
  assert.equal(new Set(keys).size, keys.length, "duplicate app key");
  assert.equal(new Set(pids).size, pids.length, "duplicate PostHog project id");
});

test("fmtNum / fmtMoney / fmtPct handle null gracefully", () => {
  assert.equal(fmtNum(null), "n/a");
  assert.equal(fmtMoney(null), "n/a");
  assert.equal(fmtPct(null), "n/a");
  assert.equal(fmtNum(1234), "1,234");
  assert.equal(fmtMoney(12.5), "$12.50");
  assert.equal(fmtPct(33.333), "33.3%");
});

test("composeMarkdown produces the expected section headers and reflects unconfigured sources", () => {
  const md = composeMarkdown({
    date: "2026-07-21",
    days: 7,
    rows: [{ key: "iheartest", name: "iHEARtest", bundleId: "com.innerscope.iheartest", posthog: { notConfigured: true }, capgo: { notConfigured: true }, revenuecat: { notConfigured: true } }],
    capgoConfigured: false,
    revenuecatConfigured: false,
    posthogConfigured: false,
    revenuecatGap: null,
  });
  assert.match(md, /# Growth Room — 2026-07-21/);
  assert.match(md, /## Per-app summary/);
  assert.match(md, /## OTA rollout health \(Capgo\)/);
  assert.match(md, /## Subscription \/ MRR signal \(RevenueCat\)/);
  assert.match(md, /## Funnel highlights \(PostHog\)/);
  assert.match(md, /## Open \/ flags/);
  assert.match(md, /NOT CONFIGURED this run/);
  assert.match(md, /iHEARtest/);
});

test("composeMarkdown surfaces a per-app RevenueCat/Capgo error without throwing", () => {
  const md = composeMarkdown({
    date: "2026-07-21",
    days: 7,
    rows: [{ key: "aware", name: "AWARE Aural Rehab", bundleId: "com.innerscope.aware", posthog: { ok: true, events: 10, actives: 3, topEvents: [{ event: "app_open", n: 5 }] }, capgo: { error: "capgo statistics 500: boom" }, revenuecat: { noProject: true } }],
    capgoConfigured: true,
    revenuecatConfigured: true,
    posthogConfigured: true,
    revenuecatGap: null,
  });
  assert.match(md, /AWARE Aural Rehab\/capgo: capgo statistics 500/);
  assert.match(md, /app_open \(5\)/);
});

test("composeMarkdown notes a RevenueCat project-scoping gap when flagged", () => {
  const md = composeMarkdown({
    date: "2026-07-21",
    days: 7,
    rows: [],
    capgoConfigured: true,
    revenuecatConfigured: true,
    posthogConfigured: true,
    revenuecatGap: 1,
  });
  assert.match(md, /the RevenueCat key visible to this job maps to 1 project/);
});
