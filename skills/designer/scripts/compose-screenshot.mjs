#!/usr/bin/env node
// compose-screenshot.mjs — Compose an App Store / Play Store / social
// screenshot from a raw app capture + device frame + headline overlay.
// Skips API calls when possible (uses sharp locally) and only hits Imagen 3
// for the headline-typography image if requested.
//
// Usage:
//   node compose-screenshot.mjs --capture path/to/raw-screen.png
//                               --device iphone-15-pro-max|iphone-15|ipad-12.9
//                               [--headline "Hear better, every day."]
//                               [--subhead "Daily training. Works alongside any aid."]
//                               [--bg-gradient teal-to-cream]
//                               [--output marketing/store/01-hero.png]
//                               [--dry-run]
//
// Output: 1290x2796 (iPhone 6.5") or 2048x2732 (iPad 12.9") composited PNG
//         with device frame + screen capture inside + headline above.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import {
    loadCredentials, resolveBrand, pickOutputPath, writeMeta,
    reportCost, parseArgs,
} from './_lib.mjs';

const args = parseArgs(process.argv);
const dryRun = Boolean(args['dry-run']);

const capture = args.capture;
const device = args.device || 'iphone-15-pro-max';
const headline = args.headline;
const subhead = args.subhead;

if (!capture) {
    console.error('Usage: compose-screenshot.mjs --capture path.png --device iphone-15-pro-max [options]');
    process.exit(1);
}
if (!existsSync(capture)) {
    console.error(`Capture file not found: ${capture}`);
    process.exit(1);
}

const DEVICE_SPECS = {
    'iphone-15-pro-max': { w: 1290, h: 2796, corner: 60, name: 'iPhone 15 Pro Max' },
    'iphone-15': { w: 1179, h: 2556, corner: 55, name: 'iPhone 15' },
    'iphone-6.5': { w: 1242, h: 2688, corner: 50, name: 'iPhone 6.5"' },
    'iphone-5.5': { w: 1242, h: 2208, corner: 40, name: 'iPhone 5.5"' },
    'ipad-12.9': { w: 2048, h: 2732, corner: 30, name: 'iPad Pro 12.9"' },
};
const spec = DEVICE_SPECS[device];
if (!spec) {
    console.error(`Unknown device: ${device}. Choose from: ${Object.keys(DEVICE_SPECS).join(', ')}`);
    process.exit(1);
}

const brand = resolveBrand(args.brand);
const localOnly = !headline || args['no-ai-headline'];
reportCost({
    provider: localOnly ? 'local' : 'mixed',
    model: localOnly ? 'sharp-only' : 'sharp + imagen-3',
    units: '1 composed screenshot',
    costUsd: localOnly ? 0 : 0.03,
    dryRun,
});

if (dryRun) {
    console.log(`Would have composed ${spec.name} ${spec.w}x${spec.h} screenshot from ${capture}`);
    process.exit(0);
}

let sharp;
try {
    sharp = (await import('sharp')).default;
} catch (e) {
    console.error('sharp is not installed. From the skill dir: npm install sharp');
    process.exit(2);
}

// Build a brand-tinted gradient background canvas
const primary = brand.palette?.primary || '#0d9488';
const surface = brand.palette?.surface || '#FAF7F2';

// Use an SVG gradient — sharp renders it cleanly.
const bgSvg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${spec.w}" height="${spec.h}">
  <defs>
    <linearGradient id="g" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="${primary}"/>
      <stop offset="100%" stop-color="${surface}"/>
    </linearGradient>
  </defs>
  <rect width="${spec.w}" height="${spec.h}" fill="url(#g)"/>
</svg>`);

// Headline + subhead overlay as SVG (rendered locally via sharp)
let headlineSvg = null;
if (headline) {
    const titleSize = Math.round(spec.w * 0.07);
    const subSize = Math.round(spec.w * 0.035);
    const family = brand.typography?.family || 'Inter';
    const fallback = brand.typography?.family_fallback || 'sans-serif';
    headlineSvg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${spec.w}" height="${Math.round(spec.h * 0.18)}">
  <style>
    .title { font-family: ${family}, ${fallback}; font-weight: 800; fill: #ffffff; }
    .sub   { font-family: ${family}, ${fallback}; font-weight: 500; fill: rgba(255,255,255,0.88); }
  </style>
  <text x="${spec.w / 2}" y="${titleSize + 40}" text-anchor="middle" class="title" font-size="${titleSize}">${escapeXml(headline)}</text>
  ${subhead ? `<text x="${spec.w / 2}" y="${titleSize + 40 + subSize + 30}" text-anchor="middle" class="sub" font-size="${subSize}">${escapeXml(subhead)}</text>` : ''}
</svg>`);
}

// Resize and round-corner the capture so it sits inside the "device" area
const captureBuf = await sharp(capture)
    .resize(Math.round(spec.w * 0.82), null, { fit: 'inside' })
    .toBuffer();
const cMeta = await sharp(captureBuf).metadata();
const cW = cMeta.width;
const cH = cMeta.height;
const cornerMask = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${cW}" height="${cH}">
  <rect x="0" y="0" width="${cW}" height="${cH}" rx="${spec.corner}" ry="${spec.corner}" fill="#fff"/>
</svg>`);
const roundedCapture = await sharp(captureBuf)
    .composite([{ input: cornerMask, blend: 'dest-in' }])
    .png()
    .toBuffer();

// Layer order (bottom → top): bg gradient → capture → headline
const composites = [];
const captureTop = Math.round(spec.h * 0.32);
const captureLeft = Math.round((spec.w - cW) / 2);
composites.push({ input: roundedCapture, top: captureTop, left: captureLeft });
if (headlineSvg) {
    composites.push({ input: headlineSvg, top: Math.round(spec.h * 0.08), left: 0 });
}

const finalPath = pickOutputPath({
    brand, type: 'store-screenshots', name: args.name || 'screenshot', ext: 'png',
    explicit: args.output,
});

await sharp(bgSvg).composite(composites).png().toFile(finalPath);
writeMeta(finalPath, {
    capture, device, headline, subhead,
    brand_name: brand.name,
    output_dims: `${spec.w}x${spec.h}`,
    cost_estimate_usd: 0,
});

console.log(`OUTPUT: ${finalPath}`);

function escapeXml(s) {
    return String(s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
