#!/usr/bin/env node
/**
 * fleet-backup — daily offline copy of the fleet's two most central, least-redundant stores:
 *   (a) the Cosmos work-ledger (tasks + their event-log history via the gateway, PLUS a direct dump
 *       of the `memory`, `events`, and `decisions_pending` containers — see the GAP-8 note below),
 *       and
 *   (b) a full document dump of every LIVE Azure AI Search index (see the LIVE-brain repoint note
 *       further down in this file).
 *
 * WHY THIS EXISTS (CROSS-BOARD-HARDENING.md item #7): both stores currently have ZERO offline copy.
 * If the Cosmos account or the search service were ever deleted, corrupted, or suffered a bad write,
 * there is no independent restore path. This job gives that independent, version-controlled
 * (blob-versioned) copy, decoupled from the live Azure resources it backs up.
 *
 * GAP-8 (2026-08, DR gap-analysis item #8): the agent-state Cosmos account has FOUR containers —
 * `tasks`, `events`, `memory`, `decisions_pending` — but this job originally only exported `tasks`.
 * `memory` is the deterministic memory-of-record (distinct from the `memory-exec` AI Search index,
 * which is a lossy DERIVED projection of it, and IS covered by the AI-Search-index export in (b));
 * `events` is the append-only task event log; `decisions_pending` is the decision-clock's open-gate
 * tracker. None of the three had ANY backup coverage — working or broken — until this job's
 * `exportCosmosContainer()` (which delegates to skills/fleet-backup/cosmos-export.mjs) closed that
 * gap. Unlike the gateway-mediated `tasks` export below, these three go DIRECT to Cosmos (see
 * cosmos-export.mjs's own header for the full rationale: the gateway's `memory_search` tool caps
 * results at 100 with no pagination token at all, and `events`/`decisions_pending` have no gateway
 * read tool whatsoever, so a gateway-mediated export of any of the three would either silently
 * truncate or be impossible to build).
 *
 * DESIGN NOTE / correction to the original runbook wording: the runbook text says "export ... to
 * otchealth-cto/ledger-backup/<date>.jsonl", which reads like a literal path inside the otchealth-cto
 * GIT REPO. That is NOT what this job does, deliberately: committing a daily growing ledger dump
 * (and a many-thousand-document search-index dump) into git would bloat repo history unboundedly and
 * git is not a backup store (no lifecycle policy, no versioning-with-retention, clones get slower
 * forever). Every other durable-artifact pattern in this fleet (kb-memory ledgers, cfo-source-docs,
 * the legal store) uses Azure Blob Storage, not git, for exactly this reason. This job therefore
 * writes to Blob:
 *   container: ledger-backup  (name mirrors the runbook path's directory component)
 *   blobs:     ledger-backup/tasks-<date>.jsonl               Cosmos tasks (via the gateway)
 *              ledger-backup/memory-<date>.jsonl               Cosmos memory (direct, GAP-8)
 *              ledger-backup/events-<date>.jsonl                Cosmos events (direct, GAP-8)
 *              ledger-backup/decisions-pending-<date>.jsonl     Cosmos decisions_pending (direct, GAP-8)
 *              ledger-backup/index-<indexName>-<date>.jsonl    one per LIVE AI Search index
 *              ledger-backup/manifest-<date>.json   (counts + hashes, for verifying completeness)
 * on the existing fleet storage account (see IAC_NOTES.md for exactly which account/RG to use —
 * this script takes the account name via env so it is not hardcoded to one choice).
 *
 * AUTH (current fleet pattern as of 2026-07, post GCP-Secret-Manager retirement):
 *   - Azure Key Vault via Container Apps MANAGED IDENTITY (kv-otc-55c84f6bef, secret names below),
 *     same resolution helper style as skills/kb-memory/azure-secret.mjs. No client secret baked into
 *     the job spec; the job's managed identity must be granted:
 *       - "Key Vault Secrets User" on kv-otc-55c84f6bef (scoped to the specific secrets it reads, or
 *         the vault if per-secret RBAC isn't in use) — GAP-8 ADDS two secrets to this list, see
 *         REQUIRED SECRETS below (cosmos-agent-state-endpoint / cosmos-agent-state-key). If the grant
 *         is per-secret RBAC rather than vault-wide, granting read on those two is a real, separate
 *         deploy step, not automatic just because this code exists.
 *       - "Storage Blob Data Contributor" scoped to ONLY the `ledger-backup` container (not the whole
 *         storage account) on the backup storage account
 *   - `tasks` continues to be reached exclusively through the existing read-only gateway HTTP API
 *     (mcp.otchealth.app: task_list/task_get), the same least-privilege posture as before GAP-8 — that
 *     part of this job still hands Cosmos no direct credential at all. `memory` / `events` /
 *     `decisions_pending` are the ONE deliberate exception (see the GAP-8 note above and
 *     cosmos-export.mjs's header for why): those three go direct to Cosmos via a read-only master-key
 *     REST client, because there is no complete, non-truncating gateway path for them today. The AI
 *     Search index dump also goes direct (see the LIVE-brain repoint note further down), using a
 *     read-only per-service QUERY key minted via this job's own managed identity (ARM
 *     listQueryKeys) — Search Service Contributor, not Owner/Contributor on the index itself.
 *
 *   GATEWAY PROTOCOL (fixed 2026-07-10): the gateway is an MCP server, not a plain REST API — it
 *   exposes exactly GET /health, POST /mcp, GET /oauth/authorize, POST /oauth/token,
 *   GET /.well-known/oauth-authorization-server, POST /admin/revoke. There is NO /tools/<name>
 *   route. Every tool call goes through POST /mcp as an MCP JSON-RPC 2.0 "tools/call" request; the
 *   real payload comes back nested at result.structuredContent.result (registry.ts's wrapper shape),
 *   with an optional JIT-offload indirection (`{_jit_offloaded:true, result_id}`) for large payloads
 *   that must be paged back via the `gateway_fetch_result` tool. See gatewayCall()/fetchOffloaded()
 *   below — the original version of this file called a nonexistent `/tools/<name>` REST endpoint
 *   and 404'd on every real run; this was only discovered on first live deploy.
 *
 * REQUIRED SECRETS (Key Vault, names mirror existing SM->KV 1:1 convention):
 *   gateway-bearer-token         bearer/API token the job presents to mcp.otchealth.app (read-only scope)
 *   cosmos-agent-state-endpoint  Cosmos account URI (GAP-8; read directly by cosmos-export.mjs)
 *   cosmos-agent-state-key       Cosmos read-capable master key (GAP-8; same two secrets every other
 *                                job Cosmos client in this repo already reads — see
 *                                skills/kb-memory/cosmos-memory-read.mjs / skills/decision-clock)
 *
 * REQUIRED ENV (set in the Container Apps Job spec, non-secret):
 *   BACKUP_STORAGE_ACCOUNT     e.g. stotc55c84f6bef (see IAC_NOTES.md — confirm exact account name
 *                              before deploy; this script does not hardcode one)
 *   BACKUP_CONTAINER           default "ledger-backup"
 *   GATEWAY_BASE_URL           default https://mcp.otchealth.app
 *   AZURE_KEYVAULT_NAME        default kv-otc-55c84f6bef
 *
 * USAGE:
 *   node backup.mjs run                 # full run: Cosmos export (tasks+memory+events+decisions_pending)
 *                                        # + AI Search index export + manifest
 *   node backup.mjs run --ledger-only   # Cosmos export only (skips the AI Search index export)
 *   node backup.mjs run --brain-only    # AI Search index export only (skips the Cosmos export)
 *   node backup.mjs selftest            # no writes: verify identity token + KV secret + blob container reachable
 */

