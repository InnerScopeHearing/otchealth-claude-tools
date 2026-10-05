import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCurrentClosePacket as current, validateHistoricalReconstructionPlan as historical } from './finance_status.mjs';

// Independent source-free fixtures. No actual source identities or finance bodies.
const expected = { tenantId: 't_demo', entityId: 'e_demo', sourceVersion: 'v1', evaluatedAt: '2026-10-05T12:00:00Z', currentScopeRef: 'scope_demo', exporterConceptRef: 'pr709-concept' };
const packet = () => ({
  kind: 'current-close-packet', tenant_id: 't_demo', entity_id: 'e_demo', source_version: 'v1',
  current_scope_ref: 'scope_demo', exporter_concept_ref: 'pr709-concept',
  controller_acceptance: { accepted: true, accepted_by: 'controller_demo', accepted_at: '2026-10-05T11:59:00Z', scope_ref: 'scope_demo', tenant_id: 't_demo', entity_id: 'e_demo', source_version: 'v1' },
  status_as_of: '2026-10-05T11:59:00Z', prepared_by: 'prep_demo', reviewed_by: 'review_demo',
  native_sources: [{ native_ref: 'native_demo', tenant_id: 't_demo', entity_id: 'e_demo', source_version: 'v1', status: 'accepted', owner: 'owner_demo', accepted_by_controller: true, observed_at: '2026-10-05T11:58:00Z', pagination_complete: true, settlement_complete: true, duplicates_absent: true, missing_span_absent: true }], exceptions: []
});
const plan = () => {
 const value = {
  kind: 'historical-reconstruction-plan', tenant_id: 't_demo', entity_id: 'e_demo', source_version: 'v1',
  owner: 'owner_demo', backup: 'backup_demo', priority: 'normal', period_start: '2024-01', period_end: '2024-02', periods: ['2024-01', '2024-02'],
  populations: [{ population_ref: 'pop_demo', periods: ['2024-01', '2024-02'], pagination_status: 'complete', settlement_status: 'complete', duplicate_status: 'clear', missing_span_status: 'clear', evidence_refs: ['evidence_demo'] }], time_cap_days: 30, cost_cap_units: 10, cost_cap_unit: 'budget_units',
  stages: ['manifest', 'extract', 'explain', 'correct', 'close_archive'], current_close_included: false, inference_allowed: false,
  missing_evidence_disposition: 'stop_and_record_missing_evidence'
 };
 value.controller_approval = { approved: true, approved_by: value.owner, approved_at: '2026-10-05T11:59:00Z' };
 for (const key of ['tenant_id', 'entity_id', 'source_version', 'backup', 'priority', 'period_start', 'period_end', 'periods', 'populations', 'stages', 'time_cap_days', 'cost_cap_units', 'cost_cap_unit', 'missing_evidence_disposition']) value.controller_approval[key] = structuredClone(value[key]);
 return value;
};
const authority = () => ({ authority_ref: 'authority_demo', approved_by: 'owner_demo', approved_at: '2026-10-05T11:59:00Z', tenant_id: 't_demo', entity_id: 'e_demo', source_version: 'v1', period: '2024-01', stage: 'correct' });
function rejects(name, validator, fixture, mutate) {
  test(name, () => { const value = fixture(); mutate(value); const result = validator(value, expected); assert.equal(result.ok, false, `UNSAFE ACCEPTANCE: ${name}`); assert.ok(result.errors.length > 0); });
}
test('independent documented current positive control', () => assert.equal(current(packet(), expected).ok, true));
test('independent documented historical positive control', () => assert.equal(historical(plan(), expected).ok, true));
for (const key of ['amount', 'bank', 'payee', 'transaction_body', 'record_body', 'tax', 'write', 'replay', 'implement_exporter', 'live_close']) {
  rejects(`current rejects restricted field ${key}`, current, packet, value => { value[key] = 'synthetic_restricted_marker'; });
}
rejects('nested hidden restricted field', current, packet, value => { value.native_sources[0].payload = 'synthetic_restricted_marker'; });
rejects('prototype-inherited hidden restricted field', current, packet, value => { Object.setPrototypeOf(value, { transaction_body: 'synthetic_restricted_marker' }); });
rejects('nonenumerable hidden restricted field', current, packet, value => { Object.defineProperty(value, 'record_body', { value: 'synthetic_restricted_marker' }); });
rejects('symbol-key hidden metadata', current, packet, value => { value[Symbol('restricted')] = 'synthetic_restricted_marker'; });
rejects('sparse native source population', current, packet, value => { value.native_sources = Array(1); });
rejects('sparse exception population', current, packet, value => { value.exceptions = Array(1); });
rejects('cross-tenant packet', current, packet, value => { value.tenant_id = 't_other'; });
rejects('cross-version packet', current, packet, value => { value.source_version = 'v_other'; });
rejects('stale overall status', current, packet, value => { value.status_as_of = '2024-01-01T00:00:00Z'; });
rejects('stale accepted native source', current, packet, value => { value.native_sources[0].observed_at = '2024-01-01T00:00:00Z'; });
rejects('future accepted native source', current, packet, value => { value.native_sources[0].observed_at = '2027-01-01T00:00:00Z'; });
rejects('invalid calendar timestamp', current, packet, value => { value.native_sources[0].observed_at = '2026-02-30T00:00:00Z'; });
rejects('controller receipt other scope', current, packet, value => { value.controller_acceptance.scope_ref = 'unrelated_scope'; });
rejects('controller receipt stale before status', current, packet, value => { value.controller_acceptance.accepted_at = '2024-01-01T00:00:00Z'; });
rejects('controller doubles as preparer', current, packet, value => { value.controller_acceptance.accepted_by = value.prepared_by; });
rejects('preparer doubles as reviewer', current, packet, value => { value.reviewed_by = value.prepared_by; });
rejects('arbitrary duplicate exporter concept', current, packet, value => { value.exporter_concept_ref = 'new_exporter_demo'; });
rejects('duplicate source pointers', current, packet, value => { value.native_sources.push(structuredClone(value.native_sources[0])); });
rejects('missing source without exception', current, packet, value => { value.native_sources[0].status = 'missing'; value.native_sources[0].accepted_by_controller = false; });
rejects('historical sparse populations', historical, plan, value => { value.populations = Array(1); });
rejects('historical sparse evidence pointers', historical, plan, value => { value.populations[0].evidence_refs = Array(1); });
rejects('historical oversized population', historical, plan, value => { value.populations = Array.from({ length: 101 }, (_, i) => `pop_${i}`); });
rejects('historical duplicate population', historical, plan, value => { value.populations.push(value.populations[0]); });
rejects('historical incomplete periods', historical, plan, value => { value.periods.pop(); });
rejects('historical span above cap', historical, plan, value => { value.period_end = '2026-02'; });
rejects('unbounded historical time cap', historical, plan, value => { value.time_cap_days = Infinity; });
rejects('present close mixing', historical, plan, value => { value.current_close_included = true; });
rejects('semantic inference enabled', historical, plan, value => { value.inference_allowed = true; });
rejects('nonterminal unresolved disposition', historical, plan, value => { value.missing_evidence_disposition = 'defer_and_retry'; });
rejects('closed-period correction missing authority', historical, plan, value => { value.correction_requested = true; });
rejects('future correction approval', historical, plan, value => { value.correction_requested = true; value.correction_authority = authority(); value.correction_authority.approved_at = '2027-01-01T00:00:00Z'; });
rejects('out-of-scope closed-period correction', historical, plan, value => { value.correction_requested = true; value.correction_authority = authority(); value.correction_authority.period = '2023-01'; });
rejects('historical prototype-inherited write flag', historical, plan, value => { Object.setPrototypeOf(value, { replay: true }); });
rejects('historical owner/backup conflict', historical, plan, value => { value.backup = value.owner; });
test('independent valid exact closed-period authority', () => { const value = plan(); value.correction_requested = true; value.correction_authority = authority(); assert.equal(historical(value, expected).ok, true); });
rejects('historical approval absent', historical, plan, value => { delete value.controller_approval; });
rejects('historical approval wrong owner', historical, plan, value => { value.controller_approval.approved_by = 'other_owner'; });
rejects('historical receipt different tenant', historical, plan, value => { value.controller_approval.tenant_id = 'other_tenant'; });
rejects('historical receipt different population evidence', historical, plan, value => { value.controller_approval.populations[0].evidence_refs = ['other_evidence']; });
rejects('historical receipt sparse populations', historical, plan, value => { value.controller_approval.populations = Array(1); });
rejects('historical receipt hidden restricted body', historical, plan, value => { value.controller_approval.populations[0].payload = 'synthetic_restricted_marker'; });
rejects('historical receipt sparse periods', historical, plan, value => { value.controller_approval.periods = Array(2); });
rejects('historical receipt changed budget cap', historical, plan, value => { value.cost_cap_units++; });
rejects('historical receipt changed backup', historical, plan, value => { value.backup = 'other_backup'; });
rejects('historical receipt changed priority', historical, plan, value => { value.priority = 'other_priority'; });
rejects('correction authority different owner', historical, plan, value => { value.correction_requested = true; value.correction_authority = authority(); value.correction_authority.approved_by = 'other_owner'; });
rejects('correction authority wrong stage', historical, plan, value => { value.correction_requested = true; value.correction_authority = authority(); value.correction_authority.stage = 'extract'; });
rejects('native source cross-tenant identity', current, packet, value => { value.native_sources[0].tenant_id = 'other_tenant'; });
rejects('accepted source incomplete pagination', current, packet, value => { value.native_sources[0].pagination_complete = false; });
rejects('accepted source incomplete settlement', current, packet, value => { value.native_sources[0].settlement_complete = false; });
rejects('accepted source unresolved duplicates', current, packet, value => { value.native_sources[0].duplicates_absent = false; });
rejects('accepted source missing span', current, packet, value => { value.native_sources[0].missing_span_absent = false; });
test('accessor input rejected without executing getter', () => {
  const value = packet(); let calls = 0;
  Object.defineProperty(value, 'status_as_of', { enumerable: true, get() { calls++; return '2026-10-05T11:59:00Z'; } });
  assert.equal(current(value, expected).ok, false); assert.equal(calls, 0, 'validator executed untrusted getter');
});
test('array accessor rejected without executing getter', () => {
  const value = packet(); let calls = 0;
  Object.defineProperty(value.native_sources, '0', { enumerable: true, get() { calls++; return packet().native_sources[0]; } });
  assert.equal(current(value, expected).ok, false); assert.equal(calls, 0, 'validator executed untrusted array getter');
});
for (const [key, status] of [['pagination_status', 'unknown'], ['settlement_status', 'incomplete'], ['duplicate_status', 'present'], ['missing_span_status', 'present']]) {
  rejects(`requested correction held for unresolved ${key}`, historical, plan, value => {
    value.populations[0][key] = status; value.controller_approval.populations = structuredClone(value.populations);
    value.correction_requested = true; value.correction_authority = authority();
  });
}
test('finite manifest may explicitly record unresolved population without inference', () => {
  const value = plan(); value.populations[0].pagination_status = 'unknown'; value.controller_approval.populations = structuredClone(value.populations);
  assert.equal(historical(value, expected).ok, true);
});
