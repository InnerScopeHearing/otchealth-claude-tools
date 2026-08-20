#!/usr/bin/env node
// Pulls the full, live, authoritative inventory of every Azure Container Apps Job across both
// production resource groups (rg-otchealth-apps-prod, otchealth-automation-rg), read-only.
//
// For each job: name, resource group, trigger type + cron, timeout/parallelism, image,
// command/args, env vars (names + values, secretRefs by name only -- never a resolved secret
// value), Container Apps identity (SystemAssigned / UserAssigned / None), and the last 5
// executions with status + timestamps.
//
// Usage: node inventory-azure-jobs.mjs [--out <file>]
// Auth: azure-sp (client_credentials -> management.azure.com), read-only ARM calls only.
import fs from 'node:fs';
import { kvSecret } from '../kb-memory/azure-secret.mjs';

const outArg = process.argv.indexOf('--out');
const OUT = outArg !== -1 ? process.argv[outArg + 1] : null;

const clientId = (await kvSecret('azure-sp-client-id')).trim();
const clientSecret = (await kvSecret('azure-sp-client-secret')).trim();
const tenantId = (await kvSecret('azure-sp-tenant-id')).trim();
const subId = (await kvSecret('azure-subscription-id')).trim();

const tokRes = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'client_credentials',
    scope: 'https://management.azure.com/.default',
  }),
});
const tokJ = await tokRes.json();
if (!tokJ.access_token) {
  console.error('TOKEN FAIL', JSON.stringify(tokJ));
  process.exit(1);
}
const AT = tokJ.access_token;

async function arm(path) {
  const r = await fetch(`https://management.azure.com${path}`, { headers: { Authorization: `Bearer ${AT}` } });
  const t = await r.text();
  let j;
  try {
    j = JSON.parse(t);
  } catch {
    j = { raw: t };
  }
  return { status: r.status, body: j };
}

// List ALL Container Apps Jobs subscription-wide (paginated).
let jobs = [];
let path = `/subscriptions/${subId}/providers/Microsoft.App/jobs?api-version=2024-03-01`;
while (path) {
  const r = await arm(path);
  if (r.status !== 200) {
    console.error('LIST FAIL', r.status, JSON.stringify(r.body).slice(0, 300));
    process.exit(1);
  }
  jobs.push(...(r.body.value || []));
  path = r.body.nextLink ? r.body.nextLink.replace('https://management.azure.com', '') : null;
}

const out = [];
for (const j of jobs) {
  const rg = j.id.split('/resourceGroups/')[1]?.split('/')[0];
  const cfg = j.properties?.configuration || {};
  const tmpl = j.properties?.template?.containers?.[0] || {};
  const env = (tmpl.env || []).map((e) => ({ name: e.name, value: e.value ?? null, secretRef: e.secretRef ?? null }));
  const secrets = (j.properties?.configuration?.secrets || []).map((s) => ({ name: s.name, keyVaultUrl: s.keyVaultUrl || null }));
  const identity = j.identity || null;

  let execs = [];
  const er = await arm(`/subscriptions/${subId}/resourceGroups/${rg}/providers/Microsoft.App/jobs/${j.name}/executions?api-version=2024-03-01`);
  if (er.status === 200) {
    execs = (er.body.value || [])
      .sort((a, b) => new Date(b.properties?.startTime || 0) - new Date(a.properties?.startTime || 0))
      .slice(0, 5)
      .map((e) => ({ name: e.name, status: e.properties?.status, startTime: e.properties?.startTime, endTime: e.properties?.endTime }));
  } else {
    execs = [{ ERROR: er.status }];
  }

  out.push({
    name: j.name,
    rg,
    location: j.location,
    triggerType: cfg.triggerType,
    cronExpression: cfg.scheduleTriggerConfig?.cronExpression || null,
    replicaTimeout: cfg.replicaTimeout,
    parallelism: cfg.scheduleTriggerConfig?.parallelism ?? cfg.manualTriggerConfig?.parallelism ?? null,
    image: tmpl.image,
    command: tmpl.command || null,
    args: tmpl.args || null,
    cpu: tmpl.resources?.cpu,
    memory: tmpl.resources?.memory,
    env,
    secrets,
    identityType: identity?.type || 'None',
    userAssignedIdentities: identity?.userAssignedIdentities ? Object.keys(identity.userAssignedIdentities) : [],
    provisioningState: j.properties?.provisioningState,
    lastExecutions: execs,
  });
}

out.sort((a, b) => a.name.localeCompare(b.name));

const payload = JSON.stringify(out, null, 2);
if (OUT) {
  fs.writeFileSync(OUT, payload);
  console.log(`wrote ${out.length} jobs to ${OUT}`);
} else {
  console.log(payload);
}
