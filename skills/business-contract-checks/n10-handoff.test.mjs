import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { validateHandoff } from './handoff.mjs';

// Entirely synthetic fixtures. The validator receives explicit policy and time
// inputs; these tests do not infer business thresholds or consult external data.
const NOW = '2026-10-05T10:00:00.000Z';
const T0 = '2026-10-05T09:55:00.000Z';
const T1 = '2026-10-05T10:05:00.000Z';
const SOURCE_VERSION = 'source-version-synthetic-1';
const SNAPSHOT = Object.freeze({
  entity_id: 'entity-synthetic-01',
  sku: 'SKU-SYNTHETIC-01',
  revision: 'rev-synthetic-1',
  channel: 'channel-synthetic-web',
  location_id: 'location-synthetic-01',
  as_of: T0,
  evidence_ref: 'source-evidence-synthetic',
  source_version: SOURCE_VERSION,
});

const ACK_RECORD = Object.freeze({
  source_id: 'ack-source-synthetic-01',
  supplier_id: 'supplier-synthetic-01',
  acknowledged: true,
  reference_id: 'ack-ref-synthetic-01',
  acknowledged_at: '2026-10-05T09:58:00.000Z',
  next_deadline: T1,
  quantity: 5,
  unit: 'case',
  entity_id: SNAPSHOT.entity_id,
  sku: SNAPSHOT.sku,
  revision: SNAPSHOT.revision,
  channel: SNAPSHOT.channel,
  location_id: SNAPSHOT.location_id,
});

function boundRecord(extra) {
  return {
    ...extra,
    source_version: SOURCE_VERSION,
    entity_id: SNAPSHOT.entity_id,
    sku: SNAPSHOT.sku,
    revision: SNAPSHOT.revision,
    channel: SNAPSHOT.channel,
    location_id: SNAPSHOT.location_id,
  };
}

function capacityRecord() {
  return boundRecord({ quantity: 10, unit: 'case', as_of: T0, evidence_ref: 'capacity-evidence-synthetic', basis: 'physical_usable_capacity', scope: 'physical_capacity' });
}

function inventoryRecord() {
  return boundRecord({ quantity: 10, unit: 'case', as_of: T0, evidence_ref: 'inventory-evidence-synthetic', basis: 'accepted_available_stock', scope: 'available_stock' });
}

function nativeRecord() {
  return boundRecord({
    system_id: 'system-synthetic-wms',
    location_id: SNAPSHOT.location_id,
    reference_id: 'native-ref-synthetic-01',
    unit: 'case',
    as_of: T0,
    evidence_ref: 'native-evidence-synthetic',
  });
}

function context(overrides = {}) {
  return {
    source_snapshot: { ...SNAPSHOT },
    max_age_ms: 10 * 60 * 1000,
    current_source_version: SOURCE_VERSION,
    immutable_acknowledgments: [{ ...ACK_RECORD }],
    immutable_capacity_records: [capacityRecord()],
    immutable_inventory_records: [inventoryRecord()],
    immutable_native_records: [nativeRecord()],
    allowed_po_operations: ['draft_purchase_order'],
    allowed_wholesale_shipment_states: ['proposal', 'acknowledged'],
    allowed_return_states: ['received', 'inspected', 'held'],
    allowed_refund_states: ['not_requested', 'proposed', 'completed'],
    allowed_replacement_states: ['not_requested', 'proposed', 'completed'],
    allowed_complaint_states: ['open', 'acknowledged', 'resolved'],
    allowed_stock_treatments: ['held'],
    ...overrides,
  };
}

