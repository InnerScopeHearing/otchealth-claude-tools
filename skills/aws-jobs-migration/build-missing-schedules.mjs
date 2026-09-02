#!/usr/bin/env node
// Registers the ECS task definitions + DISABLED EventBridge schedules for every Azure Container
// Apps Job that has NO AWS twin yet, following the EXACT live pattern the pre-existing 22 already
// use (verified 2026-08-16 via DescribeTaskDefinition on otchealth-job-brain-reindex and GetSchedule
// on otchealth-librarian-commerce -- see runbooks/AWS-JOBS-MIGRATION-WAVE-B.md for the full
// derivation). Never enables anything; every schedule this script creates is born DISABLED and this
// script has no code path that can change that.
//
// IDEMPOTENT: if a schedule with the target name already exists (by any means -- a prior run of this
// script, or hand-built the way the original 22 were), the whole job is skipped before ANY mutation:
// no schedule is re-created or overwritten, and no task definition is registered for it either. An
// earlier version of this comment said "task definitions ARE re-registered on every run"; that is
// wrong and always was, because the existing-schedule branch `continue`s before RegisterTaskDefinition.
// Task definitions are registered ONLY for jobs that pass the existence check as confirmed-absent.
// (Registration itself is inherently additive -- it always creates a new revision, never mutates one --
// which is why an unnecessary registration is silent churn rather than a loud failure, and therefore
// worth preventing rather than tolerating.) A schedule that already exists keeps pointing at whatever
// revision it was created against; inspect the diff before manually repointing one at a newer revision.
//
// Usage:
//   node build-missing-schedules.mjs                 create every JOB below that has no schedule yet
//   node build-missing-schedules.mjs --dry-run        print what would be created, touch nothing
//   node build-missing-schedules.mjs --only <name>    build a single job by its Azure name
//
// Auth: aws-cto-access-key-id / aws-cto-secret-access-key (Key Vault), signed via ../../setup/
// aws-sigv4.mjs (FND-20260828-5ca1, 2026-09-02 -- one of nine hand-rolled SigV4 implementations this
// fleet had grown, consolidated into a single shared signer; see that file's header for the full
// writeup, including a latent bug in the EventBridge Scheduler paths this file itself signs below).
import { kvSecret } from '../kb-memory/azure-secret.mjs';
import { awsFetch, canonicalUriPath } from '../../setup/aws-sigv4.mjs';

const DRY_RUN = process.argv.includes('--dry-run');
const onlyIdx = process.argv.indexOf('--only');
const ONLY = onlyIdx !== -1 ? process.argv[onlyIdx + 1] : null;

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
const schedulerGet = (name) => awsCall({ service: 'scheduler', method: 'GET', path: canonicalUriPath(`/schedules/${name}`), query: 'groupName=default' });
const schedulerCreate = (name, body) => awsCall({
  service: 'scheduler', method: 'POST', path: canonicalUriPath(`/schedules/${name}`), body: JSON.stringify(body),
  headers: { 'Content-Type': 'application/json' },
});

const EXEC_ROLE = 'arn:aws:iam::900915535335:role/otchealthEcsExecutionRole';
const TASK_ROLE = 'arn:aws:iam::900915535335:role/otchealthTaskRole';
const SCHED_ROLE = 'arn:aws:iam::900915535335:role/otchealthSchedulerRole';
const CLUSTER_ARN = 'arn:aws:ecs:us-east-1:900915535335:cluster/otchealth';
const SUBNETS = ['subnet-0a94aaba3ce6e2623', 'subnet-0e39a2049aa73ab50', 'subnet-09695b3527b656f4a'];
const SG = ['sg-0a5d44b67befc3bbe'];
const DOC_INDEXER = '900915535335.dkr.ecr.us-east-1.amazonaws.com/doc-indexer:latest';
const UAMI = '01b82248-86b1-4237-a8f3-8317cf9d5f33'; // Azure-only, non-functional on AWS -- carried forward for capture fidelity, matching the existing 22's own precedent. See runbook "KV-DEPENDENT" note.
const KV_NAME = 'kv-otc-55c84f6bef';

