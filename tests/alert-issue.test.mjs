import test from 'node:test';
import assert from 'node:assert/strict';
import {
  redactSecrets, parseMentions, parseStepOutcomes, extractFailedChecks, buildAlertBody, upsertAlertIssue,
  startDiagCapture, issueConfigFromArgv, deliverIssueChannel, MENTION_NOTE,
} from '../setup/alert-issue.mjs';

// Hermetic: every GitHub call goes through an injected fake fetch. The credential-shaped strings below are
// assembled at runtime from synthetic fragments so no secret scanner ever sees a whole one in this file.
const FAKE_KEY_ID = 'ASIA' + 'ABCDEFGHIJKLMNOP';

function makeFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const call = { method: init.method || 'GET', path: u.pathname + u.search, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(call);
    const { status = 200, json = {} } = handler(call) || {};
    const text = typeof json === 'string' ? json : JSON.stringify(json);
    return { ok: status >= 200 && status < 300, status, text: async () => text };
  };
  return { fetchImpl, calls };
}

test('redactSecrets strips credential shapes but keeps check rows readable', () => {
  const raw = [
    `Credential=${FAKE_KEY_ID}/20261007/us-east-1/s3/aws4_request`,
    'Authorization: Bearer abc.def.ghi',
    'token=0123456789',
    'deadbeef'.repeat(5),
    '[STALE   ] ssm-archive newest found (secrets-dr/daily/ssm-otchealth-2026-10-05.json.enc) is 30.0h old, SLO 26h',
  ].join('\n');
  const out = redactSecrets(raw);
  assert.doesNotMatch(out, /ASIAABCDEFGHIJKLMNOP/);
  assert.doesNotMatch(out, /abc\.def\.ghi/);
  assert.doesNotMatch(out, /0123456789/);
  assert.doesNotMatch(out, /(deadbeef){5}/);
  assert.match(out, /\[STALE {3}\] ssm-archive newest found \(secrets-dr\/daily\/ssm-otchealth-2026-10-05\.json\.enc\) is 30\.0h old, SLO 26h/);
});

test('parseMentions keeps only well-formed handles and caps the list', () => {
  assert.equal(parseMentions('@octocat, @org/team-a  not-a-handle @bad_handle! @x'), '@octocat @org/team-a @x');
  assert.equal(parseMentions(''), '');
  assert.equal(parseMentions(undefined), '');
  assert.equal(parseMentions('@a @b @c @d @e @f @g').split(' ').length, 5);
});

test('parseStepOutcomes and extractFailedChecks read the workflow context and the canary table', () => {
  assert.deepEqual(parseStepOutcomes('aws=success canary=failure, heartbeat=skipped;bad junk=1x'), [['aws', 'success'], ['canary', 'failure'], ['heartbeat', 'skipped']]);
  const rows = extractFailedChecks([
    '# aws-dr-canary - 12 check(s) [--strict]\n[OK       ] rds-snapshot           3.1h old\n[STALE    ] ssm-archive            neither today nor yesterday found\n[LEAK     ] commons-ring-residue   12 chunk(s) of ring-private content',
    '[ERROR    ] n8n-healthz            never returned HTTP 200',
  ]);
  assert.deepEqual(rows, [
    'STALE ssm-archive neither today nor yesterday found',
    'LEAK commons-ring-residue 12 chunk(s) of ring-private content',
    'ERROR n8n-healthz never returned HTTP 200',
  ]);
});

