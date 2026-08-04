// cosmos-export.mjs — a DIRECT, dependency-free Cosmos DB for NoSQL REST client used ONLY by
// skills/fleet-backup/backup.mjs to export the three agent-state Cosmos containers that have NO
// safe, complete read path through the gateway's MCP tool surface:
//
//   memory              (pk /agent)     the structured memory-of-record (NOT the same thing as the
//                                        memory-exec AI Search index, which is a lossy DERIVED
//                                        projection of this container -- see otchealth-mcp-server's
//                                        src/agentstate/memory.ts)
//   events              (pk /task_id)   the append-only task event log
//   decisions_pending   (pk /owner)     the decision-clock's open-gate tracker
//
// WHY NOT THE GATEWAY (a deliberate, documented departure from this job's normal least-privilege
// posture -- see backup.mjs's own header note on why it otherwise prefers the gateway): the
// gateway's `memory_search` tool caps results at 100 with NO continuation/pagination token
// (confirmed against otchealth-mcp-server's tool schema) -- an export built on it would silently
// truncate `memory` (currently ~3,900+ rows and growing, confirmed live) the exact same way a
// 0-indexed-vs-1-indexed pagination bug already truncated a different gateway-mediated export (see
// backup.mjs's `fetchOffloaded` history / FND-20260728-b8a0). `events` and `decisions_pending` have
// NO gateway read tool at all -- task_list/task_get (which backup.mjs's own exportLedger() already
// uses) only cover `tasks`. So this module talks to Cosmos directly, with REAL x-ms-continuation
// pagination drained to exhaustion (never capped), using the SAME master-key REST auth pattern
// already proven live in skills/kb-memory/cosmos-memory-read.mjs and
// skills/decision-clock/cosmos-client.mjs. Auth-header construction itself is centralized in the ONE
// shared skills/kb-memory/cosmos-auth.mjs -- this file does not reimplement the HMAC formula.
//
// `tasks` keeps using the gateway path (backup.mjs's own exportLedger(), unchanged by this module).
// `events` here is intentionally a SEPARATE, redundant capture of task history via its own
// container -- exportLedger's task_get already folds per-task event history into the tasks export,
// but redundant, cheap, complete coverage of a small container is the right tradeoff for a DR
// backup (an export that OVERLAPS is fine; an export that silently OMITS a container is not).
//
// READ-ONLY BY CONSTRUCTION: this module exports exactly one query function (queryContainerAll,
// plus the dumpContainer convenience wrapper around it) and the fixed container/partition-key
// registry below. There is no create/replace/delete/upsert path of any kind anywhere in this file --
// nothing here for a caller to accidentally use to mutate the Cosmos memory-of-record.
//
// AUTH / CREDENTIALS: resolves cosmos-agent-state-endpoint / cosmos-agent-state-key /
// cosmos-agent-state-db from Azure Key Vault (kv-otc-55c84f6bef) via the shared kvSecret() helper
// (managed identity first, SP client_credentials fallback -- mirrors every other job Cosmos client in
// this repo, see skills/kb-memory/azure-secret.mjs). ENV OVERRIDE: COSMOS_ENDPOINT / COSMOS_KEY /
// COSMOS_DB, the same names every other Cosmos client in this repo already honors.
//
// DEPLOY NOTE (a new requirement this module adds to backup.mjs's Container Apps Job spec): the
// job's managed identity must additionally be granted read access to the
// cosmos-agent-state-endpoint / cosmos-agent-state-key Key Vault secrets (the same two secrets
// skills/kb-memory, skills/decision-clock, and skills/doc-indexer/job/agent-state-janitor.mjs already
// read in their own jobs). backup.mjs's Key Vault grant previously only needed to cover
// gateway-bearer-token. If the grant is per-secret RBAC (see backup.mjs's own header note: "scoped to
// the specific secrets it reads, or the vault if per-secret RBAC isn't in use") rather than
// vault-wide, this is a real, separate provisioning step before the job can run this path in
// production -- it is NOT automatic just because this code exists.

import { kvSecret } from "../kb-memory/azure-secret.mjs";
import { cosmosAuthHeader } from "../kb-memory/cosmos-auth.mjs";

const COSMOS_API_VERSION = "2018-12-31";
const DB_NAME_DEFAULT = "agent-state";

// Hard allowlist: container name -> partition-key FIELD NAME (not a value). Confirmed live against
// production (see skills/fleet-backup/README.md and the PR that added this file) and matches the
// registry already documented in skills/doc-indexer/job/agent-state-janitor.mjs's REPORT_ONLY list
// and skills/decision-clock/decision.mjs's own "/owner" partitioning comment. Path-injection guard,
// same discipline as skills/decision-clock/cosmos-client.mjs's CONTAINERS Set -- container names are
// interpolated directly into REST URLs below, so only names in this allowlist are ever queryable
// through this module, regardless of what a caller passes in.
export const COSMOS_CONTAINERS = Object.freeze({
  memory: Object.freeze({ pk: "agent" }),
  events: Object.freeze({ pk: "task_id" }),
  decisions_pending: Object.freeze({ pk: "owner" }),
});

