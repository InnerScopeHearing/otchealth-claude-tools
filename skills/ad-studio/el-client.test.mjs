import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createClient, ElevenLabsError, GenerationFailed, GenerationTimeout, imageReferenceFromFile, resolveApiKey, scrub, shortUrl } from './el-client.mjs';
import { fakeClock, mockFetch, tmp } from './test-helpers.mjs';

const KEY = 'sk_test_SECRET_KEY_123456';
const mk = (handler, extra = {}) => {
  const fetchImpl = mockFetch(handler);
  const clock = fakeClock();
  return { fetchImpl, clock, client: createClient({ apiKey: KEY, fetchImpl, sleep: clock.sleep, ...extra }) };
};

test('constructor refuses a missing key', () => {
  assert.throws(() => createClient({}), /API key missing/);
});

test('resolveApiKey: env beats file, file is parsed, missing -> null', () => {
  const home = tmp('elhome-');
  assert.equal(resolveApiKey({ env: {}, home }), null);
  assert.equal(resolveApiKey({ env: { ELEVENLABS_API_KEY: ' abc ' }, home }), 'abc');
});

test('resolveApiKey reads ~/.designer/credentials.env', async () => {
  const { mkdirSync } = await import('node:fs');
  const home = tmp('elhome2-');
  mkdirSync(join(home, '.designer'));
  writeFileSync(join(home, '.designer', 'credentials.env'), '# c\nOTHER=1\nELEVENLABS_API_KEY="from_file"\n');
  assert.equal(resolveApiKey({ env: {}, home }), 'from_file');
});

test('flowsVideoCreate: POST /v1/flows/video with JSON body and xi-api-key', async () => {
  const { client, fetchImpl } = mk(() => ({ json: { id: 'gen_1', status: 'pending' } }));
  const body = { model_id: 'veo-3.1-fast-generate-001', prompt: 'x', duration_secs: 4, aspect_ratio: '9:16', resolution: '1080p', generate_audio: false };
  const r = await client.flowsVideoCreate(body);
  assert.deepEqual(r, { id: 'gen_1', status: 'pending' });
  const c = fetchImpl.calls[0];
  assert.equal(c.url, 'https://api.elevenlabs.io/v1/flows/video');
  assert.equal(c.method, 'POST');
  assert.equal(c.headers['xi-api-key'], KEY);
  assert.equal(c.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(c.body), body);
});

test('flowsVideoWait: polls pending -> generating -> completed, never faster than 10 s, backs off', async () => {
  const seq = ['pending', 'generating', 'generating', 'completed'];
  const { client, clock } = mk((url, init, i) => (seq[i] === 'completed'
    ? { json: { status: 'completed', id: 'g', content_url: 'https://cdn.example/x.mp4?sig=abc', content_mime_type: 'video/mp4' } }
    : { json: { status: seq[i], id: 'g' } }));
  const done = await client.flowsVideoWait('g', { now: clock.now });
  assert.equal(done.status, 'completed');
  assert.deepEqual(clock.sleeps, [10000, 15000, 22500]);
  assert.ok(clock.sleeps.every((s) => s >= 10000), 'video polls must never be faster than 10 s');
});

test('flowsVideoWait: a caller cannot poll faster than the 10 s floor (regression guard)', async () => {
  const seq = ['generating', 'completed'];
  const { client, clock } = mk((u, i2, i) => (seq[i] === 'completed' ? { json: { status: 'completed', id: 'g', content_url: 'https://cdn/x', content_mime_type: 'video/mp4' } } : { json: { status: 'generating', id: 'g' } }));
  await client.flowsVideoWait('g', { now: clock.now, minIntervalMs: 100, maxIntervalMs: 200 });
  assert.equal(clock.sleeps[0], 10000);
});

test('flowsVideoWait: failed status throws GenerationFailed with the reason', async () => {
  const { client, clock } = mk(() => ({ json: { status: 'failed', id: 'g', failure_reason: 'moderated', error_message: 'blocked by policy' } }));
  await assert.rejects(() => client.flowsVideoWait('g', { now: clock.now }), (e) => e instanceof GenerationFailed && e.failureReason === 'moderated' && /moderated/.test(e.message));
});

test('flowsVideoWait: hard ceiling throws GenerationTimeout (job id preserved for resume)', async () => {
  const { client, clock } = mk(() => ({ json: { status: 'generating', id: 'g' } }));
  await assert.rejects(() => client.flowsVideoWait('g', { now: clock.now, timeoutMs: 60_000 }), (e) => e instanceof GenerationTimeout && e.generationId === 'g');
  assert.ok(clock.now() <= 60_000, 'must not sleep past the ceiling');
});

