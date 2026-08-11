#!/usr/bin/env node
// search-deletion-policy.mjs — closes a fleet-wide correctness bug on Azure AI Search
// otchealth-dataroom-s1: every one of its 18 blob-backed datasources has
// dataDeletionDetectionPolicy: null (and dataChangeDetectionPolicy: null), so deleting a source blob
// NEVER removes its search document. Ghost documents accumulate permanently and crowd out live
// results in brain_search / kb_search across every ring. Root-caused live 2026-08-04 (CTO).
//
// Fix: NativeBlobSoftDeleteDeletionDetectionPolicy on each datasource, which REQUIRES blob soft-delete
// enabled on the backing storage account first (verified live: otchealthcommons already has it,
// 14 days; otchealthlegalstore / otchealthcfodata / otchealthcommerce do not).
//
// THE ONE SHARP EDGE (read before touching this file): a datasource GET response NEVER returns a
// usable credentials.connectionString -- Azure Search always redacts it (comes back as `null` on this
// service; the Azure docs describe `<unchanged>`/`<redacted>` sentinels for the same field on write).
// Blindly PUTting a GET response back verbatim would therefore silently DESTROY the datasource's
// connection to blob storage and break its indexer. buildPutBody() below is the single place that
// guards this: it ALWAYS forces credentials.connectionString to the literal string "<unchanged>" on
// write, regardless of what the GET returned, and otherwise copies every other field from the GET
// response untouched (container, type, description, encryptionKey, dataChangeDetectionPolicy, name).
// Verified against the live Azure REST docs (Data Sources - Create Or Update, api-version 2024-07-01):
// "connectionString ... Set to `<unchanged>` (with brackets) if you don't want the connection string
// updated." See buildPutBody()'s own comment for the full citation.
//
// Auth: azure-sp client_credentials for ARM (mirrors setup/drift-recon.mjs's ensureSpCreds/armToken --
// env fast-path, else the shared kb-memory kvSecret() resolver), api-key for the Azure AI Search
// data-plane (mirrors skills/doc-indexer/indexer.mjs's AIS_EP/AIS_KEY resolution). Both read-only
// until --commit is passed to `apply`.
//
// Usage:
//   node setup/search-deletion-policy.mjs audit [--json] [--strict]
//   node setup/search-deletion-policy.mjs apply [--commit] [--only <datasourceName>] [--json]
//
// `audit` is read-only: reports every manifest datasource's current deletion/change policy plus its
// backing storage account's soft-delete state. Safe to run anytime; this is the ongoing drift
// detector. `--strict` exits 3 if any datasource is missing the correct policy (for CI gating);
// default (no --strict) always exits 0, matching this fleet's other canary/report scripts.
//
// `apply` is dry-run BY DEFAULT (plans and prints what it would do, makes zero network writes).
// `--commit` is required to actually mutate anything: (1) enables blob soft-delete (14-day retention)
// on any backing storage account that lacks it, via an ARM PUT scoped to that account's
// blobServices/default (PUT, not PATCH -- that sub-resource 404s on PATCH, see enableBlobSoftDelete);
// (2) PUTs each datasource back with dataDeletionDetectionPolicy set to
// NativeBlobSoftDeleteDeletionDetectionPolicy, preserving every other field. Idempotent: a datasource
// already carrying the correct policy is skipped (no PUT issued) on every re-run. `--only <name>`
// scopes a run to a single datasource (used to prove the approach on ds-commons-journal before any
// fleet-wide rollout -- see the CTO's dispatch note; this repo intentionally ships with the fleet-wide
// apply UNRUN, gated on a human "go" for the remaining 17).
//
// Exit codes: 0 = success / clean. 1 = unexpected error or a failed --commit write.
//             3 = audit --strict found drift. 2 = usage error. 78 = missing azure-sp/search creds.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const DEFAULT_MANIFEST_PATH = path.join(__dirname, "expected-datasources.json");

export const SEARCH_API = "2024-07-01";
export const STORAGE_API = "2023-01-01";
export const DELETION_POLICY = Object.freeze({ "@odata.type": "#Microsoft.Azure.Search.NativeBlobSoftDeleteDeletionDetectionPolicy" });
export const UNCHANGED_CONNECTION_STRING = "<unchanged>";

// ============================================================== manifest ====
export function loadManifest(manifestPath = DEFAULT_MANIFEST_PATH) {
  const raw = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (!Array.isArray(raw.datasources) || raw.datasources.length === 0) {
    throw new Error(`manifest at ${manifestPath} has no datasources[]`);
  }
  return raw;
}

