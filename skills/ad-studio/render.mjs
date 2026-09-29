#!/usr/bin/env node
// render.mjs -- validate -> estimate -> (only if committed) generate -> assemble.
//
//   node render.mjs ad.json                                   DRY RUN: validation + spend plan, nothing submitted
//   node render.mjs ad.json --commit --max-credits 20000      spend, capped
//   flags: --allow-unknown-rate  --model veo-3.1-fast-generate-001  --resolution 1080p  --audio  --out dir  --offline  --preview (half-size assembly)
//
// A run whose assets are ALL already cached needs no --commit (nothing to spend); it just re-assembles.
// Nothing is assembled unless claims_check passed for this exact manifest.
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { imageReferenceFromFile, createClient, resolveApiKey, GenerationFailed } from './el-client.mjs';
import { BudgetExceeded, defaultLedgerPath, formatPlan, planSpend, readLedger, SpendGuard } from './credit-guard.mjs';
import { assetPath, cacheRoot, clearPending, getJson, getOrCreate, getPending, hashFile, hashJson, peek, putJson, putPending } from './cache.mjs';
import { loadManifest, validateManifest } from './validate.mjs';
import { needsAiLabel } from './guards.mjs';
import { chunkWords, stripAudioTags, wordTimings } from './captions.mjs';
import { buildAudioMaster, computeTimeline, layoutVoLines, measureLoudness, probe, renderVideo } from './assemble.mjs';
import { parseFlags, spendOptions, SPEND_BOOLS } from './cli.mjs';

export const DEFAULT_VIDEO_MODEL = 'veo-3.1-fast-generate-001';
export const DEFAULT_NEGATIVE = 'on-screen text, captions, subtitles, logos, watermarks, brand names, competitor products';

/** The manifest block for one locale (script, onScreenText, endCard, voice id). */
export function localeBlock(m, locale) {
  if (locale === 'en') return { script: m.script, onScreenText: m.onScreenText || [], endCard: m.endCard, voiceId: m.voice.voice_id };
  const b = m.i18n?.[locale] || {};
  return {
    script: b.script,
    onScreenText: b.onScreenText ?? m.onScreenText ?? [],
    endCard: { ...m.endCard, ...(b.endCard || {}) },
    voiceId: m.voice.voices?.[locale] || m.voice.voice_id,
  };
}

