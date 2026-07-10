#!/usr/bin/env node
/**
 * sm-to-kv-mirror — nightly mirror of every GCP Secret Manager secret into Azure Key Vault.
 * Keeps the Azure-system copy of all fleet credentials current (GCP Secret Manager stays the live
 * backbone; Key Vault is the durable Azure mirror, post-Notion). Public-repo-safe: NO infra IDs or
 * secrets are hardcoded; all of them (azure-sp creds, the Key Vault name) are read from Secret
 * Manager via the claude-driver SA at runtime.
 *
 * Requires: GCP_CLAUDE_DRIVER_SA_JSON (env) or ~/.gcp_claude_driver_sa.json. NODE_USE_ENV_PROXY=1 on
 * the Hyperagent sandbox; native egress in the Container Apps job. azure-sp must hold the Key Vault
 * Secrets Officer role on the vault (one-time grant).
 */
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import crypto from 'node:crypto';

function loadSA() {
  const env = process.env.GCP_CLAUDE_DRIVER_SA_JSON;
  if (env && env.trim()) { try { return JSON.parse(env); } catch { /* try base64 / file */ } }
  const f = join(homedir(), '.gcp_claude_driver_sa.json');
  if (existsSync(f)) return JSON.parse(readFileSync(f, 'utf8'));
  throw new Error('claude-driver SA not available (env GCP_CLAUDE_DRIVER_SA_JSON or ~/.gcp_claude_driver_sa.json)');
}
const SA = loadSA(); const GP = SA.project_id;
const b = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function gjwt(scope) { const n = Math.floor(Date.now()/1000); const i = `${b({alg:'RS256',typ:'JWT'})}.${b({iss:SA.client_email,scope,aud:'https://oauth2.googleapis.com/token',iat:n,exp:n+3600})}`; return i + '.' + crypto.createSign('RSA-SHA256').update(i).sign(SA.private_key,'base64url'); }
async function gcpToken() { const r = await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:`grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${encodeURIComponent(gjwt('https://www.googleapis.com/auth/cloud-platform'))}`}); return (await r.json()).access_token; }
const GT = await gcpToken(); const GH = { Authorization: `Bearer ${GT}` };
async function sm(id) { const r = await fetch(`https://secretmanager.googleapis.com/v1/projects/${GP}/secrets/${id}/versions/latest:access`,{headers:GH}); if(!r.ok) return null; return Buffer.from((await r.json()).payload.data,'base64').toString('utf8'); }

const [ci, cs, tn, vaultName] = await Promise.all(['azure-sp-client-id','azure-sp-client-secret','azure-sp-tenant-id','azure-keyvault-name'].map(sm));
if (!ci || !vaultName) throw new Error('missing azure-sp creds or azure-keyvault-name in Secret Manager');
const KT = (await (await fetch(`https://login.microsoftonline.com/${tn.trim()}/oauth2/v2.0/token`,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:ci.trim(),client_secret:cs.trim(),grant_type:'client_credentials',scope:'https://vault.azure.net/.default'})})).json()).access_token;
const KV = `https://${vaultName.trim()}.vault.azure.net`;
const KH = { Authorization: `Bearer ${KT}`, 'Content-Type': 'application/json' };

let names = [], url = `https://secretmanager.googleapis.com/v1/projects/${GP}/secrets?pageSize=300`;
while (url) { const j = await (await fetch(url,{headers:GH})).json(); for (const s of (j.secrets||[])) names.push(s.name.split('/').pop()); url = j.nextPageToken ? `https://secretmanager.googleapis.com/v1/projects/${GP}/secrets?pageSize=300&pageToken=${j.nextPageToken}` : null; }
let ok=0, fail=0;
for (const n of names) {
  const v = await sm(n); if (v === null) { fail++; continue; }
  const kvName = n.replace(/[^0-9a-zA-Z-]/g,'-');
  const r = await fetch(`${KV}/secrets/${kvName}?api-version=7.4`,{method:'PUT',headers:KH,body:JSON.stringify({value:v})});
  if (r.status>=200 && r.status<300) ok++; else fail++;
}
console.log(`sm-to-kv-mirror: mirrored ${ok}/${names.length} secrets to ${vaultName.trim()} (fail=${fail})`);