function base(stage = 'receiving_to_stock', overrides = {}) {
  const coverage = {
    receipt_id: 'coverage-receipt-synthetic',
    starts_at: '2026-10-05T09:00:00.000Z',
    ends_at: '2026-10-05T11:00:00.000Z',
  };
  const result = {
    status: 'acknowledged',
    workflow_stage: stage,
    source_snapshot: { ...SNAPSHOT },
    entity_id: SNAPSHOT.entity_id,
    sku: SNAPSHOT.sku,
    revision: SNAPSHOT.revision,
    channel: SNAPSHOT.channel,
    location_id: SNAPSHOT.location_id,
    quantity: 5,
    unit: 'case',
    owner: { actor_id: 'actor-synthetic-owner', accepted: true, coverage: { ...coverage } },
    backup: { actor_id: 'actor-synthetic-backup', accepted: true, coverage: { ...coverage, receipt_id: 'backup-coverage-synthetic' } },
    native: nativeRecord(),
    capacity: capacityRecord(),
    inventory: inventoryRecord(),
    acknowledgment: {
      supplier_id: 'supplier-synthetic-01',
      acknowledged: true,
      reference_id: 'ack-ref-synthetic-01',
      acknowledged_at: '2026-10-05T09:58:00.000Z',
      next_deadline: T1,
      quantity: 5,
      unit: 'case',
      source_record: { ...ACK_RECORD },
    },
    ...overrides,
  };
  const stageFields = {
    demand_to_procurement: 'draft_po',
    receiving_to_stock: 'receiving',
    stock_to_channels: 'allocation',
    wholesale_po_to_cash: 'wholesale',
    physical_return_to_disposition: 'reverse_logistics',
  };
  for (const key of Object.values(stageFields)) {
    if (stageFields[stage] !== key) delete result[key];
  }
  if (stage === 'receiving_to_stock' && !Object.hasOwn(overrides, 'receiving')) {
    result.receiving = {
      quantity: 5,
      lot_serial_applicable: true,
      lot_serial_ref: 'lot-synthetic-01',
      quality_disposition: 'accept',
      native_receipt_ref: 'receipt-synthetic-01',
    };
  }
  return result;
}

function demand(overrides = {}) {
  const authority = {
    accepted: true,
    receipt_id: 'authority-receipt-synthetic',
    actor_id: 'actor-synthetic-owner',
    entity_id: SNAPSHOT.entity_id,
    operation: 'draft_purchase_order',
    limit_quantity: 5,
    unit: 'case',
    window_start: '2026-10-05T09:00:00.000Z',
    window_end: T1,
  };
  return base('demand_to_procurement', {
    status: 'open',
    draft_po: {
      state: 'proposal',
      actor_id: 'actor-synthetic-owner',
      entity_id: SNAPSHOT.entity_id,
      operation: 'draft_purchase_order',
      limit_quantity: 5,
      unit: 'case',
      window_start: authority.window_start,
      window_end: authority.window_end,
      authority: { ...authority },
    },
    ...overrides,
  });
}

function allocation(overrides = {}) {
  return base('stock_to_channels', {
    status: 'open',
    allocation: {
      reservation_ref: 'reservation-synthetic-01',
      release_ref: 'release-synthetic-01',
      reconciled: true,
      available_quantity: 5,
      stockout: false,
      oversell: false,
    },
    ...overrides,
  });
}

function wholesale(overrides = {}) {
  return base('wholesale_po_to_cash', {
    status: 'acknowledged',
    wholesale: {
      contract_ref: 'contract-synthetic-01',
      edi_ref: 'edi-synthetic-01',
      label_ref: 'label-synthetic-01',
      otif_ref: 'otif-synthetic-01',
      obligation_ref: 'obligation-synthetic-01',
      invoice_ref: 'invoice-synthetic-01',
      shipment_ref: 'shipment-synthetic-01',
      shipment_status: 'acknowledged',
      collection_date: '2026-10-06T00:00:00.000Z',
      operator_receipt: 'operator-ack-synthetic',
      controller_receipt: 'controller-ack-synthetic',
      deduction_state: 'none',
    },
    ...overrides,
  });
}

function reverse(overrides = {}) {
  return base('physical_return_to_disposition', {
    status: 'acknowledged',
    reverse_logistics: {
      original_sale_ref: 'sale-synthetic-01',
      return_or_repair_ref: 'return-synthetic-01',
      inspection_ref: 'inspection-synthetic-01',
      stock_treatment: 'held',
      remedy_ref: 'remedy-synthetic-01',
      refund_ref: 'refund-synthetic-01',
      replacement_ref: 'replacement-synthetic-01',
      complaint_ref: 'complaint-synthetic-01',
      return_state: 'inspected',
      refund_state: 'proposed',
      replacement_state: 'proposed',
      complaint_state: 'open',
    },
    ...overrides,
  });
}

