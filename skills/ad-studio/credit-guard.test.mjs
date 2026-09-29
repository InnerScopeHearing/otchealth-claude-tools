import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendLedger, BudgetExceeded, estimateJob, formatPlan, learnedRates, lookupRate, planSpend, rateKey, readLedger, SpendGuard } from './credit-guard.mjs';
import { tmp } from './test-helpers.mjs';

const veo = (seconds, over = {}) => ({ kind: 'video', model: 'veo-3.1-fast-generate-001', resolution: '1080p', audio: false, seconds, label: `veo ${seconds}s`, ...over });
const tts = (chars) => ({ kind: 'tts', model: 'eleven_v4', chars, label: `tts ${chars}` });

test('known rate: veo fast 1080p silent = 1000 credits/s (measured), scaled by seconds', () => {
  assert.equal(estimateJob(veo(4)).credits, 4000);
  assert.equal(estimateJob(veo(8)).credits, 8000);
});

test('any other model/resolution/audio combination is UNKNOWN (never guessed)', () => {
  for (const j of [veo(4, { resolution: '720p' }), veo(4, { audio: true }), veo(4, { model: 'veo-3.1-generate-001' }), tts(100), { kind: 'music', model: 'music_v2_5', seconds: 20 }, { kind: 'dubbing', seconds: 30 }]) {
    const e = estimateJob(j);
    assert.equal(e.known, false, rateKey(j));
    assert.equal(e.credits, null);
  }
});

test('sfx uses the documented 40 credits/s, but only when a duration is given', () => {
  assert.equal(estimateJob({ kind: 'sfx', seconds: 2 }).credits, 80);
  assert.equal(estimateJob({ kind: 'sfx' }).known, false);
});

test('cached jobs cost zero', () => {
  assert.equal(estimateJob({ ...veo(8), cached: true }).credits, 0);
});

test('DRY RUN is the default: no commit => proceed=false even when everything is known and cheap', () => {
  const p = planSpend({ jobs: [veo(4)], maxCredits: 1e9 });
  assert.equal(p.mode, 'dry-run');
  assert.equal(p.proceed, false);
  assert.match(formatPlan(p), /DRY RUN/);
});

test('--commit without --max-credits is refused', () => {
  const p = planSpend({ jobs: [veo(4)], commit: true });
  assert.equal(p.proceed, false);
  assert.match(p.reasons.join(' '), /max-credits/);
});

test('cap abort: known estimate above the cap refuses; at the cap it proceeds', () => {
  assert.equal(planSpend({ jobs: [veo(8)], commit: true, maxCredits: 5000 }).proceed, false);
  assert.match(planSpend({ jobs: [veo(8)], commit: true, maxCredits: 5000 }).reasons[0], /exceeds --max-credits/);
  assert.equal(planSpend({ jobs: [veo(8)], commit: true, maxCredits: 8000 }).proceed, true);
});

test('unknown-rate abort: commit + cap is NOT enough while any rate is unknown', () => {
  const p = planSpend({ jobs: [veo(4), tts(200)], commit: true, maxCredits: 50_000 });
  assert.equal(p.proceed, false);
  assert.match(p.reasons.join(' '), /UNKNOWN rate/);
  assert.equal(p.knownTotal, 4000);
  const ok = planSpend({ jobs: [veo(4), tts(200)], commit: true, maxCredits: 50_000, allowUnknownRate: true });
  assert.equal(ok.proceed, true);
});

test('counterfactual: an all-unknown plan sums to 0 known credits, so a naive "total <= cap" check would have passed', () => {
  const p = planSpend({ jobs: [tts(500), { kind: 'music', model: 'music_v2_5', seconds: 20 }], commit: true, maxCredits: 1 });
  assert.equal(p.knownTotal, 0);           // a cap-only gate would say 0 <= 1 and spend
  assert.equal(p.proceed, false);          // the unknown-rate gate is what stops it
});

test('balance guard: known estimate above remaining balance is refused', () => {
  const p = planSpend({ jobs: [veo(8)], commit: true, maxCredits: 100_000, balanceRemaining: 5000 });
  assert.equal(p.proceed, false);
  assert.match(p.reasons.join(' '), /remaining balance/);
});