test('buildAlertBody names the failed steps and checks, quotes the pager stderr, and redacts', () => {
  const body = buildAlertBody({
    workflow: 'Nightly AWS DR Canary',
    runUrl: 'https://github.com/o/r/actions/runs/1',
    stepOutcomes: 'aws=success canary=failure heartbeat=failure',
    delivery: ['email: FAILED (cto-lane creds unavailable (oauth-lane-cto-id/secret))', "posthog: FAILED (posthog-fleet-ingest-key unavailable)"],
    diag: [`[kv-secret] ACCESS DENIED reading "oauth-lane-cto-id" (AccessDeniedException) Credential=${FAKE_KEY_ID}/x`],
    logSections: ['[a.log] (last 3 of 3 lines):\n[STALE   ] ssm-archive  too old\nAuthorization: Bearer abc.def.ghi'],
    mention: '@octocat',
    now: new Date('2026-10-07T05:00:00Z'),
  });
  assert.match(body, /^\*\*Nightly AWS DR Canary: RED\*\*/);
  assert.match(body, /failed steps: canary, heartbeat/);
  assert.match(body, /Run: https:\/\/github\.com\/o\/r\/actions\/runs\/1/);
  assert.match(body, /At \(UTC\): 2026-10-07T05:00:00\.000Z/);
  assert.match(body, /Step outcomes: aws=success, canary=failure, heartbeat=failure/);
  assert.match(body, /- email: FAILED/);
  assert.match(body, /Degraded channel:/);
  assert.match(body, /Failed checks \(from the log\):\n- STALE ssm-archive too old/);
  assert.match(body, /ACCESS DENIED reading "oauth-lane-cto-id"/);
  assert.match(body, /cc @octocat/);
  assert.doesNotMatch(body, /ASIAABCDEFGHIJKLMNOP|abc\.def\.ghi/);
  assert.doesNotMatch(body, /[—–]/, 'no em/en dashes (fleet copy convention)');
});

test('buildAlertBody self-test banner replaces the incident wording and never mentions anyone', () => {
  const body = buildAlertBody({ workflow: 'W', runUrl: 'u', testMode: true, mention: '@octocat', delivery: ['email: sent to x'] });
  assert.match(body, /PAGER SELF-TEST \(not a real incident\)/);
  assert.match(body, /No real incident occurred/);
  assert.doesNotMatch(body, /cc @octocat|Degraded channel/);
  assert.doesNotMatch(body, /failed on its schedule/);
});

test('buildAlertBody is bounded', () => {
  const body = buildAlertBody({ workflow: 'W', runUrl: 'u', logSections: ['x'.repeat(500000)], diag: ['y'.repeat(500000)] });
  assert.ok(body.length <= 60000);
});

test('upsertAlertIssue creates the issue when no open one has the exact title', async () => {
  const { fetchImpl, calls } = makeFetch((c) => (c.method === 'GET' ? { json: [{ number: 1, title: '[FLEET-ALERT] other' }] } : { status: 201, json: { number: 42, html_url: 'https://x/42' } }));
  const r = await upsertAlertIssue({ repo: 'o/r', token: 'tok', title: '[FLEET-ALERT] w', body: 'B', fetchImpl });
  assert.deepEqual(r, { action: 'created', number: 42, url: 'https://x/42' });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].path, '/repos/o/r/issues?state=open&per_page=100&page=1');
  assert.equal(calls[1].method, 'POST');
  assert.equal(calls[1].path, '/repos/o/r/issues');
  assert.deepEqual(calls[1].body, { title: '[FLEET-ALERT] w', body: 'B' });
  assert.equal(calls[1].headers.Authorization, 'Bearer tok');
  assert.ok(!JSON.stringify(calls[1].body).includes('tok'), 'the token never enters a request body');
});

test('upsertAlertIssue comments on the existing open issue and ignores a PR with the same title', async () => {
  const rows = [
    { number: 5, title: '[FLEET-ALERT] w', pull_request: {} },
    { number: 9, title: '[FLEET-ALERT] w', html_url: 'https://x/9' },
  ];
  const { fetchImpl, calls } = makeFetch((c) => (c.method === 'GET' ? { json: rows } : { status: 201, json: { html_url: 'https://x/9#c' } }));
  const r = await upsertAlertIssue({ repo: 'o/r', token: 'tok', title: '[FLEET-ALERT] w', body: 'B', fetchImpl });
  assert.deepEqual(r, { action: 'commented', number: 9, url: 'https://x/9' });
  assert.equal(calls[1].path, '/repos/o/r/issues/9/comments');
  assert.deepEqual(calls[1].body, { body: 'B' });
});

