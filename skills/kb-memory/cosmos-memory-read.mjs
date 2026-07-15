// cosmos-memory-read.mjs -- dependency-free, READ-ONLY Cosmos DB client scoped to the `memory`
// container (partition key /agent) of the shared agent-state Cosmos account
// (cosmos-otc-agentstate-55c84, database "agent-state"). This is the SAME container the gateway's
// memory_write / memory_search / checkpoint MCP tools write to: every document carries at least
// { id, agent, kind, text, tags?, source?, supersedes? }, where kind is one of
// fact | decision | correction | pitfall | status | episode (see otchealth-mcp-server's memory_write
// tool schema). It is the Cosmos-native twin of kb-memory's Azure-Blob JSONL ledger: engines that
// connect through the gateway (ChatGPT, Hyperagent, Perplexity, ...) write memories HERE; Claude
// Code's kb-memory skill (mem.mjs) writes to Blob. Phase-4 B1 (nightly-reflection.mjs) and B2
// (contradiction-scan.mjs) read BOTH stores to keep the two in sync / catch where they disagree.
//
// Mirrors the auth + cross-partition-query pattern already proven in
// skills/doc-indexer/job/agent-state-janitor.mjs and skills/decision-clock/cosmos-client.mjs exactly
// (master-key HMAC auth, per-pkrange fan-out query) -- do NOT "tidy" the authToken() casing, it is
// load-bearing (matches the gateway's own cosmos.ts auth scheme).
//
// READ-ONLY BY CONSTRUCTION: this module exports exactly one query function and nothing that can
// create, replace, or delete a document. The container allowlist has exactly one entry ("memory").
// nightly-reflection.mjs and contradiction-scan.mjs must never be able to mutate the Cosmos
// memory-of-record directly -- every durable write either of them makes goes through mem.mjs (a NEW
// row on the Blob ledger) or decision.mjs (a NEW decision-clock proposal), never back into this
// container. This is the mechanical enforcement of "never silently mutate memory."
import crypto from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { kvSecret } from "./azure-secret.mjs";

const SM_PROJECT = "otchealth-shared-prod";
const COSMOS_API_VERSION = "2018-12-31";
const DB_NAME_DEFAULT = "agent-state";
const CONTAINER = "memory"; // the ONLY container this module will ever touch

// ---- Cosmos REST auth (mirrors agent-state-janitor.mjs / decision-clock/cosmos-client.mjs exactly) ----
function authToken(verb, resType, resourceLink, date, masterKey) {
  const stringToSign = `${verb.toLowerCase()}\n${resType.toLowerCase()}\n${resourceLink}\n${date.toLowerCase()}\n\n`;
  const sig = crypto.createHmac("sha256", Buffer.from(masterKey, "base64")).update(stringToSign, "utf8").digest("base64");
  return encodeURIComponent(`type=master&ver=1.0&sig=${sig}`);
}

// GCP Secret Manager fallback (claude-driver SA), same pattern as the two files above. kvSecret()
// (Azure Key Vault) is tried FIRST; this is a harmless legacy path kept for parity with every other
// doc-indexer-family job's code shape.
function resolveSaJson() {
  if (process.env.GCP_CLAUDE_DRIVER_SA_JSON) return process.env.GCP_CLAUDE_DRIVER_SA_JSON;
  if (process.env.GCP_CLAUDE_DRIVER_SA_JSON_B64) {
    try { return Buffer.from(process.env.GCP_CLAUDE_DRIVER_SA_JSON_B64, "base64").toString("utf8"); } catch {}
  }
  const p = `${homedir()}/.gcp_claude_driver_sa.json`;
  try { if (existsSync(p)) return readFileSync(p, "utf8"); } catch {}
  return null;
}
function saJwt(scope) {
  const raw = resolveSaJson();
  if (!raw) return null;
  let sa;
  try { sa = JSON.parse(raw); } catch { return null; }
  if (!sa || !sa.private_key) return null;
  const now = Math.floor(Date.now() / 1000);
  const e = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const i = `${e({ alg: "RS256", typ: "JWT" })}.${e({ iss: sa.client_email, scope, aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 })}`;
  return i + "." + crypto.createSign("RSA-SHA256").update(i).sign(sa.private_key, "base64url");
}
async function sm(id) {
  const kv = await kvSecret(id);
  if (kv != null) return kv;
  const jwt = saJwt("https://www.googleapis.com/auth/cloud-platform");
  if (!jwt) return null;
  try {
    const r0 = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${encodeURIComponent(jwt)}` });
    const t = (await r0.json()).access_token;
    if (!t) return null;
    const r = await fetch(`https://secretmanager.googleapis.com/v1/projects/${SM_PROJECT}/secrets/${id}/versions/latest:access`, { headers: { Authorization: `Bearer ${t}` } });
    if (!r.ok) return null;
    return Buffer.from((await r.json()).payload.data, "base64").toString("utf8").trim();
  } catch {
    return null;
  }
}

