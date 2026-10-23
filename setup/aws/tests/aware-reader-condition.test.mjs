import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const fake = process.env.AIOS_READER_FAKE_AWS ?? path.join(here, 'fake-aws.py');
const python = String.raw`
import importlib.util, json, sys
spec=importlib.util.spec_from_file_location('fake_aws',sys.argv[1]); fake=importlib.util.module_from_spec(spec); spec.loader.exec_module(fake)
role='arn:aws:iam::900915535335:role/otchealth-ai-reader-role'
action='devicefarm:GetRun'
resource='arn:aws:devicefarm:us-west-2:900915535335:run:58bbc541-f082-4594-b744-738a345f3654/run-123'
project='arn:aws:devicefarm:us-west-2:900915535335:project:58bbc541-f082-4594-b744-738a345f3654'
allow={'Effect':'Allow','Action':['devicefarm:GetRun'],'Resource':['arn:aws:devicefarm:us-west-2:900915535335:run:58bbc541-f082-4594-b744-738a345f3654/*',project],'Condition':{'ArnEquals':{'aws:PrincipalArn':role}}}
def decision(statement, who=role, act=action, res=resource):
    doc={'Version':'2012-10-17','Statement':statement if isinstance(statement,list) else [statement]}
    match=__import__('re').match(r'^arn:aws:iam::[0-9]+:(user|role)/(.+)$',who)
    kind,name=match.groups(); principal_key=kind+':'+name.rsplit('/',1)[-1]
    world={'iam':{'attached':{principal_key:['arn:aws:iam::900915535335:policy/test']},'policies':{'test':{'arn':'arn:aws:iam::900915535335:policy/test','versions':[{'default':True,'doc':doc}] }},'inline':{}}}
    return fake.evaluate(world,who,act,res)
cases={
 'exact_role':decision(allow),
 'exact_project':decision(allow,res=project),
 'wrong_project_arn':decision(allow,res='arn:aws:devicefarm:us-west-2:900915535335:project:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'),
 'human_user':decision(allow,'arn:aws:iam::900915535335:user/otchealth-ai-reader'),
 'wrong_project':decision(allow,res='arn:aws:devicefarm:us-west-2:900915535335:run:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/run-123'),
 'wrong_region':decision(allow,res='arn:aws:devicefarm:us-east-1:900915535335:run:58bbc541-f082-4594-b744-738a345f3654/run-123'),
 'wrong_account':decision(allow,res='arn:aws:devicefarm:us-west-2:111122223333:run:58bbc541-f082-4594-b744-738a345f3654/run-123'),
 'other_role':decision(allow,'arn:aws:iam::900915535335:role/other'),
 'other_action':decision(allow,act='devicefarm:ScheduleRun'),
 'explicit_deny_wins':decision([allow,{'Effect':'Deny','Action':['devicefarm:GetRun'],'Resource':'*'}]),
}
try:
 decision({'Effect':'Allow','Action':['devicefarm:GetRun'],'Resource':'*','Condition':{'StringEquals':{'aws:PrincipalArn':role}}})
 cases['unknown_condition']='NO_GAP'
except fake.Gap: cases['unknown_condition']='GAP'
for name, condition in [
 ('unknown_condition_key',{'ArnEquals':{'aws:PrincipalArn':role,'aws:RequestedRegion':'us-west-2'}}),
 ('multiple_condition_operators',{'ArnEquals':{'aws:PrincipalArn':role},'StringEquals':{'aws:RequestedRegion':'us-west-2'}}),
 ('malformed_condition_value',{'ArnEquals':{'aws:PrincipalArn':[role]}}),
]:
 try:
  decision({'Effect':'Allow','Action':['devicefarm:GetRun'],'Resource':'*','Condition':condition})
  cases[name]='NO_GAP'
 except fake.Gap: cases[name]='GAP'
print(json.dumps(cases,sort_keys=True))
`;