import { readFileSync } from "node:fs";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { dumpContainer, dumpContainerSegregated } from "./cosmos-export.mjs";

// ---------- Key Vault (managed identity, mirrors skills/kb-memory/azure-secret.mjs) ----------
let _tok = null, _exp = 0;
async function identityToken(resource) {
  const endpoint = process.env.IDENTITY_ENDPOINT;
  const header = process.env.IDENTITY_HEADER;
  if (!endpoint || !header) return null;
  try {
    const clientIdQS = process.env.AZURE_UAMI_CLIENT_ID ? `&client_id=${encodeURIComponent(process.env.AZURE_UAMI_CLIENT_ID)}` : "";
    const r = await fetch(`${endpoint}?resource=${encodeURIComponent(resource)}&api-version=2019-08-01${clientIdQS}`, {
      headers: { "x-identity-header": header },
    });
    if (!r.ok) return null;
    const j = await r.json();
    return j.access_token || null;
  } catch { return null; }
}
async function vaultToken() {
  const now = Date.now();
  if (_tok && _exp - now > 60_000) return _tok;
  const tok = await identityToken("https://vault.azure.net");
  if (!tok) return null;
  _tok = tok; _exp = now + 3600_000;
  return _tok;
}
async function kvSecret(name) {
  const vault = process.env.AZURE_KEYVAULT_NAME || "kv-otc-55c84f6bef";
  const tok = await vaultToken();
  if (!tok) return null;
  try {
    const r = await fetch(`https://${vault}.vault.azure.net/secrets/${name}?api-version=7.4`, { headers: { Authorization: `Bearer ${tok}` } });
    if (!r.ok) return null;
    const v = (await r.json()).value;
    return v == null ? null : String(v).trim() || null;
  } catch { return null; }
}
async function requireSecret(name) {
  const v = await kvSecret(name);
  if (v == null) {
    console.error(`[FATAL] required secret '${name}' unavailable from Key Vault (${process.env.AZURE_KEYVAULT_NAME || "kv-otc-55c84f6bef"}). Refusing to run.`);
    process.exit(78);
  }
  return v;
}

// ---------- Blob Storage (managed identity, direct REST, no SDK dependency) ----------
async function blobToken() { return identityToken("https://storage.azure.com"); }

