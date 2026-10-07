import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Pins the Nightly AWS DR Canary's pager wiring (2026-10-07). The canary was red daily 2026-09-29..10-06 and its
// email/PostHog pager could not read SSM under the read-only OIDC role, so nobody was told. The GitHub-issue
// channel (GITHUB_TOKEN + issues: write) is the guaranteed pager; these checks keep it from being un-wired.
const workflow = readFileSync(new URL('../.github/workflows/nightly-aws-dr-canary.yml', import.meta.url), 'utf8');

function stepText(namePattern) {
  const lines = workflow.split('\n');
  const start = lines.findIndex((l) => /^ {6}- name:/.test(l) && namePattern.test(l));
  assert.notEqual(start, -1, `step matching ${namePattern} exists`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) if (/^ {6}- name:/.test(lines[i])) { end = i; break; }
  return { text: lines.slice(start, end).join('\n'), index: start };
}

test('workflow grants issues: write so GITHUB_TOKEN can open the alert issue', () => {
  const perms = workflow.match(/^permissions:\n((?: {2}.*\n)+)/m)?.[1] ?? '';
  assert.match(perms, /^ {2}issues: write\b/m);
  assert.match(perms, /^ {2}id-token: write\b/m);
  assert.match(perms, /^ {2}contents: read\b/m);
});

test('the page step opens the [FLEET-ALERT] issue and carries the job token', () => {
  const page = stepText(/Page on failure/).text;
  assert.match(page, /if: failure\(\)/);
  assert.match(page, /--github-issue "\[FLEET-ALERT\] nightly-aws-dr-canary"/);
  assert.match(page, /GITHUB_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(page, /PAGE_STEP_OUTCOMES:/);
  assert.match(page, /--log "\$\{GITHUB_WORKSPACE\}\/aws-dr-canary\.log"/);
  assert.doesNotMatch(page, /continue-on-error/);
});

test('the page step runs AFTER the heartbeat so a failed heartbeat pages too', () => {
  assert.ok(stepText(/Page on failure/).index > stepText(/Heartbeat/).index);
  assert.ok(stepText(/Heartbeat/).index > stepText(/Run the canary/).index);
});

test('steps whose outcome feeds the page have ids', () => {
  assert.match(stepText(/Configure AWS credentials/).text, /^ {8}id: aws$/m);
  assert.match(stepText(/Run the canary/).text, /^ {8}id: canary$/m);
  assert.match(stepText(/Heartbeat/).text, /^ {8}id: heartbeat$/m);
});

test('every step name containing a colon is quoted (an unquoted one fails the workflow at startup, 0 jobs)', () => {
  for (const line of workflow.split('\n')) {
    const m = line.match(/^ {6}- name: (.*)$/);
    if (!m) continue;
    const value = m[1].trim();
    if (value.startsWith('"') || value.startsWith("'")) continue;
    assert.doesNotMatch(value, /: |:$/, `unquoted step name with a colon: ${value}`);
  }
});

test('the canary step keeps pipefail and --strict so a red check really fails the job', () => {
  const canary = stepText(/Run the canary/).text;
  assert.match(canary, /set -o pipefail/);
  assert.match(canary, /canary\.mjs --strict/);
});
