#!/usr/bin/env node
// validate.mjs -- every gate an ad manifest must pass BEFORE any credit is spent.
//   node validate.mjs ad.json            full validation including the gateway claims_check gate
//   node validate.mjs ad.json --offline  static guards only (structure, FTC, brand, copy/PHI); claims NOT RUN
// Exit 0 = all gates passed; 1 = at least one error. Lines starting "warn:" are warnings and do not fail.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { GUARDS, publishedTexts } from './guards.mjs';
import { checkClaims, gatewayCaller } from './claims.mjs';

/**
 * @param {object} manifest
 * @param {object} opts { baseDir, offline, callTool, disable:[guardNames] (TEST HOOK ONLY: proves a guard is what stops a bad manifest) }
 * @returns {Promise<{ok:boolean, errors:string[], warnings:string[], claims:object|null}>}
 */
export async function validateManifest(manifest, { baseDir = process.cwd(), offline = false, callTool, disable = [], includeNetImpression = true } = {}) {
  const all = [];
  let structureBroken = false;
  for (const [name, fn] of Object.entries(GUARDS)) {
    if (disable.includes(name)) continue;
    const found = fn(manifest, { baseDir });
    if (name === 'structure' && found.some((x) => !x.startsWith('warn:'))) structureBroken = true;
    all.push(...found);
  }
  let claims = null;
  if (offline) {
    all.push('warn: claims_check NOT RUN (--offline); this manifest is NOT cleared for spend');
  } else if (!disable.includes('claims')) {
    if (structureBroken) {
      all.push('claims_check not run: fix the structure errors first');
    } else {
      const items = publishedTexts(manifest).filter((t) => t.role !== 'label').map(({ id, where, text }) => ({ id, where, text }));
      claims = await checkClaims(items, {
        productClass: manifest.productClass,
        callTool: callTool || gatewayCaller(),
        includeNetImpression,
        context: `Paid social video ad for ${manifest.product}. AI-generated video; not a testimonial.`,
      });
      all.push(...claims.errors);
    }
  }
  const errors = all.filter((x) => !x.startsWith('warn:'));
  const warnings = all.filter((x) => x.startsWith('warn:')).map((x) => x.slice(5).trim());
  const ok = errors.length === 0;
  // `cleared` is what render.mjs requires before ANY spend: every guard passed AND claims_check actually ran and passed.
  return { ok, cleared: ok && claims !== null && claims.ok, errors, warnings, claims, claimsRan: claims !== null };
}

export function loadManifest(path) {
  const abs = resolve(path);
  const manifest = JSON.parse(readFileSync(abs, 'utf8'));
  return { manifest, baseDir: dirname(abs), path: abs };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const argv = process.argv.slice(2);
  const file = argv.find((a) => !a.startsWith('--'));
  if (!file) { console.error('usage: validate.mjs ad.json [--offline]'); process.exit(2); }
  const { manifest, baseDir } = loadManifest(file);
  const r = await validateManifest(manifest, { baseDir, offline: argv.includes('--offline') });
  for (const w of r.warnings) console.log('  warn: ' + w);
  for (const e of r.errors) console.log('  FAIL: ' + e);
  console.log(r.ok ? `VALID (${r.claimsRan ? 'claims_check passed' : 'claims NOT RUN'})` : `INVALID (${r.errors.length} error(s))`);
  process.exit(r.ok ? 0 : 1);
}
