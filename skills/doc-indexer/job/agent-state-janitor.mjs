#!/usr/bin/env node
// agent-state-janitor.mjs — Container Apps Job (cron `30 */6 * * *`, otchealth-jobs-env /
// otchealth-automation-rg). Garbage-collects the `agent-state` Cosmos DB account
// (cosmos-otc-agentstate-55c84, database "agent-state" -- the pre-existing kb-memory/gateway
// database, distinct from the newer `ai_memory` database used by the Agent Memory Toolkit pilot).
//
// WHY THIS EXISTS: two of the account's 8 containers were provisioned with defaultTtl=-1
// (TTL enabled at the container level, but Cosmos only expires an item if THAT item also carries
// its own `ttl` field -- a container-level -1 does NOT expire anything by itself). Verified live via
// ARM on 2026-07-09: `oauthcodes` (pk /id) and `turns` (pk /threadId) are both in this state, meaning
// any writer that forgot to set a per-item ttl leaves that document there forever. This job is the
// backstop: it enforces an absolute-age cutoff on those containers regardless of whether the writer
// set its own ttl, using the same dependency-free Cosmos REST client pattern already proven in
// skills/decision-clock/cosmos-client.mjs and skills/signal-radar/common.mjs (master-key HMAC auth,
// creds self-resolved via kvSecret -- Key Vault first, GCP Secret Manager fallback).
//
// CREDENTIAL PATH (fixed 2026-07-09): this job predates the fleet's managed-identity-for-Key-Vault
// pattern (established 2026-07-05, see azure-secret.mjs's A9-MANAGED-IDENTITY note) and originally
// shipped with identity:None, relying only on the legacy GCP-Secret-Manager fallback -- which is
// silently dead now that the fleet has moved its secrets to Azure Key Vault (confirmed live: the SA
// key decodes fine but the resulting GCP token mint/Secret Manager call never succeeds). Fixed by
// attaching a SystemAssigned identity to the job (principalId 1e711cfe-584e-4d48-931a-a84b20c62fcd)
// and granting it "Key Vault Secrets User" on kv-otc-55c84f6bef -- kvSecret()'s identity path now
// resolves cosmos-agent-state-endpoint/key/db directly, no GCP round-trip needed. The GCP fallback
// stays in this file for now (harmless, matches every other doc-indexer-family job's code shape) but
// is not the path this job actually uses.
//
// SAFETY MODEL (read this before touching CLEANUP_RULES):
//   - Hard allowlist: ONLY the containers listed in CLEANUP_RULES are eligible for deletion, ever.
//     decisions_pending, tasks, and memory are load-bearing governance/ledger data (open decision
//     gates, the fleet task board, durable agent memory) -- deleting by age alone could destroy an
//     unresolved item. They are REPORT-ONLY (count + oldest-item age logged every run, never touched).
//   - cache and signals already self-clean via a real container-level defaultTtl and need no action.
//   - Every deletion is logged individually (container, id, partition key, age in days) before the
//     DELETE call -- this job must NEVER be a silent success (see lint-silent-success.mjs; that
//     anti-pattern is exactly what caused past outages and is why Matt asked for this to be written
//     properly rather than deferred again).
//   - Per-run cap (MAX_DELETES_PER_CONTAINER) bounds worst-case blast radius if a query is ever
//     miswritten. Exceeding the cap logs a warning and stops early rather than deleting unboundedly.
//   - Fails LOUD: any credential/network/query error throws and exits non-zero, so the Container Apps
//     Job's own retry/alerting reflects a real failure instead of a green checkmark over broken state.
import crypto from "node:crypto";
import { kvSecret } from "../../kb-memory/azure-secret.mjs";

const SM_PROJECT = "otchealth-shared-prod";
const COSMOS_API_VERSION = "2018-12-31";
const DB_NAME_DEFAULT = "agent-state";
const DRY_RUN = process.env.JANITOR_DRY_RUN === "1"; // opt into dry-run; default is APPLY (this is a
// scheduled janitor, not an interactive tool -- Matt asked for it deployed and actually cleaning, not
// logging forever). Every deletion is still logged individually either way.
const MAX_DELETES_PER_CONTAINER = Number(process.env.JANITOR_MAX_DELETES || 2000);

// ---- Cosmos REST auth (mirrors decision-clock/cosmos-client.mjs and the gateway's cosmos.ts
// exactly -- do NOT "tidy" the casing, it is load-bearing) ----
function authToken(verb, resType, resourceLink, date, masterKey) {
  const stringToSign = `${verb.toLowerCase()}\n${resType.toLowerCase()}\n${resourceLink}\n${date.toLowerCase()}\n\n`;
  const sig = crypto.createHmac("sha256", Buffer.from(masterKey, "base64")).update(stringToSign, "utf8").digest("base64");
  return encodeURIComponent(`type=master&ver=1.0&sig=${sig}`);
}

