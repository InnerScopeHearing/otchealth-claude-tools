// cosmos-client.mjs — dependency-free Azure Cosmos DB for NoSQL data-plane client for decision-clock.
// Mirrors otchealth-mcp-server's src/agentstate/cosmos.ts auth scheme exactly (master-key HMAC, same
// stringToSign casing) so this skill talks to the SAME agent-state Cosmos account
// (cosmos-otc-agentstate-55c84, db agent-state) the gateway uses, without needing a Node/TS build step
// or the gateway's runtime. Creds resolve from GCP Secret Manager via the claude-driver SA (the
// standard kb-memory sm() pattern), never from a committed config.
//
// Auth (do NOT "tidy" the casing, it is load-bearing, matches the gateway's cosmos.ts):
//   stringToSign = verb.toLowerCase() + "\n" + resType.toLowerCase() + "\n" +
//                  resourceLink + "\n" + date.toLowerCase() + "\n" + "" + "\n"
//   sig = base64( HMAC-SHA256( base64decode(masterKey), stringToSign ) )
//   Authorization = urlencode("type=master&ver=1.0&sig=" + sig)
// resourceLink keeps its original case (db/container/doc ids are case-sensitive).
//
// Inert without creds: isConfigured() is false if Secret Manager lacks cosmos-agent-state-*, and every
// caller in this skill degrades to a clear "Cosmos not reachable, dry-run" note instead of throwing.
import crypto from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";

const SM = "otchealth-shared-prod";
const COSMOS_API_VERSION = "2018-12-31";

// ---- Secret Manager (claude-driver SA), same pattern as kb-memory/mem.mjs ----
function resolveSaJson() {
  if (process.env.GCP_CLAUDE_DRIVER_SA_JSON) return process.env.GCP_CLAUDE_DRIVER_SA_JSON;
  const p = `${homedir()}/.gcp_claude_driver_sa.json`;
  try { if (existsSync(p)) return readFileSync(p, "utf8"); } catch {}
  return null;
}
function saJwt(scope) {
  const raw = resolveSaJson();
  if (!raw) return null;
  const sa = JSON.parse(raw);
  const now = Math.floor(Date.now() / 1000);
  const e = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const i = `${e({ alg: "RS256", typ: "JWT" })}.${e({ iss: sa.client_email, scope, aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 })}`;
  return i + "." + crypto.createSign("RSA-SHA256").update(i).sign(sa.private_key, "base64url");
}
async function sm(id) {
  const jwt = saJwt("https://www.googleapis.com/auth/cloud-platform");
  if (!jwt) return null;
  const r0 = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${encodeURIComponent(jwt)}` });
  const t = (await r0.json()).access_token;
  if (!t) return null;
  const r = await fetch(`https://secretmanager.googleapis.com/v1/projects/${SM}/secrets/${id}/versions/latest:access`, { headers: { Authorization: `Bearer ${t}` } });
  if (!r.ok) return null;
  return Buffer.from((await r.json()).payload.data, "base64").toString("utf8").trim();
}

let _cfg; // memoized {endpoint, key, db} | null
async function cfg() {
  if (_cfg !== undefined) return _cfg;
  const endpoint = process.env.COSMOS_ENDPOINT || (await sm("cosmos-agent-state-endpoint"));
  const key = process.env.COSMOS_KEY || (await sm("cosmos-agent-state-key"));
  const dbName = process.env.COSMOS_DB || (await sm("cosmos-agent-state-db")) || "agent-state";
  _cfg = (endpoint && key) ? { endpoint: endpoint.replace(/\/+$/, ""), key, db: dbName } : null;
  return _cfg;
}

export async function isConfigured() {
  return (await cfg()) !== null;
}

/** The Cosmos master-key Authorization header value (URL-encoded token). Pure + testable. */
export function authToken(verb, resType, resourceLink, date, masterKey) {
  const stringToSign = `${verb.toLowerCase()}\n${resType.toLowerCase()}\n${resourceLink}\n${date.toLowerCase()}\n\n`;
  const sig = crypto.createHmac("sha256", Buffer.from(masterKey, "base64")).update(stringToSign, "utf8").digest("base64");
  return encodeURIComponent(`type=master&ver=1.0&sig=${sig}`);
}

// Path-injection guard, same allowlist discipline as the gateway's cosmos.ts.
const CONTAINERS = new Set(["decisions_pending"]);
const ID_RE = /^[A-Za-z0-9_.\-]{1,255}$/;
function assertColl(coll) { if (!CONTAINERS.has(coll)) throw new Error(`unknown container "${coll}" (allowed: ${[...CONTAINERS].join(", ")})`); }
function assertId(value, label = "id") { if (typeof value !== "string" || !ID_RE.test(value) || /^\.+$/.test(value)) throw new Error(`invalid ${label} (must match Cosmos id charset)`); }

