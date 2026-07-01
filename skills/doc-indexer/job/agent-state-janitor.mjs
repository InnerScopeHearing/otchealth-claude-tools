#!/usr/bin/env node
/**
 * Agent state-plane JANITOR (Container Apps Job on otchealth-automation-rg, doc-indexer image).
 *
 * Two idempotent sweeps over the Cosmos work-ledger, so the plane stays honest over time:
 *   1) LEASE SWEEP: a task left 'claimed' whose lease has expired -> flip back to 'open' so it is
 *      visibly available again. (claimTask already treats an expired lease as claimable; this keeps
 *      task_list truthful and re-surfaces abandoned work.)
 *   2) ARTIFACT RECONCILE: a 'done' task whose blob: artifact no longer resolves -> flip to
 *      'blocked' and note it. Catches a done=artifact that silently rotted (deleted blob), so
 *      "done" keeps meaning "the artifact is still there".
 *
 * Reads creds from Secret Manager via the claude-driver SA (GCP_CLAUDE_DRIVER_SA_JSON_B64, the
 * job-standard secret). Non-PHI ring; touches only the agent-state ledger. Fail-soft: logs and
 * exits 0 so a transient hiccup never marks the job Failed.
 */

import crypto from 'node:crypto';

const SM = 'otchealth-shared-prod';
const DB = 'agent-state';
const VER = '2018-12-31';
const b64u = (b) => Buffer.from(b).toString('base64url');

