#!/usr/bin/env node
// gateway-deep-client.mjs -- thin client for calling the OTCHealth MCP gateway's `brain_search` tool
// in mode:'deep' (agentic multi-round retrieval + synthesized cited answer; see otchealth-mcp-server
// src/tools/kb/brain-search.ts + src/memory/deep-retrieval.ts). Used by run-deep-evals.mjs to build a
// DEEP-MODE-SPECIFIC recall-quality eval -- the existing recall-evals suite (run-evals.mjs) only ever
// exercises the local, non-deep semantic.mjs recall path, so a regression specific to the agentic
// planner/refine/synthesize pipeline would be entirely invisible to it.
//
// Auth: reuses skills/gateway-connect/connect.mjs's mintToken(lane) -- the SAME client_credentials
// lane-token mint every other gateway-calling skill in this repo uses (cfo-gateway, fleet-search,
// gateway-connect itself). No new credential path.
//
// RESPONSE SHAPE PITFALL (ledger-documented, see otchealth-cto/CLAUDE.md's Phase 5/6 session notes):
// gateway MCP tools put their structured, machine-readable result in the JSON-RPC response's
// `result.structuredContent.result` field, NOT in `result.content[0].text` -- that text field is a
// human-readable rendering (JSON.stringify(data) followed by a blank line and a plain-English summary
// sentence, see registry.ts's buildTextContent()), which is NOT valid JSON on its own (the summary
// text trails the JSON blob in the SAME string) and will fail a naive JSON.parse. This file always
// reads structuredContent.result. parseDeepToolResponse() is pure (fixture-testable, no network) so
// this pitfall has a regression test independent of the live gateway.
import { mintToken, GATEWAY_MCP } from '../gateway-connect/connect.mjs';

/**
 * Pure parse of a gateway /mcp JSON-RPC HTTP response body (raw text, as fetch().text() returns it)
 * into either the deep-mode structured result or a clear failure reason. Never throws.
 *
 * Handles: a plain JSON response body (the normal case for this gateway); an SSE-framed body
 * (`data: {...}` lines -- some MCP transports/proxies wrap responses this way; connect.mjs's own
 * verify() already tolerates this, mirrored here for the same robustness); a JSON-RPC `error` object;
 * a tool-level `isError` result; and a response with no structuredContent at all (a genuinely
 * malformed/unexpected shape).
 *
 * @param {string} bodyText - the raw HTTP response body text.
 * @returns {{ok: true, structured: object} | {ok: false, reason: string}}
 */
export function parseDeepToolResponse(bodyText) {
  const text = String(bodyText || '');
  if (!text.trim()) return { ok: false, reason: 'empty response body' };

  let envelope = null;
  try {
    envelope = JSON.parse(text);
  } catch {
    // SSE framing: take the LAST `data: {...}` line (mirrors connect.mjs's verify() parsing).
    for (const line of text.split('\n')) {
      if (!line.startsWith('data:')) continue;
      try { envelope = JSON.parse(line.slice(5)); } catch { /* keep scanning */ }
    }
    if (!envelope) return { ok: false, reason: 'response body is neither plain JSON nor a parseable SSE frame' };
  }

  if (envelope.error) {
    return { ok: false, reason: `JSON-RPC error: ${envelope.error.message || JSON.stringify(envelope.error).slice(0, 200)}` };
  }
  const result = envelope.result;
  if (!result) return { ok: false, reason: 'no result field in the JSON-RPC envelope' };
  if (result.isError) {
    const msg = (result.content && result.content[0] && result.content[0].text) || 'tool reported isError with no text';
    return { ok: false, reason: `tool error: ${String(msg).slice(0, 300)}` };
  }
  const structured = result.structuredContent && result.structuredContent.result;
  if (!structured || typeof structured !== 'object') {
    return { ok: false, reason: 'no structuredContent.result in the tool response (unexpected shape)' };
  }
  return { ok: true, structured };
}

/**
 * Call the gateway's brain_search tool in mode:'deep' for one query. Network I/O; wraps
 * parseDeepToolResponse() (the pure/testable half) around a single fetch. Never throws -- any
 * transport failure degrades to a `{ok: false}` result the caller can score as a miss, exactly like
 * run-evals.mjs's runRecall() already does for the local recall path.
 * @param {string} token - a minted gateway bearer token (see mintToken()).
 * @param {string} query
 * @param {{top?: number, includeOps?: boolean, timeoutMs?: number}} [opts]
 * @returns {Promise<{ok: boolean, structured: object|null, reason: string|null, latencyMs: number, httpStatus: number|null}>}
 */
export async function callDeepBrainSearch(token, query, opts = {}) {
  const top = opts.top ?? 8;
  const timeoutMs = opts.timeoutMs ?? 45000;
  const started = Date.now();
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const body = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'brain_search', arguments: { query, mode: 'deep', top } } };
    const r = await fetch(GATEWAY_MCP, {
      method: 'POST',
      signal: ac.signal,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    const latencyMs = Date.now() - started;
    const parsed = parseDeepToolResponse(text);
    if (!parsed.ok) return { ok: false, structured: null, reason: parsed.reason, latencyMs, httpStatus: r.status };
    return { ok: true, structured: parsed.structured, reason: null, latencyMs, httpStatus: r.status };
  } catch (e) {
    return { ok: false, structured: null, reason: String((e && e.message) || e), latencyMs: Date.now() - started, httpStatus: null };
  } finally {
    clearTimeout(to);
  }
}

export { mintToken };
