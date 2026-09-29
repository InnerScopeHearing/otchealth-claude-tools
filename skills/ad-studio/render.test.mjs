// Orchestrator tests: mocked ElevenLabs client (counts every "generation"), mocked claims_check, REAL ffmpeg assembly.
// The point of most tests is to prove what does NOT get spent.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildJobs, localeBlock, planOverlays, renderAd } from './render.mjs';
import { GenerationFailed, GenerationTimeout } from './el-client.mjs';
import { getPending, getJson, putJson } from './cache.mjs';
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
  const c = { video: 0, tts: 0, music: 0, dub: 0, waits: 0, downloads: 0, bodies: [] };
  const hooks = { wait: null, download: null }; // tests can make wait()/download() fail once
  return {
    c, hooks,
    balance: async () => ({ used, limit: 33_100_000, remaining: 33_100_000 - used }),
    // like the real API the charge happens at CREATE time; wait/download are free
    flowsVideoCreate: async (body) => { c.video++; c.bodies.push(body); used += body.duration_secs * videoPerSec; return { id: `gen_${c.video}`, status: 'pending' }; },
    flowsVideoWait: async (id) => { c.waits++; if (hooks.wait) await hooks.wait(id); return { status: 'completed', id, content_url: 'https://cdn.example/x.mp4?sig=1', content_mime_type: 'video/mp4' }; },
    download: async () => { c.downloads++; if (hooks.download) await hooks.download(); return videoBuf; },
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
  assert.match(plan, /DRY RUN/); assert.match(plan, /UNKNOWN \(bounded at/);
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

test('the runtime cap stops the run mid-way when an unknown-rate job blows past its ceiling; finished assets stay cached', async () => {
  const s = setup(); const el = fakeEl({ ttsCost: () => 20_000 });
  // 12,000 clears the planner (8,000 known + ~3,700 of ceilings), but the first real TTS costs 20,000, far over its ceiling
  const r = await renderAd(s.m, opts(s, { client: el, commit: true, maxCredits: 12_000, allowUnknownRate: true }));
  assert.equal(r.ok, false); assert.equal(r.stage, 'budget');
  assert.equal(el.c.video, 2);           // 8000 known, fits
  assert.equal(el.c.tts, 1);             // first TTS costs 20,000 -> cap blown -> nothing else starts
  assert.equal(el.c.music, 0);
  assert.equal(r.spent, 28_000);
  // and the planner alone would have refused a cap below the worst case (known + ceilings)
  const s2 = setup();
  const tight = await renderAd(s2.m, opts(s2, { client: fakeEl(), commit: true, maxCredits: 9000, allowUnknownRate: true }));
  assert.equal(tight.stage, 'spend-gate'); assert.match(tight.errors.join(' '), /worst case/);
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

// ---- B2: one budget across all variants ---------------------------------------------------------
test('B2: --max-credits is ONE budget for the whole variants run, not per variant', async () => {
  const s = setup(); const el = fakeEl();
  const base = await renderAd(s.m, opts(s, { client: el, commit: true, maxCredits: 200_000, allowUnknownRate: true }));
  assert.equal(base.ok, true, JSON.stringify(base.errors));
  const specs = [{ id: 'one', hook: 'Hook number one is here.' }, { id: 'two', hook: 'Hook number two is here.' }]; // 24 chars each
  // counterfactual (the OLD behavior): each variant rendered on its own with cap 40 -> both pass, 48 credits spent in total
  const solo = setup(); const soloEl = fakeEl();
  await renderAd(solo.m, opts(solo, { client: soloEl, commit: true, maxCredits: 200_000, allowUnknownRate: true }));
  const before = soloEl.c.tts;
  for (const sp of specs) {
    const r = await renderAd(deriveVariant(solo.m, sp), opts(solo, { client: soloEl, commit: true, maxCredits: 40, forbidNewVideo: true }));
    assert.equal(r.ok, true, JSON.stringify(r.errors));
  }
  assert.equal(soloEl.c.tts - before, 2, 'per-variant caps let the run spend 2 x 24 = 48 credits under a "cap" of 40');
  // the fix: renderVariants shares one guard, so the second variant sees only what is left of the 40
  const before2 = el.c.tts;
  const res = await renderVariants(s.m, specs, { ...opts(s, { client: el, commit: true, maxCredits: 40 }), outDir: s.outDir });
  assert.equal(res[0].ok, true, JSON.stringify(res[0].errors));
  assert.equal(res[1].ok, false); assert.equal(res[1].stage, 'spend-gate');
  assert.match(res[1].errors.join(' '), /exceeds --max-credits 16/, 'the second variant is planned against the REMAINING 16 credits');
  assert.equal(el.c.tts - before2, 1);
});

test('B2: when the shared cap runs out mid-run, later variants generate nothing', async () => {
  const s = setup(); const el = fakeEl({ ttsCost: () => 500 });
  await renderAd(s.m, opts(s, { client: el, commit: true, maxCredits: 200_000, allowUnknownRate: true }));
  const t0 = el.c.tts;
  const res = await renderVariants(s.m, [{ id: 'a', hook: 'A brand new hook line.' }, { id: 'b', hook: 'Another new hook line.' }, { id: 'c', hook: 'Yet another hook line.' }],
    { ...opts(s, { client: el, commit: true, maxCredits: 600 }), outDir: s.outDir });
  assert.deepEqual(res.map((r) => r.ok), [true, false, false]);
  assert.equal(el.c.tts - t0, 1);
});

// ---- M3: resume a paid generation instead of re-submitting --------------------------------------
test('M3: the generation id is saved BEFORE waiting; a timeout resumes the SAME generation on the next run (no second charge)', async () => {
  const s = setup(); const el = fakeEl();
  el.hooks.wait = async (id) => { if (id === 'gen_1') { el.hooks.wait = null; throw new GenerationTimeout(id, 900000); } };
  const r1 = await renderAd(s.m, opts(s, { client: el, commit: true, maxCredits: 200_000, allowUnknownRate: true }));
  assert.equal(r1.ok, false); assert.equal(r1.stage, 'generate'); assert.match(r1.errors.join(' '), /did not finish/);
  const jobs = buildJobs(s.m, { baseDir: s.dir, cacheDir: s.cacheDir });
  const hero = jobs.shotJobs[0];
  assert.equal(getPending(s.cacheDir, 'video', hero.key).id, 'gen_1', 'saved before waiting');
  assert.equal(hero.resumed, true); assert.equal(el.c.video, 1);
  const lines = [];
  const r2 = await renderAd(s.m, opts(s, { client: el, commit: true, maxCredits: 200_000, allowUnknownRate: true, log: (x) => lines.push(x) }));
  assert.equal(r2.ok, true, JSON.stringify(r2.errors));
  assert.equal(el.c.video, 2, 'hero is NOT re-created (1 create in run 1) and only the second shot is created in run 2');
  assert.equal(el.c.bodies.filter((b) => b.prompt?.includes('Slow push-in')).length, 1);
  assert.match(lines.join('\n'), /resuming an already-paid generation/);
  assert.equal(getPending(s.cacheDir, 'video', hero.key), null, 'pending is cleared once downloaded');
  assert.equal(readLedger(s.ledgerPath).filter((e) => e.label?.startsWith('shot hero')).length, 1, 'the resumed shot is not charged to the cap a second time');
});
test('M3: a failed DOWNLOAD keeps the generation id; a FAILED generation (not charged) clears it so a fresh one may be submitted', async () => {
  const s = setup(); const el = fakeEl();
  el.hooks.download = async () => { el.hooks.download = null; throw new Error('storage 503'); };
  const r1 = await renderAd(s.m, opts(s, { client: el, commit: true, maxCredits: 200_000, allowUnknownRate: true }));
  assert.equal(r1.ok, false);
  const heroKey = buildJobs(s.m, { baseDir: s.dir, cacheDir: s.cacheDir }).shotJobs[0].key;
  assert.equal(getPending(s.cacheDir, 'video', heroKey).id, 'gen_1');
  const r2 = await renderAd(s.m, opts(s, { client: el, commit: true, maxCredits: 200_000, allowUnknownRate: true }));
  assert.equal(r2.ok, true, JSON.stringify(r2.errors));
  assert.equal(el.c.bodies.filter((b) => b.prompt?.includes('Slow push-in')).length, 1, 'download retry did not re-submit');
  // failed generation: pending cleared
  const f = setup(); const el2 = fakeEl();
  el2.hooks.wait = async (id) => { el2.hooks.wait = null; throw new GenerationFailed(id, 'moderated', 'blocked'); };
  const rf = await renderAd(f.m, opts(f, { client: el2, commit: true, maxCredits: 200_000, allowUnknownRate: true }));
  assert.equal(rf.ok, false);
  assert.equal(getPending(f.cacheDir, 'video', buildJobs(f.m, { baseDir: f.dir, cacheDir: f.cacheDir }).shotJobs[0].key), null);
});

// ---- misc hardening ------------------------------------------------------------------------------
test('--audio is rejected: Veo audio is not mixed, so we never pay for it', async () => {
  const s = setup(); const el = fakeEl();
  const r = await renderAd(s.m, opts(s, { client: el, audio: true, commit: true, maxCredits: 1e6, allowUnknownRate: true }));
  assert.equal(r.ok, false); assert.equal(r.stage, 'options'); assert.match(r.errors[0], /NOT mixed/);
  assert.equal(total(el.c), 0);
  const ok = await renderAd(s.m, opts(s, { client: el })); // counterfactual: without --audio the run proceeds to the (dry-run) plan
  assert.equal(ok.dryRun, true);
});
test('TTS mp3 + alignment are written atomically and alignment first: an mp3 in the cache always has its alignment', async () => {
  const s = setup(); const el = fakeEl();
  await renderAd(s.m, opts(s, { client: el, commit: true, maxCredits: 200_000, allowUnknownRate: true }));
  const files = readdirSync(join(s.cacheDir, 'tts'));
  assert.ok(!files.some((f) => f.includes('.tmp-')), 'no temp files left behind');
  for (const f of files.filter((x) => x.endsWith('.mp3'))) assert.ok(files.includes(f.replace('.mp3', '.align.json')));
  // a crash between the two writes (alignment written, mp3 missing) is NOT treated as cached
  const s2 = setup();
  const t = buildJobs(s2.m, { baseDir: s2.dir, cacheDir: s2.cacheDir }).voJobs.en[0];
  putJson(s2.cacheDir, 'tts', t.key, { alignment: null });
  assert.equal(buildJobs(s2.m, { baseDir: s2.dir, cacheDir: s2.cacheDir }).voJobs.en[0].cached, false);
  assert.ok(getJson(s2.cacheDir, 'tts', t.key));
});
test('v4 audio tags like [whispers] are never burned into captions', async () => {
  const { stripAudioTags, wordTimings, chunkWords } = await import('./captions.mjs');
  const text = '[whispers] Meet TReO [laughs softly] today[pause].';
  const words = stripAudioTags(wordTimings(text, null, 3));
  assert.deepEqual(words.map((w) => w.word), ['Meet', 'TReO', 'today.']);
  assert.ok(!chunkWords(words).some((c) => /[\[\]]/.test(c.text)));
  // counterfactual: without stripping the tag words would be captioned
  assert.ok(chunkWords(wordTimings(text, null, 3)).some((c) => /\[/.test(c.text)));
});
test('dub: --max-credits applies to the dub stage too (ceiling 2,000 credits/s of speech)', async () => {
  const s = setup(); const el = fakeEl();
  await renderAd(s.m, opts(s, { client: el, commit: true, maxCredits: 200_000, allowUnknownRate: true }));
  const common = { lang: 'es', client: el, baseDir: s.dir, outDir: join(s.dir, 'dub'), cacheDir: s.cacheDir, ledgerPath: s.ledgerPath, callTool: passAllClaims, log: () => {} };
  const r = await dubVoice(s.m, { ...common, commit: true, maxCredits: 2000, allowUnknownRate: true });
  assert.equal(r.ok, false); assert.match(r.errors.join(' '), /worst case/);
  assert.equal(el.c.dub, 0);
  const ok = await dubVoice(s.m, { ...common, commit: true, maxCredits: 20_000, allowUnknownRate: true });
  assert.equal(ok.ok, true, JSON.stringify(ok.errors)); assert.equal(el.c.dub, 1);
});
