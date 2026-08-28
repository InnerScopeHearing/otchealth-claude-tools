// opensearch-client.mjs — minimal, dependency-free Amazon OpenSearch client (search / bulk update /
// refresh / mapping GET), signed with AWS Signature Version 4 via node:crypto only. No aws-sdk
// dependency, matching the fleet's established "built-in fetch + node:crypto, no vendor SDK"
// convention (see skills/fleet-backup/s3-client.mjs and skills/amazon-sp-api/sp-api.mjs for the same
// style; that file's own signer is S3-specific -- virtual-hosted bucket host, service "s3", no query
// string support -- so it is not reusable here as-is; this is a separate, general-purpose REST signer
// for service "es", parameterized by host/region/path/query/body like the gateway's own
// otchealth-mcp-server/src/search/sigv4.ts, which is independently live-verified against this exact
// cluster (see otchealth-cto/runbooks/AWS-CUTOVER-2026-08-14.md's 2026-08-14 addendum).
//
// Credentials + host + region are passed in explicitly per call (an `cfg` object: host, region,
// accessKeyId, secretAccessKey, sessionToken) rather than read from env/Key Vault in this file --
// same "no global credential state" design principle s3-client.mjs's header documents. The caller
// (enrich.mjs's resolveOpenSearch()) owns credential resolution.
//
// Pure signing helpers (rfc3986Encode/canonicalUri/canonicalQuery/signOpenSearchRequest) are exported
// so they are unit-testable without a live cluster (tests/opensearch-client-sigv4.test.mjs) -- URI
// encoding and query-string canonicalization are, per s3-client.mjs's header comment, "the #1 source
// of SigV4 SignatureDoesNotMatch bugs when done wrong."

import crypto from "node:crypto";

function sha256Hex(s) {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}
function hmac(key, data) {
  return crypto.createHmac("sha256", key).update(data, "utf8").digest();
}

/** RFC3986-strict percent-encoding: JS's built-in encodeURIComponent leaves `!'()*` unescaped, but
 *  AWS's canonical-request spec requires those escaped too (this is the exact gap the gateway's own
 *  sigv4.ts documents and the AWS-CUTOVER runbook specifically called out as verified-correct there:
 *  "Its path encoder is correct. canonicalUri percent-encodes ( ) ! ' *"). */