function validate(handoff, ctx = context(), now = NOW) {
  return validateHandoff(handoff, ctx, now);
}

function ready(handoff, ctx = context(), now = NOW) {
  const result = validate(handoff, ctx, now);
  assert.equal(result?.status, 'ready', `expected ready, got ${JSON.stringify(result)}`);
  assert.deepEqual(result.errors, []);
}

function held(handoff, ctx = context(), now = NOW) {
  const result = validate(handoff, ctx, now);
  assert.equal(result?.status, 'hold', `expected hold, got ${JSON.stringify(result)}`);
  assert.ok(Array.isArray(result.errors) && result.errors.length > 0, 'hold must explain its blocker');
}

function change(value, path, replacement) {
  const clone = structuredClone(value);
  let target = clone;
  for (const key of path.slice(0, -1)) target = target[key];
  target[path.at(-1)] = replacement;
  return clone;
}

function withQuantity(quantity) {
  const handoff = base();
  handoff.quantity = quantity;
  handoff.receiving.quantity = quantity;
  handoff.acknowledgment.quantity = quantity;
  const sourceRecord = { ...ACK_RECORD, quantity };
  handoff.acknowledgment.source_record = sourceRecord;
  return { handoff, ctx: context({ immutable_acknowledgments: [sourceRecord] }) };
}

test('each workflow stage has a positive synthetic contract fixture', async (t) => {
  // Stage-specific positive fixtures are deliberately explicit and use only
  // test-local identifiers and policy receipts.
  const cases = [
    ['demand to procurement', demand()],
    ['receiving to stock', base('receiving_to_stock')],
    ['stock to channels', allocation()],
    ['wholesale PO to cash', wholesale()],
    ['physical return to disposition', reverse()],
  ];
  for (const [name, handoff] of cases) await t.test(name, () => ready(handoff));
});

test('source identity, SKU, revision, channel, and location must match current context', async (t) => {
  for (const [key, wrong] of [
    ['entity_id', 'entity-other-synthetic'],
    ['sku', 'SKU-OTHER-SYNTHETIC'],
    ['revision', 'rev-other-synthetic'],
    ['channel', 'channel-other-synthetic'],
    ['location_id', 'location-other-synthetic'],
  ]) {
    await t.test(key, () => {
      const bad = change(base(), [key], wrong);
      held(bad);
    });
    await t.test(`snapshot ${key}`, () => {
      const bad = change(base(), ['source_snapshot', key], wrong);
      held(bad);
    });
  }
  held(base(), context({ source_snapshot: { ...SNAPSHOT, sku: 'SKU-OTHER-SYNTHETIC' } }));
  held(base(), context({ source_snapshot: { ...SNAPSHOT, location_id: 'location-other-synthetic' } }));
  held(base(), context({ current_source_version: 'source-version-old-synthetic' }));
  held(base(), context({ source_snapshot: { ...SNAPSHOT, evidence_ref: 'source-other-synthetic' } }));
});

test('timestamps are strict, current, and respect half-open coverage windows', async (t) => {
  for (const value of ['', 'UNKNOWN', 'not-a-date', '2026-02-30T10:00:00.000Z', '2026-10-05', '2026-10-05T24:00:00.000Z']) {
    await t.test(`reject ${JSON.stringify(value)} source time`, () => {
      held(base(), context({ source_snapshot: { ...SNAPSHOT, as_of: value } }));
    });
  }
  held(base(), context({ source_snapshot: { ...SNAPSHOT, as_of: '2026-10-05T10:00:00.001Z' } }));
  held(base(), context({ source_snapshot: { ...SNAPSHOT, as_of: '2026-10-05T09:49:59.999Z' } }));
  held(base(), context({ max_age_ms: 0 }));
  held(base(), context({ max_age_ms: -1 }));
  held(base(), context({ max_age_ms: Number.POSITIVE_INFINITY }));
  // The bounds are half-open: starts_at is included, ends_at is excluded.
  ready(change(base(), ['owner', 'coverage', 'starts_at'], NOW));
  // The validator contract requires the upper bound to be excluded.
  held(change(base(), ['owner', 'coverage', 'ends_at'], NOW));
  held(change(base(), ['owner', 'coverage', 'starts_at'], '2026-10-05T10:00:00.001Z'));
  held(change(base(), ['backup', 'coverage', 'ends_at'], '2026-10-05T09:59:59.999Z'));
});

