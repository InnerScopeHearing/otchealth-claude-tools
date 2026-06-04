#!/usr/bin/env node
// gen-app-icon-family.mjs — Generate a 1024x1024 master app icon, then
// derive every iOS, Android, and watchOS size from it via sharp. Lands
// the full AppIcon.appiconset + Android adaptive icon foreground/background
// + watchOS icon ready to commit.
//
// Usage:
//   node gen-app-icon-family.mjs --prompt "..." [--output assets/app-icons]
//                                [--master-only] [--dry-run]
//
// Output structure (under brand.output_root/app-icons/):
//   master/icon-1024.png
//   ios/AppIcon-20.png ... AppIcon-1024.png  (all required sizes)
//   android/ic_launcher-foreground-432.png  +  background-432.png
//   watchos/icon-1024.png  (Apple Watch master)
//   spec.json  (manifest of every output file)

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
    loadCredentials, requireCredential, resolveBrand, ensureOutputDir,
    writeMeta, reportCost, parseArgs, brandPromptPrefix,
} from './_lib.mjs';

const args = parseArgs(process.argv);
const dryRun = Boolean(args['dry-run']);
const masterOnly = Boolean(args['master-only']);

const userPrompt = args.prompt || args.p ||
    'app icon that represents the brand cleanly without text';
const brand = resolveBrand(args.brand);
const creds = loadCredentials();

const masterPrompt = [
    brandPromptPrefix(brand, 'icon'),
    `Square iOS app icon, 1024x1024, rounded square format with no transparency.`,
    `Solid brand color background, single recognizable mark centered.`,
    `${userPrompt}`,
    `No text, no wordmark, no taglines — pure mark only. Clear silhouette at small sizes.`,
    `Looks premium next to Calm, Headspace, Apple Health on a home screen.`,
].join(' ');

const cost = 0.04; // gpt-image-1 1024x1024 high (DALL-E 3 retired Mar 2026)
reportCost({ provider: 'openai', model: 'gpt-image-1', units: '1 master', costUsd: cost, dryRun });

if (dryRun) {
    console.log('MASTER PROMPT:');
    console.log(`  ${masterPrompt}`);
    console.log(`Would have written master + derived sizes to ${ensureOutputDir(brand, 'app-icons')}`);
    process.exit(0);
}

requireCredential(creds, 'openaiKey', 'OPENAI_API_KEY');

let sharp;
try {
    sharp = (await import('sharp')).default;
} catch (e) {
    console.error('sharp is not installed. From the skill dir:');
    console.error('  npm install sharp');
    process.exit(2);
}

const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${creds.openaiKey}`,
};
if (creds.openaiOrg) headers['OpenAI-Organization'] = creds.openaiOrg;

console.log('Generating master at 1024x1024...');
const res = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers,
    body: JSON.stringify({
        model: 'dall-e-3',
        prompt: masterPrompt,
        n: 1,
        size: '1024x1024',
        quality: 'hd',
        response_format: 'b64_json',
    }),
});
if (!res.ok) {
    console.error(`OpenAI error ${res.status}: ${await res.text()}`);
    process.exit(2);
}
const { data } = await res.json();
const masterBuf = Buffer.from(data[0].b64_json, 'base64');

const root = ensureOutputDir(brand, 'app-icons');
const masterDir = resolve(root, 'master');
mkdirSync(masterDir, { recursive: true });
const masterPath = resolve(masterDir, 'icon-1024.png');
writeFileSync(masterPath, masterBuf);
console.log(`  master → ${masterPath}`);

writeMeta(masterPath, {
    user_prompt: userPrompt,
    full_prompt: masterPrompt,
    kind: 'app-icon-master',
    model: 'dall-e-3-hd',
    brand_name: brand.name,
    brand_source: brand._source,
    cost_estimate_usd: cost,
});

if (masterOnly) {
    console.log('\n--master-only set, skipping derived sizes.');
    process.exit(0);
}

// ─── Derive iOS sizes ────────────────────────────────────────────────
const iosSizes = [
    { name: 'AppIcon-20.png', px: 20 },
    { name: 'AppIcon-29.png', px: 29 },
    { name: 'AppIcon-40.png', px: 40 },
    { name: 'AppIcon-58.png', px: 58 },
    { name: 'AppIcon-60.png', px: 60 },
    { name: 'AppIcon-76.png', px: 76 },
    { name: 'AppIcon-80.png', px: 80 },
    { name: 'AppIcon-87.png', px: 87 },
    { name: 'AppIcon-120.png', px: 120 },
    { name: 'AppIcon-152.png', px: 152 },
    { name: 'AppIcon-167.png', px: 167 },
    { name: 'AppIcon-180.png', px: 180 },
    { name: 'AppIcon-1024.png', px: 1024 },
];
const iosDir = resolve(root, 'ios');
mkdirSync(iosDir, { recursive: true });
for (const s of iosSizes) {
    const out = resolve(iosDir, s.name);
    await sharp(masterBuf).resize(s.px, s.px).png().toFile(out);
}
console.log(`  iOS (${iosSizes.length} sizes) → ${iosDir}`);

// ─── Derive Android adaptive icon layers ─────────────────────────────
// Android adaptive icons need a foreground (with safe-zone padding) and
// a background. We extract the brand color from the master corners as
// the background, and shrink the master to ~63% as the foreground.
const androidDir = resolve(root, 'android');
mkdirSync(androidDir, { recursive: true });
const ANDROID_SIZE = 432;
const FG_SCALE = 0.66;

const bgColor = brand.palette?.primary || '#0d9488';
await sharp({
    create: {
        width: ANDROID_SIZE, height: ANDROID_SIZE, channels: 4,
        background: bgColor,
    },
}).png().toFile(resolve(androidDir, 'ic_launcher_background-432.png'));

const fgSize = Math.round(ANDROID_SIZE * FG_SCALE);
const fgBuf = await sharp(masterBuf).resize(fgSize, fgSize).png().toBuffer();
const pad = Math.round((ANDROID_SIZE - fgSize) / 2);
await sharp({
    create: {
        width: ANDROID_SIZE, height: ANDROID_SIZE, channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
}).composite([{ input: fgBuf, top: pad, left: pad }]).png().toFile(
    resolve(androidDir, 'ic_launcher_foreground-432.png')
);
console.log(`  Android adaptive layers → ${androidDir}`);

// ─── watchOS master ──────────────────────────────────────────────────
if (brand.platform_targets?.watchos) {
    const watchDir = resolve(root, 'watchos');
    mkdirSync(watchDir, { recursive: true });
    await sharp(masterBuf).resize(1024, 1024).png().toFile(
        resolve(watchDir, 'icon-1024.png')
    );
    console.log(`  watchOS master → ${watchDir}`);
}

// ─── Spec manifest ───────────────────────────────────────────────────
const spec = {
    master: masterPath,
    ios: iosSizes.map(s => resolve(iosDir, s.name)),
    android_fg: resolve(androidDir, 'ic_launcher_foreground-432.png'),
    android_bg: resolve(androidDir, 'ic_launcher_background-432.png'),
    watchos: brand.platform_targets?.watchos ? resolve(root, 'watchos/icon-1024.png') : null,
    background_color: bgColor,
    brand_name: brand.name,
    generated_at: new Date().toISOString(),
};
const specPath = resolve(root, 'spec.json');
writeFileSync(specPath, JSON.stringify(spec, null, 2));

console.log(`\nGenerated full app-icon family for ${brand.name}.`);
console.log(`Manifest: ${specPath}`);
console.log(`Total cost: ~$${cost.toFixed(2)} (master) + free post-processing.`);