/** Unique storage-account names referenced by the manifest, in first-seen order. */
export function accountsInManifest(manifest) {
  const seen = new Set();
  const out = [];
  for (const d of manifest.datasources) {
    if (!seen.has(d.storageAccount)) { seen.add(d.storageAccount); out.push(d.storageAccount); }
  }
  return out;
}

// ============================================================== azure-sp / ARM auth ====
let TEN = process.env.AZURE_SP_TENANT_ID, CID = process.env.AZURE_SP_CLIENT_ID, CSEC = process.env.AZURE_SP_CLIENT_SECRET;
let SUB = process.env.AZURE_SUBSCRIPTION_ID || null;

async function ensureSpCreds() {
  if (TEN && CID && CSEC && SUB) return true;
  try {
    const m = await import("../skills/kb-memory/azure-secret.mjs");
    TEN = TEN || (await m.kvSecret("azure-sp-tenant-id"));
    CID = CID || (await m.kvSecret("azure-sp-client-id"));
    CSEC = CSEC || (await m.kvSecret("azure-sp-client-secret"));
    SUB = SUB || (await m.kvSecret("azure-subscription-id")) || "55c84f6b-ef90-4259-a58b-50835cc4cab4";
  } catch { /* fall through to the caller's own missing-creds handling */ }
  return Boolean(TEN && CID && CSEC && SUB);
}

export async function armToken() {
  if (!(await ensureSpCreds())) return null;
  const r = await fetch(`https://login.microsoftonline.com/${TEN}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: CID, client_secret: CSEC, scope: "https://management.azure.com/.default" }),
  });
  const j = await r.json().catch(() => ({}));
  return j.access_token || null;
}

export function currentSubscriptionId() { return SUB; }

// ============================================================== Azure AI Search creds ====
let AIS_EP = process.env.AZURE_SEARCH_ENDPOINT || null;
let AIS_KEY = process.env.AZURE_SEARCH_KEY || null;

async function ensureSearchCreds() {
  if (AIS_EP && AIS_KEY) return true;
  try {
    const m = await import("../skills/kb-memory/azure-secret.mjs");
    AIS_EP = AIS_EP || (await m.kvSecret("azure-search-endpoint"));
    AIS_KEY = AIS_KEY || (await m.kvSecret("azure-search-admin-key"));
  } catch { /* fall through */ }
  if (AIS_EP) AIS_EP = AIS_EP.replace(/\/$/, "");
  return Boolean(AIS_EP && AIS_KEY);
}

// ============================================================== ARM: storage accounts ====
/** Resolve a storage account's full ARM resource id. Tries the manifest's resourceGroup hint first
 *  (one direct GET); falls back to a subscription-wide list-and-match (same fallback pattern as
 *  setup/resource-reconcile.mjs's storageAccount handling) if the hint is wrong or absent. */
export async function resolveStorageAccountId(tok, sub, accountName, resourceGroupHint) {
  if (resourceGroupHint) {
    const r = await fetch(`https://management.azure.com/subscriptions/${sub}/resourceGroups/${resourceGroupHint}/providers/Microsoft.Storage/storageAccounts/${accountName}?api-version=${STORAGE_API}`, { headers: { Authorization: `Bearer ${tok}` } });
    if (r.status === 200) { const j = await r.json(); return j.id; }
  }
  const lr = await fetch(`https://management.azure.com/subscriptions/${sub}/providers/Microsoft.Storage/storageAccounts?api-version=${STORAGE_API}`, { headers: { Authorization: `Bearer ${tok}` } });
  if (!lr.ok) return null;
  const lj = await lr.json().catch(() => ({}));
  const match = (lj.value || []).find((a) => a.name === accountName);
  return match ? match.id : null;
}

export async function getBlobSoftDelete(tok, storageAccountId) {
  const r = await fetch(`https://management.azure.com${storageAccountId}/blobServices/default?api-version=${STORAGE_API}`, { headers: { Authorization: `Bearer ${tok}` } });
  if (!r.ok) return { status: r.status, enabled: null, days: null };
  const j = await r.json().catch(() => ({}));
  const p = j.properties?.deleteRetentionPolicy || {};
  return { status: r.status, enabled: Boolean(p.enabled), days: p.days ?? null };
}

