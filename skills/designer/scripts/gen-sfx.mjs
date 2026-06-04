#!/usr/bin/env node
// gen-sfx.mjs — Generate short sound effects via ElevenLabs (text-to-sound).
// Use for UI feedback (success chime, tap, error buzz), notification tones,
// app stingers, game/whimsy sounds, video transitions.
//
// Usage:
//   node gen-sfx.mjs --prompt "soft success chime, gentle bell, positive" \
//        [--duration 1.5] [--influence 0.4] [--name success-chime] \
//        [--output assets/sfx/success.mp3] [--dry-run]
//
// --duration is seconds (0.5–30); omit to let the model pick. --influence
// (0–1, default 0.3) — higher hugs the prompt more tightly, less variety.
//
// Output: MP3 at brand.output_root/sfx/<slug>.mp3 + .meta.json.

import { writeFileSync } from 'node:fs';
import {
    loadCredentials, requireCredential, resolveBrand, pickOutputPath,
    writeMeta, reportCost, parseArgs,
} from './_lib.mjs';

const args = parseArgs(process.argv);
const dryRun = Boolean(args['dry-run']);
const prompt = args.prompt || args.text || args.p;
if (!prompt) {
    console.error('Usage: gen-sfx.mjs --prompt "sound description" [--duration 1.5] [--influence 0.4]');
    process.exit(1);
}

const brand = resolveBrand(args.brand);
const creds = loadCredentials();

const duration = args.duration ? Math.min(30, Math.max(0.5, parseFloat(args.duration))) : null;
const influence = args.influence ? Math.min(1, Math.max(0, parseFloat(args.influence))) : 0.3;

// SFX are cheap; small flat estimate against the ElevenLabs grant.
const costUsd = 0.02;
reportCost({
    provider: 'elevenlabs', model: 'eleven-sound-effects',
    units: duration ? `${duration}s` : 'auto-length',
    costUsd, dryRun,
});

if (dryRun) {
    console.log('PROMPT:');
    console.log(`  ${prompt}`);
    console.log(`Would have written MP3 to ${brand.output_root || 'assets/generated'}/sfx/`);
    process.exit(0);
}

requireCredential(creds, 'elevenlabsKey', 'ELEVENLABS_API_KEY');

const body = { text: prompt, prompt_influence: influence };
if (duration !== null) body.duration_seconds = duration;

const res = await fetch('https://api.elevenlabs.io/v1/sound-generation', {
    method: 'POST',
    headers: {
        'xi-api-key': creds.elevenlabsKey,
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg',
    },
    body: JSON.stringify(body),
});
if (!res.ok) {
    console.error(`ElevenLabs SFX ${res.status}: ${await res.text()}`);
    process.exit(2);
}
const buf = Buffer.from(await res.arrayBuffer());

const slug = args.name || prompt.split(/\s+/).slice(0, 6).join(' ');
const outputPath = pickOutputPath({
    brand, type: 'sfx', name: slug, ext: 'mp3', explicit: args.output,
});
writeFileSync(outputPath, buf);
writeMeta(outputPath, {
    prompt,
    duration_seconds: duration,
    prompt_influence: influence,
    model: 'eleven-sound-effects',
    brand_name: brand.name,
    cost_estimate_usd: costUsd,
});

console.log(`\nOUTPUT: ${outputPath}`);
console.log(`Cost: ~$${costUsd.toFixed(3)} (ElevenLabs grant)`);