function evaluateCases() {
  const result = spawnSync('python3', ['-I', '-S', '-c', python, fake], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

test('fake evaluator supports only the exact scoped aws:PrincipalArn ArnEquals condition', () => {
  const got = evaluateCases();
  assert.deepEqual(got, {
    exact_role: 'allowed',
    exact_project: 'allowed',
    wrong_project_arn: 'implicitDeny',
    human_user: 'implicitDeny',
    wrong_project: 'implicitDeny',
    wrong_region: 'implicitDeny',
    wrong_account: 'implicitDeny',
    other_role: 'implicitDeny',
    other_action: 'implicitDeny',
    explicit_deny_wins: 'explicitDeny',
    unknown_condition: 'GAP',
    unknown_condition_key: 'GAP',
    multiple_condition_operators: 'GAP',
    malformed_condition_value: 'GAP',
  });
});

const sourcePython = String.raw`
import importlib.util, json, pathlib, re, sys
spec=importlib.util.spec_from_file_location('fake_aws',sys.argv[1]); fake=importlib.util.module_from_spec(spec); spec.loader.exec_module(fake)
source=pathlib.Path(sys.argv[2]).read_text()
match=re.search(r"cat > \"\$EXTRAS_FILE\" <<'EXTRAS_JSON'\n(.*?)\nEXTRAS_JSON",source,re.S)
assert match, 'EXTRAS_JSON heredoc not found'
doc=json.loads(match.group(1))
role='arn:aws:iam::900915535335:role/otchealth-ai-reader-role'
user='arn:aws:iam::900915535335:user/otchealth-ai-reader'
stmt=[s for s in doc['Statement'] if s.get('Sid')=='SchedulerGetOwnedScheduleMetadata']
assert len(stmt)==1, f'expected exactly one scheduler grant, got {len(stmt)}'
stmt=stmt[0]
assert stmt == {'Sid':'SchedulerGetOwnedScheduleMetadata','Effect':'Allow','Action':['scheduler:GetSchedule'],'Resource':'arn:aws:scheduler:us-east-1:900915535335:schedule/default/otchealth-*','Condition':{'ArnEquals':{'aws:PrincipalArn':role}}}
def decision(who, action, resource):
    m=re.match(r'^arn:aws:iam::[0-9]+:(user|role)/(.+)$',who); kind,name=m.groups(); key=kind+':'+name.rsplit('/',1)[-1]
    world={'iam':{'attached':{key:['arn:aws:iam::900915535335:policy/test']},'policies':{'test':{'arn':'arn:aws:iam::900915535335:policy/test','versions':[{'default':True,'doc':doc}]}},'inline':{}}}
    return fake.evaluate(world,who,action,resource)
exact='arn:aws:scheduler:us-east-1:900915535335:schedule/default/otchealth-health-check'
cases={
 'exact_role_get':decision(role,'scheduler:GetSchedule',exact),
 'reader_user_get':decision(user,'scheduler:GetSchedule',exact),
 'other_role_get':decision('arn:aws:iam::900915535335:role/other','scheduler:GetSchedule',exact),
 'other_schedule_get':decision(role,'scheduler:GetSchedule','arn:aws:scheduler:us-east-1:900915535335:schedule/default/other-health-check'),
 'other_group_get':decision(role,'scheduler:GetSchedule','arn:aws:scheduler:us-east-1:900915535335:schedule/custom/otchealth-health-check'),
 'wrong_region_get':decision(role,'scheduler:GetSchedule','arn:aws:scheduler:us-west-2:900915535335:schedule/default/otchealth-health-check'),
 'wrong_account_get':decision(role,'scheduler:GetSchedule','arn:aws:scheduler:us-east-1:111122223333:schedule/default/otchealth-health-check'),
 'list_schedules':decision(role,'scheduler:ListSchedules','*'),
 'update_schedule':decision(role,'scheduler:UpdateSchedule',exact),
}
assert cases=={'exact_role_get':'allowed','reader_user_get':'implicitDeny','other_role_get':'implicitDeny','other_schedule_get':'implicitDeny','other_group_get':'implicitDeny','wrong_region_get':'implicitDeny','wrong_account_get':'implicitDeny','list_schedules':'implicitDeny','update_schedule':'implicitDeny'}, cases
df=[s for s in doc['Statement'] if s.get('Sid')=='AwareDeviceFarmRunMetadataOnly']
assert len(df)==1, 'exactly one scoped DeviceFarm statement must exist'
assert df[0]=={'Sid':'AwareDeviceFarmRunMetadataOnly','Effect':'Allow','Action':['devicefarm:GetProject','devicefarm:GetRun'],'Resource':['arn:aws:devicefarm:us-west-2:900915535335:run:58bbc541-f082-4594-b744-738a345f3654/*','arn:aws:devicefarm:us-west-2:900915535335:project:58bbc541-f082-4594-b744-738a345f3654'],'Condition':{'ArnEquals':{'aws:PrincipalArn':role}}}
assert decision(role,'devicefarm:GetRun','arn:aws:devicefarm:us-west-2:900915535335:project:58bbc541-f082-4594-b744-738a345f3654')=='allowed'
assert decision(user,'devicefarm:GetRun','arn:aws:devicefarm:us-west-2:900915535335:project:58bbc541-f082-4594-b744-738a345f3654')=='implicitDeny'
print(json.dumps(cases,sort_keys=True))
`;

test('candidate script grants only owned Scheduler GetSchedule metadata to the reader role', () => {
  const source = process.env.AIOS_READER_POLICY_SCRIPT ?? path.resolve(here, '../../iam/aws-ai-access-2026-10-07.sh');
  const result = spawnSync('python3', ['-I', '-S', '-c', sourcePython, fake, source], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(result.stdout), {
    exact_role_get: 'allowed',
    reader_user_get: 'implicitDeny',
    other_role_get: 'implicitDeny',
    other_schedule_get: 'implicitDeny',
    other_group_get: 'implicitDeny',
    wrong_region_get: 'implicitDeny',
    wrong_account_get: 'implicitDeny',
    list_schedules: 'implicitDeny',
    update_schedule: 'implicitDeny',
  });
});