test('upsertAlertIssue pages past a full first page before creating', async () => {
  const full = Array.from({ length: 100 }, (_, i) => ({ number: i + 1, title: `t${i}` }));
  const { fetchImpl, calls } = makeFetch((c) => {
    if (c.method === 'GET') return { json: c.path.endsWith('page=1') ? full : [{ number: 777, title: '[FLEET-ALERT] w', html_url: 'https://x/777' }] };
    return { status: 201, json: {} };
  });
  const r = await upsertAlertIssue({ repo: 'o/r', token: 'tok', title: '[FLEET-ALERT] w', body: 'B', fetchImpl });
  assert.equal(r.number, 777);
  assert.equal(calls[1].path, '/repos/o/r/issues?state=open&per_page=100&page=2');
});

test('upsertAlertIssue fails loud, with the permission hint, when GitHub refuses', async () => {
  const { fetchImpl } = makeFetch(() => ({ status: 403, json: { message: 'Resource not accessible by integration' } }));
  await assert.rejects(
    upsertAlertIssue({ repo: 'o/r', token: 'tok', title: 't', body: 'B', fetchImpl }),
    /list issues HTTP 403: Resource not accessible by integration .*issues: write/,
  );
  await assert.rejects(upsertAlertIssue({ repo: 'o/r', token: '', title: 't', body: 'B', fetchImpl }), /GITHUB_TOKEN/);
  await assert.rejects(upsertAlertIssue({ repo: 'nonsense', token: 'tok', title: 't', body: 'B', fetchImpl }), /GITHUB_REPOSITORY/);
  const failCreate = makeFetch((c) => (c.method === 'GET' ? { json: [] } : { status: 422, json: { message: 'Validation Failed' } }));
  await assert.rejects(upsertAlertIssue({ repo: 'o/r', token: 'tok', title: 't', body: 'B', fetchImpl: failCreate.fetchImpl }), /create issue HTTP 422: Validation Failed/);
});

test('deliverIssueChannel is off without a title, never throws, and bounds a hung attempt', async () => {
  assert.deepEqual(await deliverIssueChannel({ cfg: { title: '' }, workflow: 'W', runUrl: 'u' }), { issued: null, error: null });

  const ok = await deliverIssueChannel({
    cfg: { title: 'T', mention: '', stepOutcomes: 'canary=failure' }, workflow: 'W', runUrl: 'u',
    env: { GITHUB_REPOSITORY: 'o/r', GITHUB_TOKEN: 'tok' },
    upsert: async (a) => { assert.equal(a.repo, 'o/r'); assert.equal(a.token, 'tok'); assert.match(a.body, /failed steps: canary/); return { action: 'created', number: 3, url: 'u3' }; },
  });
  assert.deepEqual(ok, { issued: { action: 'created', number: 3, url: 'u3' }, error: null });

  const bad = await deliverIssueChannel({
    cfg: { title: 'T' }, workflow: 'W', runUrl: 'u', env: {},
    upsert: async () => { throw new Error(`boom Credential=${FAKE_KEY_ID}/x`); },
  });
  assert.equal(bad.issued, null);
  assert.match(bad.error, /boom/);
  assert.doesNotMatch(bad.error, /ASIAABCDEFGHIJKLMNOP/);

  const hung = await deliverIssueChannel({ cfg: { title: 'T' }, workflow: 'W', runUrl: 'u', env: {}, upsert: () => new Promise(() => {}), timeoutMs: 20 });
  assert.equal(hung.issued, null);
  assert.match(hung.error, /timed out after 20ms/);
});

test('startDiagCapture tees console.error and restores it', () => {
  const real = console.error;
  const seen = [];
  console.error = (...a) => seen.push(a.join(' '));
  const diag = startDiagCapture(2);
  console.error('one');
  console.error('two', 'parts');
  console.error('three');
  assert.deepEqual(diag.lines, ['two parts', 'three']);
  assert.deepEqual(seen, ['one', 'two parts', 'three'], 'the real log line still goes out');
  diag.stop();
  console.error('after');
  assert.deepEqual(diag.lines, ['two parts', 'three']);
  assert.equal(seen.at(-1), 'after');
  console.error = real;
});

