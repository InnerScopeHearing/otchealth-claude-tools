import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, readFileSync, existsSync } from 'node:fs';
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
function executeHeartbeat({ nodeExit = 0, timeoutExit, outcome = 'ok', nodeStdout = '', nodeStderr = '' } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'nightly-heartbeat-'));
  try {
    const bin = join(directory, 'bin');
    mkdirSync(bin);
    const timeout = join(bin, 'timeout');
    const node = join(bin, 'node');
    writeFileSync(timeout, timeoutExit === undefined
      ? '#!/bin/sh\nshift\nexec "$@"\n'
      : `#!/bin/sh\nexit ${timeoutExit}\n`);
    writeFileSync(node, '#!/bin/sh\nprintf "%s\\n" "$@" > "$CAPTURE_ARGS"\nprintf "%s\\n" "$MOCK_STDOUT"\nprintf "%s\\n" "$MOCK_STDERR" >&2\nexit "$NODE_EXIT"\n');
    chmodSync(timeout, 0o755);
    chmodSync(node, 0o755);
    const result = spawnSync('/bin/bash', ['-e', '-o', 'pipefail', '-c', run], {
      encoding: 'utf8', timeout: 5000,
      env: {
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        HEARTBEAT_OUTCOME: outcome,
        CAPTURE_ARGS: join(directory, 'args.txt'),
        NODE_EXIT: String(nodeExit),
        MOCK_STDOUT: nodeStdout,
        MOCK_STDERR: nodeStderr,
        RUNNER_TEMP: directory,
      },
    });
    return {
      ...result,
      args: existsSync(join(directory, 'args.txt'))
        ? readFileSync(join(directory, 'args.txt'), 'utf8').trim().split('\n')
        : [],
      publishedLog: existsSync(join(directory, 'aws-dr-heartbeat.log'))
        ? readFileSync(join(directory, 'aws-dr-heartbeat.log'), 'utf8')
        : '',
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('heartbeat is unconditional and a denied write fails the step', () => {
  assert.match(step, /if: always\(\)/);
  assert.doesNotMatch(step, /continue-on-error:\s*true/);
  const result = executeHeartbeat({ nodeExit: 1, outcome: 'fail' });
  assert.equal(result.status, 1);
  assert.equal(result.publishedLog, '[heartbeat] nightly-aws-dr-canary event=fail exit=1\n');
});

test('heartbeat timeout fails the step', () => {
  const result = executeHeartbeat({ timeoutExit: 124 });
  assert.equal(result.status, 124);
  assert.equal(result.publishedLog, '[heartbeat] nightly-aws-dr-canary event=ok exit=124\n');
});

test('successful heartbeat succeeds', () => {
  assert.equal(executeHeartbeat().status, 0);
});

test('only a successful canary maps to an ok heartbeat', () => {
  const configured = step.match(/^        env:\n([\s\S]*?)(?=^        run:)/m)?.[1];
  assert.match(configured ?? '', /^          HEARTBEAT_OUTCOME: \$\{\{ steps\.canary\.outcome == 'success' && 'ok' \|\| 'fail' \}\}$/m);
  assert.match(run, /if \[\[ "\$\{HEARTBEAT_OUTCOME:-\}" == "ok" \]\]; then event=ok; fi/);
  assert.match(run, /beat nightly-aws-dr-canary "\$event"/);

  const outcomes = ['success', 'failure', 'cancelled', 'skipped', 'unknown'];
  for (const canaryOutcome of outcomes) {
    const event = canaryOutcome === 'success' ? 'ok' : 'fail';
    const result = executeHeartbeat({ outcome: event });
    assert.equal(result.status, 0, `heartbeat ${event} write path should run for ${canaryOutcome}`);
    assert.deepEqual(result.args.slice(0, 4), ['setup/heartbeat.mjs', 'beat', 'nightly-aws-dr-canary', event]);
  }
});

test('private heartbeat output never reaches console, uploaded log, or pager inputs', () => {
  const privateStdout = 'PRIVATE_HEARTBEAT_BODY_STDOUT_DO_NOT_PUBLISH';
  const privateStderr = 'PRIVATE_HEARTBEAT_BODY_STDERR_DO_NOT_PUBLISH';
  const result = executeHeartbeat({
    nodeExit: 1,
    outcome: 'fail',
    nodeStdout: privateStdout,
    nodeStderr: privateStderr,
  });

  assert.equal(result.status, 1);
  assert.equal(result.publishedLog, '[heartbeat] nightly-aws-dr-canary event=fail exit=1\n');
  assert.doesNotMatch(result.stdout, /PRIVATE_HEARTBEAT_BODY/);
  assert.doesNotMatch(result.publishedLog, /PRIVATE_HEARTBEAT_BODY/);
  assert.match(run, />\s*"\$private_output"\s+2>&1/);
  const upload = workflow.match(/      - name: Upload canary log([\s\S]*?)(?=^      - name:)/m)?.[1] ?? '';
  const pagerCommand = workflow.split('\n').find((line) => line.includes('run: timeout 120 node setup/page-on-failure')) ?? '';
  assert.match(upload, /aws-dr-heartbeat\.log/);
  assert.doesNotMatch(upload, /private_output|heartbeat-private/);
  assert.match(pagerCommand, /--log .*aws-dr-heartbeat\.log/);
  assert.doesNotMatch(pagerCommand, /private_output|heartbeat-private/);
});