test('ledger learning: an unknown rate becomes known after TWO real samples, and it is used', () => {
  const ledger = [{ rateKey: 'tts|eleven_v4', units: 200, delta: 200, ok: true, attributable: true }, { rateKey: 'tts|eleven_v4', units: 100, delta: 150, ok: true, attributable: true }];
  const r = lookupRate(tts(1000), ledger);
  assert.equal(r.perUnit, 1.25);          // median of 1.0 and 1.5
  assert.equal(estimateJob(tts(1000), ledger).credits, 1250);
  assert.equal(planSpend({ jobs: [tts(1000)], commit: true, maxCredits: 2000, ledger }).proceed, true);
});

test('ledger learning ignores failed, zero-delta, and non-attributable samples', () => {
  const l = learnedRates([
    { rateKey: 'k', units: 10, delta: 0, ok: true }, { rateKey: 'k', units: 10, delta: 100, ok: false },
    { rateKey: 'k', units: 10, delta: 100, ok: true, attributable: false }, { rateKey: 'k', units: 10, delta: 50, ok: true, attributable: true },
  ]);
  assert.equal(l.k.samples, 1);
  assert.equal(l.k.perUnit, 5);
});

test('learned rates need >= 2 samples and may only RAISE a known rate, never lower it', () => {
  const key = rateKey(veo(4));
  const sample = (perUnit) => ({ rateKey: key, units: 4, delta: 4 * perUnit, ok: true, attributable: true });
  assert.equal(estimateJob(veo(4), [sample(1500)]).credits, 4000, 'one sample is ignored');
  assert.equal(estimateJob(veo(4), [sample(1500), sample(1500)]).credits, 6000, 'two higher samples raise it');
  assert.equal(estimateJob(veo(4), [sample(100), sample(100), sample(100)]).credits, 4000, 'cheap samples must NEVER lower a known rate');
  // and for a rate with no table entry, one sample is not enough to make it "known"
  const one = [{ rateKey: 'tts|eleven_v4', units: 100, delta: 100, ok: true, attributable: true }];
  assert.equal(estimateJob(tts(500), one).known, false);
});

test('unknown-rate jobs carry a conservative CEILING; commit needs known + ceilings under the cap', () => {
  assert.equal(estimateJob(tts(100)).ceiling, 200);
  assert.equal(estimateJob({ kind: 'music', model: 'music_v2_5', seconds: 20 }).ceiling, 6000);
  assert.equal(estimateJob({ kind: 'dubbing', seconds: 30 }).ceiling, 60000);
  assert.equal(estimateJob({ kind: 'sfx' }).ceiling, 1200);
  assert.equal(estimateJob(veo(4)).ceiling, 4000, 'a known job is bounded by its estimate');
  // 1,000 chars of TTS: known total is 0, so the OLD gate (known <= cap) would have let a cap of 500 through
  const p = planSpend({ jobs: [tts(1000)], commit: true, maxCredits: 500, allowUnknownRate: true });
  assert.equal(p.knownTotal, 0);
  assert.equal(p.proceed, false);
  assert.match(p.reasons.join(' '), /worst case 2,000/);
  assert.equal(planSpend({ jobs: [tts(1000)], commit: true, maxCredits: 2000, allowUnknownRate: true }).proceed, true);
});

test('readLedger skips corrupt lines and a missing file', () => {
  const d = tmp(); const f = join(d, 'l.jsonl');
  assert.deepEqual(readLedger(f), []);
  writeFileSync(f, '{"a":1}\nnot json\n\n{"b":2}\n');
  assert.deepEqual(readLedger(f), [{ a: 1 }, { b: 2 }]);
});

// ---- runtime guard --------------------------------------------------------------------------------
function fakeBalanceClient(costs) {
  // each generation calls bump(n) to add credits; balance() reads the counter
  let used = 1000;
  return { bump: (n) => { used += n; }, balance: async () => ({ used, limit: 1_000_000, remaining: 1_000_000 - used }), get used() { return used; } };
}

