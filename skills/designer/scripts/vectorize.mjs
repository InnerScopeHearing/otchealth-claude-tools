#!/usr/bin/env node
// vectorize.mjs — Convert a PNG (typically a generated icon or hero
// illustration) into a clean SVG. Tries Recraft API first (best results
// for icons) and falls back to local potrace if Recraft is unavailable.
//
// Usage:
//   node vectorize.mjs --input path.png [--output path.svg]
//                       [--mode icon|illustration|line|color]
//                       [--dry-run]
//
// Output: SVG written next to input by default. Path printed.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname, basename, extname } from 'node:path';
import {
    loadCredentials, resolveBrand, writeMeta, reportCost, parseArgs,
} from './_lib.mjs';

const args = parseArgs(process.argv);
const dryRun = Boolean(args['dry-run']);
const input = args.input || args.i;
if (!input) {
    console.error('Usage: vectorize.mjs --input path.png [--output path.svg]');
    process.exit(1);
}
if (!existsSync(input)) {
    console.error(`Input not found: ${input}`);
    process.exit(1);
}

const brand = resolveBrand(args.brand);
const creds = loadCredentials();
const mode = args.mode || 'icon';
const output = args.output || resolve(dirname(input), `${basename(input, extname(input))}.svg`);

const useRecraft = Boolean(creds.recraftKey);
reportCost({
    provider: useRecraft ? 'recraft' : 'local-potrace',
    model: useRecraft ? 'recraftv3-vectorize' : 'potrace',
    units: '1 image',
    costUsd: useRecraft ? 0.04 : 0,
    dryRun,
});

if (dryRun) {
    console.log(`Would have written SVG to ${output}`);
    process.exit(0);
}

let svgContent;
if (useRecraft) {
    const buf = readFileSync(input);
    const form = new FormData();
    form.append('file', new Blob([buf], { type: 'image/png' }), basename(input));
    const res = await fetch('https://external.api.recraft.ai/v1/images/vectorize', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${creds.recraftKey}` },
        body: form,
    });
    if (!res.ok) {
        console.error(`Recraft vectorize failed ${res.status}: ${await res.text()}`);
        process.exit(2);
    }
    const data = await res.json();
    // Recraft returns an image URL — fetch the SVG content
    const url = data.image?.url || data.images?.[0]?.url;
    if (!url) {
        console.error('Recraft returned no SVG URL:', JSON.stringify(data).slice(0, 500));
        process.exit(2);
    }
    const svgRes = await fetch(url);
    svgContent = await svgRes.text();
} else {
    // Local potrace fallback. Requires `potrace` binary on PATH (apt install potrace).
    const { execFileSync } = await import('node:child_process');
    // potrace wants pbm/bmp/pgm/ppm input — convert via sharp
    let sharp;
    try {
        sharp = (await import('sharp')).default;
    } catch (e) {
        console.error('Neither Recraft credential nor sharp+potrace available.');
        console.error('Install Recraft key (--recraft-key) or `npm install sharp && apt install potrace`.');
        process.exit(2);
    }
    const pgmBuf = await sharp(input).greyscale().toFormat('pgm').toBuffer();
    const tmpPgm = `/tmp/vec-${Date.now()}.pgm`;
    writeFileSync(tmpPgm, pgmBuf);
    try {
        svgContent = execFileSync('potrace', ['-s', '-o', '-', tmpPgm]).toString();
    } catch (e) {
        console.error(`potrace failed: ${e.message}`);
        console.error('Install: apt install potrace (or brew install potrace)');
        process.exit(2);
    }
}

writeFileSync(output, svgContent);
writeMeta(output, {
    input,
    mode,
    method: useRecraft ? 'recraft' : 'potrace',
    brand_name: brand.name,
});

console.log(`OUTPUT: ${output}`);
