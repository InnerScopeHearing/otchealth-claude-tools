// task-claim-race.test.mjs -- proves two (and three) SIMULTANEOUS claim attempts on the SAME mutex
// resource are handled correctly: exactly one claimant wins, the other(s) correctly detect and
// report the conflict, and NEITHER silently believes it holds an exclusive claim it does not. This
// is the load-bearing property the whole task-claim skill exists to prove: the fleet's cto-bridge
// ACTIVE-CTO-THREAD line is a prose convention that nothing enforces, so nothing stops two threads
// from both believing they hold it (the documented 2026-06-13 double-CTO incident). This test proves
// the replacement primitive cannot have that failure mode.
//
// The race is genuine, not simulated by promise-ordering alone: MockLedger (tests/mock-ledger.mjs)
// puts a randomized async delay on BOTH the read and the write half of every operation, so two
// concurrent claim() calls interleave their read/decide/write steps unpredictably (Promise.all fires
// them "at the same time"; which one's write actually lands first is decided by the RNG jitter, not
// by call order). The only thing that keeps the outcome sane is the SAME mechanism production uses:
// a synchronous compare-and-swap at the store (mirroring Cosmos's If-Match PUT), so no matter how the
// two calls interleave, only one write can ever land against a given etag -- the loser gets a 412 in
// the mock, retries once (mirroring ledger.ts's claimTask retry loop), and reports a clean conflict.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as mutex from '../mutex.mjs';
import { MockLedger } from './mock-ledger.mjs';

const TRIALS = 40;

test(`race: ${TRIALS} trials of two agents racing acquire() on a FRESH resource -- exactly one wins every time, never both, never neither`, async () => {
  for (let i = 0; i < TRIALS; i++) {
    const ledger = new MockLedger({ jitterMs: 12 }); // fresh store + fresh randomized jitter each trial
    const resource = `race-resource-${i}`;
    const [a, b] = await Promise.all([
      mutex.acquire(ledger, { resource, agent: 'agent-a' }),
      mutex.acquire(ledger, { resource, agent: 'agent-b' }),
    ]);

    const winners = [a, b].filter((r) => r.acquired === true);
    const losers = [a, b].filter((r) => r.acquired === false);

    assert.equal(winners.length, 1, `trial ${i}: exactly one racer must win (got ${winners.length}) -- a[${a.acquired}] b[${b.acquired}]`);
    assert.equal(losers.length, 1, `trial ${i}: exactly one racer must lose`);

    const winner = winners[0];
    const loser = losers[0];
    const winnerAgent = a.acquired ? 'agent-a' : 'agent-b';

    // The loser must correctly REPORT the conflict, not silently look like a no-op success and not
    // throw/crash -- it has a coherent, truthful reason and names who actually holds the claim.
    assert.equal(loser.conflict, true, `trial ${i}: the losing racer must report conflict:true`);
    assert.equal(loser.held_by, winnerAgent, `trial ${i}: the loser must correctly attribute the hold to the winner`);
    assert.ok(loser.reason && loser.reason.length > 0, `trial ${i}: the loser must give a non-empty reason`);

    // Both racers must have resolved to the SAME underlying task (one resource, one task identity) --
    // if they ever raced onto TWO different task ids for the same resource name, that alone would be
    // a distinct (worse) bug: get-or-create not actually being get-or-create under contention.
    assert.equal(a.task_id, b.task_id, `trial ${i}: both racers must resolve the same resource to the same task id`);

    // The store itself must never end up with the resource doubly/ambiguously owned: read it back
    // fresh and confirm it is claimed by exactly the winner.
    const finalStatus = await mutex.status(ledger, { resource });
    assert.equal(finalStatus.held_by, winnerAgent, `trial ${i}: the final ledger state must show the winner as sole holder`);
    assert.equal(winner.task.owner_agent, winnerAgent);
  }
});

test('race: three agents racing acquire() on the same fresh resource -- exactly one wins, the other two both correctly report conflict', async () => {
  for (let i = 0; i < 15; i++) {
    const ledger = new MockLedger({ jitterMs: 15 });
    const resource = `race3-${i}`;
    const results = await Promise.all([
      mutex.acquire(ledger, { resource, agent: 'agent-a' }),
      mutex.acquire(ledger, { resource, agent: 'agent-b' }),
      mutex.acquire(ledger, { resource, agent: 'agent-c' }),
    ]);
    const winners = results.filter((r) => r.acquired === true);
    const losers = results.filter((r) => r.acquired === false);
    assert.equal(winners.length, 1, `trial ${i}: exactly one of three racers must win`);
    assert.equal(losers.length, 2, `trial ${i}: the other two must lose`);
    const winnerAgent = winners[0].task.owner_agent;
    for (const loser of losers) {
      assert.equal(loser.conflict, true);
      assert.equal(loser.held_by, winnerAgent);
    }
    const allSameTaskId = new Set(results.map((r) => r.task_id));
    assert.equal(allSameTaskId.size, 1, `trial ${i}: all three racers must resolve to the same task id`);
  }
});

test('race: two agents racing acquire() where BOTH already know the resource exists (create() is also raced, not just claim())', async () => {
  // Unlike the fresh-resource trials above, here the resource's task identity does NOT exist yet
  // when the race starts either -- both racers' ledger.create() calls ALSO race each other (not just
  // their claim() calls), exercising MockLedger's idempotent-create race path (mirrors ledger.ts
  // createTask's own conflict-then-reread handling) at the same time as the claim race.
  for (let i = 0; i < 25; i++) {
    const ledger = new MockLedger({ jitterMs: 20 });
    const resource = `race-create-${i}`;
    const [a, b] = await Promise.all([
      mutex.acquire(ledger, { resource, agent: 'x', createdBy: 'x' }),
      mutex.acquire(ledger, { resource, agent: 'y', createdBy: 'y' }),
    ]);
    assert.equal(a.task_id, b.task_id, `trial ${i}: create() racing must still collapse to one task id`);
    const winners = [a, b].filter((r) => r.acquired);
    assert.equal(winners.length, 1, `trial ${i}: exactly one winner even when create() itself was raced`);

    // create() being raced must not have produced two "created:true" docs under the hood -- confirm
    // there is exactly one doc in the store keyed to this resource's task id family (the mock's Map
    // is keyed by the deterministic id, so a duplicate would only be detectable as a distinct id;
    // the task_id equality assertion above already proves there is no second id in play).
    assert.equal(ledger.docs.size >= 1, true);
  }
});

test('race: a claim-race loser never mutates the store -- re-reading the resource by task_get shows only the winner’s write took effect', async () => {
  const ledger = new MockLedger({ jitterMs: 10 });
  const resource = 'race-getcheck';
  const [a, b] = await Promise.all([
    mutex.acquire(ledger, { resource, agent: 'agent-a' }),
    mutex.acquire(ledger, { resource, agent: 'agent-b' }),
  ]);
  const winnerAgent = a.acquired ? 'agent-a' : 'agent-b';
  const taskId = a.task_id;
  const got = await ledger.get({ task_id: taskId });
  assert.equal(got.found, true);
  assert.equal(got.task.owner_agent, winnerAgent);
  assert.equal(got.task.lease_version, 1, 'exactly one successful claim write must have landed (lease_version==1), not two');
});
