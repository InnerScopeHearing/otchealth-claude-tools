// Shared utilities for the designer skill scripts.
//
// What lives here:
//   - Brand-profile resolution (project-local → home → default)
//   - Credential loading (env vars → ~/.designer/credentials.env)
//   - Output-path management (assets/generated/<type>/<slug>.<ext> + .meta.json)
//   - Cost reporting + dry-run guard
//   - Shared logging
//
// Imported by every gen-* script. Single source of truth so each script stays small.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname, basename, extname, join } from 'node:path';
import { homedir } from 'node:os';

const HOME = homedir();
const SKILL_HOME = resolve(HOME, '.claude/skills/designer');
const USER_HOME = resolve(HOME, '.designer');

// ─── Credentials ──────────────────────────────────────────────────────
// Order of precedence: process.env → ~/.designer/credentials.env (KEY=value lines)
export function loadCredentials() {
    const envFile = resolve(USER_HOME, 'credentials.env');
    if (existsSync(envFile)) {
        const content = readFileSync(envFile, 'utf8');
        for (const line of content.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            const idx = trimmed.indexOf('=');
            if (idx === -1) continue;
            const key = trimmed.slice(0, idx).trim();
            let value = trimmed.slice(idx + 1).trim();
            if ((value.startsWith('"') && value.endsWith('"')) ||
                (value.startsWith("'") && value.endsWith("'"))) {
                value = value.slice(1, -1);
            }
            if (!(key in process.env)) process.env[key] = value;
        }
    }
    return {
        openaiKey: process.env.OPENAI_API_KEY,
        openaiOrg: process.env.OPENAI_ORG_ID,
        googleCredsPath: process.env.GOOGLE_APPLICATION_CREDENTIALS,
        googleProject: process.env.GOOGLE_CLOUD_PROJECT,
        elevenlabsKey: process.env.ELEVENLABS_API_KEY,
        recraftKey: process.env.RECRAFT_API_KEY,
        // Azure (optional — present only once the Azure resources are provisioned
        // and their keys land in Secret Manager). See setup/fetch-secrets.mjs.
        azureOpenAIEndpoint: process.env.AZURE_OPENAI_ENDPOINT,
        azureOpenAIKey: process.env.AZURE_OPENAI_API_KEY,
        azureOpenAIApiVersion: process.env.AZURE_OPENAI_API_VERSION || '2025-04-01-preview',
        azureOpenAIImageDeployment: process.env.AZURE_OPENAI_IMAGE_DEPLOYMENT,
        azureOpenAIVisionDeployment: process.env.AZURE_OPENAI_VISION_DEPLOYMENT,
        azureSpeechKey: process.env.AZURE_SPEECH_KEY,
        azureSpeechRegion: process.env.AZURE_SPEECH_REGION,
    };
}

export function requireCredential(creds, key, friendlyName) {
    if (!creds[key]) {
        console.error(`ERROR: missing credential ${friendlyName}.`);
        console.error(`  Set it in process.env or in ~/.designer/credentials.env.`);
        console.error(`  Run \`bash ${SKILL_HOME}/scripts/setup.sh\` for a guided setup.`);
        process.exit(2);
    }
}

// ─── Brand profile resolution ─────────────────────────────────────────
// Order: $PWD/.designer/brand.json → $PWD/brand.json → $PWD/BRAND.md
//      → ~/.designer/brand-profiles/<basename-of-pwd>.json
//      → ~/.claude/skills/designer/brand-profiles/default.json
export function resolveBrand(overridePath) {
    const cwd = process.cwd();
    const candidates = [
        overridePath,
        resolve(cwd, '.designer/brand.json'),
        resolve(cwd, 'brand.json'),
        resolve(USER_HOME, `brand-profiles/${basename(cwd)}.json`),
        resolve(SKILL_HOME, 'brand-profiles/default.json'),
    ].filter(Boolean);

    for (const p of candidates) {
        if (existsSync(p)) {
            try {
                const profile = JSON.parse(readFileSync(p, 'utf8'));
                profile._source = p;
                return profile;
            } catch (e) {
                console.error(`WARN: could not parse brand profile at ${p}: ${e.message}`);
            }
        }
    }
    throw new Error('No brand profile found and default is missing — reinstall the designer skill.');
}

