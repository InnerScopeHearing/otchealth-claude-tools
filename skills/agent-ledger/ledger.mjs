#!/usr/bin/env node
/**
 * agent-ledger - the CLI face of the AGENT STATE PLANE for any Claude Code session.
 *
 * The gateway (mcp.otchealth.app) exposes these as MCP tools for gateway-connected clients
 * (claude.ai, Hyperagent). This CLI is the equivalent for a Claude Code session: it self-hydrates
 * Cosmos + Storage-Queue creds from Secret Manager via the claude-driver SA (same pattern as
 * kb-memory / company-brain) and talks straight to the same Cosmos work-ledger + memory-of-record
 * + inbox. So every agent, on every engine, uses ONE source of truth.
 *
 * Verbs:
 *   whoami
 *   task create --title T --owner A --by W [--desc D --priority p --tags a,b]
 *   task list [--owner A --status s --limit N]
 *   task get <id>
 *   task claim <id> --agent A
 *   task update <id> --by W [--status s --note N --owner A --artifact U --priority p]
 *   task done <id> --artifact U --agent A [--note N]     (done=artifact: rejects unless U resolves)
 *   mem write --agent A --kind k --text T [--tags a,b --source S]
 *   mem search [--agent A --kind k --contains Q --limit N]
 *   inbox send --to A --from W --subject S --body B [--task ID]
 *   inbox read --agent A [--peek --max N]
 *
 * Non-PHI ring. Verbatim-critical records live here (Cosmos), never an LLM-consolidated store.
 * clo-personal is privilege-walled and rejected.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import dns from 'node:dns/promises';
import net from 'node:net';

const SM = 'otchealth-shared-prod';
const DB = 'agent-state';
const VER = '2018-12-31';
const b64u = (b) => Buffer.from(b).toString('base64url');
const FORBIDDEN = new Set(['clo-personal']);
const TASK_STATUSES = ['open', 'claimed', 'in_progress', 'blocked', 'done', 'cancelled'];
const MEMORY_KINDS = ['fact', 'decision', 'correction', 'pitfall', 'status'];

function agentOk(a) {
  const s = (a || '').trim().toLowerCase();
  if (!s) throw new Error('agent required');
  if (FORBIDDEN.has(s)) throw new Error(`agent "${s}" is privilege-walled`);
  if (!/^[a-z0-9][a-z0-9_-]{0,40}$/.test(s)) throw new Error(`invalid agent "${a}"`);
  return s;
}
const idOk = (v) => typeof v === 'string' && /^[A-Za-z0-9_.\-]{1,255}$/.test(v) && !/^\.+$/.test(v);

// ---- creds (SM via claude-driver SA) ----
function loadSA() {
  if (process.env.GCP_CLAUDE_DRIVER_SA_JSON) { try { return JSON.parse(process.env.GCP_CLAUDE_DRIVER_SA_JSON); } catch {} }
  if (process.env.GCP_CLAUDE_DRIVER_SA_JSON_B64) { try { return JSON.parse(Buffer.from(process.env.GCP_CLAUDE_DRIVER_SA_JSON_B64, 'base64').toString('utf8')); } catch {} }
  for (const p of [`${os.homedir()}/.gcp_claude_driver_sa.json`, '/agent/.gcp_claude_driver_sa.json']) {
    try { if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8')); } catch {}
  }
  throw new Error('no claude-driver SA (set GCP_CLAUDE_DRIVER_SA_JSON)');
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
let EP, KEY, QACCT, QKEY, CACCT, CKEY;
async function init() {
  const g = await gcpToken();
  [EP, KEY, QACCT, QKEY, CACCT, CKEY] = await Promise.all([
    sm(g, 'cosmos-agent-state-endpoint'), sm(g, 'cosmos-agent-state-key'),
    sm(g, 'agent-inbox-storage-account'), sm(g, 'agent-inbox-storage-key'),
    sm(g, 'azure-commons-storage-account'), sm(g, 'azure-commons-storage-key'),
  ]);
  if (!EP || !KEY) throw new Error('agent-state Cosmos creds missing in SM');
}

// ---- cosmos ----
const cAuth = (v, rt, rl, d) => encodeURIComponent(`type=master&ver=1.0&sig=${crypto.createHmac('sha256', Buffer.from(KEY, 'base64')).update(`${v.toLowerCase()}\n${rt.toLowerCase()}\n${rl}\n${d.toLowerCase()}\n\n`, 'utf8').digest('base64')}`);
async function cx(v, rt, rl, path, { pk, body, ifMatch, isQuery, pkRange } = {}) {
  const d = new Date().toUTCString();
  const h = { Authorization: cAuth(v, rt, rl, d), 'x-ms-date': d, 'x-ms-version': VER, Accept: 'application/json' };
  if (pk !== undefined) h['x-ms-documentdb-partitionkey'] = JSON.stringify([pk]);
  if (pkRange) h['x-ms-documentdb-partitionkeyrangeid'] = pkRange;
  if (ifMatch) h['If-Match'] = ifMatch;
  if (isQuery) { h['Content-Type'] = 'application/query+json'; h['x-ms-documentdb-isquery'] = 'true'; if (pk === undefined) h['x-ms-documentdb-query-enablecrosspartition'] = 'true'; }
  else if (body !== undefined) h['Content-Type'] = 'application/json';
  const r = await fetch(`${EP.replace(/\/+$/, '')}/${path}`, { method: v, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch { j = { raw: t }; }
  return { status: r.status, ok: r.ok, body: j, etag: r.headers.get('etag') };
}
async function query(coll, q, pk) {
  const rl = `dbs/${DB}/colls/${coll}`;
  if (pk !== undefined) { const r = await cx('POST', 'docs', rl, `${rl}/docs`, { isQuery: true, body: { query: q }, pk }); return (r.body?.Documents) || []; }
  const d = new Date().toUTCString();
  const pr = await fetch(`${EP.replace(/\/+$/, '')}/${rl}/pkranges`, { headers: { Authorization: cAuth('GET', 'pkranges', rl, d), 'x-ms-date': d, 'x-ms-version': VER } });
  const ranges = ((await pr.json()).PartitionKeyRanges || []).map((x) => x.id);
  const out = [];
  for (const rid of ranges) { const r = await cx('POST', 'docs', rl, `${rl}/docs`, { isQuery: true, body: { query: q }, pkRange: rid }); out.push(...((r.body?.Documents) || [])); }
  return out;
}
const newId = (p) => `${p}_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`;
async function appendEvent(taskId, kind, actor, detail) {
  await cx('POST', 'docs', `dbs/${DB}/colls/events`, `dbs/${DB}/colls/events/docs`, { pk: taskId, body: { id: newId('e'), type: 'event', task_id: taskId, kind, actor, detail, ts: new Date().toISOString() } });
}

// ---- done=artifact resolver (blob / cosmos / https-SSRF-guarded) ----
function ipBlocked(ip) {
  if (net.isIP(ip) === 4) { const p = ip.split('.').map(Number); if (p[0] === 10 || p[0] === 127 || p[0] === 0) return true; if (p[0] === 169 && p[1] === 254) return true; if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true; if (p[0] === 192 && p[1] === 168) return true; if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true; if (p[0] >= 224) return true; return false; }
  const v = ip.toLowerCase().replace(/^\[|\]$/g, ''); if (v === '::1' || v === '::') return true; if (v.startsWith('fe80') || v.startsWith('fc') || v.startsWith('fd')) return true; const m = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/); if (m) return ipBlocked(m[1]); return false;
}
async function hostSafe(h) { if (net.isIP(h)) return !ipBlocked(h); try { const a = await dns.lookup(h, { all: true }); return a.length > 0 && a.every((x) => !ipBlocked(x.address)); } catch { return false; } }
function commonsSas() { const sv = '2021-12-02', ss = 'b', srt = 'co', perm = 'rl'; const st = `${new Date(Date.now() - 3e5).toISOString().slice(0, 19)}Z`; const se = `${new Date(Date.now() + 36e5).toISOString().slice(0, 19)}Z`; const sts = `${[CACCT, perm, ss, srt, st, se, '', 'https', sv, ''].join('\n')}\n`; return new URLSearchParams({ sv, ss, srt, sp: perm, st, se, spr: 'https', sig: crypto.createHmac('sha256', Buffer.from(CKEY, 'base64')).update(sts, 'utf8').digest('base64') }).toString(); }
async function resolveArtifact(uri) {
  uri = (uri || '').trim();
  if (!uri) return { resolved: false, detail: 'empty' };
  if (uri.startsWith('blob:')) { if (!CACCT) return { resolved: false, detail: 'commons not configured' }; const rel = uri.slice(5).replace(/^company-journal\//, ''); const enc = rel.split('/').map(encodeURIComponent).join('/'); const r = await fetch(`https://${CACCT}.blob.core.windows.net/company-journal/${enc}?${commonsSas()}`, { method: 'HEAD' }); return { resolved: r.status === 200, detail: `blob ${rel} -> ${r.status}` }; }
  if (uri.startsWith('cosmos:')) { const [coll, pk, id] = uri.slice(7).split('/'); if (!['tasks', 'memory', 'events'].includes(coll) || !idOk(pk) || !idOk(id)) return { resolved: false, detail: 'bad cosmos uri' }; const r = await cx('GET', 'docs', `dbs/${DB}/colls/${coll}/docs/${id}`, `dbs/${DB}/colls/${coll}/docs/${id}`, { pk }); return { resolved: r.status === 200, detail: `cosmos ${coll}/${id} -> ${r.status}` }; }
  if (uri.startsWith('https://')) { let u; try { u = new URL(uri); } catch { return { resolved: false, detail: 'bad url' }; } if (!(await hostSafe(u.hostname))) return { resolved: false, detail: `blocked host ${u.hostname}` }; try { const r = await fetch(uri, { method: 'HEAD', redirect: 'manual' }); return { resolved: r.status < 400, detail: `${u.hostname} -> ${r.status}` }; } catch { return { resolved: false, detail: 'fetch failed' }; } }
  return { resolved: false, detail: 'unrecognized scheme (use blob:/cosmos:/https:)' };
}

// ---- queue inbox ----
function qSas(perm = 'racwlup') { const sv = '2021-12-02', ss = 'q', srt = 'sco'; const st = `${new Date(Date.now() - 3e5).toISOString().slice(0, 19)}Z`; const se = `${new Date(Date.now() + 36e5).toISOString().slice(0, 19)}Z`; const sts = `${[QACCT, perm, ss, srt, st, se, '', 'https', sv, ''].join('\n')}\n`; return new URLSearchParams({ sv, ss, srt, sp: perm, st, se, spr: 'https', sig: crypto.createHmac('sha256', Buffer.from(QKEY, 'base64')).update(sts, 'utf8').digest('base64') }).toString(); }
const qName = (a) => `inbox-${agentOk(a).replace(/_/g, '-')}`.replace(/-+/g, '-');
async function inboxSend(to, msg) { const q = qName(to); await fetch(`https://${QACCT}.queue.core.windows.net/${q}?${qSas()}`, { method: 'PUT' }); const payload = Buffer.from(JSON.stringify(msg)).toString('base64'); const r = await fetch(`https://${QACCT}.queue.core.windows.net/${q}/messages?${qSas()}`, { method: 'POST', headers: { 'Content-Type': 'application/xml' }, body: `<QueueMessage><MessageText>${payload}</MessageText></QueueMessage>` }); return r.status; }
async function inboxRead(a, { peek = false, max = 16 } = {}) { const q = qName(a); await fetch(`https://${QACCT}.queue.core.windows.net/${q}?${qSas()}`, { method: 'PUT' }); const r = await fetch(`https://${QACCT}.queue.core.windows.net/${q}/messages?numofmessages=${max}&visibilitytimeout=60&${qSas()}`); const xml = await r.text(); const out = []; for (const b of xml.matchAll(/<QueueMessage>([\s\S]*?)<\/QueueMessage>/g)) { const g = b[1]; const id = (g.match(/<MessageId>([^<]+)</) || [])[1]; const pop = (g.match(/<PopReceipt>([^<]+)</) || [])[1]; const txt = (g.match(/<MessageText>([^<]*)</) || [])[1] || ''; let m; try { m = JSON.parse(Buffer.from(txt, 'base64').toString()); } catch { m = { body: txt }; } if (!peek && id && pop) await fetch(`https://${QACCT}.queue.core.windows.net/${q}/messages/${id}?popreceipt=${encodeURIComponent(pop)}&${qSas()}`, { method: 'DELETE' }); out.push(m); } return out; }

// ---- arg parsing ----
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const has = (n) => argv.includes(`--${n}`);
const pos = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--')));
const out = (o) => console.log(typeof o === 'string' ? o : JSON.stringify(o, null, 2));

(async () => {
  const [group, verb] = [pos[0], pos[1]];
  await init();
  if (group === 'whoami') { const t = await query('tasks', "SELECT VALUE COUNT(1) FROM c WHERE c.board='fleet'", 'fleet'); out(`agent-ledger OK. Cosmos ${EP}. tasks in fleet board: ${t[0] ?? 0}. inbox: ${QACCT ? 'configured' : 'MISSING'}.`); return; }

  if (group === 'task') {
    if (verb === 'create') {
      const owner = agentOk(flag('owner')); const now = new Date().toISOString(); const id = newId('t');
      const doc = { id, board: 'fleet', type: 'task', title: flag('title') || '(untitled)', description: flag('desc') || '', owner_agent: owner, status: 'open', priority: flag('priority') || 'normal', tags: (flag('tags') || '').split(',').filter(Boolean), artifact_uri: null, created_by: flag('by') || 'unknown', created_at: now, updated_at: now, claim_ts: null, lease_until: null, done_ts: null, notes: [] };
      const r = await cx('POST', 'docs', `dbs/${DB}/colls/tasks`, `dbs/${DB}/colls/tasks/docs`, { pk: 'fleet', body: doc });
      if (!r.ok) throw new Error(`create -> ${r.status}`); await appendEvent(id, 'created', doc.created_by, `for ${owner}`); out(`created ${id} for ${owner} [open]`); return;
    }
    if (verb === 'list') {
      const conds = ["c.board='fleet'", "c.type='task'"]; if (flag('owner')) conds.push(`c.owner_agent='${agentOk(flag('owner'))}'`); if (flag('status')) conds.push(`c.status='${flag('status')}'`);
      const rows = await query('tasks', `SELECT c.id,c.owner_agent,c.status,c.priority,c.title FROM c WHERE ${conds.join(' AND ')}`, 'fleet');
      out(rows.length ? rows.map((r) => `[${r.status}] ${r.priority} ${r.owner_agent}  ${r.id}  ${r.title}`).join('\n') : '(no tasks)'); return;
    }
    if (verb === 'get') { const id = pos[2]; const r = await cx('GET', 'docs', `dbs/${DB}/colls/tasks/docs/${id}`, `dbs/${DB}/colls/tasks/docs/${id}`, { pk: 'fleet' }); if (r.status === 404) return out('not found'); const ev = await query('events', `SELECT c.kind,c.actor,c.ts,c.detail FROM c WHERE c.task_id='${id}'`, id); out({ task: r.body, events: ev }); return; }
    if (verb === 'claim') {
      const id = pos[2]; const who = agentOk(flag('agent'));
      const r = await cx('GET', 'docs', `dbs/${DB}/colls/tasks/docs/${id}`, `dbs/${DB}/colls/tasks/docs/${id}`, { pk: 'fleet' }); if (r.status === 404) return out('not found');
      const t = r.body, now = new Date();
      if ((t.status === 'done' || t.status === 'cancelled')) return out(`cannot claim: ${t.status}`);
      if (t.status === 'claimed' && t.owner_agent !== who && t.lease_until && new Date(t.lease_until) > now) return out(`conflict: leased to ${t.owner_agent} until ${t.lease_until}`);
      t.owner_agent = who; t.status = 'claimed'; t.claim_ts = now.toISOString(); t.lease_until = new Date(now.getTime() + 45 * 60000).toISOString(); t.updated_at = now.toISOString();
      const u = await cx('PUT', 'docs', `dbs/${DB}/colls/tasks/docs/${id}`, `dbs/${DB}/colls/tasks/docs/${id}`, { pk: 'fleet', body: t, ifMatch: r.etag });
      if (u.status === 412) return out('conflict (concurrent claim), retry'); if (!u.ok) throw new Error(`claim -> ${u.status}`); await appendEvent(id, 'claimed', who, `lease ${t.lease_until}`); out(`claimed ${id} for ${who} (lease 45m)`); return;
    }
    if (verb === 'update') {
      const id = pos[2]; const r = await cx('GET', 'docs', `dbs/${DB}/colls/tasks/docs/${id}`, `dbs/${DB}/colls/tasks/docs/${id}`, { pk: 'fleet' }); if (r.status === 404) return out('not found');
      const t = r.body; if (flag('status')) { if (flag('status') === 'done') return out('use "task done" (done=artifact enforced)'); t.status = flag('status'); } if (flag('priority')) t.priority = flag('priority'); if (flag('owner')) t.owner_agent = agentOk(flag('owner')); if (flag('artifact')) t.artifact_uri = flag('artifact'); if (flag('note')) t.notes = [...(t.notes || []), `[${new Date().toISOString()}] ${flag('by') || '?'}: ${flag('note')}`]; t.updated_at = new Date().toISOString();
      const u = await cx('PUT', 'docs', `dbs/${DB}/colls/tasks/docs/${id}`, `dbs/${DB}/colls/tasks/docs/${id}`, { pk: 'fleet', body: t, ifMatch: r.etag }); if (!u.ok) throw new Error(`update -> ${u.status}`); await appendEvent(id, 'updated', flag('by') || '?', flag('note') || flag('status') || ''); out(`updated ${id}`); return;
    }
    if (verb === 'done') {
      const id = pos[2]; const who = agentOk(flag('agent')); const uri = flag('artifact');
      const res = await resolveArtifact(uri);
      if (!res.resolved) { await appendEvent(id, 'complete_rejected', who, `${uri} :: ${res.detail}`); return out(`REJECTED (done=artifact): ${res.detail}. Land the work-product first (blob:/cosmos:/https:).`); }
      const r = await cx('GET', 'docs', `dbs/${DB}/colls/tasks/docs/${id}`, `dbs/${DB}/colls/tasks/docs/${id}`, { pk: 'fleet' }); if (r.status === 404) return out('not found');
      const t = r.body, now = new Date().toISOString(); t.status = 'done'; t.artifact_uri = uri; t.done_ts = now; t.updated_at = now; if (flag('note')) t.notes = [...(t.notes || []), `[${now}] ${who} (done): ${flag('note')}`];
      const u = await cx('PUT', 'docs', `dbs/${DB}/colls/tasks/docs/${id}`, `dbs/${DB}/colls/tasks/docs/${id}`, { pk: 'fleet', body: t, ifMatch: r.etag }); if (!u.ok) throw new Error(`done -> ${u.status}`); await appendEvent(id, 'completed', who, `artifact ${uri} (${res.detail})`); out(`DONE ${id} - artifact verified (${res.detail})`); return;
    }
  }

  if (group === 'mem') {
    if (verb === 'write') { const agent = agentOk(flag('agent')); const kind = flag('kind'); if (!MEMORY_KINDS.includes(kind)) throw new Error(`kind must be one of ${MEMORY_KINDS.join('|')}`); const rec = { id: newId('m'), type: 'memory', agent, kind, text: flag('text') || '', tags: (flag('tags') || '').split(',').filter(Boolean), source: flag('source') || null, created_at: new Date().toISOString() }; const r = await cx('POST', 'docs', `dbs/${DB}/colls/memory`, `dbs/${DB}/colls/memory/docs`, { pk: agent, body: rec }); if (!r.ok) throw new Error(`mem write -> ${r.status}`); out(`wrote ${rec.id} (${kind}) for ${agent}`); return; }
    if (verb === 'search') { const conds = ["c.type='memory'"]; if (flag('agent')) conds.push(`c.agent='${agentOk(flag('agent'))}'`); if (flag('kind')) conds.push(`c.kind='${flag('kind')}'`); if (flag('contains')) conds.push(`CONTAINS(LOWER(c.text),'${(flag('contains') || '').toLowerCase().replace(/'/g, '')}')`); const rows = (await query('memory', `SELECT c.id,c.agent,c.kind,c.text,c.source FROM c WHERE ${conds.join(' AND ')}`, flag('agent') ? agentOk(flag('agent')) : undefined)).slice(0, parseInt(flag('limit', '15'), 10)); out(rows.length ? rows.map((r) => `[${r.kind}] ${r.agent} (${r.source || ''}): ${String(r.text).slice(0, 200)}`).join('\n\n') : '(no matches)'); return; }
  }

  if (group === 'inbox') {
    if (verb === 'send') { const st = await inboxSend(flag('to'), { to: agentOk(flag('to')), from: flag('from') || '?', subject: flag('subject') || '', body: flag('body') || '', ts: new Date().toISOString(), ...(flag('task') ? { task_id: flag('task') } : {}) }); out(`dispatched to ${flag('to')} inbox [${st}]`); return; }
    if (verb === 'read') { const msgs = await inboxRead(flag('agent'), { peek: has('peek'), max: parseInt(flag('max', '16'), 10) }); out(msgs.length ? msgs.map((m) => `FROM ${m.from} | ${m.subject}${m.task_id ? ` | task ${m.task_id}` : ''}\n  ${m.body}`).join('\n\n') : '(inbox empty)'); return; }
  }

  out('usage: whoami | task {create|list|get|claim|update|done} | mem {write|search} | inbox {send|read}  (see the SKILL.md)');
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
