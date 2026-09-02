// sigv4.mjs -- ONE shared AWS SigV4 request signer for the whole toolkit.
//
// WHY THIS EXISTS (FND-20260828-5ca1, severity medium, still open): a fleet audit found FIVE
// independent hand-rolled SigV4 implementations already in this repo --
//   skills/kb-memory/aws-secret.mjs (ssmCall, the SSM JSON-1.1 caller)
//   skills/kb-memory/s3-blob.mjs
//   skills/fleet-backup/s3-client.mjs
//   skills/doc-indexer/opensearch-client.mjs
//   skills/aws-image-canary/image-canary.mjs (and skills/aws-dr-canary/canary.mjs, skills/legal-
//     deadline-pager/pager.mjs, skills/cutover-preflight/preflight.mjs carry close variants too)
// -- with two contradictory canonical-header-encoding conventions between them (compare
// aws-secret.mjs's `hh` object, whose keys are hand-written lowercase and never re-cased, against
// image-canary.mjs's `extra` handling, which lowercases keys defensively). The finding asks for a
// shared extraction point BEFORE the next SigV4-shaped caller lands, so the fleet stops growing a
// sixth (seventh, ...) copy.
//
// THIS FILE DOES NOT REFACTOR THE EXISTING FIVE. Each is load-bearing production code with its own
// test coverage and its own service-specific quirks (S3's optional streaming payload hash, OpenSearch's
// index-routing paths); collapsing them onto a shared signer is a real, separately-reviewable change
// with real regression risk, not a rider on an unrelated feature PR. This file is the extraction POINT
// the finding asks for: skills/safety-monitor/monitor.mjs's SNS publish call is its first consumer.
// The next new SigV4 caller should import from here; a future dedicated PR can migrate the existing
// five once each is verified from a paused pipeline (see the finding's own note: "before bedrock-client
// lands; publish merge-order epic").
//
// Dependency-free: hand-rolled HMAC-SHA256 chain via node:crypto, exactly the algorithm every one of
// the five existing implementations already uses (AWS Signature Version 4 -- see
// https://docs.aws.amazon.com/general/latest/gr/sigv4-signing.html). No aws-sdk.
//
// Credentials come from awsCreds() in ./aws-secret.mjs -- the SAME resolver every AWS-touching skill
// in this repo already shares (ECS task role first, then AWS_ACCESS_KEY_ID/SECRET, then the
// OTC_AWS_-prefixed sandbox-safe fallback). This file adds no new credential path.

import crypto from "node:crypto";
import { awsCreds } from "./aws-secret.mjs";

const sha256Hex = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const hmac = (key, data) => crypto.createHmac("sha256", key).update(data).digest();

/**
 * Derive the final SigV4 signing key via the standard 4-step HMAC chain, exactly as specified in AWS's
 * own documentation ("Derive a signing key", https://docs.aws.amazon.com/IAM/latest/UserGuide/
 * reference_sigv-create-signed-request.html, fetched and quoted verbatim 2026-09-02):
 *   DateKey = HMAC-SHA256("AWS4"+Key, Date)
 *   DateRegionKey = HMAC-SHA256(DateKey, Region)
 *   DateRegionServiceKey = HMAC-SHA256(DateRegionKey, Service)
 *   SigningKey = HMAC-SHA256(DateRegionServiceKey, "aws4_request")
 * Exported (not just inlined in signAwsRequest below) so ../tests/sigv4.test.mjs can differential-test
 * it against a SECOND, independently-written implementation of that same published formula (rather
 * than a single hardcoded "known-good" hex constant -- an earlier draft of this file tried exactly
 * that, using a value recalled from memory; it did not match this implementation's output, and a live
 * web search meant to confirm the "correct" value instead surfaced a source that had silently
 * corrupted a character in the secret key AND produced a 65-hex-character digest for what must be a
 * 64-character SHA-256 HMAC, i.e. the search result was ALSO wrong. A single unverifiable magic
 * constant is worse than no such test at all -- it can only ever tell you your code disagrees with a
 * string you cannot actually prove is right. Two independent readings of the SAME live-quoted
 * specification, agreeing across many varied inputs, is real evidence).
 *
 * @returns {Buffer} the raw signing key (callers needing hex call .toString("hex"))
 */
export function deriveSigningKey({ secretKey, dateStamp, region, service }) {
  let k = hmac(`AWS4${secretKey}`, dateStamp);
  k = hmac(k, region);
  k = hmac(k, service);
  k = hmac(k, "aws4_request");
  return k;
}