// ─── Output paths ─────────────────────────────────────────────────────
export function ensureOutputDir(brand, type) {
    const root = brand.output_root || 'assets/generated';
    const dir = resolve(process.cwd(), root, type);
    mkdirSync(dir, { recursive: true });
    return dir;
}

export function slugify(text) {
    return String(text || 'asset')
        .toLowerCase()
        .replace(/[^\w\s-]/g, '')
        .replace(/[\s_-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60) || 'asset';
}

export function pickOutputPath({ brand, type, name, ext, explicit }) {
    if (explicit) {
        const p = resolve(process.cwd(), explicit);
        mkdirSync(dirname(p), { recursive: true });
        return p;
    }
    const dir = ensureOutputDir(brand, type);
    const slug = slugify(name);
    return resolve(dir, `${slug}.${ext}`);
}

export function writeMeta(outputPath, meta) {
    const metaPath = outputPath.replace(/\.[^.]+$/, '.meta.json');
    writeFileSync(metaPath, JSON.stringify({
        ...meta,
        output: outputPath,
        generated_at: new Date().toISOString(),
    }, null, 2));
    return metaPath;
}

// ─── Cost reporting ───────────────────────────────────────────────────
export function reportCost({ provider, model, units, costUsd, dryRun }) {
    const tag = dryRun ? '[DRY-RUN]' : '[BILLED]';
    console.log(`${tag} ${provider}/${model}: ${units} → ~$${costUsd.toFixed(3)}`);
}

// ─── Arg parsing (minimal, dep-free) ──────────────────────────────────
export function parseArgs(argv) {
    const args = { _: [] };
    const arr = argv.slice(2);
    for (let i = 0; i < arr.length; i++) {
        const a = arr[i];
        if (a.startsWith('--')) {
            const key = a.slice(2);
            const next = arr[i + 1];
            if (next === undefined || next.startsWith('--')) {
                args[key] = true;
            } else {
                args[key] = next;
                i++;
            }
        } else if (a.startsWith('-') && a.length === 2) {
            args[a.slice(1)] = arr[i + 1];
            i++;
        } else {
            args._.push(a);
        }
    }
    return args;
}

// ─── Brand → prompt prefix ────────────────────────────────────────────
// Every generator prepends this brand context to the user's prompt so
// generated assets land on-style without needing the user to repeat it.
export function brandPromptPrefix(brand, assetKind) {
    const parts = [];
    if (brand.palette) {
        const pal = brand.palette;
        parts.push(`Brand colors: primary ${pal.primary}${pal.primary_deep ? `, deep ${pal.primary_deep}` : ''}${pal.accent ? `, accent ${pal.accent}` : ''}.`);
    }
    if (assetKind === 'illustration' && brand.illustration_style) {
        parts.push(`Illustration style: ${brand.illustration_style}`);
    }
    if (assetKind === 'icon' && brand.icon_style) {
        parts.push(`Icon style: ${brand.icon_style}`);
    }
    if (brand.style_references && brand.style_references.length) {
        parts.push(`Reference brands to mimic: ${brand.style_references.join(', ')}.`);
    }
    if (brand.style_anti_references && brand.style_anti_references.length) {
        parts.push(`Avoid: ${brand.style_anti_references.join('; ')}.`);
    }
    return parts.join(' ');
}

// ─── Vertex AI / Veo helpers ──────────────────────────────────────────
// Shared by gen-video.mjs and gen-avatar.mjs. The Veo family (2.0, 3.0,
// 3.1) all use the same asynchronous predictLongRunning + poll contract,
// so the auth + submit + poll loop lives here once.

// Mint a short-lived Vertex access token from a service-account key object
// (the parsed JSON of GOOGLE_APPLICATION_CREDENTIALS).
export async function getVertexAccessToken(sa) {
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

// Submit a Veo predictLongRunning job and poll until it finishes.
// Returns the raw `response` object from the completed operation so the
// caller can pull bytes/uri out of it (see extractVeoVideoB64).
export async function runVeoJob({
    token, project, location = 'us-central1', model,
    instances, parameters, maxPolls = 120, intervalMs = 5000, log = console.error,
}) {
    const base = `https://${location}-aiplatform.googleapis.com/v1`;
    const submitUrl = `${base}/projects/${project}/locations/${location}/publishers/google/models/${model}:predictLongRunning`;
    log(`Submitting ${model} job...`);
    const submitRes = await fetch(submitUrl, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ instances, parameters }),
    });
    if (!submitRes.ok) {
        throw new Error(`Submit failed ${submitRes.status}: ${await submitRes.text()}`);
    }
    const operationName = (await submitRes.json()).name;
    log(`  job: ${operationName}`);

    // Veo long-running ops are NOT polled with a GET on the operation URL —
    // that 404s. You POST the operation name to :fetchPredictOperation on the
    // same model endpoint and read `done` / `response` off the result.
    const fetchUrl = `${base}/projects/${project}/locations/${location}/publishers/google/models/${model}:fetchPredictOperation`;
    for (let i = 0; i < maxPolls; i++) {
        await new Promise(r => setTimeout(r, intervalMs));
        process.stderr.write(`  polling (${i + 1})... `);
        const pollRes = await fetch(fetchUrl, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ operationName }),
        });
        if (!pollRes.ok) {
            process.stderr.write(`HTTP ${pollRes.status}\n`);
            continue;
        }
        const poll = await pollRes.json();
        if (poll.done) {
            process.stderr.write('done\n');
            if (poll.error) throw new Error(`Job failed: ${JSON.stringify(poll.error)}`);
            return poll.response;
        }
        process.stderr.write('still running\n');
    }
    throw new Error(`Timed out polling ${model} after ${(maxPolls * intervalMs / 60000).toFixed(0)} minutes.`);
}

