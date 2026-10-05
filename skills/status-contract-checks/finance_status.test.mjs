import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateCurrentClosePacket,
  validateHistoricalReconstructionPlan,
} from './finance_status.mjs';

// Deliberately synthetic metadata only. No source reads, bodies, amounts, or
// account/payee details are included in these fixtures.
const expected = {
  tenantId: 'tenant-synthetic-a',
  entityId: 'entity-synthetic-a',
  sourceVersion: 'source-version-synthetic-7',
  currentScopeRef: 'scope-current-synthetic',
  exporterConceptRef: 'pr709-concept-synthetic',
  evaluatedAt: '2026-10-05T12:00:00.000Z',
};

const validPacket = () => ({
  kind: 'current-close-packet',
  tenant_id: expected.tenantId,
  entity_id: expected.entityId,
  source_version: expected.sourceVersion,
  exporter_concept_ref: expected.exporterConceptRef,
  current_scope_ref: expected.currentScopeRef,
  controller_acceptance: {
    accepted: true,
    accepted_by: 'controller-synthetic',
    accepted_at: '2026-10-05T11:45:00.000Z',
    tenant_id: expected.tenantId,
    entity_id: expected.entityId,
    source_version: expected.sourceVersion,
    scope_ref: expected.currentScopeRef,
  },
  status_as_of: '2026-10-05T11:50:00.000Z',
  prepared_by: 'preparer-synthetic',
  reviewed_by: 'reviewer-synthetic',
  native_sources: [
    {
      native_ref: 'source-pointer-synthetic-1',
      tenant_id: expected.tenantId,
      entity_id: expected.entityId,
      source_version: expected.sourceVersion,
      status: 'accepted',
      owner: 'source-owner-synthetic',
      accepted_by_controller: true,
      pagination_complete: true,
      settlement_complete: true,
      duplicates_absent: true,
      missing_span_absent: true,
      observed_at: '2026-10-05T11:50:00.000Z',
    },
    {
      native_ref: 'source-pointer-synthetic-2',
      tenant_id: expected.tenantId,
      entity_id: expected.entityId,
      source_version: expected.sourceVersion,
      status: 'missing',
      owner: 'source-owner-synthetic-2',
      accepted_by_controller: false,
      pagination_complete: true,
      settlement_complete: true,
      duplicates_absent: true,
      missing_span_absent: true,
      observed_at: '2026-10-05T11:40:00.000Z',
    },
  ],
  exceptions: [
    {
      native_ref: 'source-pointer-synthetic-2',
      reason: 'missing',
      owner: 'source-owner-synthetic-2',
      backup: 'backup-owner-synthetic-2',
      due_at: '2026-10-06T12:00:00.000Z',
    },
  ],
});

const validPlan = () => ({
  kind: 'historical-reconstruction-plan',
  tenant_id: expected.tenantId,
  entity_id: expected.entityId,
  source_version: expected.sourceVersion,
  owner: 'controller-synthetic',
  backup: 'backup-synthetic',
  priority: 'normal',
  period_start: '2025-01',
  period_end: '2025-03',
  periods: ['2025-01', '2025-02', '2025-03'],
  populations: ['population-ref-synthetic-1'],
  time_cap_days: 30,
  cost_cap_units: 100,
  cost_cap_unit: 'budget_units',
  stages: ['manifest', 'extract', 'explain', 'correct', 'close_archive'],
  current_close_included: false,
  missing_evidence_disposition: 'stop_and_record_missing_evidence',
  inference_allowed: false,
  controller_approval: {
    approved: true,
    approved_by: 'controller-synthetic',
    approved_at: '2026-10-05T11:45:00.000Z',
    tenant_id: expected.tenantId,
    entity_id: expected.entityId,
    source_version: expected.sourceVersion,
    period_start: '2025-01',
    backup: 'backup-synthetic',
    priority: 'normal',
    period_end: '2025-03',
    periods: ['2025-01', '2025-02', '2025-03'],
    populations: [{
      population_ref: 'population-ref-synthetic-1',
      periods: ['2025-01', '2025-02', '2025-03'],
      pagination_status: 'complete',
      settlement_status: 'complete',
      duplicate_status: 'clear',
      missing_span_status: 'clear',
      evidence_refs: ['evidence-ref-synthetic-1'],
    }],
    stages: ['manifest', 'extract', 'explain', 'correct', 'close_archive'],
    time_cap_days: 30,
    cost_cap_units: 100,
    cost_cap_unit: 'budget_units',
    missing_evidence_disposition: 'stop_and_record_missing_evidence',
  },
  populations: [{
    population_ref: 'population-ref-synthetic-1',
    periods: ['2025-01', '2025-02', '2025-03'],
    pagination_status: 'complete',
    settlement_status: 'complete',
    duplicate_status: 'clear',
    missing_span_status: 'clear',
    evidence_refs: ['evidence-ref-synthetic-1'],
  }],
});

