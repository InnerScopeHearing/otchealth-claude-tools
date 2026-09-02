// Tests for setup/aws-sigv4.mjs -- the shared AWS SigV4 signer extracted per FND-20260828-5ca1.
//
// Two independent kinds of evidence, matching the methodology skills/kb-memory/tests/sigv4.test.mjs
// already established for this exact algorithm (its own header explains why: a single memorized or
// web-searched "known good" magic constant was tried first and was WRONG both times, so a hardcoded
// expected-signature string is worse evidence than none):
//   1. deriveSigningKey() and the encoding helpers are checked by DIFFERENTIAL TESTING against a
//      second, independently-written implementation of AWS's own documented steps (see
//      referenceDeriveSigningKey()/referenceRfc3986Encode() below -- not copy-pasted from
//      ../setup/aws-sigv4.mjs), so agreement is a genuine cross-check, not a tautology.
//   2. signRequest()/awsFetch() are checked with AWS-SigV4-test-suite-SHAPED cases (get-vanilla,
//      get-utf8, get-space, post-x-www-form-urlencoded, an S3-style path with a space and a '+') for
//      STRUCTURAL correctness (Authorization shape, SignedHeaders content, exact encoded characters)
//      that is verifiable by reading the assertion itself, with fixed fake credentials and a fixed
//      clock so nothing here needs real AWS credentials or network access.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  deriveSigningKey,
  rfc3986Encode,
  canonicalUriPath,
  doubleEncodeUriPath,
  canonicalQueryString,
  signRequest,
  awsFetch,
} from "../setup/aws-sigv4.mjs";

const FAKE_CREDS = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", sessionToken: null };
const FIXED_NOW = new Date("2015-08-30T12:36:00Z");

// Written FRESH from AWS's documented steps (https://docs.aws.amazon.com/IAM/latest/UserGuide/
// reference_sigv-create-signed-request.html, "Derive a signing key") -- not copy-pasted from
// ../setup/aws-sigv4.mjs's deriveSigningKey().
function referenceDeriveSigningKey(secretKey, dateStamp, region, service) {
  const h = (key, data) => crypto.createHmac("sha256", key).update(data).digest();
  const dateKey = h(`AWS4${secretKey}`, dateStamp);
  const dateRegionKey = h(dateKey, region);
  const dateRegionServiceKey = h(dateRegionKey, service);
  return h(dateRegionServiceKey, "aws4_request");
}

// A second, independent RFC 3986 percent-encoder operating byte-by-byte on the UTF-8 encoding of the
// input, rather than delegating to encodeURIComponent()'s replace-the-gaps approach.
function referenceRfc3986Encode(value) {
  const bytes = Buffer.from(String(value), "utf8");
  let out = "";
  for (const byte of bytes) {
    const ch = String.fromCharCode(byte);
    if (/[A-Za-z0-9\-._~]/.test(ch)) out += ch;
    else out += "%" + byte.toString(16).toUpperCase().padStart(2, "0");
  }
  return out;
}