// Pull the generated MP4 (base64) out of a completed Veo response. Veo
// returns inline bytes by default; a gcsUri appears only when an output
// storageUri was requested, which these scripts don't do.
export function extractVeoVideoB64(response) {
    const b64 = response?.videos?.[0]?.bytesBase64Encoded
        || response?.predictions?.[0]?.bytesBase64Encoded;
    if (b64) return b64;
    const uri = response?.videos?.[0]?.gcsUri || response?.predictions?.[0]?.gcsUri;
    if (uri) {
        throw new Error(`Veo returned a GCS URI (${uri}) instead of inline bytes — fetch it from Cloud Storage, or omit any output storageUri.`);
    }
    throw new Error(`Job done but no video bytes in response: ${JSON.stringify(response).slice(0, 500)}`);
}

// ─── OpenAI provider routing (direct OpenAI vs Azure OpenAI) ──────────
// Both back the same models (gpt-image-1, gpt-4o). Routing to Azure spends
// the Azure grant instead of direct-OpenAI credits. Precedence:
//   --provider flag  →  DESIGNER_OPENAI_PROVIDER env  →  'openai'
export function resolveOpenAIProvider(args) {
    const choice = (args && args.provider) || process.env.DESIGNER_OPENAI_PROVIDER || 'openai';
    if (choice !== 'azure' && choice !== 'openai') {
        throw new Error(`--provider must be 'openai' or 'azure' (got '${choice}')`);
    }
    return choice;
}

// Preflight the Azure OpenAI config on the real call path (not during dry-run).
export function requireAzureOpenAI(creds, deployment) {
    const missing = [];
    if (!creds.azureOpenAIEndpoint) missing.push('azure-openai-endpoint');
    if (!creds.azureOpenAIKey) missing.push('azure-openai-key');
    if (!deployment) missing.push('a deployment name (azure-openai-*-deployment)');
    if (missing.length) {
        throw new Error(
            `Azure provider selected but not fully configured. Missing: ${missing.join(', ')}.\n` +
            '  Add these to GCP Secret Manager — see setup/fetch-secrets.mjs.'
        );
    }
}

// Build the Azure OpenAI REST URL for a given deployment + operation, e.g.
//   azureOpenAIUrl(creds, deployment, 'images/generations')
export function azureOpenAIUrl(creds, deployment, op) {
    if (!deployment) {
        throw new Error(`Azure OpenAI deployment name missing for '${op}'. Set the matching azure-openai-*-deployment secret.`);
    }
    const base = creds.azureOpenAIEndpoint.replace(/\/+$/, '');
    return `${base}/openai/deployments/${deployment}/${op}?api-version=${creds.azureOpenAIApiVersion}`;
}

export const PATHS = { SKILL_HOME, USER_HOME };
