#!/usr/bin/env node
// healthcheck.mjs — probe every credential / API the designer skill depends on
// and report PASS/FAIL. Auth-only checks where possible (no generation spend).
//
// Usage: node healthcheck.mjs
// Exit code 0 if all required providers pass, 1 otherwise.

import { loadCredentials, getVertexAccessToken, PATHS } from './_lib.mjs';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const creds = loadCredentials();
const results = [];
const rec = (name, status, detail, required = true) => results.push({ name, status, detail, required });

async function timed(fn) { try { return await fn(); } catch (e) { return { _err: e.message }; } }

// 1) OpenAI (direct) — required, the default image/vision provider
if (creds.openaiKey) {
    const r = await timed(() => fetch('https://api.openai.com/v1/models', {
        headers: { Authorization: `Bearer ${creds.openaiKey}`, ...(creds.openaiOrg ? { 'OpenAI-Organization': creds.openaiOrg } : {}) },
    }));
    if (r._err) rec('OpenAI (direct)', 'FAIL', r._err);
    else if (r.ok) {
        const j = await r.json();
        const ids = (j.data || []).map(m => m.id);
        const img = ids.some(i => i.includes('gpt-image-1'));
        const vis = ids.some(i => i === 'gpt-4o' || i.startsWith('gpt-4o'));
        rec('OpenAI (direct)', 'PASS', `${ids.length} models · gpt-image-1:${img ? '✓' : '✗'} gpt-4o:${vis ? '✓' : '✗'}`);
    } else rec('OpenAI (direct)', 'FAIL', `HTTP ${r.status}: ${(await r.text()).slice(0, 100)}`);
} else rec('OpenAI (direct)', 'FAIL', 'OPENAI_API_KEY missing');

// 2) ElevenLabs — required for voice/music/sfx
if (creds.elevenlabsKey) {
    const r = await timed(() => fetch('https://api.elevenlabs.io/v1/user', { headers: { 'xi-api-key': creds.elevenlabsKey } }));
    if (r._err) rec('ElevenLabs', 'FAIL', r._err);
    else if (r.ok) {
        const j = await r.json(); const s = j.subscription || {};
        const used = s.character_count ?? '?', lim = s.character_limit ?? '?';
        rec('ElevenLabs', 'PASS', `tier ${s.tier || '?'} · ${used}/${lim} chars used`);
    } else rec('ElevenLabs', 'FAIL', `HTTP ${r.status}`);
} else rec('ElevenLabs', 'FAIL', 'ELEVENLABS_API_KEY missing');

// 3) Google Vertex AI — required for Imagen + Veo (video/avatars)
if (creds.googleCredsPath && creds.googleProject) {
    const r = await timed(async () => {
        const sa = JSON.parse(readFileSync(creds.googleCredsPath, 'utf8'));
        const token = await getVertexAccessToken(sa);
        return { email: sa.client_email, ok: !!token };
    });
    if (r._err) rec('Google Vertex AI', 'FAIL', r._err);
    else rec('Google Vertex AI', 'PASS', `SA token mint OK · ${r.email} · project ${creds.googleProject}`);
} else rec('Google Vertex AI', 'FAIL', 'GOOGLE_APPLICATION_CREDENTIALS / GOOGLE_CLOUD_PROJECT missing');

// 4) Azure OpenAI — optional. Auth-only probe against a real deployment:
// POST an empty body to chat/completions. 400 = authenticated; 401/403 = bad key.
if (creds.azureOpenAIEndpoint && creds.azureOpenAIKey) {
    const base = creds.azureOpenAIEndpoint.replace(/\/+$/, '');
    const dep = creds.azureOpenAIVisionDeployment || creds.azureOpenAIImageDeployment;
    if (!dep) {
        rec('Azure OpenAI', 'SKIP', 'endpoint+key set but no deployment name configured', false);
    } else {
        const r = await timed(() => fetch(`${base}/openai/deployments/${dep}/chat/completions?api-version=2024-10-21`, {
            method: 'POST', headers: { 'api-key': creds.azureOpenAIKey, 'Content-Type': 'application/json' }, body: '{}',
        }));
        if (r._err) rec('Azure OpenAI', 'FAIL', r._err, false);
        else if (r.status === 401 || r.status === 403) rec('Azure OpenAI', 'FAIL', `HTTP ${r.status} — key/endpoint auth failed`, false);
        else rec('Azure OpenAI', 'PASS', `auth OK @ ${dep} (HTTP ${r.status})`, false);
    }
} else rec('Azure OpenAI', 'SKIP', 'not configured (optional)', false);

