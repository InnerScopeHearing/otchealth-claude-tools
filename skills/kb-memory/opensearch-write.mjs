#!/usr/bin/env node
// opensearch-write.mjs — Amazon OpenSearch backend for the fleet's kb-memory writers: semantic.mjs's
// `memory-exec` index and ring-memory-index's per-agent/per-ring memory indexes (legal-personal-memory,
// finance-cfo-memory, commons-<agent>-memory). Selected via SEARCH_BACKEND=opensearch — the SAME env var
// name/values as otchealth-mcp-server's src/search/index.ts dispatcher and doc-indexer's enrich.mjs
// `--search-backend` flag, so the flag means the identical thing everywhere in the fleet. Default
// SEARCH_BACKEND=azure leaves every existing caller byte-identical (this module is then never imported
// into an active code path — see semantic.mjs's and index-ring-memory.mjs's dispatch).
//
// THE DEFECT THIS FIXES: semantic.mjs's init() hardcoded `throw new Error("missing azure-search-endpoint/
// admin-key")` with NO opensearch branch anywhere in the file — the ONLY thing that populates memory-exec
// and the ring indexes — so an Azure outage (or a deliberate billing block) stops fleet memory INDEXING
// outright rather than degrading. Measured: memory-exec + 7 ring-memory indexes frozen at their
// 2026-08-13 doc counts while the equivalent Azure-side indexes kept growing.
//
// REUSES, DOES NOT DUPLICATE, the fleet's already-proven OpenSearch primitives:
//   skills/doc-indexer/opensearch-client.mjs — hand-rolled SigV4 signer + osFetch/osSearch/osBulkUpdate/
//   osGetMapping/osRefresh/osCount, live-verified against this exact cluster by enrich.mjs's OpenSearch
//   write path (2026-08-16, commerce room 0 -> 130 entity-tagged docs; see FLEET-BULLETIN.md). This file
//   adds only what enrich.mjs did not need: credential/config resolution with an Azure-independent
//   fallback order, the memory-document mapping + a per-doc-distinct bulk upsert, id/field listing via
//   scroll, delete, and a BM25+kNN hybrid search for recall().
//
// EMBEDDINGS is an INDEPENDENT switch from SEARCH_BACKEND (mirrors otchealth-mcp-server/src/azure/
// foundry.ts's EMBEDDINGS_PROVIDER exactly): a genuine Azure outage takes Azure Foundry down too, so
// SEARCH_BACKEND=opensearch alone is NOT sufficient for an Azure-free run — EMBEDDINGS_PROVIDER=openai is
// also required, or every embed() call still reaches Azure and fails right along with it. OpenAI's own API
// serves the IDENTICAL text-embedding-3-large model the live indexes were built with (3072 dims), so
// switching is a change of URL and auth header, never a re-embed / migration.
//
// CREDENTIAL RESOLUTION, cheapest/most Azure-independent first:
//   AWS credentials (to SigV4-sign every OpenSearch call):
//     1. the ECS/Fargate task-role container-credentials endpoint (AWS_CONTAINER_CREDENTIALS_RELATIVE_URI
//        / _FULL_URI, ambient — zero Azure or anything else involved). Mirrors skills/kb-memory/
//        aws-secret.mjs's awsCreds(); that function is module-private there (not exported), so this is a
//        small, deliberate, independent copy rather than a cross-file import, kept in this file precisely
//        because this file lives outside aws-secret.mjs's ownership.
//     2. explicit env AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY, guarded against the cloud-sandbox proxy's
//        non-functional "prox"-prefixed placeholder key (the same guard aws-secret.mjs uses — signing
//        with it would produce a confusing 403 instead of an obvious "no credentials").
//     3. Azure Key Vault secrets aws-cto-access-key-id/aws-cto-secret-access-key — the exact pair
//        enrich.mjs's resolveOpenSearch() already uses live today. Works today (Azure is up); deliberately
//        LAST because it is the one link in this chain that itself depends on Azure.
//   OPENSEARCH_ENDPOINT / OPENSEARCH_REGION / OPENAI_API_KEY (VALUES to look up, not credentials to sign
//   with): (1) explicit env var; (2) AWS SSM Parameter Store via aws-secret.mjs's exported ssmSecret() —
//   genuinely Azure-independent PROVIDED step 1 above already resolved real AWS creds (this tier is a
//   harmless, fast no-op fallthrough otherwise: ssmSecret() calls its own credential resolver and returns
//   null with nothing to sign with); (3) Azure Key Vault (kvSecret) — works today, matches enrich.mjs;
//   (4) for the endpoint only, a hardcoded default (the live cluster host, matching enrich.mjs's
//   OS_DEFAULT_HOST) / "us-east-1" region default.
//
// SCHEMA: id keyword (== the OpenSearch _id — every write here PUTs/updates by explicit _id), agent
// text+keyword sub-field, type keyword, ts keyword, tags text, text text, retracted boolean, contentVector
// knn_vector dim 3072 (text-embedding-3-large, hnsw/cosine) — field-for-field identical to semantic.mjs's
// and index-ring-memory.mjs's own Azure schemas, and matching the ALREADY-LIVE OpenSearch memory-exec
// index this module writes into (the fleet's own record confirms the live OpenSearch documents were
// embedded at exactly this model/dimension).
//
// BULK WRITE SEMANTICS — the thing most likely to silently corrupt this (the identical concern enrich.mjs's
// own header calls out for the entity layer, 2026-08-16): every bulk write in this module uses the
// OpenSearch bulk API's "update" action with doc_as_upsert:true, NEVER "index"/PUT _doc. "index" REPLACES
// the whole document — a partial payload (semantic.mjs's retraction-refresh writes only {id,
// retracted:true} to flip one field on an ALREADY-embedded row, without re-sending its text/vector) would
// silently WIPE OUT that row's existing contentVector and text if sent via "index". "update"+doc_as_upsert
// merges: fields present in the payload overwrite, fields absent are left untouched on an existing doc, and
// doc_as_upsert still creates a new doc from just the given fields when none existed yet. This is the EXACT
// semantic Azure AI Search's own "mergeOrUpload" action already has (every doc pushed by semantic.mjs and
// index-ring-memory.mjs carries `"@search.action": "mergeOrUpload"`, full doc or partial alike) — so using
// "update"+doc_as_upsert UNIFORMLY here, whether or not a given payload happens to include every field, is
// not merely safe but the exact cross-backend-equivalent behavior. No per-call branching on "is this a full
// or partial doc" is needed or attempted; branching on that would itself be a place a future edit could get
// it wrong.
import { kvSecret } from "./azure-secret.mjs";
import { ssmSecret } from "./aws-secret.mjs";
import { osFetch, osSearch, osGetMapping, osRefresh, osCount } from "../doc-indexer/opensearch-client.mjs";

