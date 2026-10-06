import { opaqueReference, strictTimestamp, metadataErrors } from './metadata-only.mjs';
const RECORD_KINDS = ['stock', 'payment', 'promise', 'capacity'];
const EXCEPTION_TYPES = new Set(['late', 'missing', 'rejected', 'capacity_shortfall']);
const PAYMENT_STATES = new Set(['settled', 'authorized']);

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const known = opaqueReference;
const timestamp = strictTimestamp;
const same = (a, b) => {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => same(x, b[i]));
  if (isRecord(a) && isRecord(b)) {
    const ak = Object.keys(a).sort(), bk = Object.keys(b).sort();
    return ak.length === bk.length && ak.every((key, i) => key === bk[i] && same(a[key], b[key]));
  }
  return false;
};

/** Validate source-free draft metadata. This is not an order or payment authorization. */
export function validateCommerceFreshness(input) {
  const envelope = { readiness_scope: 'draft_review_only', activation: 'disabled', live_authorization: false };
  const reasons = metadataErrors(input).map(code => ({ code, field: '$' }));
  if (reasons.length) return { status: 'hold', reason_codes: reasons, ...envelope };
  const add = (condition, code, field) => { if (!condition) reasons.push({ code, field }); };
  if (!isRecord(input)) return { status: 'hold', reason_codes: [{ code: 'INVALID_INPUT', field: '$' }], ...envelope };
  const { stock, payment, promise, fulfillment, context } = input;
  add(isRecord(context), 'MISSING_CONTEXT', 'context');
  if (!isRecord(context)) return { status: 'hold', reason_codes: reasons, ...envelope };
  const nowMs = timestamp(context.now) ? Date.parse(context.now) : NaN;
  add(Number.isFinite(nowMs), 'INVALID_NOW', 'context.now');
  const requested = context.requested_quantity;
  add(typeof requested === 'number' && Number.isFinite(requested) && requested > 0, 'INVALID_REQUESTED_QUANTITY', 'context.requested_quantity');
  const thresholds = context.freshness_thresholds_ms;
  add(isRecord(thresholds), 'MISSING_FRESHNESS_THRESHOLDS', 'context.freshness_thresholds_ms');
  for (const kind of ['stock', 'payment']) {
    const limit = thresholds?.[kind];
    add(typeof limit === 'number' && Number.isFinite(limit) && limit >= 0, 'INVALID_FRESHNESS_THRESHOLD', `context.freshness_thresholds_ms.${kind}`);
  }
  const scope = context.scope;
  add(isRecord(scope), 'MISSING_SCOPE', 'context.scope');
  for (const field of ['sku', 'location_id', 'channel']) add(known(scope?.[field]), 'INVALID_SCOPE', `context.scope.${field}`);
  add(isRecord(context.current_source_versions), 'MISSING_CURRENT_SOURCE_VERSIONS', 'context.current_source_versions');
  add(Array.isArray(context.immutable_native_records), 'MISSING_NATIVE_RECORDS', 'context.immutable_native_records');

  const checkSource = (kind, item) => {
    const source = item?.source;
    add(isRecord(item), `MISSING_${kind.toUpperCase()}`, kind);
    add(isRecord(source), 'MISSING_NATIVE_SOURCE', `${kind}.source`);
    if (!isRecord(source)) return;
    for (const field of ['system_id', 'reference_id', 'evidence_ref', 'source_version']) add(known(source[field]), 'INVALID_NATIVE_LINK', `${kind}.source.${field}`);
    add(timestamp(source.as_of), 'INVALID_SOURCE_TIMESTAMP', `${kind}.source.as_of`);
    add(isRecord(source.scope), 'INVALID_SOURCE_SCOPE', `${kind}.source.scope`);
    for (const field of ['sku', 'location_id', 'channel']) {
      add(source.scope?.[field] === scope?.[field], 'SOURCE_SCOPE_MISMATCH', `${kind}.source.scope.${field}`);
    }
    add(source.source_version === context.current_source_versions?.[kind], 'SOURCE_VERSION_MISMATCH', `${kind}.source.source_version`);
    const records = Array.isArray(context.immutable_native_records) ? context.immutable_native_records : [];
    const matches = records.filter((record) => record?.kind === kind && same(record?.source, source));
    const identities = records.filter((record) => record?.kind === kind && record?.source?.system_id === source.system_id && record?.source?.reference_id === source.reference_id && record?.source?.evidence_ref === source.evidence_ref);
    add(matches.length === 1 && identities.length === 1, 'NATIVE_RECORD_NOT_UNIQUELY_VERIFIED', `${kind}.source`);
    const expected = kind === 'payment' ? { status: item.status, payment_ref: item.payment_ref } : kind === 'promise' ? { version: item.version } : { available_quantity: item.available_quantity };
    add(matches.length === 1 && same(matches[0].facts, expected), 'NATIVE_FACTS_MISMATCH', kind);
    if (['stock', 'payment'].includes(kind) && timestamp(source.as_of) && Number.isFinite(nowMs) && typeof thresholds?.[kind] === 'number' && Number.isFinite(thresholds[kind])) {
      const age = nowMs - Date.parse(source.as_of);
      add(age >= 0 && age <= thresholds[kind], `${kind.toUpperCase()}_STALE`, `${kind}.source.as_of`);
    }
  };

  checkSource('stock', stock);
  add(typeof stock?.available_quantity === 'number' && Number.isFinite(stock.available_quantity) && stock.available_quantity >= requested, 'STOCK_INSUFFICIENT', 'stock.available_quantity');
  checkSource('payment', payment);
  add(Array.isArray(context.accepted_payment_states) && context.accepted_payment_states.length > 0 && context.accepted_payment_states.every(state => PAYMENT_STATES.has(state)), 'MISSING_PAYMENT_POLICY', 'context.accepted_payment_states');
  add(Array.isArray(context.accepted_payment_states) && context.accepted_payment_states.includes(payment?.status), 'PAYMENT_NOT_CONFIRMED', 'payment.status');
  add(known(payment?.payment_ref), 'PAYMENT_REFERENCE_MISSING', 'payment.payment_ref');

  checkSource('promise', promise);
  add(known(context.current_promise_version), 'MISSING_CURRENT_PROMISE_VERSION', 'context.current_promise_version');
  add(promise?.version === context.current_promise_version, 'PROMISE_VERSION_MISMATCH', 'promise.version');
  add(promise?.source?.source_version === context.current_source_versions?.promise, 'PROMISE_SOURCE_VERSION_MISMATCH', 'promise.source.source_version');

  checkSource('capacity', fulfillment?.capacity);
  add(typeof fulfillment?.capacity?.available_quantity === 'number' && Number.isFinite(fulfillment.capacity.available_quantity) && fulfillment.capacity.available_quantity >= requested, 'CAPACITY_INSUFFICIENT', 'fulfillment.capacity.available_quantity');
  add(isRecord(fulfillment), 'MISSING_FULFILLMENT', 'fulfillment');
  const exceptions = fulfillment?.exceptions;
  add(Array.isArray(exceptions), 'MISSING_FULFILLMENT_EXCEPTIONS', 'fulfillment.exceptions');
  if (Array.isArray(exceptions)) exceptions.forEach((exception, index) => {
    const base = `fulfillment.exceptions[${index}]`;
    add(isRecord(exception), 'INVALID_FULFILLMENT_EXCEPTION', base);
    if (!isRecord(exception)) return;
    add(EXCEPTION_TYPES.has(exception.type), 'INVALID_EXCEPTION_TYPE', `${base}.type`);
    add(known(exception.owner_actor_id) && Array.isArray(context.accepted_owner_ids) && context.accepted_owner_ids.includes(exception.owner_actor_id), 'EXCEPTION_OWNER_UNACCEPTED', `${base}.owner_actor_id`);
    add(timestamp(exception.due_at) && Number.isFinite(nowMs) && Date.parse(exception.due_at) >= nowMs, 'INVALID_EXCEPTION_DEADLINE', `${base}.due_at`);
    add(known(exception.native_ref), 'EXCEPTION_NATIVE_REFERENCE_MISSING', `${base}.native_ref`);
  });
  if (Array.isArray(exceptions) && exceptions.length > 0) reasons.push({ code: 'FULFILLMENT_EXCEPTION_OPEN', field: 'fulfillment.exceptions' });

  return { status: reasons.length === 0 ? 'ready' : 'hold', reason_codes: reasons, ...envelope };
}
