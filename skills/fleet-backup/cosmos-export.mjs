// cosmos-export.mjs — a DIRECT, dependency-free Cosmos DB for NoSQL REST client used by
// skills/fleet-backup/backup.mjs to export Cosmos containers that have NO safe, complete read path
// through the gateway's MCP tool surface.
//
// ============================================================================================
// GAP-9 (2026-08-13, DR coverage re-audit): the allowlist below originally covered only THREE
// containers -- memory (pk /agent), events (pk /task_id), decisions_pending (pk /owner) -- all in
// the `agent-state` database. Verified live against production this session: the account actually
// holds THIRTEEN containers across TWO databases:
//   agent-state: decisions_pending, cache, events, oauthcodes, tasks, turns, memory, signals
//   ai_memory:   memories_turns, memories, leases, memories_summaries, counter
// So this module (and therefore every DR export built on it) had never captured `tasks` (a separate,
// redundant capture from the gateway-mediated exportLedger() in backup.mjs -- see its own header),
// `signals`, `cache`, and the ENTIRE `ai_memory` database. This revision widens the allowlist to all
// thirteen and makes the module multi-database-aware (see DB RESOLUTION below) rather than assuming
// a single hardcoded db name for every container.
//
// PK / LANE FIELD PROVENANCE (so a future reader knows what is verified vs. inferred): pk field
// names for memory/events/decisions_pending/tasks/signals/oauthcodes/turns/cache/memories/
// memories_turns are confirmed against real source in this repo, otchealth-mcp-server, and
// otchealth-cto (see the registry comments below for the exact file each one comes from). `leases`,
// `counter`, and `memories_summaries` have NO confirmed pk field name anywhere this session could
// reach (they were not documented and their code lives in the Python azure-cosmos-agent-memory
// toolkit, not a repo checked out here) -- their `pk` values below are a reasonable INFERENCE
// (leases/counter as singleton-style docs keyed by their own id; memories_summaries following the
// same thread_id-partitioning pattern as its sibling memories/memories_turns containers), not a
// verified fact. This does not affect correctness of the actual export: queryContainerAll() below
// is a CROSS-PARTITION query that fans out over the container's real pk-RANGES (which Cosmos reports
// authoritatively via the /pkranges endpoint) and never needs the pk FIELD NAME or a pk VALUE to do
// a full scan -- so even if one of the three inferred pk names is wrong, the export itself is
// unaffected. The pk field name matters only for documentation and for a future point-read/write
// caller, which this module does not have (read-only, SELECT * FROM c only).
//
// WHY NOT THE GATEWAY (a deliberate, documented departure from this job's normal least-privilege
// posture -- see backup.mjs's own header note on why it otherwise prefers the gateway): the
// gateway's `memory_search` tool caps results at 100 with NO continuation/pagination token
// (confirmed against otchealth-mcp-server's tool schema) -- an export built on it would silently
// truncate `memory` (currently ~3,900+ rows and growing, confirmed live) the exact same way a
// 0-indexed-vs-1-indexed pagination bug already truncated a different gateway-mediated export (see
// backup.mjs's `fetchOffloaded` history / FND-20260728-b8a0). Most of the newly-added containers
// (signals, cache, oauthcodes, turns, and the whole ai_memory database) have NO gateway read tool at
// all. So this module talks to Cosmos directly, with REAL x-ms-continuation pagination drained to
// exhaustion (never capped), using the SAME master-key REST auth pattern already proven live in
// skills/kb-memory/cosmos-memory-read.mjs and skills/decision-clock/cosmos-client.mjs. Auth-header
// construction itself is centralized in the ONE shared skills/kb-memory/cosmos-auth.mjs -- this file
// does not reimplement the HMAC formula.
//
// `tasks` ALSO keeps using the gateway path (backup.mjs's own exportLedger(), unchanged by this
// module) -- this module's own `tasks` entry is an intentionally SEPARATE, redundant direct capture
// (same reasoning as the pre-existing `events`-vs-task_get overlap note below): an export that
// OVERLAPS is fine; an export that silently OMITS a container is not.
//
// READ-ONLY BY CONSTRUCTION: this module exports exactly two query functions (queryContainerAll,
// plus the dumpContainer / dumpContainerSegregated convenience wrappers around it) and the fixed
// container/partition-key registry below. There is no create/replace/delete/upsert path of any kind
// anywhere in this file -- nothing here for a caller to accidentally use to mutate the Cosmos
// memory-of-record.
//
// ============================================================================================
// TWO SAFETY REQUIREMENTS added alongside GAP-9 (both load-bearing; see dumpContainerSegregated()):
//
// (a) RING SEGREGATION. Several containers carry a lane discriminator field (memory.agent,
//     events.actor, decisions_pending.owner, tasks.owner_agent, signals.owner). A personal-lane row
//     (lane string matching /(^|[-_])personal($|[-_])/i -- e.g. "clo-personal") must never be
//     co-mingled with general company/finance rows in the same export output. This mirrors
//     PERSONAL_LEGAL_RING in otchealth-mcp-server PR #124 (the P0 cross-ring leak fix for
//     kb_search_privileged / brain_search / legal_blob_*): the same personal-vs-company separation
//     that gateway enforces on READS must hold for this direct-Cosmos DR export too, or a DR restore
//     could reintroduce exactly the leak #124 closed. classifyLane() below computes, per row, whether
//     it goes in the `general` or `restricted` bucket; a container with NO lane field at all (cache,
//     oauthcodes, turns, and every ai_memory container -- none of them carry an agent-identity lane,
//     see the registry) has no way to prove a row is safe for the general bucket, so EVERY row from
//     those containers fails closed into `restricted` by the same rule (an absent/unrecognized lane
//     value on a container that DOES have a lane field also fails closed the same way). This is a
//     conservative default (some containers end up 100% restricted even though most of their rows are
//     not actually personal-legal data), which is the correct direction to err on for a DR export.
//
// (b) CACHE TOKEN ENCRYPTION. The `cache` container's rows can carry live OAuth accessToken /
//     refreshToken VALUES (see skills/xero/xero-token.mjs's header + otchealth-mcp-server's
//     src/tools/xero/client.ts / src/auth/revocation-store.ts, which is exactly what populates this
//     container). DECISION: encrypt those two fields (never write them in plaintext, never silently
//     drop them either) using the fleet's existing AES-256-GCM envelope format
//     (skills/fleet-backup/crypto-envelope.mjs, the same format skills/fleet-backup/secrets-dr-*
//     already use, keyed off the `secrets-dr-passphrase` Key Vault secret) rather than omitting the
//     fields outright. Justification: a DR export exists to make disaster recovery possible; if a
//     real incident ever required restoring the `cache` container, an export with the token fields
//     stripped would be forensically informative (which orgs, when) but operationally useless for
//     actual recovery (every live session would need to be manually re-authenticated instead of
//     restored) -- reusing an already-audited, already-in-production encryption format costs nothing
//     new to build or key-manage. ENFORCEMENT (the "impossible to bypass silently" requirement):
//     dumpContainer("cache") is a HARD REFUSAL (throws immediately, before any network call) -- there
//     is no code path in this module that can return `cache` rows with plaintext token fields. The
//     only way to read `cache` at all is dumpContainerSegregated("cache", { passphrase }), which
//     requires the passphrase up front and always encrypts accessToken/refreshToken before a row is
//     placed in either output bucket.
//
// ============================================================================================
// DB RESOLUTION (new, GAP-9): the Cosmos ACCOUNT (endpoint + master key) is shared across both
// databases -- there is exactly one `cosmos-agent-state-endpoint` / `cosmos-agent-state-key` pair in
// Key Vault and it authenticates account-wide, so no new credential secret is needed for ai_memory.
// Only the DATABASE NAME differs per container (see COSMOS_CONTAINERS' `db` field below):
//   agent-state db name: COSMOS_DB_AGENT_STATE env, else legacy COSMOS_DB env (unchanged
//     back-compat with every existing caller/test of this file), else Key Vault
//     `cosmos-agent-state-db`, else "agent-state".
//   ai_memory db name:    COSMOS_DB_AI_MEMORY env, else Key Vault `cosmos-ai-memory-db`, else
//     "ai_memory" (matches otchealth-cto/apps/otchealth-os-chat/memory.mjs's own
//     AGENT_MEMORY_COSMOS_DATABASE default).
//
// DEPLOY NOTE (unchanged from the original GAP-8 module, still applies): the job's managed identity
// must have read access to the cosmos-agent-state-endpoint / cosmos-agent-state-key Key Vault
// secrets. No NEW Key Vault grant is needed for GAP-9 (same account, same two secrets) -- only a real
// production decision on whether/how backup.mjs's caller wires up the ai_memory containers and the
// ring-segregated cache path, which is intentionally NOT done by this revision (see backup.mjs's own
// header; this module only closes the coverage gap in cosmos-export.mjs itself, per the assigned
// scope -- wiring the nightly job to actually call the new containers is a separate follow-up).