function assertContainer(name) {
  if (!Object.prototype.hasOwnProperty.call(COSMOS_CONTAINERS, name)) {
    throw new Error(`cosmos-export: unknown container "${name}" (allowed: ${Object.keys(COSMOS_CONTAINERS).join(", ")})`);
  }
}

let _cfg; // memoized {endpoint, key, db} | null
async function cfg() {
  if (_cfg !== undefined) return _cfg;
  const endpoint = process.env.COSMOS_ENDPOINT || (await kvSecret("cosmos-agent-state-endpoint"));
  const key = process.env.COSMOS_KEY || (await kvSecret("cosmos-agent-state-key"));
  const dbName = process.env.COSMOS_DB || (await kvSecret("cosmos-agent-state-db")) || DB_NAME_DEFAULT;
  _cfg = endpoint && key ? { endpoint: endpoint.replace(/\/+$/, ""), key, db: dbName } : null;
  return _cfg;
}

/** Test-only: clear the memoized config so cases with different env don't leak state across each
 *  other. A no-op in production use (nothing in this file's real call paths calls this). */
export function _resetConfigForTests() {
  _cfg = undefined;
}

/** True when Cosmos creds resolved in this environment. Callers that want fail-open behavior should
 *  check this first rather than let a missing-credential Error crash a nightly job outright. */
export async function isCosmosConfigured() {
  return (await cfg()) !== null;
}

async function request(verb, resType, resourceLink, urlPath, opts = {}) {
  const c = await cfg();
  if (!c) throw new Error("cosmos-export: Cosmos agent-state not configured (cosmos-agent-state-endpoint/key unavailable from Key Vault).");
  const date = new Date().toUTCString();
  const headers = {
    Authorization: await cosmosAuthHeader({ verb, resType, resourceLink, date, masterKey: c.key }),
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
  const r = await fetch(`${c.endpoint}/${urlPath}`, {
    method: verb,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const txt = await r.text();
  let body = null;
  try { body = txt ? JSON.parse(txt) : null; } catch { body = { raw: txt }; }
  return { status: r.status, ok: r.ok, body, continuation: r.headers.get("x-ms-continuation") };
}

async function pkRanges(container) {
  const c = await cfg();
  const link = `dbs/${c.db}/colls/${container}`;
  const res = await request("GET", "pkranges", link, `${link}/pkranges`, {});
  if (!res.ok) throw new Error(`cosmos-export: pkranges ${container} -> HTTP ${res.status}: ${JSON.stringify(res.body).slice(0, 240)}`);
  return ((res.body && res.body.PartitionKeyRanges) || []).map((r) => r.id);
}

/**
 * Cross-partition, READ-ONLY, UNBOUNDED query against one allowlisted container. Fans out per
 * pk-range (a container's pk-ranges must each be queried independently for a cross-partition query --
 * an x-ms-continuation token is only valid WITHIN the pk-range that issued it), and within each range
 * drains x-ms-continuation to exhaustion. There is deliberately NO row cap anywhere in this function
 * (unlike skills/kb-memory/cosmos-memory-read.mjs's queryMemory, which caps at 5000 for its own
 * bounded reflection/scan use case) -- a DR export must never silently stop early; a caller that
 * wants a bound should slice the returned array itself, not ask this function to truncate.
 *
 * Throws on any non-2xx response (including mid-drain, on a later page of an otherwise-successful
 * pk-range) rather than degrading to "return what we have so far" -- see backup.mjs's own header
 * note on why this job fails loud rather than ever writing a partial export as if it were complete.
 */
export async function queryContainerAll(container, query, parameters = [], { pageSize = 500 } = {}) {
  assertContainer(container);
  const c = await cfg();
  if (!c) throw new Error("cosmos-export: Cosmos agent-state not configured.");
  const link = `dbs/${c.db}/colls/${container}`;
  const ranges = await pkRanges(container);
  const out = [];
  for (const rid of ranges) {
    let continuation;
    let pageCount = 0;
    do {
      const res = await request("POST", "docs", link, `${link}/docs`, {
        isQuery: true,
        pkRangeId: rid,
        body: { query, parameters },
        continuation,
        maxItemCount: pageSize,
      });
      if (!res.ok) {
        throw new Error(`cosmos-export: query ${container} (pkRange ${rid}, page ${pageCount}) -> HTTP ${res.status}: ${JSON.stringify(res.body).slice(0, 240)}`);
      }
      const docs = (res.body && res.body.Documents) || [];
      out.push(...docs);
      continuation = res.continuation || undefined;
      pageCount++;
      if (pageCount > 100000) {
        // A defensive circuit breaker, not a real-world limit (at maxItemCount=500 this is 50M rows
        // per pk-range). Guards against silently hanging a Container Apps Job forever if Cosmos ever
        // returned a continuation token that never terminates, rather than draining "forever".
        throw new Error(`cosmos-export: query ${container} (pkRange ${rid}) exceeded ${pageCount} pages without exhausting its continuation token -- aborting as a probable infinite-pagination bug rather than looping forever.`);
      }
    } while (continuation);
  }
  return out;
}

/** Convenience: full unbounded dump of one allowlisted container ("SELECT * FROM c"). This is what
 *  backup.mjs actually calls for memory / events / decisions_pending. */
export async function dumpContainer(container, opts = {}) {
  return queryContainerAll(container, "SELECT * FROM c", [], opts);
}
