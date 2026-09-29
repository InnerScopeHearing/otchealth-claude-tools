// credit-guard.mjs -- the spend gate for ad-studio.
//
// RULES
//  1. Every generating command is a DRY RUN unless BOTH --commit AND --max-credits N are given.
//  2. Known-rate estimates are summed; if the sum exceeds the cap, nothing is submitted.
//  3. A job whose rate is UNKNOWN blocks the run unless --allow-unknown-rate is given. Even then it is not free of
//     the cap: every unknown-rate job is bounded by a deliberately HIGH default ceiling (CEILING_RATES), and the
//     planner and the runtime guard both require known estimates + ceilings to fit under the cap.
//  4. While running, the guard keeps a running total of credits (balance delta after each job; when the delta is
//     missing, zero or negative the job is charged at its estimate/ceiling instead) and refuses to START a job whose
//     bound would push the total past the cap. A single job can still cost more than its ceiling if the ceiling is
//     wrong; the guard then stops everything after it and the ledger learns the real number.
//  5. Every real job appends {balance before/after, delta, units} to a JSONL ledger. The estimator reads the
//     ledger, so rates that were unknown become known after one real run.
//
// The rate table is deliberately tiny: ElevenLabs publishes NO per-unit credit table for Flows video, so only
// values that were MEASURED (or stated on a docs page) are listed; everything else is null = UNKNOWN.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export function defaultLedgerPath(env = process.env) {
  return env.AD_STUDIO_LEDGER || join(homedir(), '.cache', 'ad-studio', 'credit-ledger.jsonl');
}

/** kind -> unit. Rate keys: video `video|<model>|<resolution>|<audio|silent>`, tts `tts|<model>`, music `music|<model>`, sfx `sfx`, dubbing `dubbing`. */
export const UNITS = { video: 'second', tts: 'char', music: 'second', sfx: 'second', dubbing: 'second' };

/** perUnit = credits per unit. source explains where the number came from. null perUnit = UNKNOWN. */
export const KNOWN_RATES = {
  'video|veo-3.1-fast-generate-001|1080p|silent': { perUnit: 1000, source: 'measured 2026-09-29: 4 s = 4,000 credits (grant account)' },
  // Docs (overview/capabilities/sound-effects.md): "40 credits per second when duration is specified".
  'sfx': { perUnit: 40, source: 'docs: 40 credits/s when duration_seconds is given' },
};

/** Deliberately HIGH per-unit ceilings for kinds whose real rate is unpublished. Used only to bound the spend of
 *  unknown-rate jobs against the cap; they are never presented as estimates. Overestimates by design. */
export const CEILING_RATES = {
  video: 5000,     // credits per second (measured Veo fast 1080p silent is 1,000)
  tts: 2,          // credits per character
  music: 300,      // credits per second
  sfx: 40,         // credits per second (docs)
  dubbing: 2000,   // credits per second of source speech
};
const SFX_AUTO_CEILING = 30 * 40; // auto-length SFX can run to the 30 s maximum

export function ceilingOf(job) {
  if (job.kind === 'sfx' && !(job.seconds > 0)) return SFX_AUTO_CEILING;
  const per = CEILING_RATES[job.kind] ?? 5000;
  const units = unitsOf(job);
  return Math.ceil(per * (Number.isFinite(units) && units > 0 ? units : 60));
}

export function rateKey(job) {
  switch (job.kind) {
    case 'video': return `video|${job.model}|${job.resolution}|${job.audio ? 'audio' : 'silent'}`;
    case 'tts': return `tts|${job.model}`;
    case 'music': return `music|${job.model}`;
    case 'sfx': return 'sfx';
    case 'dubbing': return 'dubbing';
    default: return String(job.kind);
  }
}

export function unitsOf(job) {
  switch (job.kind) {
    case 'tts': return job.chars;
    default: return job.seconds;
  }
}

/** Read the ledger; skip corrupt lines. */
export function readLedger(path = defaultLedgerPath()) {
  if (!existsSync(path)) return [];
  const out = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip corrupt line */ }
  }
  return out;
}

export function appendLedger(entry, path = defaultLedgerPath()) {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(entry) + '\n');
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Rates learned from real, single-flight jobs: median(delta/units) per rate key. */
export function learnedRates(ledger) {
  const by = new Map();
  for (const e of ledger) {
    if (!e || e.ok === false || e.attributable === false) continue;
    if (!(e.delta > 0) || !(e.units > 0) || !e.rateKey) continue;
    if (!by.has(e.rateKey)) by.set(e.rateKey, []);
    by.get(e.rateKey).push(e.delta / e.units);
  }
  const out = {};
  for (const [k, v] of by) out[k] = { perUnit: median(v), samples: v.length, source: `learned from ${v.length} ledger sample(s)` };
  return out;
}

