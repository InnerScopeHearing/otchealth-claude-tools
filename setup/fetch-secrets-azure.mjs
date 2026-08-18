#!/usr/bin/env node
// fetch-secrets-azure.mjs — session-start.sh's primary secret hydration, for the FULL fleet secret
// bundle (not just kb-memory's ledger).
//
// REFACTORED 2026-08-18 (the agent-seat credential bootstrap fix) to fetch every MAP entry through
// kb-memory's shared kvSecret() resolver instead of a hand-rolled, SP-client-credentials-ONLY
// getAccessToken()/accessSecret() pair. That hand-rolled pair was a SECOND, independent
// reimplementation of "how does this seat read a Key Vault secret" that had silently drifted out of
// sync with the real one: it never got the managed-identity or az-CLI/OIDC auth paths, and -- the
// concrete bug this refactor closes -- it never got the AWS SSM fallback kvSecret() gained on
// 2026-08-18 when Azure Key Vault became permanently unreachable (see azure-secret.mjs's and
// aws-secret.mjs's own headers). A seat with ONLY OTC_AWS_ACCESS_KEY_ID/SECRET set (no Azure creds at
// all -- the documented single-bootstrap-credential posture for a non-ECS seat) used to get NOTHING
// from this script: `if (!TENANT || !CID || !CSEC) process.exit(1)` fired before a single secret was
// even attempted, even though every one of these secrets was reachable via SSM the whole time. Now
// this script tries every auth path kvSecret() supports (managed identity -> AZURE_SP_* -> az-CLI/OIDC
// -> AWS SSM mirror) per secret, and the only behavior change a caller can observe is that MORE
// secrets resolve on MORE seats. Output format, env-var names, and exit codes are unchanged, so
// session-start.sh's `get_key()` parsing needs no changes.
//
// The Key Vault secret NAMES are identical to the old GCP Secret Manager ids
// (1:1 mirror), so the MAP below is lifted verbatim from fetch-secrets.mjs.
//
// Env (any ONE of these is now sufficient; see skills/kb-memory/SKILL.md "Credential bootstrap"):
//   AZURE_SP_CLIENT_ID / AZURE_SP_CLIENT_SECRET / AZURE_SP_TENANT_ID   Azure service principal
//   IDENTITY_ENDPOINT / IDENTITY_HEADER                                Azure Container Apps managed identity
//   OTC_AWS_ACCESS_KEY_ID / OTC_AWS_SECRET_ACCESS_KEY                  AWS SSM mirror (Azure-independent)
//   AZURE_KEYVAULT_NAME    vault name (default kv-otc-55c84f6bef), used only for diagnostic messages
//
// Output: KEY=value lines on stdout for session-start.sh to fold into credentials.env.
import { kvSecret } from '../skills/kb-memory/azure-secret.mjs';
import { awsCredsPresent } from '../skills/kb-memory/aws-secret.mjs';

const VAULT = process.env.AZURE_KEYVAULT_NAME || 'kv-otc-55c84f6bef';

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

// Fast, informational-only upfront check (2026-08-18). Deliberately NOT a hard exit -- kvSecret()
// itself supports FOUR paths (managed identity, AZURE_SP_*, az-CLI/OIDC, AWS SSM) and a seat with
// ONLY az-CLI logged in (no env markers for any of the other three) would be wrongly turned away by a
// hard require here, same as the OLD SP-only hard exit wrongly turned away every AWS-only seat. This
// is a heads-up for a human reading the log, not a gate.
{
  const identityOk = Boolean(process.env.IDENTITY_ENDPOINT && process.env.IDENTITY_HEADER);
  const spOk = Boolean(process.env.AZURE_SP_CLIENT_ID && process.env.AZURE_SP_CLIENT_SECRET && process.env.AZURE_SP_TENANT_ID);
  const aws = awsCredsPresent();
  if (!identityOk && !spOk && !aws.any) {
    console.error(
      '[fetch-secrets-azure] heads up: no managed identity, no AZURE_SP_*, and no AWS creds ' +
      '(OTC_AWS_ACCESS_KEY_ID/SECRET) are set -- only az-CLI/OIDC login (if present) can supply secrets ' +
      'this run. See skills/kb-memory/SKILL.md "Credential bootstrap" for what to set per seat type.',
    );
  }
}

// kvSecret() never throws (it is fail-open by design: every internal auth-path failure is caught and
// logged as its own `[kv-secret] ...` line, and the function itself just returns null) -- so no
// try/catch is needed around the loop below the way the old accessSecret() call required one.
let hadRequiredMiss = false;
for (const { id, env, required } of MAP) {
  const val = await kvSecret(id);
  if (val) {
    const safe = `'${val.replace(/'/g, "'\\''")}'`;
    process.stdout.write(`${env}=${safe}\n`);
  } else if (required) {
    console.error(`[fetch-secrets-azure] MISSING required secret '${id}' (checked Key Vault ${VAULT} and its AWS SSM fallback).`);
    hadRequiredMiss = true;
  }
}
process.exit(hadRequiredMiss ? 2 : 0);
