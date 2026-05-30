#!/usr/bin/env node
// optimize-asset.mjs — Compress + convert assets locally with sharp.
// No API spend. Used as the last step in any pipeline so the asset
// committed to a repo is small and platform-appropriate.
//
// Usage:
//   node optimize-asset.mjs --input path.png [--format webp|png|jpg|avif]
//                            [--width N] [--quality 1-100]
//                            [--strip-meta] [--output path.webp]
//
// Output: written next to input by default. Path printed.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname, basename, extname } from 'node:path';
import { parseArgs } from './_lib.mjs';

const args = parseArgs(process.argv);
const input = args.input || args.i;
if (!input || !existsSync(input)) {
    console.error('Usage: optimize-asset.mjs --input path [--format webp|png|jpg|avif] [--width N] [--quality 80]');
    process.exit(1);
}

const format = args.format || 'webp';
const width = args.width ? parseInt(args.width, 10) : null;
const quality = args.quality ? parseInt(args.quality, 10) : 80;
const output = args.output || resolve(dirname(input), `${basename(input, extname(input))}.${format}`);

let sharp;
try {
    sharp = (await import('sharp')).default;
} catch (e) {
    console.error('sharp not installed. From the skill dir: npm install sharp');
    process.exit(2);
}

const before = readFileSync(input).length;

let pipeline = sharp(input);
if (width) pipeline = pipeline.resize({ width, withoutEnlargement: true });

switch (format) {
    case 'webp': pipeline = pipeline.webp({ quality }); break;
    case 'avif': pipeline = pipeline.avif({ quality }); break;
    case 'jpg':
    case 'jpeg': pipeline = pipeline.jpeg({ quality, mozjpeg: true }); break;
    case 'png':  pipeline = pipeline.png({ quality, compressionLevel: 9, palette: true }); break;
    default:
        console.error(`Unknown format: ${format}`);
        process.exit(1);
}

await pipeline.toFile(output);
const after = readFileSync(output).length;
const pct = ((1 - after / before) * 100).toFixed(1);
console.log(`OUTPUT: ${output}`);
console.log(`  ${(before / 1024).toFixed(1)} KB → ${(after / 1024).toFixed(1)} KB (${pct}% smaller)`);
