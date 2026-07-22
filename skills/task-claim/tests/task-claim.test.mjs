// task-claim.test.mjs -- unit + sequential-flow coverage for skills/task-claim/mutex.mjs, against the
// hermetic MockLedger (tests/mock-ledger.mjs). No network, no live gateway/Cosmos credentials
// required. The race and expiry proofs live in task-claim-race.test.mjs / task-claim-expiry.test.mjs;
// this file covers the pure helpers plus the single-actor happy/unhappy paths for each verb.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as mutex from '../mutex.mjs';
import { MockLedger } from './mock-ledger.mjs';
import { parseToolResult } from '../gateway-ledger.mjs';

// ---------------------------------------------------------------- pure helpers ----
test('mutexTitle() / isMutexTaskFor(): deterministic title mapping, round-trips', () => {
  assert.equal(mutex.mutexTitle('cto-bridge:iheartest'), 'mutex: cto-bridge:iheartest');
  assert.ok(mutex.isMutexTaskFor({ title: 'mutex: cto-bridge:iheartest' }, 'cto-bridge:iheartest'));
  assert.ok(!mutex.isMutexTaskFor({ title: 'mutex: something-else' }, 'cto-bridge:iheartest'));
  assert.ok(!mutex.isMutexTaskFor(null, 'x'));
});

test('SERVER_LEASE_MINUTES is the documented fixed gateway lease window (45 min)', () => {
  assert.equal(mutex.SERVER_LEASE_MINUTES, 45);
});

// ---------------------------------------------------------------- acquire() ----
test('acquire(): a fresh resource is claimed cleanly (acquired, lease info present)', async () => {
  const ledger = new MockLedger({ jitterMs: 0 });
  const res = await mutex.acquire(ledger, { resource: 'cto-bridge:testapp', agent: 'cto' });
  assert.equal(res.acquired, true);
  assert.equal(res.resource, 'cto-bridge:testapp');
  assert.ok(res.task_id);
  assert.equal(res.lease_version, 1);
  assert.ok(res.lease_until);
  assert.equal(res.task.owner_agent, 'cto');
  assert.equal(res.task.status, 'claimed');
});

test('acquire(): the SAME resource string always maps to the SAME task id across repeated calls', async () => {
  const ledger = new MockLedger({ jitterMs: 0 });
  const first = await mutex.acquire(ledger, { resource: 'r1', agent: 'cto' });
  await mutex.release(ledger, { taskId: first.task_id, agent: 'cto', leaseVersion: first.lease_version });
  const second = await mutex.acquire(ledger, { resource: 'r1', agent: 'developer' });
  assert.equal(second.task_id, first.task_id, 'same resource name -> same underlying task, every time');
});

test('acquire(): a resource already held by another agent (lease not expired) refuses with conflict + held_by', async () => {
  const ledger = new MockLedger({ jitterMs: 0 });
  const first = await mutex.acquire(ledger, { resource: 'cto-bridge:testapp', agent: 'cto' });
  assert.equal(first.acquired, true);
  const second = await mutex.acquire(ledger, { resource: 'cto-bridge:testapp', agent: 'hyperagent-cto' });
  assert.equal(second.acquired, false);
  assert.equal(second.conflict, true);
  assert.equal(second.held_by, 'cto');
  assert.ok(second.lease_until);
});

test('acquire(): the SAME agent re-acquiring its own still-held claim just re-grants it (idempotent-ish, no conflict)', async () => {
  const ledger = new MockLedger({ jitterMs: 0 });
  const first = await mutex.acquire(ledger, { resource: 'r2', agent: 'cto' });
  const second = await mutex.acquire(ledger, { resource: 'r2', agent: 'cto' });
  assert.equal(second.acquired, true, 'the current holder re-claiming its own resource is not a conflict');
  assert.equal(second.task_id, first.task_id);
});

// ---------------------------------------------------------------- release() ----
test('release(): requires leaseVersion -- refuses to construct an unfenced release call', async () => {
  const ledger = new MockLedger({ jitterMs: 0 });
  const acq = await mutex.acquire(ledger, { resource: 'r3', agent: 'cto' });
  await assert.rejects(
    () => mutex.release(ledger, { taskId: acq.task_id, agent: 'cto' }), // leaseVersion omitted on purpose
    /leaseVersion is required/,
  );
});

test('release(): with the correct leaseVersion, returns the resource to "open" -- a clean re-acquire afterward is NOT a reclaim (attempt_count stays 0)', async () => {
  const ledger = new MockLedger({ jitterMs: 0 });
  const acq = await mutex.acquire(ledger, { resource: 'r4', agent: 'cto' });
  const rel = await mutex.release(ledger, { taskId: acq.task_id, agent: 'cto', leaseVersion: acq.lease_version });
  assert.equal(rel.released, true);
  assert.equal(rel.task.status, 'open');

  const reacquired = await mutex.acquire(ledger, { resource: 'r4', agent: 'developer' });
  assert.equal(reacquired.acquired, true);
  assert.equal(reacquired.task.attempt_count, 0, 'a clean release + fresh claim must never look like a reclaim');
});

