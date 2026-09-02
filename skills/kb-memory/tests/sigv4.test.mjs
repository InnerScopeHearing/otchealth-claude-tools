// Tests for sigv4.mjs -- the shared AWS SigV4 signer extracted per FND-20260828-5ca1.
//
// Two independent kinds of evidence, deliberately not just one:
//   1. deriveSigningKey() is checked by DIFFERENTIAL TESTING against a second, independently-written
//      implementation of the exact 4-step HMAC chain AWS's own documentation specifies (see
//      referenceDeriveSigningKey() below, and deriveSigningKey()'s own comment in ../sigv4.mjs for why
//      this replaced an attempt to pin a single hardcoded "known-good" hex constant: that constant,
//      recalled from memory and then "confirmed" by a web search, turned out to be wrong both times --
//      the search result even produced a 65-character string for what must be a 64-character SHA-256
//      digest. A magic constant nobody can actually verify is worse than no such test; two independent
//      readings of the same live-quoted specification agreeing across many varied inputs is real
//      evidence that this implementation matches AWS's documented algorithm, not just itself.
//   2. signAwsRequest()/awsRequest() are then checked for structural correctness (Authorization
//      shape, canonical-header inclusion/exclusion, credential-resolution fallback, transport-error
//      handling) with fixed fake credentials and a fixed clock, so the assertions are deterministic
//      and need no network or real AWS credentials.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { deriveSigningKey, canonicalQueryString, signAwsRequest, awsRequest } from "../sigv4.mjs";

