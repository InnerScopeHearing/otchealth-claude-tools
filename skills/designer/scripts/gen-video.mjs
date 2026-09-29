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
//   --engine elevenlabs  ElevenLabs Flows (Veo 3.1 / 3.1 Fast through the workspace credit grant). It is a DRY RUN
//                        unless you pass BOTH --commit and --max-credits N (plus --allow-unknown-rate when the
//                        credit rate for that model/resolution/audio combination has not been measured yet).
//                        Ads: use skills/ad-studio (claims, FTC and brand gates run there); this flag is for one-off clips.
//
// Output: MP4 at brand.output_root/video/<slug>.mp4 + .meta.json.
//         Veo jobs are asynchronous — script polls until ready then downloads.

import { writeFileSync, readFileSync } from 'node:fs';
import {
    loadCredentials, requireCredential, resolveBrand, pickOutputPath,
    writeMeta, reportCost, parseArgs, brandPromptPrefix,
    getVertexAccessToken, runVeoJob, extractVeoVideoB64, requireAzureOpenAI,
} from './_lib.mjs';
import { truthy } from './_spend.mjs';
import { soraGenerateVideo } from './_azure.mjs';
import { openaiGenerateVideo } from './_openai.mjs';

const args = parseArgs(process.argv);
const dryRun = Boolean(args['dry-run']);
const prompt = args.prompt || args.p;
const duration = parseInt(args.duration || '8', 10);
const ratio = args.ratio || '16:9';
const resolution = args.resolution || '1080p';
const seedImage = args['seed-image'];
// Primary video engine is direct OpenAI Sora 2 (plenty of OpenAI credits).
// Alternatives: veo (Vertex, native lip-sync) | azure (Azure OpenAI Sora).
const engine = args.engine || process.env.DESIGNER_VIDEO_ENGINE || ((process.env.AZURE_OPENAI_API_KEY && process.env.AZURE_OPENAI_VIDEO_DEPLOYMENT) ? 'azure' : 'openai');
const model = args.model || 'veo-3.1-generate-001';
const audio = Boolean(args.audio); // Veo-only flag; Sora generates its own audio

if (!prompt) {
    console.error('Usage: gen-video.mjs --prompt "..." [--engine openai|veo|azure] [--duration N] [--ratio 16:9|9:16|1:1] [--resolution 720p|1080p] [--audio] [--model ...]');
    process.exit(1);
}
if (!['openai', 'veo', 'azure', 'elevenlabs'].includes(engine)) {
    console.error(`--engine must be 'openai', 'veo', 'azure', or 'elevenlabs' (got '${engine}')`);
    process.exit(1);
}

const brand = resolveBrand(args.brand);
const creds = loadCredentials();
const fullPrompt = `${brandPromptPrefix(brand, 'illustration')} ${prompt}`.trim();

// ─── Sora 2 on direct OpenAI (PRIMARY / default) ──────────────────────
if (engine === 'openai') {
    const soraModel = args['sora-model'] || 'sora-2'; // or sora-2-pro
    // sora-2 sizes are WxH; map aspect ratio to a supported pair.
    const size = ratio === '9:16' ? '720x1280'
        : ratio === '1:1' ? '1024x1024'
        : '1280x720';
    // sora-2 accepts 4 / 8 / 12 seconds — snap to the nearest.
    const soraSeconds = [4, 8, 12].reduce((a, b) => Math.abs(b - duration) < Math.abs(a - duration) ? b : a, 8);
    // Rough list estimate (verify on the OpenAI dashboard).
    const perSec = soraModel === 'sora-2-pro' ? 0.30 : 0.10;
    const soraCost = soraSeconds * perSec;
    reportCost({ provider: 'openai', model: soraModel, units: `${soraSeconds}s ${size}`, costUsd: soraCost, dryRun });
    if (dryRun) {
        console.log('PROMPT:');
        console.log(`  ${fullPrompt}`);
        console.log(`Would have written ~${soraSeconds}s MP4 (OpenAI ${soraModel}, ${size}) to ${brand.output_root || 'assets/generated'}/video/`);
        process.exit(0);
    }
    requireCredential(creds, 'openaiKey', 'OPENAI_API_KEY');
    let buf;
    try {
        buf = await openaiGenerateVideo({
            key: creds.openaiKey, org: creds.openaiOrg, prompt: fullPrompt,
            seconds: soraSeconds, size, model: soraModel, log: (m) => process.stderr.write(m + '\n'),
        });
    } catch (e) {
        // Don't fail the job — fall back to Veo on Vertex if Sora is unavailable.
        console.error(`WARN: OpenAI Sora unavailable (${e.message}). Falling back to Veo on Vertex.`);
        try {
            requireCredential(creds, 'googleProject', 'GOOGLE_CLOUD_PROJECT');
            requireCredential(creds, 'googleCredsPath', 'GOOGLE_APPLICATION_CREDENTIALS');
            const sa = JSON.parse((await import('node:fs')).readFileSync(creds.googleCredsPath, 'utf8'));
            const token = await getVertexAccessToken(sa);
            const response = await runVeoJob({
                token, project: creds.googleProject, model: 'veo-3.1-generate-001',
                instances: [{ prompt: fullPrompt }],
                parameters: { durationSeconds: 8, aspectRatio: ratio, resolution, generateAudio: true, sampleCount: 1, personGeneration: 'allow_adult' },
            });
            buf = Buffer.from(extractVeoVideoB64(response), 'base64');
        } catch (veoErr) {
            console.error(`ERROR: Sora and Veo fallback both failed: ${veoErr.message}`);
            process.exit(2);
        }
    }
    const slug = args.name || prompt.split(/\s+/).slice(0, 6).join(' ');
    const outputPath = pickOutputPath({ brand, type: 'video', name: slug, ext: 'mp4', explicit: args.output });
    (await import('node:fs')).writeFileSync(outputPath, buf);
    writeMeta(outputPath, {
        user_prompt: prompt, full_prompt: fullPrompt, duration_sec: soraSeconds,
        aspect_ratio: ratio, engine: 'openai', model: soraModel,
        brand_name: brand.name, cost_estimate_usd: soraCost,
    });
    console.log(`\nOUTPUT: ${outputPath}`);
    console.log(`Cost: ~$${soraCost.toFixed(2)} (OpenAI)`);
    process.exit(0);
}