test('429 is retried honoring Retry-After; 5xx retried with backoff; then success', async () => {
  let n = 0;
  const { client, clock } = mk(() => {
    n++;
    if (n === 1) return { status: 429, headers: { 'retry-after': '2' }, body: 'slow down' };
    if (n === 2) return { status: 503, body: 'oops' };
    return { json: { tier: 'grant', character_count: 5, character_limit: 100 } };
  });
  const s = await client.subscription();
  assert.equal(s.tier, 'grant');
  assert.equal(n, 3);
  assert.equal(clock.sleeps[0], 2000);
  assert.equal(clock.sleeps[1], 1000); // attempt 2 backoff = 500 * 2^1
});

test('4xx (not 429) is NOT retried and error carries status/code, not the key', async () => {
  const { client, fetchImpl } = mk(() => ({ status: 402, json: { detail: { status: 'payment_required', message: `insufficient credits for key ${KEY}`, request_id: 'r1' } } }));
  await assert.rejects(() => client.flowsVideoCreate({}), (e) => {
    assert.ok(e instanceof ElevenLabsError);
    assert.equal(e.status, 402);
    assert.equal(e.code, 'payment_required');
    assert.ok(!e.message.includes(KEY) && !String(e.body).includes(KEY), 'key must never appear in errors');
    return true;
  });
  assert.equal(fetchImpl.calls.length, 1);
});

test('retries are bounded: gives up after maxRetries', async () => {
  const { client, fetchImpl } = mk(() => ({ status: 500, body: 'boom' }), { maxRetries: 2 });
  await assert.rejects(() => client.subscription(), /HTTP 500/);
  assert.equal(fetchImpl.calls.length, 3);
});

test('download never sends the API key to the signed-URL host and truncates the URL in errors', async () => {
  const signed = 'https://storage.example.com/bucket/very/long/path/name.mp4?X-Signature=TOPSECRETSIG';
  const ok = mk(() => new Response(Buffer.from('VIDEO')));
  const buf = await ok.client.download(signed);
  assert.equal(buf.toString(), 'VIDEO');
  assert.equal(ok.fetchImpl.calls[0].headers['xi-api-key'], undefined);
  assert.deepEqual(ok.fetchImpl.calls[0].init.headers ?? {}, {});
  const bad = mk(() => ({ status: 404, body: 'nope' }));
  await assert.rejects(() => bad.client.download(signed), (e) => { assert.ok(!e.message.includes('TOPSECRETSIG')); return true; });
});

test('scrub/shortUrl strip keys and signed query strings', () => {
  assert.ok(!scrub(`bad ${KEY} at https://a.example/p/q?sig=zzz`, KEY).includes('sig=zzz'));
  assert.ok(!scrub(`bad ${KEY}`, KEY).includes(KEY));
  assert.equal(shortUrl('https://a.example/x?sig=1'), 'https://a.example/x');
});

test('flowsVideoRun: create + wait + download returns the bytes', async () => {
  const seq = [
    { json: { id: 'g9', status: 'pending' } },
    { json: { status: 'completed', id: 'g9', content_url: 'https://cdn.example/g9.mp4?sig=1', content_mime_type: 'video/mp4' } },
    new Response(Buffer.from('MP4BYTES')),
  ];
  const { client, clock, fetchImpl } = mk((u, i2, i) => seq[i]);
  const r = await client.flowsVideoRun({ model_id: 'm', prompt: 'p' }, { now: clock.now });
  assert.equal(r.buffer.toString(), 'MP4BYTES');
  assert.equal(r.id, 'g9');
  assert.equal(fetchImpl.calls[1].url, 'https://api.elevenlabs.io/v1/flows/video/g9');
});

test('ttsWithTimestamps: path, default eleven_v4, no voice_settings unless given, decodes audio + alignment', async () => {
  const al = { characters: ['h', 'i'], character_start_times_seconds: [0, 0.1], character_end_times_seconds: [0.1, 0.2] };
  const { client, fetchImpl } = mk(() => ({ json: { audio_base64: Buffer.from('MP3').toString('base64'), alignment: al, normalized_alignment: al } }));
  const r = await client.ttsWithTimestamps({ voiceId: 'v 1', text: 'hi' });
  assert.equal(r.audio.toString(), 'MP3');
  assert.deepEqual(r.alignment, al);
  const c = fetchImpl.calls[0];
  assert.equal(c.url, 'https://api.elevenlabs.io/v1/text-to-speech/v%201/with-timestamps?output_format=mp3_44100_128');
  const b = JSON.parse(c.body);
  assert.equal(b.model_id, 'eleven_v4');
  assert.equal('voice_settings' in b, false);
  assert.equal('previous_text' in b, false);
});