import { kvSecret } from "../kb-memory/azure-secret.mjs";
import { cosmosAuthHeader } from "../kb-memory/cosmos-auth.mjs";
import { encrypt } from "./crypto-envelope.mjs";

const COSMOS_API_VERSION = "2018-12-31";

// Hard allowlist: container name -> { db, pk, laneField }. Path-injection guard, same discipline as
// skills/decision-clock/cosmos-client.mjs's CONTAINERS Set -- container names are interpolated
// directly into REST URLs below, so only names in this allowlist are ever queryable through this
// module, regardless of what a caller passes in.
//   db:        which logical Cosmos database this container lives in ("agent-state" | "ai_memory"),
//              resolved to a real db name via cfg().dbNames (see DB RESOLUTION above).
//   pk:        the partition-key FIELD NAME (not a value) -- documentation only; queryContainerAll()
//              is a cross-partition scan and never needs this to run correctly (see the PK / LANE
//              FIELD PROVENANCE note above for which of these are confirmed vs. inferred).
//   laneField: the field name that carries this container's agent/owner lane discriminator, or null
//              if the container has no such field at all. Used by classifyLane() for ring
//              segregation (safety requirement (a) above). A row from a container with laneField:
//              null always fails closed to the `restricted` bucket.
export const COSMOS_CONTAINERS = Object.freeze({
  // ---- agent-state database ----
  // memory / events / decisions_pending: the original GAP-8 set, unchanged.
  memory: Object.freeze({ db: "agent-state", pk: "agent", laneField: "agent" }),
  events: Object.freeze({ db: "agent-state", pk: "task_id", laneField: "actor" }),
  decisions_pending: Object.freeze({ db: "agent-state", pk: "owner", laneField: "owner" }),
  // tasks: pk "board" confirmed via skills/doc-indexer/job/agent-state-janitor.mjs's own
  // CLEANUP_RULES/REPORT_ONLY registry ({ container: "tasks", pk: "board", ... }); lane field
  // "owner_agent" confirmed via this session's live field-shape check.
  tasks: Object.freeze({ db: "agent-state", pk: "board", laneField: "owner_agent" }),
  // signals: pk "owner" confirmed via skills/signal-radar/common.mjs (cosmosPutSignal partitions on
  // doc.owner; cosmosQuerySignals takes an explicit owner pk). Same field doubles as its lane.
  signals: Object.freeze({ db: "agent-state", pk: "owner", laneField: "owner" }),
  // cache: pk "cacheScope" confirmed via otchealth-mcp-server src/memory/hot-cache.ts ("partition key
  // /cacheScope") and src/tools/xero/client.ts ("the `cache` container partitions on /cacheScope").
  // No agent/owner lane field of any kind -- cacheScope is sometimes an agent lane ("agent:<lane>",
  // hot-cache.ts) and sometimes an unrelated org/token id (xero/client.ts's tokenDocId(org)), so it
  // cannot be trusted as a lane discriminator; every cache row fails closed to `restricted` by
  // construction (laneField: null) AND is additionally hard-gated behind encryption -- see safety
  // requirement (b) above.
  cache: Object.freeze({ db: "agent-state", pk: "cacheScope", laneField: null }),
  // oauthcodes: pk "id" confirmed via otchealth-mcp-server src/auth/oauth-tokens.ts (createDoc(...,
  // code, { id: code, ... }) -- the code IS the id IS the pk). No lane field -- single-use OAuth
  // codes are not agent-lane-scoped -- fails closed to `restricted`.
  oauthcodes: Object.freeze({ db: "agent-state", pk: "id", laneField: null }),
  // turns: pk "threadId" confirmed via skills/doc-indexer/job/agent-state-janitor.mjs's REPORT_ONLY
  // entry. No lane field -- fails closed to `restricted`.
  turns: Object.freeze({ db: "agent-state", pk: "threadId", laneField: null }),
  // ---- ai_memory database (Agent Memory Toolkit pilot) ----
  // memories / memories_turns: pk "thread_id" confirmed via otchealth-cto/apps/otchealth-os-chat/
  // memory.mjs's own comment ("No partitionKey option passed -- deliberately cross-partition, fans
  // out across all thread_id values for this user_id"), which only makes sense if thread_id is the
  // partition key. Rows carry user_id, not an agent/owner lane -- fails closed to `restricted` (this
  // toolkit's documents are end-user chat data, not agent-lane governance data, and this module has
  // no confirmed way to tell a "personal" user_id from any other, so it never guesses).
  memories: Object.freeze({ db: "ai_memory", pk: "thread_id", laneField: null }),
  memories_turns: Object.freeze({ db: "ai_memory", pk: "thread_id", laneField: null }),
  // memories_summaries: same schema family as memories/memories_turns (see the PK / LANE FIELD
  // PROVENANCE note above -- pk INFERRED, not independently confirmed).
  memories_summaries: Object.freeze({ db: "ai_memory", pk: "thread_id", laneField: null }),
  // leases / counter: small utility containers (no documented schema reachable this session -- see
  // the PK / LANE FIELD PROVENANCE note above). pk "id" is the conservative single-item-partition
  // default; queryContainerAll()'s cross-partition scan does not depend on this being exactly right.
  leases: Object.freeze({ db: "ai_memory", pk: "id", laneField: null }),
  counter: Object.freeze({ db: "ai_memory", pk: "id", laneField: null }),
});