export const EMB_DIMS = 3072;
// Matches doc-indexer/enrich.mjs's OS_DEFAULT_HOST exactly — the same live cluster, so a fresh
// deployment with no opensearch-endpoint secret set anywhere still resolves to the right place.
const DEFAULT_HOST = "search-otchealth-brain-uqmq2jw23cv4yjnnxblxzb7nny.us-east-1.es.amazonaws.com";
const DEFAULT_REGION = "us-east-1";
const OPENAI_EMBED_MODEL = "text-embedding-3-large"; // pinned, never configurable — MUST match the model the live indexes were embedded with (3072 dims); see this file's header.

// ============================ AWS credential resolution ============================

async function ecsTaskRoleCreds() {
  const rel = process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI;
  const full = process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI;
  if (!rel && !full) return null;
  try {
    const url = full || `http://169.254.170.2${rel}`;
    const headers = process.env.AWS_CONTAINER_AUTHORIZATION_TOKEN ? { Authorization: process.env.AWS_CONTAINER_AUTHORIZATION_TOKEN } : {};
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(3000) });
    if (!r.ok) return null;
    const j = await r.json();
    if (!j.AccessKeyId || !j.SecretAccessKey) return null;
    const expiresAtMs = j.Expiration ? Date.parse(j.Expiration) : Date.now() + 10 * 60_000;
    return { creds: { accessKeyId: j.AccessKeyId, secretAccessKey: j.SecretAccessKey, sessionToken: j.Token || undefined }, expiresAtMs: Number.isFinite(expiresAtMs) ? expiresAtMs : Date.now() + 10 * 60_000 };
  } catch {
    return null;
  }
}
// Exported (pure, no I/O) so the "prox" placeholder guard and the tier-2 credential shape are directly
// unit-testable without mocking any network call.
export function envCreds() {
  const ak = process.env.AWS_ACCESS_KEY_ID, sk = process.env.AWS_SECRET_ACCESS_KEY;
  if (!ak || !sk) return null;
  // The cloud-sandbox proxy injects a non-functional placeholder key (prefix "prox"); signing with it
  // produces a confusing 403 rather than an obvious "no credentials" — same guard as aws-secret.mjs.
  if (/^prox/i.test(ak)) return null;
  return { accessKeyId: ak, secretAccessKey: sk, sessionToken: process.env.AWS_SESSION_TOKEN || undefined };
}

