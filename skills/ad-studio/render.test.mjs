// Orchestrator tests: mocked ElevenLabs client (counts every "generation"), mocked claims_check, REAL ffmpeg assembly.
// The point of most tests is to prove what does NOT get spent.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildJobs, localeBlock, planOverlays, renderAd } from './render.mjs';
import { deriveVariant, renderVariants } from './variants.mjs';
import { dubVoice } from './dub.mjs';
import { readLedger } from './credit-guard.mjs';
import { probe } from './assemble.mjs';
import { goodManifest, makeClip, makeTone, passAllClaims, tmp } from './test-helpers.mjs';

let videoBuf, toneBuf;
before(() => {
  const d = tmp('fx-');
  makeClip(join(d, 'v.mp4'), { w: 720, h: 1280, secs: 4 });
  makeTone(join(d, 't.wav'), { freq: 440, secs: 1.5, vol: 0.3 });
  makeTone(join(d, 'm.wav'), { freq: 220, secs: 12, vol: 0.3 });
  videoBuf = readFileSync(join(d, 'v.mp4'));
  toneBuf = readFileSync(join(d, 't.wav'));
  globalThis.__musicBuf = readFileSync(join(d, 'm.wav'));
});

/** Fake ElevenLabs client. Every generation increments a counter and the fake balance, like the real thing. */
function fakeEl({ ttsCost = (t) => t.length, videoPerSec = 1000, musicCost = 600 } = {}) {
  let used = 5000;
  const c = { video: 0, tts: 0, music: 0, dub: 0, bodies: [] };
  return {
    c,
    balance: async () => ({ used, limit: 33_100_000, remaining: 33_100_000 - used }),
    flowsVideoRun: async (body) => { c.video++; c.bodies.push(body); used += body.duration_secs * videoPerSec; return { id: 'gen', buffer: videoBuf, mime: 'video/mp4' }; },
    ttsWithTimestamps: async ({ text, voiceId, languageCode }) => {
      c.tts++; c.bodies.push({ tts: text, voiceId, languageCode }); used += ttsCost(text);
      const chars = [...text];
      return { audio: toneBuf, alignment: { characters: chars, character_start_times_seconds: chars.map((_, i) => (i / chars.length) * 1.4), character_end_times_seconds: chars.map((_, i) => ((i + 1) / chars.length) * 1.4) }, normalizedAlignment: null };
    },
    music: async () => { c.music++; used += musicCost; return globalThis.__musicBuf; },
    dubbingRun: async ({ targetLanguage }) => { c.dub++; used += 900; return { buffer: Buffer.from('FLAC'), format: 'flac', projectId: 'p', languageId: targetLanguage }; },
  };
}

function setup() {
  const dir = tmp('ren-');
  const m = structuredClone(goodManifest(dir));
  return { dir, m, cacheDir: join(dir, 'cache'), ledgerPath: join(dir, 'ledger.jsonl'), outDir: join(dir, 'out'), quiet: () => {} };
}
const opts = (s, o = {}) => ({ baseDir: s.dir, cacheDir: s.cacheDir, ledgerPath: s.ledgerPath, outDir: s.outDir, callTool: passAllClaims, log: () => {}, preset: 'ultrafast', sizeDivisor: 4, ...o });
const total = (c) => c.video + c.tts + c.music + c.dub;

test('DRY RUN is the default: nothing generated, nothing written, plan shows UNKNOWN rates', async () => {
  const s = setup(); const el = fakeEl(); const lines = [];
  const r = await renderAd(s.m, opts(s, { client: el, log: (x) => lines.push(x) }));
  assert.equal(r.ok, true); assert.equal(r.dryRun, true);
  assert.equal(total(el.c), 0);
  assert.equal(existsSync(s.outDir), false);
  assert.equal(existsSync(s.ledgerPath), false);
  const plan = lines.join('\n');
  assert.match(plan, /DRY RUN/); assert.match(plan, /UNKNOWN credits/);
  assert.match(plan, /shot hero.*4,?000 credits/);
});

test('counterfactual: the SAME manifest with --commit + a workable cap really does call the generators', async () => {
  const s = setup(); const el = fakeEl();
  const r = await renderAd(s.m, opts(s, { client: el, commit: true, maxCredits: 100_000, allowUnknownRate: true }));
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(el.c.video, 2); assert.equal(el.c.tts, 2); assert.equal(el.c.music, 1);
});

