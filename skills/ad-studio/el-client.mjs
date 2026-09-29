// el-client.mjs -- small dependency-free ElevenLabs client for ad-studio (fetch only).
//
// Endpoint shapes below were read from the official docs on 2026-09-29; the doc URL sits next to each
// method. Anything NOT confirmed on a docs page is marked UNVERIFIED in a comment.
//
// SAFETY RULES BAKED IN
//  - The API key is sent ONLY to the ElevenLabs API host, never to a signed content URL (downloads use
//    a bare fetch), and never appears in an error message or log line.
//  - Signed URLs are truncated (host + first path chars, query stripped) whenever they are logged.
//  - 429 and 5xx are retried with exponential backoff (Retry-After honored); other 4xx fail at once.
//  - Nothing in this file decides to SPEND. Spending is gated by credit-guard.mjs and render.mjs.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, extname, join } from 'node:path';

export const BASE_URL = 'https://api.elevenlabs.io';

// ---------- small helpers -------------------------------------------------------------------------

/** Truncate a URL for logs: host + first 40 path chars, query and fragment dropped. */
export function shortUrl(u) {
  try {
    const x = new URL(u);
    const p = x.pathname.length > 40 ? x.pathname.slice(0, 40) + '...' : x.pathname;
    return `${x.protocol}//${x.host}${p}`;
  } catch { return String(u).slice(0, 40) + '...'; }
}

