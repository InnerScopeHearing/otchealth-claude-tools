#!/usr/bin/env node
// Owner-consented Developer OAuth session for direct, native MCP SDK calls.
// No AWS credentials, client secret, endpoint override, or token output is used here.
import { createHash, randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, parse, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  chmod, lstat, mkdir, open, readFile, readdir, rename, rmdir,
} from 'node:fs/promises';

export const GATEWAY_ORIGIN = 'https://mcp.otchealth.app';
export const MCP_ENDPOINT = `${GATEWAY_ORIGIN}/mcp`;
export const REGISTER_ENDPOINT = `${GATEWAY_ORIGIN}/register`;
export const AUTHORIZE_ENDPOINT = `${GATEWAY_ORIGIN}/oauth/authorize`;
export const CONSENT_ENDPOINT = `${GATEWAY_ORIGIN}/oauth/authorize/consent`;
export const TOKEN_ENDPOINT = `${GATEWAY_ORIGIN}/oauth/token`;
export const SESSION_FILE = 'session.json';
const EXPIRY_SKEW_MS = 60_000;
const OAUTH_BODY_LIMIT = 32 * 1024;
const MCP_BODY_LIMIT = 4 * 1024 * 1024;
const SENSITIVE_FIELD = /^(?:access[_-]?token|refresh[_-]?token|client[_-]?secret|setup[_-]?code|code[_-]?verifier)$/i;

export const DEFAULT_SESSION_DIR = join(homedir(), '.local', 'share', 'otchealth', 'developer-cloud-session');

function safeError(message) {
  return new Error(message);
}

function safeStatus(status) {
  return Number.isInteger(status) ? ` (HTTP ${status})` : '';
}

async function fetchSafe(fetchImpl, url, options, label) {
  try {
    return await fetchImpl(url, { signal: AbortSignal.timeout(15_000), ...options });
  } catch {
    throw safeError(`${label} failed before receiving a response.`);
  }
}

async function responseTextLimited(response, limit, label) {
  if (!response.body?.getReader) throw safeError(`${label} returned an empty response.`);
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw safeError(`${label} response exceeded the size limit.`);
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    if (error instanceof Error && /response exceeded/.test(error.message)) throw error;
    throw safeError(`${label} response could not be read.`);
  }
  return Buffer.concat(chunks, size).toString('utf8');
}

async function readJsonResponse(response, label) {
  if (!response.ok) throw safeError(`${label} failed${safeStatus(response.status)}.`);
  try {
    return JSON.parse(await responseTextLimited(response, OAUTH_BODY_LIMIT, label));
  } catch {
    throw safeError(`${label} returned an invalid response.`);
  }
}

function formBody(fields) {
  return new URLSearchParams(fields).toString();
}