async function putBlockBlob(account, container, blobName, buffer, contentType) {
  const tok = await blobToken();
  if (!tok) throw new Error("could not mint a storage.azure.com managed-identity token");
  const url = `https://${account}.blob.core.windows.net/${container}/${blobName}`;
  const r = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${tok}`,
      "x-ms-version": "2023-11-03",
      "x-ms-blob-type": "BlockBlob",
      "Content-Type": contentType || "application/octet-stream",
      "Content-Length": String(buffer.length),
    },
    body: buffer,
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`PUT blob ${blobName} failed: ${r.status} ${body.slice(0, 300)}`);
  }
  return { etag: r.headers.get("etag") };
}

async function containerExists(account, container) {
  const tok = await blobToken();
  if (!tok) return false;
  const url = `https://${account}.blob.core.windows.net/${container}?restype=container`;
  const r = await fetch(url, { method: "HEAD", headers: { Authorization: `Bearer ${tok}`, "x-ms-version": "2023-11-03" } });
  return r.status === 200;
}

// ---------- Gateway (read-only, bearer token, MCP JSON-RPC) — the ONLY path to Cosmos work-ledger + AI Search ----------
function gatewayBase() { return process.env.GATEWAY_BASE_URL || "https://mcp.otchealth.app"; }

/** Low-level: one MCP tools/call round-trip. Parses either a plain JSON body or an SSE stream. */
async function mcpCall(bearer, toolName, args) {
  const r = await fetch(`${gatewayBase()}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${bearer}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name: toolName, arguments: args || {} } }),
  });
  const bodyText = await r.text();
  if (!r.ok) throw new Error(`gateway call ${toolName} failed: ${r.status} ${bodyText.slice(0, 300)}`);
  let msg = null;
  try { msg = JSON.parse(bodyText); }
  catch {
    for (const line of bodyText.split("\n")) {
      if (line.startsWith("data:")) { try { msg = JSON.parse(line.slice(5)); } catch { /* keep scanning */ } }
    }
  }
  if (!msg) throw new Error(`gateway call ${toolName}: could not parse response body (${bodyText.slice(0, 200)})`);
  if (msg.error) throw new Error(`gateway call ${toolName} error: ${JSON.stringify(msg.error).slice(0, 300)}`);
  const result = msg.result || {};
  if (result.isError) {
    const errText = ((result.content || [])[0] || {}).text || JSON.stringify(result).slice(0, 300);
    throw new Error(`gateway call ${toolName} returned a tool-level error: ${errText.slice(0, 400)}`);
  }
  return result;
}

/**
 * Pull the full payload for a JIT-offloaded result (see src/tools/result-store.ts and
 * src/tools/gateway-fetch-result.ts on the gateway).
 *
 * 2026-08-04 (FND-20260728-b8a0, "backup.mjs Cosmos work-ledger export produces 0 rows nightly"):
 * this function's contract was wrong on two counts, confirmed live against the real gateway
 * (`gateway_fetch_result` on a real jitres_ id, 8-page payload). The tool is 0-indexed
 * (`page` default 0) and its output shape is `{found, total_bytes, page, pages, chunk, expired}`
 * -- there is no `has_more`/`hasMore`/`next_page` field anywhere in it. The old code started at
 * `page = 1` (silently skipping page 0, ~1/8 of every offloaded payload) and used
 * `chunk.has_more ?? chunk.hasMore ?? false`, which is unconditionally `false` since neither key
 * exists -- so the loop always stopped after exactly one (wrong) page. The resulting `combined`
 * string was a truncated JSON fragment starting mid-document; JSON.parse failed and the old
 * `catch { return combined; }` silently handed the caller a raw broken string instead of an
 * object, which `page.tasks || page.items || []` in exportLedger() then read as "0 tasks" --
 * a job that reports "Succeeded" while quietly exporting nothing, exactly the July-27 incident.
 * Any large task_list/task_get or brain_search response that gets JIT-offloaded hits this same
 * path, so this was not specific to the ledger export. Fixed to walk real `page`/`pages`, and to
 * THROW (not silently degrade) on an unparseable/missing/expired page, so a future offload-layer
 * bug fails the job loudly instead of writing an empty, "successful" backup.
 */
export async function fetchOffloaded(bearer, resultId) {
  const parts = [];
  let page = 0;
  let totalPages = null;
  for (;;) {
    const chunk = await gatewayCall(bearer, "gateway_fetch_result", { result_id: resultId, page });
    if (chunk == null || typeof chunk !== "object") {
      throw new Error(`gateway_fetch_result(${resultId}, page=${page}): unexpected response shape (got ${typeof chunk})`);
    }
    if (chunk.expired) throw new Error(`gateway_fetch_result(${resultId}, page=${page}): result has expired`);
    if (chunk.found === false) throw new Error(`gateway_fetch_result(${resultId}, page=${page}): not found (invalid id or expired)`);
    parts.push(String(chunk.chunk ?? ""));
    totalPages = chunk.pages ?? totalPages ?? 1;
    page += 1;
    if (page >= totalPages) break;
  }
  const combined = parts.join("");
  try {
    return JSON.parse(combined);
  } catch (e) {
    throw new Error(`gateway_fetch_result(${resultId}): failed to parse combined ${combined.length}-char payload across ${page} page(s): ${e.message}`);
  }
}

/** High-level: call a gateway tool and return its actual data (unwraps structuredContent + JIT offload). */
async function gatewayCall(bearer, toolName, params) {
  const result = await mcpCall(bearer, toolName, params);
  const sc = result.structuredContent || {};
  let payload = sc.result;
  if (payload && typeof payload === "object" && payload._jit_offloaded && payload.result_id) {
    payload = await fetchOffloaded(bearer, payload.result_id);
  }
  if (payload !== undefined && payload !== null) return payload;
  // Fallback: no structuredContent (e.g. connector-curated toolset) — parse the text content block.
  const textBlock = (result.content || [])[0];
  if (textBlock && textBlock.text) {
    try { return JSON.parse(textBlock.text); } catch { return { raw: textBlock.text }; }
  }
  return {};
}

// ---------- (a) Cosmos work-ledger export ----------
// Paginates task_list (all owners, all statuses) then task_get per task to include the full
// append-only event-log history, exactly what CROSS-BOARD-HARDENING.md #7 calls "the ledger".
async function exportLedger(bearer) {
  const rows = [];
  let cursor = null;
  do {
    const page = await gatewayCall(bearer, "task_list", cursor ? { cursor } : {});
    const tasks = page.tasks || page.items || [];
    for (const t of tasks) {
      let full = t;
      try {
        const detail = await gatewayCall(bearer, "task_get", { id: t.id });
        full = detail.task || detail;
      } catch (e) {
        full = { ...t, _backup_note: `task_get failed: ${e.message}` };
      }
      rows.push(full);
    }
    cursor = page.next_cursor || page.cursor || null;
  } while (cursor);
  return rows;
}

// ---------- (a2) direct Cosmos container export (GAP-8: memory / events / decisions_pending) ----------
// Unlike exportLedger() above (gateway task_list/task_get), this goes straight to Cosmos via
// cosmos-export.mjs's read-only master-key REST client with real x-ms-continuation pagination drained
// to exhaustion — no row cap, no gateway search-shaped API involved. See this file's own header
// ("GAP-8") and cosmos-export.mjs's header for the full rationale (the gateway's memory_search tool
// caps at 100 with no continuation token at all; events/decisions_pending have no gateway read tool
// whatsoever). Throws on failure (never returns a silently-truncated array) so run() below reports it
// the same way it already reports a failed AI Search index dump — a partial GAP-8 container export
// must never be recorded in the manifest as if it were complete.
export async function exportCosmosContainer(container) {
  return dumpContainer(container);
}

/**
 * Ring-SEGREGATED container export. Returns { general, restricted } so the caller writes TWO blobs
 * and a personal-lane row can never ride along in a company-lane file.
 *
 * WHY THIS REPLACED THE UNSEGREGATED CALL (P0, 2026-08-16). The nightly job used
 * exportCosmosContainer() above, which returns ONE undifferentiated array. The `memory` container
 * holds both company and `clo-personal` rows, and s3-mirror.mjs classifies blobs by FILENAME, so a
 * file called `memory-<date>.jsonl` matched no privileged substring and the whole thing -- personal
 * rows included -- was mirrored into the NON-privileged DR bucket every night.
 *
 * Measured directly in the live bucket before the fix: 42 clo-personal rows on 08-05, 75 on 08-10,
 * 80 on 08-15. Growing nightly. Attorney-privileged material in a bucket whose whole purpose is to
 * be the non-privileged one.
 *
 * The segregating library was already merged and already correct (cosmos-export.mjs's
 * dumpContainerSegregated + classifyLane, PR #433); that change's own commit message said wiring
 * the nightly caller to it was "a separate follow-up, out of this change's scope". The follow-up
 * was never done, so a correct library sat next to a caller that never used it -- which is exactly
 * as leaky as not having written it.
 */
export async function exportCosmosContainerSegregated(container, opts = {}) {
  return dumpContainerSegregated(container, opts);
}

/** Pure: append `additions` onto `existing` (never overwrite/clobber a prior value) -- the exact
 *  fix for a real bug class this file already hit once (see run()'s "Merge (never overwrite)"
 *  comments at both call sites): the AI-Search-index block and the GAP-8 Cosmos-container block
 *  both write to manifest.backup_incomplete, and a plain `manifest.backup_incomplete = failures`
 *  assignment in either block would silently discard whatever the OTHER block had already recorded,
 *  turning a real, reported failure into an unreported one. Exported + regression-tested directly so
 *  this invariant cannot regress without a test catching it, independent of exercising the rest of
 *  run()'s network-heavy machinery. */
export function mergeBackupIncomplete(existing, additions) {
  if (!additions || !additions.length) return existing;
  return [...(existing || []), ...additions];
}

// ---------- (b) AI Search index full dump ----------
// Azure AI Search has no native "export index" API; the standard workaround (documented by
// Microsoft: https://learn.microsoft.com/azure/search/search-howto-move-across-regions) is to
// page through the index with $skip/search=* and dump every document's stored fields. We go
// through the gateway's read-only brain_search tool rather than holding a Search admin key in this
// job, at the cost of only getting back whatever fields brain_search projects (not literally every
// internal field) — that's an intentional least-privilege tradeoff documented here and in the PR.
// pageSize is hard-capped at 25 by brain_search's own input schema (confirmed live: passing
// top=50 returns an MCP tool-level error "Number must be less than or equal to 25" -- the ORIGINAL
// version of this file used pageSize=200, then 50, both silently swallowed as "0 docs" because
// mcpCall() below didn't check the tool-level `isError` flag on the response and instead tried to
// JSON.parse the MCP error string as data, got {raw: "<error text>"}, and exportBrainIndex read an
// absent `.matches` off that as an empty page. Both bugs are fixed here: the real page-size ceiling,
// and mcpCall() now throws on `result.isError` instead of silently returning garbage.
async function exportBrainIndex(bearer, { pageSize = 25 } = {}) {
  const rows = [];
  let skip = 0;
  for (;;) {
    const page = await gatewayCall(bearer, "brain_search", { query: "*", top: pageSize, skip });
    const docs = page.matches || page.results || page.documents || page.value || [];
    if (!docs.length) break;
    rows.push(...docs);
    skip += docs.length;
    if (docs.length < pageSize) break; // last page
  }
  return rows;
}

// DIRECT AI Search index dump (the reliable path, preferred by run()). brain_search is a ranked
// top-N search (top<=25, NO skip param) and CANNOT enumerate a full index -- the gateway-paginated
// exportBrainIndex above either captured 0 docs (query "*" returned nothing that run) or INFINITE-
// LOOPED on a full page that never satisfies `docs.length < pageSize`, running until the 30-min
// replica timeout killed it (the real cause of the nightly Failed runs; the two 2026-07-10
// "successes" captured 0 brain docs = no valid DR copy). This dumps the index directly via the
// Search REST API with real $top/$skip paging, using a READ-ONLY query key (brain-search-query-key
// in Key Vault; Azure query keys cannot modify the index/service). $skip tops out at 100,000 per
// Azure AI Search; the current corpus is ~67,645 so skip-paging is complete (guarded + warned above).
// STREAMS straight to a Block Blob (one Put Block per page) so the full ~67k-doc corpus is NEVER
// held in memory at once. The earlier buffered version (rows.push all docs -> toNdjson one big
// string) OOM'd the container's ~512MB Node heap at ~500MB. Peak memory here = one page (~10-30MB).
// Computes sha256 + row/byte counts incrementally; commits with Put Block List. Returns the manifest
// stats so run() does not re-buffer. $skip tops out at 100,000 per Azure AI Search (guarded).
async function exportBrainIndexToBlob(apiKey, endpoint, account, container, blobName, { index = process.env.BRAIN_INDEX || "otchealth-brain", pageSize = 1000, apiVersion = "2023-11-01" } = {}) {
  const tok = await blobToken();
  if (!tok) throw new Error("could not mint a storage.azure.com managed-identity token for the brain dump");
  const url = `https://${account}.blob.core.windows.net/${container}/${blobName}`;
  const hash = crypto.createHash("sha256");
  const blockIds = [];
  let skip = 0, rows = 0, bytes = 0, page = 0, odataCount = null;
  for (;;) {
    const r = await fetch(`${endpoint}/indexes/${index}/docs/search?api-version=${apiVersion}`, {
      method: "POST",
      headers: { "api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ search: "*", top: pageSize, skip, count: skip === 0 }),
    });
    if (!r.ok) throw new Error(`AI Search dump ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j = await r.json();
    if (skip === 0) odataCount = j["@odata.count"];
    const docs = j.value || [];
    if (!docs.length) break;
    let chunk = "";
    for (const d of docs) {
      delete d["@search.score"]; delete d["@search.rerankerScore"]; delete d["@search.highlights"]; delete d["@search.captions"];
      chunk += JSON.stringify(d) + "\n";
    }
    const buf = Buffer.from(chunk, "utf8");
    const blockId = Buffer.from(`blk-${String(page).padStart(8, "0")}`).toString("base64");
    const pr = await fetch(`${url}?comp=block&blockid=${encodeURIComponent(blockId)}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${tok}`, "x-ms-version": "2023-11-03", "Content-Length": String(buf.length) },
      body: buf,
    });
    if (!pr.ok) throw new Error(`Put Block ${pr.status}: ${(await pr.text()).slice(0, 200)}`);
    blockIds.push(blockId);
    hash.update(buf); rows += docs.length; bytes += buf.length; skip += docs.length; page++;
    if (docs.length < pageSize) break; // last page
    if (skip >= 100000) { console.warn(`[fleet-backup] WARNING: hit the AI Search $skip=100000 ceiling at ${rows} docs; index has more. Switch to range/key paging for a complete dump.`); break; }
  }
  if (!blockIds.length) { // empty index: write a 0-byte blob so the manifest points at something real
    await putBlockBlob(account, container, blobName, Buffer.alloc(0), "application/x-ndjson");
    return { rows: 0, bytes: 0, sha256: hash.digest("hex") };
  }
  const xml = `<?xml version="1.0" encoding="utf-8"?><BlockList>${blockIds.map((id) => `<Latest>${id}</Latest>`).join("")}</BlockList>`;
  const cr = await fetch(`${url}?comp=blocklist`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${tok}`, "x-ms-version": "2023-11-03", "Content-Type": "text/plain", "x-ms-blob-content-type": "application/x-ndjson" },
    body: xml,
  });
  if (!cr.ok) throw new Error(`Put Block List ${cr.status}: ${(await cr.text()).slice(0, 200)}`);
  if (odataCount != null && rows < odataCount) console.warn(`[fleet-backup] WARNING: dumped ${rows} of @odata.count=${odataCount} brain docs.`);
  return { rows, bytes, sha256: hash.digest("hex") };
}

function toNdjson(rows) { return rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""); }
function sha256(buf) { return crypto.createHash("sha256").update(buf).digest("hex"); }
function todayStamp() { return new Date().toISOString().slice(0, 10); } // YYYY-MM-DD