// Personal-lane match, mirrors otchealth-mcp-server's PERSONAL_LEGAL_RING gating pattern (PR #124):
// "clo-personal", "clo_personal", "personal-legal", "personal", etc. all match; "personally" or
// "impersonal" do not (word-boundary-ish via the leading/trailing [-_] or string-edge anchors).
const PERSONAL_LANE_RE = /(^|[-_])personal($|[-_])/i;

// Fields in the `cache` container that hold live token VALUES and must never leave this module in
// plaintext (safety requirement (b) above).
const CACHE_SENSITIVE_FIELDS = Object.freeze(["accessToken", "refreshToken"]);

function assertContainer(name) {
  if (!Object.prototype.hasOwnProperty.call(COSMOS_CONTAINERS, name)) {
    throw new Error(`cosmos-export: unknown container "${name}" (allowed: ${Object.keys(COSMOS_CONTAINERS).join(", ")})`);
  }
}

/**
 * Pure: classify a single row's ring bucket for a given (allowlisted) container. Exported so it can
 * be unit-tested directly without any network/Cosmos involvement. Never throws on a malformed row
 * (an absent/non-string/empty lane value just falls into the fail-closed default) -- assertContainer
 * still guards the container-name path-injection case, callers should call it (or go through
 * dumpContainer/dumpContainerSegregated, which already do) before relying on this for an unknown
 * container name.
 */