let _cfg; // memoized {endpoint, key, db} | null
async function cfg() {
  if (_cfg !== undefined) return _cfg;
  const endpoint = process.env.COSMOS_ENDPOINT || (await sm("cosmos-agent-state-endpoint"));
  const key = process.env.COSMOS_KEY || (await sm("cosmos-agent-state-key"));
  const dbName = process.env.COSMOS_DB || (await sm("cosmos-agent-state-db")) || DB_NAME_DEFAULT;
  _cfg = (endpoint && key) ? { endpoint: endpoint.replace(/\/+$/, ""), key, db: dbName } : null;
  return _cfg;
}

/** True when Cosmos creds resolved in this environment. Callers should check this and degrade to an
 *  empty result set (fail-open) rather than throw when it is false. */
export async function isConfigured() {
  return (await cfg()) !== null;
}

async function request(verb, resType, resourceLink, urlPath, opts = {}) {
  const c = await cfg();
  if (!c) throw new Error("cosmos-memory-read: Cosmos agent-state not configured (cosmos-agent-state-endpoint/key unavailable via Key Vault or GCP Secret Manager).");
  const date = new Date().toUTCString();
  const headers = {
    Authorization: authToken(verb, resType, resourceLink, date, c.key),
    "x-ms-date": date,
    "x-ms-version": COSMOS_API_VERSION,
    Accept: "application/json",
  };
  if (opts.pkRangeId !== undefined) headers["x-ms-documentdb-partitionkeyrangeid"] = opts.pkRangeId;
  if (opts.continuation) headers["x-ms-continuation"] = opts.continuation;
  if (opts.maxItemCount) headers["x-ms-max-item-count"] = String(opts.maxItemCount);
  if (opts.isQuery) {
    headers["Content-Type"] = "application/query+json";
    headers["x-ms-documentdb-isquery"] = "true";
    headers["x-ms-documentdb-query-enablecrosspartition"] = "true"; // this module never queries a single pk
  }
  const r = await fetch(`${c.endpoint}/${urlPath}`, { method: verb, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  const txt = await r.text();
  let body = null;
  try { body = txt ? JSON.parse(txt) : null; } catch { body = { raw: txt }; }
  return { status: r.status, ok: r.ok, body, continuation: r.headers.get("x-ms-continuation") };
}

async function pkRanges() {
  const c = await cfg();
  const link = `dbs/${c.db}/colls/${CONTAINER}`;
  const res = await request("GET", "pkranges", link, `${link}/pkranges`, {});
  if (!res.ok) throw new Error(`cosmos-memory-read: pkranges ${CONTAINER} -> HTTP ${res.status}`);
  return ((res.body?.PartitionKeyRanges) || []).map((r) => r.id);
}

/**
 * Cross-partition, READ-ONLY query against the `memory` container ONLY (fans out per pk-range since
 * the container is partitioned /agent, then merges + caps at opts.max, default 5000). Throws on a
 * genuine query/auth error; callers that want fail-open behavior should check isConfigured() first
 * (or catch here) rather than let a Cosmos outage crash a nightly job -- see nightly-reflection.mjs /
 * contradiction-scan.mjs, which both wrap this in a try/catch and degrade to "nothing to process".
 */
export async function queryMemory(query, parameters = [], opts = {}) {
  const c = await cfg();
  if (!c) throw new Error("cosmos-memory-read: Cosmos agent-state not configured.");
  const link = `dbs/${c.db}/colls/${CONTAINER}`;
  const max = opts.max ?? 5000;
  const ranges = await pkRanges();
  const out = [];
  for (const rid of ranges) {
    let continuation;
    do {
      const res = await request("POST", "docs", link, `${link}/docs`, { isQuery: true, pkRangeId: rid, body: { query, parameters }, continuation, maxItemCount: 200 });
      if (!res.ok) throw new Error(`cosmos-memory-read: query ${CONTAINER} -> HTTP ${res.status}: ${JSON.stringify(res.body).slice(0, 240)}`);
      out.push(...((res.body?.Documents) || []));
      continuation = res.continuation;
    } while (continuation && out.length < max);
    if (out.length >= max) break;
  }
  return out.slice(0, max);
}
