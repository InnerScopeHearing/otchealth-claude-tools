// mock-ledger.mjs -- a hermetic, in-process stand-in for the gateway's REAL work-ledger tools
// (task_create / task_claim / task_update / task_heartbeat / task_get), used ONLY by this skill's
// tests (never imported by mutex.mjs, gateway-ledger.mjs, or claim.mjs). Not a simplification that
// hand-waves the hard part: it reimplements the actual mechanism otchealth-mcp-server's
// src/agentstate/ledger.ts uses to make task_claim genuinely atomic -- a single-document store with
// ETag-based optimistic concurrency (a synchronous check-and-set inside `_write()`, exactly
// mirroring what Cosmos's If-Match PUT guarantees atomically server-side), wrapped in async
// "network hop" delays on every call so two "simultaneous" claim() calls genuinely interleave their
// read/decide/write steps in an unpredictable order -- the same race shape a real two-agent claim
// race over HTTP has.
//
// leaseMs / maxClaimAttempts / jitterMs are constructor knobs purely so tests do not have to wait 45
// real minutes or fire hundreds of trials to hit a race window (the real gateway hardcodes
// LEASE_MINUTES=45 and MAX_CLAIM_ATTEMPTS=3 -- see mutex.mjs's SERVER_LEASE_MINUTES comment and
// SKILL.md's gap analysis). The CAS / lease / reclaim / dead-letter DECISION logic below deliberately
// mirrors ledger.ts's claimTask / heartbeatTask / updateTask step-for-step, just against this
// in-memory store instead of a Cosmos REST call.
import crypto from 'node:crypto';

/** Deterministic id from an idempotency key -- byte-for-byte the same djb2-ish hash
 *  otchealth-mcp-server's ledger.ts idFromIdempotencyKey() uses, so a mock-ledger id is shaped
 *  exactly like a real one (t_idem_<8 hex>) even though the two implementations are independent. */
function idFromIdempotencyKey(key) {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (Math.imul(31, h) + key.charCodeAt(i)) | 0;
  const hex = (h >>> 0).toString(16).padStart(8, '0');
  return `t_idem_${hex}`;
}

export class MockLedger {
  constructor({ leaseMs = 45 * 60_000, maxClaimAttempts = 3, jitterMs = 8 } = {}) {
    this.leaseMs = leaseMs;
    this.maxClaimAttempts = maxClaimAttempts;
    this.jitterMs = jitterMs;
    this.docs = new Map(); // id -> { doc, etag }
    this.calls = []; // [name, input] audit trail, for assertions that want it
  }

  async _delay() {
    if (this.jitterMs <= 0) return;
    await new Promise((r) => setTimeout(r, Math.random() * this.jitterMs));
  }

  _read(id) {
    const hit = this.docs.get(id);
    return hit ? { doc: { ...hit.doc }, etag: hit.etag } : null;
  }

  /** Synchronous compare-and-swap: the ONE operation with no async gap between checking the etag and
   *  committing the new doc -- exactly what Cosmos's If-Match PUT guarantees atomically server-side
   *  in production (see otchealth-mcp-server src/agentstate/cosmos.ts replaceDoc). */
  _write(id, doc, expectedEtag) {
    const hit = this.docs.get(id);
    const currentEtag = hit ? hit.etag : null;
    if (expectedEtag !== undefined && currentEtag !== expectedEtag) return { ok: false, status: 412 };
    const etag = crypto.randomBytes(6).toString('hex');
    this.docs.set(id, { doc: { ...doc }, etag });
    return { ok: true, status: hit ? 200 : 201, etag };
  }

  async create(input) {
    this.calls.push(['create', input]);
    const board = (input.board || 'mutex').trim().toLowerCase();
    const id = idFromIdempotencyKey(`${board}:${input.idempotency_key}`);
    await this._delay(); // simulated read hop
    const existing = this._read(id);
    if (existing) return { created: false, deduped: true, task: existing.doc };
    const now = new Date().toISOString();
    const task = {
      id,
      board,
      title: input.title,
      description: input.description || '',
      owner_agent: input.owner_agent,
      status: 'open',
      priority: input.priority || 'normal',
      tags: input.tags || [],
      artifact_uri: null,
      created_by: input.created_by,
      created_at: now,
      updated_at: now,
      claim_ts: null,
      lease_until: null,
      lease_version: 0,
      idempotency_key: input.idempotency_key ?? null,
      done_ts: null,
      notes: [],
      attempt_count: 0,
    };
    await this._delay(); // simulated write hop
    // Idempotent-create race: if a concurrent create() beat us between our read and our write,
    // return ITS doc (deduped) instead of clobbering it -- mirrors ledger.ts createTask's own
    // conflict-then-reread path.
    const race = this._read(id);
    if (race) return { created: false, deduped: true, task: race.doc };
    this._write(id, task, undefined);
    return { created: true, deduped: false, task };
  }