test('--commit with a cap below the known video estimate is refused BEFORE anything is submitted', async () => {
  const s = setup(); const el = fakeEl();
  const r = await renderAd(s.m, opts(s, { client: el, commit: true, maxCredits: 5000, allowUnknownRate: true }));
  assert.equal(r.ok, false); assert.equal(r.stage, 'spend-gate');
  assert.match(r.errors.join(' '), /exceeds --max-credits/);
  assert.equal(total(el.c), 0);
});

test('--commit without --allow-unknown-rate is refused while TTS/music rates are unknown', async () => {
  const s = setup(); const el = fakeEl();
  const r = await renderAd(s.m, opts(s, { client: el, commit: true, maxCredits: 1_000_000 }));
  assert.equal(r.ok, false); assert.match(r.errors.join(' '), /UNKNOWN rate/);
  assert.equal(total(el.c), 0);
});

test('--commit without --max-credits is refused', async () => {
  const s = setup(); const el = fakeEl();
  const r = await renderAd(s.m, opts(s, { client: el, commit: true, allowUnknownRate: true }));
  assert.equal(r.ok, false); assert.match(r.errors.join(' '), /max-credits/);
  assert.equal(total(el.c), 0);
});

test('an --offline (claims NOT run) manifest can never spend, even with --commit', async () => {
  const s = setup(); const el = fakeEl();
  const r = await renderAd(s.m, opts(s, { client: el, offline: true, commit: true, maxCredits: 1e6, allowUnknownRate: true }));
  assert.equal(r.ok, false); assert.equal(r.stage, 'gate');
  assert.equal(total(el.c), 0);
});

test('a claims BLOCK stops the run at validation: zero spend, no plan', async () => {
  const s = setup(); const el = fakeEl();
  const r = await renderAd(s.m, opts(s, { client: el, commit: true, maxCredits: 1e6, allowUnknownRate: true, callTool: async () => ({ result: { structuredContent: { result: { verdict: 'block' } } } }) }));
  assert.equal(r.ok, false); assert.equal(r.stage, 'validate');
  assert.equal(total(el.c), 0);
});

test('full run: every requested output exists at the right size; ledger learns rates; second run re-pays NOTHING', async () => {
  const s = setup(); s.m.outputs = ['9:16', '1:1', '16:9'];
  const el = fakeEl();
  const r = await renderAd(s.m, opts(s, { client: el, commit: true, maxCredits: 200_000, allowUnknownRate: true }));
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.outputs.length, 3);
  const sizes = Object.fromEntries(r.outputs.map((o) => [o.aspect, `${o.width}x${o.height}`]));
  assert.deepEqual(sizes, { '9:16': '270x480', '1:1': '270x270', '16:9': '480x270' }); // sizeDivisor 4 in tests; full sizes are asserted in assemble.test.mjs
  for (const o of r.outputs) assert.ok(Math.abs(o.lufs - -14) <= 1.5, `${o.aspect} ${o.lufs} LUFS`);
  assert.ok(existsSync(join(s.outDir, 'test-ad-01.report.json')));
  // ledger: 5 jobs, deltas attributed
  const led = readLedger(s.ledgerPath);
  assert.equal(led.length, 5);
  assert.deepEqual(led.filter((e) => e.kind === 'video').map((e) => e.delta), [4000, 4000]);
  assert.equal(r.spent, 8000 + 'Meet TReO, a personal sound amplifier.'.length + 'Learn more at the link below.'.length + 600);
  // second run: everything cached, no --commit needed, zero generations
  const before2 = total(el.c);
  const one = structuredClone(s.m); one.outputs = ['9:16']; // outputs do not affect cache keys; keep the re-runs quick
  const r2 = await renderAd(one, opts(s, { client: el }));
  assert.equal(r2.ok, true); assert.equal(r2.outputs.length, 1);
  assert.equal(total(el.c), before2, 're-render must never re-pay');
  // third run: change ONE voiceover line -> exactly one TTS job, zero video
  const m3 = structuredClone(one); m3.script[1] = 'Find out more at the link below.';
  const r3 = await renderAd(m3, opts(s, { client: el, commit: true, maxCredits: 1000 }));
  assert.equal(r3.ok, true, JSON.stringify(r3.errors)); // tts rate is now LEARNED from the ledger, so no --allow-unknown-rate needed
  assert.equal(el.c.tts, 3); assert.equal(el.c.video, 2);
});

