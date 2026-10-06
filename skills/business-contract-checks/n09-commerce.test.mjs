import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { validateCommerceFreshness } from './commerce.mjs';

const NOW = '2026-10-06T04:00:00.000Z';
const makeSource = (kind) => ({
  system_id: `synthetic://${kind}/system`,
  reference_id: `synthetic://${kind}/reference`,
  evidence_ref: `synthetic://${kind}/evidence`,
  source_version: `synthetic-${kind}-v1`,
  as_of: '2026-10-06T03:59:00.000Z',
  scope: { sku: 'synthetic://scope/sku', location_id: 'synthetic://scope/location', channel: 'synthetic://scope/channel' },
});
const base = () => {
  const facts = { stock: { available_quantity: 5 }, payment: { status: 'settled', payment_ref: 'synthetic://payment/receipt' }, promise: { version: 'synthetic-promise-v4' }, capacity: { available_quantity: 5 } };
  const records = ['stock', 'payment', 'promise', 'capacity'].map((kind) => ({ kind, source: makeSource(kind), facts: facts[kind] }));
  return {
    draft_validation: true,
    live_authorization: false,
    workflow: 'N09',
    context: {
      now: NOW,
      requested_quantity: 2,
      accepted_payment_states: ['settled'],
      scope: { sku: 'synthetic://scope/sku', location_id: 'synthetic://scope/location', channel: 'synthetic://scope/channel' },
      freshness_thresholds_ms: { stock: 300000, payment: 300000 },
      current_source_versions: { stock: 'synthetic-stock-v1', payment: 'synthetic-payment-v1', promise: 'synthetic-promise-v1', capacity: 'synthetic-capacity-v1' },
      current_promise_version: 'synthetic-promise-v4',
      immutable_native_records: records,
      accepted_owner_ids: ['synthetic-actor-owner'],
    },
    stock: { available_quantity: 5, source: makeSource('stock') },
    payment: { status: 'settled', payment_ref: 'synthetic://payment/receipt', source: makeSource('payment') },
    promise: { version: 'synthetic-promise-v4', source: makeSource('promise') },
    fulfillment: { capacity: { available_quantity: 5, source: makeSource('capacity') }, exceptions: [] },
  };
};
const hold = (input, code) => {
  const result = validateCommerceFreshness(input);
  assert.equal(result.status, 'hold');
  assert.ok(result.reason_codes.some((r) => r.code === code), JSON.stringify(result.reason_codes));
};

test('fresh linked stock, confirmed payment, current promise, and capacity pass draft validation only', () => {
  const input = base();
  const before = structuredClone(input);
  assert.deepEqual(validateCommerceFreshness(input), { status: 'ready', reason_codes: [], readiness_scope: 'draft_review_only', activation: 'disabled', live_authorization: false });
  assert.deepEqual(input, before);
});

test('stock freshness uses supplied now and caller threshold; future evidence also holds', () => {
  const old = base();
  old.stock.source.as_of = '2026-10-06T03:50:00.000Z';
  old.context.immutable_native_records[0].source.as_of = old.stock.source.as_of;
  hold(old, 'STOCK_STALE');
  const future = base();
  future.payment.source.as_of = '2026-10-06T04:00:01.000Z';
  future.context.immutable_native_records[1].source.as_of = future.payment.source.as_of;
  hold(future, 'PAYMENT_STALE');
  const noThreshold = base();
  delete noThreshold.context.freshness_thresholds_ms.payment;
  hold(noThreshold, 'INVALID_FRESHNESS_THRESHOLD');
});

