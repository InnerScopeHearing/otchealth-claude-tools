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
import { pathToFileURL } from "node:url";
import { kvSecret } from "../../kb-memory/azure-secret.mjs";
import { cosmosAuthHeader } from "../../kb-memory/cosmos-auth.mjs";

const SM_PROJECT = "otchealth-shared-prod";
const COSMOS_API_VERSION = "2018-12-31";
const DB_NAME_DEFAULT = "agent-state";
const DRY_RUN = process.env.JANITOR_DRY_RUN === "1"; // opt into dry-run; default is APPLY (this is a
// scheduled janitor, not an interactive tool -- Matt asked for it deployed and actually cleaning, not
// logging forever). Every deletion is still logged individually either way.
const MAX_DELETES_PER_CONTAINER = Number(process.env.JANITOR_MAX_DELETES || 2000);

// ---- Episode-decay config (Phase 4B3; see the EPISODE DECAY section below for the full design
// note). Read once here, same style as DRY_RUN/MAX_DELETES_PER_CONTAINER above. The shipped
// defaults are the SAFE (disarmed) values: EPISODE_DECAY_ENABLED unset and no --commit flag both
// mean report-only, see episodeDecayCommitMode(). ----
const argv = process.argv.slice(2);
const EPISODE_DECAY_DAYS = Number(process.env.EPISODE_DECAY_DAYS || 45);
const EPISODE_DECAY_MAX_PER_RUN = Number(process.env.EPISODE_DECAY_MAX_PER_RUN || 500);

// ---- Cosmos REST auth: COSMOS_AUTH_MODE=key|aad, centralized in ../../kb-memory/cosmos-auth.mjs
// (shared by all 4 job Cosmos clients; mirrors the gateway's cosmos.ts exactly). key mode (the
// default) is BYTE-FOR-BYTE the master-key HMAC this file used to build inline -- do NOT "tidy" its
// casing, it is load-bearing.

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
    Authorization: await cosmosAuthHeader({ verb, resType, resourceLink, date, masterKey: c.key }),
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

