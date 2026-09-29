#!/usr/bin/env node
// dub.mjs -- OPTIONAL stage: machine-dub the English VO track into another language with Dubbing v2.
//
//   node dub.mjs ad.json --lang es [--commit --max-credits N --allow-unknown-rate]
//
// WHY THIS IS NOT THE DEFAULT SPANISH PATH: a dub is machine-translated speech whose transcript we never see,
// so it can NOT pass claims_check and has no caption timing. The supported route is a reviewed i18n.<lang>.script
// in the manifest (each line claims-checked, then TTS). This stage only produces an audio file plus a
// NOT-REVIEWED marker for a human/counsel to review; render.mjs never mixes it in automatically.
//
// Dubbing v2 output is AUDIO ONLY (outputs.lossless_audio, FLAC); the docs list no video artifact.
// Credit rate per minute is not published, so the estimate is UNKNOWN until the ledger learns it.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createClient, resolveApiKey } from './el-client.mjs';
import { defaultLedgerPath, formatPlan, planSpend, readLedger, SpendGuard } from './credit-guard.mjs';
import { cacheRoot, assetPath } from './cache.mjs';
import { buildJobs, DEFAULT_VIDEO_MODEL } from './render.mjs';
import { buildVoTrack, layoutVoLines, probe } from './assemble.mjs';
import { loadManifest, validateManifest } from './validate.mjs';
import { parseFlags, spendOptions, SPEND_BOOLS } from './cli.mjs';

export async function dubVoice(manifest, { lang, client, baseDir, outDir, commit = false, maxCredits, allowUnknownRate = false, cacheDir = cacheRoot(), ledgerPath = defaultLedgerPath(), log = console.log, callTool, offline = false, validator = validateManifest }) {
  const v = await validator(manifest, { baseDir, offline, callTool });
  if (!v.ok) return { ok: false, stage: 'validate', errors: v.errors };
  const built = buildJobs(manifest, { baseDir, cacheDir, model: DEFAULT_VIDEO_MODEL });
  const en = built.voJobs.en;
  if (en.some((j) => !j.cached)) return { ok: false, stage: 'prereq', errors: ['the English VO lines are not cached yet; render the base ad first'] };
  const lines = [];
  for (const j of en) lines.push({ path: assetPath(cacheDir, 'tts', j.key, 'mp3'), durationSec: (await probe(assetPath(cacheDir, 'tts', j.key, 'mp3'))).duration });
  const layout = layoutVoLines(lines.map((l) => l.durationSec));
  const voLines = lines.map((l, i) => ({ ...l, ...layout[i] }));
  const total = voLines.at(-1).startSec + voLines.at(-1).durationSec + 0.5;
  const job = { kind: 'dubbing', label: `dub en->${lang} (${total.toFixed(1)}s of speech)`, seconds: total, cached: false };
  const plan = planSpend({ jobs: [job], commit, maxCredits, allowUnknownRate, ledger: readLedger(ledgerPath) });
  log(formatPlan(plan, { maxCredits }));
  if (!commit) return { ok: true, dryRun: true, plan };
  if (!v.cleared) return { ok: false, stage: 'gate', errors: ['claims_check must pass on the English master before dubbing'] };
  if (!plan.proceed) return { ok: false, stage: 'spend-gate', errors: plan.reasons };
  mkdirSync(outDir, { recursive: true });
  const track = await buildVoTrack({ voLines, totalSec: total, workDir: join(outDir, '.work') });
  const guard = new SpendGuard({ client, maxCredits, ledgerPath, runId: `${manifest.id}-dub-${lang}` });
  const res = await guard.run(job, () => client.dubbingRun({ filePath: track, sourceLanguage: 'en', targetLanguage: lang, reference: `${manifest.id}-${lang}` }));
  const out = join(outDir, `${manifest.id}_${lang}_dub.${res.format}`);
  writeFileSync(out, res.buffer);
  writeFileSync(out + '.NOT-REVIEWED.txt', `Machine dub of ${manifest.id} into ${lang}. The translated transcript was NOT claims_check'd and this file must not be published until a reviewed i18n.${lang}.script exists and passes claims_check.\n`);
  return { ok: true, file: out, spent: guard.spent };
}

export async function main(argv) {
  const f = parseFlags(argv, { bool: SPEND_BOOLS });
  if (!f._[0] || !f.lang) { console.error('usage: dub.mjs ad.json --lang es [--commit --max-credits N --allow-unknown-rate]'); return 2; }
  const { manifest, baseDir } = loadManifest(f._[0]);
  const s = spendOptions(f);
  const key = resolveApiKey();
  const client = key ? createClient({ apiKey: key }) : undefined;
  if (s.commit && !client) { console.error('ELEVENLABS_API_KEY not found'); return 2; }
  const r = await dubVoice(manifest, { lang: f.lang, client, baseDir, outDir: resolve(f.out || join('ad-studio-out', manifest.id)), ...s });
  if (!r.ok) { for (const e of r.errors) console.error('REFUSED: ' + e); return 1; }
  console.log(r.dryRun ? 'DRY RUN complete.' : `wrote ${r.file}`);
  return 0;
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main(process.argv.slice(2)).then((c) => { process.exitCode = c; }, (e) => { console.error(e.message); process.exitCode = 1; });
}