export function createPkce(randomBytesImpl = randomBytes) {
  const verifier = randomBytesImpl(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function nonce(randomBytesImpl = randomBytes) {
  return randomBytesImpl(32).toString('base64url');
}

function parseAccessClaims(token) {
  if (typeof token !== 'string' || token.length > 16_384) throw safeError('OAuth returned an invalid access token.');
  const parts = token.split('.');
  if (parts.length !== 3) throw safeError('OAuth returned an invalid access token.');
  try {
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (!claims || typeof claims !== 'object') throw new Error();
    return claims;
  } catch {
    throw safeError('OAuth returned an invalid access token.');
  }
}

function validateTokenResponse(body, expectedGrant, { requireRefresh = true, expectedClientId } = {}) {
  if (!body || typeof body !== 'object' || body.token_type !== 'Bearer' || typeof body.access_token !== 'string') {
    throw safeError('OAuth returned an incomplete token response.');
  }
  const expiresIn = Number(body.expires_in);
  if (!Number.isFinite(expiresIn) || expiresIn < 1 || expiresIn > 86_400) {
    throw safeError('OAuth returned an invalid token lifetime.');
  }
  if (requireRefresh && (typeof body.refresh_token !== 'string' || body.refresh_token.length < 20)) {
    throw safeError('OAuth did not return a renewable session.');
  }
  const claims = parseAccessClaims(body.access_token);
  if (claims.agent !== 'developer' || claims.gty !== expectedGrant || claims.typ !== 'access' || claims.cs !== true ||
      (expectedClientId && claims.sub !== expectedClientId)) {
    throw safeError('OAuth session identity did not match the requested Developer lane.');
  }
  if (!Number.isFinite(Number(claims.exp)) || Number(claims.exp) * 1000 <= Date.now()) {
    throw safeError('OAuth returned an expired access token.');
  }
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt: new Date(Math.min(Date.now() + expiresIn * 1000, Number(claims.exp) * 1000)).toISOString(),
  };
}

export function exactLoopbackCallbackUrl(rawUrl, redirectUri, expectedState) {
  let callback;
  let expected;
  try {
    callback = new URL(rawUrl, redirectUri);
    expected = new URL(redirectUri);
  } catch {
    throw safeError('OAuth callback was invalid.');
  }
  if (expected.protocol !== 'http:' || expected.hostname !== '127.0.0.1' || expected.pathname !== '/oauth/callback' ||
      callback.origin !== expected.origin || callback.pathname !== expected.pathname || callback.hash || callback.username || callback.password) {
    throw safeError('OAuth callback did not match the registered loopback URI.');
  }
  const state = callback.searchParams.getAll('state');
  const codes = callback.searchParams.getAll('code');
  if (state.length !== 1 || state[0] !== expectedState || codes.length !== 1 || !codes[0]) {
    throw safeError('OAuth callback state or authorization code was invalid.');
  }
  if ([...callback.searchParams.keys()].some((key) => !['state', 'code'].includes(key))) {
    throw safeError('OAuth callback contained unexpected parameters.');
  }
  return codes[0];
}

function makeLoopbackRedirectUri(randomBytesImpl = randomBytes) {
  const port = 49_152 + (randomBytesImpl(2).readUInt16BE(0) % 16_384);
  return `http://127.0.0.1:${port}/oauth/callback`;
}

function parseMcpEnvelope(text) {
  try {
    return JSON.parse(text);
  } catch {
    // MCP Streamable HTTP may use server-sent events. Use the last valid data frame.
    const frames = String(text).split(/\r?\n/).filter((line) => line.startsWith('data:'));
    for (let index = frames.length - 1; index >= 0; index -= 1) {
      try { return JSON.parse(frames[index].slice(5).trim()); } catch { /* try earlier frame */ }
    }
    throw safeError('Gateway returned an invalid MCP response.');
  }
}

async function gatewayRpc(accessToken, method, params, fetchImpl = fetch) {
  const response = await fetchSafe(fetchImpl, MCP_ENDPOINT, {
    method: 'POST',
    redirect: 'error',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!response.ok) throw safeError(`Gateway ${method} request failed${safeStatus(response.status)}.`);
  const envelope = parseMcpEnvelope(await responseTextLimited(response, MCP_BODY_LIMIT, `Gateway ${method}`));
  if (envelope.error) throw safeError(`Gateway ${method} request failed.`);
  if (!envelope.result || typeof envelope.result !== 'object') throw safeError(`Gateway ${method} returned no result.`);
  return envelope.result;
}

function findRequestContext(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return null;
  seen.add(value);
  if (value.request_context && typeof value.request_context === 'object') return value.request_context;
  for (const child of Object.values(value)) {
    const found = findRequestContext(child, seen);
    if (found) return found;
  }
  return null;
}

async function verifyDeveloperBearer(accessToken, fetchImpl) {
  const result = await gatewayRpc(accessToken, 'tools/call', {
    name: 'catalog_probe',
    arguments: { include_cto_workspace: false },
  }, fetchImpl);
  if (result.isError) throw safeError('Gateway identity probe failed.');
  const context = findRequestContext(result.structuredContent ?? result);
  if (context?.caller_agent !== 'developer' || context?.is_m365_static_auth !== false || context?.is_connector_surface !== true) {
    throw safeError('Gateway identity probe did not confirm the Developer connector session.');
  }
  return {
    agent: context.caller_agent,
    connectorSurface: context.is_connector_surface,
    m365StaticAuth: context.is_m365_static_auth,
  };
}

function isCredentialKey(key) {
  return SENSITIVE_FIELD.test(String(key)) || /^(?:authorization|bearer)$/i.test(String(key));
}

export function redactCredentialFields(value, credentialValues = []) {
  if (typeof value === 'string') {
    let safe = value;
    for (const secret of credentialValues) {
      if (typeof secret === 'string' && secret.length >= 8) safe = safe.split(secret).join('[REDACTED]');
    }
    return safe.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]');
  }
  if (Array.isArray(value)) return value.map((item) => redactCredentialFields(item, credentialValues));
  if (value && typeof value === 'object') {
    const safe = {};
    for (const [key, child] of Object.entries(value)) {
      if (!isCredentialKey(key)) safe[key] = redactCredentialFields(child, credentialValues);
    }
    return safe;
  }
  return value;
}

function validateSessionPath(pathValue) {
  const target = resolve(pathValue || DEFAULT_SESSION_DIR);
  const segments = target.split(sep).filter(Boolean);
  if (segments.some((segment) => segment.toLowerCase() === 'brain' || segment === '.git' || segment === '.claude')) {
    throw safeError('Session directory must be outside Git metadata, Brain, and agent-runtime directories.');
  }
  return target;
}

async function assertNoSymlinkAncestors(pathValue, includeLeaf = true) {
  const absolute = resolve(pathValue);
  const root = parse(absolute).root;
  const remainder = absolute.slice(root.length).split(sep).filter(Boolean);
  let current = root;
  const stopAt = includeLeaf ? remainder.length : Math.max(0, remainder.length - 1);
  for (let index = 0; index < stopAt; index += 1) {
    current = join(current, remainder[index]);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw safeError('Session path may not contain symbolic links.');
      if (!info.isDirectory()) throw safeError('Session path components must be directories.');
    } catch (error) {
      if (error?.code === 'ENOENT') break;
      throw error;
    }
  }
}