export function classifyLane(container, row) {
  const entry = COSMOS_CONTAINERS[container];
  if (!entry) throw new Error(`cosmos-export: unknown container "${container}" (allowed: ${Object.keys(COSMOS_CONTAINERS).join(", ")})`);
  if (!entry.laneField) return "restricted"; // no lane discriminator on this container at all -> fail closed
  const laneValue = row && row[entry.laneField];
  if (typeof laneValue !== "string" || laneValue.length === 0) return "restricted"; // absent/malformed -> fail closed
  return PERSONAL_LANE_RE.test(laneValue) ? "restricted" : "general";
}

/**
 * Pure: encrypt the live token fields of one `cache` row using the fleet's AES-256-GCM envelope
 * format (crypto-envelope.mjs), leaving every other field (cacheScope, org, status, expiresAt,
 * tenantId, tenantName, ttl, ...) untouched and plaintext -- those are useful DR/forensic context and
 * are not secrets. Never returns a row with a plaintext accessToken/refreshToken. Throws if no
 * passphrase is supplied (see dumpContainerSegregated's own gate, which is the only caller).
 */
export function encryptCacheDoc(doc, passphrase) {
  if (!passphrase) {
    throw new Error("cosmos-export: encryptCacheDoc requires a passphrase -- refusing to return a `cache` row with plaintext token fields.");
  }
  const out = { ...doc };
  for (const field of CACHE_SENSITIVE_FIELDS) {
    if (out[field] !== undefined && out[field] !== null) {
      const envelope = encrypt(Buffer.from(String(out[field]), "utf8"), passphrase);
      out[field] = { _encrypted: true, envelope: envelope.toString("base64") };
    }
  }
  return out;
}

