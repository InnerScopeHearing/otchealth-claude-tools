#!/usr/bin/env node
// gen-image.mjs — single-image generation for illustrations, icons, hero art,
// empty states, social graphics. Defaults to OpenAI GPT-image-1 (best general
// model) with optional --model imagen4 to route through Google Vertex AI
// Imagen 4 instead (better text rendering for store screenshot headlines).
//
// Usage:
//   node gen-image.mjs --prompt "..." [--kind illustration|icon|empty-state|hero|social]
//                      [--name slug] [--size 1024x1024] [--variants N]
//                      [--model gpt-image-1|dall-e-3|imagen4] [--quality high|medium|low]
//                      [--output path] [--brand path/to/brand.json] [--dry-run]
//
// Output: PNG at brand.output_root/<kind>/<slug>.png + <slug>.meta.json
//         Path is printed to stdout for the caller to pick up.

import { writeFileSync, readFileSync } from 'node:fs';
import {
    loadCredentials, requireCredential, resolveBrand, pickOutputPath,
    writeMeta, reportCost, parseArgs, brandPromptPrefix,
    resolveOpenAIProvider, requireAzureOpenAI, azureOpenAIUrl,
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
let model = args.model || 'gpt-image-1';
const quality = args.quality || 'high';
const brand = resolveBrand(args.brand);
const creds = loadCredentials();

// 'vertex' for Imagen; otherwise 'openai' or 'azure' (spends the Azure grant).
const provider = model.startsWith('imagen') ? 'vertex' : resolveOpenAIProvider(args);

// DALL-E 3 was retired (Mar 2026). Keep the old aliases working by routing
// them to gpt-image-1 instead of a dead endpoint.
if (model === 'dalle3' || model === 'dall-e-3') {
    console.error('NOTE: dall-e-3 was retired (Mar 2026); using gpt-image-1 instead.');
    model = 'gpt-image-1';
}

// Per-call estimated cost (2026 published rates; verify in vendor dashboard).
// Imagen 4 GA as of late 2025; Imagen 3 superseded. For video/avatars use
// gen-video.mjs / gen-avatar.mjs (Veo 3.1, native audio).
const COST_PER_IMAGE = {
    'gpt-image-1': 0.04,
    'dalle3': size === '1792x1024' || size === '1024x1792' ? 0.08 : 0.04,
    'dall-e-3': size === '1792x1024' || size === '1024x1792' ? 0.08 : 0.04,
    'imagen4': 0.04,
    'imagen4-fast': 0.02,
    'imagen4-ultra': 0.06,
    'imagen3': 0.03,  // legacy alias — routes to imagen4 for actual call
};
const costUsd = (COST_PER_IMAGE[model] || 0.05) * variants;

const fullPrompt = `${brandPromptPrefix(brand, kind)} ${prompt}`.trim();

reportCost({
    provider: provider === 'vertex' ? 'google-vertex' : provider,
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

async function callOpenAIImage({ prompt, size, n, useProvider }) {
    // gpt-image-1 always returns b64_json and rejects response_format. quality
    // is high|medium|low. The body is identical for direct OpenAI and Azure;
    // on Azure the deployment name (not a model field) selects the model.
    const body = { prompt, n, size, quality };
    let url, headers;
    if (useProvider === 'azure') {
        requireAzureOpenAI(creds, creds.azureOpenAIImageDeployment);
        url = azureOpenAIUrl(creds, creds.azureOpenAIImageDeployment, 'images/generations');
        headers = { 'Content-Type': 'application/json', 'api-key': creds.azureOpenAIKey };
    } else {
        requireCredential(creds, 'openaiKey', 'OPENAI_API_KEY');
        url = 'https://api.openai.com/v1/images/generations';
        headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${creds.openaiKey}` };
        if (creds.openaiOrg) headers['OpenAI-Organization'] = creds.openaiOrg;
        body.model = 'gpt-image-1';
    }
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!res.ok) {
        throw new Error(`${useProvider} image API ${res.status}: ${await res.text()}`);
    }
    const data = await res.json();
    return Promise.all((data.data || []).map(async (d) => {
        if (d.b64_json) return Buffer.from(d.b64_json, 'base64');
        const img = await fetch(d.url);
        return Buffer.from(await img.arrayBuffer());
    }));
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
    if (!res.ok) throw new Error(`Vertex Imagen 4 ${res.status}: ${await res.text()}`);
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
    if (provider === 'vertex') {
        buffers = await callImagen({ prompt: fullPrompt, n: variants });
    } else if (provider === 'azure') {
        // Azure is opt-in and its OpenAI models are pending quota — never let an
        // Azure problem fail the job when direct OpenAI can do it. Fall back.
        try {
            buffers = await callOpenAIImage({ prompt: fullPrompt, size, n: variants, useProvider: 'azure' });
        } catch (azErr) {
            console.error(`WARN: Azure image path unavailable (${azErr.message}). Falling back to direct OpenAI.`);
            buffers = await callOpenAIImage({ prompt: fullPrompt, size, n: variants, useProvider: 'openai' });
        }
    } else {
        buffers = await callOpenAIImage({ prompt: fullPrompt, size, n: variants, useProvider: 'openai' });
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
        kind, size, model, quality, variant: i + 1,
        brand_name: brand.name, brand_source: brand._source,
        cost_estimate_usd: costUsd / buffers.length,
    });
    outputs.push(outputPath);
});

console.log('OUTPUTS:');
outputs.forEach(p => console.log(`  ${p}`));
