// Unit tests for the deep-mode gateway client's PURE response parser
// (skills/recall-evals/gateway-deep-client.mjs's parseDeepToolResponse). No IO: fixtures only, no
// network call to the live gateway. Fixture shapes mirror what was observed live against
// mcp.otchealth.app during development of this harness (a plain JSON-RPC envelope whose
// content[0].text is JSON.stringify(data) + a trailing human-readable summary line -- NOT valid JSON
// on its own -- with the real structured payload in result.structuredContent.result).
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDeepToolResponse } from "../skills/recall-evals/gateway-deep-client.mjs";

const REAL_DEEP_STRUCTURED = {
  matches: [{ score: 0.0164, source: "memory-exec", text: "Front Door WAF policy names must be alphanumeric only", id: "cto__1" }],
  count: 1,
  mode: "deep-agentic",
  rooms_searched: ["memory-exec", "commons-company-journal"],
  include_ops: false,
  answer: "Front Door WAF policy names must be alphanumeric only [1].",
  citations: [{ n: 1, source: "memory-exec" }],
  sub_queries: ["Front Door WAF alphanumeric hyphens deploy"],
  rounds_used: 1,
};

function envelopeWith(structured) {
  // content[0].text intentionally is JSON + "\n\n" + a plain summary sentence -- NOT parseable JSON on
  // its own -- exactly what registry.ts's buildTextContent() produces. This is why the parser must use
  // structuredContent.result, never content[0].text. structuredContent itself is the registry's own
  // wrapper ({result, compliance_warning, correlation_id, dry_run, ...}), matching the REAL shape
  // (otchealth-mcp-server src/tools/registry.ts's `const structured = {result, ...}`) -- the tool's
  // actual return value lives one level DEEPER than a naive reading of "structuredContent" suggests.
  const textBlock = `${JSON.stringify(structured, null, 2)}\n\ndeep (1 round, 1 sub-query): 1 cited passage(s) for "x" across 1 room(s): memory-exec.`;
  return JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: {
      content: [{ type: "text", text: textBlock }],
      structuredContent: { result: structured, compliance_warning: null, correlation_id: "corr-1", dry_run: false },
    },
  });
}

test("parseDeepToolResponse: a real-shaped plain-JSON envelope parses via structuredContent.result", () => {
  const body = envelopeWith(REAL_DEEP_STRUCTURED);
  const r = parseDeepToolResponse(body);
  assert.equal(r.ok, true);
  assert.deepEqual(r.structured, REAL_DEEP_STRUCTURED);
});

test("parseDeepToolResponse: content[0].text alone is NOT valid JSON (the pitfall this file guards against)", () => {
  // Prove the fixture itself reproduces the real pitfall: JSON.stringify(data) + a trailing summary
  // line is not parseable as JSON on its own. If this assertion ever stops throwing, the fixture no
  // longer represents the real gateway shape and the test above should be revisited.
  const structured = REAL_DEEP_STRUCTURED;
  const textBlock = `${JSON.stringify(structured, null, 2)}\n\ndeep (1 round, 1 sub-query): summary sentence here.`;
  assert.throws(() => JSON.parse(textBlock));
});

test("parseDeepToolResponse: SSE-framed body (data: {...} lines) is tolerated", () => {
  const structured = { ...REAL_DEEP_STRUCTURED, mode: "deep-agentic" };
  const envelope = { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "x" }], structuredContent: { result: structured } } };
  const body = `event: message\ndata: ${JSON.stringify(envelope)}\n\n`;
  const r = parseDeepToolResponse(body);
  assert.equal(r.ok, true);
  assert.equal(r.structured.mode, "deep-agentic");
});

test("parseDeepToolResponse: JSON-RPC error object -> ok:false with a readable reason", () => {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "unauthorized" } });
  const r = parseDeepToolResponse(body);
  assert.equal(r.ok, false);
  assert.match(r.reason, /unauthorized/);
});

test("parseDeepToolResponse: tool-level isError result -> ok:false with the tool's own message", () => {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { isError: true, content: [{ type: "text", text: "Tool \"brain_search\" is restricted." }] } });
  const r = parseDeepToolResponse(body);
  assert.equal(r.ok, false);
  assert.match(r.reason, /restricted/);
});

test("parseDeepToolResponse: missing structuredContent entirely -> ok:false, does not throw", () => {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "just text, no structured payload" }] } });
  const r = parseDeepToolResponse(body);
  assert.equal(r.ok, false);
  assert.match(r.reason, /structuredContent/);
});

test("parseDeepToolResponse: missing result field entirely -> ok:false", () => {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1 });
  const r = parseDeepToolResponse(body);
  assert.equal(r.ok, false);
  assert.match(r.reason, /no result field/);
});

test("parseDeepToolResponse: empty body -> ok:false, never throws", () => {
  assert.equal(parseDeepToolResponse("").ok, false);
  assert.equal(parseDeepToolResponse("   ").ok, false);
  assert.equal(parseDeepToolResponse(undefined).ok, false);
});

test("parseDeepToolResponse: garbage (neither JSON nor SSE) -> ok:false, never throws", () => {
  const r = parseDeepToolResponse("<html>502 Bad Gateway</html>");
  assert.equal(r.ok, false);
  assert.match(r.reason, /neither plain JSON nor/);
});

test("parseDeepToolResponse: structuredContent.result present but not an object -> ok:false", () => {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [], structuredContent: { result: "a plain string, not an object" } } });
  const r = parseDeepToolResponse(body);
  assert.equal(r.ok, false);
});
