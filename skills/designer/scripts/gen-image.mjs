#!/usr/bin/env node
// gen-image.mjs — single-image generation for illustrations, icons, hero art,
// empty states, social graphics. Defaults to OpenAI DALL-E 3 (best general
// model) with optional --model imagen3 to route through Google Vertex AI
// Imagen 3 instead (better text rendering for store screenshot headlines).
//
// Usage:
//   node gen-image.mjs --prompt "..." [--kind illustration|icon|empty-state|hero|social]
//                      [--name slug] [--size 1024x1024] [--variants N]
//                      [--model dalle3|imagen3|gpt-image-1] [--output path]
//                      [--brand path/to/brand.json] [--dry-run]
//
// Output: PNG at brand.output_root/<kind>/<slug>.png + <slug>.meta.json
//         Path is printed to stdout for the caller to pick up.

import { writeFileSync, readFileSync } from 'node:fs';
import {
    loadCredentials, requireCredential, resolveBrand, pickOutputPath,
    writeMeta, reportCost, parseArgs, brandPromptPrefix,
} from './_lib.mjs';

const args = parseArgs(process.argv);
const dryRun = Boolean(args['dry-run']);
const prompt = args.prompt || args.p;
if (!prompt) {
    console.error('Usage: gen-image.mjs --prompt "..." [--kind illustration|icon|empty-state|hero|social]');
    process.exit(1);
}

const kind = args.kind || 'illustration';
const size = args.size || (kind === 'icon' ? '1024x1024' : '1024x1024');
const variants = parseInt(args.variants || '1', 10);
const model = args.model || 'gpt-image-1';
const brand = resolveBrand(args.brand);
const creds = loadCredentials();

// Per-call estimated cost (May-2026 published rates; verify in vendor dashboard).
// Imagen 4 GA as of late 2025; Imagen 3 superseded. Veo 3/3.1 are Preview as
// of May 2026 and are deliberately not supported here — use Veo 2 via
// gen-video.mjs for video.
const COST_PER_IMAGE = {
    'gpt-image-1': 0.04,
    'gpt-image-1.5': 0.06,
    'gpt-image-1-mini': 0.02,
    // dall-e-3 was retired on OpenAI accounts in the gpt-image era; these aliases
    // route to gpt-image-1 so older invocations keep working.
    'dalle3': 0.04,
    'dall-e-3': 0.04,
    'imagen4': 0.04,
    'imagen4-fast': 0.02,
    'imagen4-ultra': 0.06,
    'imagen3': 0.03,  // legacy alias — routes to imagen4 for actual call
};
const costUsd = (COST_PER_IMAGE[model] || 0.05) * variants;

const fullPrompt = `${brandPromptPrefix(brand, kind)} ${prompt}`.trim();

reportCost({
    provider: model.startsWith('imagen') ? 'google-vertex' : 'openai',
    model,
    units: `${variants}x ${size}`,
    costUsd,
    dryRun,
});

if (dryRun) {
    console.log('PROMPT:');
    console.log(`  ${fullPrompt}`);
    console.log('OUTPUT (would have written):');
    const slug = args.name || prompt.split(/\s+/).slice(0, 6).join(' ');
    const out = pickOutputPath({ brand, type: kind, name: slug, ext: 'png', explicit: args.output });
    console.log(`  ${out}`);
    process.exit(0);
}