async function rejectGitOrBrainAncestor(pathValue) {
  let current = resolve(pathValue);
  for (;;) {
    try {
      const entries = await (await import('node:fs/promises')).readdir(current);
      if (entries.includes('.git')) throw safeError('Session directory must be outside a Git working tree.');
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

async function ensurePrivateDirectory(sessionDir, { createExclusive = false } = {}) {
  await assertNoSymlinkAncestors(sessionDir, false);
  await rejectGitOrBrainAncestor(dirname(sessionDir));
  if (createExclusive) {
    await mkdir(dirname(sessionDir), { recursive: true, mode: 0o700 });
    await assertNoSymlinkAncestors(sessionDir, false);
    try {
      await mkdir(sessionDir, { mode: 0o700 });
    } catch (error) {
      if (error?.code === 'EEXIST') throw safeError('A Developer session already exists at this path.');
      throw safeError('Could not create the private session directory.');
    }
  }
  const directoryInfo = await lstat(sessionDir).catch(() => null);
  if (!directoryInfo || !directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
    throw safeError('Private session directory is unavailable.');
  }
  if ((directoryInfo.mode & 0o077) !== 0) throw safeError('Session directory permissions must be owner-only (0700).');
  if (typeof process.getuid === 'function' && directoryInfo.uid !== process.getuid()) {
    throw safeError('Session directory must be owned by the current user.');
  }
  await rejectGitOrBrainAncestor(sessionDir);
  return sessionDir;
}

function sessionFilePath(sessionDir) {
  return join(sessionDir, SESSION_FILE);
}

async function readSession(sessionDir) {
  const directory = validateSessionPath(sessionDir);
  await ensurePrivateDirectory(directory);
  const file = sessionFilePath(directory);
  const info = await lstat(file).catch(() => null);
  if (!info || !info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (info.mode & 0o077) !== 0) {
    throw safeError('Private Developer session file is missing or has unsafe permissions.');
  }
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) throw safeError('Session file must be owned by the current user.');
  let session;
  try { session = JSON.parse(await readFile(file, 'utf8')); } catch { throw safeError('Private Developer session file is invalid.'); }
  if (session?.version !== 1 || typeof session.clientId !== 'string' || !session.clientId.startsWith('dcr_') ||
      typeof session.accessToken !== 'string' || typeof session.refreshToken !== 'string' ||
      session.refreshToken.length < 20 || typeof session.expiresAt !== 'string' || session.agent !== 'developer' ||
      !['authorization_code', 'refresh_token'].includes(session.grantType)) {
    throw safeError('Private Developer session file is incomplete.');
  }
  const claims = parseAccessClaims(session.accessToken);
  const expiresAt = Date.parse(session.expiresAt);
  if (claims.agent !== 'developer' || claims.typ !== 'access' || claims.cs !== true ||
      claims.gty !== session.grantType || claims.sub !== session.clientId ||
      !Number.isFinite(Number(claims.exp)) || !Number.isFinite(expiresAt) ||
      expiresAt > Number(claims.exp) * 1000) {
    throw safeError('Cached OAuth session identity did not match the Developer client and grant.');
  }
  return { directory, session };
}

async function writeSessionExclusive(sessionDir, session) {
  const file = sessionFilePath(sessionDir);
  const handle = await open(file, 'wx', 0o600).catch((error) => {
    if (error?.code === 'EEXIST') throw safeError('A Developer session already exists at this path.');
    throw safeError('Could not create the private Developer session file.');
  });
  try {
    await handle.writeFile(`${JSON.stringify(session, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(file, 0o600);
}

async function replaceSession(sessionDir, session) {
  const name = `.session-${randomBytes(10).toString('hex')}.tmp`;
  const temp = join(sessionDir, name);
  const handle = await open(temp, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(session, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(temp, 0o600);
  await rename(temp, sessionFilePath(sessionDir));
}

async function postToken(fields, fetchImpl) {
  const response = await fetchSafe(fetchImpl, TOKEN_ENDPOINT, {
    method: 'POST',
    redirect: 'error',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: formBody(fields),
  });
  return readJsonResponse(response, 'OAuth token exchange');
}

async function registerPublicClient(redirectUri, fetchImpl) {
  const response = await fetchSafe(fetchImpl, REGISTER_ENDPOINT, {
    method: 'POST',
    redirect: 'error',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      redirect_uris: [redirectUri],
      application_type: 'native',
      client_name: 'OTCHealth Developer Cloud SDK',
    }),
  });
  const body = await readJsonResponse(response, 'Gateway client registration');
  if (typeof body.client_id !== 'string' || !/^dcr_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(body.client_id) ||
      body.token_endpoint_auth_method !== 'none' || !Array.isArray(body.redirect_uris) ||
      body.redirect_uris.length !== 1 || body.redirect_uris[0] !== redirectUri) {
    throw safeError('Gateway returned invalid public-client registration metadata.');
  }
  return body.client_id;
}

function buildAuthorizationUrl({ clientId, redirectUri, state, challenge }) {
  const url = new URL(AUTHORIZE_ENDPOINT);
  url.search = formBody({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'mcp',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  return url.toString();
}

function parsePendingId(html) {
  if (typeof html !== 'string' || html.length > OAUTH_BODY_LIMIT) throw safeError('Gateway authorization page was invalid.');
  const matches = [...html.matchAll(/<input\b(?=[^>]*\btype=["']hidden["'])(?=[^>]*\bname=["']pending_id["'])[^>]*\bvalue=["']([a-f0-9]{32})["'][^>]*>/gi)];
  if (matches.length !== 1) throw safeError('Gateway authorization page did not contain one valid pending request.');
  return matches[0][1];
}

async function requestOwnerConsent({ authorizationUrl, setupCode, fetchImpl }) {
  const authorize = await fetchSafe(fetchImpl, authorizationUrl, {
    method: 'GET', redirect: 'manual', headers: { accept: 'text/html' },
  }, 'Gateway authorization request');
  if (authorize.status !== 200) throw safeError(`Gateway authorization request failed${safeStatus(authorize.status)}.`);
  const pendingId = parsePendingId(await responseTextLimited(authorize, OAUTH_BODY_LIMIT, 'Gateway authorization page'));
  const authUrl = new URL(authorizationUrl);
  const state = authUrl.searchParams.get('state');
  const redirectUri = authUrl.searchParams.get('redirect_uri');
  if (!state || !redirectUri) throw safeError('OAuth state or loopback callback was missing.');

  // The owner code comes from stdin and is submitted once to the gateway's consent endpoint.
  const consent = await fetchSafe(fetchImpl, CONSENT_ENDPOINT, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html' },
    body: formBody({ pending_id: pendingId, action: 'elevate', code: setupCode }),
  }, 'Gateway owner-consent request');
  if (consent.status !== 302) throw safeError(`Owner consent was not accepted${safeStatus(consent.status)}. The setup code was submitted once; do not retry this authorization request.`);
  const location = consent.headers.get('location');
  if (!location) throw safeError('Gateway consent response did not include an authorization redirect.');
  return { authCode: exactLoopbackCallbackUrl(location, redirectUri, state), redirectUri };
}

async function exchangeAuthorizationCode(clientId, redirectUri, authCode, verifier, fetchImpl) {
  const response = await fetchSafe(fetchImpl, TOKEN_ENDPOINT, {
    method: 'POST',
    redirect: 'error',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: formBody({
      grant_type: 'authorization_code',
      code: authCode,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: verifier,
    }),
  });
  return readJsonResponse(response, 'OAuth authorization-code exchange');
}

export async function bootstrapSession({
  sessionDir = DEFAULT_SESSION_DIR,
  setupCode,
  fetchImpl = fetch,
  randomBytesImpl = randomBytes,
} = {}) {
  if (typeof setupCode !== 'string' || !/^[0-9A-HJKMNP-TV-Z]{16}$/i.test(setupCode.replace(/[-\s]/g, ''))) {
    throw safeError('Read the owner setup code from stdin; it must be a 16-character setup code.');
  }
  const directory = validateSessionPath(sessionDir);
  await ensurePrivateDirectory(directory, { createExclusive: true });
  try {
    const redirectUri = makeLoopbackRedirectUri(randomBytesImpl);
    const pkce = createPkce(randomBytesImpl);
    const state = nonce(randomBytesImpl);
    const clientId = await registerPublicClient(redirectUri, fetchImpl);
    const authorizationUrl = buildAuthorizationUrl({ clientId, redirectUri, state, challenge: pkce.challenge });
    const { authCode } = await requestOwnerConsent({ authorizationUrl, setupCode, fetchImpl });
    const tokenBody = await exchangeAuthorizationCode(clientId, redirectUri, authCode, pkce.verifier, fetchImpl);
    const tokens = validateTokenResponse(tokenBody, 'authorization_code', { expectedClientId: clientId });
    const verified = await verifyDeveloperBearer(tokens.accessToken, fetchImpl);
    const session = {
      version: 1,
      clientId,
      agent: verified.agent,
      connectorSurface: verified.connectorSurface,
      m365StaticAuth: verified.m365StaticAuth,
      grantType: 'authorization_code',
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      updatedAt: new Date().toISOString(),
    };
    await writeSessionExclusive(directory, session);
    return { agent: 'developer', expiresAt: tokens.expiresAt, connectorSurface: true, m365StaticAuth: false };
  } catch (error) {
    await rmdir(directory).catch(() => {});
    if (error instanceof Error && /^OAuth |^Gateway |^Private |^Session |^A Developer |^Could not |^Read the |^The gateway |^Owner consent/.test(error.message)) throw error;
    throw safeError('Developer OAuth setup failed. No session was saved.');
  }
}

async function refreshSession(sessionDir, session, fetchImpl) {
  const body = await postToken({ grant_type: 'refresh_token', refresh_token: session.refreshToken, client_id: session.clientId }, fetchImpl);
  const tokens = validateTokenResponse(body, 'refresh_token', { expectedClientId: session.clientId });
  const verified = await verifyDeveloperBearer(tokens.accessToken, fetchImpl);
  const next = {
    ...session,
    agent: verified.agent,
    connectorSurface: verified.connectorSurface,
    m365StaticAuth: verified.m365StaticAuth,
    grantType: 'refresh_token',
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
    updatedAt: new Date().toISOString(),
  };
  await replaceSession(sessionDir, next);
  return next;
}

async function getActiveSession(sessionDir, fetchImpl, now = Date.now) {
  const { directory, session } = await readSession(sessionDir);
  if (Date.parse(session.expiresAt) <= now() + EXPIRY_SKEW_MS) {
    return { directory, session: await refreshSession(directory, session, fetchImpl) };
  }
  return { directory, session };
}

export async function sessionStatus({ sessionDir = DEFAULT_SESSION_DIR, fetchImpl = fetch, now = Date.now } = {}) {
  const { session } = await getActiveSession(sessionDir, fetchImpl, now);
  const verified = await verifyDeveloperBearer(session.accessToken, fetchImpl);
  return { status: 'connected', agent: verified.agent, connectorSurface: verified.connectorSurface, m365StaticAuth: verified.m365StaticAuth, expiresAt: session.expiresAt };
}

export async function toolSchema({ sessionDir = DEFAULT_SESSION_DIR, toolName, fetchImpl = fetch, now = Date.now } = {}) {
  if (typeof toolName !== 'string' || !/^[a-z][a-z0-9_]{0,127}$/.test(toolName)) throw safeError('Tool name is invalid.');
  const { session } = await getActiveSession(sessionDir, fetchImpl, now);
  await verifyDeveloperBearer(session.accessToken, fetchImpl);
  const result = await gatewayRpc(session.accessToken, 'tools/list', {}, fetchImpl);
  const tool = result.tools?.find((item) => item.name === toolName);
  if (!tool) throw safeError(`Tool ${toolName} is not available to this Developer connector.`);
  return redactCredentialFields(tool, [session.accessToken, session.refreshToken]);
}

export async function callTool({ sessionDir = DEFAULT_SESSION_DIR, toolName, args = {}, fetchImpl = fetch, now = Date.now } = {}) {
  if (typeof toolName !== 'string' || !/^[a-z][a-z0-9_]{0,127}$/.test(toolName)) throw safeError('Tool name is invalid.');
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw safeError('Tool arguments must be a JSON object.');
  const { session } = await getActiveSession(sessionDir, fetchImpl, now);
  await verifyDeveloperBearer(session.accessToken, fetchImpl);
  const listing = await gatewayRpc(session.accessToken, 'tools/list', {}, fetchImpl);
  if (!listing.tools?.some((item) => item.name === toolName)) throw safeError(`Tool ${toolName} is not available to this Developer connector.`);
  // Exactly one call attempt. An unknown write outcome must be resolved by reading its state, never by retrying.
  const result = await gatewayRpc(session.accessToken, 'tools/call', { name: toolName, arguments: args }, fetchImpl);
  return redactCredentialFields(result, [session.accessToken, session.refreshToken]);
}

function parseCli(argv) {
  const [command, ...rest] = argv;
  const options = { command, sessionDir: DEFAULT_SESSION_DIR };
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (value === '--session-dir') options.sessionDir = rest[++index];
    else if (value === '--args-file') options.argsFile = rest[++index];
    else if (!value.startsWith('-') && !options.toolName && ['schema', 'call'].includes(command)) options.toolName = value;
    else throw safeError('Command arguments are invalid.');
  }
  if (typeof options.sessionDir !== 'string' || !options.sessionDir) throw safeError('Session directory is required.');
  if (command === 'schema' && !options.toolName) throw safeError('schema requires one tool name.');
  if (command === 'call' && (!options.toolName || !options.argsFile)) throw safeError('call requires one tool name and --args-file.');
  if (!['bootstrap', 'status', 'schema', 'call'].includes(command)) throw safeError('Usage: cloud-session.mjs bootstrap|status|schema <tool>|call <tool> --args-file <path> [--session-dir <private-directory>].');
  return options;
}

async function readOneLine(stream) {
  let input = '';
  for await (const chunk of stream) {
    input += chunk;
    const end = input.indexOf('\n');
    if (end >= 0) return input.slice(0, end).trim();
    if (input.length > 4096) throw safeError('stdin input was too long.');
  }
  return input.trim();
}

export async function readSetupCodeFromStdin(stream, stderr) {
  if (!stream.isTTY || typeof stream.setRawMode !== 'function') return readOneLine(stream);
  return new Promise((resolvePromise, rejectPromise) => {
    let input = '';
    const originalRaw = stream.isRaw;
    const finish = (error) => {
      stream.removeListener('data', onData);
      stream.setRawMode(Boolean(originalRaw));
      stream.pause();
      stderr.write('\n');
      if (error) rejectPromise(error);
      else resolvePromise(input.trim());
    };
    const onData = (chunk) => {
      for (const char of String(chunk)) {
        if (char === '\u0003') return finish(safeError('Bootstrap was interrupted.'));
        if (char === '\r' || char === '\n') return finish();
        if (char === '\u007f' || char === '\b') input = input.slice(0, -1);
        else if (input.length < 128) input += char;
      }
    };
    stderr.write('Owner setup code (input hidden): ');
    stream.setRawMode(true);
    stream.resume();
    stream.on('data', onData);
  });
}

function requireEnvironmentProxyMode() {
  const enabled = process.env.NODE_USE_ENV_PROXY === '1' || process.execArgv.includes('--use-env-proxy');
  if (!enabled) throw safeError('Run Node with --use-env-proxy or NODE_USE_ENV_PROXY=1 to use the configured HTTPS proxy.');
}

async function runCli(argv, io = process) {
  const options = parseCli(argv);
  requireEnvironmentProxyMode();
  if (options.command === 'bootstrap') {
    const setupCode = await readSetupCodeFromStdin(io.stdin, io.stderr);
    const outcome = await bootstrapSession({
      sessionDir: options.sessionDir,
      setupCode,
    });
    io.stdout.write(`${JSON.stringify({ status: 'connected', ...outcome })}\n`);
    return;
  }
  if (options.command === 'status') {
    io.stdout.write(`${JSON.stringify(await sessionStatus({ sessionDir: options.sessionDir }))}\n`);
    return;
  }
  if (options.command === 'schema') {
    io.stdout.write(`${JSON.stringify(await toolSchema({ sessionDir: options.sessionDir, toolName: options.toolName }))}\n`);
    return;
  }
  let args;
  try { args = JSON.parse(await readFile(resolve(options.argsFile), 'utf8')); } catch { throw safeError('Arguments file is not valid JSON.'); }
  const result = await callTool({ sessionDir: options.sessionDir, toolName: options.toolName, args });
  io.stdout.write(`${JSON.stringify(result)}\n`);
  if (result?.isError === true) io.exitCode = 1;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  runCli(process.argv.slice(2)).catch((error) => {
    const message = error instanceof Error ? error.message : 'Developer cloud session failed.';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
