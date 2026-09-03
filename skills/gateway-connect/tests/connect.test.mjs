// Tests for gateway-connect pure helpers + the ring-safe LANES registry. Offline: no network, no claude CLI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LANES, parseTokenResponse, buildAddArgs, laneClaim, GATEWAY_MCP } from '../connect.mjs';

test('LANES registry: every lane references ONLY its own lane creds (ring-safe) + distinct', () => {
  assert.ok(LANES.clo && LANES.cfo, 'clo + cfo lanes present');
  for (const [lane, cfg] of Object.entries(LANES)) {
    for (const f of ['idSecret', 'secretSecret', 'mcpName']) assert.ok(typeof cfg[f] === 'string' && cfg[f], `${lane}.${f}`);
    // the lane's secret names must be scoped to that lane (no cross-lane creds)
    assert.ok(cfg.idSecret.includes(lane) && cfg.secretSecret.includes(lane), `${lane} must use oauth-lane-${lane}-* creds`);
  }
});

test('parseTokenResponse: extracts token + expiry, throws safely (no secret leak) on bad input', () => {
  const ok = parseTokenResponse({ access_token: 'abc.def.ghi', expires_in: 3600 });
  assert.equal(ok.token, 'abc.def.ghi');
  assert.equal(ok.expiresIn, 3600);
  assert.equal(parseTokenResponse({ access_token: 'x' }).expiresIn, 3600); // default expiry
  assert.throws(() => parseTokenResponse({ error: 'invalid_client' }), /no access_token/);
  assert.throws(() => parseTokenResponse(null), /non-JSON/);
});

test('buildAddArgs: correct claude mcp add argv shape for the gateway', () => {
  const a = buildAddArgs('otchealth-gateway', GATEWAY_MCP, 'TOK');
  assert.deepEqual(a, ['mcp', 'add', '--transport', 'http', 'otchealth-gateway', GATEWAY_MCP, '--header', 'Authorization: Bearer TOK']);
  assert.match(GATEWAY_MCP, /^https:\/\/mcp\.otchealth\.app\/mcp$/);
});

test('laneClaim: decodes the agent claim from a JWT payload, null on garbage', () => {
  const payload = Buffer.from(JSON.stringify({ agent: 'clo' })).toString('base64url');
  assert.equal(laneClaim(`h.${payload}.s`), 'clo');
  assert.equal(laneClaim('not-a-jwt'), null);
});

import { hasLane } from '../connect.mjs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

test('hasLane: true for known lanes, false otherwise (onboarding no-op gate)', () => {
  assert.equal(hasLane('clo'), true);
  assert.equal(hasLane('cfo'), true);
  // NOTE (2026-07-10): this used to assert hasLane('cto') === false, but the LANES registry in
  // connect.mjs now carries a real 'cto' entry (oauth-lane-cto-id/secret) -- that assumption is
  // stale and was failing this suite (and therefore the repo's required CI check) for every PR,
  // unrelated to their own content.
  // NOTE (2026-07-21): coo + cro were onboarded onto the gateway (oauth-lane-coo-*/oauth-lane-cro-*),
  // so both now resolve to real lanes too. 'nope' is the correct known-laneless placeholder going
  // forward (it names no real agent, so it can't go stale the way 'coo' did).
  assert.equal(hasLane('coo'), true);
  assert.equal(hasLane('cro'), true);
  assert.equal(hasLane('nope'), false);
});

test('CLI --if-lane on a laneless agent exits 0 and does nothing (no network, no register)', () => {
  const runMjs = join(dirname(fileURLToPath(import.meta.url)), '..', 'connect.mjs');
  const out = execFileSync('node', [runMjs, 'nope', '--if-lane'], { encoding: 'utf8' }); // exit 0, prints skip
  assert.match(out, /no gateway lane for "nope"; skipping/);
});

import { azureEnvPresent, credSource } from '../connect.mjs';