/** Look up a rate. A LEARNED rate needs >= 2 ledger samples, and where a measured/docs rate already exists a
 *  learned rate may only RAISE it (a lucky cheap sample never lowers the guard). Otherwise: table, else UNKNOWN. */
export const MIN_LEARNED_SAMPLES = 2;
export function lookupRate(job, ledger = []) {
  const key = rateKey(job);
  const l = learnedRates(ledger)[key];
  const learned = l && l.samples >= MIN_LEARNED_SAMPLES ? l : null;
  let known = KNOWN_RATES[key];
  if (known && job.kind === 'sfx' && !(job.seconds > 0)) known = null; // sfx table rate only applies with a duration
  if (known && known.perUnit != null) {
    if (learned && learned.perUnit > known.perUnit) return { key, ...learned };
    return { key, ...known };
  }
  if (learned) return { key, ...learned };
  return { key, perUnit: null, source: 'UNKNOWN: no published or measured rate' };
}

/** Estimate one job. cached or resumed (already paid) jobs cost 0. `ceiling` is what the guard bounds the job at. */
export function estimateJob(job, ledger = []) {
  if (job.cached || job.resumed) return { job, credits: 0, ceiling: 0, known: true, key: rateKey(job), source: job.cached ? 'cache hit, no spend' : 'resuming an already-paid generation, no new spend' };
  const r = lookupRate(job, ledger);
  const units = unitsOf(job);
  if (r.perUnit == null || !(units >= 0)) return { job, credits: null, ceiling: ceilingOf(job), known: false, key: r.key, source: r.source, units };
  const credits = Math.ceil(r.perUnit * units);
  return { job, credits, ceiling: credits, known: true, key: r.key, source: r.source, units };
}

/**
 * Plan the spend for a list of jobs. Never spends anything itself.
 * Returns {mode:'dry-run'|'commit', proceed:boolean, lines[], knownTotal, unknownCount, reasons[], estimates[]}.
 * `proceed` is true ONLY when mode==='commit' and every gate passed.
 */
export function planSpend({ jobs, commit = false, maxCredits, allowUnknownRate = false, ledger = [], balanceRemaining = null }) {
  const estimates = jobs.map((j) => estimateJob(j, ledger));
  const knownTotal = estimates.reduce((a, e) => a + (e.known ? e.credits : 0), 0);
  const unknown = estimates.filter((e) => !e.known);
  const ceilingTotal = unknown.reduce((a, e) => a + e.ceiling, 0);
  const worstCase = knownTotal + ceilingTotal;
  const lines = estimates.map((e) => {
    const j = e.job;
    const what = `${j.kind.padEnd(7)} ${j.label || ''}`.trim();
    const cost = e.known ? `${e.credits.toLocaleString()} credits` : `UNKNOWN (bounded at ${e.ceiling.toLocaleString()})`;
    return `  ${what.padEnd(46)} ${cost.padStart(30)}   [${e.source}]`;
  });
  const reasons = [];
  const mode = commit ? 'commit' : 'dry-run';
  if (commit) {
    if (!(Number.isFinite(maxCredits) && maxCredits > 0)) reasons.push('--commit requires --max-credits N (a positive number)');
    else if (knownTotal > maxCredits) reasons.push(`known estimate ${knownTotal.toLocaleString()} exceeds --max-credits ${maxCredits.toLocaleString()}`);
    else if (worstCase > maxCredits) reasons.push(`worst case ${worstCase.toLocaleString()} (known ${knownTotal.toLocaleString()} + ceilings for ${unknown.length} unknown-rate job(s) ${ceilingTotal.toLocaleString()}) exceeds --max-credits ${maxCredits.toLocaleString()}`);
    if (unknown.length && !allowUnknownRate) reasons.push(`${unknown.length} job(s) have an UNKNOWN rate (${[...new Set(unknown.map((u) => u.key))].join(', ')}); pass --allow-unknown-rate to accept the risk (each is still bounded by a ceiling under the cap)`);
    if (balanceRemaining != null && worstCase > balanceRemaining) reasons.push(`worst case ${worstCase.toLocaleString()} exceeds remaining balance ${balanceRemaining.toLocaleString()}`);
  }
  return { mode, proceed: commit && reasons.length === 0, lines, knownTotal, ceilingTotal, worstCase, unknownCount: unknown.length, reasons, estimates };
}

