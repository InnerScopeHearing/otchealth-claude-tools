// mutex.mjs -- the pure, transport-agnostic claim/release/heartbeat/status orchestration for a
// TYPED, cross-agent exclusive claim (mutex) on a named resource, built ENTIRELY on top of the
// gateway's EXISTING work-ledger tools (task_create / task_claim / task_update / task_heartbeat /
// task_get -- see otchealth-mcp-server src/agentstate/ledger.ts). This module never talks to Cosmos
// or the gateway HTTP API directly -- it takes a `ledger` object (the LedgerClient shape documented
// below) and calls its create/claim/update/heartbeat/get methods. gateway-ledger.mjs supplies the
// real, network-backed implementation; tests inject a hermetic in-memory one (tests/mock-ledger.mjs).
//
// THE GAP THIS CLOSES (full writeup in SKILL.md "Gap analysis"): the fleet's cto-bridge/
// ACTIVE-CTO-THREAD claim is a PROSE convention, a line of markdown an agent reads, reasons about,
// and edits by hand. Nothing enforces it except an agent choosing to follow the written protocol, so
// nothing stops two agents from both believing they hold it. The gateway's task ledger already gives
// a single task a real, server-side atomic compare-and-swap on claim (Cosmos ETag optimistic
// concurrency -- ledger.ts's claimTask reads the doc, decides, PUTs with If-Match, and a genuinely
// simultaneous competing write gets Cosmos's own 412 and retries once against the fresh doc). What
// the exposed tools do NOT already give a caller is a REUSABLE resource identity that can be claimed,
// released, and re-claimed indefinitely under one stable name ("cto-bridge:iheartest") the way a
// mutex needs -- task_* is shaped around one-shot WORK ITEMS (create once, claim, eventually
// complete/cancel, terminal). This module is the missing layer: a stable resource identity (one
// work-ledger task per mutex resource, board="mutex" by default, get-or-created via an
// idempotency_key equal to the resource name) plus a clean release path (task_update back to status
// "open"), so the SAME real atomic claim primitive the ledger already has can be used as a genuine
// mutex, without duplicating any Cosmos access or reimplementing the CAS itself.
//
// LedgerClient shape (what gateway-ledger.mjs and tests/mock-ledger.mjs both implement):
//   create({title, description, owner_agent, created_by, board, idempotency_key, tags, priority})
//     -> { created, deduped, task }                      (task_create)
//   claim({task_id, agent, board})
//     -> { claimed, task, conflict?, dead_lettered?, reason? }   (task_claim)
//   update({task_id, actor, status, note, board, expected_lease_version, owner_agent})
//     -> { updated, task, fenced?, reason? }               (task_update)
//   heartbeat({task_id, agent, board, expected_lease_version})
//     -> { extended, task, fenced?, reason? }               (task_heartbeat)
//   get({task_id, board})
//     -> { found, task, events }                            (task_get)

const MUTEX_BOARD_DEFAULT = 'mutex';
const TITLE_PREFIX = 'mutex: ';

/** The lease window the gateway's task_claim tool grants TODAY. This is NOT a knob this module (or
 *  any caller going through the gateway) can turn -- ledger.ts hardcodes LEASE_MINUTES = 45 and the
 *  task_claim tool input has no ttl/duration field at all (see SKILL.md's gap analysis, gap #3).
 *  Exported purely for CLI help text / human-readable expiry math; it is never sent on the wire. */
export const SERVER_LEASE_MINUTES = 45;

export function mutexTitle(resource) {
  return `${TITLE_PREFIX}${resource}`;
}

/** True when a task doc's title identifies it as the mutex resource task for `resource`. */
export function isMutexTaskFor(task, resource) {
  return Boolean(task) && task.title === mutexTitle(resource);
}

