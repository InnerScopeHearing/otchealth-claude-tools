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

export const PATHS = { SKILL_HOME, USER_HOME };
