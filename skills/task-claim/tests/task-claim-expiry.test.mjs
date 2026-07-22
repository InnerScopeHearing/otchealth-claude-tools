// task-claim-expiry.test.mjs -- proves a stale (abandoned) claim can be reclaimed once its lease TTL
// passes, proves a well-behaved holder's heartbeat() legitimately prevents that reclaim, and proves
// the ledger's attempt_count / dead_letter policy (a real gap this skill documents rather than hides
// -- see SKILL.md gap #2): a mutex resource that is abandoned-without-release too many times over its
// life gets PERMANENTLY retired by the gateway, with no exposed tool to revive it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as mutex from '../mutex.mjs';
import { MockLedger } from './mock-ledger.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('expiry: an abandoned claim (holder never releases) cannot be reclaimed before its lease expires', async () => {
  const ledger = new MockLedger({ leaseMs: 150, jitterMs: 0 });
  const first = await mutex.acquire(ledger, { resource: 'expiry-1', agent: 'cto' });
  assert.equal(first.acquired, true);

  // Immediately, well before the 150ms lease expires: a second agent's attempt must be refused.
  const tooSoon = await mutex.acquire(ledger, { resource: 'expiry-1', agent: 'developer' });
  assert.equal(tooSoon.acquired, false);
  assert.equal(tooSoon.conflict, true);
  assert.equal(tooSoon.held_by, 'cto');
});

test('expiry: after the lease TTL passes, a DIFFERENT agent can reclaim the abandoned resource', async () => {
  const ledger = new MockLedger({ leaseMs: 100, jitterMs: 0 });
  const first = await mutex.acquire(ledger, { resource: 'expiry-2', agent: 'cto' });
  assert.equal(first.acquired, true);

  await sleep(200); // past the 100ms lease, with headroom

  const reclaimed = await mutex.acquire(ledger, { resource: 'expiry-2', agent: 'developer' });
  assert.equal(reclaimed.acquired, true, 'a lease-expired claim must become reclaimable by another agent');
  assert.equal(reclaimed.task.owner_agent, 'developer');
  // This is a RECLAIM (the task was still status "claimed" with a stale lease, not cleanly released
  // back to "open"), so it burns one of the resource's lifetime reclaim-attempt budget -- see gap #2.
  assert.equal(reclaimed.task.attempt_count, 1);

  const st = await mutex.status(ledger, { resource: 'expiry-2' });
  assert.equal(st.held_by, 'developer');
});

test('expiry: heartbeat() before the lease lapses legitimately BLOCKS a reclaim that would otherwise have succeeded by now', async () => {
  const ledger = new MockLedger({ leaseMs: 150, jitterMs: 0 });
  const first = await mutex.acquire(ledger, { resource: 'expiry-3', agent: 'cto' });
  assert.equal(first.acquired, true);

  await sleep(80); // well inside the original 150ms window
  const beat = await mutex.heartbeat(ledger, { taskId: first.task_id, agent: 'cto', leaseVersion: first.lease_version });
  assert.equal(beat.extended, true);

  await sleep(120); // 80 + 120 = 200ms since the original claim -- past the ORIGINAL lease, but the
  // heartbeat reset the clock at t=80ms, so only 120ms have elapsed since the extension: still held.
  const attempt = await mutex.acquire(ledger, { resource: 'expiry-3', agent: 'developer' });
  assert.equal(attempt.acquired, false, 'a heartbeat-extended lease must not be reclaimable while still within its extended window');
  assert.equal(attempt.held_by, 'cto');

  // Confirm the resource never touched the reclaim path (attempt_count still 0) -- the whole point of
  // heartbeating a legitimately long-running hold.
  const st = await mutex.status(ledger, { resource: 'expiry-3' });
  assert.equal(st.attempt_count, 0);
});

test('expiry + dead-letter: a resource abandoned-and-reclaimed past MAX_CLAIM_ATTEMPTS is PERMANENTLY retired -- acquire() surfaces this clearly with a rotate-resource suggestion, never a false "acquired"', async () => {
  // maxClaimAttempts:2 (smaller than production's 3) purely to keep this test fast; the DECISION
  // logic exercised is identical to ledger.ts's real MAX_CLAIM_ATTEMPTS policy.
  const ledger = new MockLedger({ leaseMs: 40, maxClaimAttempts: 2, jitterMs: 0 });
  const resource = 'expiry-4';

  // Cycle: claim, never release, let the lease lapse, reclaim -- repeated until the attempt budget
  // is exhausted. Each reclaim (not the first claim) increments attempt_count by design.
  let holder = await mutex.acquire(ledger, { resource, agent: 'agent-0' });
  assert.equal(holder.acquired, true);
  for (let i = 1; i <= 2; i++) {
    await sleep(80); // past the 40ms lease each time
    holder = await mutex.acquire(ledger, { resource, agent: `agent-${i}` });
    assert.equal(holder.acquired, true, `reclaim #${i} should still succeed (attempt_count below the cap during this reclaim)`);
  }
  // attempt_count is now at maxClaimAttempts (2). The NEXT claim attempt -- even after a further
  // legitimate lease expiry -- must be refused and the resource dead-lettered, not silently granted.
  await sleep(80);
  const final = await mutex.acquire(ledger, { resource, agent: 'agent-3' });
  assert.equal(final.acquired, false, 'must NOT silently grant a claim on an exhausted resource');
  assert.equal(final.dead_lettered, true);
  assert.match(final.reason, /exceeded/);
  assert.ok(final.suggestion && /rotat/i.test(final.suggestion), 'must give the caller an actionable way forward (rotate the resource name)');

  // And it STAYS dead -- a subsequent attempt (even by a brand-new agent) is refused the same way,
  // proving this is a durable terminal state, not a one-time refusal.
  const again = await mutex.acquire(ledger, { resource, agent: 'agent-4' });
  assert.equal(again.acquired, false);
  assert.equal(again.dead_lettered, true);
});