let _cfg; // memoized {endpoint, key, dbNames: {"agent-state": ..., "ai_memory": ...}} | null
async function cfg() {
  if (_cfg !== undefined) return _cfg;
  const endpoint = process.env.COSMOS_ENDPOINT || (await kvSecret("cosmos-agent-state-endpoint"));
  const key = process.env.COSMOS_KEY || (await kvSecret("cosmos-agent-state-key"));
  if (!endpoint || !key) {
    _cfg = null;
    return _cfg;
  }
  // Legacy back-compat: COSMOS_DB (no _AGENT_STATE suffix) has always meant the agent-state db name
  // for every existing caller/test of this file -- keep honoring it so nothing that already sets
  // COSMOS_DB breaks. COSMOS_DB_AGENT_STATE is the new, explicit name; it wins if both are set.
  const agentStateDb = process.env.COSMOS_DB_AGENT_STATE || process.env.COSMOS_DB || (await kvSecret("cosmos-agent-state-db")) || "agent-state";
  const aiMemoryDb = process.env.COSMOS_DB_AI_MEMORY || (await kvSecret("cosmos-ai-memory-db")) || "ai_memory";
  _cfg = {
    endpoint: endpoint.replace(/\/+$/, ""),
    key,
    dbNames: { "agent-state": agentStateDb, ai_memory: aiMemoryDb },
  };
  return _cfg;
}