export function formatPlan(plan, { maxCredits } = {}) {
  const out = [];
  out.push(plan.mode === 'commit' ? 'SPEND PLAN (commit requested)' : 'SPEND PLAN (DRY RUN, nothing will be submitted)');
  out.push(...plan.lines);
  out.push(`  known total: ${plan.knownTotal.toLocaleString()} credits` + (plan.unknownCount ? `  +  ${plan.unknownCount} unknown-rate job(s) bounded at ${plan.ceilingTotal.toLocaleString()} (worst case ${plan.worstCase.toLocaleString()})` : ''));
  if (maxCredits) out.push(`  cap: ${Number(maxCredits).toLocaleString()} credits`);
  if (plan.mode === 'dry-run') out.push('  To spend: re-run with --commit --max-credits N (and --allow-unknown-rate if any rate is UNKNOWN).');
  for (const r of plan.reasons) out.push(`  REFUSED: ${r}`);
  return out.join('\n');
}

/**
 * Runtime guard for a committed run. Tracks ACTUAL spend and enforces the cap between jobs.
 *   const g = new SpendGuard({client, maxCredits, ledgerPath, runId});
 *   await g.run(job, async () => {...generate...});   // records the ledger entry, throws BudgetExceeded before starting a job that would cross the cap
 */
export class BudgetExceeded extends Error {
  constructor(msg) { super(msg); this.name = 'BudgetExceeded'; }
}

export class SpendGuard {
  /** `uncapped: true` (legacy single-shot scripts with no --max-credits) keeps the ledger + before/after logging but
   *  enforces no ceiling. Everything else requires a positive cap. */
  constructor({ client, maxCredits, uncapped = false, ledgerPath = defaultLedgerPath(), runId = `run-${Date.now()}`, ledger = readLedger(ledgerPath), now = () => new Date().toISOString() }) {
    if (uncapped) maxCredits = Infinity;
    else if (!(Number.isFinite(maxCredits) && maxCredits > 0)) throw new Error('SpendGuard requires a positive maxCredits');
    Object.assign(this, { client, maxCredits, ledgerPath, runId, ledger, now });
    this.spent = 0;
    this.warnings = [];
  }

  async run(job, fn) {
    if (job.cached || job.resumed) return fn();
    const est = estimateJob(job, this.ledger);
    const bound = est.known ? est.credits : est.ceiling;
    if (this.spent + bound > this.maxCredits) {
      throw new BudgetExceeded(`refusing to start "${job.label || job.kind}": ${this.spent.toLocaleString()} spent + ${bound.toLocaleString()} ${est.known ? 'estimated' : 'ceiling (unknown rate)'} > cap ${this.maxCredits.toLocaleString()}`);
    }
    const before = await this.client.balance();
    let ok = true, result, err;
    try { result = await fn(); } catch (e) { ok = false; err = e; }
    let after = null;
    try { after = await this.client.balance(); } catch { /* recorded below as a missing delta */ }
    const delta = after && Number.isFinite(before.used) && Number.isFinite(after.used) ? after.used - before.used : null;
    const reliable = delta != null && delta > 0;
    // A missing / zero / negative delta on a job that succeeded (or may have been accepted) is NOT "free": charge the bound.
    let charged;
    if (reliable) charged = delta;
    else if (ok || err?.outcomeUnknown) charged = bound;
    else charged = 0; // a definite failure with no balance movement was not charged
    this.spent += charged;
    const entry = {
      ts: this.now(), runId: this.runId, kind: job.kind, label: job.label, rateKey: rateKey(job),
      model: job.model, resolution: job.resolution, audio: !!job.audio, units: unitsOf(job),
      before: before.used, after: after?.used ?? null, delta, charged, deltaReliable: reliable, estimate: est.known ? est.credits : null,
      ok, attributable: reliable && ok, // the guard runs jobs strictly one at a time, so a positive delta belongs to this job
    };
    appendLedger(entry, this.ledgerPath);
    this.ledger.push(entry);
    if (!ok) throw err;
    const warn = !reliable ? `balance delta unavailable; charged the ${est.known ? 'estimate' : 'ceiling'} (${charged}) against the cap`
      : (est.known && delta > est.credits * 1.5 + 10 ? `actual ${delta} credits vs estimate ${est.credits}` : null);
    if (warn) {
      this.warnings.push(warn);
      // only PLAIN objects are decorated; a Buffer/array result (raw audio, etc.) must come back untouched
      if (result && Object.getPrototypeOf(result) === Object.prototype) result = { ...result, spendWarning: warn };
    }
    return result;
  }
}