/**
 * Acquire (claim) the named mutex resource for `agent`. Two gateway calls, each independently
 * atomic server-side:
 *
 *   1. ledger.create({idempotency_key: resource, board}) -- get-or-create the resource's stable task
 *      identity. Idempotent: a resource claimed a thousand times over its life always maps to the
 *      SAME task id (ledger.ts's idFromIdempotencyKey is a deterministic hash of `${board}:${key}`),
 *      and a concurrent double-create collapses to one winner + one deduped reader (createTask's own
 *      conflict-then-reread path) -- never two resource tasks for one name.
 *
 *   2. ledger.claim({task_id}) -- the actual lock acquisition. This is the real atomic operation: the
 *      gateway does a single read of the Cosmos doc, decides, and PUTs with If-Match; Cosmos itself
 *      resolves a genuine simultaneous write race by rejecting the loser's PUT with 412, and
 *      claimTask retries once against the fresh doc before giving up. So even though this module
 *      issues create-then-claim as two separate HTTP round trips, the race window that actually
 *      matters (two agents both trying to WIN the claim) closes entirely inside that single claim()
 *      call -- there is no client-side "read, decide, then write" gap in the acquisition itself. See
 *      tests/task-claim-race.test.mjs for a concurrency test that exercises exactly this.
 */
export async function acquire(ledger, { resource, agent, board = MUTEX_BOARD_DEFAULT, createdBy } = {}) {
  if (!resource) throw new Error('acquire: resource is required');
  if (!agent) throw new Error('acquire: agent is required');
  const created = await ledger.create({
    title: mutexTitle(resource),
    description: `Cross-agent exclusive claim on "${resource}" (skills/task-claim mutex).`,
    owner_agent: agent,
    created_by: createdBy || agent,
    board,
    idempotency_key: resource,
    tags: ['mutex'],
  });
  const taskId = created?.task?.id;
  if (!taskId) {
    return { acquired: false, resource, reason: 'could not resolve/create the resource task', raw: created };
  }
  const claimed = await ledger.claim({ task_id: taskId, agent, board });

  // A14-DEAD-LETTER (see SKILL.md gap #2): this resource has been abandoned-without-release enough
  // times that the ledger has retired it PERMANENTLY -- no exposed gateway tool can reset
  // attempt_count, so this is a genuine dead end for THIS resource name, not a transient conflict.
  //
  // NORMALIZATION NOTE (a real inconsistency in the underlying tool, documented in SKILL.md gap #2):
  // task_claim only sets dead_lettered:true on the CALL that performs the open->dead_letter
  // transition. A LATER call against an already-dead-lettered task instead hits ledger.ts's
  // terminal-status early return (`task.status === 'dead_letter' -> return { reason: 'task already
  // dead_letter' }`, no `task` field, no `dead_lettered` field at all), so the tool's own response
  // shape for "this is dead" differs depending on whether THIS call caused it or merely found it.
  // Detect both shapes here so every caller of this module gets one consistent, honest signal.
  const alreadyDeadLettered = /already dead_letter/.test(claimed?.reason || '');
  if (claimed?.dead_lettered || alreadyDeadLettered) {
    return {
      acquired: false,
      dead_lettered: true,
      resource,
      task_id: taskId,
      reason: claimed.reason,
      suggestion:
        `this mutex resource has been claimed-and-abandoned too many times and the gateway's work-` +
        `ledger has retired it permanently (dead_letter is terminal; no exposed tool resets ` +
        `attempt_count). Recourse: acquire a rotated resource name instead (e.g. "${resource}#2") ` +
        `and record the rotation somewhere durable (the calling protocol's own status doc).`,
    };
  }
  if (claimed?.claimed === true) {
    return {
      acquired: true,
      resource,
      task_id: taskId,
      lease_version: claimed.task.lease_version,
      lease_until: claimed.task.lease_until,
      task: claimed.task,
    };
  }
  // GAP (see SKILL.md gap #4): task_claim's "leased to another agent" conflict response carries NO
  // structured task/owner_agent field at all -- ledger.ts's leasedToOther branch returns only
  // `{ conflict: true, reason: "leased to <agent> until <iso>" }`, so the holder's identity is only
  // present as free-form prose inside `reason`. Rather than regex-parsing that string, ask the
  // ledger directly (one extra, read-only task_get call) so callers of this module get a real,
  // structured held_by/lease_until instead of having to parse another tool's error message.
  let heldBy = claimed?.task?.owner_agent ?? null;
  let leaseUntil = claimed?.task?.lease_until ?? null;
  if (heldBy === null) {
    try {
      const current = await ledger.get({ task_id: taskId, board });
      if (current?.found && current.task) {
        heldBy = current.task.owner_agent ?? null;
        leaseUntil = current.task.lease_until ?? null;
      }
    } catch {
      /* best-effort enrichment only; fall through with heldBy still null rather than fail acquire() */
    }
  }
  return {
    acquired: false,
    resource,
    task_id: taskId,
    conflict: Boolean(claimed?.conflict),
    reason: claimed?.reason || 'claim refused',
    held_by: heldBy,
    lease_until: leaseUntil,
  };
}