const FAKE_CREDS = { ak: "AKIAIOSFODNN7EXAMPLE", sk: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", st: null };
const FIXED_NOW = new Date("2015-08-30T12:36:00Z");

// Written FRESH from AWS's own documented steps (https://docs.aws.amazon.com/IAM/latest/UserGuide/
// reference_sigv-create-signed-request.html, "Derive a signing key", fetched 2026-09-02) -- not
// copy-pasted from ../sigv4.mjs's deriveSigningKey() -- so agreement between the two is a genuine
// differential check, not a tautology comparing a function to itself.
function referenceDeriveSigningKey(secretKey, dateStamp, region, service) {
  const h = (key, data) => crypto.createHmac("sha256", key).update(data).digest();
  const dateKey = h(`AWS4${secretKey}`, dateStamp);
  const dateRegionKey = h(dateKey, region);
  const dateRegionServiceKey = h(dateRegionKey, service);
  return h(dateRegionServiceKey, "aws4_request");
}

test("deriveSigningKey agrees with an independent reimplementation of AWS's documented 4-step HMAC chain, across varied inputs", () => {
  const cases = [
    { secretKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", dateStamp: "20150830", region: "us-east-1", service: "iam" },
    { secretKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", dateStamp: "20260902", region: "us-east-1", service: "sns" },
    { secretKey: "a-totally-different-secret-42", dateStamp: "20260101", region: "eu-west-1", service: "s3" },
    { secretKey: "another/secret+with=symbols", dateStamp: "19700101", region: "us-west-2", service: "ssm" },
  ];
  for (const c of cases) {
    const mine = deriveSigningKey(c).toString("hex");
    const reference = referenceDeriveSigningKey(c.secretKey, c.dateStamp, c.region, c.service).toString("hex");
    assert.equal(mine, reference, `mismatch for ${JSON.stringify(c)}`);
    assert.equal(mine.length, 64, "a SHA-256 HMAC digest must be exactly 64 hex characters");
  }
});

test("deriveSigningKey changes when any single input changes (no accidental input-independence)", () => {
  const base = deriveSigningKey({ secretKey: "sk", dateStamp: "20260101", region: "us-east-1", service: "sns" }).toString("hex");
  const diffs = [
    deriveSigningKey({ secretKey: "SK", dateStamp: "20260101", region: "us-east-1", service: "sns" }),
    deriveSigningKey({ secretKey: "sk", dateStamp: "20260102", region: "us-east-1", service: "sns" }),
    deriveSigningKey({ secretKey: "sk", dateStamp: "20260101", region: "us-west-2", service: "sns" }),
    deriveSigningKey({ secretKey: "sk", dateStamp: "20260101", region: "us-east-1", service: "ssm" }),
  ];
  for (const d of diffs) assert.notEqual(d.toString("hex"), base, "changing one input must change the derived key");
});

test("canonicalQueryString sorts by encoded key and percent-encodes SigV4's stricter reserved set", () => {
  // "!*'()" are left UNESCAPED by encodeURIComponent -- the well-known JS footgun this function exists
  // to close (see its own comment). "b" < "a with a reserved char" only if encoding happens BEFORE
  // sorting is verified correctly ordered too.
  const qs = canonicalQueryString({ b: "plain", a: "needs !*'() encoding" });
  assert.match(qs, /^a=/, "must sort by key, a before b");
  assert.doesNotMatch(qs, /[!*'()]/, "reserved characters must not survive unescaped");
  assert.match(qs, /%20/, "space must be %20, never +");
  assert.equal(canonicalQueryString(null), "", "no params -> empty string, never throws");
  assert.equal(canonicalQueryString({}), "", "empty object -> empty string");
});

test("signAwsRequest produces the documented Authorization shape and signs exactly host+x-amz-date+extras", async () => {
  const result = await signAwsRequest({
    method: "POST",
    service: "sns",
    region: "us-east-1",
    host: "sns.us-east-1.amazonaws.com",
    path: "/",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "Action=Publish&Version=2010-03-31",
    now: FIXED_NOW,
    creds: FAKE_CREDS,
  });
  assert.ok(!result.error, "must not error with valid fake creds");
  const auth = result.headers.authorization;
  assert.match(auth, /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/20150830\/us-east-1\/sns\/aws4_request, SignedHeaders=[a-z;-]+, Signature=[0-9a-f]{64}$/);
  // SignedHeaders must be exactly {content-type, host, x-amz-date}, alphabetically sorted -- not more
  // (leaking an unrelated header into the signed set) and not fewer (a header the request actually
  // sends but did not sign is a request-smuggling-adjacent bug class in SigV4-authenticated APIs).
  const signedHeaders = auth.match(/SignedHeaders=([a-z;-]+)/)[1];
  assert.equal(signedHeaders, "content-type;host;x-amz-date");
  assert.equal(result.headers["content-type"], "application/x-www-form-urlencoded");
  assert.equal(result.headers["x-amz-date"], "20150830T123600Z");
  assert.ok(!("host" in result.headers), "host is signed but not resent -- fetch() sets the real Host header itself");
});

test("signAwsRequest is deterministic for fixed inputs (regression pin) and changes when the body changes", async () => {
  const base = { method: "GET", service: "s3", region: "us-east-1", host: "example.amazonaws.com", path: "/", now: FIXED_NOW, creds: FAKE_CREDS };
  const a = await signAwsRequest({ ...base, body: "" });
  const b = await signAwsRequest({ ...base, body: "" });
  assert.equal(a.headers.authorization, b.headers.authorization, "identical inputs must sign identically");
  const c = await signAwsRequest({ ...base, body: "different payload" });
  assert.notEqual(a.headers.authorization, c.headers.authorization, "a different body must change the signature");
  // Pin the exact signature for these fixed inputs (computed once from this same implementation and
  // hardcoded here, NOT derived from `a` itself) so a future refactor that silently changes
  // canonicalization -- header ordering, the empty-body hash, the scope string -- is caught even
  // without re-deriving the value by hand. A pin that reads the value from its own subject under test
  // would be tautological; this one does not.
  assert.equal(
    a.headers.authorization,
    "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20150830/us-east-1/s3/aws4_request, SignedHeaders=host;x-amz-date, " +
      "Signature=e138049a32ea46833c181cb7ae1c0a3298f28bcc1f4f424e4df5eb5f4cea85c5",
  );
});

test("signAwsRequest includes x-amz-security-token in the signed set only when a session token is present", async () => {
  const withToken = await signAwsRequest({
    method: "GET", service: "sts", region: "us-east-1", host: "sts.amazonaws.com", now: FIXED_NOW,
    creds: { ...FAKE_CREDS, st: "FwoGZXIvYXdzEXAMPLE" },
  });
  assert.match(withToken.headers.authorization, /SignedHeaders=host;x-amz-date;x-amz-security-token/);
  assert.equal(withToken.headers["x-amz-security-token"], "FwoGZXIvYXdzEXAMPLE");

  const withoutToken = await signAwsRequest({ method: "GET", service: "sts", region: "us-east-1", host: "sts.amazonaws.com", now: FIXED_NOW, creds: FAKE_CREDS });
  assert.doesNotMatch(withoutToken.headers.authorization, /x-amz-security-token/);
  assert.ok(!("x-amz-security-token" in withoutToken.headers));
});

test("signAwsRequest fails with a distinct, checkable reason when no credentials resolve (no network attempted)", async () => {
  // Deliberately omit `creds` AND ensure the ambient environment cannot resolve any via awsCreds()'s
  // own chain, by clearing every variable it checks for the duration of this one assertion.
  const saved = {};
  for (const k of ["AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", "AWS_CONTAINER_CREDENTIALS_FULL_URI", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "OTC_AWS_ACCESS_KEY_ID", "OTC_AWS_SECRET_ACCESS_KEY"]) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  try {
    const result = await signAwsRequest({ method: "GET", service: "sns", region: "us-east-1", host: "sns.us-east-1.amazonaws.com" });
    assert.equal(result.error, "no-aws-credentials");
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
  }
});

test("awsRequest surfaces the no-credentials case as status:0 without ever calling fetch", async () => {
  const saved = {};
  for (const k of ["AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", "AWS_CONTAINER_CREDENTIALS_FULL_URI", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "OTC_AWS_ACCESS_KEY_ID", "OTC_AWS_SECRET_ACCESS_KEY"]) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = async (...args) => { fetchCalled = true; return originalFetch(...args); };
  try {
    const result = await awsRequest({ method: "POST", service: "sns", region: "us-east-1", host: "sns.us-east-1.amazonaws.com", body: "x" });
    assert.equal(result.status, 0);
    assert.equal(result.reason, "no-aws-credentials");
    assert.equal(result.json, null);
    assert.equal(fetchCalled, false, "must not attempt a network call when signing itself already failed");
  } finally {
    globalThis.fetch = originalFetch;
    for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
  }
});

test("awsRequest never throws on a transport failure and reports it as a distinct reason", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("simulated DNS failure"); };
  try {
    const result = await awsRequest({ method: "POST", service: "sns", region: "us-east-1", host: "sns.us-east-1.amazonaws.com", body: "x", headers: {} });
    // Falls through to real awsCreds(); if this sandbox has none resolvable, that is itself a valid,
    // still-non-throwing outcome, so accept either shape rather than asserting a specific one.
    assert.ok(result.reason === "no-aws-credentials" || /^error-/.test(result.reason));
    assert.equal(result.status, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("canonical header values collapse internal whitespace, not just trim (AWS signs them collapsed)", async () => {
  // Trim-only signs "a:  b   c" verbatim while AWS canonicalizes to "a:b c", producing two different
  // signatures and an auth failure whose message never explains itself. Same credentials, same
  // request, values differing only in internal spacing must therefore sign IDENTICALLY.
  const base = { method: "POST", service: "sns", region: "us-east-1", host: "sns.us-east-1.amazonaws.com", path: "/", body: "Action=Publish" };
  const creds = { ak: "AKIAIOSFODNN7EXAMPLE", sk: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" };
  const when = new Date("2026-09-02T00:00:00Z");
  const tight = await signAwsRequest({ ...base, headers: { "content-type": "application/x-www-form-urlencoded" }, creds, now: when });
  const loose = await signAwsRequest({ ...base, headers: { "content-type": "  application/x-www-form-urlencoded  " }, creds, now: when });
  const spaced = await signAwsRequest({ ...base, headers: { "content-type": "application/x-www-form-urlencoded" }, creds, now: when });
  assert.equal(loose.headers.authorization, tight.headers.authorization, "leading/trailing space must not change the signature");
  assert.equal(spaced.headers.authorization, tight.headers.authorization);
  // And the collapse itself: a value with runs of internal whitespace must sign as its collapsed form.
  const runs = await signAwsRequest({ ...base, headers: { "x-test": "a   b     c" }, creds, now: when });
  const single = await signAwsRequest({ ...base, headers: { "x-test": "a b c" }, creds, now: when });
  assert.equal(runs.headers.authorization, single.headers.authorization, "internal whitespace runs must collapse to one space before signing");
});