test('missing or disputed payment, source mismatch, promise drift, and insufficient capacity hold', () => {
  const disputed = base(); disputed.payment.status = 'disputed'; hold(disputed, 'PAYMENT_NOT_CONFIRMED');
  const missing = base(); delete missing.payment; hold(missing, 'MISSING_PAYMENT');
  const drift = base(); drift.stock.source.source_version = 'synthetic-stock-v0'; hold(drift, 'SOURCE_VERSION_MISMATCH');
  const scope = base(); scope.stock.source.scope.location_id = 'synthetic://scope/other'; hold(scope, 'SOURCE_SCOPE_MISMATCH');
  const duplicate = base(); duplicate.context.immutable_native_records.push(structuredClone(duplicate.context.immutable_native_records[0])); hold(duplicate, 'NATIVE_RECORD_NOT_UNIQUELY_VERIFIED');
  const promiseSource = base(); promiseSource.promise.source.source_version = 'synthetic-promise-v3'; hold(promiseSource, 'SOURCE_VERSION_MISMATCH');
  const promise = base(); promise.promise.version = 'synthetic-promise-v3'; hold(promise, 'PROMISE_VERSION_MISMATCH');
  const capacity = base(); capacity.fulfillment.capacity.available_quantity = 1; hold(capacity, 'CAPACITY_INSUFFICIENT');
});

test('fulfillment exception holds and requires a configured accepted owner', () => {
  const missingOwner = base();
  missingOwner.fulfillment.exceptions = [{ type: 'capacity_shortfall', owner_actor_id: 'synthetic-actor-unknown', due_at: '2026-10-06T04:30:00.000Z', native_ref: 'synthetic://fulfillment/exception' }];
  hold(missingOwner, 'EXCEPTION_OWNER_UNACCEPTED');
  const absentOwner = base();
  absentOwner.fulfillment.exceptions = [{ type: 'missing', due_at: '2026-10-06T04:30:00.000Z', native_ref: 'synthetic://fulfillment/exception' }];
  hold(absentOwner, 'EXCEPTION_OWNER_UNACCEPTED');
  const owned = base();
  owned.fulfillment.exceptions = [{ type: 'late', owner_actor_id: 'synthetic-actor-owner', due_at: '2026-10-06T04:30:00.000Z', native_ref: 'synthetic://fulfillment/exception' }];
  hold(owned, 'FULFILLMENT_EXCEPTION_OPEN');
});

test('malformed input holds without throwing', () => {
  for (const value of [null, [], 'bad', {}]) assert.equal(validateCommerceFreshness(value).status, 'hold');
});

test('CLI pass/hold/malformed cases preserve the draft-only envelope and structured reason codes', () => {
  const run = (input) => spawnSync(process.execPath, ['./cli.mjs'], { cwd: new URL('.', import.meta.url), input: JSON.stringify(input), encoding: 'utf8' });
  const pass = run(base());
  assert.equal(pass.status, 0);
  const passResult = JSON.parse(pass.stdout);
  assert.equal(passResult.kind, 'draft_validation');
  assert.equal(passResult.live_authorization, false);
  const denied = base(); denied.payment.status = 'disputed';
  const holdResult = run(denied);
  assert.equal(holdResult.status, 1);
  assert.ok(JSON.parse(holdResult.stdout).reason_codes.some((r) => r.code === 'PAYMENT_NOT_CONFIRMED'));
  const malformed = run({ draft_validation: true, live_authorization: false, workflow: 'N09', context: null });
  assert.equal(malformed.status, 1);
  assert.equal(JSON.parse(malformed.stdout).status, 'hold');
  const opaque = base();
  const replaceMarkers = (value) => {
    if (Array.isArray(value)) return value.map(replaceMarkers);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, replaceMarkers(v)]));
    if (typeof value === 'string' && value.startsWith('synthetic://')) return `native:${value.slice(11)}`;
    if (typeof value === 'string' && value.startsWith('synthetic-')) return `version:${value.slice(10)}`;
    return value;
  };
  const opaquePass = run(replaceMarkers(opaque));
  assert.equal(opaquePass.status, 0, opaquePass.stdout);
  const freeText = run({ ...base(), memo: 'customer said ship now' });
  assert.equal(freeText.status, 1);
  const bodyField = run({ ...base(), source_body: 'raw content' });
  assert.equal(bodyField.status, 1);
});
