import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// End to end: runs the REAL setup/page-on-failure.mjs as a child process with no AWS credentials in its
// environment (so the email and PostHog channels cannot resolve their SSM secrets, exactly the Nightly AWS DR
// Canary situation) and a local stub standing in for api.github.com. The page must still land as a GitHub issue.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGER = join(ROOT, 'setup', 'page-on-failure.mjs');
const TOKEN = 'ghs_' + 'unit_test_token_value_0123456789';
const KEY_ID = 'ASIA' + 'ABCDEFGHIJKLMNOP';

function startStub(routes) {
  const requests = [];
  const server = createServer((req, res) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      const entry = { method: req.method, path: req.url, headers: req.headers, body: data ? JSON.parse(data) : undefined };
      requests.push(entry);
      const out = routes(entry) || { status: 404, json: { message: 'Not Found' } };
      res.writeHead(out.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out.json));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, requests, url: `http://127.0.0.1:${server.address().port}` })));
}

function runPager(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [PAGER, ...args], { env: { PATH: process.env.PATH, ...env }, cwd: ROOT });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    const killer = setTimeout(() => child.kill('SIGKILL'), 25000);
    child.on('close', (code) => { clearTimeout(killer); resolve({ code, out, err }); });
  });
}

async function scenario(routes, args, extraEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pager-issue-'));
  const log = join(dir, 'canary.log');
  writeFileSync(log, [
    '# aws-dr-canary - 3 check(s) [--strict]',
    '[OK       ] rds-snapshot           3.1h old',
    '[STALE    ] ssm-archive            neither today nor yesterday found in the bucket',
    `[ERROR    ] n8n-healthz            probe failed Authorization: Bearer abc.def.ghi Credential=${KEY_ID}/x`,
    '',
  ].join('\n'));
  const stub = await startStub(routes);
  try {
    const r = await runPager(['--workflow', 'Unit Test WF', '--log', log, ...args], {
      GITHUB_REPOSITORY: 'acme/tools',
      GITHUB_TOKEN: TOKEN,
      GITHUB_API_URL: stub.url,
      GITHUB_RUN_ID: '4242',
      GITHUB_SERVER_URL: 'https://github.example',
      PAGE_STEP_OUTCOMES: 'aws=success canary=failure heartbeat=success',
      ...extraEnv,
    });
    return { ...r, requests: stub.requests };
  } finally {
    stub.server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const TITLE = '[FLEET-ALERT] unit-test-wf';

test('a red run with dead email and PostHog channels still pages through the GitHub issue (creates it)', async () => {
  const r = await scenario(
    (q) => (q.method === 'GET' ? { status: 200, json: [] } : { status: 201, json: { number: 7, html_url: 'http://stub/issues/7' } }),
    ['--github-issue', TITLE],
  );
  assert.equal(r.code, 0, `exit code (stderr: ${r.err})`);
  assert.equal(r.requests.length, 2);
  assert.equal(r.requests[0].path, '/repos/acme/tools/issues?state=open&per_page=100&page=1');
  assert.equal(r.requests[1].method, 'POST');
  assert.equal(r.requests[1].path, '/repos/acme/tools/issues');
  assert.equal(r.requests[1].headers.authorization, `Bearer ${TOKEN}`);
  const { title, body } = r.requests[1].body;
  assert.equal(title, TITLE);
  assert.match(body, /Unit Test WF: RED/);
  assert.match(body, /failed steps: canary/);
  assert.match(body, /Run: https:\/\/github\.example\/acme\/tools\/actions\/runs\/4242/);
  assert.match(body, /- email: FAILED/);
  assert.match(body, /- posthog: FAILED/);
  assert.match(body, /- STALE ssm-archive neither today nor yesterday found/);
  assert.match(body, /- ERROR n8n-healthz probe failed/);
  assert.doesNotMatch(body, /abc\.def\.ghi/);
  assert.doesNotMatch(body, /ASIAABCDEFGHIJKLMNOP/);
  assert.ok(!body.includes(TOKEN), 'the GitHub token never lands in the issue body');
  assert.match(r.out, /GitHub issue created: #7 http:\/\/stub\/issues\/7/);
  assert.match(r.err, /::warning::.*GitHub issue channel only/);
});

test('a later red run comments on the existing open issue instead of opening another', async () => {
  const r = await scenario(
    (q) => (q.method === 'GET'
      ? { status: 200, json: [{ number: 3, title: TITLE, pull_request: {} }, { number: 9, title: TITLE, html_url: 'http://stub/issues/9' }] }
      : { status: 201, json: { html_url: 'http://stub/issues/9#c' } }),
    ['--github-issue', TITLE, '--github-mention', '@octocat'],
  );
  assert.equal(r.code, 0, r.err);
  assert.equal(r.requests[1].path, '/repos/acme/tools/issues/9/comments');
  assert.match(r.requests[1].body.body, /cc @octocat/);
  assert.match(r.out, /GitHub issue commented: #9/);
});

test('--test posts a clearly labeled self-test and never mentions anyone', async () => {
  const r = await scenario(
    (q) => (q.method === 'GET' ? { status: 200, json: [] } : { status: 201, json: { number: 8, html_url: 'http://stub/issues/8' } }),
    ['--github-issue', TITLE, '--test'],
    { PAGE_GITHUB_MENTION: '@octocat' },
  );
  assert.equal(r.code, 0, r.err);
  const { body } = r.requests[1].body;
  assert.match(body, /PAGER SELF-TEST \(not a real incident\)/);
  assert.doesNotMatch(body, /cc @octocat/);
  assert.match(r.out, /\[SELF-TEST\] GitHub issue created: #8/);
});

test('when every channel fails the pager exits non-zero and says which', async () => {
  const r = await scenario(() => ({ status: 403, json: { message: 'Resource not accessible by integration' } }), ['--github-issue', TITLE]);
  assert.equal(r.code, 1);
  assert.match(r.err, /ALL page channels failed/);
  assert.match(r.err, /list issues HTTP 403/);
});

test('without --github-issue behavior is the old email-then-PostHog pager (no GitHub traffic)', async () => {
  const r = await scenario(() => ({ status: 200, json: [] }), []);
  assert.equal(r.code, 1);
  assert.equal(r.requests.length, 0);
  assert.match(r.err, /ALL page channels failed/);
  assert.match(r.err, /not configured for this workflow/);
});
