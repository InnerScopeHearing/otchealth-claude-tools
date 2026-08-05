#!/usr/bin/env node
/**
 * search-reaper — orphan search-document garbage collector for the Azure AI Search brain
 * (otchealth-dataroom-s1, chunked schema: chunk_id/parent_id/title/path/chunk/text_vector).
 *
 * THE BUG (root-caused firsthand by the CTO, 2026-08): all 18 native blob pull-indexer
 * datasources on otchealth-dataroom-s1 have `dataDeletionDetectionPolicy: null`. When a source
 * blob is deleted (soft-deleted to a `_TRASH/` prefix, purged, reorganized, whatever), the search
 * documents that were indexed FROM it are never removed. The index accumulates permanent ghost
 * documents that still rank in search results and crowd out live ones. Verified live: the
 * `legal-personal` index (165,983 total chunk docs at last count) has a real, non-trivial orphan
 * backlog. A deletion-detection POLICY (built separately) only catches FUTURE deletes going
 * forward; this tool is the reaper that clears the EXISTING backlog and doubles as ongoing GC for
 * anything the policy misses (policy outages, out-of-band deletes, etc).
 *
 * WHAT "ORPHAN" MEANS HERE: a chunk_id whose `path` field (the full source blob URL the pull
 * indexer read it from) no longer resolves to a real blob (a definitive 404 on a HEAD request).
 * This is deliberately narrower than "everything under a _TRASH/ prefix" — a _TRASH-prefixed path
 * may still be a perfectly real blob (soft-delete moves files, it does not always remove them),
 * and this tool only ever acts on a *confirmed-gone* blob, never on a naming convention.
 *
 * INDEX -> CONTAINER MAPPING IS LIVE, NEVER HARDCODED. Which blob container(s) (and query-prefix
 * scopes) actually feed a given index is read at run time from the real datasource + indexer
 * definitions (GET /datasources, GET /indexers, joined on dataSourceName -> targetIndexName). New
 * datasources (e.g. the ~15 that already feed commons-company-journal, and any added later) are
 * picked up automatically with no code change here. Azure Search redacts datasource
 * `credentials.connectionString` on GET (by design — there is no API that returns a live
 * storage-account key), so the STORAGE ACCOUNT NAME + KEY used to actually check blob existence
 * still has to come from a small container -> Key-Vault-secret-name table (CONTAINER_ACCOUNT_MAP
 * below). That table mirrors, secret-name-for-secret-name, the exact PROFILES credential
 * resolution skills/doc-indexer/indexer.mjs and skills/fleet-backup/backup.mjs already use for
 * these same accounts (otchealthcfodata / otchealthlegalstore / otchealthcommerce /
 * otchealthcommons) — it is a credential lookup, not an index-to-container hardcode, and every
 * per-doc path is cross-checked against the account that credential map resolves before any HEAD
 * check runs (see the "account mismatch" error class below).
 *
 * SAFETY (load-bearing, read before changing):
 *   1. An existence check that ERRORS (network failure, 401/403/429, 5xx, an unparseable path, an
 *      unrecognized container, an account-name mismatch) is NEVER treated as "blob missing". Only
 *      a literal HTTP 404 on the HEAD request counts as missing. See headBlobExists() and its
 *      test coverage. A run with an abnormally high error rate refuses to delete anything at all
 *      (the circuit breaker in reapIndex()) rather than risk mass-deleting live documents because
 *      of a bad key, a throttle storm, or a network blip.
 *   2. A doc whose `path` contains "CANARY" (case-insensitive) is NEVER deleted, full stop — an
 *      active investigation canary is in flight fleet-wide. isCanaryPath() short-circuits those
 *      paths out of the existence-check / delete pipeline entirely before any HEAD request or
 *      delete batch is built.
 *   3. `reap` is dry-run BY DEFAULT. Nothing is ever deleted unless the caller passes --commit.
 *      Without --commit, reapIndex() computes and reports exactly what it WOULD delete and returns
 *      before making a single call to the docs/index (delete) endpoint.
 *   4. This tool only ever reads chunk_id + path from the search index (never `chunk` — the
 *      indexed text — or `text_vector`) and only ever does a HEAD (never GET) against blob
 *      storage. It never reads, logs, or emits blob or document CONTENT. This matters most for
 *      `legal-personal`, which is attorney-privileged — the reaper is safe to run against it
 *      because it operates on existence metadata only, never privileged content.
 *
 * USAGE:
 *   node reaper.mjs scan --index legal-personal [--prefix <blob-path-prefix>]
 *   node reaper.mjs scan --all
 *   node reaper.mjs reap --index legal-personal [--commit] [--prefix <blob-path-prefix>]
 *   node reaper.mjs reap --all --commit
 *
 * CREDENTIALS: kvSecret() from skills/kb-memory/azure-secret.mjs (Key Vault, fail-open, tries
 * managed identity -> SP -> az-CLI in order — see that file's header). Secret names:
 *   azure-search-endpoint / azure-search-admin-key           the search service itself
 *   azure-{legal,cfo,commerce,commons}-storage-{account,key}  per-room blob credentials
 */

