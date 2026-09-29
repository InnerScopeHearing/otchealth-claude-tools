// End-to-end tests for the designer scripts that call ElevenLabs (gen-voiceover, gen-music, gen-sfx, healthcheck).
// Each script runs as a real child process with a preloaded mock fetch: no network, no credits.
// They pin the CURRENT ElevenLabs API shapes (docs URLs in each script) so a regression to the retired fields fails here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PRELOAD = join(HERE, 'test-support', 'mock-fetch-preload.mjs');
const DEFAULT_BRAND = join(HERE, '..', 'brand-profiles', 'default.json');

const made = [];
process.on('exit', () => { for (const d of made) rmSync(d, { recursive: true, force: true }); });
function run(script, args) {
  const cwd = mkdtempSync(join(tmpdir(), 'dz-'));
  made.push(cwd);
  mkdirSync(join(cwd, '.designer'));
  copyFileSync(DEFAULT_BRAND, join(cwd, '.designer', 'brand.json'));
  const log = join(cwd, 'requests.jsonl');
  const r = spawnSync(process.execPath, ['--import', PRELOAD, join(HERE, script), ...args], {
    cwd, encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: cwd, ELEVENLABS_API_KEY: 'test-key-not-real', MOCK_LOG: log, OPENAI_USAGE_DISABLE: '1' },
  });
  const reqs = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  return { ...r, cwd, reqs };
}

const posts = (r) => r.reqs.filter((q) => q.method === 'POST');
const ledgerOf = (r) => { const f = join(r.cwd, '.cache', 'ad-studio', 'credit-ledger.jsonl'); return existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []; };