async function run({ ledgerOnly, brainOnly }) {
  const account = process.env.BACKUP_STORAGE_ACCOUNT;
  if (!account) { console.error("[FATAL] BACKUP_STORAGE_ACCOUNT is not set. Refusing to run."); process.exit(78); }
  const container = process.env.BACKUP_CONTAINER || "ledger-backup";
  const bearer = await requireSecret("gateway-bearer-token");
  const date = todayStamp();

  const ok = await containerExists(account, container);
  if (!ok) { console.error(`[FATAL] container '${container}' not reachable/does not exist on ${account}. Create it (least-privilege scope) before deploying this job.`); process.exit(78); }

  const manifest = { date, account, container, ledger: null, brain: null, memory: null, events: null, decisions_pending: null };

  if (!brainOnly) {
    console.log("[fleet-backup] exporting Cosmos work-ledger via gateway task_list/task_get ...");
    const ledgerRows = await exportLedger(bearer);
    const ledgerBuf = Buffer.from(toNdjson(ledgerRows), "utf8");
    const blobName = `tasks-${date}.jsonl`;
    await putBlockBlob(account, container, blobName, ledgerBuf, "application/x-ndjson");
    manifest.ledger = { blob: blobName, rows: ledgerRows.length, bytes: ledgerBuf.length, sha256: sha256(ledgerBuf) };
    console.log(`[fleet-backup] ledger export OK: ${ledgerRows.length} tasks, ${ledgerBuf.length} bytes -> ${container}/${blobName}`);

    // GAP-8: direct Cosmos export of the three containers with no complete gateway read path (see
    // this file's header "GAP-8" note and cosmos-export.mjs's own header for the full rationale).
    // `zeroRowsIsFailure: false` on decisions_pending means a genuinely empty decision-clock queue
    // ("nothing pending right now") is NOT treated as a failure -- unlike `memory`/`events`, which are
    // append-only and effectively never legitimately empty on this live account, an empty
    // decisions_pending is a real, healthy, and common state; hard-failing the DR job on it would
    // just train operators to ignore the alert. A row-count of 0 is still logged for all three either
    // way, so the signal is never silently dropped -- only whether it escalates to a job failure differs.
    const GAP8_CONTAINERS = [
      { container: "memory", blobPrefix: "memory", zeroRowsIsFailure: true },
      { container: "events", blobPrefix: "events", zeroRowsIsFailure: true },
      { container: "decisions_pending", blobPrefix: "decisions-pending", zeroRowsIsFailure: false },
    ];
    const cosmosFailures = [];
    for (const { container: coll, blobPrefix, zeroRowsIsFailure } of GAP8_CONTAINERS) {
      // TWO blobs, always, with the lane in the NAME. s3-mirror.mjs classifies by filename, so the
      // name is the ring boundary as far as the mirror is concerned -- "-restricted" is what keeps a
      // personal row out of the non-privileged bucket. Emitting both files unconditionally (even
      // when one side is empty) is deliberate: a missing -restricted file is ambiguous between
      // "no personal rows today" and "segregation silently stopped running", and this whole class of
      // bug is exactly that ambiguity.
      const generalBlobName = `${blobPrefix}-general-${date}.jsonl`;
      const restrictedBlobName = `${blobPrefix}-restricted-${date}.jsonl`;
      try {
        console.log(`[fleet-backup] exporting Cosmos ${coll} ring-segregated (GAP-8) -> ${container}/{${generalBlobName},${restrictedBlobName}} ...`);
        const { general, restricted } = await exportCosmosContainerSegregated(coll);
        const rows = general; // row-count semantics below stay about the company-lane export

        const genBuf = Buffer.from(toNdjson(general), "utf8");
        await putBlockBlob(account, container, generalBlobName, genBuf, "application/x-ndjson");
        const resBuf = Buffer.from(toNdjson(restricted), "utf8");
        await putBlockBlob(account, container, restrictedBlobName, resBuf, "application/x-ndjson");

        manifest[coll] = {
          blob: generalBlobName, rows: general.length, bytes: genBuf.length, sha256: sha256(genBuf),
          restricted_blob: restrictedBlobName, restricted_rows: restricted.length,
          restricted_bytes: resBuf.length, restricted_sha256: sha256(resBuf),
        };
        console.log(`[fleet-backup] ${coll} export OK: ${general.length} general + ${restricted.length} restricted rows`);
        if (rows.length === 0) {
          console.warn(`::warning::[fleet-backup] Cosmos ${coll} dumped ZERO documents${zeroRowsIsFailure ? "" : " (not treated as a failure for this container -- an empty queue is a legitimate state)"}.`);
          if (zeroRowsIsFailure) cosmosFailures.push(`${coll}: 0 rows`);
        }
      } catch (e) {
        const collBlobName = generalBlobName;
        console.error(`::error::[fleet-backup] Cosmos ${coll} export FAILED: ${e.message}`);
        manifest[coll] = { blob: collBlobName, error: e.message };
        cosmosFailures.push(`${coll}: ${e.message}`);
      }
    }
    // Merge (never overwrite) -- the AI Search index block below also writes manifest.backup_incomplete
    // when it runs, and both blocks must contribute to the SAME final failure list, not clobber each other.
    manifest.backup_incomplete = mergeBackupIncomplete(manifest.backup_incomplete, cosmosFailures);
  }

  if (!ledgerOnly) {
    // >>> 2026-07-13 CRITICAL REPOINT. This job used to dump ONLY `otchealth-brain` and call that "the
    // >>> fleet brain DR copy". otchealth-brain is a DEAD, WRITER-LESS one-time snapshot, frozen at
    // >>> 67,645 docs since ~2026-07-01 (see setup/expected-indexes.json). So the fleet's celebrated
    // >>> "first-ever valid brain backup" was a backup OF A CORPSE -- while the indexes that actually
    // >>> hold the living brain (memory-exec + every data room) had ZERO offline copy. Backing up the
    // >>> one index nothing writes, and none of the six that everything writes, is worse than no backup:
    // >>> it produces the FEELING of DR coverage. We now back up every LIVE index in the writer registry,
    // >>> which is the same list the freshness canary watches -- one registry, no second list to forget.
    const registry = JSON.parse(readFileSync(new URL("../../setup/expected-indexes.json", import.meta.url), "utf8"));
    const liveIndexes = registry.indexes || [];
    // Search creds are NOT in Key Vault (no AIS secret exists there). Obtain a read-only QUERY key per
    // service via ARM listQueryKeys using THIS job's managed identity (granted Search Service Contributor
    // on otchealth-dataroom-search 2026-07-13), mirroring the gateway's azure_search_index_stats path.
    // The endpoint is derived from the service name; the query key is held in memory, never logged.
    const SUBSCRIPTION = process.env.AZURE_SUBSCRIPTION_ID || "55c84f6b-ef90-4259-a58b-50835cc4cab4";
    const SEARCH_RG = process.env.AZURE_SEARCH_RG || "otchealth-automation-rg";
    async function miArmToken() {
      const ep = process.env.IDENTITY_ENDPOINT, hdr = process.env.IDENTITY_HEADER;
      if (!ep || !hdr) throw new Error("managed identity unavailable (IDENTITY_ENDPOINT unset) -- cannot obtain a search key. This job MUST run under a managed identity with Search Service Contributor.");
      const r = await fetch(`${ep}?resource=${encodeURIComponent("https://management.azure.com")}&api-version=2019-08-01`, { headers: { "X-IDENTITY-HEADER": hdr } });
      if (!r.ok) throw new Error(`MI ARM token request failed (${r.status})`);
      return (await r.json()).access_token;
    }
    const _keyCache = {};
    async function searchKeyFor(service) {
      if (_keyCache[service]) return _keyCache[service];
      const tok = await miArmToken();
      const r = await fetch(`https://management.azure.com/subscriptions/${SUBSCRIPTION}/resourceGroups/${SEARCH_RG}/providers/Microsoft.Search/searchServices/${service}/listQueryKeys?api-version=2023-11-01`, { method: "POST", headers: { Authorization: `Bearer ${tok}` } });
      if (!r.ok) throw new Error(`listQueryKeys(${service}) -> ${r.status}: ${(await r.text()).slice(0, 150)}`);
      const key = (await r.json()).value?.find((k) => k.key)?.key;
      if (!key) throw new Error(`no query key returned for search service ${service}`);
      return (_keyCache[service] = key);
    }
    manifest.indexes = [];
    const failures = [];
    for (const ix of liveIndexes) {
      const blobName = `index-${ix.index}-${date}.jsonl`;
      try {
        const searchKey = await searchKeyFor(ix.service);
        console.log(`[fleet-backup] streaming ${ix.index} (${ix.service}) -> ${container}/${blobName} ...`);
        const st = await exportBrainIndexToBlob(searchKey, `https://${ix.service}.search.windows.net`, account, container, blobName, { index: ix.index });
        manifest.indexes.push({ index: ix.index, service: ix.service, blob: blobName, rows: st.rows, bytes: st.bytes, sha256: st.sha256 });
        console.log(`[fleet-backup] ${ix.index}: ${st.rows} docs, ${st.bytes} bytes`);
        // LIVENESS ASSERTION, not a volume floor: an index that dumps ZERO rows is a dead index, and a
        // backup job that cheerfully writes an empty file is the exact "green job that did nothing"
        // pattern this whole change exists to kill -- so ZERO rows counts as a FAILURE.
        if (st.rows === 0) { console.warn(`::warning::[fleet-backup] ${ix.index} dumped ZERO documents.`); failures.push(`${ix.index}: 0 rows`); }
      } catch (e) {
        console.error(`::error::[fleet-backup] ${ix.index} FAILED: ${e.message}`);
        failures.push(`${ix.index}: ${e.message}`);
      }
    }
    const totalDocs = manifest.indexes.reduce((a, b) => a + b.rows, 0);
    manifest.brain = { mode: "federated-live-rooms", indexes: manifest.indexes.length, expected: liveIndexes.length, total_docs: totalDocs, failures };
    console.log(`[fleet-backup] LIVE brain export: ${manifest.indexes.length}/${liveIndexes.length} index(es) OK, ${totalDocs} docs total.`);
    // Persist the manifest (below) BEFORE failing, so partial progress is recorded -- but FAIL LOUD if
    // any live index could not be captured. A silent partial backup is exactly how we got here.
    // Merge (never overwrite) -- the GAP-8 Cosmos-container block above may have already populated
    // manifest.backup_incomplete this same run; both sources must contribute to one final list.
    manifest.backup_incomplete = mergeBackupIncomplete(manifest.backup_incomplete, failures);
  }

  const manifestBuf = Buffer.from(JSON.stringify(manifest, null, 2), "utf8");
  await putBlockBlob(account, container, `manifest-${date}.json`, manifestBuf, "application/json");
  console.log(`[fleet-backup] manifest written: ${container}/manifest-${date}.json`);
  console.log(JSON.stringify(manifest, null, 2));
  // Manifest is persisted (partial progress recorded). Now FAIL LOUD if any live index OR GAP-8 Cosmos
  // container was missed, so a partial backup (search or Cosmos) can never masquerade as a green run.
  if (Array.isArray(manifest.backup_incomplete) && manifest.backup_incomplete.length) {
    throw new Error(`[fleet-backup] INCOMPLETE: ${manifest.backup_incomplete.length} item(s) not captured -> ${manifest.backup_incomplete.join("; ")}`);
  }
}

