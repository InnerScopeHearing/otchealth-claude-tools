// recall-evals SCORING CORE — pure, unit-testable, NO IO (no fetch/fs/network/creds/process.env).
// Computes precision@k, hit-rate, and MRR (mean reciprocal rank) over a golden set's recall results.
// Kept separate from the runner (which does the actual I/O) so the math can be tested in isolation
// and never accidentally depends on the recall transport, the SA, or a live store.
//
// A "hit" for one golden item = at least one returned line contains at least one of its
// `expect` substrings (case-insensitive). Substring match, not exact-id match, because the ledger
// text itself IS the payload (kb-memory recall returns free-text lines, not row ids as a stable API).

/**
 * Does a single returned line count as relevant for this golden item?
 * @param {string} line - one line of recall output (already lower-cased by caller convention, but
 *   this function lower-cases defensively so callers can pass raw text).
 * @param {string[]} expect - substrings, ANY of which makes the line relevant.
 * @returns {boolean}
 */
export function lineMatches(line, expect) {
  if (!line || !Array.isArray(expect) || expect.length === 0) return false;
  const hay = String(line).toLowerCase();
  return expect.some((s) => typeof s === "string" && s.length > 0 && hay.includes(s.toLowerCase()));
}

/**
 * Precision@k for ONE query's result list: of the top-k returned lines, what fraction are relevant?
 * @param {string[]} results - ordered result lines (best/first match first).
 * @param {string[]} expect - substrings that make a line relevant.
 * @param {number} k - cutoff (defaults to results.length, i.e. precision over everything returned).
 * @returns {number} 0..1. Returns 0 if k <= 0 or no results.
 */
export function precisionAtK(results, expect, k) {
  const list = Array.isArray(results) ? results : [];
  const hasK = Number.isFinite(k);
  if (hasK && k <= 0) return 0;
  const kk = hasK ? Math.min(k, list.length) : list.length;
  if (kk <= 0) return 0;
  const top = list.slice(0, kk);
  const relevant = top.filter((line) => lineMatches(line, expect)).length;
  return relevant / kk;
}

/**
 * Hit-rate for ONE query: 1 if ANY returned line (within the first k, default all) is relevant, else 0.
 * @param {string[]} results
 * @param {string[]} expect
 * @param {number} [k]
 * @returns {0|1}
 */
export function hitAtK(results, expect, k) {
  const list = Array.isArray(results) ? results : [];
  const hasK = Number.isFinite(k);
  if (hasK && k <= 0) return 0;
  const kk = hasK ? Math.min(k, list.length) : list.length;
  const top = list.slice(0, kk);
  return top.some((line) => lineMatches(line, expect)) ? 1 : 0;
}

/**
 * Reciprocal rank for ONE query: 1/rank of the FIRST relevant line (1-indexed), else 0 if none found.
 * @param {string[]} results
 * @param {string[]} expect
 * @returns {number} 0..1
 */
export function reciprocalRank(results, expect) {
  const list = Array.isArray(results) ? results : [];
  for (let i = 0; i < list.length; i++) {
    if (lineMatches(list[i], expect)) return 1 / (i + 1);
  }
  return 0;
}

/**
 * Aggregate a full run: array of { results: string[], expect: string[] } (one per golden item) into
 * mean precision@k, hit-rate, and MRR across the whole golden set. Pure aggregation, no IO.
 * @param {Array<{results: string[], expect: string[]}>} items
 * @param {number} [k]
 * @returns {{n: number, meanPrecisionAtK: number, hitRate: number, mrr: number}}
 */
export function aggregate(items, k) {
  const list = Array.isArray(items) ? items : [];
  const n = list.length;
  if (n === 0) return { n: 0, meanPrecisionAtK: 0, hitRate: 0, mrr: 0 };
  let sumP = 0, sumHit = 0, sumRR = 0;
  for (const it of list) {
    const results = (it && it.results) || [];
    const expect = (it && it.expect) || [];
    sumP += precisionAtK(results, expect, k);
    sumHit += hitAtK(results, expect, k);
    sumRR += reciprocalRank(results, expect);
  }
  return {
    n,
    meanPrecisionAtK: sumP / n,
    hitRate: sumHit / n,
    mrr: sumRR / n,
  };
}