test('gen-voiceover: default model is eleven_v4 and voice_settings has ONLY stability + similarity_boost', () => {
  const r = run('gen-voiceover.mjs', ['--text', 'Hello there.', '--voice-id', 'VOICE1', '--output', 'vo.mp3']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(posts(r).length, 1);
  const q = posts(r)[0];
  assert.equal(q.url, 'https://api.elevenlabs.io/v1/text-to-speech/VOICE1');
  assert.equal(q.sawKey, true);
  assert.equal(q.body.model_id, 'eleven_v4');
  assert.deepEqual(Object.keys(q.body.voice_settings).sort(), ['similarity_boost', 'stability']);
  assert.equal(readFileSync(join(r.cwd, 'vo.mp3'), 'utf8'), 'FAKE-AUDIO-BYTES');
});

test('gen-voiceover: explicit --model eleven_v3 keeps the legacy four-field settings (behavior otherwise unchanged)', () => {
  const r = run('gen-voiceover.mjs', ['--text', 'Hello.', '--model', 'eleven_v3', '--output', 'vo.mp3']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(posts(r)[0].body.model_id, 'eleven_v3');
  assert.equal(posts(r)[0].body.voice_settings.style, 0.3);
  assert.equal(posts(r)[0].body.voice_settings.use_speaker_boost, true);
});

test('gen-voiceover: text over the model limit is refused before any request; --dry-run makes no request', () => {
  const big = run('gen-voiceover.mjs', ['--text', 'a'.repeat(10001)]);
  assert.equal(big.status, 1); assert.match(big.stderr, /exceeds the 10000-character limit for eleven_v4/); assert.equal(big.reqs.length, 0);
  const v3 = run('gen-voiceover.mjs', ['--text', 'a'.repeat(5001), '--model', 'eleven_v3']);
  assert.equal(v3.status, 1); assert.match(v3.stderr, /5000-character limit/);
  const dry = run('gen-voiceover.mjs', ['--text', 'Hi.', '--dry-run']);
  assert.equal(dry.status, 0); assert.equal(dry.reqs.length, 0); assert.match(dry.stdout, /DRY-RUN/);
});

test('gen-music: music_v2_5 + force_instrumental; the retired music_instrumental field is gone', () => {
  const r = run('gen-music.mjs', ['--prompt', 'calm piano', '--duration', '20', '--output', 'm.mp3']);
  assert.equal(r.status, 0, r.stderr);
  const q = posts(r)[0];
  assert.equal(q.url, 'https://api.elevenlabs.io/v1/music');
  assert.deepEqual(q.body, { prompt: 'calm piano', music_length_ms: 20000, model_id: 'music_v2_5', force_instrumental: true });
  assert.equal('music_instrumental' in q.body, false);
});

test('gen-music: --vocal turns force_instrumental off; --model overrides; --dry-run makes no request', () => {
  const v = run('gen-music.mjs', ['--prompt', 'song', '--vocal', '--model', 'music_v2', '--output', 'm.mp3']);
  assert.equal(posts(v)[0].body.force_instrumental, false); assert.equal(posts(v)[0].body.model_id, 'music_v2');
  const dry = run('gen-music.mjs', ['--prompt', 'x', '--dry-run']);
  assert.equal(dry.reqs.length, 0); assert.equal(dry.status, 0);
});

test('gen-sfx: sends the current model id and duration_seconds; --dry-run makes no request', () => {
  const r = run('gen-sfx.mjs', ['--prompt', 'soft chime', '--duration', '1.5', '--influence', '0.4', '--output', 's.mp3']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(posts(r)[0].url, 'https://api.elevenlabs.io/v1/sound-generation');
  assert.deepEqual(posts(r)[0].body, { text: 'soft chime', model_id: 'eleven_text_to_sound_v2', prompt_influence: 0.4, duration_seconds: 1.5 });
  const dry = run('gen-sfx.mjs', ['--prompt', 'x', '--dry-run']);
  assert.equal(dry.reqs.length, 0);
});

test('healthcheck: probes GET /v1/user/subscription and reads tier + credits from the record', () => {
  const r = run('healthcheck.mjs', []);
  const q = r.reqs.find((x) => x.url.includes('elevenlabs'));
  assert.ok(q, r.stderr);
  assert.equal(q.url, 'https://api.elevenlabs.io/v1/user/subscription');
  assert.equal(q.method, 'GET');
  assert.match(r.stdout, /ElevenLabs\s+\S+ PASS\s+tier grant .* 12\/100 chars used/);
});

// ---- gen-video --engine elevenlabs (Flows) -------------------------------------------------------
test('gen-video --engine elevenlabs: DRY RUN by default (no request), prints the plan with the measured rate', () => {
  const r = run('gen-video.mjs', ['--engine', 'elevenlabs', '--prompt', 'a calm kitchen', '--duration', '4', '--ratio', '9:16']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.reqs.length, 0);
  assert.match(r.stdout, /DRY RUN/); assert.match(r.stdout, /4,000 credits/); assert.match(r.stdout, /Nothing was submitted/);
});

test('gen-video --engine elevenlabs: --commit without --max-credits, or a cap below the estimate, is refused with zero requests', () => {
  const a = run('gen-video.mjs', ['--engine', 'elevenlabs', '--prompt', 'x', '--duration', '4', '--commit']);
  assert.equal(a.status, 2); assert.equal(a.reqs.length, 0); assert.match(a.stderr, /max-credits/);
  const b = run('gen-video.mjs', ['--engine', 'elevenlabs', '--prompt', 'x', '--duration', '8', '--commit', '--max-credits', '5000']);
  assert.equal(b.status, 2); assert.equal(b.reqs.length, 0); assert.match(b.stderr, /exceeds --max-credits/);
});

test('gen-video --engine elevenlabs: an unmeasured model/resolution needs --allow-unknown-rate', () => {
  const r = run('gen-video.mjs', ['--engine', 'elevenlabs', '--model', 'veo-3.1-generate-001', '--prompt', 'x', '--duration', '4', '--commit', '--max-credits', '99999']);
  assert.equal(r.status, 2); assert.equal(r.reqs.length, 0); assert.match(r.stderr, /UNKNOWN rate/);
});

test('gen-video --engine elevenlabs: committed run posts the Flows body, polls, downloads WITHOUT the API key, writes the mp4', () => {
  const r = run('gen-video.mjs', ['--engine', 'elevenlabs', '--prompt', 'a calm kitchen', '--duration', '5', '--ratio', '9:16', '--commit', '--max-credits', '20000', '--output', 'clip.mp4']);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const create = r.reqs.find((q) => q.method === 'POST' && q.url.endsWith('/v1/flows/video'));
  assert.ok(create && create.sawKey);
  assert.equal(create.body.model_id, 'veo-3.1-fast-generate-001');
  assert.equal(create.body.duration_secs, 4);              // 5 snaps to the nearest Veo duration (4|6|8); a tie goes to the cheaper, shorter one
  assert.equal(create.body.aspect_ratio, '9:16'); assert.equal(create.body.resolution, '1080p'); assert.equal(create.body.generate_audio, false);
  const dl = r.reqs.find((q) => q.url.startsWith('https://cdn.example.test/'));
  assert.equal(dl.sawKey, false, 'the API key must never be sent to the signed-URL host');
  assert.equal(readFileSync(join(r.cwd, 'clip.mp4'), 'utf8'), 'FAKE-MP4');
  const ledger = join(r.cwd, '.cache', 'ad-studio', 'credit-ledger.jsonl');
  assert.ok(existsSync(ledger), 'the real job is recorded in the credit ledger');
});

test('gen-video: the existing engines are untouched (--engine flag validation still lists them)', () => {
  const r = run('gen-video.mjs', ['--engine', 'bogus', '--prompt', 'x']);
  assert.equal(r.status, 1); assert.match(r.stderr, /'openai', 'veo', 'azure', or 'elevenlabs'/);
});

// ---- M5: ledger logging + --max-credits on the single-shot generators -----------------------------
test('M5 gen-voiceover / gen-music / gen-sfx: every real call writes a credit-ledger entry (spend-by-default is unchanged)', () => {
  const v = run('gen-voiceover.mjs', ['--text', 'Hello there.', '--output', 'vo.mp3']);
  assert.equal(v.status, 0, v.stderr);
  const m = run('gen-music.mjs', ['--prompt', 'calm piano', '--duration', '10', '--output', 'm.mp3']);
  const x = run('gen-sfx.mjs', ['--prompt', 'chime', '--duration', '2', '--output', 's.mp3']);
  assert.deepEqual([v, m, x].map((r) => ledgerOf(r).length), [1, 1, 1]);
  const [e] = ledgerOf(v);
  assert.equal(e.kind, 'tts'); assert.equal(e.units, 'Hello there.'.length); assert.equal(e.ok, true);
  assert.equal(ledgerOf(m)[0].kind, 'music'); assert.equal(ledgerOf(x)[0].kind, 'sfx');
  // the request itself is byte-for-byte the same single POST as before (no cap given, so nothing else changed)
  assert.equal(posts(v).length, 1);
});
test('M5 --max-credits is honored BEFORE any request: a cap below the estimate/ceiling exits 2 with no POST and no ledger entry', () => {
  const text = 'a'.repeat(400);                      // ceiling 800 credits (unmeasured rate)
  const refused = run('gen-voiceover.mjs', ['--text', text, '--max-credits', '500']);
  assert.equal(refused.status, 2); assert.match(refused.stderr, /REFUSED: worst case 800/);
  assert.equal(refused.reqs.length, 0); assert.equal(ledgerOf(refused).length, 0);
  // counterfactual: the same text without a cap (legacy behavior) or with a cap that fits is sent
  assert.equal(posts(run('gen-voiceover.mjs', ['--text', text, '--output', 'v.mp3'])).length, 1);
  assert.equal(posts(run('gen-voiceover.mjs', ['--text', text, '--max-credits', '5000', '--output', 'v.mp3'])).length, 1);
  const music = run('gen-music.mjs', ['--prompt', 'x', '--duration', '60', '--max-credits', '1000']); // ceiling 18,000
  assert.equal(music.status, 2); assert.equal(music.reqs.length, 0);
  const sfx = run('gen-sfx.mjs', ['--prompt', 'x', '--max-credits', '100']); // auto-length ceiling 1,200
  assert.equal(sfx.status, 2); assert.equal(sfx.reqs.length, 0);
  const bad = run('gen-voiceover.mjs', ['--text', 'hi', '--max-credits', 'abc']);
  assert.equal(bad.status, 2); assert.equal(bad.reqs.length, 0);
});
test('M5 gen-video --commit false (and =0, --dry-run true) are NOT commits', () => {
  for (const flags of [['--commit', 'false', '--max-credits', '20000'], ['--commit=0', '--max-credits', '20000'], ['--commit', 'no', '--max-credits', '20000'], ['--commit', 'true', '--dry-run', 'true', '--max-credits', '20000']]) {
    const r = run('gen-video.mjs', ['--engine', 'elevenlabs', '--prompt', 'x', '--duration', '4', ...flags]);
    assert.equal(r.status, 0, flags.join(' ') + r.stderr);
    assert.equal(r.reqs.length, 0, `${flags.join(' ')} must not submit anything`);
    assert.match(r.stdout, /Nothing was submitted/);
  }
  // counterfactual: the same command with a true value really does commit
  const yes = run('gen-video.mjs', ['--engine', 'elevenlabs', '--prompt', 'x', '--duration', '4', '--commit', 'true', '--max-credits', '20000', '--output', 'c.mp4']);
  assert.ok(posts(yes).some((q) => q.url.endsWith('/v1/flows/video')));
});
