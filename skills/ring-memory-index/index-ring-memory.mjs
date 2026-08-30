#!/usr/bin/env node
// ring-memory-index — keep each RING-ISOLATED agent memory ledger semantically recallable.
//
// WHY: the shared exec brain (_MEMORY/_exec/*) is indexed into Amazon OpenSearch `memory-exec`, so every
// agent recalls SHARED memory by meaning. But every agent also keeps its real work in a PRIVATE ledger,
// which the shared reindex never touches:
//   - CLO (legal ring):    otchealthlegalstore / personal        / _MEMORY/clo-personal.jsonl -> legal-personal-memory
//   - CFO (finance ring):  otchealthcfodata    / cfo-source-docs / _MEMORY/cfo.jsonl           -> finance-cfo-memory
//   - COO/CCO/CRO/CPO/developer (non-privileged, commons store): otchealthcommons / company-journal /
//     _MEMORY/<agent>.jsonl -> commons-<agent>-memory (one index per agent, even though they share a store)
// Those ledgers were only FLAT-readable (slow keyword scan over a large growing jsonl). This embeds each
// agent's ledger into its own OpenSearch index (BM25 + text-embedding-3-large vector), so the agent recalls
// its OWN decisions/status/facts by meaning, fast — the same upgrade memory-exec gave the shared brain,
// applied per agent. The DOCUMENT corpora are indexed separately by doc-indexer; this is specifically the
// agent's memory ledger.
//
// RING SAFETY: each row is read from an explicit allow-listed S3 mapping and embedded ONLY into its own
// index — never crosses into another agent's index, even when commons agents share a bucket. Content is
// never printed. S3/OpenSearch credentials resolve through the AWS task role or approved environment
// credential chain. Idempotent (upsert by stable id) and fail-safe PER ROW.
//
// DUAL-WRITER CONVERGENCE (defect-1 fix, 2026-07-21): `memory-exec` (FLEET_INDEX below) has a SECOND
// writer -- kb-memory/semantic.mjs's reindex(), which indexes the curated shared exec feed
// (_MEMORY/_exec/<agent>.jsonl) under id `docId(agent,id) = "<agent>__<id>"` with the entry's raw `.text`.
// Before this fix, indexRing()'s fleet push used a DIFFERENT id scheme (`fleet__<label>__<localDocId>`)
// and a type-prefixed text, so any entry that was ALSO `--share`d (and is therefore in BOTH
// `_MEMORY/<agent>.jsonl` here AND `_MEMORY/_exec/<agent>.jsonl`, under the SAME source `id` -- mem.mjs's
// append() builds ONE entry object and writes it to both places) landed in `memory-exec` as TWO rows,
// measured at ~882/6176 (~14%) of the index, diluting recall (a verified case knocked a golden
// Mercury-cash-runway answer out of the top-5). FIX: the fleet push now uses `sharedDocId(ring.label,
// eR.id)` -- semantic.mjs's OWN docId() -- and the same raw-text convention semantic.mjs stores, so a
// shared entry converges onto the IDENTICAL key + content from EITHER writer (mergeOrUpload collapses
// re-runs to one row, order-independent). Entries that were NEVER shared (present only in the private
// ledger read here) still get a unique key under the converged scheme, so this ring's UNIQUE
// fleet-learning coverage (semantic.mjs only ever sees the curated _exec feed, never the full private
// ledger) is preserved -- no fact coverage is lost, only the duplicate rows are. See
// `planFleetDupeCleanup` / `reconcileFleetDupes` below for cleaning the pre-fix `fleet__*` leftovers.
//
// Runtime selectors are shared with kb-memory/semantic.mjs. The active AWS configuration is
// BLOB_BACKEND=s3, SEARCH_BACKEND=opensearch, EMBEDDINGS_PROVIDER=openai. Azure branches remain only as
// explicit historical compatibility paths and must never be selected for the retired fleet estate.
import crypto from "node:crypto";
import { mergeSchemaAdditive } from "../doc-indexer/schema-merge.mjs";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { kvSecret } from "../kb-memory/azure-secret.mjs";
import { docId as sharedDocId } from "../kb-memory/semantic.mjs";
import { getTextFromS3 } from "../kb-memory/s3-blob.mjs";
import * as OS from "../kb-memory/opensearch-write.mjs";