// ============================ EPISODE DECAY (Phase 4B3 -- SHIPPED DISARMED) ============================
// A narrow, ADDITIVE carve-out layered on top of the `memory` REPORT_ONLY entry above. That entry
// is UNCHANGED: it still reports every kind in the `memory` container (fact/decision/correction/
// pitfall/status/episode) as a simple count + oldest-age, and never deletes anything. This section
// adds a SEPARATE rule that is the only thing in this file allowed to touch the `memory` container's
// contents, and it is scoped as narrowly as possible: kind='episode' ONLY, ever.
//
// WHAT AN "episode" IS: the gateway's safety/journal.ts auto-journals a best-effort one-line record
// of every successful, mutating, non-dry-run tool call ("agent called tool X (success)"), plus
// tools/memory/checkpoint.ts's explicit session-end markers. The gateway's agentstate/agents.ts
// MEMORY_KINDS comment calls this "OPERATIONAL EXHAUST for knowledge retrieval", and
// memory/room-hygiene.ts's EXHAUST_RECORD_TYPES already excludes it from brain_search/kb_search by
// default. It is high-volume and low-value-per-row BY DESIGN -- exactly the class of row that should
// not accumulate forever in the hot `memory` container / memory-exec search index diluting real
// recall precision -- but it is also shaped exactly like a durable fact/decision/correction/pitfall/
// status row (same MemoryRecord interface, same container, same partition key), so this rule is
// deliberately paranoid about touching ONLY kind='episode'.
//
// DOUBLE-ENFORCED KIND FILTER (defense in depth): the Cosmos query below already filters
// `WHERE c.kind = @kind AND c._ts < @cutoff`, but every row it returns is filtered AGAIN, client-side,
// through isEpisodeEligibleForDecay/selectEpisodesForDecay before anything is archived or deleted.
// Two independent layers must both agree a row is an old episode. Unit-tested directly with one
// fixture of every kind (see tests/agent-state-janitor.test.mjs) -- a fact/decision/correction/
// pitfall/status row is NEVER selected, at any age.
//
// SHIPPED DISARMED: episodeDecayCommitMode() requires BOTH an explicit `--commit` CLI arg AND the
// EPISODE_DECAY_ENABLED=1 env var. Neither is part of this job's current default invocation, so
// merging + deploying this section changes NOTHING about production behavior today -- it only starts
// LOGGING what it would archive and delete (report-only), the same posture every other rule in this
// file already has. Arming is a deliberate later step: set EPISODE_DECAY_ENABLED=1 on the Container
// Apps Job's env AND add --commit to its args/command.
//
// ARCHIVE BEFORE DELETE, ALWAYS: mirrors the otchealth-brain snapshot precedent (archived to
// azure://otchealthcommons/company-journal/_ARCHIVE/... before that index was ever deleted). Each
// eligible row is appended as one JSON line to
//   azure://otchealthcommons/company-journal/_ARCHIVE/episodes/<agent>/<YYYY-MM>.jsonl
// (grouped by the month the episode actually happened, see archiveBlobPathFor), and that write is
// confirmed durable (the append resolves 2xx) BEFORE the row is deleted from Cosmos. If the
// archive write fails for a row, that row is logged and skipped -- never deleted.
//
// CONCURRENCY-SAFE ARCHIVE (Azure APPEND BLOB, no read-modify-write): the archive target is an
// APPEND blob, not a block blob. archiveEpisodeRow does create-if-missing (PUT with
// x-ms-blob-type: AppendBlob + If-None-Match:*, so two runs racing to create the same month/agent
// blob resolve to exactly one creator and the losers treat 409/412 as "already there") then Append
// Block (PUT ...?comp=appendblock). Append Block is atomic server-side, so two overlapping ARMED
// runs (e.g. a manual azure_job_execute while the 6-hourly cron run is in flight) can NEVER
// lose-update an already-archived line -- there is no read-then-overwrite window at all. This is the
// exact durability the archive-before-delete design promises: an episode we are about to delete from
// Cosmos must first be durably in the archive, and a concurrent writer must not be able to clobber
// it. The append path uses the SAME account-SAS auth as every other blob call in this file (the SAS
// just carries the `a`/Add permission in addition to r/w/l/c). NOTE these archive paths are brand-new
// (this feature has never run armed), so no legacy block blob exists at them to conflict with the
// append-blob type on first write.
//
// Only after a successful Cosmos delete does a best-effort cleanup remove the row's twin from the
// memory-exec Azure AI Search index (same account/container/docId scheme skills/kb-memory/semantic.mjs's
// reindex and the gateway's azure/search-write.ts indexMemoryNow() write into:
// `${agent}__${id}`, sanitized -- see memoryExecDocId, reimplemented locally rather than imported
// so this job stays dependency-free like the rest of the file); a failure there is logged but never
// blocks or reverses the Cosmos delete, matching search-write.ts's own "indexing is a convenience
// over the durable store" law.

const EPISODE_QUERY =
  "SELECT c.id, c.agent, c.kind, c.text, c.tags, c.source, c.supersedes, c.created_at, c._ts FROM c WHERE c.kind = @kind AND c._ts < @cutoff";

/** True when a Cosmos `memory` row is eligible for episode-decay: kind === 'episode' AND its Cosmos
 *  _ts (epoch seconds) is older than cutoffTs. Every other kind -- fact, decision, correction,
 *  pitfall, status -- is NEVER eligible, regardless of age. Tolerates null/undefined/malformed rows
 *  (never throws). Pure. */
export function isEpisodeEligibleForDecay(doc, cutoffTs) {
  return Boolean(doc) && doc.kind === "episode" && typeof doc._ts === "number" && doc._ts < cutoffTs;
}

/** Filter a batch of Cosmos `memory` rows down to exactly the episode-decay-eligible ones. Pure;
 *  the application-level safety net behind the Cosmos WHERE clause -- see the section note above. */