/**
 * Release a held claim, returning the resource to status "open" so the NEXT acquire() is a clean
 * first claim, not a reclaim (see SKILL.md gap #2 on why that distinction matters for attempt_count /
 * dead_letter -- a resource that is always released cleanly never touches that counter at all).
 *
 * `leaseVersion` is REQUIRED here (unlike the raw task_update tool, where expected_lease_version is
 * optional). See SKILL.md gap #1: task_update's ownership fencing is opt-in server-side -- a caller
 * that omits expected_lease_version can flip ANY task's status, including one it does not hold. This
 * module refuses to construct an unfenced release call at all, as a client-side mitigation until the
 * gateway grows a dedicated task_release tool that enforces ownership unconditionally.
 */
export async function release(ledger, { taskId, agent, board = MUTEX_BOARD_DEFAULT, leaseVersion, note } = {}) {
  if (!taskId) throw new Error('release: taskId is required');
  if (!agent) throw new Error('release: agent is required');
  if (leaseVersion === undefined || leaseVersion === null) {
    throw new Error(
      'release: leaseVersion is required (pass the lease_version acquire() returned) -- releasing ' +
        'without it is not fenced server-side, see SKILL.md gap #1',
    );
  }
  const res = await ledger.update({
    task_id: taskId,
    actor: agent,
    status: 'open',
    note: note || `released by ${agent}`,
    board,
    expected_lease_version: leaseVersion,
  });
  if (res?.updated && res?.task) return { released: true, task: res.task };
  return { released: false, fenced: Boolean(res?.fenced), reason: res?.reason || 'release refused' };
}

/**
 * Extend a held claim's lease before it expires. This is the standing pattern for legitimate
 * long-running work: heartbeat well inside the 45-minute lease window (every ~15-20 min) so it never
 * lapses, and the resource never enters the reclaim / attempt_count path at all. Only a holder that
 * DIES without releasing or heartbeating ever produces a reclaim.
 */
export async function heartbeat(ledger, { taskId, agent, board = MUTEX_BOARD_DEFAULT, leaseVersion } = {}) {
  if (!taskId) throw new Error('heartbeat: taskId is required');
  if (!agent) throw new Error('heartbeat: agent is required');
  const res = await ledger.heartbeat({ task_id: taskId, agent, board, expected_lease_version: leaseVersion });
  if (res?.extended && res?.task) return { extended: true, task: res.task, lease_until: res.task.lease_until };
  return { extended: false, fenced: Boolean(res?.fenced), reason: res?.reason || 'heartbeat refused' };
}

/**
 * Read-only-in-spirit status check: get-or-create the resource's task identity (ledger.create() is
 * idempotent -- deduped:true, no new doc, when the resource already exists) and report its current
 * claim state. If the resource has NEVER been claimed before, this call itself is what brings its
 * ledger doc into existence in status "open" -- a faithful, not a fabricated, answer to "has anyone
 * ever locked this," and consistent with how acquire() resolves the exact same identity.
 */
export async function status(ledger, { resource, board = MUTEX_BOARD_DEFAULT, createdBy = 'task-claim-status' } = {}) {
  if (!resource) throw new Error('status: resource is required');
  const created = await ledger.create({
    title: mutexTitle(resource),
    description: `Cross-agent exclusive claim on "${resource}" (skills/task-claim mutex).`,
    owner_agent: createdBy,
    created_by: createdBy,
    board,
    idempotency_key: resource,
    tags: ['mutex'],
  });
  const task = created?.task;
  if (!task) return { resource, found: false };
  const now = Date.now();
  const heldNow = task.status === 'claimed' && Boolean(task.lease_until) && Date.parse(task.lease_until) > now;
  return {
    resource,
    found: true,
    task_id: task.id,
    status: task.status,
    held: heldNow,
    held_by: heldNow ? task.owner_agent : null,
    lease_until: task.lease_until,
    lease_version: task.lease_version,
    attempt_count: task.attempt_count,
    dead_lettered: task.status === 'dead_letter',
  };
}

export default { acquire, release, heartbeat, status, mutexTitle, isMutexTaskFor, SERVER_LEASE_MINUTES };