test('SpendGuard.run records balance before/after to the JSONL ledger and returns the result', async () => {
  const d = tmp(); const ledgerPath = join(d, 'ledger.jsonl');
  const client = fakeBalanceClient();
  const g = new SpendGuard({ client, maxCredits: 10_000, ledgerPath, runId: 'r1', now: () => 'T' });
  const out = await g.run(veo(4), async () => { client.bump(4000); return 'clip'; });
  assert.equal(out, 'clip');
  assert.equal(g.spent, 4000);
  const [e] = readLedger(ledgerPath);
  assert.deepEqual({ before: e.before, after: e.after, delta: e.delta, units: e.units, rateKey: e.rateKey, ok: e.ok, runId: e.runId }, { before: 1000, after: 5000, delta: 4000, units: 4, rateKey: 'video|veo-3.1-fast-generate-001|1080p|silent', ok: true, runId: 'r1' });
});

test('SpendGuard refuses to START a job whose known estimate would cross the cap', async () => {
  const d = tmp(); const client = fakeBalanceClient(); let ran = 0;
  const g = new SpendGuard({ client, maxCredits: 9000, ledgerPath: join(d, 'l.jsonl') });
  await g.run(veo(8), async () => { ran++; client.bump(8000); });
  await assert.rejects(() => g.run(veo(4), async () => { ran++; }), BudgetExceeded);
  assert.equal(ran, 1, 'the second job must not have been submitted');
});

test('SpendGuard bounds UNKNOWN-rate jobs by actual spend: stops once the cap is reached', async () => {
  const d = tmp(); const client = fakeBalanceClient(); let ran = 0;
  const g = new SpendGuard({ client, maxCredits: 3000, ledgerPath: join(d, 'l.jsonl') });
  await g.run(tts(100), async () => { ran++; client.bump(5000); }); // unknown estimate, real cost 5000
  await assert.rejects(() => g.run(tts(100), async () => { ran++; }), BudgetExceeded); // spent 5000 >= cap 3000
  assert.equal(ran, 1);
});

test('SpendGuard records failures (ok:false) and rethrows; cached jobs bypass the guard', async () => {
  const d = tmp(); const ledgerPath = join(d, 'l.jsonl'); const client = fakeBalanceClient();
  const g = new SpendGuard({ client, maxCredits: 10_000, ledgerPath });
  await assert.rejects(() => g.run(veo(4), async () => { throw new Error('boom'); }), /boom/);
  assert.equal(readLedger(ledgerPath)[0].ok, false);
  const before = readLedger(ledgerPath).length;
  assert.equal(await g.run({ ...veo(4), cached: true }, async () => 'hit'), 'hit');
  assert.equal(readLedger(ledgerPath).length, before);
});

test('SpendGuard requires a positive cap', () => {
  assert.throws(() => new SpendGuard({ client: {}, maxCredits: 0, ledgerPath: '/dev/null' }), /positive maxCredits/);
  assert.throws(() => new SpendGuard({ client: {}, maxCredits: NaN, ledgerPath: '/dev/null' }), /positive maxCredits/);
});

test('appendLedger creates parent directories', () => {
  const d = tmp(); const f = join(d, 'a', 'b', 'l.jsonl');
  appendLedger({ x: 1 }, f);
  assert.ok(existsSync(f));
  assert.equal(readFileSync(f, 'utf8').trim(), '{"x":1}');
  appendFileSync(f, '');
});

// ---- M2: missing balance deltas ------------------------------------------------------------------
test('a ZERO or NULL balance delta on a job that ran is charged at its estimate/ceiling, not treated as free', async () => {
  const d = tmp(); let ran = 0;
  const frozen = { balance: async () => ({ used: 1000, limit: 1e6, remaining: 999000 }) }; // balance never moves
  const g = new SpendGuard({ client: frozen, maxCredits: 10_000, ledgerPath: join(d, 'l.jsonl') });
  const r = await g.run(veo(4), async () => { ran++; return { path: 'x' }; });
  assert.equal(g.spent, 4000, 'a known job with no delta is charged its estimate');
  assert.match(r.spendWarning, /balance delta unavailable/);
  await g.run(tts(100), async () => { ran++; });          // unknown rate: charged its ceiling (200)
  assert.equal(g.spent, 4200);
  await assert.rejects(() => g.run(veo(8), async () => { ran++; }), BudgetExceeded); // 4200 + 8000 > 10000
  assert.equal(ran, 2);
  const led = readLedger(join(d, 'l.jsonl'));
  assert.equal(led[0].deltaReliable, false); assert.equal(led[0].attributable, false); assert.equal(led[0].charged, 4000);
  // and such an entry can never teach the estimator a rate
  assert.deepEqual(learnedRates(led), {});
});

