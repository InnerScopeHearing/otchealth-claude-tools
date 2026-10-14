import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, link, lstat, mkdtemp, mkdir, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AUTHORIZE_ENDPOINT,
  CONSENT_ENDPOINT,
  GATEWAY_ORIGIN,
  MCP_ENDPOINT,
  REGISTER_ENDPOINT,
  SESSION_FILE,
  TOKEN_ENDPOINT,
  bootstrapSession,
  callTool,
  createPkce,
  exactLoopbackCallbackUrl,
  redactCredentialFields,
  sessionStatus,
  toolSchema,
} from '../cloud-session.mjs';

const SETUP_CODE = 'ABCD-EFGH-JKMP-QRST';
const PENDING_ID = '0123456789abcdef0123456789abcdef';
const CLIENT_ID = 'dcr_payload.signature';
const ACCESS_SECRET = 'access-token-secret-value';
const REFRESH_SECRET = 'refresh-token-secret-value';

function token(agent = 'developer', gty = 'authorization_code', exp = Math.floor(Date.now() / 1000) + 3600, sub = CLIENT_ID) {
  const payload = Buffer.from(JSON.stringify({ agent, gty, typ: 'access', cs: true, sub, exp })).toString('base64url');
  return `header.${payload}.signature`;
}

function json(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function authResponse(accessToken = token(), refreshToken = REFRESH_SECRET, grant = 'authorization_code') {
  return json({ access_token: accessToken, refresh_token: refreshToken, token_type: 'Bearer', expires_in: 3600, scope: 'mcp', grant });
}

function identityProbe() {
  return json({ result: { structuredContent: { result: { data: { request_context: {
    caller_agent: 'developer', is_m365_static_auth: false, is_connector_surface: true,
  } } } } } });
}

async function tempSessionDir(t, name = 'session') {
  const root = await mkdtemp(join(tmpdir(), 'developer-cloud-session-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, sessionDir: join(root, name) };
}

function fakeGateway({ wrongCallback = false, wrongAgent = false, tools = [] } = {}) {
  const calls = [];
  let state;
  let redirectUri;
  let challenge;
  let consentCount = 0;
  let tokenCount = 0;
  const fetchImpl = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url === REGISTER_ENDPOINT) {
      assert.equal(init.redirect, 'error');
      const body = JSON.parse(init.body);
      redirectUri = body.redirect_uris[0];
      assert.equal(body.application_type, 'native');
      assert.equal(body.redirect_uris.length, 1);
      assert.match(redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback$/);
      return json({ client_id: CLIENT_ID, token_endpoint_auth_method: 'none', redirect_uris: [redirectUri] }, 201);
    }
    if (url.startsWith(`${AUTHORIZE_ENDPOINT}?`)) {
      assert.equal(init.method, 'GET');
      assert.equal(init.redirect, 'manual');
      const authUrl = new URL(url);
      assert.equal(authUrl.searchParams.get('client_id'), CLIENT_ID);
      assert.equal(authUrl.searchParams.get('redirect_uri'), redirectUri);
      assert.equal(authUrl.searchParams.get('response_type'), 'code');
      assert.equal(authUrl.searchParams.get('scope'), 'mcp');
      assert.equal(authUrl.searchParams.get('code_challenge_method'), 'S256');
      state = authUrl.searchParams.get('state');
      challenge = authUrl.searchParams.get('code_challenge');
      return new Response(`<form><input type="hidden" name="pending_id" value="${PENDING_ID}"></form>`, {
        status: 200, headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }
    if (url === CONSENT_ENDPOINT) {
      consentCount += 1;
      assert.equal(init.method, 'POST');
      assert.equal(init.redirect, 'manual');
      const form = new URLSearchParams(init.body);
      assert.equal(form.get('pending_id'), PENDING_ID);
      assert.equal(form.get('action'), 'elevate');
      assert.equal(form.get('code'), SETUP_CODE);
      assert.equal(form.getAll('code').length, 1);
      const target = wrongCallback ? 'https://attacker.invalid/oauth/callback' : redirectUri;
      return new Response(null, { status: 302, headers: { location: `${target}?code=authorization-code-value&state=${state}` } });
    }
    if (url === TOKEN_ENDPOINT) {
      tokenCount += 1;
      assert.equal(init.redirect, 'error');
      const form = new URLSearchParams(init.body);
      assert.equal(form.get('grant_type'), 'authorization_code');
      assert.equal(form.get('client_id'), CLIENT_ID);
      assert.equal(form.get('redirect_uri'), redirectUri);
      const verifier = form.get('code_verifier');
      assert.ok(verifier);
      assert.equal(createHash('sha256').update(verifier).digest('base64url'), challenge);
      assert.equal(form.get('code'), 'authorization-code-value');
      return authResponse(token(wrongAgent ? 'cto' : 'developer'));
    }
    if (url === MCP_ENDPOINT) {
      assert.equal(init.redirect, 'error');
      assert.match(init.headers.authorization, /^Bearer /);
      const rpc = JSON.parse(init.body);
      assert.equal(rpc.method, 'tools/call');
      assert.equal(rpc.params.name, 'catalog_probe');
      assert.deepEqual(rpc.params.arguments, { include_cto_workspace: false });
      return identityProbe();
    }
    throw new Error(`unexpected endpoint ${url}`);
  };
  return { fetchImpl, calls, get consentCount() { return consentCount; }, get tokenCount() { return tokenCount; }, get state() { return state; }, get redirectUri() { return redirectUri; }, get challenge() { return challenge; } };
}

test('PKCE generates an S256 challenge over a fresh verifier', () => {
  const { verifier, challenge } = createPkce();
  assert.match(verifier, /^[A-Za-z0-9_-]{40,}$/);
  assert.equal(challenge, createHash('sha256').update(verifier).digest('base64url'));
  assert.notEqual(verifier, challenge);
});

test('hidden TTY setup input pauses the still-open stream so a subprocess can exit', () => {
  const moduleUrl = new URL('../cloud-session.mjs', import.meta.url).href;
  const script = `
    import { PassThrough } from 'node:stream';
    import { readSetupCodeFromStdin } from ${JSON.stringify(moduleUrl)};
    const input = new PassThrough();
    const prompt = new PassThrough();
    input.isTTY = true;
    input.isRaw = false;
    input.setRawMode = (mode) => { input.isRaw = mode; };
    const pending = readSetupCodeFromStdin(input, prompt);
    input.write('synthetic-owner-code\\n');
    pending.then((value) => {
      if (value !== 'synthetic-owner-code' || input.isRaw || !input.isPaused()) process.exitCode = 1;
      process.stdout.write('completed');
    });
  `;
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8', timeout: 2_000,
  });
  assert.equal(output, 'completed');
});

test('manual authorization redirect accepts only exact 127.0.0.1 callback, matching state, one code', () => {
  const redirect = 'http://127.0.0.1:53014/oauth/callback';
  assert.equal(exactLoopbackCallbackUrl(`${redirect}?code=one&state=s`, redirect, 's'), 'one');
  for (const candidate of [
    `http://localhost:53014/oauth/callback?code=one&state=s`,
    `http://127.0.0.1:53014/elsewhere?code=one&state=s`,
    `${redirect}?code=one&code=two&state=s`,
    `${redirect}?code=one&state=s&state=s`,
    `${redirect}?code=one&state=wrong`,
    `${redirect}?code=one&state=s&extra=x`,
    `${redirect}?code=one&state=s#fragment`,
  ]) assert.throws(() => exactLoopbackCallbackUrl(candidate, redirect, 's'));
  assert.throws(() => exactLoopbackCallbackUrl('https://127.0.0.1:53014/oauth/callback?code=one&state=s', redirect, 's'));
});

test('bootstrap submits stdin owner code exactly once, exchanges PKCE code, probes server identity, then saves mode-0600 session', async (t) => {
  const { sessionDir } = await tempSessionDir(t);
  const gateway = fakeGateway();
  const result = await bootstrapSession({ sessionDir, setupCode: SETUP_CODE, fetchImpl: gateway.fetchImpl });
  assert.deepEqual(result, { agent: 'developer', expiresAt: result.expiresAt, connectorSurface: true, m365StaticAuth: false });
  assert.equal(gateway.consentCount, 1);
  assert.equal(gateway.tokenCount, 1);
  assert.deepEqual(gateway.calls.map((call) => new URL(call.url).pathname), [
    '/register', '/oauth/authorize', '/oauth/authorize/consent', '/oauth/token', '/mcp',
  ]);
  const dirInfo = await lstat(sessionDir);
  const filePath = join(sessionDir, SESSION_FILE);
  const fileInfo = await lstat(filePath);
  assert.equal(dirInfo.mode & 0o777, 0o700);
  assert.equal(fileInfo.mode & 0o777, 0o600);
  assert.equal(fileInfo.nlink, 1);
  const saved = JSON.parse(await readFile(filePath, 'utf8'));
  assert.equal(saved.agent, 'developer');
  assert.equal(saved.grantType, 'authorization_code');
  assert.equal(saved.accessToken, token());
  assert.equal(saved.refreshToken, REFRESH_SECRET);
  assert.doesNotMatch(await readFile(filePath, 'utf8'), new RegExp(SETUP_CODE.replaceAll('-', '')));
  assert.doesNotMatch(await readFile(filePath, 'utf8'), /authorization-code-value/);
  assert.doesNotMatch(JSON.stringify(result), /token|secret|code/i);
});

test('bootstrap refuses mismatched gateway callback before token exchange or saving', async (t) => {
  const { sessionDir } = await tempSessionDir(t);
  const gateway = fakeGateway({ wrongCallback: true });
  await assert.rejects(() => bootstrapSession({ sessionDir, setupCode: SETUP_CODE, fetchImpl: gateway.fetchImpl }), /did not match the registered loopback URI/);
  assert.equal(gateway.consentCount, 1);
  assert.equal(gateway.tokenCount, 0);
  await assert.rejects(() => lstat(join(sessionDir, SESSION_FILE)), { code: 'ENOENT' });
});

test('bootstrap rejects wrong signed-context claims before catalog probe or session persistence', async (t) => {
  const { sessionDir } = await tempSessionDir(t);
  const gateway = fakeGateway({ wrongAgent: true });
  await assert.rejects(() => bootstrapSession({ sessionDir, setupCode: SETUP_CODE, fetchImpl: gateway.fetchImpl }), /identity did not match/);
  assert.equal(gateway.tokenCount, 1);
  assert.equal(gateway.calls.filter((call) => call.url === MCP_ENDPOINT).length, 0);
  await assert.rejects(() => lstat(join(sessionDir, SESSION_FILE)), { code: 'ENOENT' });
});

test('bootstrap does not retry owner-consent on an unknown HTTP outcome', async (t) => {
  const { sessionDir } = await tempSessionDir(t);
  const gateway = fakeGateway();
  const original = gateway.fetchImpl;
  const fetchImpl = async (url, options) => {
    if (String(url) === CONSENT_ENDPOINT) {
      gateway.calls.push({ url: String(url), init: options });
      throw new Error(`transport failure echoed ${SETUP_CODE}`);
    }
    return original(url, options);
  };
  await assert.rejects(() => bootstrapSession({ sessionDir, setupCode: SETUP_CODE, fetchImpl }), (error) => {
    assert.doesNotMatch(error.message, /ABCD|transport failure echoed/);
    return true;
  });
  assert.equal(gateway.calls.filter((call) => call.url === CONSENT_ENDPOINT).length, 1);
  assert.equal(gateway.tokenCount, 0);
});

test('expired access token refreshes once, verifies the renewed Developer identity, and rotates stored refresh token', async (t) => {
  const { sessionDir } = await tempSessionDir(t);
  const gateway = fakeGateway();
  await bootstrapSession({ sessionDir, setupCode: SETUP_CODE, fetchImpl: gateway.fetchImpl });
  const filePath = join(sessionDir, SESSION_FILE);
  const saved = JSON.parse(await readFile(filePath, 'utf8'));
  saved.expiresAt = new Date(Date.now() - 60_000).toISOString();
  await (await import('node:fs/promises')).writeFile(filePath, JSON.stringify(saved));
  await chmod(filePath, 0o600);
  let refreshes = 0;
  const refreshedAccess = token('developer', 'refresh_token');
  const fetchImpl = async (url, options = {}) => {
    if (String(url) === TOKEN_ENDPOINT && new URLSearchParams(options.body).get('grant_type') === 'refresh_token') {
      refreshes += 1;
      return authResponse(refreshedAccess, 'rotated-refresh-token-value', 'refresh_token');
    }
    if (String(url) === MCP_ENDPOINT) {
      const rpc = JSON.parse(options.body);
      if (rpc.method === 'tools/call' && rpc.params.name === 'catalog_probe') return identityProbe();
    }
    throw new Error('unexpected refresh request');
  };
  const status = await sessionStatus({ sessionDir, fetchImpl });
  assert.equal(status.agent, 'developer');
  assert.equal(refreshes, 1);
  const rotated = JSON.parse(await readFile(filePath, 'utf8'));
  assert.equal(rotated.refreshToken, 'rotated-refresh-token-value');
  assert.equal(rotated.accessToken, refreshedAccess);
  // A cache-busted module instance models a fresh client process reading the durable session.
  const restartedClient = await import(`../cloud-session.mjs?restart=${Date.now()}`);
  const afterRestart = await restartedClient.sessionStatus({ sessionDir, fetchImpl });
  assert.equal(afterRestart.status, 'connected');
  assert.equal(refreshes, 1);
});

test('expired session with a revoked refresh token fails before a protected operation and does not retry', async (t) => {
  const { sessionDir } = await tempSessionDir(t);
  const gateway = fakeGateway();
  await bootstrapSession({ sessionDir, setupCode: SETUP_CODE, fetchImpl: gateway.fetchImpl });
  const filePath = join(sessionDir, SESSION_FILE);
  const saved = JSON.parse(await readFile(filePath, 'utf8'));
  saved.expiresAt = new Date(Date.now() - 60_000).toISOString();
  await (await import('node:fs/promises')).writeFile(filePath, JSON.stringify(saved));
  await chmod(filePath, 0o600);

  let refreshAttempts = 0;
  let protectedCalls = 0;
  const fetchImpl = async (url, options = {}) => {
    if (String(url) === TOKEN_ENDPOINT) {
      refreshAttempts += 1;
      assert.equal(new URLSearchParams(options.body).get('grant_type'), 'refresh_token');
      return json({ error: 'invalid_grant' }, 400);
    }
    if (String(url) === MCP_ENDPOINT) protectedCalls += 1;
    throw new Error('unexpected request');
  };
  await assert.rejects(() => callTool({ sessionDir, toolName: 'task_update', args: { task_id: 'x' }, fetchImpl }), /token exchange failed \(HTTP 400\)/);
  assert.equal(refreshAttempts, 1);
  assert.equal(protectedCalls, 0);
  assert.deepEqual(JSON.parse(await readFile(filePath, 'utf8')), saved);
});

test('a refresh response for another seat is rejected without replacing the durable session', async (t) => {
  const { sessionDir } = await tempSessionDir(t);
  const gateway = fakeGateway();
  await bootstrapSession({ sessionDir, setupCode: SETUP_CODE, fetchImpl: gateway.fetchImpl });
  const filePath = join(sessionDir, SESSION_FILE);
  const saved = JSON.parse(await readFile(filePath, 'utf8'));
  saved.expiresAt = new Date(Date.now() - 60_000).toISOString();
  await (await import('node:fs/promises')).writeFile(filePath, JSON.stringify(saved));
  await chmod(filePath, 0o600);

  let refreshAttempts = 0;
  let gatewayRequests = 0;
  const fetchImpl = async (url, options = {}) => {
    if (String(url) === TOKEN_ENDPOINT) {
      refreshAttempts += 1;
      return authResponse(token('cto', 'refresh_token'), 'rotated-refresh-token-value', 'refresh_token');
    }
    if (String(url) === MCP_ENDPOINT) gatewayRequests += 1;
    throw new Error('unexpected request');
  };
  await assert.rejects(() => sessionStatus({ sessionDir, fetchImpl }), /identity did not match/);
  assert.equal(refreshAttempts, 1);
  assert.equal(gatewayRequests, 0);
  assert.deepEqual(JSON.parse(await readFile(filePath, 'utf8')), saved);
});

test('missing refresh credential fails before network access', async (t) => {
  const { sessionDir } = await tempSessionDir(t);
  const gateway = fakeGateway();
  await bootstrapSession({ sessionDir, setupCode: SETUP_CODE, fetchImpl: gateway.fetchImpl });
  const filePath = join(sessionDir, SESSION_FILE);
  const saved = JSON.parse(await readFile(filePath, 'utf8'));
  delete saved.refreshToken;
  await (await import('node:fs/promises')).writeFile(filePath, JSON.stringify(saved));
  await chmod(filePath, 0o600);
  let requests = 0;
  await assert.rejects(() => sessionStatus({ sessionDir, fetchImpl: async () => { requests += 1; throw new Error('unexpected'); } }), /incomplete/);
  assert.equal(requests, 0);
});

test('lost refresh response is not retried and does not reach the requested tool', async (t) => {
  const { sessionDir } = await tempSessionDir(t);
  const gateway = fakeGateway();
  await bootstrapSession({ sessionDir, setupCode: SETUP_CODE, fetchImpl: gateway.fetchImpl });
  const filePath = join(sessionDir, SESSION_FILE);
  const saved = JSON.parse(await readFile(filePath, 'utf8'));
  saved.expiresAt = new Date(Date.now() - 60_000).toISOString();
  await (await import('node:fs/promises')).writeFile(filePath, JSON.stringify(saved));
  await chmod(filePath, 0o600);

  let refreshAttempts = 0;
  let protectedCalls = 0;
  const fetchImpl = async (url) => {
    if (String(url) === TOKEN_ENDPOINT) {
      refreshAttempts += 1;
      throw new Error('synthetic response lost after server rotation');
    }
    if (String(url) === MCP_ENDPOINT) protectedCalls += 1;
    throw new Error('unexpected request');
  };
  await assert.rejects(() => callTool({ sessionDir, toolName: 'task_update', args: { task_id: 'x' }, fetchImpl }), /token exchange failed/);
  assert.equal(refreshAttempts, 1);
  assert.equal(protectedCalls, 0);
  assert.deepEqual(JSON.parse(await readFile(filePath, 'utf8')), saved);
});

test('schema output preserves normal business code properties while removing credential fields', async (t) => {
  const { sessionDir } = await tempSessionDir(t);
  const gateway = fakeGateway();
  await bootstrapSession({ sessionDir, setupCode: SETUP_CODE, fetchImpl: gateway.fetchImpl });
  const schemaResponse = {
    jsonrpc: '2.0', id: 1, result: { tools: [{
      name: 'aws_mcp_tool_call', inputSchema: { properties: {
        code: { type: 'string', description: 'A normal AWS source code value.' },
        access_token: { type: 'string', description: 'credential' },
        client_secret: { type: 'string', description: 'credential' },
      } },
    }] },
  };
  const fetchImpl = async (url, options = {}) => {
    if (String(url) !== MCP_ENDPOINT) throw new Error('unexpected');
    const rpc = JSON.parse(options.body);
    if (rpc.params.name === 'catalog_probe') return identityProbe();
    return json(schemaResponse);
  };
  const schema = await toolSchema({ sessionDir, toolName: 'aws_mcp_tool_call', fetchImpl });
  assert.equal(schema.inputSchema.properties.code.type, 'string');
  assert.equal(schema.inputSchema.properties.access_token, undefined);
  assert.equal(schema.inputSchema.properties.client_secret, undefined);
});

test('tool call unknown outcome is returned safely after one attempt, without retrying the call', async (t) => {
  const { sessionDir } = await tempSessionDir(t);
  const gateway = fakeGateway();
  await bootstrapSession({ sessionDir, setupCode: SETUP_CODE, fetchImpl: gateway.fetchImpl });
  let callCount = 0;
  const fetchImpl = async (url, options = {}) => {
    if (String(url) !== MCP_ENDPOINT) throw new Error('unexpected');
    const rpc = JSON.parse(options.body);
    if (rpc.method === 'tools/call' && rpc.params.name === 'catalog_probe') return identityProbe();
    if (rpc.method === 'tools/list') return json({ result: { tools: [{ name: 'task_update' }] } });
    callCount += 1;
    return new Response('opaque failure', { status: 504 });
  };
  await assert.rejects(() => callTool({ sessionDir, toolName: 'task_update', args: { task_id: 'x' }, fetchImpl }), /HTTP 504/);
  assert.equal(callCount, 1);
});

test('credential field redaction does not erase normal business or policy code fields', () => {
  const result = redactCredentialFields({
    code: 'business-code',
    error: { code: 'forbidden_role' },
    access_token: ACCESS_SECRET,
    client_secret: 'client-secret-value',
    setup_code: SETUP_CODE,
    message: `Bearer ${ACCESS_SECRET}`,
  }, [ACCESS_SECRET]);
  assert.equal(result.code, 'business-code');
  assert.equal(result.error.code, 'forbidden_role');
  assert.equal(result.access_token, undefined);
  assert.equal(result.client_secret, undefined);
  assert.equal(result.setup_code, undefined);
  assert.equal(result.message, 'Bearer [REDACTED]');
});

test('a cached CTO bearer is rejected before any protected MCP call', async (t) => {
  const { sessionDir } = await tempSessionDir(t);
  await mkdir(sessionDir, { mode: 0o700 });
  await chmod(sessionDir, 0o700);
  await (await import('node:fs/promises')).writeFile(join(sessionDir, SESSION_FILE), JSON.stringify({
    version: 1, clientId: CLIENT_ID, agent: 'developer', grantType: 'authorization_code',
    connectorSurface: true, m365StaticAuth: false, accessToken: token('cto'), refreshToken: REFRESH_SECRET,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }), { mode: 0o600 });
  let requests = 0;
  await assert.rejects(() => callTool({
    sessionDir, toolName: 'task_update', args: { task_id: 'x' },
    fetchImpl: async () => { requests += 1; throw new Error('should not send'); },
  }), /Cached OAuth session identity/);
  assert.equal(requests, 0);
});

test('session reader rejects a symlinked token file and hard-linked session file', async (t) => {
  const { root, sessionDir } = await tempSessionDir(t);
  await mkdir(sessionDir, { mode: 0o700 });
  await chmod(sessionDir, 0o700);
  const outside = join(root, 'outside.json');
  await (await import('node:fs/promises')).writeFile(outside, JSON.stringify({
    version: 1, clientId: CLIENT_ID, agent: 'developer', accessToken: token(), refreshToken: REFRESH_SECRET,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }), { mode: 0o600 });
  await symlink(outside, join(sessionDir, SESSION_FILE));
  await assert.rejects(() => sessionStatus({ sessionDir }), /unsafe permissions/);
  await rm(join(sessionDir, SESSION_FILE));
  await link(outside, join(sessionDir, SESSION_FILE));
  await assert.rejects(() => sessionStatus({ sessionDir }), /unsafe permissions/);
});

test('all OAuth and MCP endpoint constants remain fixed to the public gateway origin', () => {
  assert.equal(new URL(REGISTER_ENDPOINT).origin, GATEWAY_ORIGIN);
  assert.equal(new URL(AUTHORIZE_ENDPOINT).origin, GATEWAY_ORIGIN);
  assert.equal(new URL(CONSENT_ENDPOINT).origin, GATEWAY_ORIGIN);
  assert.equal(new URL(TOKEN_ENDPOINT).origin, GATEWAY_ORIGIN);
  assert.equal(new URL(MCP_ENDPOINT).origin, GATEWAY_ORIGIN);
});
