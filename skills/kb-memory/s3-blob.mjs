// s3-blob.mjs — dependency-free (no aws-sdk) S3 object-store client for the kb-memory ledgers.
//
// WHY THIS EXISTS (2026-08-18). mem.mjs / semantic.mjs / kb-journal.mjs / blob-lease.mjs /
// ledger-archive.mjs / memory-librarian.mjs all talk to Azure Blob directly via a hand-rolled
// account-key SAS. As of today every one of those storage accounts (otchealthcommons,
// otchealthcfodata, otchealthlegalstore) has been placed into a WRITE-BLOCKED state: every PUT
// returns `403 AuthorizationPermissionMismatch`, while GET/LIST still succeed (verified live,
// 2026-08-18 — see the PR description for the three-account probe). This is NOT "the subscription
// vanished" (a prior note describing it that way is imprecise); it reads exactly like an
// account-wide read-only lock applied as an Azure-exit step, kept around so the OLD data stays
// inspectable during the cutover. Whatever the precise mechanism, the practical fact is unconditional
// and permanent from this codebase's point of view: writes never succeed there again.
//
// otchealth-mcp-server (the gateway) hit the identical wall and already built + deployed the fix:
// an S3 mirror, `src/legal/s3-blob-store.ts`, with an explicit (account, container) -> (bucket,
// keyPrefix) allow-list, `BLOB_BACKEND=s3` live in production. This file is a deliberate, faithful
// PORT of that module's S3 wire protocol (the MIRROR table, the SigV4 signing, the single-encode-only
// S3 URI quirk, the 404/403-vs-loud-failure contracts) into this repo's plain-JS, dependency-free
// style, so a write from mem.mjs and a write from the gateway's `memory_remember` land in the SAME
// physical S3 objects — one ledger, two writers, not a fork. Re-sync the MIRROR table below whenever
// otchealth-mcp-server's src/legal/s3-blob-store.ts adds/changes a row; it is the authoritative source.
//
// CREDENTIALS: reuses aws-secret.mjs's awsCreds() (ECS task role -> AWS_ACCESS_KEY_ID/SECRET ->
// OTC_AWS_ACCESS_KEY_ID/SECRET) so this file adds no NEW credential-bootstrap path. Key Vault is
// deliberately NOT consulted here for AWS keys: Key Vault itself lives in the same locked-down Azure
// estate, so an AWS-creds-from-Key-Vault fallback would be circular exactly when it is needed most.
//
// CONTRACTS (mirrors s3-blob-store.ts exactly, so callers can treat this as a drop-in):
//   getTextFromS3(account, container, path)   -> string | null (null ONLY on 404). Throws loud on
//                                                 any other failure — a 403 must never read as "empty".
//   listBlobsFromS3(account, container, prefix) -> [{name,size,lastModified,etag}] (name relative to
//                                                 the prefix). Throws on any failure OTHER than a
//                                                 clean "prefix has zero objects" 200 response.
//   putObjectToS3(account, container, path, bodyBuffer, contentType, extraHeaders?) -> {etag}. Throws
//                                                 on any non-2xx (a 412/409 conflict included — the
//                                                 caller's optimistic-concurrency loop decides what to
//                                                 do with that, same shape as condHeaders()/isConflict()
//                                                 in blobwrite.mjs).
//   s3LocationFor(account, container)         -> {bucket, keyPrefix} | null (fail-closed: an
//                                                 unmapped pair is refused, never guessed).
import { createHash, createHmac } from "node:crypto";
import { awsCreds } from "./aws-secret.mjs";

const REGION = process.env.AWS_REGION || "us-east-1";
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

