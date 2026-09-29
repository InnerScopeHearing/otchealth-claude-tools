// REAL ffmpeg assembly tests: generated color-bar clips + generated sine tones stand in for Veo shots, VO and music.
// No network, no credits. Skipped (loudly) only if ffmpeg/ffprobe are missing.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { run, buildAudioMaster, computeTimeline, fitFilter, layoutVoLines, measureLoudness, OUTPUT_SIZES, planFit, probe, renderVideo } from './assemble.mjs';
import { buildAss, chunkWords, wordTimings, assTime } from './captions.mjs';
import { makeClip, makeTone, tmp } from './test-helpers.mjs';

let haveFfmpeg = true;
try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); execFileSync('ffprobe', ['-version'], { stdio: 'ignore' }); } catch { haveFfmpeg = false; }
const T = { skip: haveFfmpeg ? false : 'ffmpeg/ffprobe not installed' };

const d = tmp('asm-');
const f = (n) => join(d, n);
let shots, voLines, timeline, master;

before(async () => {
  if (!haveFfmpeg) return;
  makeClip(f('s1.mp4'), { w: 720, h: 1280, secs: 4, src: 'testsrc2' });
  makeClip(f('s2.mp4'), { w: 720, h: 1280, secs: 4, src: 'smptebars' });
  makeClip(f('land.mp4'), { w: 1280, h: 720, secs: 4, src: 'testsrc2' });
  makeTone(f('vo1.wav'), { freq: 440, secs: 2, vol: 0.05 });   // deliberately QUIET so normalization has to do real work
  makeTone(f('vo2.wav'), { freq: 330, secs: 1.5, vol: 0.05 });
  makeTone(f('mus.wav'), { freq: 220, secs: 5, vol: 0.05 });
  shots = [{ path: f('s1.mp4'), aspect: '9:16', duration: 4 }, { path: f('s2.mp4'), aspect: '9:16', duration: 4 }];
  const lay = layoutVoLines([2, 1.5]);
  voLines = [{ path: f('vo1.wav'), ...lay[0] }, { path: f('vo2.wav'), ...lay[1] }];
  timeline = computeTimeline({ shotDurations: [4, 4], voLines });
  master = await buildAudioMaster({ voLines, musicPath: f('mus.wav'), totalSec: timeline.total, workDir: f('work') });
});

test('timeline math: crossfades shorten the body, end card adds 3 s minus one fade, VO can extend the body', T, () => {
  const t = computeTimeline({ shotDurations: [4, 4], voLines: [{ startSec: 0.3, durationSec: 2 }] });
  assert.equal(t.mainLen, 7.75);
  assert.equal(t.total, 7.75 + 3 - 0.25);
  assert.equal(t.cardStart, 7.5);
  assert.equal(t.pad, 0);
  const long = computeTimeline({ shotDurations: [4], voLines: [{ startSec: 0.3, durationSec: 6 }] });
  assert.equal(long.contentLen, 6.8);
  assert.ok(Math.abs(long.pad - 2.8) < 1e-9);
});

test('planFit: same aspect scales, portrait<->landscape flips get a blurred-pad, mild changes crop', T, () => {
  assert.equal(planFit('9:16', '9:16'), 'scale');
  assert.equal(planFit('9:16', '1:1'), 'crop');
  assert.equal(planFit('9:16', '16:9'), 'blurpad');
  assert.equal(planFit('16:9', '9:16'), 'blurpad');
  assert.equal(planFit('16:9', '1:1'), 'crop');
  assert.match(fitFilter('blurpad', 1080, 1920, '0:v', 's0'), /boxblur/);
  assert.match(fitFilter('crop', 1080, 1080, '0:v', 's0'), /crop=1080:1080/);
});

test('audio master is loudness-normalized to -14 LUFS (within 1 LU) and lasts the whole ad', T, async () => {
  const m = await measureLoudness(master);
  assert.ok(Math.abs(m.integrated - -14) <= 1, `master is ${m.integrated} LUFS`);
  assert.ok(m.truePeak <= -1, `true peak ${m.truePeak}`);
  const p = await probe(master);
  assert.ok(Math.abs(p.duration - timeline.total) < 0.1, `audio ${p.duration}s vs ${timeline.total}s`);
});

test('counterfactual: WITHOUT the normalization pass the same mix is nowhere near -14 LUFS', T, async () => {
  const raw = await measureLoudness(join(f('work'), 'premix.wav'));
  assert.ok(Math.abs(raw.integrated - -14) > 5, `premix is ${raw.integrated} LUFS; if this were already ~-14 the test proves nothing`);
});

test('music is ducked under the VO: level during a VO line is lower than the same music in a VO-free stretch', T, async () => {
  // Music is a 150 Hz tone, VO is 1.5-1.8 kHz tones at a realistic speech level (peaks ~0.3). A steep low-pass isolates the music bed.
  makeTone(f('duck_vo1.wav'), { freq: 1500, secs: 2, vol: 0.3 });
  makeTone(f('duck_vo2.wav'), { freq: 1800, secs: 1.5, vol: 0.3 });
  makeTone(f('duck_mus.wav'), { freq: 150, secs: 5, vol: 0.3 });
  const lay = layoutVoLines([2, 1.5]);
  const loud = [{ path: f('duck_vo1.wav'), ...lay[0] }, { path: f('duck_vo2.wav'), ...lay[1] }];
  const master = await buildAudioMaster({ voLines: loud, musicPath: f('duck_mus.wav'), totalSec: timeline.total, workDir: f('work_duck') });
  const meanVolume = async (start, dur) => {
    const { stderr } = await run('ffmpeg', ['-hide_banner', '-nostats', '-ss', String(start), '-t', String(dur), '-i', master, '-af', 'lowpass=f=300,lowpass=f=300,lowpass=f=300,volumedetect', '-f', 'null', '-'], {});
    return parseFloat(stderr.match(/mean_volume: (-?[\d.]+) dB/)[1]);
  };
  const duringVo = await meanVolume(0.8, 1.2);     // vo1 speaks 0.3..2.3
  const afterVo = await meanVolume(5.0, 1.2);      // both lines finished (they end ~4.15)
  assert.ok(afterVo > -80, `the bed must still be playing after the VO ends (got ${afterVo} dB): a sidechain that ends with the VO would silence it`);
  assert.ok(duringVo < afterVo - 3, `music during VO ${duringVo} dB should be at least 3 dB below music alone ${afterVo} dB`);
});

