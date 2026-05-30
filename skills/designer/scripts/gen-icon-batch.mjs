#!/usr/bin/env node
// gen-icon-batch.mjs — Generate a set of brand-consistent icons in one
// shot. Uses style locking so all 20+ icons share visual DNA (corner
// radius, stroke weight, fill style, color usage). Solves the "DIY emoji
// icons" problem in one command.
//
// Usage:
//   node gen-icon-batch.mjs --names "search,settings,home,profile,bell"
//                           [--style-ref path/to/existing-icon.png]
//                           [--style "rounded line, 2px stroke"]
//                           [--output assets/icons]
//                           [--dry-run]
//
// Output: One PNG per icon name at brand.output_root/icons/<name>.png
//         All meta files cross-reference each other for traceability.

import { writeFileSync, readFileSync } from 'node:fs';
import {
    loadCredentials, requireCredential, resolveBrand, pickOutputPath,
    writeMeta, reportCost, parseArgs, brandPromptPrefix,
} from './_lib.mjs';

const args = parseArgs(process.argv);
const dryRun = Boolean(args['dry-run']);

const names = (args.names || args.n || '')
    .split(',').map(s => s.trim()).filter(Boolean);
if (!names.length) {
    console.error('Usage: gen-icon-batch.mjs --names "search,settings,..." [options]');
    process.exit(1);
}

const brand = resolveBrand(args.brand);
const creds = loadCredentials();
requireCredential(creds, 'openaiKey', 'OPENAI_API_KEY');

const styleAddendum = args.style || brand.icon_style ||
    'rounded line icons, 2px stroke, brand color fill, 24x24 viewBox, slightly playful';
const refImage = args['style-ref'] || null;

const COST_PER_ICON = 0.04; // gpt-image-1 baseline
const totalCost = COST_PER_ICON * names.length;
reportCost({
    provider: 'openai', model: 'gpt-image-1',
    units: `${names.length} icons`, costUsd: totalCost, dryRun,
});

if (dryRun) {
    console.log('Would have generated:');
    names.forEach(n => console.log(`  ${n}`));
    process.exit(0);
}

const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${creds.openaiKey}`,
};
if (creds.openaiOrg) headers['OpenAI-Organization'] = creds.openaiOrg;

async function genOne(name) {
    const prompt = [
        brandPromptPrefix(brand, 'icon'),
        `A single ${name} icon. ${styleAddendum}.`,
        `Centered on a flat solid white background. No drop shadow. No text.`,
        `Same visual style as every other icon in this set so they belong together.`,
    ].join(' ');

    // For style consistency, gpt-image-1 supports a reference image input.
    // If --style-ref is provided, use the edit endpoint; otherwise plain gen.
    let body, endpoint;
    if (refImage) {
        const refB64 = readFileSync(refImage).toString('base64');
        body = {
            model: 'gpt-image-1',
            prompt,
            image: refB64,
            n: 1,
            size: '1024x1024',
        };
        endpoint = 'https://api.openai.com/v1/images/edits';
    } else {
        body = {
            model: 'gpt-image-1',
            prompt,
            n: 1,
            size: '1024x1024',
            response_format: 'b64_json',
        };
        endpoint = 'https://api.openai.com/v1/images/generations';
    }

    const res = await fetch(endpoint, {
        method: 'POST', headers, body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`OpenAI ${res.status} on "${name}": ${await res.text()}`);
    const data = await res.json();
    return Buffer.from(data.data[0].b64_json, 'base64');
}

const outputs = [];
for (const name of names) {
    process.stderr.write(`  generating ${name}... `);
    try {
        const buf = await genOne(name);
        const outputPath = pickOutputPath({
            brand, type: 'icons', name, ext: 'png',
            explicit: null,
        });
        writeFileSync(outputPath, buf);
        writeMeta(outputPath, {
            user_prompt: name,
            kind: 'icon',
            model: 'gpt-image-1',
            batch_id: `${Date.now()}`,
            batch_total: names.length,
            style_addendum: styleAddendum,
            style_ref: refImage,
            brand_name: brand.name,
            cost_estimate_usd: COST_PER_ICON,
        });
        outputs.push(outputPath);
        process.stderr.write('OK\n');
    } catch (e) {
        process.stderr.write(`FAIL — ${e.message}\n`);
    }
}

console.log('\nOUTPUTS:');
outputs.forEach(p => console.log(`  ${p}`));
console.log(`\nGenerated ${outputs.length}/${names.length} icons. Total cost ~$${(outputs.length * COST_PER_ICON).toFixed(3)}.`);
console.log(`\nTip: run \`node ${process.argv[1].replace('gen-icon-batch.mjs', 'vectorize.mjs')} --input <png>\` to convert any of these to SVG.`);