// AWS's URI-encoding rule for SigV4 canonical query strings and path segments is STRICTER than
// encodeURIComponent(): RFC 3986 unreserved characters are A-Z a-z 0-9 - _ . ~, and everything else
// (including !, *, ', (, ) -- which encodeURIComponent leaves UNESCAPED, a well-known JS footgun for
// SigV4) must be percent-encoded, uppercase hex, and space must become %20 (never +). Getting this
// wrong produces a signature AWS silently recomputes differently, which surfaces as a 403 that reads
// exactly like "wrong credentials" -- see image-canary.mjs's own comment on the same class of bug for
// the query-string ordering half of this; this is the encoding half.
function awsUriEncode(str) {
  return encodeURIComponent(String(str)).replace(/[!*'()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * Build a SigV4 canonical query string from a plain key/value object: URI-encode every key and
 * value per awsUriEncode(), then sort entries by encoded key (byte order, which `.sort()` on strings
 * already gives for this character set). Returns "" for an empty/absent object. A caller that already
 * has a pre-encoded, pre-sorted query string (the shape every existing hand-rolled caller in this repo
 * uses) may pass that string directly to signAwsRequest()'s `query` instead -- this helper exists for
 * a caller building a query from structured params, so it does not have to hand-roll the encoding
 * rules above itself.
 */
export function canonicalQueryString(params) {
  if (!params) return "";
  const entries = Object.entries(params).map(([k, v]) => [awsUriEncode(k), awsUriEncode(v)]);
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return entries.map(([k, v]) => `${k}=${v}`).join("&");
}

/**
 * Sign an AWS request with SigV4 and return the headers to send alongside it. Pure/no network --
 * awsRequest() below does the actual fetch. Accepts a pre-resolved `creds` (mainly for tests, which
 * need a deterministic signature from fixed inputs and must not depend on this sandbox's real AWS
 * credential resolution) or resolves them itself via awsCreds() when omitted.
 *
 * @param {object} opts
 * @param {string} opts.method   HTTP method, e.g. "POST", "GET"
 * @param {string} opts.service  AWS service signing name, e.g. "sns", "ssm", "s3"
 * @param {string} opts.region   AWS region, e.g. "us-east-1"
 * @param {string} opts.host     request host, e.g. "sns.us-east-1.amazonaws.com"
 * @param {string} [opts.path]   URL path, default "/". Passed through AS-IS (not re-encoded) --
 *                                callers with reserved characters in the path should pre-encode it;
 *                                every current caller's paths are static ASCII.
 * @param {string} [opts.query]  a canonical query string (already encoded+sorted -- see
 *                                canonicalQueryString() above to build one from an object), default ""
 * @param {object} [opts.headers] extra headers to sign, e.g. { "content-type": "application/x-www-form-urlencoded" }.
 *                                Keys are lowercased before signing (header NAME case never affects
 *                                HTTP semantics, but SigV4's canonical form requires lowercase).
 * @param {string} [opts.body]   request body whose SHA-256 is signed (default "" -- the documented
 *                                SHA-256 of an empty string, correct for bodyless GET/HEAD requests)
 * @param {Date}   [opts.now]    clock override for deterministic tests; default `new Date()`
 * @param {object} [opts.creds]  pre-resolved { ak, sk, st } to skip calling awsCreds() again
 * @returns {Promise<{ headers: object } | { error: string }>} `error` is "no-aws-credentials" when
 *          neither `creds` nor awsCreds() yields anything -- never throws.
 */
export async function signAwsRequest({ method, service, region, host, path = "/", query = "", headers = {}, body = "", now, creds: presetCreds }) {
  const creds = presetCreds || (await awsCreds());
  if (!creds) return { error: "no-aws-credentials" };

  const amzDate = (now || new Date()).toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);

  const lower = { host: host.toLowerCase(), "x-amz-date": amzDate };
  if (creds.st) lower["x-amz-security-token"] = creds.st;
  // AWS canonicalization trims a header value AND collapses runs of internal whitespace to a single
  // space. Trimming alone signs "a:  b   c" as-is while AWS canonicalizes it to "a:b c", so the two
  // sides compute different signatures and the request fails to authenticate for a reason the error
  // never names. SCOPE, stated rather than implied: the spec exempts whitespace inside a quoted
  // string, which this does not model. No caller passes a quoted-string header value today (the
  // signed set is host, x-amz-date, content-type and x-amz-security-token), and collapsing is
  // strictly closer to the spec than trimming alone for every value that is not quoted.
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = String(v).trim().replace(/\s+/g, " ");

  const signedKeys = Object.keys(lower).sort();
  const canonicalHeaders = signedKeys.map((k) => `${k}:${lower[k]}\n`).join("");
  const signedHeaders = signedKeys.join(";");

  const canonicalRequest = [method, path, query, canonicalHeaders, signedHeaders, sha256Hex(body)].join("\n");
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");

  const signingKey = deriveSigningKey({ secretKey: creds.sk, dateStamp, region, service });
  const signature = hmac(signingKey, stringToSign).toString("hex");

  const authorization = `AWS4-HMAC-SHA256 Credential=${creds.ak}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const outHeaders = { ...lower, authorization };
  delete outHeaders.host; // fetch() sets the real Host header itself; resending it is redundant, not wrong, but omitting keeps the header set exactly the signed set plus Authorization
  return { headers: outHeaders };
}

/**
 * Sign AND perform an AWS request. Never throws -- every failure (no credentials, network error,
 * non-2xx) comes back as a normal return value so a caller's own fail-loud logic decides what "loud"
 * means for it (this file has no opinion on logging or exit codes).
 *
 * @returns {Promise<{ status: number, text: string|null, json: object|null, reason: string|null }>}
 *          `reason` is null on any 2xx; on failure it is "no-aws-credentials", "http-<code>", or
 *          "error-<message>" (transport failure) -- the same three-shape convention
 *          ssmSecretDetailed()/ssmCall() in aws-secret.mjs already use, so a caller already familiar
 *          with that shape needs nothing new here.
 */
export async function awsRequest({ method, service, region, host, path = "/", query = "", headers = {}, body = "" }) {
  const signed = await signAwsRequest({ method, service, region, host, path, query, headers, body });
  if (signed.error) return { status: 0, text: null, json: null, reason: signed.error };
  try {
    const url = `https://${host}${path}${query ? `?${query}` : ""}`;
    const r = await fetch(url, {
      method,
      headers: signed.headers,
      body: method === "GET" || method === "HEAD" ? undefined : body,
    });
    const text = await r.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null; // non-JSON bodies (e.g. SNS's XML responses) are legitimate; callers read `text`
    }
    return { status: r.status, text, json, reason: r.ok ? null : `http-${r.status}` };
  } catch (e) {
    return { status: 0, text: null, json: null, reason: `error-${String((e && e.message) || e)}` };
  }
}