let _credsCache = null; // { creds, expiresAtMs? }
/** Resolve AWS credentials for signing OpenSearch calls. Memoized (refreshed once within 60s of a
 *  known expiry). Returns null — never throws — when nothing resolves; callers decide what that means. */
export async function resolveAwsCredentials() {
  const now = Date.now();
  if (_credsCache && (!_credsCache.expiresAtMs || _credsCache.expiresAtMs - now > 60_000)) return _credsCache.creds;
  const viaTaskRole = await ecsTaskRoleCreds();
  if (viaTaskRole) {
    _credsCache = viaTaskRole;
    return viaTaskRole.creds;
  }
  const viaEnv = envCreds();
  if (viaEnv) {
    _credsCache = { creds: viaEnv };
    return viaEnv;
  }
  const [accessKeyId, secretAccessKey] = await Promise.all([kvSecret("aws-cto-access-key-id"), kvSecret("aws-cto-secret-access-key")]);
  if (accessKeyId && secretAccessKey) {
    const creds = { accessKeyId, secretAccessKey };
    _credsCache = { creds };
    return creds;
  }
  return null;
}

// ============================ OpenSearch endpoint/region + client config ============================

let _osCfgCache = null;
/** Resolve {host, region, accessKeyId, secretAccessKey, sessionToken} — the exact `cfg` shape
 *  opensearch-client.mjs's osFetch/osSearch/... expect. Memoized per process. Throws (loudly, once) only
 *  when no AWS credentials are resolvable at all; a missing endpoint/region degrades to the documented
 *  defaults instead of failing, since those are recoverable guesses and credentials are not. */
export async function resolveOpenSearchConfig() {
  if (_osCfgCache) return _osCfgCache;
  const host = (process.env.OPENSEARCH_ENDPOINT || (await ssmSecret("opensearch-endpoint")) || (await kvSecret("opensearch-endpoint")) || DEFAULT_HOST)
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");
  const region = process.env.OPENSEARCH_REGION || (await ssmSecret("opensearch-region")) || (await kvSecret("opensearch-region")) || DEFAULT_REGION;
  const credentials = await resolveAwsCredentials();
  if (!credentials) {
    throw new Error(
      "opensearch: no AWS credentials resolvable (checked the ECS task role, AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY env, and Key Vault aws-cto-access-key-id/aws-cto-secret-access-key)",
    );
  }
  return (_osCfgCache = { host, region, accessKeyId: credentials.accessKeyId, secretAccessKey: credentials.secretAccessKey, sessionToken: credentials.sessionToken });
}

/** Test-only: clear every memoized credential/config so a test can force re-resolution under a fresh
 *  env/fetch stub. Mirrors the fleet's existing `_resetXForTests` convention (see cosmos-auth.mjs). */
