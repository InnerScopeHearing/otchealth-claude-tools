// gateway-ledger.mjs -- the REAL (network) transport for skills/task-claim: calls the gateway's
// EXISTING agent-state work-ledger tools (task_create / task_claim / task_update / task_heartbeat /
// task_get) over the gateway's MCP HTTP API, using the SAME client_credentials lane-bearer pattern
// every other gateway-calling skill in this toolkit uses (skills/gateway-connect, skills/cfo-gateway). This
// file does NOT talk to Cosmos directly and does NOT reimplement the ledger's claim/lease/fencing
// logic -- all of that logic lives server-side in otchealth-mcp-server's src/agentstate/ledger.ts;
// this is a thin, typed RPC client over it. mutex.mjs (the pure claim/release orchestration) is
// transport-agnostic and takes any object shaped like the LedgerClient this file returns -- tests
// inject a hermetic mock instead of this file, so no live gateway/network access is required to
// prove the mutex semantics (see tests/mock-ledger.mjs + tests/task-claim*.test.mjs).
import { mintToken, GATEWAY_MCP } from '../gateway-connect/connect.mjs';

/**
 * Parse a gateway /mcp tools/call HTTP response body (plain JSON, or an SSE `data: {...}` frame)
 * into its `structuredContent.result` payload -- the exact `data` object each tool's handler
 * returned (see otchealth-mcp-server src/tools/registry.ts registerTool(): every tool response is
 * wrapped as `{ content, structuredContent: { result, compliance_warning, correlation_id, dry_run,
 * error? } }`, isError:true on the outer content when the handler threw). Pure string-in,
 * object-out -- no network, so it is directly unit-testable against fixture response bodies.
 */
export function parseToolResult(rawText) {
  let j;
  try {
    j = JSON.parse(rawText);
  } catch {
    const m = rawText.match(/data:\s*(\{[\s\S]*\})\s*$/m);
    if (!m) throw new Error(`gateway /mcp: could not parse response body: ${rawText.slice(0, 200)}`);
    j = JSON.parse(m[1]);
  }
  if (j.error) {
    throw new Error(`gateway /mcp JSON-RPC error: ${j.error.message || JSON.stringify(j.error)}`);
  }
  const result = j.result;
  if (!result) throw new Error(`gateway /mcp: no result in response: ${rawText.slice(0, 200)}`);
  const sc = result.structuredContent;
  if (result.isError) {
    const msg = sc?.error?.message || result.content?.[0]?.text || 'tool call failed';
    throw new Error(`gateway tool call error: ${msg}`);
  }
  if (sc && Object.prototype.hasOwnProperty.call(sc, 'result')) return sc.result;
  // Fallback for a transport that only surfaced the text content block: registerTool's text block
  // always leads with the JSON-stringified `data` payload (buildTextContent), so parse that.
  const text = result.content?.[0]?.text;
  if (text) {
    try {
      return JSON.parse(text);
    } catch {
      return { text };
    }
  }
  return result;
}

class GatewayLedger {
  constructor({ lane = 'cto', fetchImpl = fetch } = {}) {
    this.lane = lane;
    this.fetchImpl = fetchImpl;
    this._bearer = null;
    this._bearerExpiresAt = 0;
  }

  async _token() {
    const now = Date.now();
    // Re-mint 60s before actual expiry (the same skew margin gateway-connect.mjs uses for --watch).
    if (this._bearer && this._bearerExpiresAt - now > 60_000) return this._bearer;
    const { token, expiresIn } = await mintToken(this.lane);
    this._bearer = token;
    this._bearerExpiresAt = now + expiresIn * 1000;
    return this._bearer;
  }

  async _call(name, args) {
    const bearer = await this._token();
    const body = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } };
    const r = await this.fetchImpl(GATEWAY_MCP, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${bearer}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`gateway /mcp ${name} -> HTTP ${r.status}: ${text.slice(0, 300)}`);
    return parseToolResult(text);
  }

  // Every write call is forced dry_run:false -- this module's whole purpose is to actually perform
  // the claim/release/heartbeat, never to preview it. A caller that wants a preview should call the
  // gateway tool directly (or add a --dry-run passthrough at the CLI layer, not here).
  create(input) {
    return this._call('task_create', { ...input, dry_run: false });
  }
  claim(input) {
    return this._call('task_claim', { ...input, dry_run: false });
  }
  update(input) {
    return this._call('task_update', { ...input, dry_run: false });
  }
  heartbeat(input) {
    return this._call('task_heartbeat', { ...input, dry_run: false });
  }
  get(input) {
    return this._call('task_get', input);
  }
}

export function createGatewayLedger(opts) {
  return new GatewayLedger(opts);
}

export default { createGatewayLedger, parseToolResult };