// ---- the (account, container) -> (bucket, keyPrefix) allow-list -------------------------------
// Copied verbatim from otchealth-mcp-server's src/legal/s3-blob-store.ts MIRROR table (read
// 2026-08-18). Fail-closed: s3LocationFor() returns null for anything not listed here, exactly like
// the gateway's own copy, so an unmapped room is refused rather than guessed into the wrong bucket.
const MIRROR = Object.freeze({
  "otchealthlegalstore/personal": { bucket: "otchealth-legal-personal-dr-55c84f6b", keyPrefix: "otchealthlegalstore/personal/" },
  "otchealthlegalstore/company":  { bucket: "otchealth-finance-legal-dr-55c84f6b",  keyPrefix: "otchealthlegalstore/company/" },
  "otchealthlegalstore/exec":     { bucket: "otchealth-finance-legal-dr-55c84f6b",  keyPrefix: "otchealthlegalstore/exec/" },
  "otchealthcfodata/cfo-source-docs":      { bucket: "otchealth-finance-legal-dr-55c84f6b", keyPrefix: "otchealthcfodata/cfo-source-docs/" },
  "otchealthcfodata/cro-from-the-chair":   { bucket: "otchealth-finance-legal-dr-55c84f6b", keyPrefix: "otchealthcfodata/cro-from-the-chair/" },
  "otchealthcfodata/innd-stock":           { bucket: "otchealth-finance-legal-dr-55c84f6b", keyPrefix: "otchealthcfodata/innd-stock/" },
  // THE BUCKET IS brain-dr, AND THAT IS AN OBSERVED FACT, NOT AN INFERENCE. A live listing found the
  // real shared exec brain at otchealth-brain-dr-55c84f6b/otchealthcommons/company-journal/_MEMORY/
  // _exec/*.jsonl -- 29 lane files, every one the latest version, zero delete markers (cto.jsonl
  // 1,236,579 bytes, cfo.jsonl 1,956,515, clo.jsonl 932,806). An earlier version of THIS row said
  // finance-legal-dr, justified from IAM; that is the same wrong answer the gateway's own row made
  // first (mcp-server #248). ONE statement in infra/aws/iam.tf grants Get/Put/List on brain_dr AND
  // finance_legal_dr together, so IAM is structurally incapable of discriminating between them: it
  // can only ever say a write is PERMITTED, never WHERE the data is. Pick the bucket from an
  // observed object listing; use IAM only to confirm the access you need already exists.
  "otchealthcommons/company-journal":      { bucket: "otchealth-brain-dr-55c84f6b", keyPrefix: "otchealthcommons/company-journal/" },
});

/** Resolve (account, container) to its S3 mirror location, or null when unmapped. Never guesses. */
export function s3LocationFor(account, container) {
  const key = `${String(account || "").trim()}/${String(container || "").trim()}`;
  return MIRROR[key] || null;
}