// ---- laneCreds() failure message (2026-08-18, the agent-seat credential bootstrap fix) -----------
// laneCreds() is not exported (internal), so this exercises it through the public mintToken() entry
// point -- the same call path a real `gateway-connect` invocation takes. With every credential store
// (Azure, AWS, GCP) unreachable, laneCreds() must name the REAL fix (OTC_AWS_*) rather than blaming
// "GCP fallback failed" as if GCP Secret Manager were still a live option (it is fully retired).
{
  const { mintToken } = await import('../connect.mjs');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  test('mintToken(): with no Azure, AWS, or GCP creds resolvable, the error names OTC_AWS_* -- not a "GCP fallback failed" red herring', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gwconnect-credboot-test-'));
    const savedHome = process.env.HOME;
    const savedVars = {};
    const CLEAR = [
      'AZURE_SP_CLIENT_ID', 'AZURE_SP_CLIENT_SECRET', 'AZURE_SP_TENANT_ID',
      'IDENTITY_ENDPOINT', 'IDENTITY_HEADER',
      'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI', 'AWS_CONTAINER_CREDENTIALS_FULL_URI',
      'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN',
      'OTC_AWS_ACCESS_KEY_ID', 'OTC_AWS_SECRET_ACCESS_KEY', 'OTC_AWS_SESSION_TOKEN',
      'GCP_CLAUDE_DRIVER_SA_JSON',
    ];
    for (const k of CLEAR) { savedVars[k] = process.env[k]; delete process.env[k]; }
    process.env.HOME = dir; // no ~/.gcp_claude_driver_sa.json can exist here
    try {
      await assert.rejects(
        () => mintToken('cfo'),
        (e) => {
          assert.match(e.message, /OTC_AWS_ACCESS_KEY_ID \+ OTC_AWS_SECRET_ACCESS_KEY/, 'must name the actual fix');
          assert.match(e.message, /AWS SSM fallback/i, 'must acknowledge SSM was already tried, not just Key Vault');
          assert.match(e.message, /GCP Secret Manager is retired/, 'must not imply GCP is a live fallback option');
          return true;
        },
      );
    } finally {
      process.env.HOME = savedHome;
      for (const k of CLEAR) { if (savedVars[k] === undefined) delete process.env[k]; else process.env[k] = savedVars[k]; }
      // maxRetries/retryDelay (2026-08-29): mintToken's Azure leg can leave an async token-cache
      // write into this fake HOME's .azure/ still in flight when the rejection settles, so a plain
      // rm() can hit ENOTEMPTY mid-walk (a file lands between readdir and rmdir). Observed twice in
      // CI on UNRELATED PRs (#484 2026-08-28, #492 2026-08-29), each cleared by a re-run -- a
      // classic transient. Node's rm() retries exactly this error class (EBUSY/ENOTEMPTY/EPERM/...)
      // when maxRetries is set, which absorbs the race without masking a real failure: a directory
      // that STAYS non-removable for the full retry window still throws.
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
}

test('azureEnvPresent + credSource: label mirrors kvSecret backend (SSM default), never names retired GCP as live', () => {
  const save = { id: process.env.AZURE_SP_CLIENT_ID, sec: process.env.AZURE_SP_CLIENT_SECRET, tn: process.env.AZURE_SP_TENANT_ID, be: process.env.SECRET_BACKEND };
  delete process.env.AZURE_SP_CLIENT_ID; delete process.env.AZURE_SP_CLIENT_SECRET; delete process.env.AZURE_SP_TENANT_ID;
  assert.equal(azureEnvPresent(), false);
  // Default (SECRET_BACKEND unset) = the fleet's store of record, AWS SSM. This is the line every
  // prompt logs; it used to say 'gcp-secret-manager' while the read was served by SSM.
  delete process.env.SECRET_BACKEND;
  assert.equal(credSource(), 'aws-ssm:/otchealth');
  process.env.SECRET_BACKEND = 'ssm';
  assert.equal(credSource(), 'aws-ssm:/otchealth');
  // The retired store must never be presented as the live source under any default.
  assert.doesNotMatch(credSource(), /^gcp-secret-manager$/);
  // Azure SP env alone no longer flips the label: the resolver keys off SECRET_BACKEND, not env presence.
  process.env.AZURE_SP_CLIENT_ID = 'x'; process.env.AZURE_SP_CLIENT_SECRET = 'y'; process.env.AZURE_SP_TENANT_ID = 'z';
  assert.equal(azureEnvPresent(), true);
  assert.equal(credSource(), 'aws-ssm:/otchealth');
  // Only an explicit keyvault backend yields the Key Vault label (a hypothetical future vault).
  process.env.SECRET_BACKEND = 'keyvault';
  assert.equal(credSource(), 'azure-keyvault');
  if (save.be !== undefined) process.env.SECRET_BACKEND = save.be; else delete process.env.SECRET_BACKEND;
  // restore
  if (save.id !== undefined) process.env.AZURE_SP_CLIENT_ID = save.id; else delete process.env.AZURE_SP_CLIENT_ID;
  if (save.sec !== undefined) process.env.AZURE_SP_CLIENT_SECRET = save.sec; else delete process.env.AZURE_SP_CLIENT_SECRET;
  if (save.tn !== undefined) process.env.AZURE_SP_TENANT_ID = save.tn; else delete process.env.AZURE_SP_TENANT_ID;
});

// credSource() is printed on EVERY prompt by the UserPromptSubmit hook, so its output must be a
// small closed set of literals rather than anything derived from the environment. An earlier draft
// interpolated AZURE_KEYVAULT_NAME and the raw SECRET_BACKEND value into the label; CodeQL flagged
// it as process environment reaching a log (js/clear-text-logging, alert 93 on PR #506). Those
// particular values are non-secret identifiers, but nothing in the function enforced that, and a
// line logged on every prompt is the worst place to find out otherwise. This pins the invariant.
test('credSource: returns a fixed literal from a closed set, never an interpolated env value', () => {
  const save = {
    be: process.env.SECRET_BACKEND, kv: process.env.AZURE_KEYVAULT_NAME,
    id: process.env.AZURE_SP_CLIENT_ID, sec: process.env.AZURE_SP_CLIENT_SECRET, tn: process.env.AZURE_SP_TENANT_ID,
  };
  const ALLOWED = new Set([
    'aws-ssm:/otchealth',
    'azure-keyvault',
    'azure-keyvault(no-sp-env)',
    'gcp-secret-manager(retired fallback)',
    'other(via kvSecret; gcp-secret-manager is a retired last-resort fallback)',
  ]);
  // A value an attacker (or a misconfiguration) could plant in the environment must never appear.
  const CANARY = 'CANARY-secret-value-must-not-be-logged';
  process.env.AZURE_KEYVAULT_NAME = CANARY;
  for (const backend of ['ssm', 'keyvault', 'gcp', 'gcp-secret-manager', CANARY, '']) {
    if (backend === '') delete process.env.SECRET_BACKEND; else process.env.SECRET_BACKEND = backend;
    for (const withSp of [false, true]) {
      if (withSp) { process.env.AZURE_SP_CLIENT_ID = 'x'; process.env.AZURE_SP_CLIENT_SECRET = 'y'; process.env.AZURE_SP_TENANT_ID = 'z'; }
      else { delete process.env.AZURE_SP_CLIENT_ID; delete process.env.AZURE_SP_CLIENT_SECRET; delete process.env.AZURE_SP_TENANT_ID; }
      const out = credSource();
      assert.ok(ALLOWED.has(out), `credSource() returned an unlisted label: ${JSON.stringify(out)}`);
      assert.doesNotMatch(out, new RegExp(CANARY), 'no environment value may reach the label');
    }
  }
  for (const [k, v] of Object.entries({ SECRET_BACKEND: save.be, AZURE_KEYVAULT_NAME: save.kv, AZURE_SP_CLIENT_ID: save.id, AZURE_SP_CLIENT_SECRET: save.sec, AZURE_SP_TENANT_ID: save.tn })) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

// ---- headersHelper registration (2026-09-03): Claude Code's dynamic MCP-headers mechanism --------
// register() itself is not exported (it shells out to the real `claude` CLI, which tests must never
// invoke), so these exercise the pure argv-building functions it is built from -- buildAddJsonArgs()
// directly, and buildRegisterArgs() (the exact env-dependent decision register() makes) via the
// GATEWAY_CONNECT_HEADERS_HELPER rollback switch. No network, no SSM, no `claude` process spawned.
import { buildAddJsonArgs, buildRegisterArgs, headersHelperEnabled, HEADERS_HELPER_PATH } from '../connect.mjs';

function withEnv(name, value, fn) {
  const saved = process.env[name];
  if (value === undefined) delete process.env[name]; else process.env[name] = value;
  try { return fn(); } finally {
    if (saved === undefined) delete process.env[name]; else process.env[name] = saved;
  }
}

test('HEADERS_HELPER_PATH: an absolute path to headers-helper.mjs alongside connect.mjs', () => {
  assert.ok(HEADERS_HELPER_PATH.startsWith('/'), 'must be absolute (Claude Code executes it directly)');
  assert.ok(HEADERS_HELPER_PATH.endsWith('/gateway-connect/headers-helper.mjs'));
});

test('headersHelperEnabled: enabled by default and for any value except the literal string "0"', () => {
  withEnv('GATEWAY_CONNECT_HEADERS_HELPER', undefined, () => assert.equal(headersHelperEnabled(), true, 'unset -> enabled'));
  withEnv('GATEWAY_CONNECT_HEADERS_HELPER', '0', () => assert.equal(headersHelperEnabled(), false, '"0" -> disabled (the rollback switch)'));
  withEnv('GATEWAY_CONNECT_HEADERS_HELPER', 'false', () => assert.equal(headersHelperEnabled(), true, 'only the literal "0" disables it'));
  withEnv('GATEWAY_CONNECT_HEADERS_HELPER', '', () => assert.equal(headersHelperEnabled(), true, 'empty string is not "0"'));
});

test('buildAddJsonArgs: carries a static Authorization header AND the headersHelper field when given a path', () => {
  const argv = buildAddJsonArgs('otchealth-gateway', GATEWAY_MCP, 'TOK', '/abs/path/headers-helper.mjs');
  assert.deepEqual(argv.slice(0, 3), ['mcp', 'add-json', 'otchealth-gateway']);
  const server = JSON.parse(argv[3]);
  assert.deepEqual(server, {
    type: 'http',
    url: GATEWAY_MCP,
    headers: { Authorization: 'Bearer TOK' },
    headersHelper: '/abs/path/headers-helper.mjs',
  });
});

test('buildAddJsonArgs: omits headersHelper entirely (no null/empty field) when no path is given', () => {
  for (const noHelper of [null, undefined, '']) {
    const argv = buildAddJsonArgs('otchealth-gateway', GATEWAY_MCP, 'TOK', noHelper);
    const server = JSON.parse(argv[3]);
    assert.equal(Object.prototype.hasOwnProperty.call(server, 'headersHelper'), false, `no key at all for ${JSON.stringify(noHelper)}`);
    assert.deepEqual(server, { type: 'http', url: GATEWAY_MCP, headers: { Authorization: 'Bearer TOK' } });
  }
});

test('buildRegisterArgs: writes the headersHelper field when the helper is enabled (the default)', () => {
  withEnv('GATEWAY_CONNECT_HEADERS_HELPER', undefined, () => {
    const argv = buildRegisterArgs('otchealth-gateway', GATEWAY_MCP, 'TOK');
    assert.equal(argv[1], 'add-json', 'goes through add-json, not the plain static-header add');
    const server = JSON.parse(argv[3]);
    assert.equal(server.headersHelper, HEADERS_HELPER_PATH);
    assert.equal(server.headers.Authorization, 'Bearer TOK', 'the static header stays as a fallback for the pre-trust-dialog window');
  });
});

test('buildRegisterArgs: omits headersHelper and reverts to plain `mcp add` when GATEWAY_CONNECT_HEADERS_HELPER=0', () => {
  withEnv('GATEWAY_CONNECT_HEADERS_HELPER', '0', () => {
    const argv = buildRegisterArgs('otchealth-gateway', GATEWAY_MCP, 'TOK');
    assert.deepEqual(argv, buildAddArgs('otchealth-gateway', GATEWAY_MCP, 'TOK'), 'byte-identical to the pre-headersHelper registration');
    assert.equal(argv.includes('add-json'), false);
    assert.ok(!JSON.stringify(argv).includes('headersHelper'));
  });
});
