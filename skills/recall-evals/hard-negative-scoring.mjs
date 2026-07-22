// hard-negative-scoring.mjs -- pure scoring core for the CONTRASTIVE (hard-negative) recall eval.
// No IO (no fetch/fs/network/creds/process.env), mirrors scoring.mjs's own purity contract exactly.
//
// WHY THIS IS A SEPARATE METRIC FROM scoring.mjs's hitAtK/precisionAtK/aggregate: the standard golden
// set only asks "did a relevant memory show up." A hard-negative case asks a SECOND, independent
// question at the same time: "did the SUPERSEDED (retracted) memory on the exact same topic get
// correctly EXCLUDED." A regression that makes retraction-filtering silently stop working (a future
// reindex bug that forgets to compute/refresh `retracted:true`, or a gateway change that drops the
// filterRetracted() step) would still let the standard golden set pass at 100% hit@5 (the CURRENT
// fact is often still findable), while a hard-negative case would start FAILING the instant the old,
// wrong, semantically-similar memory leaks back into the top-k -- exactly the failure mode this file
// exists to catch. See mine-hard-negatives.mjs for how real (old, new) pairs are mined + validated.
import { lineMatches, hitAtK } from "./scoring.mjs";

/**
 * Score ONE hard-negative case's retrieved results against its two expectation sets.
 * @param {string[]} results - ordered result lines/texts (top-first), same shape scoring.mjs consumes.
 * @param {string[]} expectNew - substrings distinctive to the CURRENT/correct fact; a hit is GOOD.
 * @param {string[]} expectOld - substrings distinctive to the OLD/retracted fact; a hit is BAD (a leak).
 * @param {number} [k] - cutoff (defaults to full results length, matching scoring.mjs's convention).
 * @returns {{newHit: 0|1, oldLeak: 0|1, passed: 0|1}} passed = the current fact was found AND the
 *   retracted one did not leak into the top-k. This is the real "did the fleet get this right" bit.
 */
export function hardNegItemResult(results, expectNew, expectOld, k) {
  const newHit = hitAtK(results, expectNew, k);
  const oldLeak = hitAtK(results, expectOld, k);
  const passed = newHit === 1 && oldLeak === 0 ? 1 : 0;
  return { newHit, oldLeak, passed };
}

/**
 * Aggregate a full hard-negative run.
 * @param {Array<{results: string[], expectNew: string[], expectOld: string[]}>} items
 * @param {number} [k]
 * @returns {{n: number, correctRate: number, leakRate: number, passRate: number}}
 *   correctRate = fraction where the current fact was found (independent of leakage).
 *   leakRate    = fraction where the retracted fact leaked into the top-k (want this near 0).
 *   passRate    = fraction that are BOTH correct and leak-free -- the SLO metric this harness pages on.
 */
export function aggregateHardNeg(items, k) {
  const list = Array.isArray(items) ? items : [];
  const n = list.length;
  if (n === 0) return { n: 0, correctRate: 0, leakRate: 0, passRate: 0 };
  let sumNew = 0, sumLeak = 0, sumPass = 0;
  for (const it of list) {
    const results = (it && it.results) || [];
    const expectNew = (it && it.expectNew) || [];
    const expectOld = (it && it.expectOld) || [];
    const r = hardNegItemResult(results, expectNew, expectOld, k);
    sumNew += r.newHit;
    sumLeak += r.oldLeak;
    sumPass += r.passed;
  }
  return { n, correctRate: sumNew / n, leakRate: sumLeak / n, passRate: sumPass / n };
}

/**
 * Does the SYNTHESIZED deep-mode answer text itself contain a leak of the old/retracted claim, or
 * ground the current one? Reuses scoring.mjs's lineMatches on a single string (an "answer" is really
 * just a one-line "result" for matching purposes). Pure.
 * @param {string} answerText
 * @param {string[]} expect
 * @returns {boolean}
 */
export function answerMatches(answerText, expect) {
  return lineMatches(answerText, expect);
}
