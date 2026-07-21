#!/usr/bin/env node
// gateway-connect — one-and-done connect (+ auto-refresh) of an agent's Claude Code session to the
// OTCHealth MCP gateway on its RING-SCOPED lane.
//
// WHY: the gateway (mcp.otchealth.app) issues short-lived (1h) access tokens via the client_credentials
// grant, and each lane's token carries its agent identity so the gateway ring-gates privileged RAG. A
// static bearer header therefore expires hourly. This mints the lane token, registers the gateway as a
// Claude Code MCP server, verifies the lane sees its tools, and (in --watch) re-mints just before expiry.
//
// CRED SOURCE (Azure-first, off GCP): lane client_id/secret are read from AZURE KEY VAULT via an Azure
// service principal supplied in the environment (AZURE_SP_CLIENT_ID/SECRET/TENANT_ID, AZURE_KEYVAULT_NAME).
// If those env vars are absent, it falls back to the legacy GCP Secret Manager path (claude-driver SA) for
// backward compatibility on Desktops still on GCP. The client_secret and access token are NEVER printed.
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { kvSecret } from '../kb-memory/azure-secret.mjs';

const SM = 'otchealth-shared-prod';
const KV_NAME = process.env.AZURE_KEYVAULT_NAME || 'kv-otc-55c84f6bef';
export const GATEWAY_MCP = 'https://mcp.otchealth.app/mcp';
export const TOKEN_ENDPOINT = 'https://mcp.otchealth.app/oauth/token';
const REFRESH_SKEW_S = 300; // re-mint this many seconds before expiry

// Lane registry: lane -> its OAuth client_id/secret secret-names (SAME name in Key Vault and Secret
// Manager) + the Claude Code MCP server name. Add a row to onboard another ring-scoped agent.
export const LANES = {
  clo: { idSecret: 'oauth-lane-clo-id', secretSecret: 'oauth-lane-clo-secret', mcpName: 'otchealth-gateway' },
  'clo-personal': { idSecret: 'oauth-lane-clo-personal-id', secretSecret: 'oauth-lane-clo-personal-secret', mcpName: 'otchealth-gateway' },
  cfo: { idSecret: 'oauth-lane-cfo-id', secretSecret: 'oauth-lane-cfo-secret', mcpName: 'otchealth-gateway' },
  cto: { idSecret: 'oauth-lane-cto-id', secretSecret: 'oauth-lane-cto-secret', mcpName: 'otchealth-gateway' },
  developer: { idSecret: 'oauth-lane-developer-id', secretSecret: 'oauth-lane-developer-secret', mcpName: 'otchealth-gateway' },
  coo: { idSecret: 'oauth-lane-coo-id', secretSecret: 'oauth-lane-coo-secret', mcpName: 'otchealth-gateway' },
  cro: { idSecret: 'oauth-lane-cro-id', secretSecret: 'oauth-lane-cro-secret', mcpName: 'otchealth-gateway' },
};

// ---- pure, unit-testable helpers ----
/** Parse an OAuth token response; returns {token, expiresIn} or throws with a safe message (no secrets). */
export function parseTokenResponse(obj) {
  if (!obj || typeof obj !== 'object') throw new Error('token endpoint returned non-JSON');
  if (!obj.access_token) throw new Error(`token endpoint returned no access_token (${obj.error || 'unknown'})`);
  const expiresIn = Number.isFinite(obj.expires_in) ? obj.expires_in : 3600;
  return { token: String(obj.access_token), expiresIn };
}
/** Build the `claude mcp add` argv for a gateway MCP server + bearer. Pure (token passed through, not logged here). */
export function buildAddArgs(mcpName, url, token) {
  return ['mcp', 'add', '--transport', 'http', mcpName, url, '--header', `Authorization: Bearer ${token}`];
}
/** Decode the (unverified) agent-lane claim from a JWT access token, for a post-mint sanity print. Safe: lane name only. */
export function laneClaim(token) {
  try { return JSON.parse(Buffer.from(String(token).split('.')[1], 'base64').toString()).agent || null; } catch { return null; }
}
/** True when the Azure service-principal env creds are present (selects the Key Vault cred source). */
export function azureEnvPresent() {
  return Boolean(process.env.AZURE_SP_CLIENT_ID && process.env.AZURE_SP_CLIENT_SECRET && process.env.AZURE_SP_TENANT_ID);
}
/** Which cred source will be used, for a non-secret startup log line. */
export function credSource() { return azureEnvPresent() ? `azure-keyvault:${KV_NAME}` : 'gcp-secret-manager'; }