function mustPass(validator, value) {
  const result = validator(value, expected);
  assert.equal(result?.ok, true, `expected valid synthetic fixture; errors: ${JSON.stringify(result?.errors)}`);
}

function mustFail(validator, value) {
  const result = validator(value, expected);
  assert.equal(result?.ok, false, 'unsafe or incomplete fixture was accepted');
  assert.ok(Array.isArray(result.errors), 'validator must return errors');
  assert.ok(result.errors.length > 0, 'rejection must explain at least one error');
}

test('accepts current status-only close packet with explicit exception metadata', () => {
  mustPass(validateCurrentClosePacket, validPacket());
});

test('accepts bounded finite legacy reconstruction plan', () => {
  mustPass(validateHistoricalReconstructionPlan, validPlan());
});

for (const [name, edit] of [
  ['tenant mismatch', p => { p.tenant_id = 'tenant-synthetic-other'; }],
  ['source-version mismatch', p => { p.source_version = 'source-version-synthetic-other'; }],
  ['unknown timestamp', p => { p.status_as_of = 'not-a-timestamp'; }],
  ['stale status timestamp', p => { p.status_as_of = '2026-10-04T10:00:00.000Z'; }],
  ['future status timestamp', p => { p.status_as_of = '2026-10-05T12:01:00.000Z'; }],
  ['missing preparer', p => { p.prepared_by = ''; }],
  ['missing reviewer', p => { p.reviewed_by = ''; }],
  ['same preparer and reviewer', p => { p.reviewed_by = p.prepared_by; }],
  ['arbitrary exporter concept', p => { p.exporter_concept_ref = 'unapproved-exporter-synthetic'; }],
  ['current scope ref mismatch', p => { p.current_scope_ref = 'unrelated-scope-synthetic'; }],
  ['controller acceptance for unrelated scope', p => { p.controller_acceptance.scope_ref = 'unrelated-scope-synthetic'; }],
  ['controller acceptance for unrelated tenant', p => { p.controller_acceptance.tenant_id = 'tenant-synthetic-other'; }],
  ['native source from unrelated tenant', p => { p.native_sources[0].tenant_id = 'tenant-synthetic-other'; }],
  ['native source from unrelated entity', p => { p.native_sources[0].entity_id = 'entity-synthetic-other'; }],
  ['native source from unrelated version', p => { p.native_sources[0].source_version = 'source-version-synthetic-other'; }],
  ['stale native source timestamp', p => { p.native_sources[0].observed_at = '2026-10-04T10:00:00.000Z'; }],
  ['future native source timestamp', p => { p.native_sources[0].observed_at = '2026-10-05T12:01:00.000Z'; }],
  ['missing pagination completeness', p => { delete p.native_sources[0].pagination_complete; }],
  ['missing settlement completeness', p => { delete p.native_sources[0].settlement_complete; }],
  ['missing duplicate completeness', p => { delete p.native_sources[0].duplicates_absent; }],
  ['missing span completeness', p => { delete p.native_sources[0].missing_span_absent; }],
  ['owner gap on exception', p => { p.exceptions[0].owner = ''; }],
  ['backup gap on exception', p => { p.exceptions[0].backup = ''; }],
  ['exception pointer does not match source', p => { p.exceptions[0].native_ref = 'unmatched-source-pointer-synthetic'; }],
  ['missing exception for missing source', p => { p.exceptions = []; }],
  ['ambiguous duplicate exception receipts', p => { p.exceptions.push({ ...p.exceptions[0] }); }],
  ['duplicate native source receipt', p => { p.native_sources.push({ ...p.native_sources[0] }); }],
  ['unaccepted native source', p => { p.native_sources[0].accepted_by_controller = false; }],
  ['restricted financial body', p => { p.transaction_body = 'synthetic-redacted'; }],
  ['amount field', p => { p.amount = 0; }],
  ['account field', p => { p.account_number = 'synthetic-redacted'; }],
  ['exporter implementation attempt', p => { p.implement_exporter = true; }],
  ['exporter action attempt', p => { p.exporter_action = 'execute'; }],
  ['unknown write attempt', p => { p.write_action = 'write'; }],
  ['unknown replay attempt', p => { p.replay = true; }],
  ['status claims live close', p => { p.status = 'closed'; }],
  ['historical fields mixed into current packet', p => { p.period_start = '2025-01'; }],
  ['sparse native-source array', p => { delete p.native_sources[0]; }],
  ['hidden accessor field', p => { Object.defineProperty(p, 'hidden_status', { get() { return 'closed'; } }); }],
]) {
  test(`rejects current packet: ${name}`, () => {
    const packet = validPacket();
    edit(packet);
    mustFail(validateCurrentClosePacket, packet);
  });
}