/** Resolve the real database name for an allowlisted container. */
function dbNameFor(c, container) {
  const entry = COSMOS_CONTAINERS[container];
  return c.dbNames[entry.db];
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
  const link = `dbs/${dbNameFor(c, container)}/colls/${container}`;
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
  const link = `dbs/${dbNameFor(c, container)}/colls/${container}`;
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

/**
 * Convenience: full unbounded dump of one allowlisted container ("SELECT * FROM c"), as a flat,
 * ring-UNAWARE array of raw documents -- unchanged contract from the original GAP-8 module, so every
 * existing caller (backup.mjs's exportCosmosContainer() for memory/events/decisions_pending) and
 * every existing test of this function keeps working exactly as before.
 *
 * HARD REFUSAL for "cache" (safety requirement (b) above): that container can carry live OAuth
 * accessToken/refreshToken values, and this function has no ring-awareness or encryption of its own,
 * so returning its rows here would be a plaintext-secret leak with no gate. There is deliberately NO
 * flag/option on this function to override that refusal -- the only way to read `cache` through this
 * module is dumpContainerSegregated("cache", { passphrase }), which encrypts the sensitive fields
 * before any row is returned.
 *
 * NOTE for any NEW caller (not just cache): every container in the registry above that carries a
 * `laneField` (memory/events/decisions_pending/tasks/signals) can contain a personal-lane row (e.g.
 * agent: "clo-personal") that must not be co-mingled with general company data in a single export
 * artifact -- see dumpContainerSegregated() and safety requirement (a) above. This function does not
 * enforce that (it is kept exactly as it always worked, for backward compatibility with the existing
 * 3-container GAP-8 callers), so a NEW caller building a DR/export artifact for any container should
 * use dumpContainerSegregated() instead of this one.
 */
export async function dumpContainer(container, opts = {}) {
  if (container === "cache") {
    throw new Error(
      'cosmos-export: dumpContainer("cache") is disabled -- the cache container holds live OAuth/Xero ' +
      "accessToken/refreshToken values, and this function has no encryption of its own. Use " +
      'dumpContainerSegregated("cache", { passphrase }) instead, which encrypts those fields before ' +
      "returning them. This is a deliberate hard gate, not an oversight.",
    );
  }
  return queryContainerAll(container, "SELECT * FROM c", [], opts);
}

/**
 * The ring-safe export path (safety requirements (a) and (b) above). Full unbounded dump of one
 * allowlisted container, split into two buckets:
 *   general:    rows whose lane (per classifyLane()) is a known, non-personal company/finance lane.
 *   restricted: everything else -- personal-lane rows, rows with an absent/unrecognized lane value,
 *               and every row from a container with no lane field at all (cache/oauthcodes/turns/
 *               every ai_memory container) -- fail-closed by construction.
 * Callers MUST write these to separate outputs (e.g. separate blobs) -- returning them pre-split
 * here is what makes "never co-mingled" enforceable at the call site rather than merely documented.
 *
 * For "cache" specifically, `opts.passphrase` is REQUIRED (throws immediately, before any network
 * call, if absent) and every row's accessToken/refreshToken is encrypted (encryptCacheDoc()) before
 * being placed in its bucket -- cache rows have no lane field so they always land in `restricted`
 * anyway, but the encryption is a second, independent gate on top of that (defense in depth: a future
 * change to classifyLane()'s bucketing logic must not be able to accidentally leak a plaintext token
 * into the `general` bucket).
 */
export async function dumpContainerSegregated(container, opts = {}) {
  assertContainer(container);
  if (container === "cache" && !opts.passphrase) {
    throw new Error(
      'cosmos-export: dumpContainerSegregated("cache", ...) requires opts.passphrase (the ' +
      'secrets-dr-passphrase Key Vault secret value) -- refusing to export live token fields in ' +
      "plaintext. Resolve it via kvSecret(\"secrets-dr-passphrase\") and pass it in.",
    );
  }
  const rows = await queryContainerAll(container, "SELECT * FROM c", [], opts);
  const general = [];
  const restricted = [];
  for (const row of rows) {
    const finalRow = container === "cache" ? encryptCacheDoc(row, opts.passphrase) : row;
    (classifyLane(container, row) === "restricted" ? restricted : general).push(finalRow);
  }
  return { general, restricted };
}