// ---- Azure Key Vault (service principal from env) — PRIMARY ----
async function kvToken() {
  const r = await fetch(`https://login.microsoftonline.com/${process.env.AZURE_SP_TENANT_ID}/oauth2/v2.0/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: process.env.AZURE_SP_CLIENT_ID, client_secret: process.env.AZURE_SP_CLIENT_SECRET, grant_type: 'client_credentials', scope: 'https://vault.azure.net/.default' }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error(`azure token: ${j.error || 'no access_token'}`);
  return j.access_token;
}
async function kv(id, tok) {
  const r = await fetch(`https://${KV_NAME}.vault.azure.net/secrets/${id}?api-version=7.4`, { headers: { Authorization: 'Bearer ' + tok } });
  if (!r.ok) throw new Error(`key vault ${id}: ${r.status}`);
  return String((await r.json()).value).trim();
}

// ---- GCP Secret Manager (claude-driver SA) — FALLBACK ----
function saRaw() {
  if (process.env.GCP_CLAUDE_DRIVER_SA_JSON) return process.env.GCP_CLAUDE_DRIVER_SA_JSON;
  return readFileSync(`${homedir()}/.gcp_claude_driver_sa.json`, 'utf8');
}
async function smToken() {
  const sa = JSON.parse(saRaw());
  const now = Math.floor(Date.now() / 1000);
  const e = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const i = `${e({ alg: 'RS256', typ: 'JWT' })}.${e({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/cloud-platform', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 })}`;
  const jwt = i + '.' + crypto.createSign('RSA-SHA256').update(i).sign(sa.private_key, 'base64url');
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${encodeURIComponent(jwt)}` });
  return (await r.json()).access_token;
}
async function sm(id, tok) {
  const r = await fetch(`https://secretmanager.googleapis.com/v1/projects/${SM}/secrets/${id}/versions/latest:access`, { headers: { Authorization: 'Bearer ' + tok } });
  if (!r.ok) throw new Error(`secret ${id}: ${r.status}`);
  return Buffer.from((await r.json()).payload.data, 'base64').toString('utf8').trim();
}

/** Read a lane's [client_id, client_secret] from the active cred source (Key Vault first, else Secret Manager). */
async function laneCreds(cfg) {
  // Azure Key Vault FIRST via the SHARED resolver (managed-identity -> AZURE_SP_* -> az-CLI/OIDC),
  // not the old AZURE_SP-only local kv() gated on azureEnvPresent(). That gate fell through to the
  // now-dead GCP path whenever AZURE_SP_* env was absent (managed-identity / az-login runtimes),
  // which is what threw the octools-sync "oauth-lane-*-id 404" ambient errors. Secret names identical.
  const [kvId, kvSec] = await Promise.all([kvSecret(cfg.idSecret), kvSecret(cfg.secretSecret)]);
  if (kvId && kvSec) return [kvId, kvSec];
  // Legacy GCP Secret Manager fallback, ONLY if a claude-driver SA is actually present (else
  // smToken/saRaw() throws). Non-fatal: a clear error if neither store can supply the lane creds.
  try {
    const tok = await smToken();
    return await Promise.all([sm(cfg.idSecret, tok), sm(cfg.secretSecret, tok)]);
  } catch (e) {
    throw new Error(`lane creds ${cfg.idSecret}/${cfg.secretSecret} unavailable from Key Vault (${KV_NAME}) and GCP fallback failed: ${String((e && e.message) || e)}`);
  }
}

/** Mint a short-lived lane token via client_credentials. Never logs the client_secret or the token. */
export async function mintToken(lane) {
  const cfg = LANES[lane];
  if (!cfg) throw new Error(`unknown lane "${lane}" (known: ${Object.keys(LANES).join(', ')})`);
  const [id, secret] = await laneCreds(cfg);
  const r = await fetch(TOKEN_ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret }) });
  const { token, expiresIn } = parseTokenResponse(await r.json());
  return { token, expiresIn, mcpName: cfg.mcpName };
}