function loadSA() {
  if (process.env.GCP_CLAUDE_DRIVER_SA_JSON_B64) {
    return JSON.parse(Buffer.from(process.env.GCP_CLAUDE_DRIVER_SA_JSON_B64, 'base64').toString('utf8'));
  }
  if (process.env.GCP_CLAUDE_DRIVER_SA_JSON) return JSON.parse(process.env.GCP_CLAUDE_DRIVER_SA_JSON);
  throw new Error('no claude-driver SA in env');
}
async function gcpToken() {
  const s = loadSA();
  const n = Math.floor(Date.now() / 1e3);
  const c = { iss: s.client_email, scope: 'https://www.googleapis.com/auth/cloud-platform', aud: 'https://oauth2.googleapis.com/token', iat: n, exp: n + 3500 };
  const i = `${b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64u(JSON.stringify(c))}`;
  const g = crypto.createSign('RSA-SHA256').update(i).sign(s.private_key);
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${i}.${Buffer.from(g).toString('base64url')}` }) });
  return (await r.json()).access_token;
}
async function sm(tok, id) {
  const r = await fetch(`https://secretmanager.googleapis.com/v1/projects/${SM}/secrets/${id}/versions/latest:access`, { headers: { Authorization: `Bearer ${tok}` } });
  if (r.status !== 200) return null;
  const j = await r.json();
  return j.payload ? Buffer.from(j.payload.data, 'base64').toString('utf8').trim() : null;
}
const authTok = (v, rt, rl, d, k) => encodeURIComponent(`type=master&ver=1.0&sig=${crypto.createHmac('sha256', Buffer.from(k, 'base64')).update(`${v.toLowerCase()}\n${rt.toLowerCase()}\n${rl}\n${d.toLowerCase()}\n\n`, 'utf8').digest('base64')}`);
async function creq(ep, key, v, rt, rl, path, { pk, body, ifMatch } = {}) {
  const d = new Date().toUTCString();
  const h = { Authorization: authTok(v, rt, rl, d, key), 'x-ms-date': d, 'x-ms-version': VER, Accept: 'application/json' };
  if (pk !== undefined) h['x-ms-documentdb-partitionkey'] = JSON.stringify([pk]);
  if (ifMatch) h['If-Match'] = ifMatch;
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const r = await fetch(`${ep.replace(/\/+$/, '')}/${path}`, { method: v, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  const t = await r.text();
  let j = null; try { j = t ? JSON.parse(t) : null; } catch { j = { raw: t }; }
  return { status: r.status, ok: r.ok, body: j, etag: r.headers.get('etag') };
}
async function queryPartition(ep, key, coll, pk, q) {
  const rl = `dbs/${DB}/colls/${coll}`;
  const d = new Date().toUTCString();
  const r = await fetch(`${ep.replace(/\/+$/, '')}/${rl}/docs`, { method: 'POST', headers: { Authorization: authTok('POST', 'docs', rl, d, key), 'x-ms-date': d, 'x-ms-version': VER, 'Content-Type': 'application/query+json', 'x-ms-documentdb-isquery': 'true', 'x-ms-documentdb-partitionkey': JSON.stringify([pk]) }, body: JSON.stringify({ query: q }) });
  return ((await r.json()).Documents) || [];
}
async function appendEvent(ep, key, taskId, kind, detail) {
  const ev = { id: `e_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`, type: 'event', task_id: taskId, kind, actor: 'janitor', detail, ts: new Date().toISOString() };
  await creq(ep, key, 'POST', 'docs', `dbs/${DB}/colls/events`, `dbs/${DB}/colls/events/docs`, { pk: taskId, body: ev });
}
function commonsSas(account, key) {
  const sv = '2021-12-02', ss = 'b', srt = 'co', perm = 'rl';
  const st = `${new Date(Date.now() - 3e5).toISOString().slice(0, 19)}Z`;
  const se = `${new Date(Date.now() + 36e5).toISOString().slice(0, 19)}Z`;
  const sts = `${[account, perm, ss, srt, st, se, '', 'https', sv, ''].join('\n')}\n`;
  return new URLSearchParams({ sv, ss, srt, sp: perm, st, se, spr: 'https', sig: crypto.createHmac('sha256', Buffer.from(key, 'base64')).update(sts, 'utf8').digest('base64') }).toString();
}

(async () => {
  const g = await gcpToken();
  const ep = await sm(g, 'cosmos-agent-state-endpoint');
  const key = await sm(g, 'cosmos-agent-state-key');
  if (!ep || !key) { console.log('agent-state Cosmos not configured; nothing to do.'); return; }
  const cacct = await sm(g, 'azure-commons-storage-account');
  const ckey = await sm(g, 'azure-commons-storage-key');
  const now = new Date();
  const board = 'fleet';

  // Sweep 1: expired-lease claimed tasks -> open
  let reopened = 0;
  const claimed = await queryPartition(ep, key, 'tasks', board, "SELECT * FROM c WHERE c.board='fleet' AND c.status='claimed'");
  for (const t of claimed) {
    if (t.lease_until && new Date(t.lease_until) < now) {
      t.status = 'open';
      t.notes = [...(t.notes || []), `[${now.toISOString()}] janitor: lease expired (was ${t.owner_agent}), reopened.`];
      t.lease_until = null; t.claim_ts = null; t.updated_at = now.toISOString();
      const r = await creq(ep, key, 'PUT', 'docs', `dbs/${DB}/colls/tasks/docs/${t.id}`, `dbs/${DB}/colls/tasks/docs/${t.id}`, { pk: board, body: t, ifMatch: t._etag });
      if (r.ok) { reopened++; await appendEvent(ep, key, t.id, 'lease_expired_reopened', `was ${t.owner_agent}, lease_until ${t.lease_until}`); }
    }
  }

  // Sweep 2: done tasks whose blob: artifact vanished -> blocked
  let broken = 0;
  if (cacct && ckey) {
    const done = await queryPartition(ep, key, 'tasks', board, "SELECT * FROM c WHERE c.board='fleet' AND c.status='done' AND STARTSWITH(c.artifact_uri,'blob:')");
    for (const t of done) {
      const path = t.artifact_uri.slice('blob:'.length);
      const container = path.split('/')[0] === 'company-journal' ? 'company-journal' : 'company-journal';
      const rel = path.replace(/^company-journal\//, '');
      const enc = rel.split('/').map(encodeURIComponent).join('/');
      const head = await fetch(`https://${cacct}.blob.core.windows.net/${container}/${enc}?${commonsSas(cacct, ckey)}`, { method: 'HEAD' });
      if (head.status !== 200) {
        t.status = 'blocked';
        t.notes = [...(t.notes || []), `[${now.toISOString()}] janitor: done-artifact no longer resolves (${t.artifact_uri} -> ${head.status}); reopened as blocked.`];
        t.updated_at = now.toISOString();
        const r = await creq(ep, key, 'PUT', 'docs', `dbs/${DB}/colls/tasks/docs/${t.id}`, `dbs/${DB}/colls/tasks/docs/${t.id}`, { pk: board, body: t, ifMatch: t._etag });
        if (r.ok) { broken++; await appendEvent(ep, key, t.id, 'artifact_vanished', `${t.artifact_uri} -> HEAD ${head.status}`); }
      }
    }
  }

  console.log(`agent-state-janitor: reopened ${reopened} expired-lease task(s); flagged ${broken} vanished-artifact task(s). OK.`);
})().catch((e) => { console.error('janitor error (fail-soft):', e.message); process.exit(0); });
