#!/usr/bin/env node
// gen-avatar.mjs — Generate a realistic AI talking avatar (presenter
// reading a script, with native lip-synced dialogue + audio) via Google
// Vertex AI Veo 3.1. This is the in-stack alternative to HeyGen: the face,
// the voice, and the lip-sync bind are all produced in one Veo render on
// your Google Cloud credits — no third-party avatar SaaS required.
//
// Two modes:
//   text-to-avatar   — describe the presenter, Veo casts + animates them
//   image-to-avatar  — pass --seed-image (e.g. a face from gen-image.mjs)
//                      and Veo animates THAT face speaking the script
//
// Usage:
//   node gen-avatar.mjs --script "Hi, I'm here to walk you through AWARE." \
//        [--presenter "warm female audiologist, 40s, friendly"] \
//        [--setting "soft teal studio background"] \
//        [--seed-image assets/generated/illustration/host.png] \
//        [--duration 8] [--ratio 16:9|9:16|1:1] [--resolution 720p|1080p] \
//        [--model veo-3.1-generate-001|veo-3.1-fast-generate-001] \
//        [--no-audio] [--output marketing/intro-avatar.mp4] [--dry-run]
//
// Output: MP4 at brand.output_root/avatar/<slug>.mp4 + .meta.json.
// Veo jobs are asynchronous — the script submits, polls, then downloads.

import { writeFileSync, readFileSync } from 'node:fs';
import {
    loadCredentials, requireCredential, resolveBrand, pickOutputPath,
    writeMeta, reportCost, parseArgs,
    getVertexAccessToken, runVeoJob, extractVeoVideoB64,
} from './_lib.mjs';

const args = parseArgs(process.argv);
const dryRun = Boolean(args['dry-run']);

const script = args.script || args.s;
if (!script) {
    console.error('Usage: gen-avatar.mjs --script "spoken line" [--presenter "..."] [--setting "..."] [--seed-image f.png] [--duration N] [--ratio 16:9|9:16|1:1] [--resolution 720p|1080p] [--no-audio]');
    process.exit(1);
}

const brand = resolveBrand(args.brand);
const creds = loadCredentials();

const avatar = brand.avatar || {};
const presenter = args.presenter
    || avatar.presenter
    || 'a warm, approachable presenter speaking directly to camera';
const setting = args.setting
    || avatar.setting
    || 'a clean, softly-lit studio with the brand primary color as a subtle background';
const seedImage = args['seed-image'];

const duration = parseInt(args.duration || '8', 10);
const ratio = args.ratio || '16:9';
const resolution = args.resolution || '1080p';
const model = args.model || avatar.default_model || 'veo-3.1-generate-001';
const audio = !args['no-audio']; // native dialogue/audio ON by default — the whole point of an avatar

// Veo 3.1 list-price estimates (Jun 2026). Audio adds cost; "fast" is cheaper.
// These are deliberately conservative so --dry-run never under-quotes.
const RATE = {
    'veo-3.1-generate-001':      { video: 0.50, audio: 0.75 },
    'veo-3.1-fast-generate-001': { video: 0.25, audio: 0.40 },
    'veo-3.0-generate-001':      { video: 0.50, audio: 0.75 },
};
const perSec = (RATE[model] || RATE['veo-3.1-generate-001'])[audio ? 'audio' : 'video'];
const costUsd = duration * perSec;

reportCost({
    provider: 'google-vertex', model,
    units: `${duration}s ${ratio} ${resolution}${audio ? ' +dialogue' : ' (silent)'}${seedImage ? ' (i2v)' : ''}`,
    costUsd, dryRun,
});

// Brand context for a PHOTOREAL avatar: pull color + audience + voice, but
// deliberately NOT illustration_style — that profile says "no photorealism",
// which would fight the talking-head we actually want here.
const brandBits = [];
if (brand.palette?.primary) brandBits.push(`Brand accent color ${brand.palette.primary} present in wardrobe or set.`);
if (brand.audience) brandBits.push(`Presenter and tone suited to: ${brand.audience}.`);
if (brand.voice?.tone) brandBits.push(`Delivery tone: ${brand.voice.tone}`);
const brandPrefix = brandBits.join(' ');

// Veo 3 dialogue prompting: name the presenter, direct eye-line + lip-sync,
// then put the exact spoken line in quotes so the model speaks it verbatim.
const spoken = script.replace(/"/g, '”'); // avoid breaking the quoted line
const fullPrompt = [
    brandPrefix,
    `${presenter}, in ${setting}.`,
    'They look directly into the camera and speak naturally, with accurate lip-sync, lifelike facial expressions, natural blinking and subtle head motion.',
    audio
        ? `They say, clearly and warmly: "${spoken}"`
        : `They mouth the words (no audio track): "${spoken}"`,
    'Photorealistic, broadcast quality, shallow depth of field, single continuous shot.',
].filter(Boolean).join(' ').trim();

if (dryRun) {
    console.log('PROMPT:');
    console.log(`  ${fullPrompt}`);
    console.log(`Mode: ${seedImage ? `image-to-avatar (seed: ${seedImage})` : 'text-to-avatar'}`);
    console.log(`Would have written ~${duration}s MP4 to ${brand.output_root || 'assets/generated'}/avatar/`);
    process.exit(0);
}

requireCredential(creds, 'googleProject', 'GOOGLE_CLOUD_PROJECT');
requireCredential(creds, 'googleCredsPath', 'GOOGLE_APPLICATION_CREDENTIALS');

const sa = JSON.parse(readFileSync(creds.googleCredsPath, 'utf8'));
const token = await getVertexAccessToken(sa);

const instance = { prompt: fullPrompt };
if (seedImage) {
    instance.image = {
        bytesBase64Encoded: readFileSync(seedImage).toString('base64'),
        mimeType: seedImage.toLowerCase().endsWith('.jpg') || seedImage.toLowerCase().endsWith('.jpeg')
            ? 'image/jpeg' : 'image/png',
    };
}

const parameters = {
    durationSeconds: duration,
    aspectRatio: ratio,
    resolution,
    generateAudio: audio,
    sampleCount: 1,
    // A talking avatar IS a realistic adult human, so Veo's person-generation
    // safety gate must be opened explicitly or every render is RAI-filtered.
    // Override with --person dont_allow|allow_adult|allow_all.
    personGeneration: args.person || 'allow_adult',
};

const response = await runVeoJob({
    token, project: creds.googleProject, model, instances: [instance], parameters,
});
const videoB64 = extractVeoVideoB64(response);

const slug = args.name || script.split(/\s+/).slice(0, 6).join(' ');
const outputPath = pickOutputPath({
    brand, type: 'avatar', name: slug, ext: 'mp4', explicit: args.output,
});
writeFileSync(outputPath, Buffer.from(videoB64, 'base64'));
writeMeta(outputPath, {
    script,
    presenter,
    setting,
    full_prompt: fullPrompt,
    mode: seedImage ? 'image-to-avatar' : 'text-to-avatar',
    seed_image: seedImage,
    duration_sec: duration,
    aspect_ratio: ratio,
    resolution,
    native_audio: audio,
    model,
    brand_name: brand.name,
    cost_estimate_usd: costUsd,
});

console.log(`\nOUTPUT: ${outputPath}`);
console.log(`Cost: ~$${costUsd.toFixed(2)}`);