test('receipts are required, affirmative, scalar, nonblank, and not unknown', async (t) => {
  for (const [path, invalid] of [
    [['owner', 'accepted'], false], [['owner', 'accepted'], {}], [['owner', 'accepted'], 'true'],
    [['owner', 'coverage', 'receipt_id'], ''], [['owner', 'coverage', 'receipt_id'], 'UNKNOWN'],
    [['backup', 'accepted'], false], [['backup', 'coverage', 'receipt_id'], null],
    [['native', 'reference_id'], ''], [['native', 'system_id'], 'UNKNOWN'],
    [['capacity', 'evidence_ref'], ''], [['inventory', 'evidence_ref'], 'UNKNOWN'],
    [['acknowledgment', 'acknowledged'], false], [['acknowledgment', 'acknowledged'], {}],
    [['acknowledgment', 'reference_id'], ''], [['acknowledgment', 'supplier_id'], 'UNKNOWN'],
  ]) {
    await t.test(`${path.join('.')}=${String(invalid)}`, () => held(change(base(), path, invalid)));
  }
  for (const field of ['owner', 'backup', 'native', 'capacity', 'inventory', 'acknowledgment']) {
    await t.test(`missing ${field}`, () => {
      const bad = structuredClone(base());
      delete bad[field];
      held(bad);
    });
  }
});

test('context and acknowledgment records cannot be cloned or mutated to impersonate evidence', async (t) => {
  const sourceRecord = { ...ACK_RECORD };
  const ctx = context({ immutable_acknowledgments: [sourceRecord] });
  const good = change(base(), ['acknowledgment', 'source_record'], structuredClone(sourceRecord));
  ready(good, ctx);
  held(change(good, ['acknowledgment', 'source_record', 'reference_id'], 'ack-clone-mutated'), ctx);
  held(change(good, ['acknowledgment', 'source_record', 'sku'], 'SKU-OTHER-SYNTHETIC'), ctx);
  held(change(good, ['acknowledgment', 'source_record', 'entity_id'], 'entity-other-synthetic'), ctx);
  held(change(good, ['acknowledgment', 'source_record'], { ...sourceRecord, reference_id: 'invented-record' }), ctx);
  held(good, context({ immutable_acknowledgments: [] }));
  held(good, context({ immutable_acknowledgments: [{ ...sourceRecord, acknowledged: false }] }));
  held(good, context({ immutable_acknowledgments: [{ ...sourceRecord }, { ...sourceRecord }] }));
  held(base(), context({ immutable_capacity_records: [capacityRecord(), capacityRecord()] }));
  held(base(), context({ immutable_inventory_records: [inventoryRecord(), inventoryRecord()] }));
  held(base(), context({ immutable_native_records: [nativeRecord(), nativeRecord()] }));

  const frozenInput = base();
  const before = structuredClone(frozenInput);
  const beforeContext = structuredClone(ctx);
  validate(frozenInput, ctx);
  assert.deepEqual(frozenInput, before, 'validator mutated the handoff input');
  assert.deepEqual(ctx, beforeContext, 'validator mutated the context input');
});