export function _resetCachesForTests() {
  _credsCache = null;
  _osCfgCache = null;
  _openaiKeyCache = null;
}

// ============================ embeddings (OpenAI-direct, the Azure-free path) ============================

let _openaiKeyCache = null;
export async function resolveOpenAIKey() {
  if (_openaiKeyCache) return _openaiKeyCache;
  const key = process.env.OPENAI_API_KEY || (await ssmSecret("openai-api-key")) || (await kvSecret("openai-api-key"));
  if (!key) throw new Error("opensearch embeddings: no OPENAI_API_KEY resolvable (checked env, SSM, and Key Vault openai-api-key)");
  return (_openaiKeyCache = key);
}

/** Embed a batch of strings via api.openai.com, pinned to text-embedding-3-large (see this file's
 *  header). Mirrors semantic.mjs's own Azure embed()'s 429-retry contract exactly (6 attempts, 1.5s *
 *  attempt backoff) so swapping providers changes nothing about caller-visible retry behavior. */
export async function embedOpenAI(texts) {
  const key = await resolveOpenAIKey();
  for (let a = 0; a < 6; a++) {
    const r = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ input: texts, model: OPENAI_EMBED_MODEL }),
    });
    if (r.status === 429) {
      await new Promise((s) => setTimeout(s, 1500 * (a + 1)));
      continue;
    }
    if (!r.ok) throw new Error("embed(openai) " + r.status + " " + (await r.text()).slice(0, 200));
    const j = await r.json();
    // Defensive re-sort by `.index` (mirrors otchealth-mcp-server/src/azure/foundry.ts's embedBatch):
    // OpenAI's own API guarantees input order, but trusting an explicit index when present is free and
    // makes this safe even if that ever changes.
    return [...j.data].sort((x, y) => (x.index ?? 0) - (y.index ?? 0)).map((d) => d.embedding);
  }
  throw new Error("embed(openai) 429 exhausted");
}

// ============================ index mapping ============================

/** The OpenSearch mapping for a flat memory index (memory-exec or any ring index) — field-for-field
 *  identical to the Azure schema semantic.mjs's/index-ring-memory.mjs's own ensureIndex() build. Pure,
 *  exported for a direct unit test of the shape. */
export function memoryIndexMapping() {
  return {
    settings: { index: { knn: true } },
    mappings: {
      properties: {
        id: { type: "keyword" },
        agent: { type: "text", fields: { keyword: { type: "keyword" } } },
        type: { type: "keyword" },
        ts: { type: "keyword" },
        tags: { type: "text" },
        text: { type: "text" },
        retracted: { type: "boolean" },
        contentVector: { type: "knn_vector", dimension: EMB_DIMS, method: { name: "hnsw", engine: "nmslib", space_type: "cosinesimil" } },
      },
    },
  };
}

/** Idempotent create-if-absent. Unlike Azure's ensureIndex() (which must PUT an additive superset schema
 *  on EVERY call because a PUT omitting an existing field is a rejected deletion — the daily-digest/
 *  memory-exec "SKEW-PROOF" class of bug this file's siblings document at length), OpenSearch has no such
 *  failure mode for ADDING fields: a write carrying a field not yet in the mapping is accepted via
 *  ordinary dynamic mapping (verified live against this exact cluster by enrich.mjs, which notes "no
 *  dynamic:strict on any doc room"). So once an index exists, this is a clean no-op — no merge/PUT dance
 *  needed or attempted on every call. */
export async function ensureIndex(index) {
  const cfg = await resolveOpenSearchConfig();
  const existing = await osGetMapping(cfg, index);
  if (existing.ok) return { created: false };
  if (existing.status !== 404) {
    throw new Error(`opensearch ensureIndex(${index}): unexpected mapping GET status ${existing.status}`);
  }
  const r = await osFetch(cfg, { method: "PUT", path: `/${encodeURIComponent(index)}`, body: JSON.stringify(memoryIndexMapping()) });
  if (r.ok) return { created: true };
  // A 400 here can be a benign race (another writer created the index between our GET and this PUT) —
  // re-check before treating it as a real failure rather than failing a legitimate concurrent first-run.
  const recheck = await osGetMapping(cfg, index);
  if (recheck.ok) return { created: false };
  throw new Error(`opensearch ensureIndex(${index}): create failed ${r.status} ${(await r.text()).slice(0, 200)}`);
}