test("deriveSigningKey agrees with an independent reimplementation of AWS's documented 4-step HMAC chain, across varied inputs", () => {
  const cases = [
    { secretKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", dateStamp: "20150830", region: "us-east-1", service: "iam" },
    { secretKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", dateStamp: "20260902", region: "us-east-1", service: "scheduler" },
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

test("rfc3986Encode agrees with an independent byte-level RFC-3986 encoder, including the '!*''()' gap encodeURIComponent leaves open", () => {
  const cases = ["plain", "a b", "a+b", "a%b", "!*'()", "colon:period.tilde~underscore_dash-", "ሴ (multi-byte UTF-8)"];
  for (const c of cases) {
    assert.equal(rfc3986Encode(c), referenceRfc3986Encode(c), `mismatch for ${JSON.stringify(c)}`);
  }
  assert.doesNotMatch(rfc3986Encode("!*'()"), /[!*'()]/, "SigV4's reserved set must not survive unescaped");
});

test("canonicalUriPath encodes per segment and preserves '/' as a literal separator", () => {
  assert.equal(canonicalUriPath(""), "/");
  assert.equal(canonicalUriPath("/"), "/");
  assert.equal(canonicalUriPath("/a/b"), "/a/b");
  assert.equal(canonicalUriPath("/my file/(draft).pdf"), "/my%20file/%28draft%29.pdf");
});

test("doubleEncodeUriPath re-encodes an ALREADY singly-encoded path -- a literal '%' from the first pass becomes '%25' on the second", () => {
  const wire = canonicalUriPath("/schedules/my-job:v2");
  assert.equal(wire, "/schedules/my-job%3Av2", "single-encode pass: colon becomes %3A");
  const signing = doubleEncodeUriPath(wire);
  assert.equal(signing, "/schedules/my-job%253Av2", "double-encode pass: the %3A from the first pass becomes %253A");
  assert.notEqual(wire, signing, "THE bug this file exists to fix: the wire path and the signing path must differ whenever a character needed escaping");
});

test("canonicalQueryString sorts by encoded key then encoded value, and never double-encodes (the double-encode rule is path-only)", () => {
  const qs = canonicalQueryString({ b: "plain", a: "needs !*'() encoding" });
  assert.match(qs, /^a=/, "must sort by key, a before b");
  assert.doesNotMatch(qs, /[!*'()]/, "reserved characters must not survive unescaped");
  assert.match(qs, /%20/, "space must be %20, never +");
  assert.doesNotMatch(qs, /%25/, "a query string must never be double-encoded");
  assert.equal(canonicalQueryString(null), "", "no params -> empty string, never throws");
  assert.equal(canonicalQueryString({}), "", "empty object -> empty string");
  // duplicate keys, tie broken by value
  const dup = canonicalQueryString(new URLSearchParams([["a", "z2"], ["a", "z1"]]));
  assert.equal(dup, "a=z1&a=z2", "same key -> sorted by value too");
});

// ---------------------------------------------------------------------------------------------------
// AWS-SigV4-test-suite-SHAPED cases (named per the task's own vocabulary; not AWS's literal published
// fixture files, whose exact expected strings this suite deliberately does not hardcode -- see header).

test("get-vanilla: a bare GET to root, no query, no extra headers", async () => {
  const r = await signRequest({ method: "GET", url: "https://example.amazonaws.com/", service: "service", region: "us-east-1", credentials: FAKE_CREDS, now: FIXED_NOW });
  assert.ok(!r.error);
  assert.match(r.headers.authorization, /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20150830\/us-east-1\/service\/aws4_request, SignedHeaders=host;x-amz-date, Signature=[0-9a-f]{64}$/);
  assert.equal(r.url, "https://example.amazonaws.com/");
  assert.ok(!("host" in r.headers), "host is signed but not resent");
});

test("get-utf8: a multi-byte UTF-8 path segment signs and the wire URL carries the correctly percent-encoded bytes", async () => {
  const r = await signRequest({ method: "GET", url: "https://example.amazonaws.com/%E1%88%B4", service: "service", region: "us-east-1", credentials: FAKE_CREDS, now: FIXED_NOW });
  assert.ok(!r.error);
  assert.equal(r.url, "https://example.amazonaws.com/%E1%88%B4", "an already-correctly-encoded path round-trips byte-for-byte");
  assert.match(r.headers.authorization, /SignedHeaders=host;x-amz-date/);
});

test("get-space: a literal space in a raw key, run through canonicalUriPath() as a caller must, becomes %20 (never '+') on the wire AND in the signature for S3", async () => {
  const path = canonicalUriPath("/my bucket key with space.txt");
  assert.equal(path, "/my%20bucket%20key%20with%20space.txt");
  const r = await signRequest({ method: "GET", url: `https://bucket.s3.us-east-1.amazonaws.com${path}`, service: "s3", region: "us-east-1", credentials: FAKE_CREDS, now: FIXED_NOW });
  assert.ok(!r.error);
  assert.equal(r.url, `https://bucket.s3.us-east-1.amazonaws.com${path}`);
  assert.doesNotMatch(r.url, /\+/, "a space must never become a literal +");
});

test("post-x-www-form-urlencoded: content-type is signed and included in SignedHeaders; the body hash changes the signature", async () => {
  const base = { method: "POST", url: "https://example.amazonaws.com/", service: "service", region: "us-east-1", credentials: FAKE_CREDS, now: FIXED_NOW, headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8" } };
  const a = await signRequest({ ...base, body: "Action=Publish&Version=2010-03-31" });
  const b = await signRequest({ ...base, body: "Action=Publish&Version=2010-03-31" });
  const c = await signRequest({ ...base, body: "Action=Different" });
  assert.equal(a.headers.authorization, b.headers.authorization, "identical inputs sign identically");
  assert.notEqual(a.headers.authorization, c.headers.authorization, "a different body must change the signature");
  const signedHeaders = a.headers.authorization.match(/SignedHeaders=([a-z;-]+)/)[1];
  assert.equal(signedHeaders, "content-type;host;x-amz-date");
  assert.equal(a.headers["content-type"], "application/x-www-form-urlencoded; charset=utf-8");
});

test("S3-style path with a space AND a '+': single-encoded on the wire (S3's documented exception), never double-encoded", async () => {
  const rawKey = "/reports/Q3 2026 + notes.pdf";
  const path = canonicalUriPath(rawKey);
  assert.equal(path, "/reports/Q3%202026%20%2B%20notes.pdf", "space -> %20, literal + -> %2B (never left as a bare '+')");
  const r = await signRequest({ method: "GET", url: `https://bucket.s3.us-east-1.amazonaws.com${path}`, service: "s3", region: "us-east-1", credentials: FAKE_CREDS, now: FIXED_NOW });
  assert.ok(!r.error);
  assert.equal(r.url, `https://bucket.s3.us-east-1.amazonaws.com${path}`, "S3's wire path is the single-encoded form, unchanged");
  // Prove the S3 exception is actually engaged: a NON-S3 service given the exact same wire path must
  // sign a DIFFERENT (double-encoded) canonical request, and therefore compute a DIFFERENT signature.
  const nonS3 = await signRequest({ method: "GET", url: `https://example.amazonaws.com${path}`, service: "scheduler", region: "us-east-1", credentials: FAKE_CREDS, now: FIXED_NOW });
  assert.notEqual(r.headers.authorization, nonS3.headers.authorization, "s3 (single-encode) and a non-s3 service (double-encode) over the identical path must sign differently");
});

test("x-amz-security-token is included in the signed set only when a session token is present", async () => {
  const withToken = await signRequest({ method: "GET", url: "https://sts.amazonaws.com/", service: "sts", region: "us-east-1", now: FIXED_NOW, credentials: { ...FAKE_CREDS, sessionToken: "FwoGZXIvYXdzEXAMPLE" } });
  assert.match(withToken.headers.authorization, /SignedHeaders=host;x-amz-date;x-amz-security-token/);
  assert.equal(withToken.headers["x-amz-security-token"], "FwoGZXIvYXdzEXAMPLE");
  const withoutToken = await signRequest({ method: "GET", url: "https://sts.amazonaws.com/", service: "sts", region: "us-east-1", now: FIXED_NOW, credentials: FAKE_CREDS });
  assert.doesNotMatch(withoutToken.headers.authorization, /x-amz-security-token/);
});

test("either credential SHAPE ({ak,sk,st} or {accessKeyId,secretAccessKey,sessionToken}) signs identically -- no remapping required at a migrated call site", async () => {
  const short = await signRequest({ method: "GET", url: "https://example.amazonaws.com/", service: "service", region: "us-east-1", now: FIXED_NOW, credentials: { ak: "AKIDEXAMPLE", sk: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", st: null } });
  const long = await signRequest({ method: "GET", url: "https://example.amazonaws.com/", service: "service", region: "us-east-1", now: FIXED_NOW, credentials: FAKE_CREDS });
  assert.equal(short.headers.authorization, long.headers.authorization);
});

test("signRequest fails with a distinct, checkable reason when no credentials resolve (no network attempted)", async () => {
  const saved = {};
  for (const k of ["AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", "AWS_CONTAINER_CREDENTIALS_FULL_URI", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "OTC_AWS_ACCESS_KEY_ID", "OTC_AWS_SECRET_ACCESS_KEY"]) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  try {
    const result = await signRequest({ method: "GET", url: "https://example.amazonaws.com/", service: "service", region: "us-east-1" });
    assert.equal(result.error, "no-aws-credentials");
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
  }
});

test("awsFetch surfaces the no-credentials case as status:0 without ever calling fetch", async () => {
  const saved = {};
  for (const k of ["AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", "AWS_CONTAINER_CREDENTIALS_FULL_URI", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "OTC_AWS_ACCESS_KEY_ID", "OTC_AWS_SECRET_ACCESS_KEY"]) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = async (...args) => { fetchCalled = true; return originalFetch(...args); };
  try {
    const result = await awsFetch("https://example.amazonaws.com/", { method: "POST", body: "x" }, { service: "service", region: "us-east-1" });
    assert.equal(result.status, 0);
    assert.equal(result.reason, "no-aws-credentials");
    assert.equal(fetchCalled, false, "must not attempt a network call when signing itself already failed");
  } finally {
    globalThis.fetch = originalFetch;
    for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
  }
});

test("awsFetch never throws on a transport failure and reports it as a distinct reason", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("simulated DNS failure"); };
  try {
    const result = await awsFetch("https://example.amazonaws.com/", { method: "POST", body: "x" }, { service: "service", region: "us-east-1", credentials: FAKE_CREDS, now: FIXED_NOW });
    assert.equal(result.status, 0);
    assert.match(result.reason, /^error-/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("awsFetch calls the SIGNED url (not a re-derived one) and never sends a body on GET", async () => {
  const originalFetch = globalThis.fetch;
  let seen = null;
  globalThis.fetch = async (url, init) => { seen = { url, init }; return { ok: true, status: 200, text: async () => '{"ok":true}' }; };
  try {
    const path = canonicalUriPath("/schedules/my-job:v2");
    const r = await awsFetch(`https://scheduler.us-east-1.amazonaws.com${path}?groupName=default`, { method: "GET" }, { service: "scheduler", region: "us-east-1", credentials: FAKE_CREDS, now: FIXED_NOW });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true });
    assert.equal(seen.url, `https://scheduler.us-east-1.amazonaws.com${path}?groupName=default`, "must fetch the exact signed url");
    assert.equal(seen.init.body, undefined, "GET must never carry a body");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