test('capacity and inventory facts are explicit, fresh, finite, nonnegative, and sufficient', async (t) => {
  held(change(base(), ['capacity', 'quantity'], 4));
  held(change(base(), ['inventory', 'quantity'], 4));
  held(change(base(), ['capacity', 'quantity'], -1));
  held(change(base(), ['inventory', 'quantity'], Number.NaN));
  held(change(base(), ['capacity', 'quantity'], Number.POSITIVE_INFINITY));
  held(change(base(), ['inventory', 'quantity'], '10'));
  held(change(base(), ['capacity', 'unit'], 'pallet'));
  held(change(base(), ['inventory', 'unit'], 'pallet'));
  held(change(base(), ['capacity', 'scope'], 'retailer_volume'));
  held(change(base(), ['inventory', 'scope'], 'retailer_volume'));
  held(change(base(), ['capacity', 'basis'], 'retailer_volume'));
  held(change(base(), ['inventory', 'basis'], 'retailer_volume'));
  held(change(base(), ['capacity', 'as_of'], 'UNKNOWN'));
  held(change(base(), ['inventory', 'as_of'], '2026-10-05T10:05:00.000Z'));
  held(change(base(), ['capacity', 'as_of'], '2026-10-05T09:49:59.999Z'));
  for (const invalidQuantity of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const { handoff, ctx } = withQuantity(invalidQuantity);
    held(handoff, ctx);
  }
  const fractional = withQuantity(0.5);
  ready(fractional.handoff, fractional.ctx);
  const atCapacity = withQuantity(10);
  ready(atCapacity.handoff, atCapacity.ctx);
  const changedCapacity = change(base(), ['capacity', 'evidence_ref'], 'capacity-clone-mutated');
  held(changedCapacity);
  const changedInventory = change(base(), ['inventory', 'source_version'], 'source-version-old-synthetic');
  held(changedInventory);
  const changedNative = change(base(), ['native', 'location_id'], 'location-other-synthetic');
  held(changedNative);
});

test('owner and backup identities require distinct accepted active coverage', async (t) => {
  held(change(base(), ['backup', 'actor_id'], 'actor-synthetic-owner'));
  held(change(base(), ['owner', 'actor_id'], ''));
  held(change(base(), ['owner', 'coverage', 'ends_at'], '2026-10-05T09:59:00.000Z'));
  held(change(base(), ['backup', 'coverage', 'starts_at'], '2026-10-05T10:01:00.000Z'));
  held(change(base(), ['owner', 'coverage', 'ends_at'], '2026-10-05T10:00:00.000Z'));
  held(change(base(), ['backup', 'accepted'], null));
  held(change(base(), ['owner', 'coverage', 'starts_at'], '2026-10-05T10:01:00.000Z'));
});

test('draft PO proposal is not treated as commitment; acceptance needs exact current authority', async (t) => {
  ready(demand());
  const authorityAccepted = change(demand(), ['draft_po', 'state'], 'accepted');
  ready(authorityAccepted);
  const authorized = structuredClone(authorityAccepted);
  for (const [path, bad] of [
    [['draft_po', 'actor_id'], 'actor-other-synthetic'],
    [['draft_po', 'entity_id'], 'entity-other-synthetic'],
    [['draft_po', 'operation'], 'issue_purchase_order'],
    [['draft_po', 'limit_quantity'], 6],
    [['draft_po', 'window_start'], '2026-10-05T08:59:59.999Z'],
    [['draft_po', 'window_end'], '2026-10-05T10:05:00.001Z'],
    [['draft_po', 'authority', 'accepted'], false],
    [['draft_po', 'authority', 'actor_id'], 'actor-other-synthetic'],
    [['draft_po', 'authority', 'entity_id'], 'entity-other-synthetic'],
    [['draft_po', 'authority', 'operation'], 'issue_purchase_order'],
    [['draft_po', 'authority', 'limit_quantity'], 4],
    [['draft_po', 'authority', 'window_end'], '2026-10-05T09:59:59.999Z'],
  ]) held(change(authorized, path, bad));
  const atEnd = structuredClone(authorized);
  atEnd.draft_po.state = 'accepted';
  atEnd.draft_po.window_end = NOW;
  atEnd.draft_po.authority.window_end = NOW;
  held(atEnd);
  held(authorized, context({ allowed_po_operations: [] }));
  const accepted = structuredClone(authorized);
  accepted.acknowledgment.acknowledged = true;
  ready(accepted);
  held(change(accepted, ['draft_po', 'unit'], 'pallet'));
  const undersizedAuthority = change(accepted, ['draft_po', 'authority', 'limit_quantity'], 4);
  held(undersizedAuthority);
});