for (const aspect of ['9:16', '1:1', '16:9']) {
  test(`renderVideo ${aspect}: exact resolution, duration matches the timeline, audio present and at -14 LUFS`, T, async () => {
    const out = f(`out_${aspect.replace(':', 'x')}.mp4`);
    await renderVideo({
      shots, audioPath: master, timeline, aspect, outFile: out, workDir: f('work'), preset: 'ultrafast',
      captions: [{ text: 'Hello there friends', start: 0.3, end: 2.0 }],
      overlays: [{ text: 'Simple sound', start: 0.5, end: 3 }],
      endCard: { headline: 'Try it today', cta: 'Learn more', legal: 'Personal sound amplifier, not a hearing aid.' },
      label: { text: 'AI-generated' },
    });
    const p = await probe(out);
    const [W, H] = OUTPUT_SIZES[aspect];
    assert.equal(p.width, W); assert.equal(p.height, H);
    assert.ok(Math.abs(p.duration - timeline.total) < 0.15, `duration ${p.duration} vs ${timeline.total}`);
    assert.equal(p.hasAudio, true);
    const ld = await measureLoudness(out);
    assert.ok(Math.abs(ld.integrated - -14) <= 1.5, `${aspect} is ${ld.integrated} LUFS`);
  });
}

test('captions are actually burned in: the caption band differs from the same render without captions', T, async () => {
  const a = f('cap_on.mp4'), b = f('cap_off.mp4');
  const common = { shots, audioPath: master, timeline, aspect: '9:16', workDir: f('work'), preset: 'ultrafast', endCard: { headline: 'x', cta: 'y', legal: 'z' } };
  await renderVideo({ ...common, outFile: a, captions: [{ text: 'HELLO CAPTION', start: 0.2, end: 3 }] });
  await renderVideo({ ...common, outFile: b, captions: [] });
  const frame = (file, out) => { execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', '1.0', '-i', file, '-frames:v', '1', '-vf', 'crop=1080:400:0:1300,format=gray', '-f', 'rawvideo', out]); return readFileSync(out); };
  const A = frame(a, f('a.raw')), B = frame(b, f('b.raw'));
  let diff = 0; for (let i = 0; i < A.length; i++) diff += Math.abs(A[i] - B[i]);
  assert.ok(diff / A.length > 2, `mean abs pixel diff ${(diff / A.length).toFixed(2)}: captions should visibly change the bottom band`);
});

test('a landscape shot is blur-padded into 9:16 and a VO longer than the shots extends the body (tpad)', T, async () => {
  const lay = layoutVoLines([2, 1.5]);
  const longVo = [{ path: f('vo1.wav'), startSec: 0.3, durationSec: 2 }, { path: f('vo2.wav'), startSec: 6.0, durationSec: 1.5 }];
  const tl = computeTimeline({ shotDurations: [4], voLines: longVo });
  assert.ok(tl.pad > 0);
  const m2 = await buildAudioMaster({ voLines: longVo, musicPath: f('mus.wav'), totalSec: tl.total, workDir: f('work2') });
  const out = f('land_to_portrait.mp4');
  await renderVideo({ shots: [{ path: f('land.mp4'), aspect: '16:9', duration: 4 }], audioPath: m2, timeline: tl, aspect: '9:16', outFile: out, workDir: f('work2'), preset: 'ultrafast', endCard: { headline: 'a', cta: 'b', legal: 'c' } });
  const p = await probe(out);
  assert.equal(p.width, 1080); assert.equal(p.height, 1920);
  assert.ok(Math.abs(p.duration - tl.total) < 0.15);
  void lay;
});

test('captions.mjs: word timings map to alignment characters; chunks are short; ASS is well-formed', () => {
  const text = 'Meet TReO today';
  const al = { characters: [...text], character_start_times_seconds: [...text].map((_, i) => i * 0.1), character_end_times_seconds: [...text].map((_, i) => i * 0.1 + 0.1) };
  const w = wordTimings(text, al, 1.5);
  assert.deepEqual(w.map((x) => x.word), ['Meet', 'TReO', 'today']);
  assert.equal(w[1].start, 0.5);
  const fallback = wordTimings(text, { characters: ['x'], character_start_times_seconds: [0], character_end_times_seconds: [1] }, 3);
  assert.ok(Math.abs(fallback.at(-1).end - 3) < 1e-9);
  const chunks = chunkWords(wordTimings('One two three four five six seven eight nine ten.', null, 5), { maxWords: 4 });
  assert.ok(chunks.length >= 3 && chunks.every((c) => c.text.split(' ').length <= 4));
  assert.equal(assTime(3725.5), '1:02:05.50');
  const ass = buildAss({ width: 1080, height: 1920, captions: [{ start: 0, end: 1, text: 'a {b} c' }], endCard: { start: 5, end: 8, headline: 'H', cta: 'C', legal: 'L' } });
  assert.match(ass, /PlayResX: 1080/); assert.match(ass, /Dialogue: 0,0:00:00.00,0:00:01.00,Caption/); assert.doesNotMatch(ass, /\{b\}/);
});
