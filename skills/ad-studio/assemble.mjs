// assemble.mjs -- ffmpeg assembly: concat shots with crossfades, VO on top, music ducked under VO, burned captions,
// end card, AI-disclosure label, loudness to -14 LUFS, and export for 9:16 / 1:1 / 16:9.
// Pure local work: no network, no credits. Requires ffmpeg + ffprobe (with libass for the `ass` filter).
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildAss } from './captions.mjs';

export const OUTPUT_SIZES = { '9:16': [1080, 1920], '1:1': [1080, 1080], '16:9': [1920, 1080] };
export const FPS = 30;
export const XFADE = 0.25;
export const END_CARD_SECS = 3;

export function run(cmd, args, { cwd } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code === 0) resolve({ stdout: out, stderr: err });
      else reject(new Error(`${cmd} exited ${code}: ${err.split('\n').slice(-12).join('\n')}`));
    });
  });
}

export async function probe(file) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_entries', 'format=duration:stream=codec_type,width,height', file]);
  const j = JSON.parse(stdout);
  const v = (j.streams || []).find((s) => s.codec_type === 'video');
  return { duration: Number(j.format?.duration), width: v?.width, height: v?.height, hasAudio: (j.streams || []).some((s) => s.codec_type === 'audio') };
}

/** Integrated loudness (LUFS) of a file, via loudnorm's measurement pass. */
export async function measureLoudness(file) {
  const { stderr } = await run('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-vn', '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json', '-f', 'null', '-']);
  const j = parseLoudnormJson(stderr);
  return { integrated: Number(j.input_i), truePeak: Number(j.input_tp), lra: Number(j.input_lra), raw: j };
}
export function parseLoudnormJson(stderr) {
  const m = stderr.match(/\{[^{}]*"input_i"[^{}]*\}/s);
  if (!m) throw new Error('could not parse loudnorm output');
  return JSON.parse(m[0]);
}

/** How to fit a shot of aspect `src` into an output of aspect `dst`: 'scale' (same), 'crop' (mild change) or 'blurpad' (portrait<->landscape flip). */
export function planFit(src, dst) {
  if (src === dst) return 'scale';
  const flip = (src === '9:16' && dst === '16:9') || (src === '16:9' && dst === '9:16');
  return flip ? 'blurpad' : 'crop';
}

/** ffmpeg filter fragment turning input label `[in]` into `[out]` at WxH for the given fit. */
export function fitFilter(fit, W, H, inLabel, outLabel) {
  const tail = `fps=${FPS},setsar=1,format=yuv420p`;
  if (fit === 'scale') return `[${inLabel}]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},${tail}[${outLabel}]`;
  // slight upward bias keeps product/face framing when cropping portrait -> square
  if (fit === 'crop') return `[${inLabel}]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}:(iw-ow)/2:(ih-oh)*0.35,${tail}[${outLabel}]`;
  return `[${inLabel}]split[${outLabel}bg][${outLabel}fg];`
    + `[${outLabel}bg]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=40:6[${outLabel}b];`
    + `[${outLabel}fg]scale=${W}:${H}:force_original_aspect_ratio=decrease[${outLabel}f];`
    + `[${outLabel}b][${outLabel}f]overlay=(W-w)/2:(H-h)/2,${tail}[${outLabel}]`;
}

/** Timeline math shared by video + audio so they can never disagree. */
export function computeTimeline({ shotDurations, voLines = [], xfade = XFADE, endCardSecs = END_CARD_SECS }) {
  const n = shotDurations.length;
  const mainLen = shotDurations.reduce((a, b) => a + b, 0) - (n - 1) * xfade;
  const voEnd = voLines.reduce((a, l) => Math.max(a, l.startSec + l.durationSec), 0);
  const contentLen = Math.max(mainLen, voEnd + 0.5);
  const pad = Math.max(0, contentLen - mainLen);
  const total = contentLen + endCardSecs - xfade;
  return { mainLen, voEnd, contentLen, pad, total, cardStart: contentLen - xfade };
}

