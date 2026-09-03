// cosmos-client.mjs -- agent-state client for decision-clock's `decisions_pending` container.
//
// REMOVAL NOTICE (2026-09-03): this file used to be a dependency-free Azure Cosmos DB for NoSQL REST
// client (master-key HMAC auth, mirroring otchealth-mcp-server's src/agentstate/cosmos.ts) against the
// fleet's Cosmos account cosmos-otc-agentstate-55c84 (db agent-state). That account is permanently
// unreachable: Azure subscription 55c84f6b was deleted 2026-08-13, and the
// cosmos-agent-state-endpoint secret was removed in the 2026-08-28 SSM cleanup (FND-20260827-acce; its
// cosmos-agent-state-key/-db companions were left behind, useless without the endpoint). The raw
// Cosmos REST implementation (master-key HMAC headers, GCP-Secret-Manager credential resolution,
// partition-key-range fan-out) has been REMOVED here rather than kept behind a STATE_BACKEND=cosmos
// switch: this file had no such switch before today (grep confirmed zero occurrences of
// STATE_BACKEND/pg-state/postgres prior to this change), there is no live Cosmos endpoint left to fall
// back to, and a default-to-Cosmos branch would only ever reproduce the exact silent-success bug this
// change exists to close -- see skills/signal-radar/common.mjs's identical history and radar.mjs's
// paired fail-loud fix for the live incident this was caught from (a scheduled job running every 30
// minutes, exiting 0, and persisting nothing since at least the 2026-08-28 cleanup).
//
// This file now delegates its whole exported surface to ../kb-memory/pg-state.mjs, the fleet's RDS
// Postgres agent-state backend (added 2026-08-16 in PR #437, never wired into either intended caller
// until now). Every exported function NAME and CALL SHAPE is unchanged on purpose, so existing
// importers need no changes at all: decision.mjs (open/ack/close/list/sweep/metrics),
// digest-section.mjs (buildDigestSectionFromCosmos), and skills/legal-deadline-pager/pager.mjs (its
// company-namespace sync into this same `decisions_pending` container).
//
// CONFIG: resolves via pg-state.mjs -> kvSecret() (AWS SSM /otchealth/* under SECRET_BACKEND=ssm, the
// fleet default) under aws-pg-host / aws-pg-master-user / aws-pg-master-password / aws-pg-port.
// isConfigured() reflects only whether those VALUES resolved; it does not prove the database is
// reachable. A value present but a dead host or bad credential still fails on the first real query,
// which throws -- decision.mjs's sweep() (the one entrypoint the scheduled job actually calls) treats
// both "unconfigured" and "configured but unreachable" as a hard, non-zero-exit failure, never a
// silent no-op. See decision.mjs's runSweep() for that fail-loud logic.
import * as pgState from "../kb-memory/pg-state.mjs";

// Path-injection guard. Narrower than pg-state.mjs's own two-container allowlist on purpose:
// decision-clock has only ever touched `decisions_pending` (signal-radar's `signals` container is a
// separate module, skills/signal-radar/common.mjs, with its own equivalent guard).
const CONTAINERS = new Set(["decisions_pending"]);
function assertColl(coll) {
  if (!CONTAINERS.has(coll)) throw new Error(`unknown container "${coll}" (allowed: ${[...CONTAINERS].join(", ")})`);
}

// Test-only backend swap, mirroring pg-state.mjs's own _resetForTests() naming convention. `_backend`
// defaults to the real pg-state module; a test can substitute a fake object implementing the same
// six-function shape (isConfigured/createDoc/readDoc/replaceDoc/upsertDoc/queryDocs) without touching
// the real module or a real Postgres connection. This exists because node:test's mock.module() needs
// --experimental-test-module-mocks, which run-tests.sh's `node --test` invocation does not pass (and
// should not gain just for this file) -- confirmed empirically, not assumed. Never invoked from any
// real call path; a no-op unless a test explicitly calls it.
let _backend = pgState;
export function _setBackendForTests(fake) { _backend = fake; }
export function _resetBackendForTests() { _backend = pgState; }

export async function isConfigured() {
  return _backend.isConfigured();
}

export async function createDoc(coll, pkValue, doc) {
  assertColl(coll);
  return _backend.createDoc(coll, pkValue, doc);
}

export async function upsertDoc(coll, pkValue, doc) {
  assertColl(coll);
  return _backend.upsertDoc(coll, pkValue, doc);
}

export async function readDoc(coll, pkValue, id) {
  assertColl(coll);
  return _backend.readDoc(coll, pkValue, id);
}

export async function replaceDoc(coll, pkValue, id, doc, ifMatch) {
  assertColl(coll);
  return _backend.replaceDoc(coll, pkValue, id, doc, ifMatch);
}

/** Run a SQL query (Cosmos-SQL syntax; pg-state.mjs translates it -- see its own pg-sql-translate.mjs
 *  for the supported grammar). Matches the original Cosmos client's shape exactly, including the
 *  cross-partition case (opts.pk omitted): pg-state.mjs's Postgres table has no partition concept to
 *  fan out over, so an unscoped query is simply a plain scan, which is the correct Postgres analog of
 *  "search every partition and merge." */
export async function queryDocs(coll, query, parameters = [], opts = {}) {
  assertColl(coll);
  return _backend.queryDocs(coll, query, parameters, opts);
}

export function newId(prefix) {
  return _backend.newId(prefix);
}