import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { kvSecret } from "../kb-memory/azure-secret.mjs";

const API_VERSION = "2024-07-01";

// ---------------------------------------------------------------------------------------------
// Container -> credential-secret-name mapping. Mirrors skills/doc-indexer/indexer.mjs's PROFILES
// table exactly (same secret names, same accounts) — this is a CREDENTIAL lookup, not the
// index-to-container association (that comes live from the datasource/indexer definitions, see
// getIndexSources() below). Add a row here only when a genuinely new storage account/container
// joins the fleet's blob-backed search rooms.
// ---------------------------------------------------------------------------------------------
export const CONTAINER_ACCOUNT_MAP = {
  "cfo-source-docs": { accountSecret: "azure-cfo-storage-account", keySecret: "azure-cfo-storage-key", accountFallback: "otchealthcfodata" },
  "company": { accountSecret: "azure-legal-storage-account", keySecret: "azure-legal-storage-key", accountFallback: "otchealthlegalstore" },
  "personal": { accountSecret: "azure-legal-storage-account", keySecret: "azure-legal-storage-key", accountFallback: "otchealthlegalstore" },
  "commerce-source-docs": { accountSecret: "azure-commerce-storage-account", keySecret: "azure-commerce-storage-key", accountFallback: "otchealthcommerce" },
  "company-journal": { accountSecret: "azure-commons-storage-account", keySecret: "azure-commons-storage-key", accountFallback: "otchealthcommons" },
};

/** Pure lookup — null for an unrecognized container (never guesses / never defaults). */
export function resolveContainerCredentials(containerName) {
  return CONTAINER_ACCOUNT_MAP[containerName] || null;
}

// ---------------------------------------------------------------------------------------------
// Pure helpers (no network) — the load-bearing safety logic lives here and is unit-tested directly.
// ---------------------------------------------------------------------------------------------

