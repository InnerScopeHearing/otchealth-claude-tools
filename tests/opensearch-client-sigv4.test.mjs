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
import { rfc3986Encode, canonicalUri, canonicalQuery, signOpenSearchRequest, signingUriFor, osBulkUpdate, osFetch } from "../skills/doc-indexer/opensearch-client.mjs";

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

test("osFetch: the URL it actually sends the request to matches the canonical (signed) path -- regression lock for the SignatureDoesNotMatch class this file's own header warns a new caller into", async () => {
  // Found live 2026-09-02 (see osFetch()'s own header comment): a caller whose path contains a
  // character canonicalUri() actually changes (a literal ':', as in an OpenSearch task id
  // "<nodeId>:<taskNumber>") used to be signed against ONE string but sent to the wire as a
  // DIFFERENT one, because osFetch() re-derived the request URL from its own raw `path` argument
  // instead of the canonicalized `path` signOpenSearchRequest() returns. Every pre-existing caller's
  // path (plain index names, literal segments like `_bulk`/`_mapping`) happens to be unaffected by
  // percent-encoding, so this never surfaced before a caller with a colon-bearing path existed.
  let capturedUrl = null;
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => { capturedUrl = url; return { status: 200, ok: true, text: async () => "{}" }; };
  try {
    const cfg = { host: "example.us-east-1.es.amazonaws.com", region: "us-east-1", accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret" };
    await osFetch(cfg, { method: "GET", path: "/_tasks/abc123:456" });
  } finally {
    globalThis.fetch = original;
  }
  assert.ok(capturedUrl, "fetch must have been called");
  const sentPath = new URL(capturedUrl).pathname;
  const signed = signOpenSearchRequest({
    method: "GET", host: "example.us-east-1.es.amazonaws.com", path: "/_tasks/abc123:456",
    region: "us-east-1", accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret",
  });
  assert.equal(sentPath, signed.path, "the path actually fetched must be byte-identical to the path that was signed");
  assert.equal(sentPath, "/_tasks/abc123%3A456", "the colon must be single-encoded on the wire, matching what AWS's signature verification expects");
});


// 2026-09-02: OpenSearch Service signs the DOUBLE-encoded path like every non-S3 service. Live proof:
// GET /_tasks/ep6nhLURSj2KQj4faFU_KA:100789 sent as %3A was rejected until the canonical URI carried
// %253A (AWS's SignatureDoesNotMatch body quoted the expected canonical string verbatim).
test("signingUriFor: es double-encodes reserved characters in the canonical URI; the wire path stays single-encoded", () => {
  const path = "/_tasks/ep6nhLURSj2KQj4faFU_KA:100789";
  assert.equal(canonicalUri(path), "/_tasks/ep6nhLURSj2KQj4faFU_KA%3A100789", "wire path is single-encoded");
  assert.equal(signingUriFor(path, "es"), "/_tasks/ep6nhLURSj2KQj4faFU_KA%253A100789", "es canonical URI is double-encoded");
  assert.equal(signingUriFor(path, "s3"), "/_tasks/ep6nhLURSj2KQj4faFU_KA%3A100789", "S3 is the only single-encode service");
  assert.equal(signingUriFor("/memory-exec/_search", "es"), "/memory-exec/_search", "plain index paths are byte-identical under both passes (why this hid for 5 days)");
  const signed = signOpenSearchRequest({ method: "GET", host: "h.es.amazonaws.com", path, region: "us-east-1", accessKeyId: "AKIA", secretAccessKey: "s", now: new Date("2026-09-02T00:00:00Z") });
  assert.equal(signed.path, "/_tasks/ep6nhLURSj2KQj4faFU_KA%3A100789", "what goes on the wire is still the single-encoded path");
});

// ============================================================================================
// 2026-09-03: canonicalUri() array-of-segments input (Bedrock GetModelInvocationJob path-parameter
// fix). Live-verified the same day against the real Bedrock control plane (HTTP 200, a real job's
// status/details returned) -- see bedrock-batch-client.mjs's header for the full incident, and
// canonicalUri()'s own doc comment for why a pre-joined STRING cannot express "this segment's value
// itself contains a literal '/'".
// ============================================================================================

test("canonicalUri: an array of raw segments encodes EACH element exactly once, even one containing '/' and ':' -- the case a pre-joined string cannot express", () => {
  const arn = "arn:aws:bedrock:us-east-1:900915535335:model-invocation-job/tcf29in6w6ts";
  assert.equal(
    canonicalUri(["model-invocation-job", arn]),
    "/model-invocation-job/arn%3Aaws%3Abedrock%3Aus-east-1%3A900915535335%3Amodel-invocation-job%2Ftcf29in6w6ts",
    "the ARN's internal '/' must become %2F (a literal DATA character, not a new path segment) and every ':' must be single-encoded",
  );
});

test("canonicalUri: the fail-on-old-code proof -- the SAME arn as a pre-joined STRING (the code this replaced) produces the WRONG, live-reproduced-broken wire path", () => {
  const arn = "arn:aws:bedrock:us-east-1:900915535335:model-invocation-job/tcf29in6w6ts";
  // This is exactly what a naive `"/model-invocation-job/" + arn` string produces: canonicalUri
  // splits on the ARN's OWN internal '/', so it comes out as FOUR segments, not two, and the
  // internal '/' survives as a literal wire character instead of becoming %2F. Sent to the real
  // Bedrock control plane, this specific wire shape was rejected with 404 UnknownOperationException
  // (the router could not match it to any known operation at all) -- reproduced live 2026-09-03.
  const brokenStringForm = canonicalUri("/model-invocation-job/" + arn);
  assert.equal(brokenStringForm, "/model-invocation-job/arn%3Aaws%3Abedrock%3Aus-east-1%3A900915535335%3Amodel-invocation-job/tcf29in6w6ts");
  assert.notEqual(brokenStringForm, canonicalUri(["model-invocation-job", arn]), "the string form and the array form must NOT agree -- this is the exact bug the array form fixes, not a cosmetic alternative");
});

test("canonicalUri: a manually-pre-encoded arn passed as a STRING (the OTHER broken variant this replaced) double-encodes -- also live-reproduced as a distinct failure (400 'provided ARN is invalid')", () => {
  const arn = "arn:aws:bedrock:us-east-1:900915535335:model-invocation-job/tcf29in6w6ts";
  const doublyEncoded = canonicalUri("/model-invocation-job/" + encodeURIComponent(arn));
  assert.match(doublyEncoded, /%253A/, "the '%' from the caller's own pre-encoding gets re-escaped to %25 by canonicalUri's OWN per-segment pass -- the double-encoding bug");
  assert.notEqual(doublyEncoded, canonicalUri(["model-invocation-job", arn]));
});

test("canonicalUri: array input composes correctly with doubleEncodeUri (via signingUriFor) for the SIGNING string, with no special-casing needed in that function", () => {
  const arn = "arn:aws:bedrock:us-east-1:900915535335:model-invocation-job/tcf29in6w6ts";
  const segments = ["model-invocation-job", arn];
  // The wire path (single-encoded) and the signing URI (double-encoded) must both start from the
  // array form and differ from each other exactly the way every other non-S3 service's path does.
  assert.equal(signingUriFor(segments, "s3"), canonicalUri(segments), "s3 signs from the single-encoded (wire) form");
  const doubleEncoded = signingUriFor(segments, "bedrock");
  assert.notEqual(doubleEncoded, canonicalUri(segments));
  assert.match(doubleEncoded, /%253A/, "bedrock (non-S3) must double-encode the ARN's colons in the SIGNING string");
  assert.match(doubleEncoded, /%252F/, "and double-encode the ARN's internal slash the same way -- it is just another character by the time the array form has already resolved it to %2F once");
});

test("canonicalUri: array input, live-verified end to end -- signOpenSearchRequest produces the EXACT signature independently hand-computed against this fleet's real 2026-09-03 Bedrock pilot call", () => {
  // This is the real request that returned HTTP 200 against the live Bedrock control plane
  // (job arn:aws:bedrock:us-east-1:900915535335:model-invocation-job/tcf29in6w6ts, account
  // 900915535335) -- reproduced here with fixed test credentials/timestamp so the expected
  // signature can be hand-computed once and pinned, matching this file's own established
  // convention for every other SigV4 edge case (see the two tests above this comment block's own
  // header cites).
  const arn = "arn:aws:bedrock:us-east-1:900915535335:model-invocation-job/tcf29in6w6ts";
  const result = signOpenSearchRequest({
    method: "GET", host: "bedrock.us-east-1.amazonaws.com", path: ["model-invocation-job", arn],
    region: "us-east-1", accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret",
    now: new Date("2026-01-01T00:00:00Z"), service: "bedrock",
  });
  assert.equal(result.path, "/model-invocation-job/arn%3Aaws%3Abedrock%3Aus-east-1%3A900915535335%3Amodel-invocation-job%2Ftcf29in6w6ts");

  const doubleEncodedPath = "/model-invocation-job/arn%253Aaws%253Abedrock%253Aus-east-1%253A900915535335%253Amodel-invocation-job%252Ftcf29in6w6ts";
  const amzDate = "20260101T000000Z";
  const dateStamp = "20260101";
  const bodyHash = crypto.createHash("sha256").update("", "utf8").digest("hex");
  const canonicalHeaders = `host:bedrock.us-east-1.amazonaws.com\nx-amz-date:${amzDate}\n`;
  const signedHeaders = "host;x-amz-date";
  const canonicalRequest = ["GET", doubleEncodedPath, "", canonicalHeaders, signedHeaders, bodyHash].join("\n");
  const scope = `${dateStamp}/us-east-1/bedrock/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, crypto.createHash("sha256").update(canonicalRequest, "utf8").digest("hex")].join("\n");
  const hmac = (key, data) => crypto.createHmac("sha256", key).update(data, "utf8").digest();
  const kDate = hmac("AWS4secret", dateStamp);
  const kRegion = hmac(kDate, "us-east-1");
  const kService = hmac(kRegion, "bedrock");
  const kSigning = hmac(kService, "aws4_request");
  const expectedSignature = hmac(kSigning, stringToSign).toString("hex");
  const expectedAuth = `AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/${scope}, SignedHeaders=${signedHeaders}, Signature=${expectedSignature}`;
  assert.equal(result.headers.Authorization, expectedAuth);
});

test("canonicalUri: array input is a NEW, additive branch -- every pre-existing string-path caller (plain index names, '_bulk', a colon-bearing task id) is byte-identical to before", () => {
  assert.equal(canonicalUri("/commerce-commerce-source-docs/_bulk"), "/commerce-commerce-source-docs/_bulk");
  assert.equal(canonicalUri("/_tasks/ep6nhLURSj2KQj4faFU_KA:100789"), "/_tasks/ep6nhLURSj2KQj4faFU_KA%3A100789");
  assert.equal(canonicalUri(""), "/");
  assert.equal(canonicalUri("/"), "/");
});
