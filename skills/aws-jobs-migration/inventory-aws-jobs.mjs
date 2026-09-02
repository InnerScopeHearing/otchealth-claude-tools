#!/usr/bin/env node
// Pulls the full, live, authoritative inventory of every AWS EventBridge Scheduler schedule and
// every ECS job task-definition family in the otchealth account, read-only.
//
// Usage: node inventory-aws-jobs.mjs [--out <file>]
// Auth: aws-cto-access-key-id / aws-cto-secret-access-key (Key Vault), signed via ../../setup/
// aws-sigv4.mjs (FND-20260828-5ca1, 2026-09-02 -- one of nine hand-rolled SigV4 implementations this
// fleet had grown, consolidated into a single shared signer; see that file's header for the full
// writeup of which ones were actually wrong, including a latent bug in the EventBridge Scheduler path
// this file itself signs at line ~50 below).
import fs from 'node:fs';
import { kvSecret } from '../kb-memory/azure-secret.mjs';
import { awsFetch, canonicalUriPath } from '../../setup/aws-sigv4.mjs';

const outArg = process.argv.indexOf('--out');
const OUT = outArg !== -1 ? process.argv[outArg + 1] : null;

const AK = (await kvSecret('aws-cto-access-key-id')).trim();
const SK = (await kvSecret('aws-cto-secret-access-key')).trim();
const CREDS = { accessKeyId: AK, secretAccessKey: SK };

async function awsCall({ service, region = 'us-east-1', host, method = 'GET', path = '/', query = '', body = '', headers = {} }) {
  host = host || `${service}.${region}.amazonaws.com`;
  const url = `https://${host}${path}${query ? `?${query}` : ''}`;
  const r = await awsFetch(url, { method, headers, body }, { service, region, credentials: CREDS });
  return { status: r.status, text: r.text };
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
  const d = await awsCall({ service: 'scheduler', method: 'GET', path: canonicalUriPath(`/schedules/${s.Name}`), query: `groupName=${encodeURIComponent(gr)}` });
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
