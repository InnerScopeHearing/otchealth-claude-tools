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

test('azureEnvPresent + credSource: Key Vault when SP env is set, GCP fallback otherwise', () => {
  const save = { id: process.env.AZURE_SP_CLIENT_ID, sec: process.env.AZURE_SP_CLIENT_SECRET, tn: process.env.AZURE_SP_TENANT_ID };
  delete process.env.AZURE_SP_CLIENT_ID; delete process.env.AZURE_SP_CLIENT_SECRET; delete process.env.AZURE_SP_TENANT_ID;
  assert.equal(azureEnvPresent(), false);
  assert.equal(credSource(), 'gcp-secret-manager');
  process.env.AZURE_SP_CLIENT_ID = 'x'; process.env.AZURE_SP_CLIENT_SECRET = 'y'; process.env.AZURE_SP_TENANT_ID = 'z';
  assert.equal(azureEnvPresent(), true);
  assert.match(credSource(), /^azure-keyvault:/);
  // restore
  if (save.id !== undefined) process.env.AZURE_SP_CLIENT_ID = save.id; else delete process.env.AZURE_SP_CLIENT_ID;
  if (save.sec !== undefined) process.env.AZURE_SP_CLIENT_SECRET = save.sec; else delete process.env.AZURE_SP_CLIENT_SECRET;
  if (save.tn !== undefined) process.env.AZURE_SP_TENANT_ID = save.tn; else delete process.env.AZURE_SP_TENANT_ID;
});