// ============================ scroll (full listing) ============================

const SCROLL_TTL = "2m";
/** Paginate every document in `index` via the scroll API (correct for exports far beyond the default
 *  10k result-window cap, unlike from/size or a naive $skip walk). `source`: false (default, id only),
 *  true, or an array of field names (OpenSearch's own `_source` option shapes, passed through as-is).
 *  Returns `[{id, ...fields}]`. Tolerates a not-yet-created index (empty result, matching semantic.mjs's
 *  own existingIds() tolerance for the first-ever run) and a transient scroll failure mid-pagination (stops
 *  and returns what was gathered so far, matching semantic.mjs's `if (!r.ok) break;` per-page contract). */
export async function scrollAll(index, { source = false, size = 1000, maxPages = 20000 } = {}) {
  const cfg = await resolveOpenSearchConfig();
  const out = [];
  const res = await osFetch(cfg, {
    method: "POST",
    path: `/${encodeURIComponent(index)}/_search`,
    query: { scroll: SCROLL_TTL },
    body: JSON.stringify({ size, _source: source, query: { match_all: {} } }),
  });
  if (res.status === 404) return out;
  if (!res.ok) throw new Error(`opensearch scrollAll(${index}): search ${res.status} ${(await res.text()).slice(0, 200)}`);
  let j = await res.json();
  let scrollId = j._scroll_id;
  let hits = j.hits?.hits || [];
  let pages = 0;
  try {
    while (hits.length && pages < maxPages) {
      for (const h of hits) out.push({ id: h._id, ...(source ? h._source || {} : {}) });
      pages++;
      const r2 = await osFetch(cfg, { method: "POST", path: "/_search/scroll", body: JSON.stringify({ scroll: SCROLL_TTL, scroll_id: scrollId }) });
      if (!r2.ok) break;
      const j2 = await r2.json();
      scrollId = j2._scroll_id;
      hits = j2.hits?.hits || [];
    }
  } finally {
    if (scrollId) {
      try {
        await osFetch(cfg, { method: "DELETE", path: "/_search/scroll", body: JSON.stringify({ scroll_id: [scrollId] }) });
      } catch {
        /* best-effort cleanup only — never let this mask the real result */
      }
    }
  }
  return out;
}

/** Every doc id currently in `index` — the OpenSearch counterpart to semantic.mjs's Azure existingIds(),
 *  used identically (the incremental "skip already-indexed" filter in reindex()). */
export async function existingIds(index) {
  return new Set((await scrollAll(index, { source: false })).map((d) => d.id));
}

export async function countDocs(index) {
  const cfg = await resolveOpenSearchConfig();
  const r = await osCount(cfg, index, { match_all: {} });
  if (!r.ok) throw new Error(`opensearch countDocs(${index}): ${r.status} ${r.text.slice(0, 200)}`);
  return r.json?.count ?? 0;
}

export async function refresh(index) {
  const cfg = await resolveOpenSearchConfig();
  return osRefresh(cfg, index);
}

// ============================ bulk write ============================

/** Bulk upsert MANY documents, each with its OWN distinct fields, via the "update"+doc_as_upsert action
 *  (see this file's header for why, never "index"). `docs` = array of {id, ...fields}; `id` is pulled out
 *  and used as the bulk _id, the remaining fields become the merged "doc". Mirrors
 *  opensearch-client.mjs's osBulkUpdate's return shape and per-item error handling exactly (that function
 *  broadcasts ONE shared doc to MANY ids — the right fit for the retraction-refresh case, so callers use
 *  osBulkUpdate directly for that; this one is for the general reindex/ring-ledger case where every row's
 *  content differs). */
