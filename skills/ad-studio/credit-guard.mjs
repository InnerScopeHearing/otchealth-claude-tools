// credit-guard.mjs -- the spend gate for ad-studio.
//
// RULES
//  1. Every generating command is a DRY RUN unless BOTH --commit AND --max-credits N are given.
//  2. Known-rate estimates are summed; if the sum exceeds the cap, nothing is submitted.
//  3. A job whose rate is UNKNOWN blocks the run unless --allow-unknown-rate is given.
//  4. While running, the guard keeps a running total of ACTUAL credits (balance delta after each job) and refuses
//     to start another job once the cap would be crossed (this bounds unknown-rate jobs too).
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

/** Look up a rate: learned (ledger) first, then the measured/docs table, else UNKNOWN (perUnit null). */
export function lookupRate(job, ledger = []) {
  const key = rateKey(job);
  const learned = learnedRates(ledger)[key];
  if (learned) return { key, ...learned };
  const known = KNOWN_RATES[key];
  if (known && known.perUnit != null) {
    // The sfx rate is only valid when a duration was specified (docs); auto-length is unknown.
    if (job.kind === 'sfx' && !(job.seconds > 0)) return { key, perUnit: null, source: 'sfx without duration_seconds: cost not published' };
    return { key, ...known };
  }
  return { key, perUnit: null, source: 'UNKNOWN: no published or measured rate' };
}

/** Estimate one job. cached jobs cost 0. */
export function estimateJob(job, ledger = []) {
  if (job.cached) return { job, credits: 0, known: true, key: rateKey(job), source: 'cache hit, no spend' };
  const r = lookupRate(job, ledger);
  const units = unitsOf(job);
  if (r.perUnit == null || !(units >= 0)) return { job, credits: null, known: false, key: r.key, source: r.source, units };
  return { job, credits: Math.ceil(r.perUnit * units), known: true, key: r.key, source: r.source, units };
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
  const lines = estimates.map((e) => {
    const j = e.job;
    const what = `${j.kind.padEnd(7)} ${j.label || ''}`.trim();
    const cost = e.known ? `${e.credits.toLocaleString()} credits` : 'UNKNOWN credits';
    return `  ${what.padEnd(46)} ${cost.padStart(18)}   [${e.source}]`;
  });
  const reasons = [];
  const mode = commit ? 'commit' : 'dry-run';
  if (commit) {
    if (!(Number.isFinite(maxCredits) && maxCredits > 0)) reasons.push('--commit requires --max-credits N (a positive number)');
    else if (knownTotal > maxCredits) reasons.push(`known estimate ${knownTotal.toLocaleString()} exceeds --max-credits ${maxCredits.toLocaleString()}`);
    if (unknown.length && !allowUnknownRate) reasons.push(`${unknown.length} job(s) have an UNKNOWN rate (${[...new Set(unknown.map((u) => u.key))].join(', ')}); pass --allow-unknown-rate to accept the risk (the running cap still applies)`);
    if (balanceRemaining != null && knownTotal > balanceRemaining) reasons.push(`known estimate ${knownTotal.toLocaleString()} exceeds remaining balance ${balanceRemaining.toLocaleString()}`);
  }
  return { mode, proceed: commit && reasons.length === 0, lines, knownTotal, unknownCount: unknown.length, reasons, estimates };
}

export function formatPlan(plan, { maxCredits } = {}) {
  const out = [];
  out.push(plan.mode === 'commit' ? 'SPEND PLAN (commit requested)' : 'SPEND PLAN (DRY RUN, nothing will be submitted)');
  out.push(...plan.lines);
  out.push(`  known total: ${plan.knownTotal.toLocaleString()} credits` + (plan.unknownCount ? `  +  ${plan.unknownCount} job(s) with UNKNOWN cost` : ''));
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
  constructor({ client, maxCredits, ledgerPath = defaultLedgerPath(), runId = `run-${Date.now()}`, ledger = readLedger(ledgerPath), now = () => new Date().toISOString() }) {
    if (!(Number.isFinite(maxCredits) && maxCredits > 0)) throw new Error('SpendGuard requires a positive maxCredits');
    Object.assign(this, { client, maxCredits, ledgerPath, runId, ledger, now });
    this.spent = 0;
  }

  async run(job, fn) {
    if (job.cached) return fn();
    const est = estimateJob(job, this.ledger);
    if (est.known && this.spent + est.credits > this.maxCredits) {
      throw new BudgetExceeded(`refusing to start "${job.label || job.kind}": ${this.spent.toLocaleString()} spent + ${est.credits.toLocaleString()} estimated > cap ${this.maxCredits.toLocaleString()}`);
    }
    if (this.spent >= this.maxCredits) {
      throw new BudgetExceeded(`cap reached (${this.spent.toLocaleString()} of ${this.maxCredits.toLocaleString()} spent); stopping before "${job.label || job.kind}"`);
    }
    const before = await this.client.balance();
    let ok = true, result, err;
    try { result = await fn(); } catch (e) { ok = false; err = e; }
    let after = null;
    try { after = await this.client.balance(); } catch { /* ledger still records the failure */ }
    const delta = after && before.used != null && after.used != null ? after.used - before.used : null;
    if (delta != null && delta > 0) this.spent += delta;
    const entry = {
      ts: this.now(), runId: this.runId, kind: job.kind, label: job.label, rateKey: rateKey(job),
      model: job.model, resolution: job.resolution, audio: !!job.audio, units: unitsOf(job),
      before: before.used, after: after?.used ?? null, delta, estimate: est.known ? est.credits : null,
      ok, attributable: true, // the guard runs jobs strictly one at a time, so the delta belongs to this job
    };
    appendLedger(entry, this.ledgerPath);
    this.ledger.push(entry);
    if (!ok) throw err;
    if (delta != null && est.known && delta > est.credits * 1.5 + 10) {
      // not fatal: the ledger now knows the real rate. Surface it so the operator sees the estimate was low.
      result = result && typeof result === 'object' ? { ...result, spendWarning: `actual ${delta} credits vs estimate ${est.credits}` } : result;
    }
    return result;
  }
}
