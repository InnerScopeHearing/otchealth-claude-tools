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