test('issueConfigFromArgv reads flags, falls back to env, and ignores a flag-like value', () => {
  assert.deepEqual(
    issueConfigFromArgv(['--workflow', 'W', '--github-issue', '[FLEET-ALERT] w', '--github-mention', '@octocat'], { PAGE_STEP_OUTCOMES: 'canary=failure' }),
    { title: '[FLEET-ALERT] w', mention: '@octocat', stepOutcomes: 'canary=failure' },
  );
  assert.deepEqual(issueConfigFromArgv([], { PAGE_GITHUB_ISSUE_TITLE: ' T ', PAGE_GITHUB_MENTION: '@a @bad!' }), { title: 'T', mention: '@a', stepOutcomes: '' });
  assert.equal(issueConfigFromArgv(['--github-issue', '--log', 'x'], {}).title, '');
  assert.equal(issueConfigFromArgv(['--workflow', 'W'], {}).title, '');
});

// ---------------------------------------------------------------------------------------------------
// The owner mention (2026-10-07). Proof run 37669544722 opened issue 621 with no mention because the repo variable
// FLEET_ALERT_MENTION was unset; the workflows now default PAGE_GITHUB_MENTION to '@GBGolfMatt'. GitHub notifies a user
// when a mention appears in NEW content (a new issue body or a new comment), not when an existing body is edited, so the
// pager must write it into every new body and every new comment and must never PATCH anything.

test('the workflow default value survives parseMentions only with its leading at sign (a bare login is dropped)', () => {
  assert.equal(parseMentions('@GBGolfMatt'), '@GBGolfMatt');
  assert.equal(parseMentions('GBGolfMatt'), '', 'a login without the at sign mentions nobody: the default MUST be written with it');
});

test('the owner mention rides in NEW content on every page: the new issue body, then each repeat page as a NEW comment, never an edit', async () => {
  const issues = [];
  const { fetchImpl, calls } = makeFetch((c) => {
    if (c.method === 'GET') return { json: issues };
    if (c.method === 'POST' && c.path === '/repos/o/r/issues') {
      const made = { number: 7, title: c.body.title, html_url: 'https://x/7' };
      issues.push(made);
      return { status: 201, json: made };
    }
    if (c.method === 'POST' && c.path === '/repos/o/r/issues/7/comments') return { status: 201, json: { html_url: 'https://x/7#c' } };
    return { status: 500, json: { message: `unexpected ${c.method} ${c.path}` } };
  });
  const cfg = issueConfigFromArgv(['--workflow', 'W', '--github-issue', '[FLEET-ALERT] w'], { PAGE_GITHUB_MENTION: '@GBGolfMatt', PAGE_STEP_OUTCOMES: 'canary=failure' });
  assert.equal(cfg.mention, '@GBGolfMatt');
  assert.equal('mentionNote' in cfg, false, 'a valid mention needs no explanatory note');
  const page = () => deliverIssueChannel({
    cfg, workflow: 'W', runUrl: 'u', env: { GITHUB_REPOSITORY: 'o/r', GITHUB_TOKEN: 'tok' },
    upsert: (a) => upsertAlertIssue({ ...a, fetchImpl }),
  });
  const pages = [await page(), await page(), await page()];
  assert.deepEqual(pages.map((p) => p.issued && p.issued.action), ['created', 'commented', 'commented']);
  assert.deepEqual(pages.map((p) => p.error), [null, null, null]);
  const writes = calls.filter((c) => c.method !== 'GET');
  assert.equal(writes.length, 3);
  assert.deepEqual(writes.map((c) => `${c.method} ${c.path}`), ['POST /repos/o/r/issues', 'POST /repos/o/r/issues/7/comments', 'POST /repos/o/r/issues/7/comments']);
  for (const w of writes) assert.match(w.body.body, /\bcc @GBGolfMatt\b/, `${w.path}: the mention is in the new content GitHub notifies on`);
  assert.ok(!calls.some((c) => ['PATCH', 'PUT', 'DELETE'].includes(c.method)), 'an edit would not notify: the pager never edits an issue or a comment');
});

