#!/usr/bin/env node
// review-asset.mjs — Art-director critique of a generated asset using an
// OpenAI vision model. Scores brand fit, flags anything that violates the
// brand profile's do_not / anti-reference rules, and hands back a refined
// generation prompt you can feed straight into gen-image / gen-avatar.
//
// This closes the generate → review → refine loop automatically so Claude
// can iterate toward the best result without a human eye on every pass.
//
// Usage:
//   node review-asset.mjs --image assets/generated/illustration/hero.png \
//        [--intent "onboarding hero, warm + reassuring"] \
//        [--model gpt-4o] [--dry-run]
//
// Prints a JSON critique to stdout and writes <image>.review.json alongside.

import { readFileSync, writeFileSync } from 'node:fs';
import { extname } from 'node:path';
import {
    loadCredentials, requireCredential, resolveBrand, parseArgs,
    resolveOpenAIProvider, requireAzureOpenAI, azureOpenAIUrl,
} from './_lib.mjs';

const args = parseArgs(process.argv);
const dryRun = Boolean(args['dry-run']);
const imagePath = args.image || args.i;
if (!imagePath) {
    console.error('Usage: review-asset.mjs --image path.png [--intent "..."] [--model gpt-4o]');
    process.exit(1);
}

const brand = resolveBrand(args.brand);
const creds = loadCredentials();
const model = args.model || 'gpt-4o';
const intent = args.intent || 'on-brand marketing asset';

// Compact brand brief the reviewer judges against.
const brandBrief = {
    name: brand.name,
    palette: brand.palette,
    voice_tone: brand.voice?.tone,
    do_not: brand.voice?.do_not,
    illustration_style: brand.illustration_style,
    icon_style: brand.icon_style,
    style_references: brand.style_references,
    style_anti_references: brand.style_anti_references,
    audience: brand.audience,
};

if (dryRun) {
    console.log(`Would review ${imagePath} with ${model} against brand "${brand.name}".`);
    console.log('Brand brief:');
    console.log(JSON.stringify(brandBrief, null, 2));
    process.exit(0);
}

const provider = resolveOpenAIProvider(args);

const ext = extname(imagePath).slice(1).toLowerCase();
const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
    : ext === 'webp' ? 'image/webp' : 'image/png';
const dataUrl = `data:${mime};base64,${readFileSync(imagePath).toString('base64')}`;

const system = `You are a meticulous art director and brand guardian. You judge a generated visual asset against a brand profile and return STRICT JSON only. Be specific and honest — call out off-brand color, style, or anything that violates the do_not rules. The refined_prompt must be a ready-to-use text-to-image prompt that fixes the issues while keeping what works.`;

const userText = `Brand profile (JSON):
${JSON.stringify(brandBrief, null, 2)}

Asset intent: ${intent}

Evaluate the attached image. Return JSON with exactly these keys:
{
  "brand_fit": <integer 0-10>,
  "verdict": "<ship | refine | reject>",
  "strengths": ["..."],
  "issues": ["..."],
  "violations": ["<any do_not / anti-reference breaches, or empty>"],
  "refined_prompt": "<an improved generation prompt to fix the issues>"
}`;

let url, headers;
if (provider === 'azure') {
    requireAzureOpenAI(creds, creds.azureOpenAIVisionDeployment);
    url = azureOpenAIUrl(creds, creds.azureOpenAIVisionDeployment, 'chat/completions');
    headers = { 'Content-Type': 'application/json', 'api-key': creds.azureOpenAIKey };
} else {
    requireCredential(creds, 'openaiKey', 'OPENAI_API_KEY');
    url = 'https://api.openai.com/v1/chat/completions';
    headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${creds.openaiKey}`,
        ...(creds.openaiOrg ? { 'OpenAI-Organization': creds.openaiOrg } : {}),
    };
}

const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
        // On Azure the deployment selects the model; the model field is ignored.
        model,
        response_format: { type: 'json_object' },
        messages: [
            { role: 'system', content: system },
            {
                role: 'user',
                content: [
                    { type: 'text', text: userText },
                    { type: 'image_url', image_url: { url: dataUrl } },
                ],
            },
        ],
    }),
});
if (!res.ok) {
    console.error(`${provider} vision ${res.status}: ${await res.text()}`);
    process.exit(2);
}
const data = await res.json();
const raw = data.choices?.[0]?.message?.content || '{}';

let critique;
try {
    critique = JSON.parse(raw);
} catch {
    console.error('Reviewer did not return valid JSON:\n' + raw);
    process.exit(2);
}

const reviewPath = imagePath.replace(/\.[^.]+$/, '.review.json');
writeFileSync(reviewPath, JSON.stringify({
    image: imagePath, intent, model, brand_name: brand.name,
    reviewed_at: new Date().toISOString(), ...critique,
}, null, 2));

console.log(JSON.stringify(critique, null, 2));
console.log(`\nVERDICT: ${critique.verdict} (brand fit ${critique.brand_fit}/10)`);
console.log(`REVIEW: ${reviewPath}`);