/** Build every generation job the manifest needs. `cached` is decided by peeking the cache; nothing is generated here. */
export function buildJobs(m, { baseDir, cacheDir = cacheRoot(), model = DEFAULT_VIDEO_MODEL, resolution = '1080p', audio = false } = {}) {
  const jobs = [];
  const shotJobs = [];
  for (const shot of m.shots) {
    const sf = shot.start_frame ? resolve(baseDir, shot.start_frame) : null;
    const seconds = shot.duration_secs;
    const aspect = shot.aspect || '9:16';
    const negative = shot.negative_prompt || DEFAULT_NEGATIVE;
    const key = hashJson({ v: 1, kind: 'video', model, resolution, audio, prompt: shot.prompt, negative, seconds, aspect, seed: shot.seed ?? null, enhance: false, startFrame: sf ? hashFile(sf) : null });
    const cached = !!peek(cacheDir, 'video', key, 'mp4');
    const job = {
      kind: 'video', label: `shot ${shot.id} (${seconds}s ${aspect} ${resolution})`, model, resolution, audio, seconds, key,
      cached, shot,
      // a generation id saved from an earlier run means the money is ALREADY spent: resume it, do not submit a new one
      resumed: !cached && !!getPending(cacheDir, 'video', key),
      async run(client) {
        const body = { model_id: model, prompt: shot.prompt, duration_secs: seconds, aspect_ratio: aspect, resolution, generate_audio: audio, negative_prompt: negative, enhance_prompt: false };
        if (Number.isInteger(shot.seed)) body.seed = shot.seed;
        if (sf) body.start_frame = imageReferenceFromFile(sf);
        const r = await getOrCreate(cacheDir, 'video', key, 'mp4', async () => {
          let id = getPending(cacheDir, 'video', key)?.id;
          if (!id) {
            ({ id } = await client.flowsVideoCreate(body));
            putPending(cacheDir, 'video', key, { id, model, resolution, seconds }); // persisted BEFORE waiting
          }
          try {
            const done = await client.flowsVideoWait(id);
            const buf = await client.download(done.content_url);
            clearPending(cacheDir, 'video', key);
            return buf;
          } catch (e) {
            // a FAILED generation is not charged, so the next run may submit a fresh one; anything else (timeout,
            // download error) keeps the id so the next run resumes the same paid generation.
            if (e instanceof GenerationFailed) clearPending(cacheDir, 'video', key);
            throw e;
          }
        }, { model, resolution, prompt: shot.prompt });
        return r.path;
      },
    };
    jobs.push(job); shotJobs.push(job);
  }
  const voJobs = {};
  const ttsModel = m.voice.model || 'eleven_v4';
  for (const locale of m.locales) {
    const b = localeBlock(m, locale);
    voJobs[locale] = b.script.map((text, i) => {
      const key = hashJson({ v: 1, kind: 'tts', voice: b.voiceId, model: ttsModel, text, lang: locale === 'en' ? null : locale, settings: m.voice.settings ?? null });
      const job = {
        kind: 'tts', label: `${locale} VO line ${i + 1} (${text.length} chars)`, model: ttsModel, chars: text.length, key, text, locale, index: i,
        cached: !!peek(cacheDir, 'tts', key, 'mp3') && !!getJson(cacheDir, 'tts', key),
        async run(client) {
          const r = await client.ttsWithTimestamps({ voiceId: b.voiceId, text, modelId: ttsModel, voiceSettings: m.voice.settings, languageCode: locale === 'en' ? undefined : locale });
          putJson(cacheDir, 'tts', key, { alignment: r.alignment, normalizedAlignment: r.normalizedAlignment });
          return (await getOrCreate(cacheDir, 'tts', key, 'mp3', async () => r.audio, { voice: b.voiceId, model: ttsModel, text })).path;
        },
      };
      jobs.push(job);
      return job;
    });
  }
  const mkey = hashJson({ v: 1, kind: 'music', model: 'music_v2_5', prompt: m.music.prompt, seconds: m.music.duration, instrumental: true });
  const musicJob = {
    kind: 'music', label: `music (${m.music.duration}s)`, model: 'music_v2_5', seconds: m.music.duration, key: mkey,
    cached: !!peek(cacheDir, 'music', mkey, 'mp3'),
    async run(client) {
      const r = await getOrCreate(cacheDir, 'music', mkey, 'mp3', () => client.music({ prompt: m.music.prompt, lengthMs: Math.round(m.music.duration * 1000), modelId: 'music_v2_5', forceInstrumental: true }), { prompt: m.music.prompt });
      return r.path;
    },
  };
  jobs.push(musicJob);
  return { jobs, shotJobs, voJobs, musicJob, cacheDir };
}

/** Overlay slots for on-screen text, spread across the main body of the ad. */
export function planOverlays(texts, contentLen) {
  if (!texts.length) return [];
  const span = Math.max(1, contentLen - 1.0);
  const slot = span / texts.length;
  return texts.map((text, i) => ({ text, start: 0.5 + i * slot, end: 0.5 + i * slot + Math.min(3.2, Math.max(1.2, slot - 0.3)) }));
}