export async function enableBlobSoftDelete(tok, storageAccountId, days) {
  const r = await fetch(`https://management.azure.com${storageAccountId}/blobServices/default?api-version=${STORAGE_API}`, {
    // PUT, not PATCH. The blobServices/default sub-resource does NOT support PATCH -- it answers
    // HTTP 404 HttpResourceNotFound, which reads like a missing account/resource-group and sends you
    // hunting for the wrong bug (verified live 2026-08-05 on otchealthcfodata + otchealthcommerce:
    // PATCH 404'd, PUT to the byte-identical URL returned 200). The PUT body carries only
    // deleteRetentionPolicy, and blobServices merges rather than replacing sibling properties.
    method: "PUT",
    headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
    body: JSON.stringify({ properties: { deleteRetentionPolicy: { enabled: true, days } } }),
  });
  return { ok: r.ok, status: r.status, body: r.ok ? null : await r.text().catch(() => "") };
}

// ============================================================== Azure AI Search: datasources ====
export async function listDatasources(ep, key) {
  const r = await fetch(`${ep}/datasources?api-version=${SEARCH_API}`, { headers: { "api-key": key } });
  if (!r.ok) throw new Error(`listDatasources: HTTP ${r.status}`);
  const j = await r.json();
  return j.value || [];
}