/** Escape a value for embedding in an OData $filter string literal (double single quotes). */
export function oDataEscape(s) {
  return String(s).replace(/'/g, "''");
}

/** A doc `path` (e.g. https://acct.blob.core.windows.net/container/some/blob%20path.txt) is
 *  parsed into {account, container, blobPath}. blobPath keeps whatever URL-encoding the search
 *  index stored (so re-appending it to a HEAD request URL is byte-correct). Returns null for
 *  anything that doesn't look like a blob.core.windows.net URL — callers must treat that as an
 *  ERROR (unparseable), never as "missing".*/
export function parseBlobUrl(pathUrl) {
  if (typeof pathUrl !== "string") return null;
  const m = pathUrl.match(/^https:\/\/([a-z0-9]+)\.blob\.core\.windows\.net\/([^/]+)\/(.+)$/i);
  if (!m) return null;
  return { account: m[1], container: m[2], blobPath: m[3] };
}

/** CANARY EXCLUSION (hardcoded, load-bearing): a path referencing an active investigation canary
 *  must never be touched. Case-insensitive on purpose — never rely on a caller getting the case
 *  exactly right for a safety exclusion. */
export function isCanaryPath(pathUrl) {
  return typeof pathUrl === "string" && /canary/i.test(pathUrl);
}

/** Read-only account SAS (permissions "rl": read + list only — this tool never needs write/delete
 *  on blob storage, only existence checks) for HEAD requests against special-char blob names,
 *  mirroring skills/doc-indexer/indexer.mjs's buildAzSas pattern (account-level SAS avoids the
 *  per-request SharedKey canonicalization 403s that special characters in blob names trigger).
 *  Pure given (account, key, now) — no network, unit-testable. */
export function buildAccountSas({ account, key, now = Date.now(), ttlMs = 3600_000 } = {}) {
  const sv = "2021-12-02", sp = "rl", ss = "b", srt = "co";
  const st = new Date(now - 5 * 60000).toISOString().slice(0, 19) + "Z";
  const se = new Date(now + ttlMs).toISOString().slice(0, 19) + "Z";
  const sts = [account, sp, ss, srt, st, se, "", "https", sv, ""].join("\n") + "\n";
  const sig = crypto.createHmac("sha256", Buffer.from(key, "base64")).update(sts, "utf8").digest("base64");
  return new URLSearchParams({ sv, ss, srt, sp, st, se, spr: "https", sig }).toString();
}

/** Batch chunker — Azure Search's docs/index (batch upload/delete) endpoint caps at 1000 actions
 *  per request. */
export function chunkArray(arr, size = 1000) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Build a delete-batch body for the docs/index endpoint, keyed on chunk_id (the index's key field). */
export function buildDeleteBatch(chunkIds) {
  return { value: chunkIds.map((id) => ({ "@search.action": "delete", chunk_id: id })) };
}

/** Parse a docs/index batch response body (200 = all ok, 207 = partial failure — Azure Search
 *  reports success/failure PER ITEM in both cases via each item's `status` boolean; the overall
 *  HTTP status alone never tells you which items actually failed). */
export function parseIndexBatchResponse(body) {
  const succeeded = [];
  const failed = [];
  for (const r of (body && body.value) || []) {
    if (r && r.status) succeeded.push(r.key);
    else failed.push({ key: r && r.key, statusCode: r && r.statusCode, errorMessage: r && r.errorMessage });
  }
  return { succeeded, failed };
}

/** Bounded-concurrency map — keeps HEAD-request fan-out reasonable instead of firing thousands of
 *  simultaneous requests at blob storage. */
async function mapWithConcurrency(items, limit, fn) {
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      await fn(items[i], i);
    }
  }
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker);
  await Promise.all(workers);
}

// ---------------------------------------------------------------------------------------------
// Network-touching helpers (all take an injectable fetchImpl so tests never hit a real network).
// ---------------------------------------------------------------------------------------------

/** HEAD a blob URL through an account SAS. Returns exactly one of "exists" | "missing" | "error".
 *  SAFETY: only a literal 404 is "missing". Everything else — a thrown network error, a non-404
 *  non-2xx status (401/403/429/5xx included) — is "error", never "missing". This is the single
 *  most load-bearing function in this file; see the test suite for the pinned behaviour. */
export async function headBlobExists(url, sas, { fetchImpl = fetch } = {}) {
  try {
    const r = await fetchImpl(`${url}?${sas}`, { method: "HEAD" });
    if (r.status === 404) return "missing";
    if (r.ok) return "exists";
    return "error";
  } catch {
    return "error";
  }
}

/** POST one delete batch (<=1000 chunk_ids) to the docs/index endpoint. Throws on a genuinely
 *  unexpected HTTP status (neither 200 nor 207); otherwise returns the parsed per-item result. */