// 5) Azure AI Speech — optional (TTS-Avatar engine)
if (creds.azureSpeechKey && creds.azureSpeechRegion) {
    const r = await timed(() => fetch(`https://${creds.azureSpeechRegion}.api.cognitive.microsoft.com/sts/v1.0/issueToken`, {
        method: 'POST', headers: { 'Ocp-Apim-Subscription-Key': creds.azureSpeechKey, 'Content-Length': '0' },
    }));
    if (r._err) rec('Azure AI Speech', 'FAIL', r._err, false);
    else if (r.ok) rec('Azure AI Speech', 'PASS', `token OK @ ${creds.azureSpeechRegion}`, false);
    else rec('Azure AI Speech', 'FAIL', `HTTP ${r.status} @ ${creds.azureSpeechRegion} (check key/region)`, false);
} else rec('Azure AI Speech', 'SKIP', 'not configured (optional)', false);

// 6) Azure service principal — optional (provisioning only)
const spId = process.env.AZURE_SP_CLIENT_ID, spSecret = process.env.AZURE_SP_CLIENT_SECRET, spTenant = process.env.AZURE_SP_TENANT_ID;
if (spId && spSecret && spTenant) {
    const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: spId, client_secret: spSecret, scope: 'https://management.azure.com/.default' });
    const r = await timed(() => fetch(`https://login.microsoftonline.com/${spTenant}/oauth2/v2.0/token`, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
    }));
    if (r._err) rec('Azure service principal', 'FAIL', r._err, false);
    else if (r.ok) rec('Azure service principal', 'PASS', 'client-credentials token OK', false);
    else rec('Azure service principal', 'FAIL', `HTTP ${r.status} — client secret likely wrong (provisioning only)`, false);
} else rec('Azure service principal', 'SKIP', 'not configured (optional)', false);

// 7) Recraft — optional (vectorize)
if (creds.recraftKey) {
    const r = await timed(() => fetch('https://external.api.recraft.ai/v1/users/me', { headers: { Authorization: `Bearer ${creds.recraftKey}` } }));
    rec('Recraft', r._err ? 'FAIL' : r.ok ? 'PASS' : 'FAIL', r._err || `HTTP ${r.status}`, false);
} else rec('Recraft', 'SKIP', 'not set — vectorize falls back to local potrace', false);

// 8) sharp (local image processing) — required for app-icon/screenshot/optimize.
// Resolve from wherever the installed skill lives, not just the cwd.
try { await import('sharp'); rec('sharp (local)', 'PASS', 'installed'); }
catch {
    if (existsSync(resolve(PATHS.SKILL_HOME, 'node_modules/sharp'))) {
        rec('sharp (local)', 'PASS', `installed in skill home (${PATHS.SKILL_HOME})`);
    } else {
        rec('sharp (local)', 'FAIL', 'not installed — run `npm install` in the skill dir');
    }
}

// ── Report ──
const pad = (s, n) => String(s).padEnd(n);
console.log('\nDesigner skill — connection / API health check');
console.log('─'.repeat(78));
console.log(`${pad('PROVIDER', 26)}${pad('STATUS', 7)}DETAIL`);
console.log('─'.repeat(78));
for (const r of results) {
    const mark = r.status === 'PASS' ? '✅' : r.status === 'SKIP' ? '⚪' : '❌';
    console.log(`${pad(r.name, 26)}${pad(mark + ' ' + r.status, 9)}${r.detail}`);
}
console.log('─'.repeat(78));
const failures = results.filter(r => r.status === 'FAIL');
const reqFail = failures.filter(r => r.required);
if (!failures.length) console.log('All checks passed.');
else {
    console.log(`${failures.length} failing (${reqFail.length} required, ${failures.length - reqFail.length} optional):`);
    for (const f of failures) console.log(`  ${f.required ? '[REQUIRED]' : '[optional]'} ${f.name}: ${f.detail}`);
}
process.exit(reqFail.length ? 1 : 0);
