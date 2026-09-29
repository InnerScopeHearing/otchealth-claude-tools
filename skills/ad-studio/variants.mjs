#!/usr/bin/env node
// variants.mjs -- N variants of a rendered ad (different hook / CTA / end card / aspects) at ZERO video credits.
//
// Variants REUSE the base ad's cached shots (same prompts + start frames -> same cache keys) and only run the cheap
// VO lines that changed. A variant that would need a new video generation is refused; render the base ad first.
//
//   node variants.mjs base.json --spec variants.json [--n 3] [--commit --max-credits N --allow-unknown-rate]
//
// variants.json = [{ "id": "hook-b", "hook": "New first line", "cta": "Shop today", "endCard": {"headline": "..."},
//                    "outputs": ["9:16"], "hookI18n": {"es": "Nueva primera linea"}, "scriptOverrides": {"2": "line text"} }]
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createClient, resolveApiKey } from './el-client.mjs';
import { loadManifest } from './validate.mjs';
import { renderAd, DEFAULT_VIDEO_MODEL } from './render.mjs';
import { defaultLedgerPath, SpendGuard } from './credit-guard.mjs';
import { parseFlags, spendOptions, SPEND_BOOLS } from './cli.mjs';

/** Pure: derive a variant manifest. Shots and music are never touched (that is what keeps video cost at zero). */
export function deriveVariant(base, spec) {
  if (!spec?.id || !/^[a-z0-9-_]+$/i.test(spec.id)) throw new Error('variant spec needs an id (letters, digits, dash)');
  const m = JSON.parse(JSON.stringify(base));
  m.id = `${base.id}--${spec.id}`;
  if (spec.hook) m.script[0] = spec.hook;
  for (const [i, t] of Object.entries(spec.scriptOverrides || {})) {
    if (!(Number(i) >= 0 && Number(i) < m.script.length)) throw new Error(`scriptOverrides index ${i} out of range`);
    m.script[Number(i)] = t;
  }
  for (const [loc, t] of Object.entries(spec.hookI18n || {})) {
    if (!m.i18n?.[loc]) throw new Error(`hookI18n for "${loc}" but the base has no i18n.${loc}`);
    m.i18n[loc].script[0] = t;
  }
  m.endCard = { ...m.endCard, ...(spec.endCard || {}), ...(spec.cta ? { cta: spec.cta } : {}) };
  if (spec.outputs) m.outputs = spec.outputs;
  if (spec.onScreenText) m.onScreenText = spec.onScreenText;
  return m;
}

export async function renderVariants(base, specs, opts = {}) {
  const results = [];
  // ONE guard for the whole run: --max-credits is the budget for ALL variants together, not per variant.
  let spendGuard = opts.spendGuard;
  if (!spendGuard && opts.commit && opts.client && Number.isFinite(opts.maxCredits) && opts.maxCredits > 0) {
    spendGuard = new SpendGuard({ client: opts.client, maxCredits: opts.maxCredits, ledgerPath: opts.ledgerPath || defaultLedgerPath(), runId: `${base.id}-variants-${Date.now()}` });
  }
  for (const spec of specs) {
    const m = deriveVariant(base, spec);
    const r = await renderAd(m, { ...opts, spendGuard, forbidNewVideo: true, outDir: resolve(opts.outDir || 'ad-studio-out', m.id) });
    results.push({ id: m.id, ...r });
  }
  return results;
}

export async function main(argv) {
  const f = parseFlags(argv, { bool: SPEND_BOOLS });
  const file = f._[0];
  if (!file || !f.spec) { console.error('usage: variants.mjs base.json --spec variants.json [--n N] [--commit --max-credits N]'); return 2; }
  const { manifest, baseDir } = loadManifest(file);
  let specs = JSON.parse(readFileSync(resolve(f.spec), 'utf8'));
  if (f.n) specs = specs.slice(0, Number(f.n));
  const s = spendOptions(f);
  const key = resolveApiKey();
  const client = key ? createClient({ apiKey: key }) : undefined;
  if (s.commit && !client) { console.error('ELEVENLABS_API_KEY not found'); return 2; }
  const res = await renderVariants(manifest, specs, { baseDir, client, ...s, outDir: f.out, model: f.model || DEFAULT_VIDEO_MODEL, resolution: f.resolution || '1080p', audio: f.audio === true, sizeDivisor: f.preview === true ? 2 : 1 });
  let bad = 0;
  for (const r of res) {
    if (!r.ok) { bad++; console.error(`variant ${r.id}: REFUSED (${(r.errors || []).join('; ')})`); }
    else console.log(`variant ${r.id}: ${r.dryRun ? 'dry run only' : r.outputs.length + ' file(s)'}`);
  }
  return bad ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main(process.argv.slice(2)).then((c) => { process.exitCode = c; }, (e) => { console.error(e.message); process.exitCode = 1; });
}