// ---- SigV4 (ported from otchealth-mcp-server's src/search/sigv4.ts, S3-specific single-encode) ----
// AWS's canonical-request spec requires `!*'()` percent-encoded, which encodeURIComponent leaves
// bare. `keepSlash` controls whether '/' inside a path segment stays literal (used for the PATH,
// never for a single segment or a query value).
function rfc3986Encode(value, keepSlash) {
  let out = encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  if (keepSlash) out = out.replace(/%2F/g, "/");
  return out;
}
// S3 is AWS's ONE exception to "encode twice": each path segment is percent-encoded exactly ONCE
// both in the signature AND on the wire. Pre-encoding the key before calling this (or reusing this
// pattern for a non-S3 AWS service, e.g. the OpenSearch/'es' call sites in opensearch-write.mjs)
// silently double-encodes and produces a signature mismatch that reads as a plain 403 — the gateway
// lost ~11 finance documents to exactly this bug (space/paren filenames) before it was traced. Do
// not "fix" this to look like ssmCall()'s query-string encoding in aws-secret.mjs; that is correct
// for SSM's JSON API and wrong here.
function canonicalUri(path) {
  if (!path || path === "/") return "/";
  return path.split("/").map((seg) => rfc3986Encode(seg, false)).join("/");
}
function canonicalQueryString(query) {
  if (!query) return "";
  const pairs = Object.entries(query);
  return pairs
    .map(([k, v]) => [rfc3986Encode(k, false), rfc3986Encode(v, false)])
    .sort(([ak, av], [bk, bv]) => (ak === bk ? (av < bv ? -1 : av > bv ? 1 : 0) : ak < bk ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
}
function sha256Hex(data) { return createHash("sha256").update(data).digest("hex"); }
function hmac(key, data) { return createHmac("sha256", key).update(data).digest(); }
function deriveSigningKey(secretAccessKey, dateStamp, region, service) {
  let k = hmac(`AWS4${secretAccessKey}`, dateStamp);
  k = hmac(k, region);
  k = hmac(k, service);
  return hmac(k, "aws4_request");
}

/** Sign one S3 request. `path` is the RAW (unencoded) absolute path (`/bucket-relative-key` is NOT
 *  used here — bucket is in the virtual-hosted host, so path is just `/<key>`). `body` is a Buffer
 *  or undefined (GET/HEAD/LIST). Returns the full header set to send, including Authorization. */
function signS3(opts) {
  const { method, host, path, query, body, credentials, extraHeaders, now = new Date() } = opts;
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = body ? sha256Hex(body) : EMPTY_SHA256;
  const headers = { host, "x-amz-date": amzDate, "x-amz-content-sha256": payloadHash, ...extraHeaders };
  // NOTE: aws-secret.mjs's awsCreds() returns {ak, sk, st} (short names), NOT the
  // {accessKeyId, secretAccessKey, sessionToken} shape otchealth-mcp-server's sigv4.ts uses. Ported
  // code must use THIS repo's actual field names, not the gateway's — mismatched field names here
  // silently signed with an `undefined` access key and produced a confusing InvalidAccessKeyId 403
  // that looked exactly like a real auth failure (caught in this file's own selftest before landing).
  if (credentials.st) headers["x-amz-security-token"] = credentials.st;
  const sortedNames = Object.keys(headers).sort();
  const canonicalHeaders = sortedNames.map((n) => `${n}:${String(headers[n]).trim()}\n`).join("");
  const signedHeaders = sortedNames.join(";");
  const canonicalRequest = [method, canonicalUri(path), canonicalQueryString(query), canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = `${dateStamp}/${REGION}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
  const signingKey = deriveSigningKey(credentials.sk, dateStamp, REGION, "s3");
  const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");
  const authorization = `AWS4-HMAC-SHA256 Credential=${credentials.ak}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { ...headers, Authorization: authorization };
}

let _credsCache = null, _credsCacheAt = 0;
async function creds() {
  // awsCreds() itself is cheap/cached where it matters (ECS metadata call); this just avoids
  // re-resolving env/placeholder-guard logic on every single blob call within one process.
  const now = Date.now();
  if (_credsCache && now - _credsCacheAt < 60_000) return _credsCache;
  const c = await awsCreds();
  if (c) { _credsCache = c; _credsCacheAt = now; }
  return c;
}
/** Test-only: clear the module-level credential cache. Without this a test that changes AWS_* env
 *  vars between cases and runs within the same 60s window would keep observing an EARLIER test's
 *  resolved credentials instead of its own — the cache is correct in production (one process, real
 *  creds do not change mid-run) but actively wrong across independent test cases. Never called from
 *  non-test code. */
export function _resetCredsCacheForTests() { _credsCache = null; _credsCacheAt = 0; }

// SigV4's canonical-request algorithm requires every signed header NAME to be lowercase (AWS spec:
// "Convert all header names to lowercase"). HTTP header names are case-insensitive on the wire, so
// lowercasing here changes nothing about what the server sees, but it is NOT optional for the
// signature itself. Doing it here, once, defensively, matters concretely for this file: mem.mjs
// passes blobwrite.mjs's condHeaders(etag) straight through for conditional writes, and that shared
// helper returns Azure-style casing (`If-Match`, `If-None-Match`) because header case is irrelevant
// to Azure's SAS signing (the SAS signs a fixed query-string, never the request headers). Signing
// those names as-is here would silently produce a mismatched signature and a confusing
// SignatureDoesNotMatch 403 — exactly the failure class this migration exists to end. Lowercasing
// the keys here, rather than requiring every call site to remember to pass lowercase names, is what
// makes that impossible by construction instead of by convention.
function lowerKeys(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) out[k.toLowerCase()] = v;
  return out;
}

async function s3Request({ method, loc, path, query, body, contentType, extraHeaders }) {
  const credentials = await creds();
  if (!credentials) throw new Error("s3-blob: AWS credentials unavailable (checked the ECS task role, AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY, and OTC_AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY)");
  const host = `${loc.bucket}.s3.${REGION}.amazonaws.com`;
  const rawPath = `/${loc.keyPrefix}${path}`;
  const signHeaders = { ...(contentType ? { "content-type": contentType } : {}), ...lowerKeys(extraHeaders) };
  const headers = signS3({ method, host, path: rawPath, query, body, credentials, extraHeaders: signHeaders });
  const url = query ? `https://${host}${canonicalUri(rawPath)}?${canonicalQueryString(query)}` : `https://${host}${canonicalUri(rawPath)}`;
  return fetch(url, { method, headers, ...(body ? { body } : {}) });
}

function locOrThrow(account, container) {
  const loc = s3LocationFor(account, container);
  if (!loc) throw new Error(`s3-blob: no S3 mirror mapping for ${account}/${container} (refusing to guess a bucket)`);
  return loc;
}

/** Fetch one object's {text, etag}. Both null ONLY on a genuine 404. Throws (loud) on anything else
 *  — a 403 must never be reported as "the file is empty / does not exist", the exact failure this
 *  migration exists to close. The ETag rides along on the SAME GET response (S3 always returns it),
 *  so a caller that needs it for a conditional PUT (mem.mjs's commitAppend) does not need a second
 *  HEAD round-trip. */
export async function getTextMetaFromS3(account, container, path) {
  const loc = locOrThrow(account, container);
  const r = await s3Request({ method: "GET", loc, path });
  if (r.status === 404) return { text: null, etag: null };
  if (!r.ok) throw new Error(`s3 get ${r.status} (refusing to report a missing object as empty): ${(await r.text()).slice(0, 200)}`);
  return { text: await r.text(), etag: r.headers.get("etag") };
}

/** Fetch one object's text only. null ONLY on a genuine 404. Same loud-on-failure contract as
 *  getTextMetaFromS3; a thin convenience wrapper for callers that never need the ETag. */
export async function getTextFromS3(account, container, path) {
  return (await getTextMetaFromS3(account, container, path)).text;
}

/** PUT one object. `extraHeaders` carries S3 conditional-write headers (`If-Match`/`If-None-Match`,
 *  the SAME names blobwrite.mjs's condHeaders() already produces for Azure — S3 supports both
 *  natively since AWS's August-2024 conditional-writes release). Returns {etag}. Throws on every
 *  non-2xx; the caller (mem.mjs's commitAppend retry loop) is what turns a 412 into a reload+retry,
 *  never this function silently swallowing it. */
export async function putObjectToS3(account, container, path, body, contentType, extraHeaders) {
  const loc = locOrThrow(account, container);
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), "utf8");
  const r = await s3Request({ method: "PUT", loc, path, body: buf, contentType, extraHeaders });
  if (!r.ok) {
    const status = r.status;
    const text = (await r.text().catch(() => "")).slice(0, 200);
    const err = new Error(`s3 put ${status}: ${text}`);
    err.status = status;
    throw err;
  }
  return { etag: r.headers.get("etag") };
}