// The 10 jobs confirmed NO-AWS-TWIN + genuinely recurring (Schedule trigger, not Manual) as of the
// 2026-08-16 matrix (see data/matrix.json). Re-derive this list from a fresh inventory-azure-jobs.mjs
// run + data/matrix.json before assuming it is still complete -- new jobs may have been added since.
export const JOBS = [
  {
    name: 'agent-memory-worker', cpu: '512', memory: '1024',
    image: '900915535335.dkr.ecr.us-east-1.amazonaws.com/agent-memory-worker:v2',
    imageGap: 'NO AWS ECR REPO EXISTS for this image (verified 2026-08-16: only otchealth-mcp-gateway, doc-indexer, otchealth-os-chat, fourvault-api, pressgolf-api exist). RunTask will fail on image pull until a repo is created and v2 is pushed. Source: otchealth-cto PRs #35/#38, not in this repo.',
    entryPoint: null, command: null,
    env: [
      { name: 'AZURE_KEYVAULT_NAME', value: KV_NAME },
      { name: 'AGENT_MEMORY_COSMOS_ACCOUNT', value: 'cosmos-otc-agentstate-55c84' },
      { name: 'AGENT_MEMORY_COSMOS_DATABASE', value: 'ai_memory' },
    ],
    secrets: [], cron: 'cron(*/15 * * * ? *)', streamPrefix: 'agent-memory-worker',
  },
  {
    name: 'agent-state-janitor', cpu: '1024', memory: '2048', image: DOC_INDEXER,
    entryPoint: ['node'], command: ['/app/skills/doc-indexer/job/agent-state-janitor.mjs'],
    env: [{ name: 'AZURE_KEYVAULT_NAME', value: KV_NAME }], secrets: [],
    cron: 'cron(30 */6 * * ? *)', streamPrefix: 'agent-state-janitor',
  },
  {
    name: 'cfo-reconstruction-nightly', cpu: '1024', memory: '2048', image: DOC_INDEXER,
    entryPoint: ['/bin/sh'], command: ['/app/skills/cfo-reconstruction/job/cfo-nightly.sh'],
    env: [
      { name: 'AZURE_KEYVAULT_NAME', value: KV_NAME },
      { name: 'AZURE_UAMI_CLIENT_ID', value: UAMI },
    ],
    secrets: [], cron: 'cron(10 8 * * ? *)', streamPrefix: 'cfo-reconstruction-nightly',
  },
  {
    name: 'decision-clock', cpu: '1024', memory: '2048', image: DOC_INDEXER,
    entryPoint: ['/bin/sh'], command: ['/app/setup/with-heartbeat.sh', 'decision-clock', '--', '/bin/sh', '/app/skills/decision-clock/job/decision-clock-sweep.sh'],
    env: [
      { name: 'AZURE_KEYVAULT_NAME', value: KV_NAME },
      { name: 'AZURE_UAMI_CLIENT_ID', value: UAMI },
    ],
    secrets: [], cron: 'cron(15 23 * * ? *)', streamPrefix: 'decision-clock',
  },
  {
    name: 'fleet-medic', cpu: '1024', memory: '2048', image: DOC_INDEXER,
    entryPoint: ['/bin/sh'], command: ['/app/skills/doc-indexer/job/fleet-medic.sh'],
    env: [{ name: 'AZURE_KEYVAULT_NAME', value: KV_NAME }], secrets: [],
    cron: 'cron(*/30 * * * ? *)', streamPrefix: 'fleet-medic',
  },
  {
    name: 'growth-room-nightly', cpu: '1024', memory: '2048', image: DOC_INDEXER,
    entryPoint: ['/bin/sh'], command: ['/app/skills/growth-room/job/growth-room-nightly.sh'],
    env: [
      { name: 'AZURE_KEYVAULT_NAME', value: KV_NAME },
      { name: 'AZURE_UAMI_CLIENT_ID', value: UAMI },
      { name: 'SKIP_PUSH_SEARCH', value: '1' },
    ],
    secrets: [], cron: 'cron(50 8 * * ? *)', streamPrefix: 'growth-room-nightly',
  },
  {
    name: 'ledger-compaction', cpu: '1024', memory: '2048', image: DOC_INDEXER,
    entryPoint: ['/bin/sh'], command: ['/app/skills/ledger-compaction/job/compaction.sh'],
    env: [{ name: 'AZURE_KEYVAULT_NAME', value: KV_NAME }], secrets: [],
    cron: 'cron(0 8 * * ? *)', streamPrefix: 'ledger-compaction',
    hazard: 'HIGH-RISK-CORRUPTION if ever enabled concurrently with the Azure twin -- compaction jobs mutate a store in place. See runbook.',
  },
  {
    name: 'memory-librarian', cpu: '2048', memory: '4096', image: DOC_INDEXER,
    entryPoint: ['/bin/sh'], command: ['/app/skills/doc-indexer/job/memory-librarian.sh', '--days', '2'],
    env: [
      { name: 'AZURE_KEYVAULT_NAME', value: KV_NAME },
      { name: 'AZURE_UAMI_CLIENT_ID', value: UAMI },
    ],
    secrets: [], cron: 'cron(0 8 * * ? *)', streamPrefix: 'memory-librarian',
  },
  {
    name: 'ring-memory-index-daily', cpu: '1024', memory: '2048', image: DOC_INDEXER,
    entryPoint: ['/bin/sh'], command: ['/app/setup/with-heartbeat.sh', 'ring-memory-index-daily', '--', 'node', '/app/skills/ring-memory-index/index-ring-memory.mjs', 'all'],
    env: [
      { name: 'AZURE_KEYVAULT_NAME', value: KV_NAME },
      { name: 'AZURE_UAMI_CLIENT_ID', value: UAMI },
    ],
    secrets: [], cron: 'cron(40 23 * * ? *)', streamPrefix: 'ring-memory-index-daily',
  },
  {
    name: 'signal-radar', cpu: '1024', memory: '2048', image: DOC_INDEXER,
    entryPoint: ['/bin/sh'], command: ['/app/setup/with-heartbeat.sh', 'signal-radar', '--', '/bin/sh', '/app/skills/signal-radar/job/radar.sh'],
    env: [
      { name: 'AZURE_KEYVAULT_NAME', value: KV_NAME },
      { name: 'AZURE_UAMI_CLIENT_ID', value: UAMI },
    ],
    secrets: [], cron: 'cron(*/30 * * * ? *)', streamPrefix: 'signal-radar',
  },
];