test('music: model_id music_v2_5 + force_instrumental (and NOT the retired music_instrumental)', async () => {
  const { client, fetchImpl } = mk(() => new Response(Buffer.from('MUSIC')));
  const buf = await client.music({ prompt: 'calm', lengthMs: 20000 });
  assert.equal(buf.toString(), 'MUSIC');
  const b = JSON.parse(fetchImpl.calls[0].body);
  assert.deepEqual(b, { prompt: 'calm', model_id: 'music_v2_5', force_instrumental: true, music_length_ms: 20000 });
  assert.equal('music_instrumental' in b, false);
});

test('sfx: model eleven_text_to_sound_v2 and duration_seconds', async () => {
  const { client, fetchImpl } = mk(() => new Response(Buffer.from('SFX')));
  await client.sfx({ text: 'chime', durationSeconds: 1.5, promptInfluence: 0.4 });
  const c = fetchImpl.calls[0];
  assert.equal(c.url, 'https://api.elevenlabs.io/v1/sound-generation');
  assert.deepEqual(JSON.parse(c.body), { text: 'chime', model_id: 'eleven_text_to_sound_v2', duration_seconds: 1.5, prompt_influence: 0.4 });
});

test('imageReferenceFromFile: inline_base64 with mime; rejects unsupported types', () => {
  const d = tmp();
  const p = join(d, 'a.png'); writeFileSync(p, Buffer.from([1, 2, 3]));
  assert.deepEqual(imageReferenceFromFile(p), { type: 'inline_base64', content_base64: 'AQID', mime_type: 'image/png' });
  const bad = join(d, 'a.gif'); writeFileSync(bad, 'x');
  assert.throws(() => imageReferenceFromFile(bad), /unsupported image type/);
});

test('assetsCreate posts multipart to /v1/assets', async () => {
  const d = tmp(); const p = join(d, 'photo.jpg'); writeFileSync(p, 'JPEG');
  const { client, fetchImpl } = mk(() => ({ json: { asset_id: 'a1', name: 'photo.jpg', mime_type: 'image/jpeg' } }));
  const r = await client.assetsCreate(p);
  assert.equal(r.asset_id, 'a1');
  const c = fetchImpl.calls[0];
  assert.equal(c.url, 'https://api.elevenlabs.io/v1/assets');
  assert.ok(c.body instanceof FormData && c.body.has('asset'));
  assert.equal(c.headers['Content-Type'], undefined, 'multipart boundary must be set by fetch');
});

test('dubbingRun: project queued -> ready, language queued -> completed, downloads the FLAC', async () => {
  const d = tmp(); const src = join(d, 'vo.wav'); writeFileSync(src, 'WAV');
  const seq = [
    { status: 201, json: { project_id: 'p1', status: 'queued' } },
    { json: { project_id: 'p1', status: 'preparing' } },
    { json: { project_id: 'p1', status: 'ready' } },
    { status: 201, json: { language_id: 'l1', project_id: 'p1', status: 'queued' } },
    { json: { language_id: 'l1', status: 'processing' } },
    { json: { language_id: 'l1', status: 'completed', outputs: { lossless_audio: 'https://cdn.example/l1.flac?sig=1' } } },
    new Response(Buffer.from('FLACBYTES')),
  ];
  const { client, fetchImpl, clock } = mk((u, i2, i) => seq[i]);
  const r = await client.dubbingRun({ filePath: src, targetLanguage: 'es', now: clock.now });
  assert.equal(r.buffer.toString(), 'FLACBYTES');
  assert.equal(r.format, 'flac');
  assert.equal(fetchImpl.calls[0].url, 'https://api.elevenlabs.io/v1/dubbing/project');
  assert.equal(fetchImpl.calls[3].url, 'https://api.elevenlabs.io/v1/dubbing/project/p1/language');
  assert.deepEqual(JSON.parse(fetchImpl.calls[3].body), { target_language: 'es' });
});

test('balance(): used/limit/remaining from GET /v1/user/subscription', async () => {
  const { client, fetchImpl } = mk(() => ({ json: { tier: 'grant', character_count: 1000, character_limit: 33_100_000 } }));
  const b = await client.balance();
  assert.equal(b.used, 1000);
  assert.equal(b.remaining, 33_099_000);
  assert.equal(fetchImpl.calls[0].url, 'https://api.elevenlabs.io/v1/user/subscription');
  assert.equal(fetchImpl.calls[0].method, 'GET');
});
