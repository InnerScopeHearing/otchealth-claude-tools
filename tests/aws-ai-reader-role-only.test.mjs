import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const pythonTest = fileURLToPath(new URL('./test_aws_ai_reader_role_only.py', import.meta.url));

test('role-only AWS provisioner passes mocked CLI safety tests', () => {
  const result = spawnSync('python3', ['-I', pythonTest], { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
