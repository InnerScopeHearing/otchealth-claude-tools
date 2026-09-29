#!/usr/bin/env node
// gen-voiceover.mjs — Generate a voiceover via ElevenLabs. Used for App
// Preview videos, marketing explainers, n8n-scheduled audio refreshes.
//
// Usage:
//   node gen-voiceover.mjs --text "..." [--voice-id <id>]
//                           [--model eleven_v4]
//                           [--output marketing/preview-vo.mp3]
//                           [--dry-run]
//
// Default voice: "warm middle-aged female calm narrator" — set per project
// via brand.voiceover_default_voice_id or override with --voice-id.

import { writeFileSync } from 'node:fs';
import {
    loadCredentials, requireCredential, resolveBrand, pickOutputPath,
    writeMeta, reportCost, parseArgs,
} from './_lib.mjs';

const args = parseArgs(process.argv);
const dryRun = Boolean(args['dry-run']);
const text = args.text || args.t;
if (!text) {
    console.error('Usage: gen-voiceover.mjs --text "..." [--voice-id <id>] [--model ...]');
    process.exit(1);
}

const brand = resolveBrand(args.brand);
const creds = loadCredentials();

const voiceId = args['voice-id'] || brand.voiceover_default_voice_id
    || '21m00Tcm4TlvDq8ikWAM'; // Rachel — ElevenLabs default warm female
// Default model is eleven_v4 (docs: https://elevenlabs.io/docs/overview/capabilities/text-to-speech/eleven-v4).
// v4 has ONLY Stability + Similarity settings (no Style / Speed / speaker boost), and takes up to 10,000 chars/request.
const model = args.model || 'eleven_v4';
const IS_V4 = /^eleven_v4/.test(model);
const MAX_CHARS = IS_V4 ? 10000 : model === 'eleven_v3' ? 5000 : 10000;
if (text.length > MAX_CHARS) {
    console.error(`ERROR: ${text.length} characters exceeds the ${MAX_CHARS}-character limit for ${model}. Split the script into lines.`);
    process.exit(1);
}
const voiceSettings = IS_V4
    ? { stability: 0.55, similarity_boost: 0.75 }
    : { stability: 0.55, similarity_boost: 0.75, style: 0.3, use_speaker_boost: true };

// ElevenLabs API list price: $0.08 per 1K characters for v4/v3 (https://elevenlabs.io/pricing/api); grant credits cover it.
const costUsd = (text.length / 1000) * 0.08;
reportCost({
    provider: 'elevenlabs', model,
    units: `${text.length} chars · voice ${voiceId.slice(0, 6)}`,
    costUsd, dryRun,
});

if (dryRun) {
    console.log('TEXT:');
    console.log(`  ${text}`);
    process.exit(0);
}

requireCredential(creds, 'elevenlabsKey', 'ELEVENLABS_API_KEY');

const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`;
const res = await fetch(url, {
    method: 'POST',
    headers: {
        'xi-api-key': creds.elevenlabsKey,
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg',
    },
    body: JSON.stringify({
        text,
        model_id: model,
        voice_settings: voiceSettings,
    }),
});

if (!res.ok) {
    console.error(`ElevenLabs ${res.status}: ${await res.text()}`);
    process.exit(2);
}

const buf = Buffer.from(await res.arrayBuffer());

const slug = args.name || text.split(/\s+/).slice(0, 6).join(' ');
const outputPath = pickOutputPath({
    brand, type: 'voiceover', name: slug, ext: 'mp3',
    explicit: args.output,
});
writeFileSync(outputPath, buf);
writeMeta(outputPath, {
    text,
    voice_id: voiceId,
    model,
    char_count: text.length,
    brand_name: brand.name,
    cost_estimate_usd: costUsd,
});

console.log(`OUTPUT: ${outputPath}`);
console.log(`Cost: ~$${costUsd.toFixed(3)}`);
