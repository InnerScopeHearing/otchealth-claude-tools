// aws-sigv4.mjs -- ONE shared AWS SigV4 request signer for the toolkit (FND-20260828-5ca1).
//
// THE FINDING: a fleet audit found the SigV4 algorithm hand-rolled independently in at least NINE
// places (`grep -rln "AWS4-HMAC-SHA256\|aws4_request" skills/ setup/`, run fresh 2026-09-02 --
// the finding's own count of "five" undercounts the current repo, see the "SCOPE" section below):
//   skills/kb-memory/aws-secret.mjs          (ssmCall -- SSM JSON-1.1)
//   skills/kb-memory/s3-blob.mjs             (S3 GET/PUT/LIST)
//   skills/fleet-backup/s3-client.mjs        (a SECOND, independent S3 client)
//   skills/doc-indexer/opensearch-client.mjs (OpenSearch + Bedrock)
//   skills/aws-image-canary/image-canary.mjs (EventBridge Scheduler, ECS, ECR)
//   skills/cutover-preflight/preflight.mjs   (ECS, S3, OpenSearch, RDS-adjacent checks)
//   skills/aws-jobs-migration/inventory-aws-jobs.mjs      (EventBridge Scheduler)
//   skills/aws-jobs-migration/build-missing-schedules.mjs (ECS, EventBridge Scheduler)
//   skills/aws-dr-canary/canary.mjs          (RDS, Lightsail)
// -- with (at least) TWO contradictory URI-encoding conventions between them. There is ALSO a
// pre-existing partial extraction, skills/kb-memory/sigv4.mjs (built for this same finding, one
// consumer: skills/safety-monitor/monitor.mjs's SNS publish), which is narrower than this file (it
// takes host/path/query separately and passes `path` through unencoded "for callers with static ASCII
// paths") and does not implement the double-vs-single-encode rule this file exists to fix. See "SCOPE"
// below for why it is deliberately NOT touched here.
//
// THE BUG, CONCRETELY (this is "which of the old implementations was wrong and why"): AWS's own
// published algorithm (https://docs.aws.amazon.com/general/latest/gr/create-signed-request.html,
// "Task 1: Create a canonical request", step 1, quoted 2026-09-02) requires the CANONICAL (signature)
// URI to be built by URI-encoding the ABSOLUTE PATH a SECOND time for every service EXCEPT S3, which
// is the one documented exception (its canonical URI is the SAME single-encoded string sent on the
// wire). Four of the nine -- image-canary.mjs, preflight.mjs, inventory-aws-jobs.mjs, and
// build-missing-schedules.mjs -- sign EventBridge Scheduler REST paths (`/schedules/<name>`) with the
// exact same singly-encoded string used for both the wire URL and the signature, i.e. they never apply
// the double-encode step at all. This is LATENT, not yet observed as a failure: every schedule name in
// this fleet is letters/digits/hyphens, which round-trips identically whether encoded once or twice
// (encodeURIComponent is idempotent on an already-unreserved string), so the gap has produced no
// SignatureDoesNotMatch yet -- exactly the same shape opensearch-client.mjs's own 2026-08-28 fix
// documents for its `service:"bedrock"` case ("made no observable difference... until a Bedrock model
// id's `:` and `.`"). A schedule/resource name containing a colon, period, or any other
// percent-encoded-on-the-second-pass character would silently break these four callers today. The two
// S3 implementations (s3-blob.mjs, fleet-backup/s3-client.mjs) get the single-encode rule RIGHT
// independently of each other and of this file; opensearch-client.mjs's 2026-08-28 fix already
// implements the double-encode rule correctly for its own two service names. Neither class was
// "wrong" -- the four EventBridge Scheduler callers were.
//
// THE FIX: RFC 3986 unreserved-set percent-encoding (`rfc3986Encode`), applied per PATH SEGMENT
// (`canonicalUriPath`, '/' kept literal as the segment separator), with the wire path double-encoded
// again for the SIGNATURE ONLY when `service !== "s3"` -- never sent on the wire, only used to compute
// the Authorization header, exactly mirroring opensearch-client.mjs's own `doubleEncodeUri()`. Query
// parameters are sorted by encoded key then encoded value and are NEVER double-encoded (AWS's
// double-encode rule is a path-only quirk; every existing implementation already agrees on this).
//
// REDACTION (Matt's standing "no secret value in a log" rule; the concrete incident is
// otchealth-mcp-server PR #256, and skills/kb-memory/tests/kvsecret-ssm-sole-path.test.mjs's
// "sink redaction" tests pin the same class for this file's neighbours): the signed Authorization
// header is returned lower-cased (`authorization`, not `Authorization`), matching every existing
// implementation's convention and the shape skills/kb-memory/redact.mjs's
// `AWS4-HMAC-SHA256\s+Credential=...` rule (and azure-secret.mjs's `safeDetail()`) already scrub for.
// This file never logs a header itself; it only returns them, so the discipline is on every CALLER:
// never let a raw fetch/execFile rejection (which can embed a full request line, Authorization
// included) reach a log or a persisted artifact unredacted -- run it through redactSecrets()/
// safeDetail() first, the same pattern src/eval/redact.mjs and azure-secret.mjs already establish.
//
// CREDENTIALS: resolves via ../skills/kb-memory/aws-secret.mjs's awsCreds() (the SAME resolver this
// whole repo already shares -- ECS task-role container-credentials endpoint first, then
// AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY/AWS_SESSION_TOKEN, then the OTC_AWS_-prefixed sandbox-safe
// fallback) ONLY when a caller does not pass its own `credentials`. This file adds NO new credential
// path and does not change WHO any migrated caller authenticates as: every migrated call site below
// still resolves its OWN credentials exactly as it did before (several use a distinct, deliberately
// broader `aws-cto-*` operator key rather than the generic chain) and passes them in explicitly --
// only the SIGNING MATH is centralized here, never credential sourcing.
//
// SCOPE (deliberate, not an oversight -- flagged in the PR for the reviewer): this PR migrates SIX of
// the nine hand-rolled implementations onto this file --
//   skills/kb-memory/aws-secret.mjs's ssmCall, skills/aws-dr-canary/canary.mjs's RDS + Lightsail
//   signers, skills/aws-image-canary/image-canary.mjs's awsRequest, skills/cutover-preflight/
//   preflight.mjs's aws(), skills/aws-jobs-migration/{inventory-aws-jobs,build-missing-schedules}.mjs's
//   awsCall.
// The remaining THREE -- skills/kb-memory/s3-blob.mjs, skills/fleet-backup/s3-client.mjs, and
// skills/doc-indexer/opensearch-client.mjs -- are deliberately NOT migrated here: each is already
// CORRECT (verified above), each carries its own comprehensive, currently-100%-green test suite, and
// all three are exercised TOGETHER by a cross-file fetch-stubbing integration test
// (tests/aws-dr-canary.test.mjs's checkOneBrainRoomFreshness() suite). Migrating an already-correct,
// heavily-tested, safety/DR-relevant implementation for zero new correctness value is a worse
// risk/reward trade than migrating the four implementations that were actually wrong plus the two that
// were trivially unaffected (SSM and RDS always sign a bare "/" path, so the encoding question is
// moot for them, making their migration a pure, low-risk refactor that still proves this file out on a
// "real" caller). Unifying those three with this file -- and reconciling this file with the
// pre-existing skills/kb-memory/sigv4.mjs -- is exactly the "future dedicated PR... once each is
// verified from a paused pipeline" sigv4.mjs's own header already calls for; this PR does not attempt
// it. Do not treat this file's existence as license to add a TENTH hand-rolled implementation instead
// of importing from here.
import crypto from "node:crypto";
import { awsCreds } from "../skills/kb-memory/aws-secret.mjs";

