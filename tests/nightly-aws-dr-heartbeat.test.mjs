import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const workflow = readFileSync(new URL('../.github/workflows/nightly-aws-dr-canary.yml', import.meta.url), 'utf8');
const marker = `      - name: "Heartbeat: mark this workflow's schedule as alive"`;
const start = workflow.indexOf(marker);
assert.notEqual(start, -1, 'heartbeat step exists');
const tail = workflow.slice(start + marker.length);
const next = tail.search(/^      - name:/m);
const step = (next === -1 ? tail : tail.slice(0, next)).trimEnd();
const run = step.match(/^        run: \|\n([\s\S]*)$/m)?.[1];
assert.ok(run, 'heartbeat command exists');

// Execute the workflow's real Bash command with offline stand-ins for timeout and node.
// No heartbeat program or provider SDK is invoked by these tests.
function executeHeartbeat({ nodeExit = 0, timeoutExit } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'nightly-heartbeat-'));
  try {
    const bin = join(directory, 'bin');
    mkdirSync(bin);
    const timeout = join(bin, 'timeout');
    const node = join(bin, 'node');
    writeFileSync(timeout, timeoutExit === undefined
      ? '#!/bin/sh\nshift\nexec "$@"\n'
      : `#!/bin/sh\nexit ${timeoutExit}\n`);
    writeFileSync(node, `#!/bin/sh\nexit ${nodeExit}\n`);
    chmodSync(timeout, 0o755);
    chmodSync(node, 0o755);
    return spawnSync('/bin/bash', ['-e', '-o', 'pipefail', '-c', run], {
      encoding: 'utf8', timeout: 5000,
      env: { PATH: `${bin}:${process.env.PATH ?? ''}` },
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('heartbeat is unconditional and a denied write fails the step', () => {
  assert.match(step, /if: always\(\)/);
  assert.doesNotMatch(step, /continue-on-error:\s*true/);
  assert.equal(executeHeartbeat({ nodeExit: 1 }).status, 1);
});

test('heartbeat timeout fails the step', () => {
  assert.equal(executeHeartbeat({ timeoutExit: 124 }).status, 124);
});

test('successful heartbeat succeeds', () => {
  assert.equal(executeHeartbeat().status, 0);
});