export function selectEpisodesForDecay(rows, cutoffTs) {
  return (rows || []).filter((d) => isEpisodeEligibleForDecay(d, cutoffTs));
}

/** Both an explicit --commit CLI flag AND the EPISODE_DECAY_ENABLED=1 env kill-switch must be set
 *  for episode-decay to mutate anything; either being absent means report-only (the safe default
 *  this ships with). Exported so the double-gate itself is directly unit-tested, not just its
 *  downstream effect. Pure. */
export function episodeDecayCommitMode(argvList, env) {
  const hasCommitFlag = Array.isArray(argvList) && argvList.includes("--commit");
  const envEnabled = String((env && env.EPISODE_DECAY_ENABLED) || "") === "1";
  return hasCommitFlag && envEnabled;
}

/** The COMPOSED production arming gate, exactly as runEpisodeDecay() uses it: episode-decay mutates
 *  Cosmos/Blob/Search only when the double-gate (episodeDecayCommitMode) is satisfied AND the
 *  file-wide JANITOR_DRY_RUN belt is NOT set. So JANITOR_DRY_RUN=1 forces the whole job (every rule,
 *  including this one) into a safe report-only run even if someone armed --commit + EPISODE_DECAY_ENABLED=1.
 *  Exported so the full composition is unit-tested, not just its two halves (DRY_RUN is a module-level
 *  const, so testing the composition needs this seam). Pure. */
export function resolveEpisodeDecayArmed(argvList, env) {
  return episodeDecayCommitMode(argvList, env) && String((env && env.JANITOR_DRY_RUN) || "") !== "1";
}

/** Archive blob path for one episode row: grouped by the MONTH THE EPISODE ACTUALLY HAPPENED
 *  (created_at), not the month it happens to be archived, so the archive reads as a real timeline.
 *  Falls back to the Cosmos _ts, then to "now", if created_at is missing or malformed. Pure. */
export function archiveBlobPathFor(doc, nowMs = Date.now()) {
  const agentRaw = (doc && (doc.agent || doc.pk)) || "unknown";
  const agent = String(agentRaw).toLowerCase().replace(/[^a-z0-9_-]/g, "_") || "unknown";
  let ym;
  if (doc && typeof doc.created_at === "string" && /^\d{4}-\d{2}/.test(doc.created_at)) {
    ym = doc.created_at.slice(0, 7);
  } else if (doc && typeof doc._ts === "number" && Number.isFinite(doc._ts)) {
    ym = new Date(doc._ts * 1000).toISOString().slice(0, 7);
  } else {
    ym = new Date(nowMs).toISOString().slice(0, 7);
  }
  return `_ARCHIVE/episodes/${agent}/${ym}.jsonl`;
}

/** Same key derivation as skills/kb-memory/semantic.mjs's docId() and the gateway's
 *  azure/search-write.ts memoryDocId() -- MUST match exactly, or this would delete the wrong
 *  memory-exec row (or silently delete nothing). Reimplemented locally, not imported, to keep this
 *  job dependency-free like the rest of the file. Pure. */
export function memoryExecDocId(agent, id) {
  return `${agent}__${id}`.replace(/[^A-Za-z0-9_\-=]/g, "_");
}

/**
 * Orchestrate episode-decay for one batch of Cosmos `memory` rows. PURE INPUT / INJECTED IO: rows,
 * cutoffTs, and commit are plain data; archiveRow/deleteRow/deleteFromIndex are async callbacks the
 * caller supplies (real Azure calls from runEpisodeDecay() below, simple mocks in tests) -- this
 * keeps the archive-before-delete safety property directly unit-testable with zero live Cosmos/
 * Blob/Search credentials.
 *
 *   - Only rows selectEpisodesForDecay() returns are ever touched.
 *   - commit=false (report-only, the shipped default) calls neither archiveRow nor deleteRow; it
 *     only logs what it would do.
 *   - commit=true: for each eligible row (capped at maxPerRun), archiveRow() is awaited FIRST; only
 *     on its success is deleteRow() called. archiveRow() throwing skips deleteRow() for that row
 *     entirely (logged, counted, not fatal to the rest of the batch) -- archive-before-delete is
 *     atomic per row.
 *   - deleteFromIndex() runs best-effort AFTER a successful deleteRow(); its failure is logged and
 *     counted but never reverses or blocks the already-completed Cosmos delete.
 *   - maxPerRun bounds worst-case blast radius per invocation (mirrors MAX_DELETES_PER_CONTAINER);
 *     any remainder is left for the next scheduled run.
 */
