// Regression gate for SIGNAL RADAR's pure classification logic - the exact same discipline as
// tests/fleet-medic.test.mjs applied to Radar's detectors. Every test here is hermetic (no network, no
// Cosmos, no Sentry/PostHog): each detector's I/O-touching run() delegates to a pure, exported function
// that this file exercises directly. If these regress, Radar either misses a real signal or starts
// crying wolf on a healthy fleet.
import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldFire, isMnpiSubject, isPhiExcluded, signalId, makeSignal } from "../skills/signal-radar/schema.mjs";
import { evaluateSeries } from "../skills/signal-radar/detectors/sentry-error-spike.mjs";
import { findRegressions } from "../skills/signal-radar/detectors/eval-regression.mjs";
import { classifyGrants } from "../skills/signal-radar/detectors/grant-burn-expiry.mjs";
import { findAgedRotateSecrets } from "../skills/signal-radar/detectors/rotate-secret-age.mjs";
import { parseLedger, isReviewCandidate } from "../skills/signal-radar/detectors/mark-review-overdue.mjs";

// ---------------------------------------------------------------- schema.mjs (the shared brain) ----
test("signalId is stable and lowercases/sanitizes the subject", () => {
  assert.equal(signalId("sentry-error-spike", "iHEARtest"), "sentry-error-spike::iheartest");
  assert.equal(signalId("d", "A B/c.d_e-f"), "d::a-b-c.d_e-f");
});

test("makeSignal fills in ts and defaults mnpi=false", () => {
  const s = makeSignal({ detector: "d", owner: "cto", subject: "x", severity: "low", why: "w", suggested_action: "a" });
  assert.equal(s.mnpi, false);
  assert.ok(s.ts);
  assert.equal(s.id, "d::x");
});

test("shouldFire: a brand-new finding (no history) always fires and is not an escalation", () => {
  const r = shouldFire([], Date.now(), { cooldownMin: 240, escalateAfter: 3 });
  assert.equal(r.fire, true);
  assert.equal(r.escalate, false);
});

test("shouldFire: within cooldown window suppresses a re-fire (no crying wolf)", () => {
  const now = Date.parse("2026-07-01T12:00:00Z");
  const history = [{ ts: new Date(now - 30 * 60000).toISOString() }]; // fired 30 min ago
  const r = shouldFire(history, now, { cooldownMin: 240, escalateAfter: 3 });
  assert.equal(r.fire, false);
});

test("shouldFire: past cooldown, a persistent finding (>= escalateAfter) escalates", () => {
  const now = Date.parse("2026-07-01T12:00:00Z");
  const history = [
    { ts: new Date(now - 10 * 3600000).toISOString() },
    { ts: new Date(now - 8 * 3600000).toISOString() },
  ]; // 2 prior firings, both past cooldown
  const r = shouldFire(history, now, { cooldownMin: 240, escalateAfter: 3 });
  assert.equal(r.fire, true);
  assert.equal(r.consecutive, 3);
  assert.equal(r.escalate, true);
});

test("isMnpiSubject flags INND/securities-shaped subjects, not ordinary ones", () => {
  assert.equal(isMnpiSubject("grant-burn-expiry", "INND stock price feed"), true);
  assert.equal(isMnpiSubject("rotate-secret-age", "xero-refresh-token-innd"), true);
  assert.equal(isMnpiSubject("sentry-error-spike", "iheartest"), false);
});

test("isPhiExcluded blocks every known MedReview Sentry project slug", () => {
  assert.equal(isPhiExcluded("medreview-api"), true);
  assert.equal(isPhiExcluded("medreview-web"), true);
  assert.equal(isPhiExcluded("iheartest"), false);
});

// ------------------------------------------------------------- detector 1: sentry-error-spike ----
test("sentry-error-spike: a 3x+ week-over-week spike above the floor fires", () => {
  const flatWeeks = [...Array(21)].map(() => 1); // 3 flat prior weeks, ~1/day = 7/week baseline
  const spikeWeek = [...Array(7)].map(() => 4); // 28 this week vs baseline 7 -> 4x
  const r = evaluateSeries([...flatWeeks, ...spikeWeek]);
  assert.equal(r.spike, true);
});

test("sentry-error-spike: normal day-to-day noise under the multiplier does NOT fire", () => {
  const flatWeeks = [...Array(21)].map(() => 2); // baseline 14/week
  const mildBump = [1, 2, 3, 2, 2, 3, 2]; // 15/week, ~1.07x
  const r = evaluateSeries([...flatWeeks, ...mildBump]);
  assert.equal(r.spike, false);
});

test("sentry-error-spike: a low-volume project under the absolute floor does not fire even at a huge ratio", () => {
  const flatWeeks = [...Array(21)].map(() => 0); // baseline 0
  const tinyWeek = [1, 0, 0, 0, 0, 0, 0]; // 1 error this week; below the 5/week floor
  const r = evaluateSeries([...flatWeeks, ...tinyWeek]);
  assert.equal(r.spike, false);
});

test("sentry-error-spike: insufficient history (cold-start project) does not fire", () => {
  const r = evaluateSeries([1, 2, 3]);
  assert.equal(r.spike, false);
  assert.match(r.reason, /insufficient/);
});

// --------------------------------------------------------------- detector 3: eval-regression ----
test("eval-regression: a hard drop between the two most recent runs of the SAME task fires", () => {
  const rows = [
    { agent: "commerce", task_id: "psap", score: 1, ts: "2026-06-22T14:13:19Z" },
    { agent: "commerce", task_id: "psap", score: 0, ts: "2026-06-22T14:25:02Z" },
  ];
  const regs = findRegressions(rows);
  assert.equal(regs.length, 1);
  assert.equal(regs[0].agent, "commerce");
  assert.equal(regs[0].drop, 1);
});

