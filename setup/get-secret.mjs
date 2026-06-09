#!/usr/bin/env node
// get-secret.mjs — materialize a single secret from GCP Secret Manager on demand.
// For PEM / multiline / binary secrets that must NOT go in the flat credentials.env
// (e.g. medreview-asc-api-key-p8). Writes to a file (chmod 600) or stdout.
//
// Usage:
//   node setup/get-secret.mjs <secret-id> [outfile]
// Auth: uses ~/.gcp_claude_driver_sa.json (the claude-driver SA), like fetch-secrets.
//
//   node setup/get-secret.mjs medreview-asc-api-key-p8 /tmp/AuthKey.p8
//   node setup/get-secret.mjs fourvault-neon-database-url   # -> stdout

import { readFileSync, writeFileSync, chmodSync } from 'node:fs';
import crypto from 'node:crypto';

const id = process.argv[2];
const outfile = process.argv[3];
if (!id) { console.error('usage: get-secret.mjs <secret-id> [outfile]'); process.exit(1); }

const SA_PATH = process.env.GOOGLE_APPLICATION_CREDENTIALS || `${process.env.HOME}/.gcp_claude_driver_sa.json`;
const PROJECT = process.env.GOOGLE_CLOUD_PROJECT || 'otchealth-shared-prod';
const sa = JSON.parse(readFileSync(SA_PATH, 'utf8'));

async function token() {
  const h = { alg: 'RS256', typ: 'JWT' }, n = Math.floor(Date.now() / 1000);
  const c = { iss: sa.client_email, scope: 'https://www.googleapis.com/auth/cloud-platform', aud: 'https://oauth2.googleapis.com/token', iat: n, exp: n + 3600 };
  const e = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const i = `${e(h)}.${e(c)}`;
  const s = crypto.createSign('RSA-SHA256').update(i).sign(sa.private_key, 'base64url');
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${encodeURIComponent(`${i}.${s}`)}` });
  return (await r.json()).access_token;
}

const t = await token();
const r = await fetch(`https://secretmanager.googleapis.com/v1/projects/${PROJECT}/secrets/${id}/versions/latest:access`, { headers: { Authorization: `Bearer ${t}` } });
if (!r.ok) { console.error(`access ${id} ${r.status}: ${(await r.text()).slice(0, 200)}`); process.exit(1); }
const data = Buffer.from((await r.json()).payload.data, 'base64');
if (outfile) { writeFileSync(outfile, data, { mode: 0o600 }); chmodSync(outfile, 0o600); console.error(`[get-secret] wrote ${data.length} bytes -> ${outfile} (600)`); }
else process.stdout.write(data);