export async function decayEpisodesForRule({
  rows,
  cutoffTs,
  commit,
  archiveRow,
  deleteRow,
  deleteFromIndex,
  maxPerRun = Infinity,
  log = () => {},
}) {
  const eligible = selectEpisodesForDecay(rows, cutoffTs);
  const batch = eligible.slice(0, maxPerRun);
  if (eligible.length > batch.length) {
    log(`episode-decay: ${eligible.length} eligible, capped to ${batch.length} this run (maxPerRun=${maxPerRun}); remainder retried next run`);
  }
  let archived = 0, deleted = 0, archiveErrors = 0, deleteErrors = 0, indexErrors = 0;
  for (const doc of batch) {
    if (!commit) {
      log(`DRY-RUN episode-decay would archive+delete ${doc.id} (agent=${doc.agent})`);
      continue;
    }
    try {
      await archiveRow(doc);
      archived++;
    } catch (e) {
      archiveErrors++;
      log(`episode-decay ARCHIVE FAILED for ${doc.id}: ${e.message} -- skipping delete (archive-before-delete)`);
      continue;
    }
    try {
      await deleteRow(doc);
      deleted++;
      log(`episode-decay DELETED ${doc.id} (agent=${doc.agent}) after successful archive`);
    } catch (e) {
      deleteErrors++;
      log(`episode-decay DELETE FAILED for ${doc.id} after successful archive: ${e.message}`);
      continue; // still live in Cosmos -- do not attempt index cleanup
    }
    try {
      await deleteFromIndex(doc);
    } catch (e) {
      indexErrors++;
      log(`episode-decay index cleanup FAILED for ${doc.id} (best-effort, non-fatal): ${e.message}`);
    }
  }
  return {
    mode: commit ? "COMMIT" : "REPORT-ONLY",
    scanned: rows.length,
    eligible: eligible.length,
    processed: batch.length,
    archived,
    deleted,
    archiveErrors,
    deleteErrors,
    indexErrors,
  };
}

// ---- real IO for decayEpisodesForRule (Azure Blob archive + memory-exec index cleanup). Reuses the
// same account-SAS + fetch pattern as skills/ledger-compaction/job/run-compaction.mjs and
// skills/cfo-store/store.mjs, but uses an APPEND blob (create-if-missing + Append Block) instead of a
// block-blob read-modify-write, so overlapping runs cannot lose an archived line. Pointed at the same
// otchealthcommons/company-journal account + container nightly.sh already writes into (assumed to
// already exist -- no create-container call). ----
let _archiveCfg;
async function archiveCfg() {
  if (_archiveCfg !== undefined) return _archiveCfg;
  const acct = (await sm("azure-commons-storage-account")) || "otchealthcommons";
  const key = await sm("azure-commons-storage-key");
  if (!key) throw new Error("agent-state-janitor: episode-decay archive creds unavailable (azure-commons-storage-key not resolvable via Key Vault or GCP Secret Manager)");
  _archiveCfg = { acct, key, container: "company-journal" };
  return _archiveCfg;
}
function archiveSas(acct, key) {
  // sp carries `a` (Add) IN ADDITION to r/w/l/c: Append Block requires the Add permission on an
  // account SAS. Everything else matches the other blob calls in this file. Account SAS supports
  // append blobs directly -- no different auth path than the account-SAS we already use.
  const sv = "2021-12-02", sp = "racwl", ss = "b", srt = "co";
  const st = new Date(Date.now() - 5 * 60000).toISOString().slice(0, 19) + "Z";
  const se = new Date(Date.now() + 3600 * 1000).toISOString().slice(0, 19) + "Z";
  const sts = [acct, sp, ss, srt, st, se, "", "https", sv, ""].join("\n") + "\n";
  const sig = crypto.createHmac("sha256", Buffer.from(key, "base64")).update(sts, "utf8").digest("base64");
  return new URLSearchParams({ sv, ss, srt, sp, st, se, spr: "https", sig }).toString();
}
const archiveEncPath = (name) => name.split("/").map(encodeURIComponent).join("/");

