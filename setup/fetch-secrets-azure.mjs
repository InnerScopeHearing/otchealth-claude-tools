#!/usr/bin/env node
// fetch-secrets-azure.mjs — Azure Key Vault mirror of fetch-secrets.mjs.
//
// GCP Secret Manager is retired (billing off). This is the primary secret source.
// Auth: OAuth2 client_credentials against Entra ID, scope https://vault.azure.net/.default,
// using a service principal — no az CLI required in the container.
//
// The Key Vault secret NAMES are identical to the old GCP Secret Manager ids
// (1:1 mirror), so the MAP below is lifted verbatim from fetch-secrets.mjs.
//
// Env:
//   AZURE_SP_CLIENT_ID / AZURE_SP_CLIENT_SECRET / AZURE_SP_TENANT_ID  (required)
//   AZURE_KEYVAULT_NAME    vault name (default kv-otc-55c84f6bef)
//
// Output: KEY=value lines on stdout for session-start.sh to fold into credentials.env.
//
// SAME TREATMENT AS THE AWS HYDRATOR (fixed 2026-08-18). This arm used to be visibly weaker: it
// called process.exit() directly (the exact stdout-pipe-truncation hazard the AWS hydrator's
// header documents and fixes), and session-start.sh invoked it as `... 2>/dev/null || true`,
// discarding both its diagnostics and its exit code and never checking for a missing required
// secret at all. Demoted-to-fallback is not a reason to verify less: this arm now uses the same
// exitCode-not-exit() pattern and writes the same structured FLEET_HYDRATION_RESULT_FILE record
// (setup/hydration-result.mjs) the AWS hydrator does, so session-start.sh's report
// (setup/hydration-report.mjs) treats both arms identically instead of trusting one and merely
// hoping about the other.

import { writeHydrationResult } from './hydration-result.mjs';

const VAULT  = process.env.AZURE_KEYVAULT_NAME || 'kv-otc-55c84f6bef';
const TENANT = process.env.AZURE_SP_TENANT_ID;
const CID    = process.env.AZURE_SP_CLIENT_ID;
const CSEC   = process.env.AZURE_SP_CLIENT_SECRET;
const RESULT_FILE = process.env.FLEET_HYDRATION_RESULT_FILE || '';

