import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, chmod } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, '../../..');
const bootstrap = path.join(packageRoot, 'setup/iam/aws-ai-access-2026-10-07.sh');
const readerOnly = path.join(packageRoot, 'setup/iam/aws-ai-reader-role-only-2026-10-09.py');
const repair = path.join(packageRoot, 'setup/iam/aware-devicefarm-reader-repair.sh');
const account = '900915535335';
const role = 'arn:aws:iam::900915535335:role/otchealth-ai-reader-role';
const rootIdentity = {Account:account,Arn:`arn:aws:iam::${account}:root`,UserId:account};
const policyArn = 'arn:aws:iam::900915535335:policy/otchealth-ai-reader-extras';
const project = '58bbc541-f082-4594-b744-738a345f3654';
const runArn = `arn:aws:devicefarm:us-west-2:${account}:run:${project}/*`;
const projectArn = `arn:aws:devicefarm:us-west-2:${account}:project:${project}`;
const sid = 'AwareDeviceFarmRunMetadataOnly';
const schedulerSid = 'SchedulerGetOwnedScheduleMetadata';

function bootstrapExtras(source) {
  const match = source.match(/cat\s*>\s*"?\$EXTRAS_FILE"?\s*<<'EXTRAS_JSON'\r?\n([\s\S]*?)\r?\nEXTRAS_JSON/);
  assert.ok(match, 'bootstrap must retain its quoted EXTRAS_JSON policy heredoc');
  return JSON.parse(match[1]);
}

function desiredStatement() {
  return {
    Sid: sid,
    Effect: 'Allow',
    Action: ['devicefarm:GetProject', 'devicefarm:GetRun'],
    Resource: [runArn, projectArn],
    Condition: { ArnEquals: { 'aws:PrincipalArn': role } },
  };
}

function previousRunOnlyStatement() {
  return {...desiredStatement(), Resource:runArn};
}

function statements(document) {
  return Array.isArray(document.Statement) ? document.Statement : [document.Statement];
}

function baselineWithoutRepair(source) {
  const doc = structuredClone(source);
  doc.Statement = statements(doc).filter((s) => s?.Sid !== sid);
  return doc;
}

function withoutStatement(document, statementId) {
  const doc = structuredClone(document);
  doc.Statement = statements(doc).filter((s) => s?.Sid !== statementId);
  return doc;
}

function legacyGetRunTarget(source) {
  const target = withoutStatement(baselineWithoutRepair(source), schedulerSid);
  target.Statement.push(desiredStatement());
  return target;
}

function previousRunOnlyTarget(source, legacy = false) {
  const target = structuredClone(source);
  if (legacy) target.Statement = statements(target).filter((s)=>s?.Sid!==schedulerSid);
  const statement = target.Statement.find((s)=>s?.Sid===sid);
  statement.Resource = runArn;
  return target;
}

function bootstrapDeny(source) {
  const match = source.match(/cat\s*>\s*"?\$DENY_FILE"?\s*<<'DENY_JSON'\r?\n([\s\S]*?)\r?\nDENY_JSON/);
  assert.ok(match, 'bootstrap must retain its quoted DENY_JSON policy heredoc');
  return JSON.parse(match[1]);
}

test('bootstrap EXTRAS_JSON contains only the exact scoped Device Farm metadata addition', async () => {
  const doc = bootstrapExtras(await readFile(bootstrap, 'utf8'));
  const found = statements(doc).filter((s) => s?.Sid === sid);
  assert.equal(found.length, 1, 'exactly one repair statement must be in the canonical extras policy');
  assert.deepEqual(found[0], desiredStatement());
  const pythonRead = spawnSync('python3', ['-I', '-S', '-c',
    'import json,runpy,sys; print(json.dumps(runpy.run_path(sys.argv[1])["EXTRAS_DOC"], sort_keys=True))', readerOnly],
  {encoding:'utf8'});
  assert.equal(pythonRead.status, 0, pythonRead.stderr || pythonRead.stdout);
  assert.deepEqual(JSON.parse(pythonRead.stdout), doc, 'both canonical provisioning sources must carry identical extras');
});