/** Remove any occurrence of the key or a signed query string from a string bound for output. */
export function scrub(text, apiKey) {
  let s = String(text ?? '');
  if (apiKey) s = s.split(apiKey).join('[key]');
  s = s.replace(/https?:\/\/[^\s"')]+/g, (m) => shortUrl(m));
  return s.length > 600 ? s.slice(0, 600) + '...' : s;
}

export class ElevenLabsError extends Error {
  constructor(message, { status, code, requestId, body } = {}) {
    super(message);
    this.name = 'ElevenLabsError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.body = body;
  }
}

export class GenerationFailed extends Error {
  constructor(id, reason, message) {
    super(`generation ${id} failed: ${reason}${message ? ' - ' + message : ''}`);
    this.name = 'GenerationFailed';
    this.generationId = id;
    this.failureReason = reason;
  }
}

export class GenerationTimeout extends Error {
  constructor(id, ms) {
    super(`generation ${id} did not finish within ${Math.round(ms / 1000)}s (still running server-side; resume with the same id)`);
    this.name = 'GenerationTimeout';
    this.generationId = id;
  }
}

/** Find the API key: explicit -> env ELEVENLABS_API_KEY -> ~/.designer/credentials.env (KEY=value lines). */
export function resolveApiKey({ env = process.env, home = homedir(), keyFile } = {}) {
  if (keyFile && existsSync(keyFile)) return readFileSync(keyFile, 'utf8').trim();
  if (env.ELEVENLABS_API_KEY) return env.ELEVENLABS_API_KEY.trim();
  const f = join(home, '.designer', 'credentials.env');
  if (existsSync(f)) {
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      const m = line.match(/^\s*ELEVENLABS_API_KEY\s*=\s*(.*)\s*$/);
      if (m) return m[1].replace(/^["']|["']$/g, '').trim();
    }
  }
  return null;
}

const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.heic': 'image/heic', '.heif': 'image/heif' };
export const MAX_INLINE_BYTES = 25 * 1024 * 1024; // docs: "Up to 25MB decoded"

/** Build an inline_base64 ImageReference from a local file. Docs: flows/video/create.md "ImageReference". */
export function imageReferenceFromFile(path) {
  const mime = MIME[extname(path).toLowerCase()];
  if (!mime) throw new Error(`unsupported image type for ${basename(path)} (jpeg/png/webp/heic/heif only)`);
  const size = statSync(path).size;
  if (size > MAX_INLINE_BYTES) throw new Error(`${basename(path)} is ${size} bytes; inline references are limited to 25 MB (upload as an asset instead)`);
  return { type: 'inline_base64', content_base64: readFileSync(path).toString('base64'), mime_type: mime };
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- client --------------------------------------------------------------------------------

export function createClient({
  apiKey,
  fetchImpl = globalThis.fetch,
  sleep = defaultSleep,
  baseUrl = BASE_URL,
  maxRetries = 4,
  requestTimeoutMs = 120_000,
  log = () => {},
} = {}) {
  if (!apiKey) throw new Error('ElevenLabs API key missing (set ELEVENLABS_API_KEY or ~/.designer/credentials.env)');

  async function raw(method, path, { json, form, query, accept } = {}) {
    let url = baseUrl + path;
    if (query) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) qs.set(k, String(v));
      const s = qs.toString();
      if (s) url += (url.includes('?') ? '&' : '?') + s;
    }
    const headers = { 'xi-api-key': apiKey };
    let body;
    if (json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
    else if (form) body = form; // fetch sets the multipart boundary itself
    if (accept) headers.Accept = accept;

    let attempt = 0;
    for (;;) {
      let res;
      try {
        res = await fetchImpl(url, { method, headers, body, signal: AbortSignal.timeout(requestTimeoutMs) });
      } catch (e) {
        if (attempt < maxRetries) { attempt++; await sleep(backoffMs(attempt)); continue; }
        throw new ElevenLabsError(`network error on ${method} ${path}: ${scrub(e.message, apiKey)}`);
      }
      if ((res.status === 429 || res.status >= 500) && attempt < maxRetries) {
        attempt++;
        const ra = Number(res.headers?.get?.('retry-after'));
        const wait = Number.isFinite(ra) && ra > 0 ? ra * 1000 : backoffMs(attempt);
        log(`retry ${attempt}/${maxRetries} after HTTP ${res.status} on ${method} ${path} (${Math.round(wait)}ms)`);
        await sleep(wait);
        continue;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        let parsed; try { parsed = JSON.parse(text); } catch { /* not json */ }
        const detail = parsed?.detail ?? parsed;
        const code = detail?.code ?? detail?.status ?? undefined;
        const msg = typeof detail === 'string' ? detail : (detail?.message ?? text);
        throw new ElevenLabsError(`HTTP ${res.status} on ${method} ${path}: ${scrub(msg, apiKey)}`, {
          status: res.status, code, requestId: detail?.request_id, body: scrub(text, apiKey),
        });
      }
      return res;
    }
  }
  function backoffMs(attempt) { return Math.min(30_000, 500 * 2 ** (attempt - 1)); }

  const jsonReq = async (method, path, opts) => (await raw(method, path, opts)).json();

  const client = {
    raw,

    // ---- account (read-only) ------------------------------------------------------------------
    /** GET /v1/user/subscription -> {tier, character_count, character_limit, ...}. Docs: user/subscription/get.md */
    subscription: () => jsonReq('GET', '/v1/user/subscription'),
    /** Credits used and remaining, from the subscription record. character_count is the credit counter. */
    async balance() {
      const s = await client.subscription();
      const used = Number(s.character_count), limit = Number(s.character_limit);
      return { used, limit, remaining: Number.isFinite(limit) && Number.isFinite(used) ? limit - used : null, tier: s.tier, raw: s };
    },
    models: () => jsonReq('GET', '/v1/models'),
    voices: () => jsonReq('GET', '/v1/voices'),

    // ---- Flows video/image (async) ------------------------------------------------------------
    /** POST /v1/flows/video -> {id, status:'pending'}. Docs: api-reference/flows/video/create.md.
     *  body = {model_id, prompt, duration_secs, aspect_ratio, resolution, generate_audio, start_frame?, ...}.
     *  References are {type:'inline_base64'|'asset'|'generation', ...}. NOTE (docs): `images` cannot be combined
     *  with start_frame/end_frame and requires duration 8. */
    flowsVideoCreate: (body) => jsonReq('POST', '/v1/flows/video', { json: body }),
    /** GET /v1/flows/video/{id}. status pending|generating|completed(content_url)|failed(failure_reason,error_message). */
    flowsVideoGet: (id) => jsonReq('GET', `/v1/flows/video/${encodeURIComponent(id)}`),
    /** Poll until terminal. Video floor is 10 s per the docs; backs off x1.5 up to maxIntervalMs; hard ceiling timeoutMs. */
    flowsVideoWait: (id, opts) => waitForGeneration(client.flowsVideoGet, id, { minIntervalMs: 10_000, maxIntervalMs: 60_000, timeoutMs: 15 * 60_000, sleep, log, ...opts, floorMs: 10_000 }),
    /** POST /v1/flows/image (UNVERIFIED body: same pattern as video with model_id/prompt/aspect_ratio; ref cookbook). */
    flowsImageCreate: (body) => jsonReq('POST', '/v1/flows/image', { json: body }),
    flowsImageGet: (id) => jsonReq('GET', `/v1/flows/image/${encodeURIComponent(id)}`),
    /** Images: docs floor is 2 s. */
    flowsImageWait: (id, opts) => waitForGeneration(client.flowsImageGet, id, { minIntervalMs: 2_000, maxIntervalMs: 20_000, timeoutMs: 5 * 60_000, sleep, log, ...opts, floorMs: 2_000 }),

    /** Download signed content. Deliberately WITHOUT the xi-api-key header (the URL is pre-authorized, and the
     *  key must never be sent to a storage host). Returns a Buffer. */
    async download(contentUrl) {
      let attempt = 0;
      for (;;) {
        const res = await fetchImpl(contentUrl, { signal: AbortSignal.timeout(requestTimeoutMs * 2) });
        if ((res.status === 429 || res.status >= 500) && attempt < maxRetries) { attempt++; await sleep(backoffMs(attempt)); continue; }
        if (!res.ok) throw new ElevenLabsError(`download failed HTTP ${res.status} from ${shortUrl(contentUrl)}`, { status: res.status });
        return Buffer.from(await res.arrayBuffer());
      }
    },
    /** Create + wait + download in one call. Returns {id, buffer, mime}. */
    async flowsVideoRun(body, waitOpts) {
      const { id } = await client.flowsVideoCreate(body);
      const done = await client.flowsVideoWait(id, waitOpts);
      return { id, buffer: await client.download(done.content_url), mime: done.content_mime_type };
    },

    // ---- assets -------------------------------------------------------------------------------
    /** POST /v1/assets multipart. Docs: eleven-api/guides/how-to/image-and-video/references.md (SDK: assets.create({asset, name})).
     *  UNVERIFIED: the exact multipart field names (`asset`, `name`) are inferred from the SDK signature. Prefer inline refs. */
    async assetsCreate(path, name) {
      const form = new FormData();
      form.set('asset', new Blob([readFileSync(path)]), name || basename(path));
      form.set('name', name || basename(path));
      return jsonReq('POST', '/v1/assets', { form });
    },

    // ---- speech / music / sfx -----------------------------------------------------------------
    /** POST /v1/text-to-speech/{voice}/with-timestamps -> {audio: Buffer, alignment, normalized_alignment}.
     *  Docs: api-reference/text-to-speech/convert-with-timestamps.md. eleven_v4 has no Style/Speed sliders, so
     *  voice_settings is only sent when the caller supplies it. */
    async ttsWithTimestamps({ voiceId, text, modelId = 'eleven_v4', voiceSettings, outputFormat = 'mp3_44100_128', languageCode, previousText, nextText, seed }) {
      if (!voiceId) throw new Error('voiceId required');
      const body = { text, model_id: modelId };
      if (voiceSettings) body.voice_settings = voiceSettings;
      if (languageCode) body.language_code = languageCode;
      if (previousText) body.previous_text = previousText;
      if (nextText) body.next_text = nextText;
      if (Number.isInteger(seed)) body.seed = seed;
      const j = await jsonReq('POST', `/v1/text-to-speech/${encodeURIComponent(voiceId)}/with-timestamps`, { json: body, query: { output_format: outputFormat } });
      return { audio: Buffer.from(j.audio_base64, 'base64'), alignment: j.alignment ?? null, normalizedAlignment: j.normalized_alignment ?? null };
    },
    /** POST /v1/music. Docs: api-reference/music/compose.md. Fields: prompt, music_length_ms (3000..600000),
     *  model_id (music_v1|music_v2|music_v2_5), force_instrumental. (The old `music_instrumental` is not in the schema.) */
    async music({ prompt, lengthMs, modelId = 'music_v2_5', forceInstrumental = true, outputFormat = 'mp3_44100_128' }) {
      const body = { prompt, model_id: modelId, force_instrumental: forceInstrumental };
      if (lengthMs) body.music_length_ms = lengthMs;
      const res = await raw('POST', '/v1/music', { json: body, query: { output_format: outputFormat }, accept: 'audio/mpeg' });
      return Buffer.from(await res.arrayBuffer());
    },
    /** POST /v1/sound-generation. Docs: api-reference/text-to-sound-effects/convert.md. duration_seconds 0.5..30. */
    async sfx({ text, durationSeconds, promptInfluence, loop, modelId = 'eleven_text_to_sound_v2' }) {
      const body = { text, model_id: modelId };
      if (durationSeconds != null) body.duration_seconds = durationSeconds;
      if (promptInfluence != null) body.prompt_influence = promptInfluence;
      if (loop) body.loop = true;
      const res = await raw('POST', '/v1/sound-generation', { json: body, accept: 'audio/mpeg' });
      return Buffer.from(await res.arrayBuffer());
    },

    // ---- dubbing v2 (project based) -----------------------------------------------------------
    /** POST /v1/dubbing/project multipart (file XOR source_url). Docs: api-reference/dubbing/create-project.md.
     *  Charges one language up front. Pass targetLanguage to queue the first language in the same call. */
    async dubbingCreateProject({ filePath, sourceUrl, sourceLanguage, reference, targetLanguage, keyterms }) {
      const form = new FormData();
      if (filePath) form.set('file', new Blob([readFileSync(filePath)]), basename(filePath));
      if (sourceUrl) form.set('source_url', sourceUrl);
      if (sourceLanguage) form.set('source_language', sourceLanguage);
      if (reference) form.set('reference', reference);
      if (targetLanguage) form.set('target_language', targetLanguage);
      for (const k of keyterms || []) form.append('keyterms', k);
      return jsonReq('POST', '/v1/dubbing/project', { form });
    },
    dubbingGetProject: (id) => jsonReq('GET', `/v1/dubbing/project/${encodeURIComponent(id)}`),
    /** POST /v1/dubbing/project/{id}/language {target_language, voice_settings?}. Billed per generation. */
    dubbingAddLanguage: (projectId, { targetLanguage, voiceSettings }) => jsonReq('POST', `/v1/dubbing/project/${encodeURIComponent(projectId)}/language`, { json: { target_language: targetLanguage, ...(voiceSettings ? { voice_settings: voiceSettings } : {}) } }),
    dubbingGetLanguage: (projectId, languageId) => jsonReq('GET', `/v1/dubbing/project/${encodeURIComponent(projectId)}/language/${encodeURIComponent(languageId)}`),
    /** Wait for project ready, then a language completed. Output is `outputs.lossless_audio` (a FLAC, signed URL ~1 h);
     *  the docs list no video output, so dubbing is an AUDIO stage in ad-studio. */
    async dubbingRun({ filePath, sourceUrl, sourceLanguage = 'en', targetLanguage, reference, pollMs = 5_000, timeoutMs = 20 * 60_000, now = Date.now }) {
      const start = now();
      const project = await client.dubbingCreateProject({ filePath, sourceUrl, sourceLanguage, reference });
      let p = project;
      while (p.status !== 'ready') {
        if (p.status === 'failed') throw new Error(`dubbing project failed: ${scrub(p.error?.error, apiKey)}`);
        if (now() - start > timeoutMs) throw new GenerationTimeout(project.project_id, timeoutMs);
        await sleep(pollMs);
        p = await client.dubbingGetProject(project.project_id);
      }
      let lang = await client.dubbingAddLanguage(project.project_id, { targetLanguage });
      while (lang.status !== 'completed') {
        if (lang.status === 'failed') throw new Error(`dubbing language failed: ${scrub(lang.error?.error, apiKey)}`);
        if (now() - start > timeoutMs) throw new GenerationTimeout(lang.language_id, timeoutMs);
        await sleep(pollMs);
        lang = await client.dubbingGetLanguage(project.project_id, lang.language_id);
      }
      const url = lang.outputs?.lossless_audio;
      if (!url) throw new Error('dubbing completed but no outputs.lossless_audio URL was returned');
      return { projectId: project.project_id, languageId: lang.language_id, buffer: await client.download(url), format: 'flac' };
    },
  };
  return client;
}

/** Shared poll loop. `getFn(id)` returns {status,...}. Interval never drops below floorMs (docs polling guidance). */
export async function waitForGeneration(getFn, id, { minIntervalMs, maxIntervalMs, timeoutMs, floorMs, sleep = defaultSleep, now = Date.now, log = () => {} }) {
  const start = now();
  let interval = Math.max(floorMs, minIntervalMs);
  for (;;) {
    const r = await getFn(id);
    if (r.status === 'completed') return r;
    if (r.status === 'failed') throw new GenerationFailed(id, r.failure_reason, r.error_message);
    if (r.status !== 'pending' && r.status !== 'generating') throw new ElevenLabsError(`unexpected generation status "${r.status}" for ${id}`);
    if (now() - start + interval > timeoutMs) throw new GenerationTimeout(id, timeoutMs);
    log(`generation ${id} ${r.status}; next poll in ${Math.round(interval / 1000)}s`);
    await sleep(interval);
    interval = Math.min(maxIntervalMs, Math.round(interval * 1.5));
  }
}