test("eval-regression: a small score jitter under the threshold does not fire", () => {
  const rows = [
    { agent: "cto", task_id: "diagnose", score: 1, ts: "2026-06-20T00:00:00Z" },
    { agent: "cto", task_id: "diagnose", score: 0.8, ts: "2026-06-21T00:00:00Z" }, // drop 0.2, below 0.34
  ];
  assert.equal(findRegressions(rows).length, 0);
});

test("eval-regression: only ONE prior run (no comparison possible) does not fire", () => {
  const rows = [{ agent: "cto", task_id: "diagnose", score: 0, ts: "2026-06-20T00:00:00Z" }];
  assert.equal(findRegressions(rows).length, 0);
});

test("eval-regression: an IMPROVING score never fires (drop is negative)", () => {
  const rows = [
    { agent: "qa", task_id: "gate", score: 0, ts: "2026-06-01T00:00:00Z" },
    { agent: "qa", task_id: "gate", score: 1, ts: "2026-06-02T00:00:00Z" },
  ];
  assert.equal(findRegressions(rows).length, 0);
});

// ------------------------------------------------------------- detector 4: grant-burn-expiry ----
test("grant-burn-expiry: an active grant inside the 60-day window is flagged expiring-soon", () => {
  const now = new Date("2026-07-01T00:00:00Z");
  const grants = [{ name: "TestGrant", status: "active", added: "2025-08-01", termMonths: 11 }]; // ~10 days left
  const out = classifyGrants(grants, now);
  assert.equal(out[0].condition, "expiring-soon");
});

test("grant-burn-expiry: an active grant whose term already lapsed is flagged lapsed-but-still-active", () => {
  const now = new Date("2026-07-01T00:00:00Z");
  const grants = [{ name: "OldGrant", status: "active", added: "2025-01-01", termMonths: 6 }]; // long expired
  const out = classifyGrants(grants, now);
  assert.equal(out[0].condition, "lapsed-but-still-active");
});

test("grant-burn-expiry: a healthy grant far from expiry is not flagged", () => {
  const now = new Date("2026-07-01T00:00:00Z");
  const grants = [{ name: "FreshGrant", status: "active", added: "2026-06-01", termMonths: 12 }];
  const out = classifyGrants(grants, now);
  assert.equal(out[0].condition, "healthy");
});

test("grant-burn-expiry: HOLD/declined grants are ignored entirely (never surfaced as a burn signal)", () => {
  const now = new Date("2026-07-01T00:00:00Z");
  const grants = [
    { name: "Declined", status: "declined", added: "2020-01-01", termMonths: 1 },
    { name: "OnHold", status: "hold", added: "2020-01-01", termMonths: 1 },
  ];
  assert.equal(classifyGrants(grants, now).length, 0);
});

// ------------------------------------------------------------- detector 5: rotate-secret-age ----
test("rotate-secret-age: a rotate-listed secret past the age threshold is flagged", () => {
  const now = new Date("2026-07-01T00:00:00Z");
  const secrets = [{ id: "github-app-private-key", created: "2025-06-01T00:00:00Z" }]; // >180d old
  const out = findAgedRotateSecrets(secrets, ["github-app"], now, 180);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, "github-app-private-key");
});

test("rotate-secret-age: a young rotate-listed secret does not fire", () => {
  const now = new Date("2026-07-01T00:00:00Z");
  const secrets = [{ id: "azure-sp-client-secret", created: "2026-06-04T00:00:00Z" }]; // ~27d old
  assert.equal(findAgedRotateSecrets(secrets, ["azure-sp"], now, 180).length, 0);
});

test("rotate-secret-age: a secret NOT on the rotate list is never flagged, however old", () => {
  const now = new Date("2026-07-01T00:00:00Z");
  const secrets = [{ id: "some-random-config-value", created: "2020-01-01T00:00:00Z" }];
  assert.equal(findAgedRotateSecrets(secrets, ["github-app", "azure-sp"], now, 180).length, 0);
});

// ------------------------------------------------------------ detector 6: mark-review-overdue ----
const SAMPLE_LEDGER = `# Sample Ledger

| Marketing | Build (CFBundleVersion) | Commit | ASC upload | TF / App Store status | Changeset | What Mark must verify & why |
|---|---|---|---|---|---|---|
| 1.0.0 | 1 | \`abc123\` | 2026-06-01 10:00 PT | On TestFlight, VALID | first build | check everything |
| 1.0.1 | 2 | \`def456\` | PENDING | Not yet uploaded | wip | n/a |
| 1.0.2 | 3 | \`ghi789\` | N/A | **SUPERSEDED by build 4** | superseded changes | see build 4 instead |
`;

test("mark-review-overdue: parseLedger extracts every data row with the right cell boundaries", () => {
  const rows = parseLedger(SAMPLE_LEDGER);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].marketing, "1.0.0");
  assert.equal(rows[0].build, "1");
  assert.match(rows[0].ascUpload, /2026-06-01/);
});

test("mark-review-overdue: isReviewCandidate accepts a real ASC upload date", () => {
  const rows = parseLedger(SAMPLE_LEDGER);
  assert.ok(isReviewCandidate(rows[0]));
});

test("mark-review-overdue: isReviewCandidate rejects PENDING (never shipped) and SUPERSEDED rows", () => {
  const rows = parseLedger(SAMPLE_LEDGER);
  assert.equal(isReviewCandidate(rows[1]), false); // PENDING
  assert.equal(isReviewCandidate(rows[2]), false); // SUPERSEDED
});