export async function pushDocs(index, docs) {
  if (!docs.length) return { ok: true, ids: [], errors: [] };
  const cfg = await resolveOpenSearchConfig();
  const lines = [];
  const ids = [];
  for (const d of docs) {
    const { id, ...fields } = d;
    ids.push(id);
    // An EMPTY ts must be omitted, never sent as "".
    //
    // Found live during the 2026-08-16 frozen-room backfill: the clo-personal ring push failed with
    // mapper_parsing_exception "cannot parse empty date" on three ledger rows whose ts was blank
    // (20260630-054/055/056). All three of the fleet's memory writers build the field as
    // `ts: entry.ts || ""`, and Azure AI Search accepted that; OpenSearch rejects it outright when
    // the live index maps ts as `date` -- which legal-personal-memory does, even though this
    // module's own header documents ts as `keyword`. That mapping mismatch is real and is why the
    // fix belongs HERE, at the shared choke point every writer goes through, rather than in any one
    // caller: it is correct under BOTH mappings.
    //
    // Omitting is the semantically right repair, not a workaround. "Unknown timestamp" is an ABSENT
    // field, not an empty one, and under doc_as_upsert an omitted key simply is not set -- so this
    // never clears a ts that a previous write already stored. Without it the whole bulk item is
    // rejected and the row's text AND embedding are lost, which on the privileged ring is exactly
    // the silent data loss this migration exists to prevent.
    if (fields.ts === "") delete fields.ts;
    lines.push(JSON.stringify({ update: { _id: id } }));
    lines.push(JSON.stringify({ doc: fields, doc_as_upsert: true }));
  }
  const body = lines.join("\n") + "\n";
  const r = await osFetch(cfg, { method: "POST", path: `/${encodeURIComponent(index)}/_bulk`, body, contentType: "application/x-ndjson" });
  const text = await r.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* leave null */
  }
  if (!r.ok || !json) return { ok: false, ids, errors: ids.map((id) => ({ id, error: `bulk http ${r.status}: ${text.slice(0, 300)}` })) };
  const items = Array.isArray(json.items) ? json.items : [];
  const errors = [];
  items.forEach((it, i) => {
    const res = it.update || it.index || it.create || {};
    if (res.error) errors.push({ id: ids[i] ?? res._id, error: JSON.stringify(res.error).slice(0, 300) });
  });
  return { ok: json.errors !== true && errors.length === 0, ids, errors };
}

/** Bulk delete by id. A missing-doc delete (404 per-item) is not treated as an error — matches the
 *  idempotent-delete expectation of every caller (Azure's own delete action is likewise a no-op on an
 *  already-absent doc). */
export async function deleteDocs(index, ids) {
  if (!ids.length) return { ok: true, ids: [], errors: [] };
  const cfg = await resolveOpenSearchConfig();
  const lines = ids.map((id) => JSON.stringify({ delete: { _id: id } }));
  const body = lines.join("\n") + "\n";
  const r = await osFetch(cfg, { method: "POST", path: `/${encodeURIComponent(index)}/_bulk`, body, contentType: "application/x-ndjson" });
  const text = await r.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* leave null */
  }
  if (!r.ok || !json) return { ok: false, ids, errors: ids.map((id) => ({ id, error: `bulk delete http ${r.status}: ${text.slice(0, 300)}` })) };
  const items = Array.isArray(json.items) ? json.items : [];
  const errors = [];
  items.forEach((it, i) => {
    const res = it.delete || {};
    if (res.error && res.status !== 404) errors.push({ id: ids[i] ?? res._id, error: JSON.stringify(res.error).slice(0, 300) });
  });
  return { ok: errors.length === 0, ids, errors };
}

// ============================ hybrid search (recall) ============================