test('receiving requires native receipt, quantity match, lot/serial applicability, and safe disposition', async (t) => {
  held(change(base(), ['receiving', 'native_receipt_ref'], ''));
  held(change(base(), ['receiving', 'quantity'], 4));
  held(change(base(), ['receiving', 'quantity'], Number.POSITIVE_INFINITY));
  held(change(base(), ['receiving', 'lot_serial_applicable'], 'yes'));
  held(change(base(), ['receiving', 'lot_serial_ref'], 'UNKNOWN'));
  held(change(base(), ['receiving', 'lot_serial_ref'], ''));
  for (const disposition of ['hold', 'reject', 'unreviewed']) {
    await t.test(disposition, () => held(change(base(), ['receiving', 'quality_disposition'], disposition)));
  }
  const notApplicable = change(base(), ['receiving', 'lot_serial_applicable'], false);
  delete notApplicable.receiving.lot_serial_ref;
  ready(notApplicable);
  const quarantine = change(base(), ['status'], 'held');
  quarantine.available_quantity = 0;
  quarantine.receiving.quality_disposition = 'hold';
  held(quarantine);
});

test('allocation requires reservation, release, reconciliation, and prevents oversell/stockout', async (t) => {
  ready(allocation());
  held(change(allocation(), ['allocation', 'reservation_ref'], ''));
  held(change(allocation(), ['allocation', 'release_ref'], 'UNKNOWN'));
  held(change(allocation(), ['allocation', 'reconciled'], false));
  held(change(allocation(), ['allocation', 'available_quantity'], 4));
  held(change(allocation(), ['allocation', 'available_quantity'], -1));
  held(change(allocation(), ['allocation', 'available_quantity'], Number.NaN));
  const stockout = allocation({ status: 'held', allocation: { ...allocation().allocation, available_quantity: 0, stockout: true } });
  stockout.exceptions = [{ type: 'missing', owner_actor_id: 'actor-synthetic-owner', due_at: T1, native_ref: 'stockout-native-synthetic' }];
  held(stockout);
  const oversell = allocation({ status: 'held', allocation: { ...allocation().allocation, available_quantity: 4, oversell: true } });
  oversell.exceptions = [{ type: 'capacity_shortfall', owner_actor_id: 'actor-synthetic-owner', due_at: T1, native_ref: 'oversell-native-synthetic' }];
  held(oversell);
});

test('wholesale evidence, accountable receipts, and conditional deductions are enforced', async (t) => {
  ready(wholesale());
  for (const key of ['contract_ref', 'edi_ref', 'label_ref', 'otif_ref', 'obligation_ref']) {
    await t.test(`missing ${key}`, () => held(change(wholesale(), ['wholesale', key], '')));
  }
  for (const key of ['invoice_ref', 'shipment_ref']) held(change(wholesale(), ['wholesale', key], ''));
  held(wholesale(), context({ allowed_wholesale_shipment_states: ['proposal'] }));
  held(change(wholesale(), ['wholesale', 'shipment_status'], 'unapproved-state'));
  held(wholesale({ shipment: 'unapproved-top-level-shipment-claim' }));
  held(change(wholesale(), ['wholesale', 'operator_receipt'], ''));
  held(change(wholesale(), ['wholesale', 'controller_receipt'], ''));
  const deduction = wholesale();
  deduction.wholesale.deduction_state = 'disputed';
  deduction.wholesale.deduction_evidence_ref = 'deduction-evidence-synthetic';
  deduction.wholesale.collection_date = '2026-10-06T00:00:00.000Z';
  ready(deduction);
  delete deduction.wholesale.deduction_evidence_ref;
  held(deduction);
  const missingCollection = wholesale();
  missingCollection.wholesale.deduction_state = 'disputed';
  missingCollection.wholesale.deduction_evidence_ref = 'deduction-evidence-synthetic';
  delete missingCollection.wholesale.collection_date;
  held(missingCollection);
  const futureCollection = wholesale();
  futureCollection.wholesale.collection_date = '2026-10-06';
  held(futureCollection);
});

test('reverse logistics references and remedy states remain distinct', async (t) => {
  ready(reverse());
  for (const key of ['original_sale_ref', 'return_or_repair_ref', 'inspection_ref']) {
    await t.test(`missing ${key}`, () => held(change(reverse(), ['reverse_logistics', key], '')));
  }
  held(change(reverse(), ['reverse_logistics', 'return_or_repair_ref'], 'sale-synthetic-01'));
  held(change(reverse(), ['reverse_logistics', 'inspection_ref'], 'return-synthetic-01'));
  held(change(reverse(), ['reverse_logistics', 'refund_ref'], 'replacement-synthetic-01'));
  held(change(reverse(), ['reverse_logistics', 'replacement_ref'], 'refund-synthetic-01'));
  held(change(reverse(), ['reverse_logistics', 'stock_treatment'], 'available'));
  held(reverse(), context({ allowed_stock_treatments: [] }));
  held(change(reverse(), ['reverse_logistics', 'return_state'], 'invented-return-state'));
  held(change(reverse(), ['reverse_logistics', 'refund_state'], 'invented-refund-state'));
  held(change(reverse(), ['reverse_logistics', 'replacement_state'], 'invented-replacement-state'));
  held(change(reverse(), ['reverse_logistics', 'complaint_state'], 'invented-complaint-state'));
  held(reverse(), context({ allowed_return_states: [] }));
});