/** LIST objects under a prefix (relative to the mirror's own keyPrefix). Returns names RELATIVE to
 *  `prefix` is NOT stripped — names are relative to loc.keyPrefix, matching Azure's listing shape so
 *  callers need no branch. Throws on any non-2xx; an empty result set is a normal 200 with zero
 *  <Contents>, never confused with a failed call the way the old `if (!r.ok) break` pattern did. */
export async function listBlobsFromS3(account, container, prefix) {
  const loc = locOrThrow(account, container);
  const out = [];
  let token = null;
  for (let page = 0; page < 200; page++) {
    const query = { "list-type": "2", "max-keys": "1000", prefix: `${loc.keyPrefix}${prefix || ""}` };
    if (token) query["continuation-token"] = token;
    const credentials = await creds();
    if (!credentials) throw new Error("s3-blob: AWS credentials unavailable for list");
    const host = `${loc.bucket}.s3.${REGION}.amazonaws.com`;
    const headers = signS3({ method: "GET", host, path: "/", query, credentials, extraHeaders: {} });
    const r = await fetch(`https://${host}/?${canonicalQueryString(query)}`, { headers });
    if (!r.ok) throw new Error(`s3 list ${r.status} (refusing to report a failed listing as empty): ${(await r.text()).slice(0, 200)}`);
    const xml = await r.text();
    for (const m of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) {
      const full = m[1];
      if (full.startsWith(loc.keyPrefix)) out.push(full.slice(loc.keyPrefix.length));
    }
    const isTruncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
    token = isTruncated ? (xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/) || [])[1] || null : null;
    if (!token) break;
  }
  return out;
}

/** True when the S3 credential chain resolves (ECS role / env / OTC_AWS_* — see aws-secret.mjs).
 *  Cheap, no network beyond what awsCreds() itself does. */
export async function s3Configured() {
  return (await creds()) !== null;
}
