// Tests for skills/doc-indexer/opensearch-client.mjs's pure SigV4 helpers, mirroring
// tests/s3-client-sigv4.test.mjs's style: no live cluster, no credentials, pure-function checks on
// the exact rules the file's own header calls out as the #1 source of SignatureDoesNotMatch bugs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { rfc3986Encode, canonicalUri, canonicalQuery, signOpenSearchRequest, osBulkUpdate } from "../skills/doc-indexer/opensearch-client.mjs";

test("rfc3986Encode leaves unreserved characters unchanged", () => {
  assert.equal(rfc3986Encode("AZaz09-._~"), "AZaz09-._~");
});

test("rfc3986Encode escapes the characters encodeURIComponent leaves alone but AWS requires escaped", () => {
  // This is the exact gap the gateway's own sigv4.ts documents and the AWS-CUTOVER runbook verified
  // live against this cluster: encodeURIComponent alone leaves ! ' ( ) * unescaped.
  assert.equal(rfc3986Encode("!"), "%21");
  assert.equal(rfc3986Encode("'"), "%27");
  assert.equal(rfc3986Encode("("), "%28");
  assert.equal(rfc3986Encode(")"), "%29");
  assert.equal(rfc3986Encode("*"), "%2A");
});

test("rfc3986Encode: space and slash percent-encode like a normal path segment", () => {
  assert.equal(rfc3986Encode(" "), "%20");
  assert.equal(rfc3986Encode("/"), "%2F");
});

test("canonicalUri: encodes each segment but keeps '/' separators literal", () => {
  assert.equal(canonicalUri("/commerce-commerce-source-docs/_bulk"), "/commerce-commerce-source-docs/_bulk");
  assert.equal(canonicalUri("/a b/c"), "/a%20b/c");
});

test("canonicalUri: empty or bare-slash path canonicalizes to '/'", () => {
  assert.equal(canonicalUri(""), "/");
  assert.equal(canonicalUri("/"), "/");
});

test("canonicalQuery: sorts params by encoded key and encodes both key and value", () => {
  assert.equal(canonicalQuery({ refresh: "wait_for", track_total_hits: "true" }), "refresh=wait_for&track_total_hits=true");
  // 'a' < 'refresh' alphabetically -- confirms real sorting, not just insertion order
  assert.equal(canonicalQuery({ refresh: "true", a: "1" }), "a=1&refresh=true");
});

test("canonicalQuery: returns empty string for no params", () => {
  assert.equal(canonicalQuery({}), "");
  assert.equal(canonicalQuery(undefined), "");
});

test("signOpenSearchRequest: content-type is a SIGNED header whenever a body is present, and defaults to application/json", () => {
  const { headers } = signOpenSearchRequest({
    method: "POST", host: "example.us-east-1.es.amazonaws.com", path: "/idx/_search", body: '{"a":1}',
    region: "us-east-1", accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret",
    now: new Date("2026-01-01T00:00:00Z"),
  });
  assert.equal(headers["content-type"], "application/json");
  assert.match(headers.Authorization, /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20260101\/us-east-1\/es\/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=[0-9a-f]{64}$/);
});

test("signOpenSearchRequest: bulk content-type override (application/x-ndjson) is honored and signed", () => {
  const { headers } = signOpenSearchRequest({
    method: "POST", host: "example.us-east-1.es.amazonaws.com", path: "/idx/_bulk", body: '{"update":{"_id":"1"}}\n{"doc":{}}\n',
    region: "us-east-1", accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret", contentType: "application/x-ndjson",
    now: new Date("2026-01-01T00:00:00Z"),
  });
  assert.equal(headers["content-type"], "application/x-ndjson");
  assert.match(headers.Authorization, /SignedHeaders=content-type;host;x-amz-date/);
});

test("signOpenSearchRequest: no body means no content-type header and no content-type in SignedHeaders (a GET)", () => {
  const { headers } = signOpenSearchRequest({
    method: "GET", host: "example.us-east-1.es.amazonaws.com", path: "/idx/_mapping",
    region: "us-east-1", accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret",
    now: new Date("2026-01-01T00:00:00Z"),
  });
  assert.equal("content-type" in headers, false);
  assert.match(headers.Authorization, /SignedHeaders=host;x-amz-date/);
});

test("signOpenSearchRequest: session token, when given, is signed as x-amz-security-token", () => {
  const { headers } = signOpenSearchRequest({
    method: "GET", host: "example.us-east-1.es.amazonaws.com", path: "/", region: "us-east-1",
    accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret", sessionToken: "TOKEN123",
    now: new Date("2026-01-01T00:00:00Z"),
  });
  assert.equal(headers["x-amz-security-token"], "TOKEN123");
  assert.match(headers.Authorization, /SignedHeaders=host;x-amz-date;x-amz-security-token/);
});

test("signOpenSearchRequest: same inputs always produce the same signature (deterministic given a fixed `now`)", () => {
  const opts = {
    method: "POST", host: "example.us-east-1.es.amazonaws.com", path: "/idx/_search", body: '{"a":1}',
    region: "us-east-1", accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret", now: new Date("2026-06-15T12:34:56Z"),
  };
  const a = signOpenSearchRequest(opts);
  const b = signOpenSearchRequest(opts);
  assert.equal(a.headers.Authorization, b.headers.Authorization);
});

test("signOpenSearchRequest: changing the body changes the signature (body hash is part of the canonical request)", () => {
  const base = {
    method: "POST", host: "example.us-east-1.es.amazonaws.com", path: "/idx/_search",
    region: "us-east-1", accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret", now: new Date("2026-06-15T12:34:56Z"),
  };
  const a = signOpenSearchRequest({ ...base, body: '{"a":1}' });
  const b = signOpenSearchRequest({ ...base, body: '{"a":2}' });
  assert.notEqual(a.headers.Authorization, b.headers.Authorization);
});

test("osBulkUpdate: empty id list is a no-op success without making a network call", async () => {
  const res = await osBulkUpdate({ host: "unreachable.invalid", region: "us-east-1", accessKeyId: "x", secretAccessKey: "y" }, "idx", [], { entity: "Acme" });
  assert.deepEqual(res, { ok: true, ids: [], errors: [] });
});