/** Create the append blob if it does not exist. If-None-Match:* makes this create-ONLY, so it never
 *  resets an existing archive blob and two runs racing to create the same blob resolve to exactly
 *  one creator (201); the losers get 409/412 (BlobAlreadyExists / precondition failed) which we
 *  treat as "already present, fine". Any OTHER non-2xx is a real failure and throws. */
async function archiveEnsureAppendBlob(acct, container, sas, name) {
  const r = await fetch(`https://${acct}.blob.core.windows.net/${container}/${archiveEncPath(name)}?${sas}`, {
    method: "PUT",
    headers: { "x-ms-blob-type": "AppendBlob", "Content-Type": "application/x-ndjson; charset=utf-8", "If-None-Match": "*" },
  });
  if (r.ok) return;
  if (r.status === 409 || r.status === 412) return; // already exists (another writer created it) -> fine
  throw new Error(`agent-state-janitor: archive append-blob create ${name} -> HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
}
/** Atomically append one block (the ndjson line) to the append blob. Concurrent Append Block calls
 *  to the same blob never clobber each other -- there is no read-modify-write. */
async function archiveAppendBlock(acct, container, sas, name, body) {
  const r = await fetch(`https://${acct}.blob.core.windows.net/${container}/${archiveEncPath(name)}?comp=appendblock&${sas}`, {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream" },
    body,
  });
  if (!r.ok) throw new Error(`agent-state-janitor: archive appendblock ${name} -> HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
}

/**
 * Pure orchestration of one episode's archive append over an INJECTED append-only blob interface
 * ({ ensureAppendBlob, appendBlock }). No fetch, no SAS, no clock beyond the injectable nowIso, so
 * the archive-append safety property (create-if-missing THEN atomic append, never read-modify-write)
 * is directly unit-testable against an in-memory append store. runEpisodeDecay() wires the real
 * fetch-based ops below; tests inject a store that models Azure append semantics and assert NO line
 * is lost across concurrent appends to the same blob. Exported for those tests.
 */
export async function appendEpisodeToArchive({ ensureAppendBlob, appendBlock }, path, doc, nowIso) {
  await ensureAppendBlob(path);
  const line = JSON.stringify({ ...doc, archived_at: nowIso || new Date().toISOString() }) + "\n";
  await appendBlock(path, line);
}

/** Append one episode row as a JSON line to its month/agent archive APPEND blob. Real IO used by
 *  runEpisodeDecay(); tests exercise the pure appendEpisodeToArchive() above with a mock store
 *  instead. Concurrency-safe by construction (create-if-missing + atomic Append Block, never a
 *  read-modify-write), so overlapping armed runs cannot lose an archived line. */
async function archiveEpisodeRow(doc) {
  const { acct, key, container } = await archiveCfg();
  const sas = archiveSas(acct, key);
  const path = archiveBlobPathFor(doc);
  await appendEpisodeToArchive(
    {
      ensureAppendBlob: (p) => archiveEnsureAppendBlob(acct, container, sas, p),
      appendBlock: (p, body) => archiveAppendBlock(acct, container, sas, p, body),
    },
    path,
    doc,
  );
}

/** Best-effort removal of one episode's twin row from the memory-exec Azure AI Search index. Real
 *  IO used by runEpisodeDecay(); tests inject a mock. Reuses the Cosmos-creds resolver (sm) already
 *  defined above, pointed at the search-specific secrets instead. */
async function deleteFromMemoryExecIndex(doc) {
  const aisEp = ((await sm("azure-search-endpoint")) || "").replace(/\/$/, "");
  const aisKey = await sm("azure-search-admin-key");
  if (!aisEp || !aisKey) throw new Error("agent-state-janitor: memory-exec index creds unavailable (azure-search-endpoint/azure-search-admin-key)");
  const id = memoryExecDocId(doc.agent, doc.id);
  // api-version 2024-07-01 matches the gateway's azure/search-write.ts (indexMemoryNow writes the
  // twin row) so read+delete of the same doc use one API version. Document delete is stable across
  // both, so this is a consistency alignment, not a behavior change.
  const r = await fetch(`${aisEp}/indexes/memory-exec/docs/index?api-version=2024-07-01`, {
    method: "POST",
    headers: { "api-key": aisKey, "Content-Type": "application/json" },
    body: JSON.stringify({ value: [{ "@search.action": "delete", id }] }),
  });
  if (!r.ok) throw new Error(`agent-state-janitor: memory-exec index delete ${id} -> HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
}