/** Lay VO lines out sequentially: first at 0.3 s, `gap` seconds between lines. `durations` are the line audio lengths. */
export function layoutVoLines(durations, { start = 0.3, gap = 0.35 } = {}) {
  let t = start;
  return durations.map((d) => { const s = t; t += d + gap; return { startSec: s, durationSec: d }; });
}


/** VO-only track (wav) with each line at its start offset; used as the source for the optional dubbing stage. */
export async function buildVoTrack({ voLines, totalSec, workDir, outFile = 'vo-track.wav', ffmpeg = 'ffmpeg' }) {
  mkdirSync(workDir, { recursive: true });
  const args = ['-y', '-hide_banner', '-nostats'];
  voLines.forEach((l) => args.push('-i', resolve(l.path)));
  const parts = voLines.map((l, i) => { const ms = Math.round(l.startSec * 1000); return `[${i}:a]aresample=48000,aformat=channel_layouts=stereo,adelay=${ms}|${ms}[v${i}]`; });
  parts.push(voLines.length === 1 ? '[v0]anull[vo]' : `${voLines.map((_, i) => `[v${i}]`).join('')}amix=inputs=${voLines.length}:normalize=0:duration=longest[vo]`);
  const out = join(workDir, outFile);
  await run(ffmpeg, [...args, '-filter_complex', `${parts.join(';')};[vo]apad=whole_dur=${totalSec.toFixed(3)},atrim=0:${totalSec.toFixed(3)}[o]`, '-map', '[o]', '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', out]);
  return out;
}

/** Build the mixed, ducked, loudness-normalized audio master (wav). voLines: [{path,startSec,durationSec}]. */
export async function buildAudioMaster({ voLines, musicPath, totalSec, workDir, outFile = 'master.wav', targetLufs = -14, musicGainDb = -16, ffmpeg = 'ffmpeg' }) {
  mkdirSync(workDir, { recursive: true });
  const args = ['-y', '-hide_banner', '-nostats'];
  voLines.forEach((l) => args.push('-i', resolve(l.path)));
  // -stream_loop repeats a short bed until atrim cuts it (the aloop filter silently stops after the first pass on a short input)
  args.push('-stream_loop', '-1', '-i', resolve(musicPath));
  const mi = voLines.length;
  const parts = [];
  voLines.forEach((l, i) => {
    const ms = Math.round(l.startSec * 1000);
    parts.push(`[${i}:a]aresample=48000,aformat=channel_layouts=stereo,adelay=${ms}|${ms}[v${i}]`);
  });
  if (voLines.length === 1) parts.push('[v0]anull[vo]');
  else parts.push(`${voLines.map((_, i) => `[v${i}]`).join('')}amix=inputs=${voLines.length}:normalize=0:duration=longest[vo]`);
  // pad the VO to the full length first: sidechaincompress ends when EITHER input ends, which would silence the bed after the last line
  parts.push(`[vo]apad=whole_dur=${totalSec.toFixed(3)},asplit=2[vomix][vosc]`);
  const fadeOutStart = Math.max(0, totalSec - 1.2).toFixed(3);
  parts.push(`[${mi}:a]aresample=48000,aformat=channel_layouts=stereo,atrim=0:${totalSec.toFixed(3)},asetpts=N/SR/TB,volume=${musicGainDb}dB,afade=t=in:st=0:d=0.5,afade=t=out:st=${fadeOutStart}:d=1.2[mus]`);
  parts.push('[mus][vosc]sidechaincompress=threshold=0.01:ratio=6:attack=20:release=300:makeup=1[duck]');
  parts.push(`[vomix][duck]amix=inputs=2:normalize=0:duration=longest,apad=whole_dur=${totalSec.toFixed(3)},atrim=0:${totalSec.toFixed(3)}[pre]`);
  const pre = join(workDir, 'premix.wav');
  await run(ffmpeg, [...args, '-filter_complex', parts.join(';'), '-map', '[pre]', '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', pre]);
  // two-pass loudnorm for an accurate -14 LUFS on short content
  const { stderr } = await run(ffmpeg, ['-y', '-hide_banner', '-nostats', '-i', pre, '-af', `loudnorm=I=${targetLufs}:TP=-1.5:LRA=11:print_format=json`, '-f', 'null', '-']);
  const m = parseLoudnormJson(stderr);
  const out = join(workDir, outFile);
  const af = `loudnorm=I=${targetLufs}:TP=-1.5:LRA=11:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`;
  await run(ffmpeg, ['-y', '-hide_banner', '-nostats', '-i', pre, '-af', af, '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', out]);
  return out;
}

