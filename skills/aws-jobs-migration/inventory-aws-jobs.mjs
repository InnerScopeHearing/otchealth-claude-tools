#!/usr/bin/env node
// Pulls the full, live, authoritative inventory of every AWS EventBridge Scheduler schedule and
// every ECS job task-definition family in the otchealth account, read-only.
//
// Usage: node inventory-aws-jobs.mjs [--out <file>]
// Auth: aws-cto-access-key-id / aws-cto-secret-access-key (Key Vault), hand-rolled SigV4.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { kvSecret } from '../kb-memory/azure-secret.mjs';

const outArg = process.argv.indexOf('--out');
const OUT = outArg !== -1 ? process.argv[outArg + 1] : null;

const AK = (await kvSecret('aws-cto-access-key-id')).trim();
const SK = (await kvSecret('aws-cto-secret-access-key')).trim();

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();

async function awsCall({ service, region = 'us-east-1', host, method = 'GET', path = '/', query = '', body = '', headers = {} }) {
  if (query) query = query.split('&').filter(Boolean).sort().join('&');
  host = host || `${service}.${region}.amazonaws.com`;
  const amz = new Date().toISOString().replace(/[:-]|\..{3}/g, '');
  const date = amz.slice(0, 8);
  const hh = { host, 'x-amz-date': amz, 'x-amz-content-sha256': sha256(body), ...headers };
  const keys = Object.keys(hh).map((k) => k.toLowerCase()).sort();
  const canonH = keys.map((k) => `${k}:${String(hh[Object.keys(hh).find((x) => x.toLowerCase() === k)]).trim()}\n`).join('');
  const signed = keys.join(';');
  const creq = [method, path, query, canonH, signed, sha256(body)].join('\n');
  const scope = `${date}/${region}/${service}/aws4_request`;
  const sts = ['AWS4-HMAC-SHA256', amz, scope, sha256(creq)].join('\n');
  let k = hmac('AWS4' + SK, date);
  k = hmac(k, region); k = hmac(k, service); k = hmac(k, 'aws4_request');
  const sig = crypto.createHmac('sha256', k).update(sts).digest('hex');
  hh.Authorization = `AWS4-HMAC-SHA256 Credential=${AK}/${scope}, SignedHeaders=${signed}, Signature=${sig}`;
  const url = `https://${host}${path}${query ? '?' + query : ''}`;
  const r = await fetch(url, { method, headers: hh, body: method === 'GET' ? undefined : body });
  return { status: r.status, text: await r.text() };
}

const ecs = (t, b) => awsCall({
  service: 'ecs', host: 'ecs.us-east-1.amazonaws.com', method: 'POST', body: JSON.stringify(b),
  headers: { 'X-Amz-Target': 'AmazonEC2ContainerServiceV20141113.' + t, 'Content-Type': 'application/x-amz-json-1.1' },
});

// 1. Every EventBridge schedule, with full target detail (state, cron, task-def ARN, network config).
let r = await awsCall({ service: 'scheduler', method: 'GET', path: '/schedules', query: 'MaxResults=60' });
const scheduleList = JSON.parse(r.text).Schedules || [];
const schedules = {};
for (const s of scheduleList) {
  const gr = s.GroupName || 'default';
  const d = await awsCall({ service: 'scheduler', method: 'GET', path: `/schedules/${encodeURIComponent(s.Name)}`, query: `groupName=${encodeURIComponent(gr)}` });
  const detail = JSON.parse(d.text);
  schedules[s.Name] = {
    state: detail.State,
    group: gr,
    scheduleExpression: detail.ScheduleExpression,
    timezone: detail.ScheduleExpressionTimezone,
    targetArn: detail.Target?.EcsParameters?.TaskDefinitionArn || detail.Target?.Arn,
    lastModified: s.LastModificationDate,
  };
}

// 2. Every ECS task-definition family (active revisions).
r = await ecs('ListTaskDefinitionFamilies', { status: 'ACTIVE' });
const families = (JSON.parse(r.text).families || []).sort();

const out = { generated_at: new Date().toISOString(), schedule_count: scheduleList.length, all_disabled: scheduleList.every((s) => s.State === 'DISABLED'), schedules, task_definition_families: families };

const payload = JSON.stringify(out, null, 2);
if (OUT) {
  fs.writeFileSync(OUT, payload);
  console.log(`wrote ${scheduleList.length} schedules + ${families.length} task-def families to ${OUT}`);
} else {
  console.log(payload);
}