/** The real (network-touching) runner main() calls. Queries Cosmos for candidate episode rows
 *  (server-side kind+age filter), then hands them to decayEpisodesForRule with the real archive/
 *  delete/index-cleanup IO wired in. See the section note above for the full safety story. `commit`
 *  additionally respects the file's existing JANITOR_DRY_RUN belt: if that is set, episode-decay
 *  stays report-only even when --commit + EPISODE_DECAY_ENABLED=1 are both present, so one env var
 *  reliably forces the whole job (every rule) into a safe dry-run. */
async function runEpisodeDecay() {
  const cutoffTs = Math.floor(Date.now() / 1000 - EPISODE_DECAY_DAYS * 86400);
  const rows = await queryAll("memory", EPISODE_QUERY, [
    { name: "@kind", value: "episode" },
    { name: "@cutoff", value: cutoffTs },
  ]);
  const commit = resolveEpisodeDecayArmed(argv, process.env);
  console.log(`[janitor] episode-decay: mode=${commit ? "COMMIT" : "REPORT-ONLY"} (--commit=${argv.includes("--commit")} EPISODE_DECAY_ENABLED=${process.env.EPISODE_DECAY_ENABLED === "1"} JANITOR_DRY_RUN=${DRY_RUN}) cutoffDays=${EPISODE_DECAY_DAYS} candidates=${rows.length}`);
  return decayEpisodesForRule({
    rows,
    cutoffTs,
    commit,
    archiveRow: archiveEpisodeRow,
    deleteRow: (doc) => deleteDoc("memory", doc.agent, doc.id),
    deleteFromIndex: deleteFromMemoryExecIndex,
    maxPerRun: EPISODE_DECAY_MAX_PER_RUN,
    log: (msg) => console.log(`[janitor] ${msg}`),
  });
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
  results.episodeDecay = await runEpisodeDecay();
  results.finishedAt = new Date().toISOString();
  console.log("[janitor] SUMMARY", JSON.stringify(results));
  const totalErrors =
    results.cleaned.reduce((s, r) => s + r.errors, 0) +
    results.episodeDecay.archiveErrors +
    results.episodeDecay.deleteErrors;
  if (totalErrors > 0) {
    console.error(`[janitor] completed with ${totalErrors} delete error(s) -- exiting non-zero so the Job surfaces this as a real failure, not a silent success`);
    process.exit(1);
  }
  console.log("[janitor] done, clean run");
}

// Only auto-run when executed directly (node agent-state-janitor.mjs, how the Container Apps Job
// invokes this), never on import -- so tests can import the pure/injectable exports above without
// triggering a real Cosmos/Blob/Search run. Mirrors skills/kb-memory/semantic.mjs's isMain guard.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((e) => {
    console.error("[janitor] FATAL:", e.message);
    process.exit(1);
  });
}