export function rfc3986Encode(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

/** Canonicalize a URI path per SigV4: each segment individually percent-encoded, '/' preserved as a
 *  literal separator. An empty/absent path canonicalizes to '/'. */
export function canonicalUri(path) {
  if (!path || path === "/") return "/";
  return path.split("/").map(rfc3986Encode).join("/");
}

/** Canonicalize a query string per SigV4 from a plain {key: value} object: both key and value
 *  percent-encoded, then pairs sorted by encoded key (ties broken by encoded value). Returns "" for
 *  no params -- every call site in this file either has no query params or exactly one
 *  (`refresh=true`/`wait_for`), so a plain object is sufficient; no need to support repeated keys. */
export function canonicalQuery(params) {
  const entries = Object.entries(params || {});
  if (!entries.length) return "";
  return entries
    .map(([k, v]) => [rfc3986Encode(k), rfc3986Encode(String(v))])
    .sort(([ak, av], [bk, bv]) => (ak === bk ? (av < bv ? -1 : av > bv ? 1 : 0) : ak < bk ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
}

/**
 * Double percent-encode an already-canonicalized URI (encode it a second time, so a literal '%'
 * from the first pass becomes '%25'). Per the AWS SigV4 spec, the canonical request for EVERY AWS
 * service except S3 is built from the DOUBLE percent-encoded path; S3 is the one documented
 * single-encode exception (see skills/kb-memory/s3-blob.mjs's canonicalUri() header for the exact
 * citation and the real bug it caused when this fleet got it backwards once already). This function
 * existed nowhere in this file before 2026-08-28 because it made no observable difference: every
 * OpenSearch index name / `_bulk` path this client has ever signed is built only from characters
 * (letters, digits, '-', '_') that percent-encoding never touches, so encoding once or twice produced
 * byte-identical output and the gap went unnoticed. A Bedrock model id's `:` and `.` are exactly the
 * kind of character where the two diverge (`:` -> `%3A` -> `%253A` on the second pass), which is why
 * `service: "bedrock"` below routes through this and the pre-existing `service: "es"` default does
 * not -- changing the default's behavior would risk regressing an already-live-verified signer with
 * no way to test the change against the real cluster from here.
 */
function doubleEncodeUri(path) {
  return canonicalUri(canonicalUri(path));
}

/**
 * Sign one AWS REST request. Returns { headers, query, path } -- `headers` is the FULL set to send
 * (host, x-amz-date, content-type when a body is present, Authorization, and x-amz-security-token
 * when a session token is given); `query` is the already-canonicalized (sorted+encoded) query string;
 * `path` is the WIRE path (single percent-encoded per segment) the caller must send the request to.
 * The caller must use `query`/`path` VERBATIM in the URL it fetches, never re-derive either
 * separately -- that is how a signed request and a sent request silently diverge (see osFetch()
 * below, which predates `path` being returned here and instead re-derives the URL from its own raw
 * `path` argument -- safe only because every index name it has ever been called with round-trips
 * identically through `canonicalUri`, which is not something a new caller should assume).
 *
 * `service` (default "es", the pre-existing OpenSearch/Elasticsearch signing name) selects the
 * signing scope/service AND, for anything other than "es", switches the CANONICAL REQUEST (never the
 * wire path) to the double-encode rule real AWS services other than S3 require -- see
 * doubleEncodeUri()'s comment. Passing "es" reproduces this function's exact pre-2026-08-28 output
 * for every existing call site; this is covered by a regression test (see
 * tests/opensearch-client-sigv4.test.mjs) precisely so a future edit here cannot silently change what
 * OpenSearch itself receives.
 */
export function signOpenSearchRequest({ method, host, path, query, body, region, accessKeyId, secretAccessKey, sessionToken, now, contentType, service }) {
  const svc = service || "es";
  const d = now || new Date();
  const amzDate = d.toISOString().replace(/[:-]|\.\d{3}/g, ""); // YYYYMMDDTHHMMSSZ
  const dateStamp = amzDate.slice(0, 8);
  const bodyStr = body || "";
  const bodyHash = sha256Hex(bodyStr);

  const headersToSign = { host, "x-amz-date": amzDate };
  if (bodyStr) headersToSign["content-type"] = contentType || "application/json";
  if (sessionToken) headersToSign["x-amz-security-token"] = sessionToken;

  const sortedNames = Object.keys(headersToSign).sort();
  const canonicalHeaders = sortedNames.map((n) => `${n}:${String(headersToSign[n]).trim()}\n`).join("");
  const signedHeaders = sortedNames.join(";");
  const qs = canonicalQuery(query);

  const wireUri = canonicalUri(path); // what actually gets sent -- unchanged by `service` on purpose
  const signingUri = svc === "es" ? wireUri : doubleEncodeUri(path);
  const canonicalRequest = [method.toUpperCase(), signingUri, qs, canonicalHeaders, signedHeaders, bodyHash].join("\n");
  const scope = `${dateStamp}/${region}/${svc}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");

  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, svc);
  const kSigning = hmac(kService, "aws4_request");
  const signature = hmac(kSigning, stringToSign).toString("hex");

  const authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { headers: { ...headersToSign, Authorization: authorization }, query: qs, path: wireUri };
}

/** Low-level signed fetch. Returns the raw Response (never throws on a non-2xx -- callers decide what
 *  counts as failure, since e.g. _bulk can return HTTP 200 with per-item errors). */
export async function osFetch(cfg, { method, path, query, body, contentType }) {
  const { headers, query: qs } = signOpenSearchRequest({
    method, host: cfg.host, path, query, body, region: cfg.region,
    accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey, sessionToken: cfg.sessionToken, contentType,
  });
  const url = `https://${cfg.host}${path}${qs ? "?" + qs : ""}`;
  return fetch(url, { method, headers, body: body || undefined });
}

async function osJson(cfg, opts) {
  const r = await osFetch(cfg, opts);
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* leave null; caller sees r.ok=false or empty json */ }
  return { status: r.status, ok: r.ok, json, text };
}

/** GET the mapping for an index. Used only for ad-hoc inspection/verify, never on the hot write path. */
export async function osGetMapping(cfg, index) {
  return osJson(cfg, { method: "GET", path: `/${encodeURIComponent(index)}/_mapping` });
}

/** POST _search. `body` is a plain object (JSON-encoded here). */
export async function osSearch(cfg, index, body) {
  return osJson(cfg, { method: "POST", path: `/${encodeURIComponent(index)}/_search`, body: JSON.stringify(body) });
}

/**
 * Bulk PARTIAL UPDATE (never index/replace) a set of documents that already exist, by _id, in one
 * index. Each id gets the SAME `doc` merged in via the bulk API's "update" action -- this is the
 * NDJSON-body equivalent of the single-document Update API (`POST /<index>/_update/<id>` with
 * `{"doc": {...}}`), NOT `index`/`PUT _doc`, which REPLACES the whole document (including whatever
 * vector field it carries). Every field in `doc` that is present overwrites that field only; every
 * field NOT in `doc` (chunk, text_vector, parent_id, ...) is left completely untouched.
 *
 * Content-Type is `application/x-ndjson` (the bulk API's own required type, distinct from every other
 * call in this file) -- each action/doc pair on its own line, body ends with a trailing newline (a
 * bulk request missing the final newline silently drops or errors the last action).
 *
 * Returns { ok, ids, errors: [{id, error}] } -- `ok` is true only when EVERY item succeeded, so the
 * caller can decide per-row whether it is safe to mark this write as durably synced.
 */
export async function osBulkUpdate(cfg, index, ids, doc) {
  if (!ids.length) return { ok: true, ids: [], errors: [] };
  const lines = [];
  for (const id of ids) {
    lines.push(JSON.stringify({ update: { _id: id } }));
    lines.push(JSON.stringify({ doc }));
  }
  const body = lines.join("\n") + "\n";
  const r = await osJson(cfg, { method: "POST", path: `/${encodeURIComponent(index)}/_bulk`, body, contentType: "application/x-ndjson" });
  if (!r.ok || !r.json) return { ok: false, ids, errors: ids.map((id) => ({ id, error: `bulk http ${r.status}: ${r.text.slice(0, 300)}` })) };
  const items = Array.isArray(r.json.items) ? r.json.items : [];
  const errors = [];
  items.forEach((it, i) => {
    const res = it.update || it.index || it.create || {};
    if (res.error) errors.push({ id: ids[i] ?? res._id, error: JSON.stringify(res.error).slice(0, 300) });
  });
  return { ok: r.json.errors !== true && errors.length === 0, ids, errors };
}

/** Force a refresh so documents written moments ago are immediately search-visible. Called once at
 *  the end of a run (not per-write -- forcing a refresh on every bulk call adds real latency at scale
 *  for no benefit once the caller is done batching). */
export async function osRefresh(cfg, index) {
  return osJson(cfg, { method: "POST", path: `/${encodeURIComponent(index)}/_refresh`, body: "" });
}

/** Count matching documents (used for the before/after proof and general ad-hoc verification). */
export async function osCount(cfg, index, query) {
  return osJson(cfg, { method: "POST", path: `/${encodeURIComponent(index)}/_count`, body: JSON.stringify({ query }) });
}