  async claim(input) {
    this.calls.push(['claim', input]);
    const { task_id: id, agent } = input;
    for (let attempt = 0; attempt < 2; attempt++) {
      await this._delay(); // simulated read hop
      const hit = this._read(id);
      if (!hit) return { claimed: false, reason: 'not found' };
      const task = hit.doc;
      const nowMs = Date.now();

      if (task.status === 'done' || task.status === 'cancelled' || task.status === 'dead_letter') {
        return { claimed: false, reason: `task already ${task.status}` };
      }

      const leasedToOther =
        task.status === 'claimed' &&
        task.owner_agent !== agent &&
        task.lease_until &&
        Date.parse(task.lease_until) > nowMs;
      if (leasedToOther) {
        return { claimed: false, conflict: true, reason: `leased to ${task.owner_agent} until ${task.lease_until}` };
      }

      const currentAttemptCount = task.attempt_count || 0;
      if (currentAttemptCount >= this.maxClaimAttempts) {
        const next = { ...task, status: 'dead_letter', updated_at: new Date(nowMs).toISOString() };
        await this._delay(); // simulated write hop
        const res = this._write(id, next, hit.etag);
        if (!res.ok) continue; // lost the race, retry against the fresh doc
        return {
          claimed: false,
          dead_lettered: true,
          task: next,
          reason: `task exceeded ${this.maxClaimAttempts} claim attempts and has been dead-lettered`,
        };
      }

      const isReclaim = task.status === 'claimed' && task.claim_ts !== null;
      const next = { ...task };
      if (isReclaim) next.attempt_count = (task.attempt_count || 0) + 1;
      next.owner_agent = agent;
      next.status = 'claimed';
      next.claim_ts = new Date(nowMs).toISOString();
      next.lease_until = new Date(nowMs + this.leaseMs).toISOString();
      next.lease_version = (task.lease_version || 0) + 1;
      next.updated_at = new Date(nowMs).toISOString();

      await this._delay(); // simulated write hop
      const res = this._write(id, next, hit.etag);
      if (!res.ok) continue; // 412: lost the race, re-read and retry (mirrors claimTask)
      return { claimed: true, task: next };
    }
    return { claimed: false, conflict: true, reason: 'concurrent claim, please retry' };
  }

  async update(input) {
    this.calls.push(['update', input]);
    await this._delay();
    const hit = this._read(input.task_id);
    if (!hit) return { updated: false, reason: 'not found' };
    const task = hit.doc;
    if (input.expected_lease_version !== undefined && task.lease_version !== input.expected_lease_version) {
      return { updated: false, fenced: true, reason: `stale lease_version (task is now at ${task.lease_version})` };
    }
    const next = { ...task };
    if (input.status) next.status = input.status;
    if (input.owner_agent) next.owner_agent = input.owner_agent;
    if (input.note) next.notes = [...(next.notes || []), `${input.actor}: ${input.note}`];
    next.updated_at = new Date().toISOString();
    await this._delay();
    const res = this._write(input.task_id, next, hit.etag);
    if (!res.ok) return { updated: false, reason: 'conflict, re-read and retry' };
    return { updated: true, task: next };
  }

  async heartbeat(input) {
    this.calls.push(['heartbeat', input]);
    await this._delay();
    const hit = this._read(input.task_id);
    if (!hit) return { extended: false, reason: 'not found' };
    const task = hit.doc;
    if (task.status !== 'claimed' && task.status !== 'in_progress') {
      return { extended: false, reason: `cannot heartbeat a task in status "${task.status}"` };
    }
    if (task.owner_agent !== input.agent) {
      return { extended: false, fenced: true, reason: `not the current lease holder (held by ${task.owner_agent})` };
    }
    if (input.expected_lease_version !== undefined && task.lease_version !== input.expected_lease_version) {
      return { extended: false, fenced: true, reason: 'stale lease_version' };
    }
    const next = { ...task, lease_until: new Date(Date.now() + this.leaseMs).toISOString(), updated_at: new Date().toISOString() };
    await this._delay();
    const res = this._write(input.task_id, next, hit.etag);
    if (!res.ok) return { extended: false, reason: 'conflict, re-read and retry' };
    return { extended: true, task: next };
  }

  async get(input) {
    this.calls.push(['get', input]);
    await this._delay();
    const hit = this._read(input.task_id);
    if (!hit) return { found: false, task: null, events: [] };
    return { found: true, task: hit.doc, events: [] };
  }
}

export default { MockLedger };
