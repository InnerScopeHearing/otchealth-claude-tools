import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const files = [
  'setup/iam/aws-ai-access-2026-10-07.sh',
  'setup/iam/aws-ai-reader-role-only-2026-10-09.py',
  'setup/iam/aware-devicefarm-reader-repair.sh',
];

test('AWARE reader grant includes project metadata and run metadata only', () => {
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    assert.match(source, /devicefarm:GetProject/, file);
    assert.match(source, /devicefarm:GetRun/, file);
    assert.match(
      source,
      /arn:aws:devicefarm:us-west-2:900915535335:project:58bbc541-f082-4594-b744-738a345f3654/,
      file,
    );
  }
});