async function main() {
  const targets = ONLY ? JOBS.filter((j) => j.name === ONLY) : JOBS;
  if (ONLY && targets.length === 0) {
    console.error(`--only ${ONLY}: no such job in JOBS[]`);
    process.exit(1);
  }

  const results = [];
  for (const j of targets) {
    const schedName = `otchealth-${j.name}`;
    // Existence check is THREE-valued, not two. `200 -> skip, anything else -> create` is
    // fail-OPEN: it silently reclassifies "I could not determine" (403 expired creds, 429
    // throttle, 5xx AWS blip) into "it does not exist", and then MUTATES AWS on that basis --
    // registering a redundant task-definition revision, then attempting a create that the
    // real schedule will reject. That breaks the idempotency this script's own SKILL.md and
    // runbook promise, and the damage (a spurious task-def revision) lands BEFORE the
    // conflicting create is refused. Only a confirmed 404 is proof of absence; everything
    // else fails closed and leaves the job for a human, because a re-run after a transient
    // error is exactly when this path gets exercised.
    const existing = await schedulerGet(schedName);
    if (existing.status === 200) {
      console.log('SKIP (already exists)', schedName);
      results.push({ name: j.name, ok: true, skipped: true });
      continue;
    }
    if (existing.status !== 404) {
      console.log('EXISTENCE CHECK INCONCLUSIVE', schedName, existing.status, existing.text.slice(0, 300));
      results.push({
        name: j.name, ok: false, stage: 'exists-check', status: existing.status,
        error: `GetSchedule returned ${existing.status} (not 200, not 404), so absence is unproven; refusing to create. ${existing.text.slice(0, 300)}`,
      });
      continue;
    }

    if (DRY_RUN) {
      console.log('DRY-RUN would create', schedName, '| cron:', j.cron, '| image:', j.image, j.imageGap ? '| ** IMAGE GAP: ' + j.imageGap + ' **' : '');
      results.push({ name: j.name, ok: true, dryRun: true });
      continue;
    }

    const family = `otchealth-job-${j.name}`;
    const containerDef = {
      name: 'job',
      image: j.image,
      essential: true,
      logConfiguration: {
        logDriver: 'awslogs',
        options: { 'awslogs-group': '/ecs/otchealth', 'awslogs-region': 'us-east-1', 'awslogs-stream-prefix': j.streamPrefix },
      },
      environment: j.env,
      secrets: j.secrets,
    };
    if (j.entryPoint) containerDef.entryPoint = j.entryPoint;
    if (j.command) containerDef.command = j.command;

    const tdRes = await ecs('RegisterTaskDefinition', {
      family, requiresCompatibilities: ['FARGATE'], networkMode: 'awsvpc',
      cpu: j.cpu, memory: j.memory, executionRoleArn: EXEC_ROLE, taskRoleArn: TASK_ROLE,
      containerDefinitions: [containerDef],
    });
    if (tdRes.status !== 200) {
      console.log('TASK DEF FAILED', j.name, tdRes.status, tdRes.text.slice(0, 500));
      results.push({ name: j.name, ok: false, stage: 'taskdef', error: tdRes.text.slice(0, 500) });
      continue;
    }
    const tdArn = JSON.parse(tdRes.text).taskDefinition.taskDefinitionArn;
    console.log('REGISTERED', family, '->', tdArn);

    const schedRes = await schedulerCreate(schedName, {
      Name: schedName,
      ClientToken: crypto.randomUUID(), // required by the direct REST API; the SDK normally hides this
      GroupName: 'default',
      ScheduleExpression: j.cron,
      ScheduleExpressionTimezone: 'UTC',
      State: 'DISABLED', // NEVER anything else here -- cutover is a deliberate, per-job, human-gated action
      FlexibleTimeWindow: { Mode: 'OFF' },
      Target: {
        Arn: CLUSTER_ARN,
        RoleArn: SCHED_ROLE,
        EcsParameters: {
          TaskDefinitionArn: tdArn,
          TaskCount: 1,
          LaunchType: 'FARGATE',
          NetworkConfiguration: { awsvpcConfiguration: { Subnets: SUBNETS, SecurityGroups: SG, AssignPublicIp: 'ENABLED' } },
        },
        RetryPolicy: { MaximumRetryAttempts: 1, MaximumEventAgeInSeconds: 3600 },
      },
    });
    if (schedRes.status !== 200) {
      console.log('SCHEDULE FAILED', j.name, schedRes.status, schedRes.text.slice(0, 500));
      results.push({ name: j.name, ok: false, stage: 'schedule', taskDefArn: tdArn, error: schedRes.text.slice(0, 500) });
      continue;
    }
    console.log('SCHEDULED (DISABLED)', schedName, '| cron:', j.cron, '| target:', tdArn, j.imageGap ? '| ** IMAGE GAP, see imageGap field **' : '');
    results.push({ name: j.name, ok: true, taskDefArn: tdArn, scheduleName: schedName, cron: j.cron });
  }

  console.log('\n=== SUMMARY ===');
  for (const r of results) console.log(r.skipped ? 'SKIP' : r.ok ? 'OK  ' : 'FAIL', r.name);
  const failed = results.filter((r) => !r.ok);
  if (failed.length) process.exit(1);
}

await main();