/**
 * Render one output aspect.
 * @param {object} o
 *   shots: [{path, aspect:'9:16'|'16:9', duration}]  (duration = probed seconds)
 *   audioPath: master wav (from buildAudioMaster)
 *   timeline: from computeTimeline
 *   captions/overlays/endCard/label: see captions.buildAss (times are on the FINAL timeline)
 *   aspect: '9:16'|'1:1'|'16:9'; outFile; workDir
 */
export async function renderVideo({ shots, audioPath, timeline, aspect, outFile, workDir, captions = [], overlays = [], endCard, label = null, font, crf = 18, preset = 'medium', sizeDivisor = 1, ffmpeg = 'ffmpeg' }) {
  mkdirSync(workDir, { recursive: true });
  // sizeDivisor > 1 renders a small PREVIEW (e.g. 2 -> 540x960) for quick review and fast tests; the default is full size.
  const [W, H] = OUTPUT_SIZES[aspect].map((n) => Math.round(n / sizeDivisor / 2) * 2);
  const tag = aspect.replace(':', 'x');
  const assName = `captions_${tag}.ass`;
  const ass = buildAss({
    width: W, height: H, captions, overlays, font,
    endCard: endCard ? { ...endCard, start: timeline.contentLen, end: timeline.total } : null,
    label: label ? { text: label.text, start: 0, end: timeline.total } : null,
  });
  writeFileSync(join(workDir, assName), ass);

  const args = ['-y', '-hide_banner', '-nostats'];
  shots.forEach((s) => args.push('-i', resolve(s.path)));
  args.push('-f', 'lavfi', '-i', `color=c=${(endCard?.bg || '#12263A').replace('#', '0x')}:s=${W}x${H}:d=${END_CARD_SECS}:r=${FPS}`);
  args.push('-i', resolve(audioPath));
  const cardIdx = shots.length, audIdx = shots.length + 1;
  const g = [];
  shots.forEach((s, i) => g.push(fitFilter(planFit(s.aspect, aspect), W, H, `${i}:v`, `s${i}`)));
  let acc = 's0', accLen = shots[0].duration;
  for (let k = 1; k < shots.length; k++) {
    const off = (accLen - XFADE).toFixed(3);
    g.push(`[${acc}][s${k}]xfade=transition=fade:duration=${XFADE}:offset=${off}[x${k}]`);
    acc = `x${k}`; accLen += shots[k].duration - XFADE;
  }
  if (timeline.pad > 0.001) { g.push(`[${acc}]tpad=stop_mode=clone:stop_duration=${timeline.pad.toFixed(3)}[padded]`); acc = 'padded'; }
  g.push(`[${cardIdx}:v]format=yuv420p,setsar=1[card]`);
  g.push(`[${acc}][card]xfade=transition=fade:duration=${XFADE}:offset=${timeline.cardStart.toFixed(3)}[joined]`);
  g.push(`[joined]ass=${assName}[vout]`);
  await run(ffmpeg, [...args, '-filter_complex', g.join(';'), '-map', '[vout]', '-map', `${audIdx}:a`,
    '-t', timeline.total.toFixed(3), '-c:v', 'libx264', '-preset', preset, '-crf', String(crf), '-pix_fmt', 'yuv420p', '-r', String(FPS),
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-movflags', '+faststart', resolve(outFile)], { cwd: workDir });
  return outFile;
}