// ─── Sora 2 on Azure OpenAI (spends the Azure grant) ──────────────────
if (engine === 'azure') {
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
        aspect_ratio: ratio, engine: 'azure', model: creds.azureOpenAIVideoDeployment,
        brand_name: brand.name, cost_estimate_usd: soraCost,
    });
    console.log(`\nOUTPUT: ${outputPath}`);
    console.log(`Cost: ~$${soraCost.toFixed(2)} (Azure grant)`);
    process.exit(0);
}

// ─── ElevenLabs Flows (Veo 3.1 via the ElevenLabs credit grant) ────────
// Docs: https://elevenlabs.io/docs/api-reference/flows/video/create  (POST /v1/flows/video, poll GET /v1/flows/video/{id}).
// Veo constraints: duration 4|6|8 s, aspect 16:9|9:16, resolution 720p|1080p|4K. Nothing is spent without --commit + --max-credits.
if (engine === 'elevenlabs') {
    const elModel = args.model || 'veo-3.1-fast-generate-001';
    if (!['veo-3.1-fast-generate-001', 'veo-3.1-generate-001'].includes(elModel)) {
        console.error(`--model for --engine elevenlabs must be veo-3.1-fast-generate-001 or veo-3.1-generate-001 (got '${elModel}')`);
        process.exit(1);
    }
    if (!['16:9', '9:16'].includes(ratio)) {
        console.error(`--ratio for --engine elevenlabs must be 16:9 or 9:16 (got '${ratio}')`);
        process.exit(1);
    }
    const elRes = String(resolution).toLowerCase() === '4k' ? '4K' : resolution;
    if (!['720p', '1080p', '4K'].includes(elRes)) {
        console.error(`--resolution for --engine elevenlabs must be 720p, 1080p or 4K (got '${resolution}')`);
        process.exit(1);
    }
    const elSecs = [4, 6, 8].reduce((a, b) => Math.abs(b - duration) < Math.abs(a - duration) ? b : a, 8);
    const { createClient, imageReferenceFromFile } = await import('../../ad-studio/el-client.mjs');
    const { planSpend, formatPlan, readLedger, SpendGuard } = await import('../../ad-studio/credit-guard.mjs');
    const job = { kind: 'video', model: elModel, resolution: elRes, audio, seconds: elSecs, label: `${elSecs}s ${ratio} ${elRes}${audio ? ' +audio' : ''}` };
    const maxCredits = args['max-credits'] === undefined ? undefined : Number(String(args['max-credits']).replace(/[,_]/g, ''));
    // `--commit false` / `--commit=0` mean NO (a bare Boolean('false') would have meant yes)
    const commit = truthy(args.commit) && !truthy(args['dry-run']) && !dryRun;
    const plan = planSpend({ jobs: [job], commit, maxCredits, allowUnknownRate: truthy(args['allow-unknown-rate']), ledger: readLedger() });
    console.log(formatPlan(plan, { maxCredits }));
    console.log('PROMPT:');
    console.log(`  ${fullPrompt}`);
    if (!commit) {
        console.log('Nothing was submitted. To spend: add --commit --max-credits N.');
        process.exit(0);
    }
    if (!plan.proceed) {
        for (const r of plan.reasons) console.error(`REFUSED: ${r}`);
        process.exit(2);
    }
    requireCredential(creds, 'elevenlabsKey', 'ELEVENLABS_API_KEY');
    const client = createClient({ apiKey: creds.elevenlabsKey, log: (m) => process.stderr.write(m + '\n') });
    const body = { model_id: elModel, prompt: fullPrompt, duration_secs: elSecs, aspect_ratio: ratio, resolution: elRes, generate_audio: audio };
    if (seedImage) body.start_frame = imageReferenceFromFile(seedImage);
    const guard = new SpendGuard({ client, maxCredits, runId: `gen-video-${Date.now()}` });
    let result;
    try { result = await guard.run(job, () => client.flowsVideoRun(body)); }
    catch (e) { console.error(`ERROR (ElevenLabs Flows): ${e.message}`); process.exit(2); }
    const slug = args.name || prompt.split(/\s+/).slice(0, 6).join(' ');
    const outputPath = pickOutputPath({ brand, type: 'video', name: slug, ext: 'mp4', explicit: args.output });
    writeFileSync(outputPath, result.buffer);
    writeMeta(outputPath, {
        user_prompt: prompt, full_prompt: fullPrompt, duration_sec: elSecs, aspect_ratio: ratio, resolution: elRes,
        native_audio: audio, seed_image: seedImage, engine: 'elevenlabs', model: elModel, generation_id: result.id,
        credits_spent: guard.spent, brand_name: brand.name,
    });
    console.log(`\nOUTPUT: ${outputPath}`);
    console.log(`Credits spent: ${guard.spent.toLocaleString()} (ElevenLabs grant)`);
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