test('typed exceptions require accepted accountable owner, due time, and native reference', async (t) => {
  const types = ['late', 'missing', 'rejected', 'capacity_shortfall'];
  for (const type of types) {
    const handoff = base();
    handoff.exceptions = [{ type, owner_actor_id: 'actor-synthetic-owner', due_at: T1, native_ref: `exception-${type}-synthetic` }];
    held(handoff);
    for (const [field, bad] of [['owner_actor_id', 'actor-unknown'], ['due_at', 'UNKNOWN'], ['native_ref', '']]) {
      const invalid = structuredClone(handoff);
      invalid.exceptions[0][field] = bad;
      held(invalid);
    }
  }
  const expiredDeadline = '2026-10-05T09:59:59.999Z';
  const expiredAckRecord = { ...ACK_RECORD, next_deadline: expiredDeadline };
  const lateWithoutException = base('receiving_to_stock', {
    acknowledgment: { ...base().acknowledgment, next_deadline: expiredDeadline, source_record: { ...expiredAckRecord } },
  });
  held(lateWithoutException, context({ immutable_acknowledgments: [expiredAckRecord] }));
  const lateOwned = base('receiving_to_stock', {
    status: 'held',
    acknowledgment: { ...base().acknowledgment, next_deadline: expiredDeadline, source_record: { ...expiredAckRecord } },
    exceptions: [{ type: 'late', owner_actor_id: 'actor-synthetic-backup', due_at: T1, native_ref: 'late-native-synthetic' }],
  });
  held(lateOwned, context({ immutable_acknowledgments: [expiredAckRecord] }));
  const wrongExceptionOwner = structuredClone(lateOwned);
  wrongExceptionOwner.exceptions[0].owner_actor_id = 'actor-unaccepted-synthetic';
  held(wrongExceptionOwner);
  for (const state of ['open', 'acknowledged']) ready(base('receiving_to_stock', { status: state }));
  held(base('receiving_to_stock', { status: 'held' }));
  held(base('receiving_to_stock', { status: 'mystery' }));
  held(base('receiving_to_stock', { exception_states: [{ state: 'closed' }] }));
});

test('closed status requires terminal and recipient evidence; unresolved exceptions cannot be hidden', async () => {
  const closed = base('receiving_to_stock', {
    status: 'closed',
    terminal_receipt: 'terminal-synthetic',
    recipient_receipt: 'recipient-synthetic',
  });
  ready(closed);
  held(change(closed, ['terminal_receipt'], ''));
  held(change(closed, ['recipient_receipt'], ''));
  const unresolved = { ...closed, exceptions: [{ type: 'late', owner_actor_id: 'actor-synthetic-owner', due_at: T1, native_ref: 'late-native-synthetic' }] };
  held(unresolved);
});

test('malformed containers never pass and validation is a pure function', async (t) => {
  for (const bad of [null, {}, [], 'handoff']) await t.test(String(bad), () => held(bad));
  const h = base();
  const c = context();
  const beforeH = structuredClone(h);
  const beforeC = structuredClone(c);
  const result = validate(h, c);
  assert.equal(result.status, 'ready');
  assert.deepEqual(h, beforeH);
  assert.deepEqual(c, beforeC);
});

test('test artifacts are source-free and contain no external IO logic', () => {
  const ownPath = new URL(import.meta.url).pathname;
  const source = readFileSync(ownPath, 'utf8');
  assert.doesNotMatch(source, /fetch\s*\(|https?:\/\//i);
  assert.equal(createHash('sha256').update(source).digest('hex').length, 64);
});
