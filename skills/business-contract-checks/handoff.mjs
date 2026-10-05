const STAGES = new Set([
  'demand_to_procurement', 'receiving_to_stock', 'stock_to_channels',
  'wholesale_po_to_cash', 'physical_return_to_disposition',
]);
const STATUSES = new Set(['open', 'held', 'acknowledged', 'closed']);
const EXCEPTION_TYPES = new Set(['late', 'missing', 'rejected', 'capacity_shortfall']);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function usableString(value) {
  return typeof value === 'string' && value.trim() !== '' && value.trim().toUpperCase() !== 'UNKNOWN';
}

function strictTimestamp(value) {
  if (!usableString(value)) return false;
  // Require an explicit timezone; Date.parse alone accepts local/ambiguous forms.
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value)) return false;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return false;
  const components = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d+)?(Z|[+-](\d\d):(\d\d))$/.exec(value);
  if (!components) return false;
  const [, , , , hour, minute, second, zone, offsetHour, offsetMinute] = components;
  if (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return false;
  if (zone !== 'Z' && (Number(offsetHour) > 23 || Number(offsetMinute) > 59)) return false;
  const date = value.slice(0, 10);
  const [year, month, day] = date.split('-').map(Number);
  const check = new Date(Date.UTC(year, month - 1, day));
  return check.getUTCFullYear() === year && check.getUTCMonth() === month - 1 && check.getUTCDate() === day;
}

function same(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => same(v, b[i]));
  }
  if (isRecord(a) && isRecord(b)) {
    const ak = Object.keys(a).sort();
    const bk = Object.keys(b).sort();
    return ak.length === bk.length && ak.every((k, i) => k === bk[i] && same(a[k], b[k]));
  }
  return false;
}

function nowMs(now) {
  if (now instanceof Date) return now.getTime();
  if (typeof now === 'number' && Number.isFinite(now)) return now;
  if (strictTimestamp(now)) return Date.parse(now);
  return NaN;
}