for (const [name, edit] of [
  ['tenant mismatch', p => { p.tenant_id = 'tenant-synthetic-other'; }],
  ['source-version mismatch', p => { p.source_version = 'source-version-synthetic-other'; }],
  ['owner gap', p => { p.owner = ''; }],
  ['backup gap', p => { p.backup = ''; }],
  ['unknown period timestamp', p => { p.period_start = '2025/01'; }],
  ['open-ended period scope', p => { delete p.period_end; }],
  ['period list does not cover declared span', p => { p.periods = ['2025-01', '2025-03']; }],
  ['period list silently infers missing span', p => { p.periods = ['2025-01', '2025-03']; p.inference_allowed = true; }],
  ['duplicate period receipts', p => { p.periods.push('2025-02'); }],
  ['empty population', p => { p.populations = []; }],
  ['duplicate or ambiguous population receipt', p => { p.populations.push(p.populations[0]); }],
  ['population with unrelated period scope', p => { p.populations[0].periods = ['2025-04']; }],
  ['population with incomplete pagination', p => { p.populations[0].pagination_status = 'incomplete'; }],
  ['population with unknown settlement completeness', p => { p.populations[0].settlement_status = 'unknown'; }],
  ['population with duplicate receipt ambiguity', p => { p.populations[0].duplicate_status = 'present'; }],
  ['population with missing span', p => { p.populations[0].missing_span_status = 'present'; }],
  ['unrelated controller approval', p => { p.controller_approval.tenant_id = 'tenant-synthetic-other'; }],
  ['approval not made by plan owner', p => { p.controller_approval.approved_by = 'other-approver-synthetic'; }],
  ['approval with unrelated period', p => { p.controller_approval.period_start = '2025-02'; }],
  ['approval with unrelated population', p => { p.controller_approval.populations[0].population_ref = 'unrelated-population-synthetic'; }],
  ['empty evidence pointer set', p => { p.evidence_refs = []; }],
  ['unbounded time cap', p => { delete p.time_cap_days; }],
  ['unbounded cost cap', p => { delete p.cost_cap_units; }],
  ['unknown cost-cap unit', p => { p.cost_cap_unit = 'unknown'; }],
  ['current and historical work mixed', p => { p.current_close_included = true; }],
  ['missing terminal disposition', p => { delete p.missing_evidence_disposition; }],
  ['semantic inference fills missing records', p => { p.inference_allowed = true; }],
  ['unknown write attempt', p => { p.write_action = 'write'; }],
  ['unknown replay attempt', p => { p.replay = true; }],
  ['exporter implementation attempt', p => { p.implement_exporter = true; }],
  ['exporter action attempt', p => { p.exporter_action = 'execute'; }],
  ['closed-period correction lacks exact authority', p => { p.correction_requested = true; }],
  ['correction authority is not period-specific', p => { p.correction_requested = true; p.correction_authority = { authority_ref: 'authority-synthetic', approved_by: 'controller-synthetic', approved_at: '2026-10-05T11:00:00.000Z', period: '2025-04' }; }],
  ['historical work claims current live close', p => { p.status = 'closed'; }],
  ['current packet fields mixed into historical plan', p => { p.status_as_of = '2026-10-05T11:50:00.000Z'; }],
  ['sparse period array', p => { delete p.periods[1]; }],
  ['sparse population array', p => { delete p.populations[0]; p.populations.length = 2; }],
  ['hidden accessor field', p => { Object.defineProperty(p, 'hidden_status', { get() { return 'closed'; } }); }],
]) {
  test(`rejects historical plan: ${name}`, () => {
    const plan = validPlan();
    edit(plan);
    mustFail(validateHistoricalReconstructionPlan, plan);
  });
}

test('accepts closed-period correction only with exact in-scope authority', () => {
  const plan = validPlan();
  plan.correction_requested = true;
  plan.correction_authority = {
    authority_ref: 'authority-pointer-synthetic',
    approved_by: 'controller-synthetic',
    approved_at: '2026-10-05T11:00:00.000Z',
    tenant_id: expected.tenantId,
    entity_id: expected.entityId,
    source_version: expected.sourceVersion,
    stage: 'correct',
    period: '2025-02',
  };
  mustPass(validateHistoricalReconstructionPlan, plan);
});