// secret name in Key Vault  ->  env var name  ->  required?  (1:1 with GCP SM ids)
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
  // Massive market data (a Polygon.io white-label; same REST API + S3 flat-files surface).
  // Powers the innd-stock skill: true VWAP + per-day trade count + OTC consolidated tape
  // (plan window ~2 years). Two REST keys for rate-limit failover. The S3 flat-files creds
  // (massive-s3-*) are fetched on demand, NOT hydrated into the flat env. Non-PHI, public
  // market data only (internal CFO records; securities firewall = never for stock promotion).
  { id: 'massive-api-key', env: 'MASSIVE_API_KEY', required: false },
  { id: 'massive-api-key-2', env: 'MASSIVE_API_KEY_2', required: false },
  // Azure Blob storage for the INND stock workbook (the funded-credit storage lane;
  // GCP -> Azure migration). The innd-stock skill reads/writes here when
  // STORAGE_BACKEND=azure (the scheduled Azure Container Apps Job sets that). Account key
  // is sensitive -> flagged for rotation.
  { id: 'azure-cfo-storage-account', env: 'AZURE_STORAGE_ACCOUNT', required: false },
  { id: 'azure-cfo-storage-container', env: 'AZURE_STORAGE_CONTAINER', required: false },
  { id: 'azure-cfo-storage-key', env: 'AZURE_STORAGE_KEY', required: false },
  // Commerce data room (CRO): dedicated account otchealthcommerce, container commerce-source-docs.
  // Own account so the commerce key does not unlock the finance/legal rooms. Key -> rotate.
  { id: 'azure-commerce-storage-account', env: 'AZURE_COMMERCE_STORAGE_ACCOUNT', required: false },
  { id: 'azure-commerce-storage-key', env: 'AZURE_COMMERCE_STORAGE_KEY', required: false },
  // Fleet commons / company-journal (daily digests + shared learnings): dedicated account
  // otchealthcommons, container company-journal. Own account (key can't reach finance/legal). Rotate.
  { id: 'azure-commons-storage-account', env: 'AZURE_COMMONS_STORAGE_ACCOUNT', required: false },
  { id: 'azure-commons-storage-key', env: 'AZURE_COMMONS_STORAGE_KEY', required: false },
  // Azure Document Intelligence (Form Recognizer) for the CFO audit data-room indexer: read +
  // layout OCR on the image-only / mangled tier (account otchealth-docintel, eastus). Key is
  // sensitive -> rotation. Endpoint is non-secret but stored alongside for one hydration path.
  { id: 'azure-docintel-endpoint', env: 'AZURE_DOCINTEL_ENDPOINT', required: false },
  { id: 'azure-docintel-key', env: 'AZURE_DOCINTEL_KEY', required: false },
  // Azure AI Search (the doc-indexer hybrid retrieval brain: keyword + vector + semantic) plus
  // the Azure OpenAI embedding deployment used to vectorize the corpus. Admin key is sensitive
  // -> rotation. (azure-openai-endpoint / azure-openai-key are already wired above.)
  { id: 'azure-search-endpoint', env: 'AZURE_SEARCH_ENDPOINT', required: false },
  { id: 'azure-search-admin-key', env: 'AZURE_SEARCH_KEY', required: false },
  { id: 'azure-openai-embedding-deployment', env: 'AZURE_OPENAI_EMBEDDING_DEPLOYMENT', required: false },
  // Azure AI Foundry resource powering Content Understanding (the doc-indexer "understand" tier:
  // generative classify + field extraction + summary) and its model deployments. Key sensitive
  // -> rotation. (otchealth-foundry, eastus; gen model gpt-4.1-mini.)
  { id: 'azure-foundry-endpoint', env: 'AZURE_FOUNDRY_ENDPOINT', required: false },
  { id: 'azure-foundry-key', env: 'AZURE_FOUNDRY_KEY', required: false },
  { id: 'azure-foundry-gen-deployment', env: 'AZURE_FOUNDRY_GEN_DEPLOYMENT', required: false },
  // Azure Blob storage for the CLO legal matter/docket store (off Google; dedicated account
  // otchealthlegalstore with company + personal containers). The legal skill reads/writes
  // here. The personal container holds confidential divorce + civil matters. Account key is
  // sensitive -> flagged for rotation.
  { id: 'azure-legal-storage-account', env: 'AZURE_LEGAL_STORAGE_ACCOUNT', required: false },
  { id: 'azure-legal-storage-key', env: 'AZURE_LEGAL_STORAGE_KEY', required: false },
  // Free legal-research tokens (CLO). CourtListener raises case-law limits; GovInfo unlocks
  // USC/CFR fetch. Both optional (the skill works without them at lower limits).
  { id: 'legal-courtlistener-token', env: 'LEGAL_COURTLISTENER_TOKEN', required: false },
  { id: 'govinfo-api-key', env: 'GOVINFO_API_KEY', required: false },
  // Gmail retrieval (CLO) for Matt's PERSONAL Gmail. Read-only (gmail.readonly). Lets the CLO
  // download emails + attachments that exist only in Gmail. Confidential/privileged.
  { id: 'gmail-oauth-client-id', env: 'GMAIL_OAUTH_CLIENT_ID', required: false },
  { id: 'gmail-oauth-client-secret', env: 'GMAIL_OAUTH_CLIENT_SECRET', required: false },
  { id: 'gmail-refresh-token', env: 'GMAIL_REFRESH_TOKEN', required: false },
  // SharePoint ingestion (CFO) — dedicated app-only Graph app (Sites.Read.All) so the CFO can
  // read Team-site document libraries (FinanceTeam WF-9145 statements, etc.). Read-only.
  { id: 'graph-sites-client-id', env: 'GRAPH_SITES_CLIENT_ID', required: false },
  { id: 'graph-sites-client-secret', env: 'GRAPH_SITES_CLIENT_SECRET', required: false },
  // Context7 (live, version-pinned library docs MCP + REST). The Context7 MCP is wired with
  // this as a Bearer header in session-start; the env also lets any tool hit the REST API.
  { id: 'context7-api-key', env: 'CONTEXT7_API_KEY', required: false },
  // Datadog observability ($100k startup credit). Infra + APM + logs. Site us3. App key
  // (ddpat_) drives the management API (monitors/dashboards/synthetics/integrations).
  // PHI WALL: never point Datadog at MedReview/Companion until a Datadog BAA is signed.
  { id: 'datadog-api-key', env: 'DD_API_KEY', required: false },
  { id: 'datadog-app-key', env: 'DD_APP_KEY', required: false },
  { id: 'datadog-site', env: 'DD_SITE', required: false },
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
  // GitHub App "OTCHealth Fleet Bot" (org InnerScopeHearing) -> 15k/hr installation identity.
  // Short identifiers here; the PRIVATE KEY (github-app-private-key, a PEM) is SM-ONLY and the
  // github-app skill reads it directly from Secret Manager (PEMs are never emitted into env).
  { id: 'github-app-id', env: 'GITHUB_APP_ID', required: false },
  { id: 'github-app-client-id', env: 'GITHUB_APP_CLIENT_ID', required: false },
  { id: 'github-app-installation-id', env: 'GITHUB_APP_INSTALLATION_ID', required: false },
  // CFO source-doc store: the private GCS bucket name for financial exports/source docs.
  { id: 'cfo-source-bucket', env: 'CFO_SOURCE_BUCKET', required: false },
  // App / cross-entity string secrets (single-store operator decision, 2026-06-08).
  { id: 'fourvault-gemini-api-key', env: 'FOURVAULT_GEMINI_API_KEY', required: false },
  { id: 'fourvault-neon-database-url', env: 'FOURVAULT_NEON_DATABASE_URL', required: false },
  { id: 'fourvault-neon-database-url-direct', env: 'FOURVAULT_NEON_DATABASE_URL_DIRECT', required: false },
  // NOTE: PEM / multiline / binary secrets (e.g. medreview-asc-api-key-p8,
  // medreview-iap-key-p8, app keystores) live in Secret Manager ONLY and are
  // fetched-to-file on demand — never emitted here (they would corrupt the flat
  // credentials.env). Use setup/get-secret.mjs <id> <outfile> to materialize one.
];

