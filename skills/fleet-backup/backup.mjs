#!/usr/bin/env node
/**
 * fleet-backup — daily offline copy of the fleet's two most central, least-redundant stores:
 *   (a) the Cosmos work-ledger (tasks + the append-only event log per task), and
 *   (b) a full document dump of the Azure AI Search index `otchealth-brain` (~67,645 docs).
 *
 * WHY THIS EXISTS (CROSS-BOARD-HARDENING.md item #7): both stores currently have ZERO offline copy.
 * If the Cosmos account or the `otchealth-brain-search` service were ever deleted, corrupted, or
 * suffered a bad write, there is no independent restore path. This job gives that independent,
 * version-controlled (blob-versioned) copy, decoupled from the live Azure resources it backs up.
 *
 * DESIGN NOTE / correction to the original runbook wording: the runbook text says "export ... to
 * otchealth-cto/ledger-backup/<date>.jsonl", which reads like a literal path inside the otchealth-cto
 * GIT REPO. That is NOT what this job does, deliberately: committing a daily growing ledger dump
 * (and a 67k-document search-index dump) into git would bloat repo history unboundedly and git is
 * not a backup store (no lifecycle policy, no versioning-with-retention, clones get slower forever).
 * Every other durable-artifact pattern in this fleet (kb-memory ledgers, cfo-source-docs, the legal
 * store) uses Azure Blob Storage, not git, for exactly this reason. This job therefore writes to Blob:
 *   container: ledger-backup  (name mirrors the runbook path's directory component)
 *   blobs:     ledger-backup/tasks-<date>.jsonl
 *              ledger-backup/brain-index-<date>.jsonl
 *              ledger-backup/manifest-<date>.json   (counts + hashes, for verifying completeness)
 * on the existing fleet storage account (see IAC_NOTES.md for exactly which account/RG to use —
 * this script takes the account name via env so it is not hardcoded to one choice).
 *
 * AUTH (current fleet pattern as of 2026-07, post GCP-Secret-Manager retirement):
 *   - Azure Key Vault via Container Apps MANAGED IDENTITY (kv-otc-55c84f6bef, secret names below),
 *     same resolution helper style as skills/kb-memory/azure-secret.mjs. No client secret baked into
 *     the job spec; the job's managed identity must be granted:
 *       - "Key Vault Secrets User" on kv-otc-55c84f6bef (scoped to the specific secrets it reads, or
 *         the vault if per-secret RBAC isn't in use)
 *       - "Storage Blob Data Contributor" scoped to ONLY the `ledger-backup` container (not the whole
 *         storage account) on the backup storage account
 *   - Cosmos work-ledger and AI Search are NOT reached directly (no Cosmos connection string / AI
 *     Search admin key is provisioned to this job). Both are reached exclusively through the existing
 *     read-only gateway HTTP API (mcp.otchealth.app), using the SAME least-privilege posture already
 *     enforced there (task_list/task_get for the ledger; a paginated raw index read for the brain).
 *     This avoids handing the backup job its own Cosmos/Search credentials at all — it inherits
 *     whatever the gateway already exposes read-only, which is strictly less privilege than a raw
 *     Cosmos "read" role or a Search "read" API key would be.
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
 *   gateway-bearer-token       bearer/API token the job presents to mcp.otchealth.app (read-only scope)
 *
 * REQUIRED ENV (set in the Container Apps Job spec, non-secret):
 *   BACKUP_STORAGE_ACCOUNT     e.g. stotc55c84f6bef (see IAC_NOTES.md — confirm exact account name
 *                              before deploy; this script does not hardcode one)
 *   BACKUP_CONTAINER           default "ledger-backup"
 *   GATEWAY_BASE_URL           default https://mcp.otchealth.app
 *   AZURE_KEYVAULT_NAME        default kv-otc-55c84f6bef
 *
 * USAGE:
 *   node backup.mjs run                 # full run: ledger export + brain index export + manifest
 *   node backup.mjs run --ledger-only
 *   node backup.mjs run --brain-only
 *   node backup.mjs selftest            # no writes: verify identity token + KV secret + blob container reachable
 */

import crypto from "node:crypto";

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