export async function getDatasource(ep, key, name) {
  const r = await fetch(`${ep}/datasources('${encodeURIComponent(name)}')?api-version=${SEARCH_API}`, { headers: { "api-key": key } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`getDatasource(${name}): HTTP ${r.status}`);
  return r.json();
}

export async function putDatasource(ep, key, name, body) {
  const r = await fetch(`${ep}/datasources('${encodeURIComponent(name)}')?api-version=${SEARCH_API}`, {
    method: "PUT",
    headers: { "api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await r.text().catch(() => "");
  return { ok: r.ok, status: r.status, body: text };
}

export async function getIndexerStatus(ep, key, indexerName) {
  const r = await fetch(`${ep}/indexers('${encodeURIComponent(indexerName)}')/status?api-version=${SEARCH_API}`, { headers: { "api-key": key } });
  if (!r.ok) return { ok: false, status: r.status };
  return { ok: true, status: r.status, body: await r.json() };
}

/** ds-<suffix> -> ixr-<suffix>; the fleet's 1:1 datasource/indexer naming convention, verified live
 *  across all 18 pairs on otchealth-dataroom-s1. */
export function indexerNameFor(datasourceName) {
  return datasourceName.replace(/^ds-/, "ixr-");
}

// ============================================================== pure decision logic ====
export function hasCorrectDeletionPolicy(datasource) {
  return datasource?.dataDeletionDetectionPolicy?.["@odata.type"] === DELETION_POLICY["@odata.type"];
}

/** Build the PUT body for a datasource update that ONLY changes dataDeletionDetectionPolicy.
 *  `existing` is a live GET response (or an equivalent fixture in tests). Every field on it is
 *  copied through untouched EXCEPT: (a) credentials.connectionString is force-set to the literal
 *  "<unchanged>" sentinel (Azure REST docs, Data Sources - Create Or Update, DataSourceCredentials:
 *  "connectionString ... Set to `<unchanged>` (with brackets) if you don't want the connection string
 *  updated") -- never the GET response's own (redacted/null) value; (b) dataDeletionDetectionPolicy is
 *  set to the desired policy; (c) @odata.context / @odata.etag (read-only response metadata, not valid
 *  request fields) are stripped. container.query, dataChangeDetectionPolicy, description,
 *  encryptionKey, name, and type are passed through byte-for-byte unchanged. */
export function buildPutBody(existing, desiredPolicy = DELETION_POLICY) {
  const { "@odata.context": _ctx, "@odata.etag": _etag, credentials: _creds, dataDeletionDetectionPolicy: _ddp, ...rest } = existing;
  return {
    ...rest,
    credentials: { connectionString: UNCHANGED_CONNECTION_STRING },
    dataDeletionDetectionPolicy: desiredPolicy,
  };
}

// ============================================================== orchestration: audit ====
export async function auditOne(ep, key, tok, sub, entry, resourceGroupHint) {
  const ds = await getDatasource(ep, key, entry.name);
  let softDelete = { status: null, enabled: null, days: null };
  if (tok) {
    const acctId = await resolveStorageAccountId(tok, sub, entry.storageAccount, resourceGroupHint);
    if (acctId) softDelete = await getBlobSoftDelete(tok, acctId);
  }
  return {
    name: entry.name,
    exists: Boolean(ds),
    container: ds?.container?.name ?? null,
    query: ds?.container?.query ?? null,
    storageAccount: entry.storageAccount,
    softDeleteEnabled: softDelete.enabled,
    softDeleteDays: softDelete.days,
    dataDeletionDetectionPolicy: ds?.dataDeletionDetectionPolicy ?? null,
    dataChangeDetectionPolicy: ds?.dataChangeDetectionPolicy ?? null,
    correct: ds ? hasCorrectDeletionPolicy(ds) : false,
  };
}

export async function runAudit({ manifestPath = DEFAULT_MANIFEST_PATH, json = false } = {}) {
  const manifest = loadManifest(manifestPath);
  if (!(await ensureSearchCreds())) { console.error("[search-deletion-policy][FATAL] azure-search-endpoint / azure-search-admin-key unavailable."); process.exit(78); }
  const tok = await armToken();
  if (!tok) console.error("[search-deletion-policy][WARN] no ARM token (azure-sp creds unavailable) -- storage soft-delete state will be unknown, not misreported as OK.");
  const sub = currentSubscriptionId();

  const rows = [];
  for (const entry of manifest.datasources) {
    rows.push(await auditOne(AIS_EP, AIS_KEY, tok, sub, entry, manifest.resourceGroup));
  }

  const drift = rows.filter((r) => !r.correct || r.softDeleteEnabled === false);
  if (json) {
    console.log(JSON.stringify({ rows, driftCount: drift.length }, null, 2));
  } else {
    console.log(`Audit: otchealth-dataroom-s1, ${rows.length} datasources\n`);
    console.log(pad("NAME", 36) + pad("STORAGE ACCT", 22) + pad("SOFT-DELETE", 14) + pad("DEL-POLICY", 16) + "CHANGE-POLICY");
    for (const r of rows) {
      const sd = r.softDeleteEnabled === null ? "unknown" : r.softDeleteEnabled ? `on (${r.softDeleteDays}d)` : "OFF";
      const dp = r.correct ? "correct" : (r.dataDeletionDetectionPolicy ? "WRONG" : "MISSING");
      const cp = r.dataChangeDetectionPolicy ? JSON.stringify(r.dataChangeDetectionPolicy) : "null";
      console.log(pad(r.exists ? r.name : `${r.name} (NOT FOUND)`, 36) + pad(r.storageAccount, 22) + pad(sd, 14) + pad(dp, 16) + cp);
    }
    console.log(`\n${rows.length - drift.length}/${rows.length} correct. ${drift.length} need fixing.`);
    if (drift.length) console.log("Drifted: " + drift.map((r) => r.name).join(", "));
  }
  return { rows, driftCount: drift.length };
}

function pad(s, n) { s = String(s); return s.length >= n ? s + " " : s + " ".repeat(n - s.length); }

// ============================================================== orchestration: apply ====
/** Ensure one storage account has blob soft-delete enabled. Dry-run unless commit=true. Returns a
 *  plan/result object; never throws (a failed enable is reported, not fatal to the whole run). */
export async function ensureAccountSoftDelete(tok, sub, accountName, resourceGroupHint, retentionDays, { commit = false } = {}) {
  const acctId = await resolveStorageAccountId(tok, sub, accountName, resourceGroupHint);
  if (!acctId) return { account: accountName, action: "error", detail: "storage account not found via ARM" };
  const before = await getBlobSoftDelete(tok, acctId);
  if (before.enabled) return { account: accountName, action: "noop", detail: `already enabled (${before.days}d)` };
  if (!commit) return { account: accountName, action: "would-enable", detail: `retention ${retentionDays}d (dry-run, no write made)` };
  const res = await enableBlobSoftDelete(tok, acctId, retentionDays);
  if (!res.ok) return { account: accountName, action: "error", detail: `PUT failed HTTP ${res.status}: ${res.body.slice(0, 300)}` };
  return { account: accountName, action: "enabled", detail: `retention ${retentionDays}d` };
}

/** Apply the deletion policy to one datasource. Dry-run unless commit=true. Idempotent: a datasource
 *  already carrying the correct policy makes NO PUT call, commit or not. Skips (does not PUT) if the
 *  account plan for its backing storage account did not end in a state where soft-delete is enabled
 *  (accountReady=false), since NativeBlobSoftDeleteDeletionDetectionPolicy requires that precondition. */
export async function applyDatasource(ep, key, entry, { commit = false, accountReady = true } = {}) {
  const existing = await getDatasource(ep, key, entry.name);
  if (!existing) return { name: entry.name, action: "error", detail: "datasource not found" };
  if (hasCorrectDeletionPolicy(existing)) return { name: entry.name, action: "noop", detail: "already correct" };
  if (!accountReady) return { name: entry.name, action: "blocked", detail: "backing storage account does not have soft-delete enabled" };
  if (!commit) return { name: entry.name, action: "would-fix", detail: "dry-run, no write made" };
  const body = buildPutBody(existing);
  const res = await putDatasource(ep, key, entry.name, body);
  if (!res.ok) return { name: entry.name, action: "error", detail: `PUT failed HTTP ${res.status}: ${res.body.slice(0, 300)}` };
  return { name: entry.name, action: "fixed", detail: "PUT ok" };
}

export async function runApply({ manifestPath = DEFAULT_MANIFEST_PATH, commit = false, only = null, json = false, verifyIndexer = false } = {}) {
  const manifest = loadManifest(manifestPath);
  if (!(await ensureSearchCreds())) { console.error("[search-deletion-policy][FATAL] azure-search-endpoint / azure-search-admin-key unavailable."); process.exit(78); }
  const tok = await armToken();
  if (!tok) { console.error("[search-deletion-policy][FATAL] no ARM token (azure-sp creds unavailable) -- cannot check/enable storage soft-delete."); process.exit(78); }
  const sub = currentSubscriptionId();

  const entries = only ? manifest.datasources.filter((d) => d.name === only) : manifest.datasources;
  if (only && entries.length === 0) { console.error(`[search-deletion-policy][FATAL] --only ${only}: not present in manifest.`); process.exit(2); }

  console.log(commit ? "APPLY (--commit): writes will be made.\n" : "DRY RUN (pass --commit to write anything).\n");

  const accounts = [...new Set(entries.map((e) => e.storageAccount))];
  const accountResults = {};
  for (const acct of accounts) {
    const res = await ensureAccountSoftDelete(tok, sub, acct, manifest.resourceGroup, manifest.retentionDays || 14, { commit });
    accountResults[acct] = res;
    console.log(`storage  ${pad(res.account, 22)} ${pad(res.action, 14)} ${res.detail}`);
  }
  const accountReady = (acct) => {
    const r = accountResults[acct];
    return r.action === "noop" || r.action === "enabled";
  };

  console.log("");
  const dsResults = [];
  for (const entry of entries) {
    const res = await applyDatasource(AIS_EP, AIS_KEY, entry, { commit, accountReady: accountReady(entry.storageAccount) });
    dsResults.push(res);
    console.log(`datasource ${pad(res.name, 36)} ${pad(res.action, 12)} ${res.detail}`);
    if (commit && res.action === "fixed" && verifyIndexer) {
      const readback = await getDatasource(AIS_EP, AIS_KEY, entry.name);
      const okPolicy = hasCorrectDeletionPolicy(readback);
      const idxName = indexerNameFor(entry.name);
      const st = await getIndexerStatus(AIS_EP, AIS_KEY, idxName);
      const lastStatus = st.ok ? (st.body.lastResult?.status ?? "(no prior run recorded)") : `status-check-failed HTTP ${st.status}`;
      console.log(`  readback policy-correct=${okPolicy}  indexer ${idxName} lastResult.status=${lastStatus}`);
    }
  }

  const errors = [...Object.values(accountResults), ...dsResults].filter((r) => r.action === "error");
  if (json) console.log(JSON.stringify({ accountResults, dsResults }, null, 2));
  if (errors.length) { console.error(`\n${errors.length} error(s).`); process.exit(1); }
  return { accountResults, dsResults };
}

// ============================================================== CLI ====
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const flag = (name) => argv.includes(name);
  const opt = (name, def) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : def; };

  const usage = `Usage:
  node setup/search-deletion-policy.mjs audit [--json] [--strict]
  node setup/search-deletion-policy.mjs apply [--commit] [--only <datasourceName>] [--json] [--verify-indexer]`;

  if (!cmd || flag("--help") || flag("-h")) { console.log(usage); process.exit(cmd ? 0 : 2); }

  if (cmd === "audit") {
    runAudit({ json: flag("--json") })
      .then(({ driftCount }) => { if (flag("--strict") && driftCount > 0) process.exit(3); })
      .catch((e) => { console.error("ERR", e.message); process.exit(1); });
  } else if (cmd === "apply") {
    runApply({ commit: flag("--commit"), only: opt("--only", null), json: flag("--json"), verifyIndexer: flag("--verify-indexer") })
      .catch((e) => { console.error("ERR", e.message); process.exit(1); });
  } else {
    console.error(usage);
    process.exit(2);
  }
}