/** Verify the lane can list tools (ring-scoped). Returns { count, privileged[] }. */
async function verify(token) {
  const r = await fetch(GATEWAY_MCP, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) });
  const body = await r.text();
  let names = [];
  try { const m = body.match(/\{[\s\S]*\}$/); const j = JSON.parse(m ? m[0] : body); names = ((j.result || {}).tools || []).map((x) => x.name); }
  catch { for (const line of body.split('\n')) if (line.startsWith('data:')) { try { const j = JSON.parse(line.slice(5)); if (j.result && j.result.tools) names = j.result.tools.map((x) => x.name); } catch { /* */ } } }
  const priv = ['memory_recall', 'kb_search_privileged', 'kb_search', 'llm_azure', 'shield_check', 'groundedness_check', 'claims_check'].filter((x) => names.includes(x));
  return { count: names.length, privileged: priv, status: r.status };
}

function register(mcpName, token) {
  try { execFileSync('claude', ['mcp', 'remove', mcpName], { stdio: 'ignore' }); } catch { /* not present yet */ }
  execFileSync('claude', buildAddArgs(mcpName, GATEWAY_MCP, token), { stdio: 'ignore' });
}

async function connectOnce({ lane, doRegister, doVerify }) {
  const { token, expiresIn, mcpName } = await mintToken(lane);
  console.log(`[gateway-connect] lane=${lane} src=${credSource()} token minted (agent=${laneClaim(token) || '?'}, expires_in=${expiresIn}s)`);
  if (doRegister) { register(mcpName, token); console.log(`[gateway-connect] registered MCP server "${mcpName}" -> ${GATEWAY_MCP}`); }
  if (doVerify) { const v = await verify(token); console.log(`[gateway-connect] verify: /mcp tools/list HTTP ${v.status}, ${v.count} tools; privileged: ${v.privileged.join(', ') || '(none)'}`); }
  return expiresIn;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const args = process.argv.slice(2);
  const lane = args.find((a) => !a.startsWith('--'));
  const watch = args.includes('--watch');
  const verifyOnly = args.includes('--verify-only');
  const ifLane = args.includes('--if-lane');
  if (!lane) { console.error('usage: node connect.mjs <clo|clo-personal|cfo> [--watch] [--verify-only] [--if-lane]'); process.exit(2); }
  if (ifLane && !hasLane(lane)) { console.log(`[gateway-connect] no gateway lane for "${lane}"; skipping.`); process.exit(0); }
  (async () => {
    try {
      do {
        const expiresIn = await connectOnce({ lane, doRegister: !verifyOnly, doVerify: true });
        if (!watch) break;
        const sleepMs = Math.max(60, expiresIn - REFRESH_SKEW_S) * 1000;
        console.log(`[gateway-connect] --watch: next refresh in ${Math.round(sleepMs / 60000)} min`);
        await new Promise((s) => setTimeout(s, sleepMs));
      } while (watch);
    } catch (e) { console.error('[gateway-connect] ERROR:', String((e && e.message) || e)); process.exit(1); }
  })();
}

/** True when `lane` is a known gateway lane. Onboarding uses this to no-op for agents without a lane. */
export function hasLane(lane) { return Object.prototype.hasOwnProperty.call(LANES, lane); }

export default { LANES, GATEWAY_MCP, TOKEN_ENDPOINT, mintToken, buildAddArgs, parseTokenResponse, laneClaim, hasLane, azureEnvPresent, credSource };