function sha256Hex(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}
function hmac(key, data) {
  return crypto.createHmac("sha256", key).update(data).digest();
}

/**
 * Derive the final SigV4 signing key via AWS's documented 4-step HMAC chain:
 *   DateKey = HMAC-SHA256("AWS4"+Key, Date)
 *   DateRegionKey = HMAC-SHA256(DateKey, Region)
 *   DateRegionServiceKey = HMAC-SHA256(DateRegionKey, Service)
 *   SigningKey = HMAC-SHA256(DateRegionServiceKey, "aws4_request")
 * @returns {Buffer} the raw signing key
 */
export function deriveSigningKey({ secretKey, dateStamp, region, service }) {
  let k = hmac(`AWS4${secretKey}`, dateStamp);
  k = hmac(k, region);
  k = hmac(k, service);
  return hmac(k, "aws4_request");
}

// AWS's canonical-request URI-encoding rule is STRICTER than encodeURIComponent(): the RFC 3986
// unreserved set is A-Z a-z 0-9 - _ . ~ ONLY, so `! * ' ( )` -- which encodeURIComponent leaves
// UNESCAPED, a well-known JS footgun for SigV4 -- must also be percent-encoded, uppercase hex.
export function rfc3986Encode(value) {
  return encodeURIComponent(String(value)).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * Canonicalize a URI path per SigV4: each '/'-separated segment individually percent-encoded, the
 * separators themselves kept literal. An empty/absent path, or exactly "/", canonicalizes to "/".
 * This is the SINGLE encoding pass every service (S3 included) sends on the wire.
 */
export function canonicalUriPath(path) {
  if (!path || path === "/") return "/";
  return path.split("/").map(rfc3986Encode).join("/");
}

/**
 * The signature-only SECOND encoding pass AWS requires for every service except S3 (see this file's
 * header for the citation and the concrete bug this closes). Takes the ALREADY singly-encoded wire
 * path and re-encodes it -- a literal '%' from the first pass becomes '%25' on this pass, which is
 * exactly the double-encode AWS's spec describes. NEVER call this on a raw/undecoded path; it must
 * only ever be applied to canonicalUriPath()'s own output, mirroring opensearch-client.mjs's
 * `doubleEncodeUri(path) { return canonicalUri(canonicalUri(path)); }`.
 */
export function doubleEncodeUriPath(wireUri) {
  return canonicalUriPath(wireUri);
}

function signingUriFor(wireUri, service) {
  return service === "s3" ? wireUri : doubleEncodeUriPath(wireUri);
}

/**
 * Build a SigV4 canonical query string. Accepts a URLSearchParams instance (what signRequest()/
 * awsFetch() pass internally, decoded straight off the caller's URL) or a plain {key: value} object
 * (for a caller building one directly, or a test). Every key/value is RFC-3986-encoded and pairs are
 * sorted by encoded key, ties broken by encoded value -- AWS's documented rule, unconditional on
 * service (the double-encode quirk above is a PATH-only concept; no implementation in this repo
 * applies it to the query string, and neither does this one). Returns "" for no params.
 */
export function canonicalQueryString(params) {
  const pairs = [];
  if (params instanceof URLSearchParams) {
    for (const [k, v] of params.entries()) pairs.push([k, v]);
  } else if (params && typeof params === "object") {
    for (const [k, v] of Object.entries(params)) pairs.push([k, v]);
  }
  if (!pairs.length) return "";
  const encoded = pairs.map(([k, v]) => [rfc3986Encode(k), rfc3986Encode(v)]);
  encoded.sort(([ak, av], [bk, bv]) => (ak === bk ? (av < bv ? -1 : av > bv ? 1 : 0) : ak < bk ? -1 : 1));
  return encoded.map(([k, v]) => `${k}=${v}`).join("&");
}

// Normalizes the two credential shapes already live in this repo: awsCreds()'s own {ak, sk, st}
// (aws-secret.mjs, sigv4.mjs) and the {accessKeyId, secretAccessKey, sessionToken} shape several
// migrated callers already build by hand (opensearch-client.mjs's cfg, s3-client.mjs's creds). Either
// is accepted with no remapping required at the call site.
function normalizeCreds(creds) {
  const accessKeyId = creds.accessKeyId ?? creds.ak;
  const secretAccessKey = creds.secretAccessKey ?? creds.sk;
  const sessionToken = creds.sessionToken ?? creds.st ?? null;
  return { accessKeyId, secretAccessKey, sessionToken };
}

/**
 * Sign an AWS request and return the headers to send PLUS the exact wire URL those headers were
 * signed against (path/query re-canonicalized -- a caller must fetch THIS url, never re-derive its
 * own, or the signature it just computed will not match the request it sends).
 *
 * @param {object} opts
 * @param {string} opts.method        HTTP method, e.g. "POST", "GET"
 * @param {string} opts.url           full absolute URL, e.g. "https://scheduler.us-east-1.amazonaws.com/schedules/my-job?groupName=default".
 *                                     The PATH must already be correctly percent-encoded by the caller
 *                                     (use canonicalUriPath() on a raw key/name first if it may contain
 *                                     anything beyond the RFC 3986 unreserved set) -- this function
 *                                     trusts `new URL(opts.url).pathname` as the wire truth and never
 *                                     re-derives it from decoded segments, so an already-correct path
 *                                     round-trips byte-for-byte. The QUERY portion, by contrast, is
 *                                     safely decoded via URLSearchParams and re-canonicalized (sorted +
 *                                     re-encoded) here, which is fine for every AWS query parameter
 *                                     this repo signs (none are S3-object-key-shaped).
 * @param {object} [opts.headers]     extra headers to sign, e.g. { "content-type": "application/json" }.
 *                                     Keys are lowercased before signing.
 * @param {string|Buffer} [opts.body] request body whose SHA-256 is signed (default "").
 * @param {string} opts.service       AWS signing service name, e.g. "scheduler", "ssm", "s3", "rds".
 * @param {string} opts.region        AWS region, e.g. "us-east-1".
 * @param {object} [opts.credentials] pre-resolved credentials ({ak,sk,st} or {accessKeyId,
 *                                     secretAccessKey,sessionToken}); resolves via awsCreds() when omitted.
 * @param {Date}   [opts.now]         clock override for deterministic tests; default `new Date()`.
 * @returns {Promise<{headers: object, url: string} | {error: string}>} `error` is "no-aws-credentials"
 *          when neither `credentials` nor awsCreds() yields anything -- never throws.
 */
export async function signRequest({ method, url, headers = {}, body = "", service, region, credentials, now }) {
  const rawCreds = credentials || (await awsCreds());
  if (!rawCreds) return { error: "no-aws-credentials" };
  const creds = normalizeCreds(rawCreds);

  const u = new URL(url);
  const wireUri = u.pathname || "/";
  const signingUri = signingUriFor(wireUri, service);
  const canonicalQuery = canonicalQueryString(u.searchParams);

  const d = now || new Date();
  const amzDate = d.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);

  const lower = { host: u.host.toLowerCase(), "x-amz-date": amzDate };
  if (service === "s3") lower["x-amz-content-sha256"] = sha256Hex(body); // S3 rejects a request without this signed; other services ignore it.
  if (creds.sessionToken) lower["x-amz-security-token"] = creds.sessionToken;
  // AWS canonicalization trims a header value AND collapses runs of internal whitespace to a single
  // space -- trimming alone signs "a:  b   c" as-is while AWS canonicalizes it to "a:b c", which
  // computes two different signatures for the same logical request.
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = String(v).trim().replace(/\s+/g, " ");

  const signedKeys = Object.keys(lower).sort();
  const canonicalHeaders = signedKeys.map((k) => `${k}:${lower[k]}\n`).join("");
  const signedHeaders = signedKeys.join(";");
  const bodyHash = sha256Hex(body);

  const canonicalRequest = [method, signingUri, canonicalQuery, canonicalHeaders, signedHeaders, bodyHash].join("\n");
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");

  const signingKey = deriveSigningKey({ secretKey: creds.secretAccessKey, dateStamp, region, service });
  const signature = hmac(signingKey, stringToSign).toString("hex");

  const authorization = `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const outHeaders = { ...lower, authorization };
  delete outHeaders.host; // fetch() sets the real Host header itself from the URL's authority -- the exact value just signed.

  const wireUrl = `${u.protocol}//${u.host}${wireUri}${canonicalQuery ? `?${canonicalQuery}` : ""}`;
  return { headers: outHeaders, url: wireUrl };
}