// GCP Secret Manager fallback (claude-driver SA), same pattern as decision-clock/cosmos-client.mjs.
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
function resolveSaJson() {
  if (process.env.GCP_CLAUDE_DRIVER_SA_JSON) return process.env.GCP_CLAUDE_DRIVER_SA_JSON;
  // This job's Container Apps spec passes the SA as GCP_CLAUDE_DRIVER_SA_JSON_B64 (secretRef "sab64")
  // and runs `node` directly with no shell wrapper to decode it first (unlike decision-clock-sweep.sh
  // / librarian.sh, which do `export GCP_CLAUDE_DRIVER_SA_JSON=$(... | base64 -d)` before invoking
  // node) -- decode it here instead of requiring a job-spec change.
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
  const sa = JSON.parse(raw);
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
  const r0 = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${encodeURIComponent(jwt)}` });
  const t = (await r0.json()).access_token;
  if (!t) return null;
  const r = await fetch(`https://secretmanager.googleapis.com/v1/projects/${SM_PROJECT}/secrets/${id}/versions/latest:access`, { headers: { Authorization: `Bearer ${t}` } });
  if (!r.ok) return null;
  return Buffer.from((await r.json()).payload.data, "base64").toString("utf8").trim();
}

let _cfg;
async function cfg() {
  if (_cfg !== undefined) return _cfg;
  const endpoint = process.env.COSMOS_ENDPOINT || (await sm("cosmos-agent-state-endpoint"));
  const key = process.env.COSMOS_KEY || (await sm("cosmos-agent-state-key"));
  const dbName = process.env.COSMOS_DB || (await sm("cosmos-agent-state-db")) || DB_NAME_DEFAULT;
  if (!endpoint || !key) throw new Error("agent-state-janitor: Cosmos creds unavailable (cosmos-agent-state-endpoint/key not resolvable via Key Vault or GCP Secret Manager) -- failing loud, not silently skipping.");
  _cfg = { endpoint: endpoint.replace(/\/+$/, ""), key, db: dbName };
  return _cfg;
}