const fakeAws = String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const scenario = JSON.parse(process.env.AWARE_MOCK_SCENARIO || '{}');
const log = process.env.AWARE_MOCK_LOG;
const statePath = process.env.AWARE_MOCK_STATE;
fs.appendFileSync(log, JSON.stringify(args) + '\n');
const writes = ['create-policy-version','delete-policy-version','create-policy','delete-policy','attach-role-policy','detach-role-policy','put-role-policy','delete-role-policy','update-assume-role-policy','create-role','delete-role'];
const operation = args[1];
if (writes.includes(operation)) {
  fs.appendFileSync(process.env.AWARE_MOCK_WRITES, JSON.stringify(args) + '\n');
  if (operation === 'create-policy-version') {
    const file = args.find((x)=>x.startsWith('file://'));
    const payload=JSON.parse(fs.readFileSync(file.slice(7),'utf8'));
    fs.writeFileSync(statePath, JSON.stringify(payload));
    fs.writeFileSync(process.env.AWARE_CAPTURE, JSON.stringify(payload));
    if(scenario.failCreate) { process.stderr.write('Uncertain mocked write result\n'); process.exit(254); }
    process.stdout.write(JSON.stringify({PolicyVersion:{VersionId:'v2'}}));
  }
  process.exit(0);
}
if (scenario.denyRead && args.join(' ').includes(scenario.denyRead)) { process.stderr.write('AccessDenied: mocked read denial\n'); process.exit(254); }
if (args[0] === 'sts' && operation === 'get-caller-identity') {
  const id = scenario.identity || {Account:'900915535335', Arn:'arn:aws:sts::900915535335:assumed-role/OwnerAdmin/session', UserId:'AIDATEST:session'};
  process.stdout.write(JSON.stringify(id)); process.exit(0);
}
if (args[0] === 'iam' && operation === 'get-role') {
  const arn = scenario.roleArn || 'arn:aws:iam::900915535335:role/otchealth-ai-reader-role';
  const Role={Arn:arn,RoleName:'otchealth-ai-reader-role',RoleId:'AROAEXACTREADER',AssumeRolePolicyDocument:scenario.trustDrift?{Version:'2012-10-17',Statement:[]}: {Version:'2012-10-17',Statement:[{Sid:'GatewayTaskRoleOnly',Effect:'Allow',Principal:{AWS:'arn:aws:iam::900915535335:role/otchealthTaskRole'},Action:'sts:AssumeRole'}]}};
  if(scenario.boundary)Role.PermissionsBoundary=scenario.boundary;
  process.stdout.write(JSON.stringify({Role})); process.exit(0);
}
if (args[0] === 'iam' && operation === 'get-policy') {
  if (scenario.missingPolicy) { process.stderr.write('NoSuchEntity\n'); process.exit(254); }
  const arn=args[args.indexOf('--policy-arn')+1];
  process.stdout.write(JSON.stringify({Policy:{Arn:arn,DefaultVersionId:fs.existsSync(statePath)?'v2':(scenario.defaultVersion || 'v1'),AttachmentCount:1}})); process.exit(0);
}
if (args[0] === 'iam' && operation === 'get-policy-version') {
  if (scenario.denyRead && args.join(' ').includes(scenario.denyRead)) { process.stderr.write('AccessDenied: mocked read denial\n'); process.exit(254); }
  const arn=args[args.indexOf('--policy-arn')+1];
  let doc = args.includes('v2') && fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath,'utf8')) : undefined;
  if (!doc && arn.endsWith(':policy/otchealth-ai-reader-extras')) doc=scenario.extras;
  if (!doc) doc = arn.endsWith(':policy/otchealth-ai-reader-deny') ? JSON.parse(fs.readFileSync(process.env.AWARE_DENY, 'utf8')) : JSON.parse(fs.readFileSync(process.env.AWARE_BASELINE, 'utf8'));
  if(scenario.denyDrift && arn.endsWith(':policy/otchealth-ai-reader-deny'))doc={Version:'2012-10-17',Statement:[]};
  if (scenario.alreadyDesired && arn.endsWith(':policy/otchealth-ai-reader-extras')) {
    const ss = Array.isArray(doc.Statement) ? doc.Statement : [doc.Statement];
    if(!ss.some((s)=>s?.Sid===${JSON.stringify(sid)}))doc = {...doc, Statement:[...ss, ${JSON.stringify(desiredStatement())}]};
  }
  process.stdout.write(JSON.stringify({PolicyVersion:{Document:doc}})); process.exit(0);
}
if (args[0] === 'iam' && operation === 'list-policy-versions') {
  const n = scenario.versionCount || 1;
  process.stdout.write(JSON.stringify({Versions:Array.from({length:n},(_,i)=>({VersionId:'v'+(i+1),IsDefaultVersion:i===0}))})); process.exit(0);
}
if (args[0] === 'iam' && operation === 'list-attached-role-policies') { const p=[{PolicyArn:'arn:aws:iam::aws:policy/job-function/ViewOnlyAccess'},{PolicyArn:'arn:aws:iam::900915535335:policy/otchealth-ai-reader-extras'},{PolicyArn:'arn:aws:iam::900915535335:policy/otchealth-ai-reader-billing'},{PolicyArn:'arn:aws:iam::900915535335:policy/otchealth-ai-reader-deny'}]; if(scenario.omitBilling){const i=p.findIndex((x)=>x.PolicyArn.endsWith(':policy/otchealth-ai-reader-billing'));p.splice(i,1);} if(scenario.extraManaged)p.push({PolicyArn:'arn:aws:iam::900915535335:policy/unexpected'}); if(scenario.missingAttached)p.pop(); process.stdout.write(JSON.stringify({AttachedPolicies:p})); process.exit(0); }
if (args[0] === 'iam' && operation === 'list-role-policies') { process.stdout.write(JSON.stringify({PolicyNames:scenario.inlinePolicies || []})); process.exit(0); }
if (args[0] === 'iam' && operation === 'list-entities-for-policy') { process.stdout.write(JSON.stringify({PolicyUsers:[],PolicyGroups:[],PolicyRoles:[{RoleName:'otchealth-ai-reader-role'}]})); process.exit(0); }
if (args[0] === 'iam' && operation === 'get-role-policy') { process.stderr.write('NoSuchEntity\n'); process.exit(254); }
process.stderr.write('Unexpected mocked AWS command: '+args.join(' ')+'\n'); process.exit(253);
`;

async function harness(scenario = {}) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'aware-iam-test-'));
  const bin = path.join(tmp, 'bin');
  const log = path.join(tmp, 'calls.jsonl');
  const writes = path.join(tmp, 'writes.jsonl');
  const baseline = path.join(tmp, 'baseline.json');
  const deny = path.join(tmp, 'deny.json');
  const capture = path.join(tmp, 'captured.json');
  const sourceText = await readFile(bootstrap, 'utf8');
  const source = baselineWithoutRepair(bootstrapExtras(sourceText));
  await import('node:fs/promises').then(({ mkdir }) => mkdir(bin));
  await writeFile(path.join(bin, 'aws'), fakeAws);
  await chmod(path.join(bin, 'aws'), 0o755);
  await writeFile(log, ''); await writeFile(writes, '');
  await writeFile(baseline, JSON.stringify(source));
  await writeFile(deny, JSON.stringify(bootstrapDeny(sourceText)));
  return {
    tmp, log, writes,
    async run(flag = '--check', changes = {}, options = []) {
      return spawnSync('bash', [repair, flag, ...options], { encoding:'utf8', env:{...process.env, TMPDIR:tmp, PATH:`${bin}:${process.env.PATH}`, AWARE_MOCK_LOG:log, AWARE_MOCK_WRITES:writes, AWARE_MOCK_STATE:path.join(tmp,'state.json'), AWARE_CAPTURE:capture, AWARE_BASELINE:baseline, AWARE_DENY:deny, AWARE_MOCK_SCENARIO:JSON.stringify({...scenario,...changes})} });
    },
    async lines(file) { const text = await readFile(file,'utf8'); return text.trim() ? text.trim().split('\n').map((s)=>JSON.parse(s)) : []; },
    close() { return rm(tmp,{recursive:true,force:true}); },
  };
}

test('default --check is read-only; --apply makes exactly one CreatePolicyVersion for the existing extras policy', async () => {
  await readFile(repair, 'utf8');
  const h = await harness();
  try {
    const checked = await h.run('--check');
    assert.equal(checked.status, 0, checked.stderr || checked.stdout);
    assert.deepEqual(await h.lines(h.writes), []);
    const evidenceDir = checked.stdout.match(/Private evidence: (.+)$/m)?.[1];
    assert.ok(evidenceDir, checked.stdout);
    const receipt = JSON.parse(await readFile(path.join(evidenceDir,'receipt.json'), 'utf8'));
    assert.equal(receipt.preimageVariant, 'monitoring_plus_scheduler');
    const applied = await h.run('--apply');
    assert.equal(applied.status, 0, applied.stderr || applied.stdout);
    const writes = await h.lines(h.writes);
    assert.equal(writes.length, 1, 'apply may perform exactly one write');
    assert.equal(writes[0][1], 'create-policy-version');
    assert.ok(writes[0].includes('--policy-arn') && writes[0].includes(policyArn));
    assert.ok(writes[0].includes('--set-as-default'));
    const doc = JSON.parse(await readFile(path.join(h.tmp,'captured.json'), 'utf8'));
    assert.deepEqual(statements(doc).filter((s)=>s?.Sid===sid), [desiredStatement()]);
    assert.deepEqual(doc, bootstrapExtras(await readFile(bootstrap, 'utf8')), 'current M+S baseline must keep Scheduler unchanged');
    assert.ok((await h.lines(h.log)).every((c)=>!['delete-policy-version','delete-policy','put-role-policy','attach-role-policy','detach-role-policy','update-assume-role-policy'].includes(c[1])));
  } finally { await h.close(); }
});

test('legacy MonitoringReads-only baseline receives only GetRun and never gains Scheduler', async () => {
  const source = bootstrapExtras(await readFile(bootstrap, 'utf8'));
  const legacyBaseline = withoutStatement(baselineWithoutRepair(source), schedulerSid);
  const h = await harness({extras:legacyBaseline});
  try {
    const checked = await h.run('--check');
    assert.equal(checked.status, 0, checked.stderr || checked.stdout);
    assert.deepEqual(await h.lines(h.writes), []);
    const evidenceDir = checked.stdout.match(/Private evidence: (.+)$/m)?.[1];
    assert.ok(evidenceDir, checked.stdout);
    const receipt = JSON.parse(await readFile(path.join(evidenceDir,'receipt.json'), 'utf8'));
    assert.equal(receipt.preimageVariant, 'monitoring_only');
    const applied = await h.run('--apply');
    assert.equal(applied.status, 0, applied.stderr || applied.stdout);
    const writes = await h.lines(h.writes);
    assert.equal(writes.length, 1);
    assert.equal(writes[0][1], 'create-policy-version');
    const payload = JSON.parse(await readFile(path.join(h.tmp,'captured.json'), 'utf8'));
    assert.deepEqual(payload, legacyGetRunTarget(source), 'write payload must be exact live baseline plus exact GetRun statement');
    assert.equal(statements(payload).some((s)=>s?.Sid===schedulerSid), false, 'unapplied Scheduler grant must not be introduced');
  } finally { await h.close(); }
});

for (const [label, legacy] of [['current M+S+old-run-only-G',false],['legacy M+old-run-only-G',true]]) {
  test(`${label} migrates to the exact dual-resource statement only`, async () => {
    const source = bootstrapExtras(await readFile(bootstrap, 'utf8'));
    const oldTarget = previousRunOnlyTarget(source, legacy);
    const expectedTarget = legacy ? legacyGetRunTarget(source) : source;
    const h = await harness({extras:oldTarget});
    try {
      const applied = await h.run('--apply');
      assert.equal(applied.status, 0, applied.stderr || applied.stdout);
      const writes = await h.lines(h.writes);
      assert.equal(writes.length, 1);
      assert.equal(writes[0][1], 'create-policy-version');
      const payload = JSON.parse(await readFile(path.join(h.tmp,'captured.json'), 'utf8'));
      assert.deepEqual(payload, expectedTarget, 'migration target must preserve M/S exactly and replace only the old run-only G');
      assert.deepEqual(statements(payload).find((s)=>s?.Sid===sid), desiredStatement());
    } finally { await h.close(); }
  });
}

test('three-policy role profile without optional billing policy is preserved by one scoped write', async () => {
  const h = await harness({omitBilling:true});
  try {
    const checked=await h.run('--check');
    assert.equal(checked.status,0,checked.stderr||checked.stdout);
    assert.deepEqual(await h.lines(h.writes),[]);
    const applied=await h.run('--apply');
    assert.equal(applied.status,0,applied.stderr||applied.stdout);
    const writes=await h.lines(h.writes);
    assert.equal(writes.length,1);
    assert.equal(writes[0][1],'create-policy-version');
    assert.ok(writes[0].includes('--policy-arn')&&writes[0].includes(policyArn));
    const doc=JSON.parse(await readFile(path.join(h.tmp,'captured.json'),'utf8'));
    assert.deepEqual(statements(doc).filter((s)=>s?.Sid===sid),[desiredStatement()]);
    const attachedCall=(await h.lines(h.log)).find((c)=>c[1]==='list-attached-role-policies');
    assert.ok(attachedCall,'three-policy profile must be read and checked');
  } finally { await h.close(); }
});

test('explicit root-owner opt-in allows only the exact account root through the existing guarded apply', async () => {
  const h = await harness({identity:rootIdentity});
  try {
    const checked = await h.run('--check', {}, ['--allow-root-owner']);
    assert.equal(checked.status, 0, checked.stderr || checked.stdout);
    assert.deepEqual(await h.lines(h.writes), [], 'root-owner check must remain read-only');
    const evidenceDir = checked.stdout.match(/Private evidence: (.+)$/m)?.[1];
    assert.ok(evidenceDir, checked.stdout);
    const receipt = JSON.parse(await readFile(path.join(evidenceDir,'receipt.json'), 'utf8'));
    assert.equal(receipt.rootOwnerOptIn, true, 'private receipt must preserve the explicit root-owner choice');
    const applied = await h.run('--apply', {}, ['--allow-root-owner']);
    assert.equal(applied.status, 0, applied.stderr || applied.stdout);
    const writes = await h.lines(h.writes);
    assert.equal(writes.length, 1, 'root-owner apply may perform exactly one existing policy-version write');
    assert.equal(writes[0][1], 'create-policy-version');
    assert.ok(writes[0].includes('--policy-arn') && writes[0].includes(policyArn));
    const doc = JSON.parse(await readFile(path.join(h.tmp,'captured.json'), 'utf8'));
    assert.deepEqual(statements(doc).filter((s)=>s?.Sid===sid), [desiredStatement()]);
  } finally { await h.close(); }
});

for (const [label, identity] of [
  ['wrong-account root', {Account:'111122223333',Arn:'arn:aws:iam::111122223333:root',UserId:'111122223333'}],
  ['reader user', {Account:account,Arn:`arn:aws:iam::${account}:user/otchealth-ai-reader`,UserId:'AIDATEST'}],
  ['reader role', {Account:account,Arn:role,UserId:'AROA:session'}],
  ['assumed reader role', {Account:account,Arn:`arn:aws:sts::${account}:assumed-role/otchealth-ai-reader-role/session`,UserId:'AROA:session'}],
]) {
  test(`root-owner opt-in still rejects ${label}`, async () => {
    const h = await harness({identity});
    try {
      const result = await h.run('--apply', {}, ['--allow-root-owner']);
      assert.notEqual(result.status, 0, result.stdout || 'unsafe identity unexpectedly succeeded');
      assert.ok(result.stderr.includes('use the existing account owner/admin session'), result.stderr);
      assert.deepEqual(await h.lines(h.writes), []);
    } finally { await h.close(); }
  });
}

for (const [label, changes, expectedStop] of [
  ['extras drift', {extras:{Version:'2012-10-17',Statement:[{Sid:'Unexpected',Effect:'Allow',Action:['s3:*'],Resource:'*'}]}}, 'existing extras policy drift'],
  ['deny drift', {denyDrift:true}, 'existing explicit deny policy differs'],
  ['role trust drift', {trustDrift:true}, 'reader role, trust or boundary differs'],
  ['permissions boundary', {boundary:{PermissionsBoundaryArn:`arn:aws:iam::${account}:policy/boundary`}}, 'reader role, trust or boundary differs'],
  ['extra attachment', {extraManaged:true}, 'reader attachments differ'],
  ['version capacity', {versionCount:5}, 'no safe version slot'],
]) {
  test(`root-owner opt-in still enforces ${label} guard`, async () => {
    const h = await harness({identity:rootIdentity});
    try {
      const result = await h.run('--apply', changes, ['--allow-root-owner']);
      assert.notEqual(result.status, 0, result.stdout || 'drift unexpectedly succeeded');
      assert.ok(result.stderr.includes(expectedStop), result.stderr);
      assert.deepEqual(await h.lines(h.writes), []);
    } finally { await h.close(); }
  });
}

for (const [label, options] of [
  ['unknown option', ['--root-owner']],
  ['duplicate root opt-in', ['--allow-root-owner','--allow-root-owner']],
  ['conflicting modes', ['--check','--apply']],
]) {
  test(`${label} fails before any AWS call`, async () => {
    const h = await harness({identity:rootIdentity});
    try {
      const result = await h.run('--apply', {}, options);
      assert.equal(result.status, 2);
      assert.match(result.stderr, /Usage:/);
      assert.deepEqual(await h.lines(h.log), []);
      assert.deepEqual(await h.lines(h.writes), []);
    } finally { await h.close(); }
  });
}

for (const [label, changes, expectedStop] of [
  ['wrong account', {identity:{Account:'111122223333',Arn:'arn:aws:iam::111122223333:user/test',UserId:'A'}}, 'use the existing account owner/admin session'],
  ['reader IAM user caller', {identity:{Account:account,Arn:`arn:aws:iam::${account}:user/otchealth-ai-reader`,UserId:'AIDATEST'}}, 'use the existing account owner/admin session'],
  ['assumed reader role caller', {identity:{Account:account,Arn:`arn:aws:sts::${account}:assumed-role/otchealth-ai-reader-role/session`,UserId:'AROA:session'}}, 'use the existing account owner/admin session'],
  ['reader role caller', {identity:{Account:account,Arn:role,UserId:'AROA:session'}}, 'use the existing account owner/admin session'],
  ['root caller', {identity:{Account:account,Arn:`arn:aws:iam::${account}:root`,UserId:account}}, 'use the existing account owner/admin session'],
  ['unexpected existing extras drift', {extras:{Version:'2012-10-17',Statement:[{Sid:'Unexpected',Effect:'Allow',Action:['s3:*'],Resource:'*'}]}}, 'existing extras policy drift'],
  ['deny policy drift', {denyDrift:true}, 'existing explicit deny policy differs'],
  ['permissions boundary', {boundary:{PermissionsBoundaryArn:'arn:aws:iam::900915535335:policy/boundary'}}, 'reader role, trust or boundary differs'],
  ['trust drift', {trustDrift:true}, 'reader role, trust or boundary differs'],
  ['extra managed policy', {extraManaged:true}, 'reader attachments differ'],
  ['missing required attached policy', {missingAttached:true}, 'reader attachments differ'],
  ['missing policy', {missingPolicy:true}, 'AWS read failed (iam get-policy)'],
  ['inline policy', {inlinePolicies:['unexpected-inline']}, 'unexpected reader inline policy'],
  ['five policy versions', {versionCount:5}, 'no safe version slot'],
  ['read API denial', {denyRead:'get-policy-version'}, 'AWS read failed (iam get-policy-version)'],
]) {
  test(`${label} fails closed without writes`, async () => {
    await readFile(repair, 'utf8');
    const h = await harness(changes);
    try {
      const result = await h.run('--apply');
      assert.notEqual(result.status, 0, result.stdout || 'unsafe scenario unexpectedly succeeded');
      assert.ok(result.stderr.includes(expectedStop), `expected fail-closed guard ${JSON.stringify(expectedStop)}, got: ${result.stderr}`);
      assert.deepEqual(await h.lines(h.writes), []);
    } finally { await h.close(); }
  });
}

test('already-present exact scoped statement is idempotent and performs no write', async () => {
  const h = await harness({alreadyDesired:true});
  try {
    const result = await h.run('--apply');
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(await h.lines(h.writes), []);
  } finally { await h.close(); }
});

test('already-applied legacy target is idempotent without adding Scheduler', async () => {
  const source = bootstrapExtras(await readFile(bootstrap, 'utf8'));
  const legacyTarget = legacyGetRunTarget(source);
  const h = await harness({extras:legacyTarget});
  try {
    const result = await h.run('--apply');
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /ALREADY_APPLIED/);
    assert.deepEqual(await h.lines(h.writes), []);
  } finally { await h.close(); }
});

for (const [label, mutate] of [
  ['modified MonitoringReads', (doc) => { doc.Statement[0].Action.push('cloudwatch:PutMetricData'); }],
  ['unknown statement', (doc) => { doc.Statement.push({Sid:'UnexpectedExtra',Effect:'Allow',Action:['s3:*'],Resource:'*'}); }],
  ['modified Scheduler grant', (doc) => { const s=doc.Statement.find((item)=>item?.Sid===schedulerSid); if(s) s.Action=['scheduler:ListSchedules']; }],
  ['duplicate MonitoringReads statement', (doc) => { doc.Statement.push(structuredClone(doc.Statement.find((item)=>item?.Sid==='MonitoringReads'))); }],
  ['duplicate Scheduler statement', (doc) => { doc.Statement.push(structuredClone(doc.Statement.find((item)=>item?.Sid===schedulerSid))); }],
  ['modified GetRun grant', (doc) => { doc.Statement.push({...desiredStatement(),Resource:'arn:aws:devicefarm:us-west-2:900915535335:run:another-project/*'}); }],
  ['duplicate GetRun grant', (doc) => { doc.Statement.push(desiredStatement(), desiredStatement()); }],
]) {
  test(`${label} is not an accepted preimage`, async () => {
    const source = bootstrapExtras(await readFile(bootstrap, 'utf8'));
    const modified = baselineWithoutRepair(source);
    mutate(modified);
    const h = await harness({extras:modified});
    try {
      const result = await h.run('--apply');
      assert.notEqual(result.status, 0, result.stdout || 'unreviewed preimage unexpectedly succeeded');
      assert.ok(result.stderr.includes('existing extras policy drift'), result.stderr);
      assert.deepEqual(await h.lines(h.writes), []);
    } finally { await h.close(); }
  });
}

test('uncertain CreatePolicyVersion failure is recorded and never retried', async () => {
  const h = await harness({failCreate:true});
  try {
    const result = await h.run('--apply');
    assert.notEqual(result.status, 0, 'uncertain write response must fail closed');
    const writes = await h.lines(h.writes);
    assert.equal(writes.length, 1);
    assert.equal(writes[0][1], 'create-policy-version');
    const dirs = (await import('node:fs/promises')).readdir;
    const entries = await dirs(h.tmp);
    const privateDir = entries.find((name)=>name.startsWith('aware-reader-repair.'));
    assert.ok(privateDir, 'private repair evidence directory must be retained');
    const receipt = JSON.parse(await readFile(path.join(h.tmp,privateDir,'receipt.json'),'utf8'));
    assert.equal(receipt.writeAttempted,true);
  } finally { await h.close(); }
});