const RRF_K = 60;
/** Reciprocal Rank Fusion over N ranked lists of {id} hits. Pure, exported for a direct unit test.
 *  Mirrors otchealth-mcp-server/src/search/opensearch.ts's own reciprocalRankFusion (same constant,
 *  same formula) — this is a re-implementation, not a shared import, since that file is TypeScript in a
 *  different repo; the formula itself is standard (Cormack et al.) and small enough that pinning it here
 *  with its own test is safer than reaching across repos for it. */
export function reciprocalRankFusion(lists, k = RRF_K) {
  const scores = new Map();
  for (const list of lists) {
    list.forEach((hit, rank) => {
      if (!hit.id) return;
      scores.set(hit.id, (scores.get(hit.id) ?? 0) + 1 / (k + rank + 1));
    });
  }
  return scores;
}

function extractHits(json) {
  const hits = json?.hits?.hits || [];
  return hits.map((h) => ({ id: String(h._id ?? ""), source: h._source || {} }));
}

/** BM25 (multi_match over agent/tags/text) + kNN hybrid, merged client-side via RRF — OpenSearch has no
 *  built-in equivalent of Azure AI Search's queryType:'semantic' L2 reranker, so this issues two plain
 *  queries and fuses them, the same documented design choice otchealth-mcp-server/src/search/opensearch.ts
 *  already made and shipped for the gateway's own room search. Returns hits shaped to match Azure's
 *  recall() hit contract exactly (`agent,type,ts,text,tags,retracted,"@search.score"`), so semantic.mjs's
 *  downstream filterHygiene/rankHitsByTrust/print logic needs no branching on which backend produced them. */
export async function hybridSearch(index, { queryText, vector, top, agent, type } = {}) {
  const cfg = await resolveOpenSearchConfig();
  const filters = [];
  // memory-exec maps `agent` directly as keyword (not text+keyword). Filtering `agent.keyword`
  // therefore matches nothing and makes every `semantic recall --agent <lane>` return 0 hits even
  // when the exact document exists. Use the field's actual live mapping.
  if (agent) filters.push({ term: { agent } });
  if (type) filters.push({ term: { type } });
  const fetchTop = Math.min(50, Math.max(top * 3, top));

  const bm25Body = {
    size: fetchTop,
    _source: { excludes: ["contentVector"] },
    query: { bool: { must: [{ multi_match: { query: queryText, fields: ["agent", "tags", "text"] } }], ...(filters.length ? { filter: filters } : {}) } },
  };
  const bmRes = await osSearch(cfg, index, bm25Body);
  if (!bmRes.ok) throw new Error(`opensearch hybridSearch(${index}): bm25 ${bmRes.status} ${bmRes.text.slice(0, 200)}`);
  const bmHits = extractHits(bmRes.json);

  let vecHits = [];
  let usedVector = false;
  if (vector) {
    const knnBody = {
      size: fetchTop,
      _source: { excludes: ["contentVector"] },
      query: { knn: { contentVector: { vector, k: fetchTop, ...(filters.length ? { filter: { bool: { filter: filters } } } : {}) } } },
    };
    const r = await osSearch(cfg, index, knnBody);
    if (r.ok) {
      vecHits = extractHits(r.json);
      usedVector = true;
    }
  }

  const rrf = reciprocalRankFusion(usedVector ? [bmHits, vecHits] : [bmHits]);
  const bySource = new Map();
  for (const h of [...bmHits, ...vecHits]) if (h.id && !bySource.has(h.id)) bySource.set(h.id, h.source);

  return [...rrf.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, top)
    .map(([id, score]) => {
      const doc = bySource.get(id) || {};
      return { agent: doc.agent, type: doc.type, ts: doc.ts, text: doc.text, tags: doc.tags, retracted: doc.retracted, "@search.score": score };
    });
}

export default {
  envCreds,
  resolveAwsCredentials,
  resolveOpenSearchConfig,
  resolveOpenAIKey,
  embedOpenAI,
  memoryIndexMapping,
  ensureIndex,
  scrollAll,
  existingIds,
  countDocs,
  refresh,
  pushDocs,
  deleteDocs,
  reciprocalRankFusion,
  hybridSearch,
  _resetCachesForTests,
};
