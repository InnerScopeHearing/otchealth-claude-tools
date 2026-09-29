// test-helpers.mjs -- shared fixtures for ad-studio tests (NOT a test file; no network, no credits).
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const made = [];
// every scratch dir is removed when the test process exits (the ffmpeg renders are large)
process.on('exit', () => { for (const d of made) rmSync(d, { recursive: true, force: true }); });
export const tmp = (p = 'ads-') => { const d = mkdtempSync(join(tmpdir(), p)); made.push(d); return d; };

/** Mock fetch: `handlers` is a function (url, init, callIndex) => Response | {status, json?, body?, headers?}. Records calls. */
export function mockFetch(handler) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const i = calls.length;
    calls.push({ url: String(url), init, method: init.method || 'GET', headers: init.headers || {}, body: init.body });
    const r = await handler(String(url), init, i);
    if (r instanceof Response) return r;
    const headers = new Headers(r.headers || {});
    if (r.json !== undefined) { headers.set('content-type', 'application/json'); return new Response(JSON.stringify(r.json), { status: r.status || 200, headers }); }
    return new Response(r.body ?? '', { status: r.status || 200, headers });
  };
  fn.calls = calls;
  return fn;
}

/** A tiny fake clock so poll loops run instantly: sleep() advances `now`. */
export function fakeClock() {
  let t = 0;
  const sleeps = [];
  return { now: () => t, sleep: async (ms) => { sleeps.push(ms); t += ms; }, sleeps };
}

export function ff(args) { execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...args]); }

/** Generate a color-bar / test-pattern clip. */
export function makeClip(path, { w = 720, h = 1280, secs = 4, src = 'testsrc2' } = {}) {
  ff(['-f', 'lavfi', '-i', `${src}=s=${w}x${h}:d=${secs}:r=24`, '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', path]);
}
/** Generate a sine tone (fake VO / music). */
export function makeTone(path, { freq = 440, secs = 2, vol = 0.5 } = {}) {
  ff(['-f', 'lavfi', '-i', `sine=f=${freq}:d=${secs}:sample_rate=44100`, '-af', `volume=${vol}`, path]);
}
/** A real (tiny) jpeg for start_frame fixtures. */
export function makeJpeg(path) {
  ff(['-f', 'lavfi', '-i', 'color=c=gray:s=64x64:d=0.04', '-frames:v', '1', path]);
}

/** A manifest that passes every static guard; tests mutate a clone of it. `dir` receives the fake product photos. */
export function goodManifest(dir) {
  mkdirSync(join(dir, 'assets'), { recursive: true });
  makeJpeg(join(dir, 'assets', 'hero.jpg'));
  makeJpeg(join(dir, 'assets', 'close.jpg'));
  return {
    id: 'test-ad-01', product: 'TReO', productClass: 'PSAP',
    voice: { voice_id: 'VOICE_TEST', model: 'eleven_v4' },
    script: ['Meet TReO, a personal sound amplifier.', 'Learn more at the link below.'],
    onScreenText: ['Meet TReO'],
    shots: [
      { id: 'hero', prompt: 'Slow push-in on the product on a wooden table, soft daylight', duration_secs: 4, aspect: '9:16', showsProduct: true, start_frame: 'assets/hero.jpg' },
      { id: 'room', prompt: 'A sunlit kitchen table with a coffee cup, morning light, no people', duration_secs: 4, aspect: '9:16', showsProduct: false },
    ],
    music: { prompt: 'warm calm acoustic instrumental', duration: 12 },
    endCard: { headline: 'TReO', cta: 'Learn more', legal: 'Personal sound amplifier, not a hearing aid.' },
    outputs: ['9:16'],
    disclosures: { aiGenerated: true, label: 'AI-generated', showLabel: true },
    locales: ['en'],
  };
}

export const passAllClaims = async () => ({ result: { structuredContent: { result: { verdict: 'pass', risk_score: 2, violations: [] } } } });
