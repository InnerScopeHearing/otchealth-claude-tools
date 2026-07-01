// Detector 1: Sentry error-rate spike. HIGH PRECISION rationale: compares THIS week's daily error
// count against the MEDIAN of the prior weeks (not the mean, so one bad day does not get baked into
// the baseline), and only fires at a fixed, generous multiplier (default 3x) so normal day-to-day
// noise on a low-volume project never trips it. Requires a minimum absolute floor (default 5
// errors/week) so a project going from 1 error to 4 errors (400%!) does not fire on statistical noise.
//
// PHI GUARDRAIL: MedReview projects are hard-excluded (isPhiExcluded), never queried, never surfaced,
// even if Sentry technically returns their stats.
import { sentryRequest, SENTRY_ORG_SLUG } from "../common.mjs";
import { isPhiExcluded, makeSignal } from "../schema.mjs";

export const NAME = "sentry-error-spike";
export const OWNER = "cto"; // infra domain

const WEEKS_BASELINE = 3; // compare vs the median of the 3 prior weeks
const MULTIPLIER = 3;
const MIN_WEEKLY_FLOOR = 5; // below this absolute count, ratios are too noisy to act on

function median(nums) {
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Pure core: given a per-project array of daily counts (oldest-first, 7*(WEEKS_BASELINE+1) days),
 * decide if the most recent 7 days constitute a spike. Exported for hermetic unit testing. */
export function evaluateSeries(dailyCounts, opts = {}) {
  const weeks = opts.weeksBaseline ?? WEEKS_BASELINE;
  const mult = opts.multiplier ?? MULTIPLIER;
  const floor = opts.minWeeklyFloor ?? MIN_WEEKLY_FLOOR;
  const need = 7 * (weeks + 1);
  if (dailyCounts.length < need) return { spike: false, reason: "insufficient history" };
  const recent7 = dailyCounts.slice(-7);
  const thisWeek = recent7.reduce((a, b) => a + b, 0);
  const priorWeeklyTotals = [];
  for (let w = 1; w <= weeks; w++) {
    const slice = dailyCounts.slice(-7 * (w + 1), -7 * w);
    priorWeeklyTotals.push(slice.reduce((a, b) => a + b, 0));
  }
  const baseline = median(priorWeeklyTotals);
  if (thisWeek < floor) return { spike: false, reason: `below floor (${thisWeek} < ${floor})`, thisWeek, baseline };
  if (baseline === 0) {
    // baseline had zero errors; any floor-crossing week is a genuine new-error signal, not a ratio.
    return { spike: true, reason: `0 -> ${thisWeek} errors this week (new error source)`, thisWeek, baseline, ratio: Infinity };
  }
  const ratio = thisWeek / baseline;
  if (ratio >= mult) return { spike: true, reason: `${thisWeek} errors this week vs median ${baseline} (${ratio.toFixed(1)}x)`, thisWeek, baseline, ratio };
  return { spike: false, reason: `${ratio.toFixed(1)}x < ${mult}x threshold`, thisWeek, baseline, ratio };
}

export async function run() {
  const signals = [];
  const notes = [];
  const projects = await sentryRequest(`/organizations/${SENTRY_ORG_SLUG}/projects/`);
  const sinceEpoch = Math.floor(Date.now() / 1000) - 7 * (WEEKS_BASELINE + 1) * 86400;
  for (const p of projects) {
    if (isPhiExcluded(p.slug)) { notes.push(`skipped ${p.slug} (PHI ring excluded)`); continue; }
    try {
      const series = await sentryRequest(`/projects/${SENTRY_ORG_SLUG}/${p.slug}/stats/?stat=received&resolution=1d&since=${sinceEpoch}`);
      const daily = series.map((pt) => pt[1]);
      const evalResult = evaluateSeries(daily);
      if (evalResult.spike) {
        signals.push(makeSignal({
          detector: NAME, owner: OWNER, subject: p.slug, severity: evalResult.ratio >= MULTIPLIER * 2 ? "high" : "medium",
          why: `Sentry ${p.slug}: ${evalResult.reason}`,
          evidence_link: `https://otchealth-inc.sentry.io/projects/${p.slug}/?statsPeriod=14d`,
          suggested_action: `Open the ${p.slug} issue stream, sort by events, triage the top new/regressed issue.`,
        }));
      }
    } catch (e) { notes.push(`${p.slug}: ${e.message}`); }
  }
  return { signals, notes };
}