async function assembleAll(m, built, { outDir, workDir, cacheDir, log, preset, crf, font, sizeDivisor }) {
  mkdirSync(outDir, { recursive: true });
  const shots = [];
  for (const j of built.shotJobs) {
    const path = assetPath(cacheDir, 'video', j.key, 'mp4');
    const p = await probe(path);
    shots.push({ path, aspect: j.shot.aspect || '9:16', duration: p.duration });
  }
  const musicPath = assetPath(cacheDir, 'music', built.musicJob.key, 'mp3');
  const outputs = [];
  for (const locale of m.locales) {
    const b = localeBlock(m, locale);
    const lineInfos = [];
    for (const j of built.voJobs[locale]) {
      const path = assetPath(cacheDir, 'tts', j.key, 'mp3');
      const dur = (await probe(path)).duration;
      lineInfos.push({ path, durationSec: dur, text: j.text, alignment: getJson(cacheDir, 'tts', j.key)?.alignment ?? null });
    }
    const layout = layoutVoLines(lineInfos.map((l) => l.durationSec));
    const voLines = lineInfos.map((l, i) => ({ ...l, ...layout[i] }));
    const timeline = computeTimeline({ shotDurations: shots.map((s) => s.duration), voLines });
    const wdir = join(workDir, locale);
    const master = await buildAudioMaster({ voLines, musicPath, totalSec: timeline.total, workDir: wdir });
    const captions = voLines.flatMap((l) => chunkWords(stripAudioTags(wordTimings(l.text, l.alignment, l.durationSec))).map((c) => ({ text: c.text, start: c.start + l.startSec, end: c.end + l.startSec })));
    const overlays = planOverlays(b.onScreenText, timeline.contentLen);
    const label = needsAiLabel(m) ? { text: m.disclosures?.label || 'AI-generated' } : null;
    for (const aspect of m.outputs) {
      const outFile = join(outDir, `${m.id}_${locale}_${aspect.replace(':', 'x')}.mp4`);
      await renderVideo({ shots, audioPath: master, timeline, aspect, outFile, workDir: wdir, captions, overlays, endCard: { ...b.endCard, bg: m.endCard.background, fg: m.endCard.textColor, accent: m.endCard.accent }, label, preset, crf, font, sizeDivisor });
      const [pr, ld] = [await probe(outFile), await measureLoudness(outFile)];
      log(`  wrote ${basename(outFile)}  ${pr.width}x${pr.height}  ${pr.duration.toFixed(1)}s  ${ld.integrated.toFixed(1)} LUFS`);
      outputs.push({ file: outFile, locale, aspect, width: pr.width, height: pr.height, duration: pr.duration, lufs: ld.integrated });
    }
  }
  return outputs;
}

/**
 * The whole pipeline. Never spends unless commit + maxCredits (+ allowUnknownRate when a rate is unknown).
 * Returns {ok, dryRun?, stage?, errors?, plan?, outputs?, spent?}.
 */