const REQUIRED_TOTAL = MAP.filter((m) => m.required).length;
const allRequired = () => MAP.filter((m) => m.required).map((m) => ({ id: m.id, env: m.env }));

async function getAccessToken() {
  const res = await fetch(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: CID,
      client_secret: CSEC,
      scope: 'https://vault.azure.net/.default',
    }),
  });
  const j = await res.json().catch(() => ({}));
  if (!j.access_token) throw new Error(`token exchange ${j.error || res.status}: ${(j.error_description || '').slice(0, 160)}`);
  return j.access_token;
}

async function accessSecret(token, name) {
  const url = `https://${VAULT}.vault.azure.net/secrets/${name}?api-version=7.4`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 404) return null; // secret not created yet
  if (!res.ok) throw new Error(`get ${name} ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const j = await res.json();
  return (j.value || '').trim();
}

// NEVER call process.exit() IN THIS FILE (same rule, same reason, as fetch-secrets-aws.mjs): stdout
// here is a PIPE (session-start.sh runs `KV_FETCHED="$(node fetch-secrets-azure.mjs ...)"`), and
// Node writes to a pipe asynchronously. process.exit() tears the process down immediately and
// discards whatever is still queued, so the exit code would say "complete" about output that is
// not. Set process.exitCode and return instead; the work lives in main() so an early failure can
// `return` rather than reach for process.exit().
async function main() {
  if (!TENANT || !CID || !CSEC) {
    console.error('[fetch-secrets-azure] AZURE_SP_CLIENT_ID / AZURE_SP_CLIENT_SECRET / AZURE_SP_TENANT_ID not all set — cannot fetch.');
    writeHydrationResult(RESULT_FILE, {
      store: 'azure-keyvault',
      reachable: false,
      emittedCount: 0,
      requiredTotal: REQUIRED_TOTAL,
      requiredMissing: allRequired(),
    });
    process.exitCode = 1;
    return;
  }

  let token;
  try {
    token = await getAccessToken();
  } catch (e) {
    console.error(`[fetch-secrets-azure] auth failed: ${e.message}`);
    writeHydrationResult(RESULT_FILE, {
      store: 'azure-keyvault',
      reachable: false,
      emittedCount: 0,
      requiredTotal: REQUIRED_TOTAL,
      requiredMissing: allRequired(),
    });
    process.exitCode = 1;
    return;
  }

  let hadRequiredMiss = false;
  let emitted = 0;
  // Same discipline as the AWS hydrator: these are the SAME {id, env} pairs MAP already holds,
  // never text re-derived from the console.error() sentence below.
  const requiredMissing = [];
  for (const { id, env, required } of MAP) {
    let val = null;
    try {
      val = await accessSecret(token, id);
    } catch (e) {
      console.error(`[fetch-secrets-azure] ${id}: ${e.message}`);
    }
    if (val) {
      const safe = `'${val.replace(/'/g, "'\\''")}'`;
      process.stdout.write(`${env}=${safe}\n`);
      emitted += 1;
    } else if (required) {
      console.error(`[fetch-secrets-azure] MISSING required secret '${id}' in vault ${VAULT}.`);
      requiredMissing.push({ id, env });
      hadRequiredMiss = true;
    }
  }

  console.error(`[fetch-secrets-azure] ${emitted} secret(s) hydrated from ${VAULT}.`);

  writeHydrationResult(RESULT_FILE, {
    store: 'azure-keyvault',
    reachable: true,
    emittedCount: emitted,
    requiredTotal: REQUIRED_TOTAL,
    requiredMissing,
  });

  process.exitCode = hadRequiredMiss ? 2 : 0;
}

await main();