async function selftest() {
  const report = { identityPresent: Boolean(process.env.IDENTITY_ENDPOINT && process.env.IDENTITY_HEADER) };
  report.kvSecretReachable = false;
  report.blobContainerReachable = false;
  try {
    const v = await kvSecret("gateway-bearer-token");
    report.kvSecretReachable = v != null;
  } catch (e) { report.kvError = e.message; }
  const account = process.env.BACKUP_STORAGE_ACCOUNT;
  if (account) {
    try { report.blobContainerReachable = await containerExists(account, process.env.BACKUP_CONTAINER || "ledger-backup"); }
    catch (e) { report.blobError = e.message; }
  }
  console.log(JSON.stringify(report, null, 2));
}

// CLI entrypoint guard: only dispatch when this file is run directly (`node backup.mjs ...`), never
// when imported (e.g. by tests importing fetchOffloaded / exportCosmosContainer /
// mergeBackupIncomplete for regression coverage) -- without this guard, importing this module for its
// exports would unconditionally kick off a real production run() (the default cmd) as a side effect
// of the import itself. Mirrors the fleet's established convention (see skills/fleet-backup/
// s3-mirror.mjs, skills/azure-canary/canary.mjs).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const cmd = process.argv[2] || "run";
  const flags = new Set(process.argv.slice(3));
  if (cmd === "selftest") {
    selftest().catch((e) => { console.error("ERR", e.message); process.exit(1); });
  } else if (cmd === "run") {
    run({ ledgerOnly: flags.has("--ledger-only"), brainOnly: flags.has("--brain-only") })
      .catch((e) => { console.error("ERR", e.message); process.exit(1); });
  } else {
    console.error("usage: node backup.mjs run [--ledger-only|--brain-only] | selftest");
    process.exit(2);
  }
}
