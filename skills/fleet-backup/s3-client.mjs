// s3-client.mjs — minimal, dependency-free AWS S3 client (PutObject / HeadObject / GetObject only),
// signed with AWS Signature Version 4 implemented directly via node:crypto. No aws-sdk dependency —
// matches the fleet's "built-in fetch + node:crypto, no vendor SDK" convention (see
// skills/fleet-backup/backup.mjs and skills/amazon-sp-api/sp-api.mjs for the same style).
//
// Deliberately narrow: only the three S3 object operations the DR mirror needs. There is NO
// ListObjects/ListBucket call in this file, on purpose — the recommended IAM policy for the aws-dr-*
// credential (see README.md) is PutObject + GetObject + HeadObject scoped to the two DR buckets ONLY,
// nothing broader. Every "what blobs exist" decision in this skill is driven from the AZURE side (list
// the source container via azure-blob-client.mjs), never by asking S3 to enumerate itself, so the AWS
// credential never needs s3:ListBucket.
//
// Credentials + bucket + region are passed in explicitly per call (a `creds` object: accessKeyId,
// secretAccessKey, bucket, region) rather than read from env/Key Vault in this file, so a caller can
// hold TWO independent credential sets in memory at once — the non-privileged DR bucket, and, opt-in
// only, the separate privileged DR bucket — with no global/module-level credential state that could
// accidentally cross-wire the two.
//
// CAVEAT (documented, not handled): bucket names containing a literal "." break virtual-hosted-style
// HTTPS (TLS SNI/certificate wildcard mismatch — `*.s3.<region>.amazonaws.com` does not match
// `my.bucket.name.s3.<region>.amazonaws.com`). Provision the aws-dr-*-s3-bucket names WITHOUT dots.

import crypto from "node:crypto";

export function sha256Hex(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}
const EMPTY_SHA256 = sha256Hex(Buffer.alloc(0));

function hmac(key, data) {
  return crypto.createHmac("sha256", key).update(data, "utf8").digest();
}

// AWS's canonical URI-encoding rule: percent-encode every byte except unreserved (A-Z a-z 0-9 - . _ ~),
// uppercase hex, operating on the RAW UTF-8 bytes so multi-byte characters encode correctly one byte
// at a time (this is the #1 source of SigV4 "SignatureDoesNotMatch" bugs when done wrong).
function awsEncode(str) {
  const bytes = Buffer.from(str, "utf8");
  let out = "";
  for (const byte of bytes) {
    const ch = String.fromCharCode(byte);
    if (/[A-Za-z0-9\-._~]/.test(ch)) out += ch;
    else out += "%" + byte.toString(16).toUpperCase().padStart(2, "0");
  }
  return out;
}
// Canonical URI path: encode each segment, keep '/' separators literal (S3 keys may contain '/').
function canonicalPath(key) {
  return "/" + key.split("/").map(awsEncode).join("/");
}

/** Build the signed request (URL + headers) for one S3 object call. Returns null-free; throws only if
 *  creds/key are structurally missing (callers already gate on creds presence before calling in). */
function sigv4(creds, { method, key, headers, payloadHashHex }) {
  const host = `${creds.bucket}.s3.${creds.region}.amazonaws.com`;
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ""); // YYYYMMDDTHHMMSSZ
  const dateStamp = amzDate.slice(0, 8);

  // Normalize ALL header names to lowercase up front, once, and sign/send from that SAME map — this
  // avoids any case-mismatch between the canonical header block and the headers actually sent, which
  // is the second classic SigV4 bug (the first is URI encoding, above).
  const norm = {};
  for (const [k, v] of Object.entries(headers || {})) norm[k.toLowerCase()] = String(v);
  norm.host = host;
  norm["x-amz-content-sha256"] = payloadHashHex;
  norm["x-amz-date"] = amzDate;

  const sortedNames = Object.keys(norm).sort();
  const canonicalHeaders = sortedNames.map((k) => `${k}:${norm[k].trim()}\n`).join("");
  const signedHeaders = sortedNames.join(";");
  const canonicalRequest = [method, canonicalPath(key), "", canonicalHeaders, signedHeaders, payloadHashHex].join("\n");

  const region = creds.region;
  const service = "s3";
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, credentialScope, sha256Hex(Buffer.from(canonicalRequest, "utf8"))].join("\n");

  const kDate = hmac(`AWS4${creds.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, "aws4_request");
  const signature = hmac(kSigning, stringToSign).toString("hex");

  const authorization = `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  // fetchHeaders = the SAME normalized map (guarantees byte-identical values between what was signed
  // and what is sent), MINUS "host" — the HTTP client sets Host from the URL's authority itself, which
  // is exactly the value we signed, so re-setting it manually is unnecessary and some fetch
  // implementations treat a client-set Host header as a forbidden/ignored header. (This is the same
  // approach the popular minimal aws4fetch library uses, for the same reason.)
  const fetchHeaders = { ...norm, Authorization: authorization };
  delete fetchHeaders.host;
  return { url: `https://${host}${canonicalPath(key)}`, headers: fetchHeaders };
}

/** PUT an object. `sha256HexStr` is required (the caller already has it — it's the DR integrity
 *  fingerprint) and is used both as the signed payload hash AND stored as S3 custom metadata
 *  (`x-amz-meta-sha256`) so a later HEAD can cheaply confirm "is the S3 copy already correct" without
 *  re-downloading the object. `metadata` (plain object of string values) is merged in as additional
 *  `x-amz-meta-*` headers. */
export async function s3Put(creds, key, buf, sha256HexStr, metadata = {}) {
  const payloadHash = sha256HexStr || sha256Hex(buf);
  const headers = { "content-type": "application/octet-stream" };
  for (const [k, v] of Object.entries(metadata || {})) headers[`x-amz-meta-${k}`] = String(v);
  headers["x-amz-meta-sha256"] = payloadHash;
  const { url, headers: signed } = sigv4(creds, { method: "PUT", key, headers, payloadHashHex: payloadHash });
  const r = await fetch(url, { method: "PUT", headers: signed, body: buf });
  if (!r.ok) throw new Error(`S3 PUT ${key} failed: ${r.status} ${(await r.text()).slice(0, 300)}`);
  return { etag: r.headers.get("etag") };
}

/** HEAD an object. Returns null on 404 (soft miss — the normal "not mirrored yet" case), throws on any
 *  other non-2xx. Returns { bytes, etag, metaSha256, lastModified } on success. */
export async function s3Head(creds, key) {
  const { url, headers } = sigv4(creds, { method: "HEAD", key, headers: {}, payloadHashHex: EMPTY_SHA256 });
  const r = await fetch(url, { method: "HEAD", headers });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`S3 HEAD ${key} failed: ${r.status}`);
  return {
    bytes: Number(r.headers.get("content-length") || 0),
    etag: r.headers.get("etag"),
    metaSha256: r.headers.get("x-amz-meta-sha256") || null,
    lastModified: r.headers.get("last-modified") || null,
  };
}

/** GET an object's full body as a Buffer. Returns null on 404, throws on any other non-2xx. */
export async function s3Get(creds, key) {
  const { url, headers } = sigv4(creds, { method: "GET", key, headers: {}, payloadHashHex: EMPTY_SHA256 });
  const r = await fetch(url, { method: "GET", headers });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`S3 GET ${key} failed: ${r.status} ${(await r.text()).slice(0, 300)}`);
  return Buffer.from(await r.arrayBuffer());
}
