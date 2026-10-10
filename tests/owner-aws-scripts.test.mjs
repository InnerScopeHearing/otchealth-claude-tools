import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const runner = fileURLToPath(new URL('../setup/aws/tests/run-owner-script-tests.sh', import.meta.url));

// The owner scripts (setup/iam/aws-ai-access-2026-10-07.sh, setup/aws/ops-alarms-2026-10-07.sh) are run once, by
// hand, in a real AWS account. This runs them from start to finish against a PRETEND account (a fake `aws` command,
// no network, no credentials) and lints them, so a wrong service name or a skipped guard fails here first.
test('owner AWS scripts pass their pretend-account scenarios and lint', () => {
  const result = spawnSync('bash', [runner], { encoding: 'utf8', timeout: 300000, maxBuffer: 64 * 1024 * 1024 });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