test('test mode never mentions the owner and never adds the mention note', () => {
  const body = buildAlertBody({ workflow: 'W', runUrl: 'u', testMode: true, mention: '@GBGolfMatt', mentionNote: MENTION_NOTE });
  assert.doesNotMatch(body, /cc @GBGolfMatt|@GBGolfMatt/);
  assert.ok(!body.includes(MENTION_NOTE));
});

test('a mention that parses to nothing is announced in the issue instead of vanishing (a bare login, a placeholder)', () => {
  for (const raw of ['GBGolfMatt', 'none', 'matt, bob', '@bad!']) {
    const cfg = issueConfigFromArgv(['--github-issue', '[FLEET-ALERT] w'], { PAGE_GITHUB_MENTION: raw });
    assert.equal(cfg.mention, '', raw);
    assert.equal(cfg.mentionNote, MENTION_NOTE, raw);
  }
  const body = buildAlertBody({ workflow: 'W', runUrl: 'u', mention: '', mentionNote: MENTION_NOTE });
  assert.ok(body.includes(MENTION_NOTE));
  assert.doesNotMatch(body, /\bcc @/, 'nobody is mentioned');
});

test('no note when a valid mention is set, when no mention is configured at all, or when the value is blank', () => {
  for (const env of [{ PAGE_GITHUB_MENTION: '@GBGolfMatt' }, { PAGE_GITHUB_MENTION: '@a GBGolfMatt' }, {}, { PAGE_GITHUB_MENTION: '' }, { PAGE_GITHUB_MENTION: '   ' }]) {
    const cfg = issueConfigFromArgv(['--github-issue', 'T'], env);
    assert.equal('mentionNote' in cfg, false, JSON.stringify(env));
  }
  const flag = issueConfigFromArgv(['--github-issue', 'T', '--github-mention', 'GBGolfMatt'], { PAGE_GITHUB_MENTION: '@octocat' });
  assert.equal(flag.mention, '', 'the flag wins over the env value, as before');
  assert.equal(flag.mentionNote, MENTION_NOTE);
  const body = buildAlertBody({ workflow: 'W', runUrl: 'u', mention: '@GBGolfMatt' });
  assert.match(body, /cc @GBGolfMatt/);
  assert.ok(!body.includes('NOTE: nobody was mentioned'));
});

test('the mention note names no handle (a handle written in it would notify whoever owns it) and survives redaction', () => {
  assert.doesNotMatch(MENTION_NOTE, /@/);
  assert.equal(parseMentions(MENTION_NOTE), '');
  assert.equal(redactSecrets(MENTION_NOTE), MENTION_NOTE, 'the pager redaction must leave the note readable');
  assert.doesNotMatch(MENTION_NOTE, /[—–]/, 'no em/en dashes (fleet copy convention)');
  assert.match(MENTION_NOTE, /FLEET_ALERT_MENTION/);
});

test('deliverIssueChannel carries the note into the posted body when the mention is invalid', async () => {
  const seen = [];
  const cfg = issueConfigFromArgv(['--github-issue', 'T'], { PAGE_GITHUB_MENTION: 'GBGolfMatt' });
  const r = await deliverIssueChannel({
    cfg, workflow: 'W', runUrl: 'u', env: { GITHUB_REPOSITORY: 'o/r', GITHUB_TOKEN: 'tok' },
    upsert: async (a) => { seen.push(a.body); return { action: 'created', number: 1, url: 'u' }; },
  });
  assert.equal(r.error, null);
  assert.equal(seen.length, 1);
  assert.ok(seen[0].includes(MENTION_NOTE));
  assert.doesNotMatch(seen[0], /\bcc @/);
});