async function request(verb, resType, resourceLink, urlPath, opts = {}) {
  const c = await cfg();
  const date = new Date().toUTCString();
  const headers = {
    Authorization: authToken(verb, resType, resourceLink, date, c.key),
    "x-ms-date": date,
    "x-ms-version": COSMOS_API_VERSION,
    Accept: "application/json",
  };
  if (opts.pk !== undefined) headers["x-ms-documentdb-partitionkey"] = JSON.stringify([opts.pk]);
  if (opts.pkRangeId !== undefined) headers["x-ms-documentdb-partitionkeyrangeid"] = opts.pkRangeId;
  if (opts.continuation) headers["x-ms-continuation"] = opts.continuation;
  if (opts.maxItemCount) headers["x-ms-max-item-count"] = String(opts.maxItemCount);
  if (opts.isQuery) {
    headers["Content-Type"] = "application/query+json";
    headers["x-ms-documentdb-isquery"] = "true";
    if (opts.pk === undefined) headers["x-ms-documentdb-query-enablecrosspartition"] = "true";
  }
  const r = await fetch(`${c.endpoint}/${urlPath}`, { method: verb, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  const txt = await r.text();
  let body = null;
  try { body = txt ? JSON.parse(txt) : null; } catch { body = { raw: txt }; }
  return { status: r.status, ok: r.ok, body };
}

async function pkRanges(coll) {
  const c = await cfg(); const link = `dbs/${c.db}/colls/${coll}`;
  const res = await request("GET", "pkranges", link, `${link}/pkranges`, {});
  if (!res.ok) throw new Error(`agent-state-janitor: pkranges ${coll} -> HTTP ${res.status}`);
  return ((res.body?.PartitionKeyRanges) || []).map((r) => r.id);
}

/** Cross-partition query, fanning out per pk-range (mirrors cosmos-client.mjs's queryDocs). */
async function queryAll(coll, query, parameters = []) {
  const c = await cfg(); const link = `dbs/${c.db}/colls/${coll}`;
  const ranges = await pkRanges(coll);
  const out = [];
  for (const rid of ranges) {
    let continuation;
    do {
      const res = await request("POST", "docs", link, `${link}/docs`, { isQuery: true, pkRangeId: rid, body: { query, parameters }, continuation, maxItemCount: 200 });
      if (!res.ok) throw new Error(`agent-state-janitor: query ${coll} -> HTTP ${res.status}: ${JSON.stringify(res.body).slice(0, 240)}`);
      out.push(...((res.body?.Documents) || []));
      continuation = res.continuation;
    } while (continuation);
  }
  return out;
}

async function deleteDoc(coll, pkValue, id) {
  const c = await cfg(); const link = `dbs/${c.db}/colls/${coll}/docs/${id}`;
  const res = await request("DELETE", "docs", link, link, { pk: pkValue });
  if (!res.ok && res.status !== 404) throw new Error(`agent-state-janitor: delete ${coll}/${id} -> HTTP ${res.status}: ${JSON.stringify(res.body).slice(0, 240)}`);
  return res;
}

// ---- Cleanup rules: HARD allowlist. Only these containers are ever deleted from. ----
// pk: the container's partition-key field name (needed for the delete call's x-ms-documentdb-partitionkey).
// maxAgeDays: absolute cutoff by Cosmos's built-in _ts (epoch seconds), independent of any per-item ttl.
const CLEANUP_RULES = [
  { container: "oauthcodes", pk: "id", maxAgeDays: 1 / 48, reason: "single-use OAuth codes; container has defaultTtl=-1 (per-item ttl required, not guaranteed set) -- 30min absolute backstop" },
  { container: "turns", pk: "threadId", maxAgeDays: 60, reason: "legacy conversation-turn log; container has defaultTtl=-1 -- 60-day absolute backstop (matches ai_memory's memories_turns 60-day TTL)" },
  { container: "events", pk: "task_id", maxAgeDays: 90, reason: "task event/telemetry log, no container TTL -- 90-day retention (matches signals' 90-day TTL)" },
];

// Report-only containers: NEVER deleted, only health-logged. Deliberately hard-coded here, not
// env-configurable, so a misconfigured env var cannot silently widen the blast radius.
const REPORT_ONLY = [
  { container: "decisions_pending", pk: "owner", note: "decision-clock's pending gate queue -- an old item here is a problem to escalate, not delete" },
  { container: "tasks", pk: "board", note: "fleet task ledger -- real work records" },
  { container: "memory", pk: "agent", note: "durable per-agent memory -- never pruned by age" },
];

function daysAgo(_ts) { return (Date.now() / 1000 - _ts) / 86400; }

async function cleanupContainer(rule) {
  const cutoffTs = Math.floor(Date.now() / 1000 - rule.maxAgeDays * 86400);
  const query = `SELECT c.id, c["${rule.pk}"] AS pk, c._ts FROM c WHERE c._ts < @cutoff`;
  const docs = await queryAll(rule.container, query, [{ name: "@cutoff", value: cutoffTs }]);
  console.log(`[janitor] ${rule.container}: ${docs.length} item(s) older than ${rule.maxAgeDays}d (${rule.reason})`);
  let deleted = 0, errors = 0;
  for (const d of docs) {
    if (deleted >= MAX_DELETES_PER_CONTAINER) {
      console.warn(`[janitor] ${rule.container}: hit MAX_DELETES_PER_CONTAINER=${MAX_DELETES_PER_CONTAINER}, stopping early this run (remaining will be caught next run)`);
      break;
    }
    const ageDays = daysAgo(d._ts).toFixed(1);
    if (DRY_RUN) {
      console.log(`[janitor] DRY-RUN would delete ${rule.container}/${d.id} (pk=${d.pk}, age=${ageDays}d)`);
      deleted++;
      continue;
    }
    try {
      await deleteDoc(rule.container, d.pk, d.id);
      console.log(`[janitor] DELETED ${rule.container}/${d.id} (pk=${d.pk}, age=${ageDays}d)`);
      deleted++;
    } catch (e) {
      console.error(`[janitor] FAILED to delete ${rule.container}/${d.id}: ${e.message}`);
      errors++;
    }
  }
  return { container: rule.container, scanned: docs.length, deleted, errors };
}

async function reportContainer(rule) {
  const query = "SELECT VALUE COUNT(1) FROM c";
  const countDocs = await queryAll(rule.container, query, []);
  const count = countDocs[0] ?? 0;
  let oldestAgeDays = null;
  try {
    const oldest = await queryAll(rule.container, "SELECT TOP 1 c._ts FROM c ORDER BY c._ts ASC", []);
    if (oldest.length) oldestAgeDays = daysAgo(oldest[0]._ts).toFixed(1);
  } catch { /* ORDER BY without composite index can fail on some containers -- report count only */ }
  console.log(`[janitor] REPORT-ONLY ${rule.container}: count=${count} oldestAgeDays=${oldestAgeDays ?? "unknown"} (${rule.note})`);
  return { container: rule.container, count, oldestAgeDays };
}

async function main() {
  console.log(`[janitor] agent-state-janitor starting -- mode=${DRY_RUN ? "DRY_RUN" : "APPLY"} db=${(await cfg()).db}`);
  const results = { cleaned: [], reported: [], startedAt: new Date().toISOString() };
  for (const rule of CLEANUP_RULES) {
    results.cleaned.push(await cleanupContainer(rule));
  }
  for (const rule of REPORT_ONLY) {
    results.reported.push(await reportContainer(rule));
  }
  results.finishedAt = new Date().toISOString();
  console.log("[janitor] SUMMARY", JSON.stringify(results));
  const totalErrors = results.cleaned.reduce((s, r) => s + r.errors, 0);
  if (totalErrors > 0) {
    console.error(`[janitor] completed with ${totalErrors} delete error(s) -- exiting non-zero so the Job surfaces this as a real failure, not a silent success`);
    process.exit(1);
  }
  console.log("[janitor] done, clean run");
}

main().catch((e) => {
  console.error("[janitor] FATAL:", e.message);
  process.exit(1);
});
