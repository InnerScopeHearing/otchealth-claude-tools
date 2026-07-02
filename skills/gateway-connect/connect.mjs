#!/usr/bin/env node
// gateway-connect — one-and-done connect (+ auto-refresh) of an agent's Claude Code Desktop session to
// the OTCHealth MCP gateway on its RING-SCOPED lane.
//
// WHY: the gateway (mcp.otchealth.app) issues short-lived (1h) access tokens via the client_credentials
// grant, and each lane's token carries its agent identity so the gateway ring-gates privileged RAG
// (kb_search_privileged returns only that lane's rooms). A static bearer header therefore expires hourly.
// This mints the lane token, registers the gateway as a Claude Code MCP server, verifies the lane sees
// its tools, and (in --watch) re-mints + re-registers just before expiry so the agent connects ONCE and
// stays connected.
//
// SECURITY: the lane client_id/secret are read fresh from Secret Manager via the claude-driver SA (the
// same SA azls.mjs/kb-memory use) and are NEVER printed. The access token is passed only into the local
// `claude mcp add --header` arg and is NEVER logged. Runs on the agent's own Desktop (where `claude` +
// the SA live); it does nothing sensitive beyond wiring that machine's own session to its own lane.
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const SM = 'otchealth-shared-prod';
export const GATEWAY_MCP = 'https://mcp.otchealth.app/mcp';
export const TOKEN_ENDPOINT = 'https://mcp.otchealth.app/oauth/token';
const REFRESH_SKEW_S = 300; // re-mint this many seconds before expiry

// Lane registry: lane -> its OAuth client_id/secret SM names + the Claude Code MCP server name. Add a
// row to onboard another ring-scoped agent. Each lane MUST reference only its OWN lane creds (ring-safe).
export const LANES = {
  clo: { idSecret: 'oauth-lane-clo-id', secretSecret: 'oauth-lane-clo-secret', mcpName: 'otchealth-gateway' },
  'clo-personal': { idSecret: 'oauth-lane-clo-personal-id', secretSecret: 'oauth-lane-clo-personal-secret', mcpName: 'otchealth-gateway' },
  cfo: { idSecret: 'oauth-lane-cfo-id', secretSecret: 'oauth-lane-cfo-secret', mcpName: 'otchealth-gateway' },
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

// ---- Secret Manager (claude-driver SA) ----
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

/** Mint a short-lived lane token via client_credentials. Never logs the client_secret or the token. */
export async function mintToken(lane) {
  const cfg = LANES[lane];
  if (!cfg) throw new Error(`unknown lane "${lane}" (known: ${Object.keys(LANES).join(', ')})`);
  const tok = await smToken();
  const [id, secret] = await Promise.all([sm(cfg.idSecret, tok), sm(cfg.secretSecret, tok)]);
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
  console.log(`[gateway-connect] lane=${lane} token minted (agent=${laneClaim(token) || '?'}, expires_in=${expiresIn}s)`);
  if (doRegister) { register(mcpName, token); console.log(`[gateway-connect] registered MCP server "${mcpName}" -> ${GATEWAY_MCP}`); }
  if (doVerify) { const v = await verify(token); console.log(`[gateway-connect] verify: /mcp tools/list HTTP ${v.status}, ${v.count} tools; privileged: ${v.privileged.join(', ') || '(none)'}`); }
  return expiresIn;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const args = process.argv.slice(2);
  const lane = args.find((a) => !a.startsWith('--'));
  const watch = args.includes('--watch');
  const verifyOnly = args.includes('--verify-only'); // mint + verify, do NOT register (offline-safe test of the lane)
  if (!lane) { console.error('usage: node connect.mjs <clo|clo-personal|cfo> [--watch] [--verify-only]'); process.exit(2); }
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

export default { LANES, GATEWAY_MCP, TOKEN_ENDPOINT, mintToken, buildAddArgs, parseTokenResponse, laneClaim };