async function request(verb, resType, resourceLink, urlPath, opts = {}) {
  const c = await cfg();
  if (!c) throw new Error("Cosmos agent-state not configured (cosmos-agent-state-endpoint/key unavailable).");
  const date = new Date().toUTCString();
  const headers = {
    Authorization: authToken(verb, resType, resourceLink, date, c.key),
    "x-ms-date": date,
    "x-ms-version": COSMOS_API_VERSION,
    Accept: "application/json",
  };
  if (opts.pk !== undefined) headers["x-ms-documentdb-partitionkey"] = JSON.stringify([opts.pk]);
  if (opts.pkRangeId !== undefined) headers["x-ms-documentdb-partitionkeyrangeid"] = opts.pkRangeId;
  if (opts.ifMatch) headers["If-Match"] = opts.ifMatch;
  if (opts.upsert) headers["x-ms-documentdb-is-upsert"] = "true";
  if (opts.continuation) headers["x-ms-continuation"] = opts.continuation;
  if (opts.maxItemCount) headers["x-ms-max-item-count"] = String(opts.maxItemCount);
  if (opts.isQuery) {
    headers["Content-Type"] = "application/query+json";
    headers["x-ms-documentdb-isquery"] = "true";
    if (opts.pk === undefined) headers["x-ms-documentdb-query-enablecrosspartition"] = "true";
  } else if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  const r = await fetch(`${c.endpoint}/${urlPath}`, { method: verb, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  const txt = await r.text();
  let body = null;
  try { body = txt ? JSON.parse(txt) : null; } catch { body = { raw: txt }; }
  return { status: r.status, ok: r.ok, body, etag: r.headers.get("etag"), continuation: r.headers.get("x-ms-continuation") };
}

function dbName(c) { return c.db; }

export async function createDoc(coll, pkValue, doc) {
  assertColl(coll); assertId(pkValue, "partition key");
  const c = await cfg(); const link = `dbs/${dbName(c)}/colls/${coll}`;
  const res = await request("POST", "docs", link, `${link}/docs`, { pk: pkValue, body: doc });
  if (!res.ok) throw new Error(`Cosmos createDoc ${coll} -> ${res.status}: ${JSON.stringify(res.body).slice(0, 240)}`);
  return res;
}

export async function upsertDoc(coll, pkValue, doc) {
  assertColl(coll); assertId(pkValue, "partition key");
  const c = await cfg(); const link = `dbs/${dbName(c)}/colls/${coll}`;
  const res = await request("POST", "docs", link, `${link}/docs`, { pk: pkValue, body: doc, upsert: true });
  if (!res.ok) throw new Error(`Cosmos upsertDoc ${coll} -> ${res.status}: ${JSON.stringify(res.body).slice(0, 240)}`);
  return res;
}

export async function readDoc(coll, pkValue, id) {
  assertColl(coll); assertId(pkValue, "partition key"); assertId(id);
  const c = await cfg(); const link = `dbs/${dbName(c)}/colls/${coll}/docs/${id}`;
  const res = await request("GET", "docs", link, link, { pk: pkValue });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Cosmos readDoc ${coll}/${id} -> ${res.status}: ${JSON.stringify(res.body).slice(0, 240)}`);
  return { doc: res.body, etag: res.etag };
}

export async function replaceDoc(coll, pkValue, id, doc, ifMatch) {
  assertColl(coll); assertId(pkValue, "partition key"); assertId(id);
  const c = await cfg(); const link = `dbs/${dbName(c)}/colls/${coll}/docs/${id}`;
  return request("PUT", "docs", link, link, { pk: pkValue, body: doc, ifMatch });
}

async function pkRanges(coll) {
  const c = await cfg(); const link = `dbs/${dbName(c)}/colls/${coll}`;
  const res = await request("GET", "pkranges", link, `${link}/pkranges`, {});
  if (!res.ok) throw new Error(`Cosmos pkranges ${coll} -> ${res.status}`);
  return ((res.body?.PartitionKeyRanges) || []).map((r) => r.id);
}

/** Run a SQL query. Single-partition when pk given; else fan out per pk-range and merge (mirrors the
 *  gateway's cosmos.ts, since the REST gateway cannot itself fan out cross-partition queries). */
export async function queryDocs(coll, query, parameters = [], opts = {}) {
  assertColl(coll);
  const max = opts.max ?? 200;
  const c = await cfg(); const link = `dbs/${dbName(c)}/colls/${coll}`;
  const MAX_PAGE_RETRIES = 3, PAGE_RETRY_BASE_MS = 250;
  const runOne = async (extra) => {
    const out = [];
    let continuation;
    do {
      let res, pageAttempt = 0;
      for (;;) {
        res = await request("POST", "docs", link, `${link}/docs`, { isQuery: true, body: { query, parameters }, continuation, maxItemCount: 100, ...extra });
        if (res.status === 429 && pageAttempt < MAX_PAGE_RETRIES) { pageAttempt++; await new Promise((r) => setTimeout(r, PAGE_RETRY_BASE_MS * pageAttempt)); continue; }
        break;
      }
      if (!res.ok) throw new Error(`Cosmos query ${coll} -> ${res.status}: ${JSON.stringify(res.body).slice(0, 240)}`);
      out.push(...((res.body?.Documents) || []));
      continuation = res.continuation ?? undefined;
    } while (continuation && out.length < max);
    return out;
  };
  if (opts.pk !== undefined) { assertId(opts.pk, "partition key"); return (await runOne({ pk: opts.pk })).slice(0, max); }
  const ranges = await pkRanges(coll);
  const merged = [];
  for (const rid of ranges) { merged.push(...(await runOne({ pkRangeId: rid }))); if (merged.length >= max) break; }
  return merged.slice(0, max);
}

export function newId(prefix) { return `${prefix}_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`; }