test('the runtime cap stops the run mid-way when an unknown-rate job blows the budget; finished assets stay cached', async () => {
  const s = setup(); const el = fakeEl({ ttsCost: () => 20_000 });
  const r = await renderAd(s.m, opts(s, { client: el, commit: true, maxCredits: 9000, allowUnknownRate: true }));
  assert.equal(r.ok, false); assert.equal(r.stage, 'budget');
  assert.equal(el.c.video, 2);           // 8000 known, fits
  assert.equal(el.c.tts, 1);             // first TTS costs 20,000 -> cap blown -> nothing else starts
  assert.equal(el.c.music, 0);
  assert.equal(r.spent, 28_000);
  assert.ok(readdirSync(join(s.cacheDir, 'video')).some((f) => f.endsWith('.mp4')), 'paid-for video stays cached for the resume');
});

test('cache keys: stable for the same inputs; change when the prompt, seconds, or the start-frame FILE content changes', () => {
  const s = setup();
  const k = (m) => buildJobs(m, { baseDir: s.dir, cacheDir: s.cacheDir }).shotJobs.map((j) => j.key);
  const base = k(s.m);
  assert.deepEqual(k(structuredClone(s.m)), base);
  const p = structuredClone(s.m); p.shots[0].prompt += ' warmer';
  assert.notEqual(k(p)[0], base[0]); assert.equal(k(p)[1], base[1]);
  const secs = structuredClone(s.m); secs.shots[1].duration_secs = 6;
  assert.notEqual(k(secs)[1], base[1]);
  writeFileSync(join(s.dir, 'assets', 'hero.jpg'), Buffer.concat([readFileSync(join(s.dir, 'assets', 'hero.jpg')), Buffer.from('x')]));
  assert.notEqual(k(s.m)[0], base[0], 'a new product photo must re-render that shot');
  assert.equal(k(s.m)[1], base[1]);
});

test('the Veo request body: model, silent by default, 1080p, inline start_frame from the real photo, enhance_prompt off, brand-safe negative prompt', async () => {
  const s = setup(); const el = fakeEl();
  await renderAd(s.m, opts(s, { client: el, commit: true, maxCredits: 100_000, allowUnknownRate: true }));
  const hero = el.c.bodies.find((b) => b.prompt?.includes('Slow push-in'));
  assert.equal(hero.model_id, 'veo-3.1-fast-generate-001');
  assert.equal(hero.generate_audio, false); assert.equal(hero.resolution, '1080p'); assert.equal(hero.aspect_ratio, '9:16'); assert.equal(hero.duration_secs, 4);
  assert.equal(hero.enhance_prompt, false);
  assert.equal(hero.start_frame.type, 'inline_base64'); assert.equal(hero.start_frame.mime_type, 'image/jpeg');
  assert.match(hero.negative_prompt, /logos/);
  const room = el.c.bodies.find((b) => b.prompt?.includes('sunlit kitchen'));
  assert.equal('start_frame' in room, false);
});

test('locales: en + es both render, es uses the translated script with language_code=es, and es text was claims-checked', async () => {
  const s = setup(); s.m.locales = ['en', 'es'];
  s.m.i18n = { es: { script: ['Conozca TReO, un amplificador de sonido personal.', 'Más información en el enlace de abajo.'], onScreenText: ['Conozca TReO'], endCard: { cta: 'Más información', legal: 'Amplificador de sonido personal, no es un audífono.' } } };
  const el = fakeEl(); const checked = [];
  const r = await renderAd(s.m, opts(s, { client: el, commit: true, maxCredits: 500_000, allowUnknownRate: true, callTool: async (n, a) => { checked.push(a.text); return passAllClaims(); } }));
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.deepEqual(r.outputs.map((o) => o.locale).sort(), ['en', 'es']);
  assert.ok(checked.includes('Conozca TReO, un amplificador de sonido personal.'));
  const esCalls = el.c.bodies.filter((b) => b.tts && b.languageCode === 'es');
  assert.equal(esCalls.length, 2);
  assert.equal(localeBlock(s.m, 'es').endCard.headline, 'TReO', 'es inherits the headline and overrides cta/legal');
});

// ---- variants ----------------------------------------------------------------------------------
test('deriveVariant: swaps hook / CTA / end card / outputs, never touches shots or music', () => {
  const s = setup(); s.m.locales = ['en']; 
  const v = deriveVariant(s.m, { id: 'b', hook: 'New hook.', cta: 'Shop now', endCard: { headline: 'New headline' }, outputs: ['1:1'] });
  assert.equal(v.id, 'test-ad-01--b'); assert.equal(v.script[0], 'New hook.'); assert.equal(v.script[1], s.m.script[1]);
  assert.equal(v.endCard.cta, 'Shop now'); assert.equal(v.endCard.headline, 'New headline'); assert.equal(v.endCard.legal, s.m.endCard.legal);
  assert.deepEqual(v.outputs, ['1:1']);
  assert.deepEqual(v.shots, s.m.shots); assert.deepEqual(v.music, s.m.music);
  assert.throws(() => deriveVariant(s.m, { id: 'x', scriptOverrides: { 9: 'nope' } }), /out of range/);
  assert.throws(() => deriveVariant(s.m, { id: 'x', hookI18n: { es: 'x' } }), /no i18n\.es/);
});