const SM = "otchealth-shared-prod";
const API = "2023-11-01";
const DIMS = 3072;
const EMBED_BATCH = 16;
const BACKEND = (process.env.SEARCH_BACKEND || "opensearch").toLowerCase(); // 'opensearch' (default since 2026-08-30; Azure AI Search died with sub 55c84f6b) | 'azure'
const EMBEDDINGS_PROVIDER = (process.env.EMBEDDINGS_PROVIDER || "openai").toLowerCase(); // 'openai' (default since 2026-08-30; Azure Foundry died with sub 55c84f6b) | 'foundry'
const BLOB_BACKEND = (process.env.BLOB_BACKEND || "s3").toLowerCase(); // 's3' is authoritative after Azure retirement
const PUSH_BATCH = 48;

// The ring registry. Add a row to onboard a new ring-isolated agent memory ledger. `storeAcctSecret`/
// `storeKeySecret` name the ring store's SM secrets; `container`+`ledger` locate the jsonl; `index` is
// the per-ring target AI Search index (created here if absent).
export const RINGS = [
  {
    label: "clo-personal",
    account: "otchealthlegalstore",
    storeAcctSecret: "azure-legal-storage-account",
    storeKeySecret: "azure-legal-storage-key",
    container: "personal",
    ledger: "_MEMORY/clo-personal.jsonl",
    index: "legal-personal-memory",
    idPrefix: "clop",
    private: true, // PRIVILEGED (attorney-privileged personal legal): NEVER aggregated into fleet-learning.
  },
  {
    label: "cfo",
    account: "otchealthcfodata",
    storeAcctSecret: "azure-cfo-storage-account",
    storeKeySecret: "azure-cfo-storage-key",
    container: "cfo-source-docs",
    ledger: "_MEMORY/cfo.jsonl",
    index: "finance-cfo-memory",
    idPrefix: "cfom",
    private: true, // PRIVILEGED (finance-sensitive / MNPI / Reg-FD): NEVER aggregated into fleet-learning.
  },
  // Non-privileged agents keep their PRIVATE lane in the shared COMMONS store (fleet commons /
  // company-journal), one ledger per agent at _MEMORY/<agent>.jsonl. Unlike CLO/CFO these agents
  // share a STORE but each still gets its own target index (commons-<agent>-memory) — no agent's
  // private ledger is ever embedded into another agent's index.
  {
    label: "coo",
    account: "otchealthcommons",
    storeAcctSecret: "azure-commons-storage-account",
    storeKeySecret: "azure-commons-storage-key",
    container: "company-journal",
    ledger: "_MEMORY/coo.jsonl",
    index: "commons-coo-memory",
    idPrefix: "coom",
  },
  {
    label: "cco",
    account: "otchealthcommons",
    storeAcctSecret: "azure-commons-storage-account",
    storeKeySecret: "azure-commons-storage-key",
    container: "company-journal",
    ledger: "_MEMORY/cco.jsonl",
    index: "commons-cco-memory",
    idPrefix: "ccom",
  },
  {
    label: "cro",
    account: "otchealthcommons",
    storeAcctSecret: "azure-commons-storage-account",
    storeKeySecret: "azure-commons-storage-key",
    container: "company-journal",
    ledger: "_MEMORY/cro.jsonl",
    index: "commons-cro-memory",
    idPrefix: "crom",
  },
  {
    label: "cpo",
    account: "otchealthcommons",
    storeAcctSecret: "azure-commons-storage-account",
    storeKeySecret: "azure-commons-storage-key",
    container: "company-journal",
    ledger: "_MEMORY/cpo.jsonl",
    index: "commons-cpo-memory",
    idPrefix: "cpom",
  },
  {
    label: "developer",
    account: "otchealthcommons",
    storeAcctSecret: "azure-commons-storage-account",
    storeKeySecret: "azure-commons-storage-key",
    container: "company-journal",
    ledger: "_MEMORY/developer.jsonl",
    index: "commons-developer-memory",
    idPrefix: "devm",
  },
];