/**
 * Sign AND perform an AWS request. Never throws -- every failure (no credentials, network error,
 * non-2xx) comes back as a normal return value, the same three-shape convention
 * (status/text/json/reason) skills/kb-memory/sigv4.mjs's awsRequest() and aws-secret.mjs's ssmCall()
 * already use, so a caller already familiar with either needs nothing new here.
 *
 * @param {string} url    full absolute URL (see signRequest()'s `url` doc for the path/query contract)
 * @param {object} [init] { method, headers, body } -- the same shape fetch()'s own `init` takes.
 * @param {object} opts   { service, region, credentials, now } -- signing parameters (see signRequest()).
 * @returns {Promise<{ status: number, text: string|null, json: object|null, reason: string|null }>}
 */
export async function awsFetch(url, init = {}, { service, region, credentials, now } = {}) {
  const method = (init.method || "GET").toUpperCase();
  const signed = await signRequest({ method, url, headers: init.headers || {}, body: init.body || "", service, region, credentials, now });
  if (signed.error) return { status: 0, text: null, json: null, reason: signed.error };
  try {
    const r = await fetch(signed.url, {
      method,
      headers: signed.headers,
      body: method === "GET" || method === "HEAD" ? undefined : init.body,
    });
    const text = await r.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null; // non-JSON bodies (e.g. RDS's XML responses) are legitimate; callers read `text`
    }
    return { status: r.status, text, json, reason: r.ok ? null : `http-${r.status}` };
  } catch (e) {
    return { status: 0, text: null, json: null, reason: `error-${String((e && e.message) || e)}` };
  }
}