test('variants reuse the cached shots: ZERO video credits, only the changed VO line is generated', async () => {
  const s = setup(); const el = fakeEl();
  const base = await renderAd(s.m, opts(s, { client: el, commit: true, maxCredits: 200_000, allowUnknownRate: true }));
  assert.equal(base.ok, true, JSON.stringify(base.errors));
  const videoAfterBase = el.c.video, ttsAfterBase = el.c.tts, musicAfterBase = el.c.music;
  const res = await renderVariants(s.m, [{ id: 'hook-b', hook: 'Hear the difference, gently.' }, { id: 'cta-b', cta: 'Shop today', outputs: ['1:1'] }],
    { ...opts(s, { client: el, commit: true, maxCredits: 1000 }), outDir: s.outDir });
  assert.deepEqual(res.map((r) => r.ok), [true, true], JSON.stringify(res.map((r) => r.errors)));
  assert.equal(el.c.video, videoAfterBase, 'variants must spend zero video credits');
  assert.equal(el.c.music, musicAfterBase);
  assert.equal(el.c.tts, ttsAfterBase + 1, 'only the new hook line is synthesized; the CTA-only variant needs no VO at all');
  assert.ok(existsSync(join(s.outDir, 'test-ad-01--hook-b', 'test-ad-01--hook-b_en_9x16.mp4')));
  assert.ok(existsSync(join(s.outDir, 'test-ad-01--cta-b', 'test-ad-01--cta-b_en_1x1.mp4')));
  assert.equal((await probe(res[1].outputs[0].file)).width, 270);
});

test('a variant that would need NEW video is refused (forbidNewVideo): render the base ad first', async () => {
  const s = setup(); const el = fakeEl();
  const res = await renderVariants(s.m, [{ id: 'x', hook: 'A hook.' }], { ...opts(s, { client: el, commit: true, maxCredits: 1e6, allowUnknownRate: true }), outDir: s.outDir });
  assert.equal(res[0].ok, false); assert.equal(res[0].stage, 'variant-video');
  assert.equal(total(el.c), 0);
});

// ---- helpers / dubbing -------------------------------------------------------------------------
test('planOverlays spreads on-screen text across the body without overlap', () => {
  const o = planOverlays(['a', 'b', 'c'], 9);
  assert.equal(o.length, 3);
  for (let i = 1; i < o.length; i++) assert.ok(o[i].start >= o[i - 1].end - 1e-9);
  assert.deepEqual(planOverlays([], 9), []);
});

test('dub stage: dry run by default; commit needs --allow-unknown-rate; output is flagged NOT-REVIEWED', async () => {
  const s = setup(); const el = fakeEl();
  await renderAd(s.m, opts(s, { client: el, commit: true, maxCredits: 200_000, allowUnknownRate: true }));
  const common = { lang: 'es', client: el, baseDir: s.dir, outDir: join(s.dir, 'dub'), cacheDir: s.cacheDir, ledgerPath: s.ledgerPath, callTool: passAllClaims, log: () => {} };
  const dry = await dubVoice(s.m, common);
  assert.equal(dry.dryRun, true); assert.equal(el.c.dub, 0);
  const refused = await dubVoice(s.m, { ...common, commit: true, maxCredits: 10_000 });
  assert.equal(refused.ok, false); assert.match(refused.errors.join(' '), /UNKNOWN rate/); assert.equal(el.c.dub, 0);
  const ok = await dubVoice(s.m, { ...common, commit: true, maxCredits: 10_000, allowUnknownRate: true });
  assert.equal(ok.ok, true, JSON.stringify(ok.errors)); assert.equal(el.c.dub, 1);
  assert.ok(existsSync(ok.file)); assert.ok(existsSync(ok.file + '.NOT-REVIEWED.txt'));
});

test('dub stage requires the English VO to be cached first', async () => {
  const s = setup(); const el = fakeEl();
  const r = await dubVoice(s.m, { lang: 'es', client: el, baseDir: s.dir, outDir: join(s.dir, 'dub'), cacheDir: s.cacheDir, ledgerPath: s.ledgerPath, callTool: passAllClaims, log: () => {} });
  assert.equal(r.ok, false); assert.equal(r.stage, 'prereq');
});