function validateHandoff(handoff, context, now) {
  const errors = [];
  const add = (condition, message) => { if (!condition) errors.push(message); };
  const reqString = (obj, key, label = key) => {
    add(isRecord(obj) && usableString(obj[key]), `${label} must be a nonblank known string`);
  };
  const reqTimestamp = (obj, key, label = key) => {
    add(isRecord(obj) && strictTimestamp(obj[key]), `${label} must be an ISO timestamp with an explicit timezone`);
  };
  const validQty = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const nowValue = nowMs(now);
  add(Number.isFinite(nowValue), 'now must be a valid Date, epoch milliseconds, or zoned ISO timestamp');

  add(isRecord(handoff), 'handoff must be an object');
  add(isRecord(context), 'context must be an object');
  if (!isRecord(handoff) || !isRecord(context)) return { status: 'hold', errors };

  add(STATUSES.has(handoff.status), 'status must be open, held, acknowledged, or closed');
  add(STAGES.has(handoff.workflow_stage), 'workflow_stage is not supported');
  for (const key of ['entity_id', 'sku', 'revision', 'channel', 'location_id']) reqString(handoff, key, key);
  add(validQty(handoff.quantity) && handoff.quantity > 0, 'quantity must be a positive finite number');
  reqString(handoff, 'unit');

  const stageFields = {
    demand_to_procurement: ['receiving', 'allocation', 'wholesale', 'reverse_logistics'],
    receiving_to_stock: ['draft_po', 'allocation', 'wholesale', 'reverse_logistics'],
    stock_to_channels: ['draft_po', 'receiving', 'wholesale', 'reverse_logistics'],
    wholesale_po_to_cash: ['draft_po', 'receiving', 'allocation', 'reverse_logistics'],
    physical_return_to_disposition: ['draft_po', 'receiving', 'allocation', 'wholesale'],
  };
  for (const key of stageFields[handoff.workflow_stage] ?? []) {
    add(handoff[key] === undefined, `${key} evidence is not allowed outside its workflow stage`);
  }
  for (const key of ['shipment', 'shipment_ref', 'shipment_status', 'invoice_ref']) {
    add(handoff[key] === undefined, `top-level ${key} claim is not allowed; shipment evidence belongs inside wholesale stage`);
  }
  if (handoff.status !== 'closed') {
    add(handoff.terminal_receipt === undefined && handoff.recipient_receipt === undefined,
      'terminal/recipient receipts are only allowed when status is closed');
  }

  const snapshot = handoff.source_snapshot;
  const expected = context.source_snapshot;
  add(isRecord(snapshot), 'source_snapshot must be an object');
  add(isRecord(expected), 'context.source_snapshot must be an object');
  if (isRecord(snapshot) && isRecord(expected)) {
    for (const key of ['entity_id', 'sku', 'revision', 'channel', 'location_id']) {
      add(usableString(snapshot[key]), `source_snapshot.${key} must be a nonblank known string`);
      add(snapshot[key] === handoff[key], `source_snapshot.${key} must exactly match handoff.${key}`);
      add(snapshot[key] === expected[key], `source_snapshot.${key} must exactly match current context snapshot`);
    }
    reqTimestamp(snapshot, 'as_of', 'source_snapshot.as_of');
    add(snapshot.as_of === expected.as_of, 'source_snapshot.as_of must exactly match current context snapshot');
    reqString(snapshot, 'evidence_ref', 'source_snapshot.evidence_ref');
    reqString(snapshot, 'source_version', 'source_snapshot.source_version');
    reqString(context, 'current_source_version', 'context.current_source_version');
    add(snapshot.source_version === context.current_source_version, 'source_snapshot.source_version must equal current context source version');
    add(snapshot.evidence_ref === expected.evidence_ref && snapshot.source_version === expected.source_version,
      'source snapshot evidence reference/version must exactly match current context snapshot');
  }
  const maxAge = context.max_age_ms;
  add(typeof maxAge === 'number' && Number.isFinite(maxAge) && maxAge >= 0, 'context.max_age_ms must be an explicit nonnegative finite number');
  if (strictTimestamp(snapshot?.as_of) && Number.isFinite(nowValue) && typeof maxAge === 'number') {
    const age = nowValue - Date.parse(snapshot.as_of);
    add(age >= 0 && age <= maxAge, 'source snapshot is stale or from the future');
  }

  const checkCustodian = (custodian, label) => {
    add(isRecord(custodian), `${label} must be an object`);
    if (!isRecord(custodian)) return;
    reqString(custodian, 'actor_id', `${label}.actor_id`);
    add(custodian.accepted === true, `${label} must be explicitly accepted`);
    add(isRecord(custodian.coverage), `${label}.coverage must be an object`);
    if (isRecord(custodian.coverage)) {
      reqString(custodian.coverage, 'receipt_id', `${label}.coverage.receipt_id`);
      reqTimestamp(custodian.coverage, 'starts_at', `${label}.coverage.starts_at`);
      reqTimestamp(custodian.coverage, 'ends_at', `${label}.coverage.ends_at`);
      if (strictTimestamp(custodian.coverage.starts_at) && strictTimestamp(custodian.coverage.ends_at) && Number.isFinite(nowValue)) {
        add(Date.parse(custodian.coverage.starts_at) <= nowValue && nowValue < Date.parse(custodian.coverage.ends_at), `${label} coverage is not current`);
      }
    }
  };
  checkCustodian(handoff.owner, 'owner');
  checkCustodian(handoff.backup, 'backup');
  add(usableString(handoff.owner?.actor_id) && usableString(handoff.backup?.actor_id) && handoff.owner.actor_id !== handoff.backup.actor_id,
    'owner and backup must be distinct actors');

  add(isRecord(handoff.native), 'native must be an object');
  if (isRecord(handoff.native)) {
    for (const k of ['system_id', 'location_id', 'reference_id', 'entity_id', 'sku', 'revision', 'channel', 'unit', 'evidence_ref', 'source_version']) reqString(handoff.native, k, `native.${k}`);
    reqTimestamp(handoff.native, 'as_of', 'native.as_of');
    add(handoff.native.location_id === handoff.location_id, 'native.location_id must exactly match handoff.location_id');
    for (const key of ['entity_id', 'sku', 'revision', 'channel', 'unit']) add(handoff.native[key] === handoff[key], `native.${key} must exactly match handoff`);
    add(handoff.native.source_version === context.current_source_version, 'native.source_version must equal current context source version');
    const nativeRecords = Array.isArray(context.immutable_native_records) ? context.immutable_native_records : [];
    const nativeMatches = nativeRecords.filter((record) => same(record, handoff.native)).length;
    const nativeIdentityMatches = nativeRecords.filter((record) => record?.system_id === handoff.native.system_id &&
      record?.reference_id === handoff.native.reference_id && record?.evidence_ref === handoff.native.evidence_ref &&
      record?.source_version === handoff.native.source_version).length;
    add(nativeMatches === 1 && nativeIdentityMatches === 1, 'native evidence must exactly match one immutable record with a unique native identity');
    if (strictTimestamp(handoff.native.as_of) && Number.isFinite(nowValue) && typeof maxAge === 'number') {
      const age = nowValue - Date.parse(handoff.native.as_of);
      add(age >= 0 && age <= maxAge, 'native evidence is stale or from the future');
    }
  }

  for (const key of ['capacity', 'inventory']) {
    const item = handoff[key];
    add(isRecord(item), `${key} must be an object`);
    if (!isRecord(item)) continue;
    add(validQty(item.quantity), `${key}.quantity must be a nonnegative finite number`);
    reqString(item, 'unit', `${key}.unit`);
    add(item.unit === handoff.unit, `${key}.unit must match handoff.unit`);
    reqTimestamp(item, 'as_of', `${key}.as_of`);
    reqString(item, 'evidence_ref', `${key}.evidence_ref`);
    reqString(item, 'source_version', `${key}.source_version`);
    const expectedBasis = key === 'capacity' ? 'physical_usable_capacity' : 'accepted_available_stock';
    add(item.basis === expectedBasis, `${key}.basis must be ${expectedBasis}`);
    const expectedScope = key === 'capacity' ? 'physical_capacity' : 'available_stock';
    add(item.scope === expectedScope, `${key}.scope must be ${expectedScope}; retailer-volume or unknown scopes are not physical evidence`);
    for (const field of ['entity_id', 'sku', 'revision', 'channel', 'location_id']) {
      reqString(item, field, `${key}.${field}`);
      add(item[field] === handoff[field], `${key}.${field} must exactly match handoff`);
    }
    add(item.source_version === context.current_source_version, `${key}.source_version must equal current context source version`);
    const recordsName = key === 'capacity' ? 'immutable_capacity_records' : 'immutable_inventory_records';
    const records = Array.isArray(context[recordsName]) ? context[recordsName] : [];
    const matches = records.filter((record) => same(record, item)).length;
    const identityMatches = records.filter((record) => ['evidence_ref', 'source_version', 'entity_id', 'sku', 'revision', 'channel', 'location_id', 'unit', 'scope']
      .every((field) => record?.[field] === item[field])).length;
    add(matches === 1 && identityMatches === 1, `${key} evidence must exactly match one immutable record with a unique physical-evidence identity`);
    if (strictTimestamp(item.as_of) && Number.isFinite(nowValue) && typeof maxAge === 'number') {
      const age = nowValue - Date.parse(item.as_of);
      add(age >= 0 && age <= maxAge, `${key} evidence is stale or from the future`);
    }
  }
  add(validQty(handoff.capacity?.quantity) && validQty(handoff.quantity) && handoff.quantity <= handoff.capacity.quantity,
    'requested quantity exceeds accepted usable physical capacity');
  add(validQty(handoff.inventory?.quantity) && validQty(handoff.quantity) && handoff.quantity <= handoff.inventory.quantity,
    'requested quantity exceeds evidenced inventory');

  const ack = handoff.acknowledgment;
  add(isRecord(ack), 'acknowledgment must be an object');
  if (isRecord(ack)) {
    reqString(ack, 'supplier_id', 'acknowledgment.supplier_id');
    add(ack.acknowledged === true, 'supplier/3PL acknowledgment must be explicit');
    reqString(ack, 'reference_id', 'acknowledgment.reference_id');
    reqTimestamp(ack, 'acknowledged_at', 'acknowledgment.acknowledged_at');
    reqTimestamp(ack, 'next_deadline', 'acknowledgment.next_deadline');
    if (strictTimestamp(ack.acknowledged_at)) add(Date.parse(ack.acknowledged_at) <= nowValue, 'acknowledgment timestamp is in the future');
    if (strictTimestamp(ack.next_deadline) && Date.parse(ack.next_deadline) < nowValue) {
      const lateOwned = Array.isArray(handoff.exceptions) && handoff.exceptions.some((e) =>
        e?.type === 'late' && (e.owner_actor_id === handoff.owner?.actor_id || e.owner_actor_id === handoff.backup?.actor_id) &&
        strictTimestamp(e.due_at) && usableString(e.native_ref));
      add(lateOwned, 'past next deadline requires a typed late exception owned by the accepted owner or backup');
    }
    add(isRecord(ack.source_record), 'acknowledgment.source_record is required and must be an object');
    if (isRecord(ack.source_record)) {
      for (const field of ['entity_id', 'sku', 'revision', 'channel', 'location_id', 'quantity', 'unit', 'supplier_id', 'reference_id', 'acknowledged', 'acknowledged_at', 'next_deadline']) {
        add(Object.hasOwn(ack.source_record, field), `acknowledgment.source_record.${field} is required`);
      }
      for (const field of ['entity_id', 'sku', 'revision', 'channel', 'location_id', 'quantity', 'unit']) {
        add(ack.source_record[field] === handoff[field], `acknowledgment.source_record.${field} must exactly match handoff`);
      }
      for (const field of ['supplier_id', 'reference_id', 'acknowledged', 'acknowledged_at', 'next_deadline']) {
        add(ack.source_record[field] === ack[field], `acknowledgment.source_record.${field} must exactly match acknowledgment`);
      }
    }
    const ackRecords = Array.isArray(context.immutable_acknowledgments) ? context.immutable_acknowledgments : [];
    const ackMatches = ackRecords.filter((record) => same(record, ack.source_record)).length;
    const ackIdentityMatches = ackRecords.filter((record) => record?.supplier_id === ack.source_record?.supplier_id &&
      record?.reference_id === ack.source_record?.reference_id).length;
    add(ackMatches === 1 && ackIdentityMatches === 1, 'acknowledgment.source_record must deeply equal one immutable acknowledgment with a unique supplier/reference identity');
  }

  const exceptions = handoff.exceptions ?? [];
  add(Array.isArray(exceptions), 'exceptions must be an array when supplied');
  if (Array.isArray(exceptions)) {
    for (const [index, exception] of exceptions.entries()) {
      const label = `exceptions[${index}]`;
      add(isRecord(exception), `${label} must be an object`);
      if (!isRecord(exception)) continue;
      add(EXCEPTION_TYPES.has(exception.type), `${label}.type must be late, missing, rejected, or capacity_shortfall`);
      reqString(exception, 'owner_actor_id', `${label}.owner_actor_id`);
      reqTimestamp(exception, 'due_at', `${label}.due_at`);
      reqString(exception, 'native_ref', `${label}.native_ref`);
      add(exception.owner_actor_id === handoff.owner?.actor_id || exception.owner_actor_id === handoff.backup?.actor_id,
        `${label}.owner_actor_id must be the accepted owner or backup`);
    }
  }
  const exceptionStates = handoff.exception_states ?? [];
  add(Array.isArray(exceptionStates), 'exception_states must be an array when supplied');
  if (Array.isArray(exceptionStates)) {
    for (const state of exceptionStates) add(EXCEPTION_TYPES.has(state), 'exception_states contains an unsupported exception state');
    for (const type of exceptionStates) {
      if (EXCEPTION_TYPES.has(type)) add(Array.isArray(exceptions) && exceptions.some((item) => item?.type === type), `exception state ${type} requires a typed owned exception`);
    }
  }

  if (handoff.workflow_stage === 'demand_to_procurement') {
    const po = handoff.draft_po;
    add(isRecord(po), 'draft_po must be an object');
    if (isRecord(po)) {
      add(po.state === 'proposal' || po.state === 'accepted', 'draft_po.state must be proposal or accepted');
      reqString(po, 'unit', 'draft_po.unit');
      add(po.unit === handoff.unit, 'draft_po.unit must exactly match handoff.unit');
      if (po.state === 'accepted') {
        const authority = po.authority;
        add(isRecord(authority), 'accepted draft PO requires exact authority evidence');
        if (isRecord(authority)) {
          add(authority.accepted === true, 'draft PO authority must be explicitly accepted');
          for (const key of ['receipt_id', 'actor_id', 'entity_id', 'operation']) reqString(authority, key, `draft_po.authority.${key}`);
          reqString(authority, 'unit', 'draft_po.authority.unit');
          add(authority.unit === handoff.unit, 'draft PO authority unit must exactly match handoff.unit');
          add(authority.actor_id === po.actor_id && authority.actor_id === handoff.owner?.actor_id, 'draft PO authority actor must match accepted owner');
          add(authority.entity_id === handoff.entity_id && po.entity_id === handoff.entity_id, 'draft PO authority entity must exactly match handoff');
          add(authority.operation === po.operation && usableString(po.operation), 'draft PO authority operation must exactly match requested operation');
          add(Array.isArray(context.allowed_po_operations) && context.allowed_po_operations.includes(po.operation),
            'draft PO operation must be explicitly allowed by current context');
          add(validQty(authority.limit_quantity) && validQty(po.limit_quantity) && po.limit_quantity <= authority.limit_quantity && handoff.quantity <= po.limit_quantity,
            'draft PO quantity exceeds explicit authority limit');
          reqTimestamp(authority, 'window_start', 'draft_po.authority.window_start');
          reqTimestamp(authority, 'window_end', 'draft_po.authority.window_end');
          add(authority.window_start === po.window_start && authority.window_end === po.window_end, 'draft PO window must exactly match authority window');
          if (strictTimestamp(authority.window_start) && strictTimestamp(authority.window_end)) {
            add(Date.parse(authority.window_start) <= nowValue && nowValue < Date.parse(authority.window_end), 'draft PO authority window is not current');
          }
        }
        add(isRecord(ack) && ack.acknowledged === true, 'accepted draft PO remains non-executable without supplier acknowledgment');
      }
      // This contract validates proposal evidence only. It never transmits or executes a PO.
    }
  }

  if (handoff.workflow_stage === 'receiving_to_stock') {
    const r = handoff.receiving;
    add(isRecord(r), 'receiving details are required');
    if (isRecord(r)) {
      add(validQty(r.quantity) && r.quantity > 0 && r.quantity <= handoff.quantity, 'receiving.quantity must be positive and not exceed handoff quantity');
      add(typeof r.lot_serial_applicable === 'boolean', 'receiving.lot_serial_applicable must be an explicit boolean');
      if (r.lot_serial_applicable === true) reqString(r, 'lot_serial_ref', 'receiving.lot_serial_ref');
      add(['accept', 'hold', 'reject'].includes(r.quality_disposition), 'receiving.quality_disposition must be accept, hold, or reject');
      reqString(r, 'native_receipt_ref', 'receiving.native_receipt_ref');
      if (r.quality_disposition === 'hold' || r.quality_disposition === 'reject') {
        add(validQty(handoff.available_quantity) && handoff.available_quantity === 0, 'held/rejected receiving stock must have zero available quantity');
        add(handoff.status === 'held', 'held/rejected receiving stock must leave overall handoff held');
      }
      if (validQty(r.quantity) && validQty(handoff.quantity) && r.quantity < handoff.quantity) {
        add(handoff.status === 'held', 'partial receiving must leave overall handoff held');
        add(Array.isArray(exceptions) && exceptions.some((e) =>
          ['missing', 'rejected', 'capacity_shortfall'].includes(e?.type) &&
          (e.owner_actor_id === handoff.owner?.actor_id || e.owner_actor_id === handoff.backup?.actor_id) &&
          strictTimestamp(e.due_at) && usableString(e.native_ref)),
        'partial receiving requires a typed owned missing, rejected, or capacity_shortfall exception');
      }
    }
  }
  if (handoff.workflow_stage === 'stock_to_channels') {
    const a = handoff.allocation;
    add(isRecord(a), 'allocation details are required');
    if (isRecord(a)) {
      reqString(a, 'reservation_ref', 'allocation.reservation_ref');
      reqString(a, 'release_ref', 'allocation.release_ref');
      add(a.reconciled === true, 'allocation requires native reservation/release reconciliation');
      add(typeof a.stockout === 'boolean', 'allocation.stockout must be an explicit boolean');
      add(typeof a.oversell === 'boolean', 'allocation.oversell must be an explicit boolean');
      add(validQty(a.available_quantity), 'allocation.available_quantity must be a nonnegative finite number');
      add(validQty(a.available_quantity) && a.available_quantity >= handoff.quantity, 'allocation exceeds reconciled available stock');
      if (a.stockout === true || a.oversell === true) {
        add(handoff.status === 'held', 'oversell/stockout must leave overall handoff held');
        add(Array.isArray(exceptions) && exceptions.some((e) => e?.owner_actor_id && (e.owner_actor_id === handoff.owner?.actor_id || e.owner_actor_id === handoff.backup?.actor_id) && e?.due_at && e?.native_ref), 'oversell/stockout must be held with an owned exception');
      }
    }
  }
  if (handoff.workflow_stage === 'wholesale_po_to_cash') {
    const w = handoff.wholesale;
    add(isRecord(w), 'wholesale obligation details are required');
    if (isRecord(w)) {
      for (const key of ['contract_ref', 'edi_ref', 'label_ref', 'otif_ref', 'obligation_ref', 'operator_receipt', 'controller_receipt', 'invoice_ref', 'shipment_ref']) reqString(w, key, `wholesale.${key}`);
      add(usableString(w.shipment_status) && Array.isArray(context.allowed_wholesale_shipment_states) && context.allowed_wholesale_shipment_states.includes(w.shipment_status),
        'wholesale.shipment_status must be explicitly allowed by current context');
      reqString(w, 'deduction_state', 'wholesale.deduction_state');
      if (w.deduction_state !== 'none') reqString(w, 'deduction_evidence_ref', 'wholesale.deduction_evidence_ref');
      reqTimestamp(w, 'collection_date', 'wholesale.collection_date'); // status evidence only; no money action
    }
  }
  if (handoff.workflow_stage === 'physical_return_to_disposition') {
    const r = handoff.reverse_logistics;
    add(isRecord(r), 'reverse-logistics details are required');
    if (isRecord(r)) {
      for (const key of ['original_sale_ref', 'return_or_repair_ref', 'inspection_ref', 'stock_treatment', 'remedy_ref', 'refund_ref', 'replacement_ref', 'complaint_ref']) reqString(r, key, `reverse_logistics.${key}`);
      add(Array.isArray(context.allowed_stock_treatments) && context.allowed_stock_treatments.length > 0 &&
        context.allowed_stock_treatments.every(usableString) && context.allowed_stock_treatments.includes(r.stock_treatment),
      'reverse_logistics.stock_treatment must exactly match an explicitly allowed current-context stock treatment');
      const refs = ['remedy_ref', 'refund_ref', 'replacement_ref', 'complaint_ref'].map((key) => r[key]);
      add(refs.every(usableString) && new Set(refs).size === refs.length, 'remedy, refund, replacement, and complaint references must remain distinct');
      add(usableString(r.original_sale_ref) && usableString(r.return_or_repair_ref) && r.original_sale_ref !== r.return_or_repair_ref,
        'original-sale and return/repair references must remain distinct');
      add(usableString(r.inspection_ref) && r.inspection_ref !== r.original_sale_ref && r.inspection_ref !== r.return_or_repair_ref,
        'inspection reference must remain distinct from original-sale and return/repair references');
      for (const [field, listName] of [
        ['return_state', 'allowed_return_states'], ['refund_state', 'allowed_refund_states'],
        ['replacement_state', 'allowed_replacement_states'], ['complaint_state', 'allowed_complaint_states'],
      ]) {
        reqString(r, field, `reverse_logistics.${field}`);
        add(Array.isArray(context[listName]) && context[listName].includes(r[field]), `${field} must be explicitly allowed by current context`);
      }
    }
  }

  if (handoff.status === 'closed') {
    reqString(handoff, 'terminal_receipt', 'terminal_receipt');
    reqString(handoff, 'recipient_receipt', 'recipient_receipt');
    add(Array.isArray(exceptions) && exceptions.length === 0, 'closed handoff cannot have unresolved exceptions');
    add(!(Array.isArray(exceptionStates) && exceptionStates.length), 'closed handoff cannot have unresolved exception states');
  }
  if (handoff.exceptions?.length || handoff.exception_states?.length) {
    add(handoff.status === 'held', 'any open exception requires overall held status');
  }
  if (handoff.status === 'held') errors.push('held handoff is not ready for growth admission');
  if ((handoff.status === 'acknowledged' || handoff.status === 'closed') && (handoff.exceptions?.length || handoff.exception_states?.length)) {
    errors.push('acknowledged/closed status contradicts unresolved exceptions');
  }
  if (handoff.status === 'acknowledged' || handoff.status === 'closed') {
    add(isRecord(ack) && ack.acknowledged === true, 'acknowledged/closed status requires explicit supplier acknowledgment');
  }

  return { status: errors.length === 0 ? 'ready' : 'hold', errors };
}

function evaluateGrowthAdmission(handoff, context, now) {
  return validateHandoff(handoff, context, now);
}

export { validateHandoff, evaluateGrowthAdmission };