export async function renderAd(manifest, opts = {}) {
  const {
    baseDir = process.cwd(), outDir = resolve('ad-studio-out', manifest.id || 'ad'), client, callTool, validator = validateManifest,
    offline = false, commit = false, maxCredits, allowUnknownRate = false, model = DEFAULT_VIDEO_MODEL, resolution = '1080p', audio = false,
    cacheDir = cacheRoot(), ledgerPath = defaultLedgerPath(), log = console.log, forbidNewVideo = false, preset = 'medium', crf = 18, font, sizeDivisor = 1, spendGuard,
  } = opts;
  if (audio) return { ok: false, stage: 'options', errors: ['--audio is not supported: Veo audio is NOT mixed into the assembly (the VO and music are), so generate_audio stays false and you never pay for audio that would be discarded'] };

  const v = await validator(manifest, { baseDir, offline, callTool });
  for (const w of v.warnings) log('  warn: ' + w);
  if (!v.ok) { for (const e of v.errors) log('  FAIL: ' + e); return { ok: false, stage: 'validate', errors: v.errors }; }

  const built = buildJobs(manifest, { baseDir, cacheDir, model, resolution, audio });
  if (forbidNewVideo && built.shotJobs.some((j) => !j.cached)) {
    return { ok: false, stage: 'variant-video', errors: ['this run would need NEW video credits (a shot is not cached); variants may only reuse cached shots. Render the base ad first.'] };
  }
  const needsSpend = built.jobs.some((j) => !j.cached);
  const ledger = readLedger(ledgerPath);
  let balance = null;
  if (needsSpend && commit && client) balance = await client.balance();
  // With a shared guard (variants) the cap is ONE budget for the whole run, so this plan sees only what is left of it.
  const planCap = spendGuard ? spendGuard.maxCredits - spendGuard.spent : maxCredits;
  const plan = planSpend({ jobs: built.jobs, commit, maxCredits: planCap, allowUnknownRate, ledger, balanceRemaining: balance?.remaining ?? null });
  log(formatPlan(plan, { maxCredits }));

  let spent = 0;
  if (needsSpend) {
    if (!commit) return { ok: true, dryRun: true, plan };
    if (!v.cleared) return { ok: false, stage: 'gate', errors: ['claims_check must have run and passed before any spend (do not combine --offline with --commit)'], plan };
    if (!plan.proceed) return { ok: false, stage: 'spend-gate', errors: plan.reasons, plan };
    if (!client) return { ok: false, stage: 'client', errors: ['no ElevenLabs client (API key missing)'], plan };
    const guard = spendGuard || new SpendGuard({ client, maxCredits, ledgerPath, runId: `${manifest.id}-${Date.now()}` });
    const spentBefore = guard.spent;
    for (const job of built.jobs) {
      if (job.cached) continue;
      log(`  generating: ${job.label}`);
      try { await guard.run(job, () => job.run(client)); }
      catch (e) {
        if (e instanceof BudgetExceeded) return { ok: false, stage: 'budget', errors: [e.message], spent: guard.spent - spentBefore, plan };
        return { ok: false, stage: 'generate', errors: [`${job.label}: ${e.message}`], spent: guard.spent - spentBefore, plan };
      }
    }
    spent = guard.spent - spentBefore;
    log(`  spent ${spent.toLocaleString()} credits (run total ${guard.spent.toLocaleString()} of cap ${guard.maxCredits.toLocaleString()})`);
  } else if (!v.cleared) {
    return { ok: false, stage: 'gate', errors: ['assets are cached, but this manifest is not cleared (claims_check did not run); refusing to assemble'], plan };
  }

  const outputs = await assembleAll(manifest, built, { outDir, workDir: join(outDir, '.work'), cacheDir, log, preset, crf, font, sizeDivisor });
  const report = { id: manifest.id, renderedAt: new Date().toISOString(), spent, outputs, jobs: built.jobs.map((j) => ({ kind: j.kind, label: j.label, key: j.key, cachedAtPlan: j.cached })) };
  writeFileSync(join(outDir, `${manifest.id}.report.json`), JSON.stringify(report, null, 2));
  return { ok: true, outputs, spent, plan };
}

export async function main(argv) {
  const f = parseFlags(argv, { bool: SPEND_BOOLS });
  const file = f._[0];
  if (!file) { console.error('usage: render.mjs ad.json [--commit --max-credits N] [--allow-unknown-rate] [--out dir] [--offline]'); return 2; }
  const { manifest, baseDir } = loadManifest(file);
  const s = spendOptions(f);
  let client;
  const key = resolveApiKey();
  if (key) client = createClient({ apiKey: key, log: (m) => console.error('  ' + m) });
  if (s.commit && !client) { console.error('ELEVENLABS_API_KEY not found (env, ~/.designer/credentials.env)'); return 2; }
  const r = await renderAd(manifest, {
    baseDir, client, ...s, outDir: f.out ? resolve(f.out) : resolve('ad-studio-out', manifest.id),
    model: f.model || DEFAULT_VIDEO_MODEL, resolution: f.resolution || '1080p', audio: f.audio === true,
    sizeDivisor: f.preview === true ? 2 : 1, // --preview renders 540x960-class files quickly; never use them as final deliverables
  });
  if (!r.ok) { for (const e of r.errors || []) console.error('  REFUSED: ' + e); return 1; }
  console.log(r.dryRun ? 'DRY RUN complete. Nothing was submitted.' : `DONE: ${r.outputs.length} file(s)`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main(process.argv.slice(2)).then((c) => { process.exitCode = c; }, (e) => { console.error(e.message); process.exitCode = 1; });
}
