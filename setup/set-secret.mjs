#!/usr/bin/env node
// set-secret.mjs — write a single secret to GCP Secret Manager (create-then-addVersion).
// The write-side companion to get-secret.mjs. Uses the same claude-driver SA, which has
// secretmanager.secrets.create + addVersion + access on otchealth-shared-prod.
//
// Creates the secret container if it does not exist (automatic replication), then adds a
// new version with the given value. Safe to re-run (a 409 on create is treated as "exists").
//
// Usage:
//   node setup/set-secret.mjs <secret-id> <value>          # value as an arg
//   node setup/set-secret.mjs <secret-id> -                # value from stdin (PEM / multiline / binary)
//   VALUE=... node setup/set-secret.mjs <secret-id> --env  # value from $VALUE (keeps it out of argv)
//
// Auth: ~/.gcp_claude_driver_sa.json (or GOOGLE_APPLICATION_CREDENTIALS).

import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';

const id = process.argv[2];
const src = process.argv[3];
if (!id || src === undefined) { console.error('usage: set-secret.mjs <secret-id> <value|-|--env>'); process.exit(1); }

let value;
if (src === '-') value = readFileSync(0); // stdin (Buffer)
else if (src === '--env') { value = process.env.VALUE; if (value === undefined) { console.error('set-secret: --env given but $VALUE is unset'); process.exit(1); } }
else value = src;
const data = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');

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
const auth = { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' };

// 1. create the container (idempotent; 409 == already exists)
const create = await fetch(`https://secretmanager.googleapis.com/v1/projects/${PROJECT}/secrets?secretId=${id}`, {
  method: 'POST', headers: auth, body: JSON.stringify({ replication: { automatic: {} } }),
});
if (!create.ok && create.status !== 409) { console.error(`create ${id} ${create.status}: ${(await create.text()).slice(0, 200)}`); process.exit(1); }

// 2. add a version with the value
const add = await fetch(`https://secretmanager.googleapis.com/v1/projects/${PROJECT}/secrets/${id}:addVersion`, {
  method: 'POST', headers: auth, body: JSON.stringify({ payload: { data: data.toString('base64') } }),
});
if (!add.ok) { console.error(`addVersion ${id} ${add.status}: ${(await add.text()).slice(0, 200)}`); process.exit(1); }
const ver = (await add.json()).name;
console.error(`[set-secret] ${create.status === 409 ? 'updated' : 'created'} ${id} (${data.length} bytes) -> ${ver}`);