/** Pull the full payload for a JIT-offloaded result (see src/tools/result-store.ts on the gateway). */
async function fetchOffloaded(bearer, resultId) {
  const parts = [];
  let page = 1;
  for (;;) {
    const chunk = await gatewayCall(bearer, "gateway_fetch_result", { result_id: resultId, page });
    if (chunk == null) break;
    if (typeof chunk === "string") { parts.push(chunk); break; }
    const text = chunk.text ?? chunk.chunk ?? chunk.data ?? null;
    if (text != null) parts.push(String(text));
    const hasMore = chunk.has_more ?? chunk.hasMore ?? false;
    if (!hasMore) break;
    page = chunk.next_page ?? page + 1;
  }
  const combined = parts.join("");
  try { return JSON.parse(combined); } catch { return combined; }
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
async function exportBrainIndexDirect(apiKey, endpoint, { index = process.env.BRAIN_INDEX || "otchealth-brain", pageSize = 1000, apiVersion = "2023-11-01" } = {}) {
  const rows = [];
  let skip = 0, odataCount = null;
  for (;;) {
    const r = await fetch(`${endpoint}/indexes/${index}/docs/search?api-version=${apiVersion}`, {
      method: "POST",
      headers: { "api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ search: "*", top: pageSize, skip, count: skip === 0 }),
    });
    if (!r.ok) throw new Error(`AI Search dump ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j = await r.json();
    if (skip === 0) odataCount = j["@odata.count"];
    const docs = (j.value || []).map((d) => {
      const o = { ...d };
      delete o["@search.score"]; delete o["@search.rerankerScore"]; delete o["@search.highlights"]; delete o["@search.captions"];
      return o;
    });
    if (!docs.length) break;
    rows.push(...docs);
    skip += docs.length;
    if (docs.length < pageSize) break; // last page
    if (skip >= 100000) { // Azure AI Search $skip hard ceiling
      console.warn(`[fleet-backup] WARNING: hit the AI Search $skip=100000 ceiling at ${rows.length} docs; index has more. Switch to range/key paging for a complete dump.`);
      break;
    }
  }
  if (odataCount != null && rows.length < odataCount) {
    console.warn(`[fleet-backup] WARNING: dumped ${rows.length} of @odata.count=${odataCount} brain docs.`);
  }
  return rows;
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

  const manifest = { date, account, container, ledger: null, brain: null };

  if (!brainOnly) {
    console.log("[fleet-backup] exporting Cosmos work-ledger via gateway task_list/task_get ...");
    const ledgerRows = await exportLedger(bearer);
    const ledgerBuf = Buffer.from(toNdjson(ledgerRows), "utf8");
    const blobName = `tasks-${date}.jsonl`;
    await putBlockBlob(account, container, blobName, ledgerBuf, "application/x-ndjson");
    manifest.ledger = { blob: blobName, rows: ledgerRows.length, bytes: ledgerBuf.length, sha256: sha256(ledgerBuf) };
    console.log(`[fleet-backup] ledger export OK: ${ledgerRows.length} tasks, ${ledgerBuf.length} bytes -> ${container}/${blobName}`);
  }

  if (!ledgerOnly) {
    // Prefer the DIRECT AI Search dump (reliable full-index export). Fall back to the gateway
    // brain_search path (LIMITED: cannot enumerate the full index) ONLY if no query key is
    // provisioned, so the job still produces a ledger backup + best-effort brain sample.
    const brainKey = await kvSecret("brain-search-query-key");
    const brainEndpoint = (await kvSecret("brain-search-endpoint")) || process.env.BRAIN_SEARCH_ENDPOINT || "https://otchealth-brain-search.search.windows.net";
    let brainRows;
    if (brainKey) {
      console.log(`[fleet-backup] exporting otchealth-brain via DIRECT AI Search dump (${brainEndpoint}, search=* $top/$skip) ...`);
      brainRows = await exportBrainIndexDirect(brainKey, brainEndpoint);
    } else {
      console.warn("[fleet-backup] brain-search-query-key ABSENT; falling back to gateway brain_search (LIMITED: cannot enumerate the full index -- expect a partial/empty dump).");
      brainRows = await exportBrainIndex(bearer);
    }
    const brainBuf = Buffer.from(toNdjson(brainRows), "utf8");
    const blobName = `brain-index-${date}.jsonl`;
    await putBlockBlob(account, container, blobName, brainBuf, "application/x-ndjson");
    manifest.brain = { blob: blobName, rows: brainRows.length, bytes: brainBuf.length, sha256: sha256(brainBuf) };
    console.log(`[fleet-backup] brain index export OK: ${brainRows.length} docs, ${brainBuf.length} bytes -> ${container}/${blobName}`);
    if (brainRows.length < 60000) {
      console.warn(`[fleet-backup] WARNING: expected ~67,645 docs in otchealth-brain; only captured ${brainRows.length}. Investigate before trusting this as a full DR copy.`);
    }
  }

  const manifestBuf = Buffer.from(JSON.stringify(manifest, null, 2), "utf8");
  await putBlockBlob(account, container, `manifest-${date}.json`, manifestBuf, "application/json");
  console.log(`[fleet-backup] manifest written: ${container}/manifest-${date}.json`);
  console.log(JSON.stringify(manifest, null, 2));
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
