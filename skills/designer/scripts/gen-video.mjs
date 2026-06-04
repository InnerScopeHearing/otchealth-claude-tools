#!/usr/bin/env node
// gen-video.mjs — Generate AI video via Google Vertex AI Veo. Defaults to
// Veo 3.1 (native audio + lip-synced dialogue, GA on Vertex). Supports
// text-to-video for hero marketing clips and image-to-video for animating
// still illustrations. For a talking presenter reading a script, use the
// purpose-built gen-avatar.mjs instead.
//
// Usage:
//   node gen-video.mjs --prompt "..." [--duration 8] [--ratio 16:9|9:16|1:1]
//                      [--resolution 720p|1080p] [--audio]
//                      [--model veo-3.1-generate-001|veo-2.0-generate-001]
//                      [--seed-image path.png] [--output marketing/preview.mp4]
//                      [--dry-run]
//
// Output: MP4 at brand.output_root/video/<slug>.mp4 + .meta.json.
//         Veo jobs are asynchronous — script polls until ready then downloads.

import { writeFileSync, readFileSync } from 'node:fs';
import {
    loadCredentials, requireCredential, resolveBrand, pickOutputPath,
    writeMeta, reportCost, parseArgs, brandPromptPrefix,
    getVertexAccessToken, runVeoJob, extractVeoVideoB64, requireAzureOpenAI,
} from './_lib.mjs';
import { soraGenerateVideo } from './_azure.mjs';

const args = parseArgs(process.argv);
const dryRun = Boolean(args['dry-run']);
const prompt = args.prompt || args.p;
const duration = parseInt(args.duration || '8', 10);
const ratio = args.ratio || '16:9';
const resolution = args.resolution || '1080p';
const seedImage = args['seed-image'];
const engine = args.engine || 'veo'; // veo (Vertex) | sora (Azure OpenAI)
const model = args.model || 'veo-3.1-generate-001';
const audio = Boolean(args.audio); // off by default for plain B-roll; on for talkies

if (!prompt) {
    console.error('Usage: gen-video.mjs --prompt "..." [--engine veo|sora] [--duration N] [--ratio 16:9|9:16|1:1] [--resolution 720p|1080p] [--audio] [--model ...]');
    process.exit(1);
}
if (engine !== 'veo' && engine !== 'sora') {
    console.error(`--engine must be 'veo' or 'sora' (got '${engine}')`);
    process.exit(1);
}

const brand = resolveBrand(args.brand);
const creds = loadCredentials();
const fullPrompt = `${brandPromptPrefix(brand, 'illustration')} ${prompt}`.trim();

// ─── Sora 2 on Azure OpenAI (spends the Azure grant) ──────────────────
if (engine === 'sora') {
    // Sora resolutions are width×height; map ratio → a supported pair.
    const dims = ratio === '9:16' ? { width: 720, height: 1280 }
        : ratio === '1:1' ? { width: 1080, height: 1080 }
        : { width: 1920, height: 1080 };
    const soraSeconds = Math.min(20, Math.max(5, duration)); // Sora supports 5–20s
    const soraCost = soraSeconds * 0.30; // rough placeholder; verify on the dashboard
    reportCost({
        provider: 'azure-openai', model: creds.azureOpenAIVideoDeployment || 'sora-2',
        units: `${soraSeconds}s ${dims.width}x${dims.height}`, costUsd: soraCost, dryRun,
    });
    if (dryRun) {
        console.log('PROMPT:');
        console.log(`  ${fullPrompt}`);
        console.log(`Would have written ~${soraSeconds}s MP4 (Azure Sora) to ${brand.output_root || 'assets/generated'}/video/`);
        process.exit(0);
    }
    requireAzureOpenAI(creds, creds.azureOpenAIVideoDeployment);
    let buf;
    try {
        buf = await soraGenerateVideo({
            creds, prompt: fullPrompt, seconds: soraSeconds,
            width: dims.width, height: dims.height,
            deployment: creds.azureOpenAIVideoDeployment, log: (m) => process.stderr.write(m + '\n'),
        });
    } catch (e) {
        console.error(`ERROR (Azure Sora): ${e.message}`);
        process.exit(2);
    }
    const slug = args.name || prompt.split(/\s+/).slice(0, 6).join(' ');
    const outputPath = pickOutputPath({ brand, type: 'video', name: slug, ext: 'mp4', explicit: args.output });
    (await import('node:fs')).writeFileSync(outputPath, buf);
    writeMeta(outputPath, {
        user_prompt: prompt, full_prompt: fullPrompt, duration_sec: soraSeconds,
        aspect_ratio: ratio, engine: 'sora', model: creds.azureOpenAIVideoDeployment,
        brand_name: brand.name, cost_estimate_usd: soraCost,
    });
    console.log(`\nOUTPUT: ${outputPath}`);
    console.log(`Cost: ~$${soraCost.toFixed(2)} (Azure grant)`);
    process.exit(0);
}

// ─── Veo on Vertex (default) ──────────────────────────────────────────
// Per-second list-price estimates (Jun 2026). Veo 2 has no native audio.
const RATE = {
    'veo-3.1-generate-001':      { video: 0.50, audio: 0.75 },
    'veo-3.1-fast-generate-001': { video: 0.25, audio: 0.40 },
    'veo-3.0-generate-001':      { video: 0.50, audio: 0.75 },
    'veo-2.0-generate-001':      { video: 0.35, audio: 0.35 },
};
const rate = RATE[model] || RATE['veo-3.1-generate-001'];
const useAudio = audio && model !== 'veo-2.0-generate-001';
const costUsd = duration * rate[useAudio ? 'audio' : 'video'];
reportCost({
    provider: 'google-vertex', model,
    units: `${duration}s ${ratio} ${resolution}${useAudio ? ' +audio' : ''}${seedImage ? ' (i2v)' : ''}`,
    costUsd, dryRun,
});

if (dryRun) {
    console.log('PROMPT:');
    console.log(`  ${fullPrompt}`);
    console.log(`Would have written ~${duration}s MP4 to ${brand.output_root || 'assets/generated'}/video/`);
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
    sampleCount: 1,
    // Open Veo's person-generation gate so clips containing people aren't
    // silently RAI-filtered. Override with --person dont_allow|allow_all.
    personGeneration: args.person || 'allow_adult',
};
// Only Veo 3.x understands generateAudio; sending it to Veo 2 would error.
if (model !== 'veo-2.0-generate-001') parameters.generateAudio = useAudio;

const response = await runVeoJob({
    token, project: creds.googleProject, model, instances: [instance], parameters,
});
const videoB64 = extractVeoVideoB64(response);

const slug = args.name || prompt.split(/\s+/).slice(0, 6).join(' ');
const outputPath = pickOutputPath({
    brand, type: 'video', name: slug, ext: 'mp4',
    explicit: args.output,
});
writeFileSync(outputPath, Buffer.from(videoB64, 'base64'));
writeMeta(outputPath, {
    user_prompt: prompt,
    full_prompt: fullPrompt,
    duration_sec: duration,
    aspect_ratio: ratio,
    resolution,
    native_audio: useAudio,
    seed_image: seedImage,
    model,
    brand_name: brand.name,
    cost_estimate_usd: costUsd,
});

console.log(`\nOUTPUT: ${outputPath}`);
console.log(`Cost: ~$${costUsd.toFixed(2)}`);