// OpenAI Images via the gpt-image-* family. Notes (verified against the live API,
// May 2026): dall-e-3 is retired on current accounts; the model is gpt-image-1
// (or 1.5/mini). The `response_format` parameter was removed — these models always
// return base64 in data[i].b64_json. `quality` takes high|medium|low (not hd).
async function callOpenAIImage({ prompt, size, n }) {
    requireCredential(creds, 'openaiKey', 'OPENAI_API_KEY');
    const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${creds.openaiKey}` };
    if (creds.openaiOrg) headers['OpenAI-Organization'] = creds.openaiOrg;
    // Retired/alias model names route to the current default.
    const apiModel = (model === 'dalle3' || model === 'dall-e-3') ? 'gpt-image-1' : model;
    const body = { model: apiModel, prompt, n, size };
    if (args.quality) body.quality = args.quality;  // high|medium|low, optional
    const res = await fetch('https://api.openai.com/v1/images/generations', {
        method: 'POST', headers, body: JSON.stringify(body),
    });
    if (!res.ok) {
        throw new Error(`OpenAI image API ${res.status}: ${await res.text()}`);
    }
    const data = await res.json();
    return data.data.map(d => Buffer.from(d.b64_json, 'base64'));
}

async function callImagen({ prompt, n }) {
    requireCredential(creds, 'googleProject', 'GOOGLE_CLOUD_PROJECT');
    requireCredential(creds, 'googleCredsPath', 'GOOGLE_APPLICATION_CREDENTIALS');
    // Vertex AI Imagen 4 is GA as of 2025 (preview IDs retired Nov 30, 2025).
    // Imagen 4 model IDs: imagen-4.0-generate-001 (standard), imagen-4.0-ultra-
    // generate-001 (ultra), imagen-4.0-fast-generate-001 (fast). Default to
    // -001 for the balance of quality + cost.
    const sa = JSON.parse(readFileSync(creds.googleCredsPath, 'utf8'));
    const token = await getGoogleAccessToken(sa);
    const imagenModel = model === 'imagen4-ultra' ? 'imagen-4.0-ultra-generate-001'
                      : model === 'imagen4-fast' ? 'imagen-4.0-fast-generate-001'
                      : 'imagen-4.0-generate-001';
    const url = `https://us-central1-aiplatform.googleapis.com/v1/projects/${creds.googleProject}/locations/us-central1/publishers/google/models/${imagenModel}:predict`;
    const body = {
        instances: [{ prompt }],
        parameters: { sampleCount: n, aspectRatio: '1:1' },
    };
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Vertex Imagen 3 ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return (data.predictions || []).map(p => Buffer.from(p.bytesBase64Encoded, 'base64'));
}

async function getGoogleAccessToken(sa) {
    // Self-sign a JWT and exchange for an access token. Avoids needing gcloud CLI.
    const jwt = await import('node:crypto').then(async (crypto) => {
        const header = { alg: 'RS256', typ: 'JWT' };
        const now = Math.floor(Date.now() / 1000);
        const claim = {
            iss: sa.client_email,
            scope: 'https://www.googleapis.com/auth/cloud-platform',
            aud: 'https://oauth2.googleapis.com/token',
            iat: now,
            exp: now + 3600,
        };
        const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
        const signingInput = `${enc(header)}.${enc(claim)}`;
        const signer = crypto.createSign('RSA-SHA256');
        signer.update(signingInput);
        const sig = signer.sign(sa.private_key, 'base64url');
        return `${signingInput}.${sig}`;
    });
    const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${encodeURIComponent(jwt)}`,
    });
    if (!res.ok) throw new Error(`Google token exchange ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return data.access_token;
}

let buffers;
try {
    if (model.startsWith('imagen')) {
        buffers = await callImagen({ prompt: fullPrompt, n: variants });
    } else {
        buffers = await callOpenAIImage({ prompt: fullPrompt, size, n: variants });
    }
} catch (e) {
    console.error(`ERROR: ${e.message}`);
    process.exit(2);
}

const slug = args.name || prompt.split(/\s+/).slice(0, 6).join(' ');
const outputs = [];
buffers.forEach((buf, i) => {
    const suffix = buffers.length > 1 ? `-v${i + 1}` : '';
    const outputPath = pickOutputPath({
        brand, type: kind, name: `${slug}${suffix}`, ext: 'png',
        explicit: i === 0 ? args.output : null,
    });
    writeFileSync(outputPath, buf);
    writeMeta(outputPath, {
        prompt: fullPrompt,
        user_prompt: prompt,
        kind, size, model, variant: i + 1,
        brand_name: brand.name, brand_source: brand._source,
        cost_estimate_usd: costUsd / buffers.length,
    });
    outputs.push(outputPath);
});

console.log('OUTPUTS:');
outputs.forEach(p => console.log(`  ${p}`));