export async function postDeleteBatch(endpoint, key, indexName, chunkIds, { fetchImpl = fetch, apiVersion = API_VERSION } = {}) {
  const batch = buildDeleteBatch(chunkIds);
  const r = await fetchImpl(`${endpoint}/indexes/${encodeURIComponent(indexName)}/docs/index?api-version=${apiVersion}`, {
    method: "POST",
    headers: { "api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify(batch),
  });
  const body = await r.json().catch(() => ({}));
  if (r.status !== 200 && r.status !== 207) {
    throw new Error(`docs/index delete batch -> ${r.status}: ${JSON.stringify(body).slice(0, 300)}`);
  }
  return parseIndexBatchResponse(body);
}

/** Join /datasources and /indexers (live) to find which blob container(s)+query-prefix scopes
 *  actually feed `indexName`. Returns [] for an index with no native blob pull-indexer at all
 *  (e.g. memory-exec, which is written directly by brain-reindex, not a pull-indexer) — callers
 *  must treat that as "not blob-backed, nothing to reap here", not an error. NEVER hardcodes which
 *  containers back which index; this is the one live source of truth for that association. */
export async function getIndexSources(endpoint, key, indexName, { fetchImpl = fetch, apiVersion = API_VERSION } = {}) {
  const [dsResp, ixResp] = await Promise.all([
    fetchImpl(`${endpoint}/datasources?api-version=${apiVersion}`, { headers: { "api-key": key } }),
    fetchImpl(`${endpoint}/indexers?api-version=${apiVersion}`, { headers: { "api-key": key } }),
  ]);
  if (!dsResp.ok) throw new Error(`GET /datasources -> ${dsResp.status}`);
  if (!ixResp.ok) throw new Error(`GET /indexers -> ${ixResp.status}`);
  const ds = ((await dsResp.json()).value) || [];
  const ix = ((await ixResp.json()).value) || [];
  const dsByName = new Map(ds.map((d) => [d.name, d]));
  const sources = [];
  for (const indexer of ix) {
    if (indexer.targetIndexName !== indexName) continue;
    const d = dsByName.get(indexer.dataSourceName);
    if (!d) continue;
    sources.push({
      indexer: indexer.name,
      datasource: d.name,
      container: { name: d.container && d.container.name, query: (d.container && d.container.query) || "" },
    });
  }
  return sources;
}

/** List every distinct targetIndexName among the live indexers — the live source for `--all`
 *  (never a hardcoded index list). */
export async function listBlobBackedIndexes(endpoint, key, { fetchImpl = fetch, apiVersion = API_VERSION } = {}) {
  const r = await fetchImpl(`${endpoint}/indexers?api-version=${apiVersion}&$select=targetIndexName`, { headers: { "api-key": key } });
  if (!r.ok) throw new Error(`GET /indexers -> ${r.status}`);
  const j = await r.json();
  return [...new Set(((j.value) || []).map((i) => i.targetIndexName).filter(Boolean))];
}

/** Drain an index's chunk_id+path pairs via KEYSET pagination (orderby chunk_id asc, filter
 *  chunk_id gt <last>), NOT $skip. Azure AI Search caps $skip at 100,000 total; legal-personal
 *  alone already has 165,983 docs (fleet-backup/backup.mjs hit this exact ceiling and had to warn
 *  about it — see its exportBrainIndexToBlob header). Keyset pagination on the sortable/filterable
 *  key field has no such ceiling. Only ever selects chunk_id + path — never `chunk` (indexed text)
 *  or `text_vector` — so this tool never reads document content, only existence metadata. */
export async function* iterateIndexDocs(endpoint, key, indexName, { pageSize = 1000, apiVersion = API_VERSION, fetchImpl = fetch } = {}) {
  let last = null;
  for (;;) {
    const body = { search: "*", top: pageSize, orderby: "chunk_id asc", select: "chunk_id,path" };
    if (last != null) body.filter = `chunk_id gt '${oDataEscape(last)}'`;
    const r = await fetchImpl(`${endpoint}/indexes/${encodeURIComponent(indexName)}/docs/search?api-version=${apiVersion}`, {
      method: "POST",
      headers: { "api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`docs/search ${indexName} -> ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j = await r.json();
    const docs = j.value || [];
    if (!docs.length) break;
    yield docs;
    last = docs[docs.length - 1].chunk_id;
    if (docs.length < pageSize) break;
  }
}

/** Default per-container credential resolver: Key Vault via kvSecret(), following the mapping in
 *  CONTAINER_ACCOUNT_MAP (mirrors doc-indexer/backup.mjs's exact secret names). Returns null when
 *  the container is unrecognized or a secret can't be resolved — callers treat that as an error
 *  class ("no credentials"), never as "the blob is missing". Injectable via
 *  evaluateIndex(opts.resolveContainerCreds) so tests never touch Key Vault / the network. */
async function defaultResolveContainerCreds(containerName) {
  const mapping = resolveContainerCredentials(containerName);
  if (!mapping) return null;
  const account = (await kvSecret(mapping.accountSecret)) || mapping.accountFallback;
  const accountKey = await kvSecret(mapping.keySecret);
  if (!account || !accountKey) return null;
  return { account, key: accountKey };
}

/** Resolve the search-service endpoint + admin key (Key Vault, with env overrides for local/CI use). */
export async function getSearchContext() {
  const endpoint = (process.env.AZURE_SEARCH_ENDPOINT || (await kvSecret("azure-search-endpoint")) || "").replace(/\/$/, "");
  const key = process.env.AZURE_SEARCH_ADMIN_KEY || (await kvSecret("azure-search-admin-key"));
  if (!endpoint || !key) throw new Error("Missing azure-search-endpoint / azure-search-admin-key (Key Vault or env AZURE_SEARCH_ENDPOINT/AZURE_SEARCH_ADMIN_KEY)");
  return { endpoint, key };
}

// ---------------------------------------------------------------------------------------------
// Core orchestration — shared by scan (read-only) and reap (scan + conditional delete).
// ---------------------------------------------------------------------------------------------

/**
 * Drain the index, classify every unique source `path` as exists/missing/error/canary, and return
 * a full summary. READ-ONLY — never deletes anything, never mutates the index. `reapIndex()`
 * below calls this and then conditionally deletes based on the result.
 */
export async function evaluateIndex(ctx, indexName, opts = {}) {
  const { fetchImpl = fetch, concurrency = 16, prefix = null, pageSize = 1000, resolveContainerCreds = defaultResolveContainerCreds } = opts;
  const { endpoint, key } = ctx;

  const sources = await getIndexSources(endpoint, key, indexName, { fetchImpl });
  if (!sources.length) {
    return {
      index: indexName, blobBacked: false, expectedContainers: [],
      totalDocs: 0, uniquePaths: 0, existing: 0, missing: 0, errors: 0,
      canaryPaths: 0, canaryDocs: 0, missingChunkIds: [], missingPathsSample: [],
      errorPathsSample: [], unexpectedContainerSample: [],
      note: "no native pull-indexer datasource targets this index (not blob-backed — e.g. memory-exec, which is written directly by brain-reindex) — nothing to check",
    };
  }
  const expectedContainers = [...new Set(sources.map((s) => s.container.name).filter(Boolean))];

  // Resolve credentials ONCE per container (not per doc).
  const containerCreds = new Map();
  for (const c of expectedContainers) {
    containerCreds.set(c, await resolveContainerCreds(c));
  }

  // Drain the index (chunk_id + path only — never document content), grouping by unique path so
  // every source blob is HEAD-checked exactly once no matter how many chunks it produced.
  const byPath = new Map(); // path -> { chunkIds: [], canary: bool }
  let totalDocs = 0;
  for await (const page of iterateIndexDocs(endpoint, key, indexName, { pageSize, fetchImpl })) {
    for (const d of page) {
      const p = d.path;
      if (prefix) {
        const parsed = parseBlobUrl(p);
        const rel = parsed ? parsed.blobPath : p;
        let decoded = rel;
        try { decoded = decodeURIComponent(rel); } catch { /* leave as-is on a bad escape */ }
        if (!rel.startsWith(prefix) && !decoded.startsWith(prefix) && !p.includes(prefix)) continue;
      }
      totalDocs++;
      let entry = byPath.get(p);
      if (!entry) { entry = { chunkIds: [], canary: isCanaryPath(p) }; byPath.set(p, entry); }
      entry.chunkIds.push(d.chunk_id);
    }
  }

  const uniquePaths = [...byPath.keys()];
  let existing = 0, missing = 0, errors = 0, canaryPaths = 0, canaryDocs = 0;
  const missingChunkIds = [];
  const missingPathsSample = [];
  const errorPathsSample = [];
  const unexpectedContainerSample = [];

  await mapWithConcurrency(uniquePaths, concurrency, async (p) => {
    const entry = byPath.get(p);

    // CANARY: never existence-checked, never touched. Counted in its own bucket only.
    if (entry.canary) {
      canaryPaths++;
      canaryDocs += entry.chunkIds.length;
      return;
    }

    const parsed = parseBlobUrl(p);
    if (!parsed) {
      errors++;
      if (errorPathsSample.length < 25) errorPathsSample.push({ path: p, reason: "unparseable path (not a blob.core.windows.net URL)" });
      return;
    }
    if (!expectedContainers.includes(parsed.container)) {
      errors++;
      if (unexpectedContainerSample.length < 25) unexpectedContainerSample.push(p);
      return;
    }
    const cred = containerCreds.get(parsed.container);
    if (!cred) {
      errors++;
      if (errorPathsSample.length < 25) errorPathsSample.push({ path: p, reason: `no resolvable credentials for container "${parsed.container}"` });
      return;
    }
    if (cred.account !== parsed.account) {
      errors++;
      if (errorPathsSample.length < 25) errorPathsSample.push({ path: p, reason: `account mismatch: path says "${parsed.account}", credentials resolved "${cred.account}"` });
      return;
    }

    const sas = buildAccountSas({ account: cred.account, key: cred.key });
    const url = `https://${parsed.account}.blob.core.windows.net/${parsed.container}/${parsed.blobPath}`;
    const state = await headBlobExists(url, sas, { fetchImpl });
    if (state === "exists") {
      existing++;
    } else if (state === "missing") {
      missing++;
      missingChunkIds.push(...entry.chunkIds);
      if (missingPathsSample.length < 50) missingPathsSample.push(p);
    } else {
      errors++;
      if (errorPathsSample.length < 25) errorPathsSample.push({ path: p, reason: "existence check errored (network/auth/throttle) — NOT treated as missing" });
    }
  });

  return {
    index: indexName, blobBacked: true, expectedContainers,
    totalDocs, uniquePaths: uniquePaths.length,
    existing, missing, errors, canaryPaths, canaryDocs,
    missingChunkIds, missingPathsSample, errorPathsSample, unexpectedContainerSample,
  };
}

/** Read-only wrapper — identical to evaluateIndex(), named for the CLI/API surface. */
export async function scanIndex(ctx, indexName, opts = {}) {
  return evaluateIndex(ctx, indexName, opts);
}

/**
 * scan + conditionally delete. DRY-RUN BY DEFAULT: without opts.commit truthy, this makes ZERO
 * calls to the delete endpoint and returns with result.dryRun = true, result.deleted = 0.
 *
 * CIRCUIT BREAKER: if the observed error rate among checked (non-canary) paths exceeds
 * errorAbortRatio (default 25%, with a errorAbortMin floor of 5 errors so a tiny sample doesn't
 * trip it), the run ABORTS and deletes nothing — a high error rate usually means a bad key, an
 * expired SAS, or a throttle storm, not that a quarter of the room's blobs vanished at once.
 */
export async function reapIndex(ctx, indexName, opts = {}) {
  const result = await evaluateIndex(ctx, indexName, opts);
  result.deleted = 0;
  result.deleteFailed = 0;
  result.committed = Boolean(opts.commit);

  if (!result.blobBacked || result.missingChunkIds.length === 0) return result;

  if (!opts.commit) {
    result.dryRun = true;
    return result; // NO network call to the delete endpoint happens below this line.
  }

  const checked = result.existing + result.missing + result.errors;
  const errorAbortRatio = opts.errorAbortRatio ?? 0.25;
  const errorAbortMin = opts.errorAbortMin ?? 5;
  if (checked > 0 && result.errors >= errorAbortMin && result.errors / checked > errorAbortRatio) {
    result.aborted = true;
    result.abortReason = `error rate ${(result.errors / checked * 100).toFixed(1)}% (${result.errors}/${checked}) exceeds the safety threshold (${(errorAbortRatio * 100).toFixed(0)}%) — refusing to delete anything this run`;
    return result;
  }

  const { endpoint, key } = ctx;
  const batches = chunkArray(result.missingChunkIds, 1000);
  result.deleteErrors = [];
  for (const batch of batches) {
    try {
      const { succeeded, failed } = await postDeleteBatch(endpoint, key, indexName, batch, { fetchImpl: opts.fetchImpl });
      result.deleted += succeeded.length;
      result.deleteFailed += failed.length;
      if (failed.length) result.deleteErrors.push(...failed.slice(0, 10));
    } catch (e) {
      result.deleteFailed += batch.length;
      result.deleteErrors.push(String((e && e.message) || e));
    }
  }
  return result;
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { cmd: argv[0] || null, index: null, prefix: null, all: false, commit: false, concurrency: null };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--index") out.index = argv[++i];
    else if (a === "--prefix") out.prefix = argv[++i];
    else if (a === "--all") out.all = true;
    else if (a === "--commit") out.commit = true;
    // --concurrency: the default 16 is fine for small rooms but leaves a large one (legal-personal,
    // ~165k docs / tens of thousands of unique paths) running long enough to trip an outer timeout,
    // which reads as a tool failure when it is only slow. Bounded 1..64 so a typo cannot fire an
    // unbounded HEAD storm at storage.
    else if (a === "--concurrency") {
      const n = Number.parseInt(argv[++i], 10);
      if (!Number.isFinite(n) || n < 1 || n > 64) { console.error("--concurrency must be an integer 1..64"); process.exit(2); }
      out.concurrency = n;
    }
  }
  return out;
}

function printSummary(r) {
  if (!r.blobBacked) {
    console.log(`  ${r.note}`);
    return;
  }
  console.log(`  expected container(s): ${r.expectedContainers.join(", ") || "(none resolved)"}`);
  console.log(`  docs scanned: ${r.totalDocs}   unique source paths: ${r.uniquePaths}`);
  console.log(`  existing: ${r.existing}   missing (orphan sources): ${r.missing}  -> ${r.missingChunkIds.length} orphan chunk doc(s)   errors: ${r.errors}`);
  console.log(`  canary-excluded paths: ${r.canaryPaths} (${r.canaryDocs} chunk docs) — NEVER touched`);
  if (r.missingPathsSample.length) console.log(`  sample orphan paths:\n    ${r.missingPathsSample.slice(0, 10).join("\n    ")}`);
  if (r.errorPathsSample.length) console.log(`  sample errors:\n    ${r.errorPathsSample.slice(0, 10).map((e) => `${e.path} :: ${e.reason}`).join("\n    ")}`);
  if (r.unexpectedContainerSample.length) console.log(`  sample unexpected-container paths:\n    ${r.unexpectedContainerSample.slice(0, 10).join("\n    ")}`);
  if (typeof r.deleted === "number") {
    if (r.aborted) console.log(`  ABORTED: ${r.abortReason}`);
    else if (r.dryRun) console.log(`  DRY RUN (no --commit passed): would delete ${r.missingChunkIds.length} chunk doc(s) across ${r.missing} orphan source path(s). Re-run with --commit to apply.`);
    else console.log(`  DELETED ${r.deleted} chunk doc(s) (${r.deleteFailed} failed)`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.cmd !== "scan" && args.cmd !== "reap") {
    console.error("usage: node reaper.mjs scan --index <name> [--prefix <p>] [--concurrency N] | scan --all");
    console.error("       node reaper.mjs reap --index <name> [--commit] [--prefix <p>] | reap --all [--commit]");
    process.exit(2);
  }
  const ctx = await getSearchContext();
  let indexes;
  if (args.all) indexes = await listBlobBackedIndexes(ctx.endpoint, ctx.key);
  else if (args.index) indexes = [args.index];
  else {
    console.error("pass --index <name> or --all");
    process.exit(2);
  }

  const opts = { prefix: args.prefix || null, commit: args.commit };
  if (args.concurrency) opts.concurrency = args.concurrency;
  for (const idx of indexes) {
    console.log(`\n=== ${args.cmd} ${idx} ===`);
    try {
      const fn = args.cmd === "scan" ? scanIndex : reapIndex;
      const r = await fn(ctx, idx, opts);
      printSummary(r);
    } catch (e) {
      console.error(`  ERROR: ${(e && e.message) || e}`);
    }
  }
}

// Only run as a script (not when imported by a test) — standing fleet convention, see
// skills/fleet-backup/s3-mirror.mjs / skills/azure-canary/canary.mjs.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error("ERR", (e && e.stack) || e);
    process.exit(1);
  });
}
