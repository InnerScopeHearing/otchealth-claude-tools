#!/usr/bin/env node
// art-director.mjs — The $10M curation engine. Scores MULTIPLE candidate
// images against a fixed "does this look like a $10 million app" rubric, ranks
// them, and picks a winner with per-image fix notes. This is the comparative
// counterpart to review-asset.mjs (which critiques ONE image vs a brand
// profile): art-director judges a SET head to head so the generate → judge →
// curate loop can keep the best of N and throw the rest away.
//
// Usage:
//   node art-director.mjs --images a.png,b.png,c.png \
//        [--intent "FourVault splash hero, premium vault + mascot"] \
//        [--brand fourvault] [--model gpt-4o] [--out report.json] [--dry-run]
//
//   # or a glob/dir:
//   node art-director.mjs --dir /tmp/fv-keyart --intent "..."
//
// Prints a ranked scorecard to stdout and writes the JSON report to --out
// (default <dir>/art-director-report.json).

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, basename, dirname } from 'node:path';
import {
    loadCredentials, requireCredential, resolveBrand, parseArgs,
    resolveOpenAIProvider, requireAzureOpenAI, azureOpenAIUrl,
} from './_lib.mjs';

const args = parseArgs(process.argv);
const dryRun = Boolean(args['dry-run']);

// ── Resolve the candidate set ────────────────────────────────────────
let images = [];
if (args.images) {
    images = String(args.images).split(',').map((s) => s.trim()).filter(Boolean);
} else if (args.dir) {
    const dir = String(args.dir);
    images = readdirSync(dir)
        .filter((f) => /\.(png|jpg|jpeg|webp)$/i.test(f))
        .map((f) => join(dir, f))
        .sort();
}
if (images.length < 2) {
    console.error('art-director judges a SET. Pass --images a.png,b.png[,c.png] or --dir <folder> with >= 2 images.');
    console.error('For a single image vs a brand profile, use review-asset.mjs instead.');
    process.exit(1);
}

const brand = args.brand ? resolveBrand(args.brand) : null;
const creds = loadCredentials();
const model = args.model || 'gpt-4o';
const intent = args.intent || 'premium app key art / splash hero';
const outPath = args.out || join(args.dir ? String(args.dir) : dirname(images[0]), 'art-director-report.json');

// The $10M rubric. Six weighted dimensions; each scored 0-10. The weighted
// sum is the headline "ten_million_score" (0-100). These weights encode what
// separates a $10M-looking app from a DIY one: finish/polish and cohesion
// carry the most, because that is exactly where DIY assets fall apart.
const RUBRIC = [
    { key: 'finish_polish', weight: 0.25, desc: 'Production finish: lighting quality, render fidelity, edge cleanliness, depth, material realism. The single biggest DIY tell.' },
    { key: 'cohesion', weight: 0.20, desc: 'Every element reads as one art-directed piece (one light source, one palette, one world). No pasted-in mismatched stickers.' },
    { key: 'composition', weight: 0.18, desc: 'Focal hierarchy, balance, use of negative space, framing for the phone splash aspect, room for UI overlay.' },
    { key: 'premium_feel', weight: 0.17, desc: 'Does it feel like a $10M flagship app (Apple/Pixar/AAA-game tier) vs a template or clip-art.' },
    { key: 'on_brand', weight: 0.12, desc: 'Matches the brand palette, tone, and character roster. Penalize wrong colors or off-brand characters.' },
    { key: 'character_accuracy', weight: 0.08, desc: 'If named characters appear, they match the intended roster/species and are consistent. Penalize wrong species/roster.' },
];

const brandBrief = brand ? {
    name: brand.name,
    palette: brand.palette,
    voice_tone: brand.voice?.tone,
    do_not: brand.voice?.do_not,
    illustration_style: brand.illustration_style,
    style_references: brand.style_references,
    style_anti_references: brand.style_anti_references,
    audience: brand.audience,
} : null;

if (dryRun) {
    console.log(`Would judge ${images.length} candidates with ${model}:`);
    images.forEach((p) => console.log('  - ' + p));
    console.log(`Intent: ${intent}`);
    console.log(`Brand: ${brand ? brand.name : '(none)'}`);
    console.log('Rubric: ' + RUBRIC.map((r) => `${r.key}(${r.weight})`).join(', '));
    process.exit(0);
}

const provider = resolveOpenAIProvider(args);

function dataUrl(p) {
    const ext = extname(p).slice(1).toLowerCase();
    const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
        : ext === 'webp' ? 'image/webp' : 'image/png';
    return `data:${mime};base64,${readFileSync(p).toString('base64')}`;
}

const rubricText = RUBRIC.map((r, i) => `${i + 1}. ${r.key} (weight ${r.weight}): ${r.desc}`).join('\n');

const system = `You are the most discerning art director in the world, judging candidate art for a flagship mobile app that must look like it cost $10 million to make (Apple / Pixar / AAA-game production tier). You score a SET of candidates head to head against a fixed rubric and pick a winner. You are brutally honest and specific: vague praise is useless. The DIY tells you hunt for are: flat lighting, pasted-in mismatched elements, clip-art characters, muddy composition, low render fidelity, and off-brand color. Return STRICT JSON only.`;

