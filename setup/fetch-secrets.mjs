#!/usr/bin/env node
// fetch-secrets.mjs — pulls non-PHI API keys from GCP Secret Manager using the
// claude-driver SA key, and prints them as KEY=value lines on stdout for
// session-start.sh to fold into ~/.designer/credentials.env.
//
// Auth is done by self-signing a JWT from the SA key and exchanging it for an
// access token — no gcloud CLI required in the container.
//
// Env:
//   GOOGLE_APPLICATION_CREDENTIALS  path to the claude-driver SA JSON (required)
//   GOOGLE_CLOUD_PROJECT            project id (default otchealth-shared-prod)
//
// Secret Manager secret IDs expected (create once as org admin — see README):
//   openai-api-key                  -> OPENAI_API_KEY
//   elevenlabs-api-key              -> ELEVENLABS_API_KEY
//   recraft-api-key                 -> RECRAFT_API_KEY                 (optional)
//   azure-openai-endpoint           -> AZURE_OPENAI_ENDPOINT           (optional)
//   azure-openai-key                -> AZURE_OPENAI_API_KEY            (optional)
//   azure-openai-api-version        -> AZURE_OPENAI_API_VERSION        (optional)
//   azure-openai-image-deployment   -> AZURE_OPENAI_IMAGE_DEPLOYMENT   (optional)
//   azure-openai-vision-deployment  -> AZURE_OPENAI_VISION_DEPLOYMENT  (optional)
//   azure-openai-video-deployment   -> AZURE_OPENAI_VIDEO_DEPLOYMENT   (optional, Sora)
//   azure-speech-key                -> AZURE_SPEECH_KEY                (optional)
//   azure-speech-region             -> AZURE_SPEECH_REGION             (optional)
//   azure-sp-client-id              -> AZURE_SP_CLIENT_ID              (optional, Contributor SP)
//   azure-sp-client-secret          -> AZURE_SP_CLIENT_SECRET          (optional)
//   azure-sp-tenant-id              -> AZURE_SP_TENANT_ID              (optional)
//   azure-subscription-id           -> AZURE_SUBSCRIPTION_ID           (optional)

import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';

const SA_PATH = process.env.GOOGLE_APPLICATION_CREDENTIALS;
const PROJECT = process.env.GOOGLE_CLOUD_PROJECT || 'otchealth-shared-prod';

// secret id in Secret Manager  ->  env var name  ->  required?
const MAP = [
  { id: 'openai-api-key', env: 'OPENAI_API_KEY', required: true },
  { id: 'elevenlabs-api-key', env: 'ELEVENLABS_API_KEY', required: true },
  { id: 'recraft-api-key', env: 'RECRAFT_API_KEY', required: false },
  // Azure (all optional — emitted only once the secrets exist in the vault).
  { id: 'azure-openai-endpoint', env: 'AZURE_OPENAI_ENDPOINT', required: false },
  { id: 'azure-openai-key', env: 'AZURE_OPENAI_API_KEY', required: false },
  { id: 'azure-openai-api-version', env: 'AZURE_OPENAI_API_VERSION', required: false },
  { id: 'azure-openai-image-deployment', env: 'AZURE_OPENAI_IMAGE_DEPLOYMENT', required: false },
  { id: 'azure-openai-vision-deployment', env: 'AZURE_OPENAI_VISION_DEPLOYMENT', required: false },
  { id: 'azure-openai-video-deployment', env: 'AZURE_OPENAI_VIDEO_DEPLOYMENT', required: false },
  { id: 'azure-speech-key', env: 'AZURE_SPEECH_KEY', required: false },
  { id: 'azure-speech-region', env: 'AZURE_SPEECH_REGION', required: false },
  // Contributor service principal (for provisioning, not data-plane calls).
  { id: 'azure-sp-client-id', env: 'AZURE_SP_CLIENT_ID', required: false },
  { id: 'azure-sp-client-secret', env: 'AZURE_SP_CLIENT_SECRET', required: false },
  { id: 'azure-sp-tenant-id', env: 'AZURE_SP_TENANT_ID', required: false },
  { id: 'azure-subscription-id', env: 'AZURE_SUBSCRIPTION_ID', required: false },
];

if (!SA_PATH) {
  console.error('[fetch-secrets] GOOGLE_APPLICATION_CREDENTIALS not set — cannot fetch.');
  process.exit(1);
}

let sa;
try {
  sa = JSON.parse(readFileSync(SA_PATH, 'utf8'));
} catch (e) {
  console.error(`[fetch-secrets] cannot read SA key at ${SA_PATH}: ${e.message}`);
  process.exit(1);
}

async function getAccessToken(sa) {
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
  const input = `${enc(header)}.${enc(claim)}`;
  const sig = crypto.createSign('RSA-SHA256').update(input).sign(sa.private_key, 'base64url');
  const jwt = `${input}.${sig}`;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${encodeURIComponent(jwt)}`,
  });
  if (!res.ok) throw new Error(`token exchange ${res.status}: ${await res.text()}`);
  return (await res.json()).access_token;
}

async function accessSecret(token, id) {
  const url = `https://secretmanager.googleapis.com/v1/projects/${PROJECT}/secrets/${id}/versions/latest:access`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 404) return null; // secret not created yet
  if (!res.ok) throw new Error(`access ${id} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return Buffer.from(data.payload.data, 'base64').toString('utf8').trim();
}

let token;
try {
  token = await getAccessToken(sa);
} catch (e) {
  console.error(`[fetch-secrets] auth failed: ${e.message}`);
  process.exit(1);
}

let hadRequiredMiss = false;
for (const { id, env, required } of MAP) {
  let val = null;
  try {
    val = await accessSecret(token, id);
  } catch (e) {
    console.error(`[fetch-secrets] ${id}: ${e.message}`);
  }
  if (val) {
    process.stdout.write(`${env}=${val}\n`);
  } else if (required) {
    console.error(`[fetch-secrets] MISSING required secret '${id}' in ${PROJECT}. Create it (see README).`);
    hadRequiredMiss = true;
  }
}

process.exit(hadRequiredMiss ? 2 : 0);
