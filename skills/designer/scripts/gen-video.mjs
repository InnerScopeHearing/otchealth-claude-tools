#!/usr/bin/env node
// gen-video.mjs — Generate AI video via Google Vertex AI Veo 2 (best
// general-purpose model as of Jan 2026). Supports text-to-video for hero
// marketing clips and image-to-video for animating still illustrations.
//
// Usage:
//   node gen-video.mjs --prompt "..." [--duration 8] [--ratio 16:9|9:16|1:1]
//                      [--seed-image path.png] [--output marketing/preview.mp4]
//                      [--dry-run]
//
// Output: MP4 at brand.output_root/video/<slug>.mp4 + .meta.json.
//         Veo 2 jobs are asynchronous — script polls until ready then downloads.

import { writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
    loadCredentials, requireCredential, resolveBrand, pickOutputPath,
    writeMeta, reportCost, parseArgs, brandPromptPrefix,
} from './_lib.mjs';

const args = parseArgs(process.argv);
const dryRun = Boolean(args['dry-run']);
const prompt = args.prompt || args.p;
const duration = parseInt(args.duration || '8', 10);
const ratio = args.ratio || '16:9';
const seedImage = args['seed-image'];

if (!prompt) {
    console.error('Usage: gen-video.mjs --prompt "..." [--duration N] [--ratio 16:9|9:16|1:1]');
    process.exit(1);
}

const brand = resolveBrand(args.brand);
const creds = loadCredentials();

// Veo 2 published rate (Jan 2026): ~$0.35/sec
const costUsd = duration * 0.35;
reportCost({
    provider: 'google-vertex', model: 'veo-2',
    units: `${duration}s ${ratio}${seedImage ? ' (i2v)' : ''}`,
    costUsd, dryRun,
});

const fullPrompt = `${brandPromptPrefix(brand, 'illustration')} ${prompt}`.trim();

if (dryRun) {
    console.log('PROMPT:');
    console.log(`  ${fullPrompt}`);
    console.log(`Would have written ~${duration}s MP4 to ${brand.output_root}/video/`);
    process.exit(0);
}

requireCredential(creds, 'googleProject', 'GOOGLE_CLOUD_PROJECT');
requireCredential(creds, 'googleCredsPath', 'GOOGLE_APPLICATION_CREDENTIALS');

const sa = JSON.parse(readFileSync(creds.googleCredsPath, 'utf8'));

async function getToken() {
    const crypto = await import('node:crypto');
    const header = { alg: 'RS256', typ: 'JWT' };
    const now = Math.floor(Date.now() / 1000);
    const claim = {
        iss: sa.client_email,
        scope: 'https://www.googleapis.com/auth/cloud-platform',
        aud: 'https://oauth2.googleapis.com/token',
        iat: now, exp: now + 3600,
    };
    const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const signingInput = `${enc(header)}.${enc(claim)}`;
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(signingInput);
    const sig = signer.sign(sa.private_key, 'base64url');
    const jwt = `${signingInput}.${sig}`;
    const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${encodeURIComponent(jwt)}`,
    });
    if (!res.ok) throw new Error(`Token exchange ${res.status}: ${await res.text()}`);
    return (await res.json()).access_token;
}

const token = await getToken();
const LOCATION = 'us-central1';
const MODEL = 'veo-2.0-generate-001';

// Submit job
const instance = { prompt: fullPrompt };
if (seedImage) {
    instance.image = {
        bytesBase64Encoded: readFileSync(seedImage).toString('base64'),
        mimeType: 'image/png',
    };
}
const body = {
    instances: [instance],
    parameters: {
        durationSeconds: duration,
        aspectRatio: ratio,
        sampleCount: 1,
    },
};

console.log('Submitting Veo 2 job...');
const submitRes = await fetch(
    `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${creds.googleProject}/locations/${LOCATION}/publishers/google/models/${MODEL}:predictLongRunning`,
    {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    }
);
if (!submitRes.ok) {
    console.error(`Submit failed ${submitRes.status}: ${await submitRes.text()}`);
    process.exit(2);
}
const submitData = await submitRes.json();
const operationName = submitData.name;
console.log(`  job: ${operationName}`);

// Poll
const opUrl = `https://${LOCATION}-aiplatform.googleapis.com/v1/${operationName}`;
let videoB64 = null;
for (let i = 0; i < 120; i++) {  // up to ~10 min
    await new Promise(r => setTimeout(r, 5000));
    process.stderr.write(`  polling (${i + 1})... `);
    const pollRes = await fetch(opUrl, { headers: { 'Authorization': `Bearer ${token}` } });
    if (!pollRes.ok) {
        process.stderr.write(`HTTP ${pollRes.status}\n`);
        continue;
    }
    const poll = await pollRes.json();
    if (poll.done) {
        process.stderr.write('done\n');
        if (poll.error) {
            console.error(`Job failed: ${JSON.stringify(poll.error)}`);
            process.exit(2);
        }
        // Veo 2 returns the video bytes in poll.response.videos[0].bytesBase64Encoded
        videoB64 = poll.response?.videos?.[0]?.bytesBase64Encoded
            || poll.response?.predictions?.[0]?.bytesBase64Encoded;
        if (!videoB64) {
            console.error('Job done but no video bytes in response:', JSON.stringify(poll.response).slice(0, 500));
            process.exit(2);
        }
        break;
    }
    process.stderr.write('still running\n');
}
if (!videoB64) {
    console.error('Timed out polling Veo 2 job after 10 minutes.');
    process.exit(2);
}

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
    seed_image: seedImage,
    model: MODEL,
    brand_name: brand.name,
    cost_estimate_usd: costUsd,
});

console.log(`\nOUTPUT: ${outputPath}`);
console.log(`Cost: ~$${costUsd.toFixed(2)}`);