const userText = `Asset intent: ${intent}
${brandBrief ? `\nBrand profile (JSON):\n${JSON.stringify(brandBrief, null, 2)}\n` : ''}
You are shown ${images.length} candidate images, in order, labeled CANDIDATE 1..${images.length} (filenames: ${images.map((p, i) => `${i + 1}=${basename(p)}`).join(', ')}).

Score EACH candidate 0-10 on every rubric dimension:
${rubricText}

Return JSON with exactly this shape:
{
  "candidates": [
    {
      "index": <1-based int>,
      "filename": "<basename>",
      "scores": { "finish_polish": <0-10>, "cohesion": <0-10>, "composition": <0-10>, "premium_feel": <0-10>, "on_brand": <0-10>, "character_accuracy": <0-10> },
      "one_line": "<the single most important thing about this candidate>",
      "strengths": ["..."],
      "fixes": ["<specific, actionable changes to push it toward $10M>"],
      "dealbreakers": ["<anything that disqualifies it, or empty>"]
    }
  ],
  "winner_index": <1-based int>,
  "why_winner": "<why this one wins head to head>",
  "to_make_winner_10m": ["<the few concrete moves to take the winner from where it is to genuinely $10M>"]
}
Score all ${images.length} candidates. Do not omit any.`;

async function callVision(useProvider) {
    let url, headers;
    if (useProvider === 'azure') {
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
    const content = [{ type: 'text', text: userText }];
    images.forEach((p, i) => {
        content.push({ type: 'text', text: `\nCANDIDATE ${i + 1} (${basename(p)}):` });
        content.push({ type: 'image_url', image_url: { url: dataUrl(p) } });
    });
    const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
            model,
            response_format: { type: 'json_object' },
            messages: [
                { role: 'system', content: system },
                { role: 'user', content },
            ],
        }),
    });
    if (!res.ok) throw new Error(`${useProvider} vision ${res.status}: ${await res.text()}`);
    return res.json();
}

let data;
try {
    if (provider === 'azure') {
        try {
            data = await callVision('azure');
        } catch (azErr) {
            console.error(`WARN: Azure vision unavailable (${azErr.message}). Falling back to direct OpenAI.`);
            data = await callVision('openai');
        }
    } else {
        data = await callVision('openai');
    }
} catch (e) {
    console.error(`ERROR: ${e.message}`);
    process.exit(2);
}

const raw = data.choices?.[0]?.message?.content || '{}';
let result;
try {
    result = JSON.parse(raw);
} catch {
    console.error('Judge did not return valid JSON:\n' + raw);
    process.exit(2);
}

// Compute the weighted $10M score for each candidate from the rubric scores
// (we own the weighting, not the model, so the ranking is deterministic).
function tenMillionScore(scores) {
    let s = 0;
    for (const r of RUBRIC) {
        const v = Number(scores?.[r.key]);
        if (Number.isFinite(v)) s += Math.max(0, Math.min(10, v)) * r.weight;
    }
    return Math.round(s * 10); // 0-100
}

const cands = (result.candidates || []).map((c) => ({
    ...c,
    ten_million_score: tenMillionScore(c.scores),
})).sort((a, b) => b.ten_million_score - a.ten_million_score);

// Trust the deterministic weighted ranking for the winner; keep the model's
// rationale.
const winner = cands[0];

const report = {
    intent,
    brand: brand ? brand.name : null,
    model,
    judged_at: new Date().toISOString(),
    candidate_count: images.length,
    ranked: cands,
    winner: winner ? { index: winner.index, filename: winner.filename, ten_million_score: winner.ten_million_score } : null,
    why_winner: result.why_winner || '',
    to_make_winner_10m: result.to_make_winner_10m || [],
};
writeFileSync(outPath, JSON.stringify(report, null, 2));

// ── Pretty scorecard ─────────────────────────────────────────────────
console.log(`\n$10M ART DIRECTOR — ${images.length} candidates judged (${model})`);
console.log('='.repeat(64));
for (const c of cands) {
    const medal = c.index === winner.index ? ' ★ WINNER' : '';
    console.log(`\n[${c.ten_million_score}/100] CANDIDATE ${c.index}: ${c.filename}${medal}`);
    console.log(`  ${c.one_line || ''}`);
    const sc = c.scores || {};
    console.log('  ' + RUBRIC.map((r) => `${r.key}=${sc[r.key] ?? '?'}`).join('  '));
    if (c.dealbreakers && c.dealbreakers.length) {
        console.log('  DEALBREAKERS: ' + c.dealbreakers.join('; '));
    }
    if (c.fixes && c.fixes.length) {
        console.log('  FIXES:');
        c.fixes.forEach((f) => console.log('    - ' + f));
    }
}
console.log('\n' + '='.repeat(64));
console.log(`WINNER: candidate ${winner.index} (${winner.filename}) at ${winner.ten_million_score}/100`);
console.log(`WHY: ${report.why_winner}`);
if (report.to_make_winner_10m.length) {
    console.log('TO REACH $10M:');
    report.to_make_winner_10m.forEach((m) => console.log('  - ' + m));
}
console.log(`\nREPORT: ${outPath}`);
