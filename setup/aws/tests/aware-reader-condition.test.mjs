import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const fake = path.join(here, 'fake-aws.py');
const python = String.raw`
import importlib.util, json, sys
spec=importlib.util.spec_from_file_location('fake_aws',sys.argv[1]); fake=importlib.util.module_from_spec(spec); spec.loader.exec_module(fake)
role='arn:aws:iam::900915535335:role/otchealth-ai-reader-role'
action='devicefarm:GetRun'
resource='arn:aws:devicefarm:us-west-2:900915535335:run:58bbc541-f082-4594-b744-738a345f3654/run-123'
allow={'Effect':'Allow','Action':['devicefarm:GetRun'],'Resource':'arn:aws:devicefarm:us-west-2:900915535335:run:58bbc541-f082-4594-b744-738a345f3654/*','Condition':{'ArnEquals':{'aws:PrincipalArn':role}}}
def decision(statement, who=role, act=action, res=resource):
    doc={'Version':'2012-10-17','Statement':statement if isinstance(statement,list) else [statement]}
    match=__import__('re').match(r'^arn:aws:iam::[0-9]+:(user|role)/(.+)$',who)
    kind,name=match.groups(); principal_key=kind+':'+name.rsplit('/',1)[-1]
    world={'iam':{'attached':{principal_key:['arn:aws:iam::900915535335:policy/test']},'policies':{'test':{'arn':'arn:aws:iam::900915535335:policy/test','versions':[{'default':True,'doc':doc}] }},'inline':{}}}
    return fake.evaluate(world,who,act,res)
cases={
 'exact_role':decision(allow),
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
