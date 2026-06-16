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
  // Platform / service tokens (NON-PHI; all optional — emitted only once the
  // secret exists in Secret Manager, so this list is safe to ship ahead of
  // provisioning. Promote each from the Notion vault with `gcloud secrets create`.
  { id: 'depot-token', env: 'DEPOT_TOKEN', required: false },                          // Depot build/CI
  { id: 'depot-project-id', env: 'DEPOT_PROJECT_ID', required: false },
  { id: 'posthog-personal-api-key', env: 'POSTHOG_PERSONAL_API_KEY', required: false },// PostHog mgmt (phx_)
  { id: 'posthog-host', env: 'POSTHOG_HOST', required: false },
  { id: 'miro-token', env: 'MIRO_TOKEN', required: false },                            // Miro diagrammer
  { id: 'miro-client-id', env: 'MIRO_CLIENT_ID', required: false },
  { id: 'miro-client-secret', env: 'MIRO_CLIENT_SECRET', required: false },
  { id: 'make-api-token', env: 'MAKE_API_TOKEN', required: false },                    // Make (non-PHI sandbox)
  { id: 'daytona-api-key', env: 'DAYTONA_API_KEY', required: false },                  // Daytona sandboxes
  { id: 'daytona-api-url', env: 'DAYTONA_API_URL', required: false },
  { id: 'greptile-token', env: 'GREPTILE_TOKEN', required: false },                    // Greptile review
  { id: 'replicate-api-token', env: 'REPLICATE_API_TOKEN', required: false },          // Replicate (avatar fallback)
  { id: 'n8n-api-key', env: 'N8N_API_KEY', required: false },                          // n8n automation
  { id: 'n8n-base-url', env: 'N8N_BASE_URL', required: false },
  { id: 'sentry-auth-token', env: 'SENTRY_AUTH_TOKEN', required: false },              // Sentry releases
  { id: 'cloudflare-api-token', env: 'CLOUDFLARE_API_TOKEN', required: false },        // Cloudflare
  { id: 'netlify-token', env: 'NETLIFY_TOKEN', required: false },                      // Netlify
  { id: 'railway-token', env: 'RAILWAY_TOKEN', required: false },                      // Railway
  // Amazon Selling Partner API (SP-API) — OTCHealth Inc. seller account (non-PHI
  // commerce; TReO PSAPs + catalog). LWA refresh-token auth, no AWS SigV4. The
  // amazon-sp-api skill (skills/amazon-sp-api) reads these. Stored once the
  // Developer Central app is created + self-authorized; safe to list ahead of that.
  { id: 'amzn-lwa-client-id', env: 'AMZ_LWA_CLIENT_ID', required: false },
  { id: 'amzn-lwa-client-secret', env: 'AMZ_LWA_CLIENT_SECRET', required: false },
  { id: 'amzn-sp-refresh-token', env: 'AMZ_SP_REFRESH_TOKEN', required: false },
  { id: 'amzn-seller-id', env: 'AMZ_SELLER_ID', required: false },
  // Plaid banking aggregator (CFO data pipeline; non-PHI finance). client_id + secret
  // here; per-institution access tokens live as plaid-access-token-<inst> and are
  // fetched-to-stdout on demand (get-secret.mjs), NOT emitted into the flat env.
  // The plaid-banking skill (skills/plaid-banking) reads these.
  { id: 'plaid-client-id', env: 'PLAID_CLIENT_ID', required: false },
  { id: 'plaid-secret', env: 'PLAID_SECRET', required: false },
  { id: 'plaid-env', env: 'PLAID_ENV', required: false },
  // QuickBooks Online multi-company (CFO; non-PHI bookkeeping). One Intuit app, per-company
  // realmId + refresh token. The quickbooks skill (skills/quickbooks) reads these. INND +
  // HearingAssist writes are gated (public co). Refresh tokens ROTATE -> the recurring sync
  // must persist new values back to the vault.
  { id: 'qbo-client-id', env: 'QBO_CLIENT_ID', required: false },
  { id: 'qbo-client-secret', env: 'QBO_CLIENT_SECRET', required: false },
  { id: 'qbo-env', env: 'QBO_ENV', required: false },
  { id: 'qbo-realm-otchealth', env: 'QBO_REALM_OTCHEALTH', required: false },
  { id: 'qbo-refresh-otchealth', env: 'QBO_REFRESH_OTCHEALTH', required: false },
  { id: 'qbo-realm-innd', env: 'QBO_REALM_INND', required: false },
  { id: 'qbo-refresh-innd', env: 'QBO_REFRESH_INND', required: false },
  { id: 'qbo-realm-hearingassist', env: 'QBO_REALM_HEARINGASSIST', required: false },
  { id: 'qbo-refresh-hearingassist', env: 'QBO_REFRESH_HEARINGASSIST', required: false },
  { id: 'qbo-realm-personal', env: 'QBO_REALM_PERSONAL', required: false },
  { id: 'qbo-refresh-personal', env: 'QBO_REFRESH_PERSONAL', required: false },
  // Xero multi-org (CFO; chosen platform). ONE app + ONE multi-tenant refresh token reaches all
  // orgs (OTCHealth/INND/HearingAssist/personal) via Xero-tenant-id. The xero skill reads these.
  // Refresh token ROTATES every use -> the recurring sync must persist new values back to the vault.
  { id: 'xero-client-id', env: 'XERO_CLIENT_ID', required: false },
  { id: 'xero-client-secret', env: 'XERO_CLIENT_SECRET', required: false },
  { id: 'xero-refresh-token', env: 'XERO_REFRESH_TOKEN', required: false },
  // Per-org Xero refresh tokens (each org is a separate Xero account/login for the free deal).
  // The xero skill reads SM `xero-refresh-token-<org>` directly via the SA; these env mirrors are
  // a fallback. Each rotates on use; the skill auto-persists.
  { id: 'xero-refresh-token-otchealth', env: 'XERO_REFRESH_TOKEN_OTCHEALTH', required: false },
  { id: 'xero-refresh-token-innd', env: 'XERO_REFRESH_TOKEN_INND', required: false },
  { id: 'xero-refresh-token-hearingassist', env: 'XERO_REFRESH_TOKEN_HEARINGASSIST', required: false },
  { id: 'xero-refresh-token-personal', env: 'XERO_REFRESH_TOKEN_PERSONAL', required: false },
  // Microsoft Graph mail mining (CFO source-doc recovery; InnerScope M365 tenant, app-only).
  // The m365-mail skill reads these. App = otchealth-cto-graph-admin (OVER-PRIVILEGED + secret
  // exposed in chat -> rotate + trim to Mail.Read/User.Read.All/Files.Read.All before launch).
  { id: 'graph-mail-client-id', env: 'GRAPH_MAIL_CLIENT_ID', required: false },
  { id: 'graph-mail-client-secret', env: 'GRAPH_MAIL_CLIENT_SECRET', required: false },
  { id: 'graph-mail-tenant-id', env: 'GRAPH_MAIL_TENANT_ID', required: false },
  // App / cross-entity string secrets (single-store operator decision, 2026-06-08).
  { id: 'fourvault-gemini-api-key', env: 'FOURVAULT_GEMINI_API_KEY', required: false },
  { id: 'fourvault-neon-database-url', env: 'FOURVAULT_NEON_DATABASE_URL', required: false },
  { id: 'fourvault-neon-database-url-direct', env: 'FOURVAULT_NEON_DATABASE_URL_DIRECT', required: false },
  // NOTE: PEM / multiline / binary secrets (e.g. medreview-asc-api-key-p8,
  // medreview-iap-key-p8, app keystores) live in Secret Manager ONLY and are
  // fetched-to-file on demand — never emitted here (they would corrupt the flat
  // credentials.env). Use setup/get-secret.mjs <id> <outfile> to materialize one.
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
    // Single-quote the value so it survives `eval`/`set -a` sourcing even when it
    // contains shell metacharacters (|, spaces, $, etc.). Escape embedded quotes.
    const safe = `'${val.replace(/'/g, "'\\''")}'`;
    process.stdout.write(`${env}=${safe}\n`);
  } else if (required) {
    console.error(`[fetch-secrets] MISSING required secret '${id}' in ${PROJECT}. Create it (see README).`);
    hadRequiredMiss = true;
  }
}

process.exit(hadRequiredMiss ? 2 : 0);