test('counterfactual for M2: a job WITH a real delta is charged the delta, so the estimate fallback is what protects the frozen case', async () => {
  const d = tmp(); const client = fakeBalanceClient();
  const g = new SpendGuard({ client, maxCredits: 10_000, ledgerPath: join(d, 'l.jsonl') });
  await g.run(veo(4), async () => { client.bump(1234); });
  assert.equal(g.spent, 1234);
});

test('a negative delta is unreliable too', async () => {
  const d = tmp(); let used = 5000;
  const client = { balance: async () => ({ used, limit: 1e6, remaining: 1e6 - used }) };
  const g = new SpendGuard({ client, maxCredits: 10_000, ledgerPath: join(d, 'l.jsonl') });
  await g.run(veo(4), async () => { used -= 300; });
  assert.equal(g.spent, 4000);
});

test('a definite failure with no balance movement is not charged; an outcome-unknown failure is charged the bound', async () => {
  const d = tmp(); const frozen = { balance: async () => ({ used: 1000, limit: 1e6, remaining: 999000 }) };
  const g = new SpendGuard({ client: frozen, maxCredits: 100_000, ledgerPath: join(d, 'l.jsonl') });
  await assert.rejects(() => g.run(veo(4), async () => { throw new Error('400 bad request'); }), /400/);
  assert.equal(g.spent, 0);
  await assert.rejects(() => g.run(veo(4), async () => { throw Object.assign(new Error('timeout'), { outcomeUnknown: true }); }), /timeout/);
  assert.equal(g.spent, 4000, 'the request may have been accepted and charged');
});

test('the runtime guard refuses to START an unknown-rate job whose CEILING would cross the cap', async () => {
  const d = tmp(); let ran = 0;
  const g = new SpendGuard({ client: fakeBalanceClient(), maxCredits: 150, ledgerPath: join(d, 'l.jsonl') });
  await assert.rejects(() => g.run(tts(100), async () => { ran++; }), /ceiling \(unknown rate\)/);
  assert.equal(ran, 0);
});

test('resumed (already-paid) jobs bypass the guard and cost nothing to plan', async () => {
  const d = tmp(); const client = fakeBalanceClient();
  assert.equal(estimateJob({ ...veo(8), resumed: true }).credits, 0);
  const g = new SpendGuard({ client, maxCredits: 1, ledgerPath: join(d, 'l.jsonl') });
  assert.equal(await g.run({ ...veo(8), resumed: true }, async () => 'ok'), 'ok');
  assert.equal(g.spent, 0);
});

test('uncapped guard (legacy single-shot scripts) still logs before/after to the ledger', async () => {
  const d = tmp(); const client = fakeBalanceClient(); const f = join(d, 'l.jsonl');
  const g = new SpendGuard({ client, uncapped: true, ledgerPath: f });
  await g.run(tts(50), async () => { client.bump(50); });
  assert.equal(readLedger(f)[0].delta, 50);
  assert.throws(() => new SpendGuard({ client, maxCredits: 0, ledgerPath: f }), /positive maxCredits/);
});

test('SpendGuard never mangles a non-plain result (a Buffer of audio comes back byte-identical even when the delta is missing)', async () => {
  const d = tmp(); const frozen = { balance: async () => ({ used: 1, limit: 1e6, remaining: 1e6 }) };
  const g = new SpendGuard({ client: frozen, maxCredits: 10_000, ledgerPath: join(d, 'l.jsonl') });
  const buf = Buffer.from('AUDIO');
  const out = await g.run(tts(5), async () => buf);
  assert.ok(Buffer.isBuffer(out)); assert.equal(out.toString(), 'AUDIO');
  assert.match(g.warnings[0], /balance delta unavailable/);
});