test('release(): a stale leaseVersion (already reclaimed by someone else) is rejected as fenced, not silently applied', async () => {
  const ledger = new MockLedger({ leaseMs: 200, jitterMs: 0 });
  const first = await mutex.acquire(ledger, { resource: 'r5', agent: 'cto' });
  await new Promise((r) => setTimeout(r, 400)); // let the 200ms lease lapse, with headroom
  const reclaimed = await mutex.acquire(ledger, { resource: 'r5', agent: 'developer' });
  assert.equal(reclaimed.acquired, true);

  // The original holder ("cto"), unaware its lease already expired and was reclaimed, tries to
  // release using its now-stale lease_version -- this must be REFUSED, not silently release the new
  // holder's active claim out from under it.
  const staleRelease = await mutex.release(ledger, { taskId: first.task_id, agent: 'cto', leaseVersion: first.lease_version });
  assert.equal(staleRelease.released, false);
  assert.equal(staleRelease.fenced, true);

  const stillHeld = await mutex.status(ledger, { resource: 'r5' });
  assert.equal(stillHeld.held_by, 'developer', "the zombie holder's release must not have clobbered the real holder");
});

// ---------------------------------------------------------------- heartbeat() ----
test('heartbeat(): extends the lease for the current holder', async () => {
  const ledger = new MockLedger({ leaseMs: 1000, jitterMs: 0 });
  const acq = await mutex.acquire(ledger, { resource: 'r6', agent: 'cto' });
  const beat = await mutex.heartbeat(ledger, { taskId: acq.task_id, agent: 'cto', leaseVersion: acq.lease_version });
  assert.equal(beat.extended, true);
  assert.ok(Date.parse(beat.lease_until) >= Date.parse(acq.lease_until));
});

test('heartbeat(): a non-holder cannot extend someone else’s lease', async () => {
  const ledger = new MockLedger({ jitterMs: 0 });
  const acq = await mutex.acquire(ledger, { resource: 'r7', agent: 'cto' });
  const beat = await mutex.heartbeat(ledger, { taskId: acq.task_id, agent: 'developer' });
  assert.equal(beat.extended, false);
  assert.equal(beat.fenced, true);
});

// ---------------------------------------------------------------- status() ----
test('status(): an unclaimed resource reports found + not held (and brings the resource identity into existence, matching acquire()’s own id resolution)', async () => {
  const ledger = new MockLedger({ jitterMs: 0 });
  const st = await mutex.status(ledger, { resource: 'r8' });
  assert.equal(st.found, true);
  assert.equal(st.held, false);
  assert.equal(st.status, 'open');

  const acq = await mutex.acquire(ledger, { resource: 'r8', agent: 'cto' });
  assert.equal(acq.task_id, st.task_id, 'status() and acquire() must resolve the same resource identity');
});

test('status(): a held, unexpired claim reports held + held_by + dead_lettered=false', async () => {
  const ledger = new MockLedger({ jitterMs: 0 });
  await mutex.acquire(ledger, { resource: 'r9', agent: 'clo' });
  const st = await mutex.status(ledger, { resource: 'r9' });
  assert.equal(st.held, true);
  assert.equal(st.held_by, 'clo');
  assert.equal(st.dead_lettered, false);
});

// ---------------------------------------------------------------- gateway-ledger.mjs parseToolResult() ----
test('parseToolResult(): extracts structuredContent.result from a plain-JSON tool response', () => {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    result: {
      content: [{ type: 'text', text: '{"claimed":true}' }],
      structuredContent: { result: { claimed: true, task: { id: 't_idem_abc' } }, compliance_warning: null, correlation_id: 'c1', dry_run: false },
    },
  });
  const parsed = parseToolResult(body);
  assert.deepEqual(parsed, { claimed: true, task: { id: 't_idem_abc' } });
});

test('parseToolResult(): extracts structuredContent.result from an SSE-framed response', () => {
  const inner = { jsonrpc: '2.0', id: 1, result: { content: [], structuredContent: { result: { created: true, task: { id: 't_x' } } } } };
  const body = `event: message\ndata: ${JSON.stringify(inner)}\n\n`;
  const parsed = parseToolResult(body);
  assert.deepEqual(parsed, { created: true, task: { id: 't_x' } });
});

test('parseToolResult(): a tool-level isError surfaces a clear thrown error (never silently returns null)', () => {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    result: {
      isError: true,
      content: [{ type: 'text', text: 'Tool task_claim failed: boom' }],
      structuredContent: { result: null, error: { code: 'tool_error', message: 'boom' } },
    },
  });
  assert.throws(() => parseToolResult(body), /boom/);
});

test('parseToolResult(): a JSON-RPC-level error surfaces a clear thrown error', () => {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'method not found' } });
  assert.throws(() => parseToolResult(body), /method not found/);
});
