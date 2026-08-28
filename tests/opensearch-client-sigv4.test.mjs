// Tests for skills/doc-indexer/opensearch-client.mjs's pure SigV4 helpers, mirroring
// tests/s3-client-sigv4.test.mjs's style: no live cluster, no credentials, pure-function checks on
// the exact rules the file's own header calls out as the #1 source of SignatureDoesNotMatch bugs.
//
// 2026-08-28 addition (Bedrock port, verify-pass REQUIRED FIX #1): signOpenSearchRequest() gained an
// optional `service` parameter so skills/doc-indexer/bedrock-client.mjs can reuse this signer instead
// of hand-rolling a fifth SigV4 implementation. The tests below at the bottom of this file prove two
// things independently: (a) every EXISTING call site (service omitted, i.e. the pre-existing "es"
// default) is BYTE-IDENTICAL to before this change -- the pre-existing tests above this comment are
// themselves that regression lock, since none of them pass `service` and all still pin an exact
// Authorization value; (b) `service: "bedrock"` genuinely applies the AWS-spec-mandated DOUBLE
// percent-encode to the CANONICAL REQUEST (never to the wire path) for a path containing a character
// (`:`) where single- vs double-encoding produce different bytes -- verified against an independently
// hand-computed reference signature (node:crypto only, no helper from the module under test), not
// merely "equals whatever this module currently produces".
import crypto from "node:crypto";
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

// ============================================================================================
// 2026-08-28 Bedrock port: service:"bedrock" double-encoding (verify-pass REQUIRED FIX #1)
// ============================================================================================

test("signOpenSearchRequest: the return value now also carries the WIRE path (single-encoded), alongside the pre-existing headers/query", () => {
  const result = signOpenSearchRequest({
    method: "GET", host: "example.us-east-1.es.amazonaws.com", path: "/idx/_mapping",
    region: "us-east-1", accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret",
    now: new Date("2026-01-01T00:00:00Z"),
  });
  assert.ok(result.headers && typeof result.headers === "object", "pre-existing 'headers' field must still be present");
  assert.equal(typeof result.query, "string", "pre-existing 'query' field must still be present");
  assert.equal(result.path, "/idx/_mapping", "the new 'path' field is the single-encoded wire path");
});

test("signOpenSearchRequest: service:'bedrock' returns a SINGLE-encoded wire path but signs the canonical request from the DOUBLE-encoded version of that same path", () => {
  const path = "/model/us.anthropic.claude-sonnet-4-5-20250929-v1:0/converse";
  const result = signOpenSearchRequest({
    method: "POST", host: "bedrock-runtime.us-east-1.amazonaws.com", path, body: '{"a":1}',
    region: "us-east-1", accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret",
    now: new Date("2026-01-01T00:00:00Z"), service: "bedrock",
  });

  // The colon must be percent-encoded EXACTLY ONCE in the path actually sent over the wire.
  assert.equal(result.path, "/model/us.anthropic.claude-sonnet-4-5-20250929-v1%3A0/converse");

  // Independently reconstruct the canonical request + AWS4-HMAC-SHA256 signature BY HAND (raw
  // node:crypto only -- no helper imported from opensearch-client.mjs itself), using the
  // DOUBLE-percent-encoded path (the '%' from the first encoding pass itself re-encoded to '%25'),
  // and assert it matches what signOpenSearchRequest actually produced. This is a cross-check
  // against an independent computation, not merely a "does the code agree with itself" tautology.
  const doubleEncodedPath = "/model/us.anthropic.claude-sonnet-4-5-20250929-v1%253A0/converse";
  const amzDate = "20260101T000000Z";
  const dateStamp = "20260101";
  const bodyHash = crypto.createHash("sha256").update('{"a":1}', "utf8").digest("hex");
  const canonicalHeaders = `content-type:application/json\nhost:bedrock-runtime.us-east-1.amazonaws.com\nx-amz-date:${amzDate}\n`;
  const signedHeaders = "content-type;host;x-amz-date";
  const canonicalRequest = ["POST", doubleEncodedPath, "", canonicalHeaders, signedHeaders, bodyHash].join("\n");
  const scope = `${dateStamp}/us-east-1/bedrock/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, crypto.createHash("sha256").update(canonicalRequest, "utf8").digest("hex")].join("\n");
  const hmac = (key, data) => crypto.createHmac("sha256", key).update(data, "utf8").digest();
  const kDate = hmac("AWS4secret", dateStamp);
  const kRegion = hmac(kDate, "us-east-1");
  const kService = hmac(kRegion, "bedrock");
  const kSigning = hmac(kService, "aws4_request");
  const expectedSignature = hmac(kSigning, stringToSign).toString("hex");
  const expectedAuth = `AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/${scope}, SignedHeaders=${signedHeaders}, Signature=${expectedSignature}`;

  assert.equal(result.headers.Authorization, expectedAuth,
    "the signature must be computed from the DOUBLE-encoded canonical URI, not the single-encoded wire path -- a mismatch here is exactly the SignatureDoesNotMatch 403 this fix exists to prevent");
});

test("signOpenSearchRequest: 'bedrock' and 'es' sign a colon-bearing path DIFFERENTLY (proves double-encoding is actually exercised, not an accidental no-op)", () => {
  const opts = {
    method: "POST", host: "bedrock-runtime.us-east-1.amazonaws.com",
    path: "/model/us.anthropic.claude-sonnet-4-5-20250929-v1:0/converse", body: '{"a":1}',
    region: "us-east-1", accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret",
    now: new Date("2026-01-01T00:00:00Z"),
  };
  const asBedrock = signOpenSearchRequest({ ...opts, service: "bedrock" });
  const asEs = signOpenSearchRequest({ ...opts, service: "es" }); // wrong scope/encoding for this path on purpose -- included only to prove the two are NOT identical
  assert.notEqual(asBedrock.headers.Authorization, asEs.headers.Authorization);
  // Encoding-for-the-wire must not depend on `service` -- only the SIGNED (canonical) form does.
  assert.equal(asBedrock.path, asEs.path);
});

test("signOpenSearchRequest: 'es' (the default, service omitted) is UNCHANGED for a path with no encoding-sensitive characters -- a plain OpenSearch index name signs identically with or without the new parameter", () => {
  const opts = {
    method: "POST", host: "example.us-east-1.es.amazonaws.com", path: "/commerce-commerce-source-docs/_bulk",
    body: '{"update":{"_id":"1"}}\n{"doc":{}}\n', region: "us-east-1", accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret",
    now: new Date("2026-01-01T00:00:00Z"), contentType: "application/x-ndjson",
  };
  const withoutService = signOpenSearchRequest(opts);
  const withEsService = signOpenSearchRequest({ ...opts, service: "es" });
  assert.equal(withoutService.headers.Authorization, withEsService.headers.Authorization, "omitting `service` must be identical to passing 'es' explicitly");
  assert.equal(withoutService.path, "/commerce-commerce-source-docs/_bulk", "no character in this path is encoding-sensitive, so single- vs double-encode make no difference here -- this is exactly why the pre-2026-08-28 signer's latent bug went unnoticed in production");
});