// RETIRED compatibility code below supports an explicit BLOB_BACKEND=azure historical run only.
// Active AWS runs never call gtoken()/sm() for ring-ledger source reads.
function saRaw() {
  if (process.env.GCP_CLAUDE_DRIVER_SA_JSON) return process.env.GCP_CLAUDE_DRIVER_SA_JSON;
  try { try { return readFileSync(`${homedir()}/.gcp_claude_driver_sa.json`, "utf8"); } catch { return null; } } catch { return null; }
}
function saJwt(scope) {
  const raw = saRaw();
  if (!raw) return null;
  const sa = JSON.parse(raw);
  const now = Math.floor(Date.now() / 1000);
  const e = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const i = `${e({ alg: "RS256", typ: "JWT" })}.${e({ iss: sa.client_email, scope, aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 })}`;
  return i + "." + crypto.createSign("RSA-SHA256").update(i).sign(sa.private_key, "base64url");
}
async function gtoken() {
  const jwt = saJwt("https://www.googleapis.com/auth/cloud-platform");
  if (!jwt) return null; // no GCP SA available (expected post-migration) — Key Vault covers all secrets
  try {
    const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${encodeURIComponent(jwt)}` });
    const j = await r.json();
    return j.access_token || null;
  } catch { return null; }
}
async function sm(id, tok) { const _kv = await kvSecret(id); if (_kv != null) return _kv;
  if (!tok) return null; // no GCP fallback available; Key Vault is authoritative post-migration
  const r = await fetch(`https://secretmanager.googleapis.com/v1/projects/${SM}/secrets/${id}/versions/latest:access`, { headers: { Authorization: "Bearer " + tok } });
  if (!r.ok) return null;
  return Buffer.from((await r.json()).payload.data, "base64").toString("utf8").trim();
}
function blobSas(acct, key) {
  const sv = "2021-12-02", sp = "rl", ss = "b", srt = "co";
  const st = new Date(Date.now() - 3e5).toISOString().slice(0, 19) + "Z";
  const se = new Date(Date.now() + 72e5).toISOString().slice(0, 19) + "Z";
  const sts = [acct, sp, ss, srt, st, se, "", "https", sv, ""].join("\n") + "\n";
  const sig = crypto.createHmac("sha256", Buffer.from(key, "base64")).update(sts, "utf8").digest("base64");
  return new URLSearchParams({ sv, ss, srt, sp, st, se, spr: "https", sig }).toString();
}
const docId = (s) => String(s).replace(/[^A-Za-z0-9_\-=]/g, "_").slice(0, 900);

async function ensureIndex(AIS, AK, index) {
  const schema = { name: index, fields: [
    { name: "id", type: "Edm.String", key: true },
    { name: "type", type: "Edm.String", filterable: true, facetable: true },
    { name: "ts", type: "Edm.String", filterable: true, sortable: true },
    { name: "tags", type: "Edm.String", searchable: true },
    { name: "text", type: "Edm.String", searchable: true },
    { name: "contentVector", type: "Collection(Edm.Single)", searchable: true, retrievable: false, dimensions: DIMS, vectorSearchProfile: "vp" },
  ], vectorSearch: { algorithms: [{ name: "hnsw", kind: "hnsw" }], profiles: [{ name: "vp", algorithm: "hnsw" }] },
    semantic: { configurations: [{ name: "sem", prioritizedFields: { prioritizedContentFields: [{ fieldName: "text" }], prioritizedKeywordsFields: [{ fieldName: "tags" }] } }] } };
  // SKEW-PROOF (2026-07-14): a PUT that omits a field the LIVE index already has is a DELETION, and Azure
  // rejects it ("Existing field(s) 'X' cannot be deleted") -- taking this writer down on EVERY run from
  // that moment on. That is exactly how daily-digest died for a night when `indexed_at` was backfilled.
  // GET the live index and merge additively so the PUT is always a non-destructive superset.
  let putSchema = schema;
  try {
    const g = await fetch(`${AIS}/indexes/${index}?api-version=${API}`, { headers: { "api-key": AK } });
    if (g.ok) putSchema = mergeSchemaAdditive(schema, await g.json());
  } catch { /* absent / transient -> first-create path */ }
  const r = await fetch(`${AIS}/indexes/${index}?api-version=${API}`, { method: "PUT", headers: { "api-key": AK, "Content-Type": "application/json" }, body: JSON.stringify(putSchema) });
  if (!r.ok && r.status !== 204 && r.status !== 201 && r.status !== 200) throw new Error(`ensureIndex ${index}: ${r.status} ${(await r.text()).slice(0, 160)}`);
}

// FLEET-LEARNING: one shared index aggregating every NON-PRIVILEGED agent's ledger (agent-faceted), so
// any agent recalls what any other agent learned — the "learn from each other" layer. Privileged rings
// (clo-personal, cfo — marked private:true) are NEVER written here. Same schema as the per-agent index
// PLUS an `agent` field so recall shows/filters by who learned it.
export const FLEET_INDEX = "memory-exec"; // the EXISTING open shared brain (has an `agent` field);
// reused as the fleet-learning target because the AI Search service is at its index quota, AND memory-exec
// is already the cross-read layer every agent queries via kb_search/memory_recall — so non-privileged
// private-lane detail becomes fleet-learnable with zero new index and zero gateway change.
async function ensureFleetIndex(AIS, AK) {
  const schema = { name: FLEET_INDEX, fields: [
    { name: "id", type: "Edm.String", key: true },
    { name: "agent", type: "Edm.String", filterable: true, facetable: true, searchable: true },
    { name: "type", type: "Edm.String", filterable: true, facetable: true },
    { name: "ts", type: "Edm.String", filterable: true, sortable: true },
    { name: "tags", type: "Edm.String", searchable: true },
    { name: "text", type: "Edm.String", searchable: true },
    { name: "contentVector", type: "Collection(Edm.Single)", searchable: true, retrievable: false, dimensions: DIMS, vectorSearchProfile: "vp" },
  ], vectorSearch: { algorithms: [{ name: "hnsw", kind: "hnsw" }], profiles: [{ name: "vp", algorithm: "hnsw" }] },
    semantic: { configurations: [{ name: "sem", prioritizedFields: { prioritizedContentFields: [{ fieldName: "text" }], prioritizedKeywordsFields: [{ fieldName: "tags" }] } }] } };
  // SKEW-PROOF (2026-07-14): a PUT that omits a field the LIVE index already has is a DELETION, and Azure
  // rejects it ("Existing field(s) 'X' cannot be deleted") -- taking this writer down on EVERY run from
  // that moment on. That is exactly how daily-digest died for a night when `indexed_at` was backfilled.
  // GET the live index and merge additively so the PUT is always a non-destructive superset.
  let putSchema = schema;
  try {
    const g = await fetch(`${AIS}/indexes/${FLEET_INDEX}?api-version=${API}`, { headers: { "api-key": AK } });
    if (g.ok) putSchema = mergeSchemaAdditive(schema, await g.json());
  } catch { /* absent / transient -> first-create path */ }
  const r = await fetch(`${AIS}/indexes/${FLEET_INDEX}?api-version=${API}`, { method: "PUT", headers: { "api-key": AK, "Content-Type": "application/json" }, body: JSON.stringify(putSchema) });
  if (!r.ok && ![200, 201, 204].includes(r.status)) throw new Error(`ensureFleetIndex: ${r.status} ${(await r.text()).slice(0, 160)}`);
}

// ============================ backend dispatch (SEARCH_BACKEND / EMBEDDINGS_PROVIDER) ============================
// Thin destination/embedding wrappers keep indexRing()/run()/reconcileFleetDupes() backend-neutral.
// The ledger source is dispatched independently by BLOB_BACKEND through readRingLedger().
export async function ensureIdx(azure, index) {
  if (BACKEND === "opensearch") { await OS.ensureIndex(index); return; }
  await ensureIndex(azure.AIS, azure.AK, index);
}
export async function ensureFleetIdx(azure) {
  if (BACKEND === "opensearch") { await OS.ensureIndex(FLEET_INDEX); return; }
  await ensureFleetIndex(azure.AIS, azure.AK);
}
export async function embedTexts(azure, texts) {
  if (EMBEDDINGS_PROVIDER === "openai") return OS.embedOpenAI(texts);
  return embed(azure.AOAI, azure.AOK, azure.DEP, texts);
}
/** Push a batch of full-doc `{"@search.action":"mergeOrUpload", ...fields}` rows. On OpenSearch this
 *  strips the Azure action marker and routes through pushDocs()'s "update"+doc_as_upsert bulk write --
 *  every row indexRing() builds is a full doc (every field given), so this is a strict semantic match to
 *  Azure's mergeOrUpload for this file's own call sites (see opensearch-write.mjs's header for the
 *  general full-vs-partial reasoning, which applies uniformly regardless). */
export async function pushBatch(azure, index, value) {
  if (!value.length) return;
  if (BACKEND === "opensearch") {
    const docs = value.map(({ "@search.action": _drop, ...rest }) => rest);
    const res = await OS.pushDocs(index, docs);
    if (!res.ok) throw new Error(`opensearch push(${index}) failed: ${JSON.stringify(res.errors.slice(0, 3))}`);
    return;
  }
  await fetch(`${azure.AIS}/indexes/${index}/docs/index?api-version=${API}`, { method: "POST", headers: { "api-key": azure.AK, "Content-Type": "application/json" }, body: JSON.stringify({ value }) });
}

async function embed(AOAI, AOK, DEP, texts) {
  for (let a = 0; a < 6; a++) {
    const r = await fetch(`${AOAI}/openai/deployments/${DEP}/embeddings?api-version=2024-02-01`, { method: "POST", headers: { "api-key": AOK, "Content-Type": "application/json" }, body: JSON.stringify({ input: texts }) });
    if (r.status === 429) { await new Promise((s) => setTimeout(s, 1500 * (a + 1))); continue; }
    if (!r.ok) throw new Error("embed " + r.status);
    return (await r.json()).data.map((d) => d.embedding);
  }
  throw new Error("embed 429 exhausted");
}
function entryText(eR) {
  const tags = Array.isArray(eR.tags) ? eR.tags.join(" ") : eR.tags || "";
  return `[${eR.type || "entry"}] ${eR.text || eR.evalue || eR.value || ""} ${tags}`.trim().slice(0, 8000);
}

// The fallback id used when a row has no real ledger `.id` (defensive: real rows written by mem.mjs's
// append() always have one). Pure, exported so fleetKeyFor()'s test can reproduce it exactly.
export const fallbackRowId = (ring, eR, k) => eR.id || `${ring.idPrefix}-${k}-${(eR.ts || "").slice(0, 19)}`;

// THE CONVERGED fleet-index key (defect-1 fix, 2026-07-21) for one ring ledger row: the SAME formula
// (semantic.mjs's own docId(), imported not reimplemented) semantic.mjs's reindex() uses for this exact
// source entry (agent=ring.label, id=eR.id) when/if it is also `--share`d to the exec feed -- so the two
// writers land on ONE row instead of two, from either writer, in either order. A named, exported function
// (not inlined in indexRing() below) so the convergence property is unit-testable against the REAL
// production code path rather than a test-side reimplementation that could silently drift from it.
export function fleetKeyFor(ring, eR, k) {
  return sharedDocId(ring.label, fallbackRowId(ring, eR, k));
}

/** Read one ring ledger from the selected source backend. S3 is authoritative after Azure retirement;
 * Azure remains an explicit legacy mode only. Returns text|null and throws loud on non-404 S3 errors. */
export async function readRingLedger(ring, tok) {
  if (BLOB_BACKEND !== "azure") return getTextFromS3(ring.account, ring.container, ring.ledger);
  const [acct, key] = await Promise.all([sm(ring.storeAcctSecret, tok), sm(ring.storeKeySecret, tok)]);
  if (!acct || !key) throw new Error("ring store creds missing");
  const sas = blobSas(acct, key);
  const rr = await fetch(`https://${acct}.blob.core.windows.net/${ring.container}/${ring.ledger.split("/").map(encodeURIComponent).join("/")}?${sas}`);
  if (!rr.ok) throw new Error(`ledger read ${rr.status}`);
  return rr.text();
}

/** Pure incremental planner. OpenSearch runs embed only rows missing from at least one target;
 * Azure legacy mode retains the historical full-upsert behavior. */
export function planIncremental(prep, ringExisting, fleetExisting, toFleet, incremental = true) {
  return prep.map((c) => ({
    ...c,
    needRing: !incremental || !ringExisting.has(c.id),
    needFleet: Boolean(toFleet && (!incremental || !fleetExisting.has(c.fleetId))),
  })).filter((c) => c.needRing || c.needFleet);
}

/** Index one ring's ledger into its index. Returns {label, indexed, total} or {label, error}. Fail-safe. */
export async function indexRing(ring, azure, tok) {
  try {
    const text = await readRingLedger(ring, tok);
    if (text == null) return { label: ring.label, error: "ledger missing" };
    const rows = text.split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    await ensureIdx(azure, ring.index);
    const prep = rows.map((eR, k) => ({
      id: docId(fallbackRowId(ring, eR, k)),
      fleetId: fleetKeyFor(ring, eR, k),
      type: eR.type || "", ts: eR.ts || "",
      tags: Array.isArray(eR.tags) ? eR.tags.join(", ") : eR.tags || "",
      text: entryText(eR),
      // Raw (non type-prefixed) text, matching semantic.mjs's stored `text` field convention exactly —
      // "ONE text format for a given source entry" so a converged doc's content does not ping-pong
      // between formats depending on which writer touched it last.
      rawText: (eR.text || eR.evalue || eR.value || "").slice(0, 16000),
    })).filter((d) => d.text);
    // Non-privileged rings ALSO feed the shared fleet-learning index (agent-faceted). Privileged rings
    // (private:true) never do — their content stays walled to their own index.
    const toFleet = !ring.private;
    // OpenSearch-only incremental mode: source ledgers can be large, and re-embedding rows already
    // present in both targets wastes paid API calls and can introduce avoidable vector churn.
    const ringExisting = BACKEND === "opensearch" ? await OS.existingIds(ring.index) : new Set();
    const fleetExisting = BACKEND === "opensearch" && toFleet ? await OS.existingIds(FLEET_INDEX) : new Set();
    const pending = planIncremental(prep, ringExisting, fleetExisting, toFleet, BACKEND === "opensearch");
    let indexed = 0, fleetIndexed = 0, buf = [], fleetBuf = [];
    for (let i = 0; i < pending.length; i += EMBED_BATCH) {
      const chunk = pending.slice(i, i + EMBED_BATCH);
      let vecs;
      try { vecs = await embedTexts(azure, chunk.map((c) => c.text)); } catch { continue; }
      chunk.forEach((c, j) => {
        if (c.needRing) buf.push({ "@search.action": "mergeOrUpload", id: c.id, type: c.type, ts: c.ts, tags: c.tags, text: c.text.slice(0, 16000), contentVector: vecs[j] });
        if (c.needFleet) fleetBuf.push({ "@search.action": "mergeOrUpload", id: c.fleetId, agent: ring.label, type: c.type, ts: c.ts, tags: c.tags, text: c.rawText, contentVector: vecs[j] });
      });
      if (buf.length >= PUSH_BATCH) { await pushBatch(azure, ring.index, buf); indexed += buf.length; buf = []; }
      if (fleetBuf.length >= PUSH_BATCH) { await pushBatch(azure, FLEET_INDEX, fleetBuf); fleetIndexed += fleetBuf.length; fleetBuf = []; }
    }
    await pushBatch(azure, ring.index, buf); indexed += buf.length;
    if (toFleet) { await pushBatch(azure, FLEET_INDEX, fleetBuf); fleetIndexed += fleetBuf.length; }
    return { label: ring.label, index: ring.index, indexed, fleetIndexed, pending: pending.length, total: rows.length, fleet: toFleet };
  } catch (e) {
    return { label: ring.label, error: String((e && e.message) || e) };
  }
}

export async function run(filterLabel) {
  const tok = BLOB_BACKEND === "azure" ? await gtoken() : null;
  // Skip resolving Azure Search/Foundry secrets entirely when BOTH the index destination and the
  // embeddings provider are already off Azure -- the genuine emergency case (Azure billing-blocked)
  // this dispatch exists for. Harmless either way (indexRing()'s dispatch helpers never reference
  // `azure.*` in that combination), but skipping avoids 7 pointless Key Vault round trips (each a
  // potential timeout) during exactly the run where speed matters most. `azure` stays a well-formed
  // placeholder object so nothing downstream needs an extra null check.
  const azureNeeded = BACKEND !== "opensearch" || EMBEDDINGS_PROVIDER !== "openai";
  let azure = { AIS: "", AK: undefined, AOAI: "", AOK: undefined, DEP: "text-embedding-3-large" };
  if (azureNeeded) {
    const [ep, AK, aoaiA, aoaiB, keyA, keyB, dep] = await Promise.all([
      sm("azure-search-endpoint", tok), sm("azure-search-admin-key", tok),
      sm("azure-foundry-openai-endpoint", tok), sm("azure-openai-endpoint", tok),
      sm("azure-foundry-key", tok), sm("azure-openai-key", tok),
      sm("azure-openai-embedding-deployment", tok),
    ]);
    azure = { AIS: (ep || "").replace(/\/$/, ""), AK, AOAI: ((aoaiA || aoaiB) || "").replace(/\/$/, ""), AOK: keyA || keyB, DEP: dep || "text-embedding-3-large" };
  }
  const rings = RINGS.filter((r) => !filterLabel || filterLabel === "all" || r.label === filterLabel);
  // Ensure the shared fleet-learning index exists if any non-privileged ring is in scope.
  if (FLEET_INDEX !== "memory-exec" && rings.some((r) => !r.private)) { try { await ensureFleetIdx(azure); } catch (e) { console.error("fleet index ensure failed (per-agent indexing continues):", e.message); } }
  const out = [];
  for (const ring of rings) out.push(await indexRing(ring, azure, tok)); // sequential: fail-safe, bounded quota
  return out;
}

// ============================ FLEET-DUPE RECONCILE (defect-1 cleanup) ============================
// One-shot cleanup for the ~882 pre-fix `fleet__*` duplicate rows already sitting in `memory-exec` (the
// old id scheme this file used before the convergence fix above). Dry-run by default; NEVER deletes
// unless called with { apply: true } / `--apply` on the CLI. The CTO runs this, not the builder.

// Pure: given the full memory-exec doc set ({id, agent, ts}), decide which `fleet__`-prefixed ids are
// SAFE to delete (a converged, non-`fleet__` doc holding the SAME fact already exists) vs which must be
// KEPT (no twin yet -- deleting would silently drop the only copy of a fact that was never `--share`d,
// so semantic.mjs never indexed it, and this ring has not been re-indexed under the converged scheme
// since the fix shipped). (agent,ts) is an exact, collision-safe join key: mem.mjs's append() stamps
// `ts` ONCE via `new Date().toISOString()` on the entry object and copies that SAME value into every
// place the entry is written (the private ledger row AND, if shared, the exec-feed copy), and a fresh
// converged fleet push carries the identical `ts` too (see indexRing() above) -- so two docs sharing
// (agent,ts) are always the same source entry, never a coincidence (millisecond-precision timestamps on
// CLI-driven writes that take >>1ms each). Pure, no I/O; exported for unit tests.
export function planFleetDupeCleanup(docs) {
  const isFleet = (id) => typeof id === "string" && id.startsWith("fleet__");
  const key = (d) => `${d.agent || ""} ${d.ts || ""}`;
  const otherKeys = new Set();
  for (const d of docs || []) { if (d && !isFleet(d.id) && d.ts) otherKeys.add(key(d)); }
  const toDelete = [], kept = [];
  for (const d of docs || []) {
    if (!d || !isFleet(d.id)) continue;
    if (d.ts && otherKeys.has(key(d))) toDelete.push(d.id);
    else kept.push(d.id);
  }
  return { toDelete, kept };
}

// Paginated listing of every doc's {id, agent, ts} in FLEET_INDEX. Mirrors semantic.mjs's existingIds()
// pagination pattern (1000/page via $skip, same 100000 bound -- already proven sufficient for this
// index's live size).
async function listMemoryExecDocs(AIS, AK) {
  const out = [];
  for (let skip = 0; skip < 100000; skip += 1000) {
    const r = await fetch(`${AIS}/indexes/${FLEET_INDEX}/docs?api-version=${API}&$select=id,agent,ts&$top=1000&$skip=${skip}`, { headers: { "api-key": AK } });
    if (!r.ok) break;
    const v = (await r.json()).value || [];
    out.push(...v);
    if (v.length < 1000) break;
  }
  return out;
}

/**
 * List (and, only with apply:true, DELETE) the pre-fix `fleet__*` duplicate rows in memory-exec.
 * Dry-run (apply:false, the default) does a read-only scan and returns the plan without deleting
 * anything. Safe to run at any time, including before a fresh `run all` -- planFleetDupeCleanup only
 * ever proposes deleting a `fleet__*` doc that ALREADY has a converged twin, so it can never orphan a
 * fact regardless of ordering (see that function's doc comment).
 */
export async function reconcileFleetDupes({ apply = false } = {}) {
  let docs, doDelete;
  if (BACKEND === "opensearch") {
    docs = await OS.scrollAll(FLEET_INDEX, { source: ["agent", "ts"] });
    doDelete = async (ids) => {
      const res = await OS.deleteDocs(FLEET_INDEX, ids);
      if (!res.ok) throw new Error("delete(opensearch) " + JSON.stringify(res.errors.slice(0, 3)));
    };
  } else {
    const tok = await gtoken();
    const [ep, AK] = await Promise.all([sm("azure-search-endpoint", tok), sm("azure-search-admin-key", tok)]);
    const AIS = (ep || "").replace(/\/$/, "");
    if (!AIS || !AK) throw new Error("missing azure-search-endpoint/admin-key");
    docs = await listMemoryExecDocs(AIS, AK);
    doDelete = async (ids) => {
      for (let i = 0; i < ids.length; i += 1000) {
        const batch = ids.slice(i, i + 1000).map((id) => ({ "@search.action": "delete", id }));
        const r = await fetch(`${AIS}/indexes/${FLEET_INDEX}/docs/index?api-version=${API}`, { method: "POST", headers: { "api-key": AK, "Content-Type": "application/json" }, body: JSON.stringify({ value: batch }) });
        if (!r.ok) throw new Error("delete " + r.status + " " + (await r.text()).slice(0, 200));
      }
    };
  }
  const { toDelete, kept } = planFleetDupeCleanup(docs);
  if (apply && toDelete.length) await doDelete(toDelete);
  return { total: docs.length, toDelete: toDelete.length, kept: kept.length, apply: !!apply };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const cliArgs = process.argv.slice(2);
  if (cliArgs.includes("reconcile-fleet-dupes")) {
    const apply = cliArgs.includes("--apply");
    reconcileFleetDupes({ apply })
      .then((r) => {
        console.log(`reconcile-fleet-dupes: scanned ${r.total} memory-exec doc(s); ${r.toDelete} fleet__* duplicate(s) ${apply ? "DELETED" : "would delete (dry-run, pass --apply to actually delete)"}; ${r.kept} fleet__* doc(s) kept (no converged twin yet -- run 'node index-ring-memory.mjs run all' first to backfill, then re-run this).`);
      })
      .catch((e) => { console.error("reconcile-fleet-dupes fatal:", e.message); process.exit(1); });
  } else {
    const arg = cliArgs.find((a) => !a.startsWith("--")) || "all";
    run(arg).then(async (res) => {
      for (const r of res) console.log(r.error ? `RING ${r.label}: ERROR ${r.error}` : `RING ${r.label}: indexed ${r.indexed}/${r.total} -> ${r.index}${r.fleet ? ` (+ ${FLEET_INDEX})` : " (PRIVATE, not in fleet)"}`);
      // SELF-HEAL (2026-07-21): after a FULL reindex, purge the pre-fix `fleet__*` duplicates whose
      // content now has a converged twin, so the scheduled ring-memory-index-daily job clears the ~882
      // legacy dupes over its next runs with NO manual step. Safe by construction -- planFleetDupeCleanup
      // only deletes a `fleet__*` doc that has an exact (agent, ts) twin, so a never-shared fact is never
      // dropped -- and idempotent. Only on a full `run all` (a single-ring run must not reconcile across
      // the whole fleet index). Non-fatal: a reconcile error never fails the reindex. RING_NO_AUTO_RECONCILE=1 opts out.
      if (arg === "all" && process.env.RING_NO_AUTO_RECONCILE !== "1") {
        try { const rc = await reconcileFleetDupes({ apply: true }); console.log(`reconcile-fleet-dupes (post-run-all): DELETED ${rc.toDelete} converged dupe(s), kept ${rc.kept}.`); }
        catch (e) { console.error("post-run-all reconcile (non-fatal):", e.message); }
      }
    })
      .catch((e) => { console.error("ring-memory-index fatal:", e.message); process.exit(1); });
  }
}

export default { RINGS, FLEET_INDEX, indexRing, run, fallbackRowId, fleetKeyFor, planFleetDupeCleanup, reconcileFleetDupes };
