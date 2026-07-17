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
 * Group raw recall-CLI stdout lines into one string per RETRIEVED MEMORY, not one string per line of
 * text. Why this exists: semantic.mjs recall() renders each hit as 2-3 output lines (a "[agent] [type]
 * date (score ...)" header, the text, and an optional "tags: ..." line). Before this helper, the
 * runner fed every raw line straight into precisionAtK/hitAtK with a line-based cutoff k -- so "top-5"
 * silently meant "top ~2 retrieved memories" (5 lines / ~2.5 lines-per-hit), not the 5 documents the
 * search actually returned. That shrank the effective eval window by more than half and produced
 * false MISSes on memories that were genuinely retrieved, just not within the first 5 raw lines.
 * Grouping restores the intended meaning of k: "did a relevant memory appear in the top-k RESULTS."
 *
 * Detection rule: a line matching HEADER_RE starts a new hit block; every following line is appended
 * to the current block until the next header (or the array ends). The very first line always starts
 * a block even if it doesn't match (defensive: never drop a line if the caller's format ever drifts).
 * Pure (no IO); the CLI-output framing recall-evals happens to consume for now.
 * @param {string[]} rawLines - already trimmed, non-empty, non-comment lines (as run-evals.mjs already filters).
 * @returns {string[]} one entry per hit block.
 */
const HIT_HEADER_RE = /^\[[^\]]+\]\s*\[[^\]]+\]\s/; // "[agent] [type] ..." - semantic.mjs recall()'s header line
export function groupHitLines(rawLines) {
  const lines = Array.isArray(rawLines) ? rawLines : [];
  const hits = [];
  for (const l of lines) {
    if (HIT_HEADER_RE.test(l) || hits.length === 0) hits.push(l);
    else hits[hits.length - 1] += " " + l;
  }
  return hits;
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
