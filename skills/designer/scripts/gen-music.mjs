#!/usr/bin/env node
// gen-music.mjs — Generate original, royalty-clear background music via
// ElevenLabs Music (Eleven Music API). Use for app ambience, video
// underscores, App Preview beds, podcast intros, hold music.
//
// Usage:
//   node gen-music.mjs --prompt "calm ambient piano, hopeful, unobtrusive" \
//        [--duration 30] [--vocal] [--name app-ambience] \
//        [--output marketing/bed.mp3] [--dry-run]
//
// --duration is seconds (3–600). Defaults to instrumental (best for beds);
// pass --vocal to allow sung vocals. Falls back to brand.music.default_style
// when --prompt is omitted.
//
// Output: MP3 at brand.output_root/music/<slug>.mp3 + .meta.json.

import { writeFileSync } from 'node:fs';
import {
    loadCredentials, requireCredential, resolveBrand, pickOutputPath,
    writeMeta, reportCost, parseArgs,
} from './_lib.mjs';

const args = parseArgs(process.argv);
const dryRun = Boolean(args['dry-run']);

const brand = resolveBrand(args.brand);
const creds = loadCredentials();

const prompt = args.prompt || args.p || brand.music?.default_style;
if (!prompt) {
    console.error('Usage: gen-music.mjs --prompt "musical brief" [--duration 30] [--vocal]');
    console.error('  (or set brand.music.default_style in the brand profile)');
    process.exit(1);
}

const durationSec = Math.min(600, Math.max(3, parseInt(args.duration || '30', 10)));
const musicLengthMs = durationSec * 1000;
const instrumental = !args.vocal; // beds are instrumental unless told otherwise

// ElevenLabs Music consumes the startup grant; rough $-equivalent for the
// dry-run quote (~$0.06 per 10s on the creator tier; verify in dashboard).
const costUsd = (durationSec / 10) * 0.06;
reportCost({
    provider: 'elevenlabs', model: 'eleven-music',
    units: `${durationSec}s ${instrumental ? 'instrumental' : 'with vocals'}`,
    costUsd, dryRun,
});

if (dryRun) {
    console.log('PROMPT:');
    console.log(`  ${prompt}`);
    console.log(`Would have written ~${durationSec}s MP3 to ${brand.output_root || 'assets/generated'}/music/`);
    process.exit(0);
}

requireCredential(creds, 'elevenlabsKey', 'ELEVENLABS_API_KEY');

const res = await fetch('https://api.elevenlabs.io/v1/music', {
    method: 'POST',
    headers: {
        'xi-api-key': creds.elevenlabsKey,
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg',
    },
    body: JSON.stringify({
        prompt,
        music_length_ms: musicLengthMs,
        music_instrumental: instrumental,
    }),
});
if (!res.ok) {
    console.error(`ElevenLabs Music ${res.status}: ${await res.text()}`);
    process.exit(2);
}
const buf = Buffer.from(await res.arrayBuffer());

const slug = args.name || prompt.split(/\s+/).slice(0, 6).join(' ');
const outputPath = pickOutputPath({
    brand, type: 'music', name: slug, ext: 'mp3', explicit: args.output,
});
writeFileSync(outputPath, buf);
writeMeta(outputPath, {
    prompt,
    duration_sec: durationSec,
    instrumental,
    model: 'eleven-music',
    brand_name: brand.name,
    cost_estimate_usd: costUsd,
});

console.log(`\nOUTPUT: ${outputPath}`);
console.log(`Cost: ~$${costUsd.toFixed(3)} (ElevenLabs grant)`);
