import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const expected = { tenantId: 't_demo', entityId: 'e_demo', sourceVersion: 'v1', evaluatedAt: '2026-10-05T12:00:00Z', currentScopeRef: 'scope_demo', exporterConceptRef: 'pr709-concept' };
const packet = () => ({
  kind: 'current-close-packet', tenant_id: 't_demo', entity_id: 'e_demo', source_version: 'v1',
  current_scope_ref: 'scope_demo', exporter_concept_ref: 'pr709-concept',
  controller_acceptance: { accepted: true, accepted_by: 'controller_demo', accepted_at: '2026-10-05T11:59:00Z', scope_ref: 'scope_demo', tenant_id: 't_demo', entity_id: 'e_demo', source_version: 'v1' },
  status_as_of: '2026-10-05T11:59:00Z', prepared_by: 'prep_demo', reviewed_by: 'review_demo',
  native_sources: [{ native_ref: 'native_demo', tenant_id: 't_demo', entity_id: 'e_demo', source_version: 'v1', status: 'accepted', owner: 'owner_demo', accepted_by_controller: true, observed_at: '2026-10-05T11:58:00Z', pagination_complete: true, settlement_complete: true, duplicates_absent: true, missing_span_absent: true }], exceptions: []
});
function run(input) {
  return spawnSync(process.execPath, [new URL('./validate.mjs', import.meta.url).pathname, '--mode', 'current'],
    { input: JSON.stringify(input), encoding: 'utf8' });
}
test('CLI validates synthetic status and always marks it as draft without live authority', () => {
  const result = run({ value: packet(), expected });
  assert.equal(result.status, 0, result.stdout);
  assert.deepEqual(JSON.parse(result.stdout), { draft_validation: true, live_authorization: false, mode: 'current', ok: true, errors: [] });
});
test('CLI rejects financial bodies and does not echo their values', () => {
  const value = packet(); value.record_body = 'SYNTHETIC_BODY_MUST_NOT_ECHO';
  const result = run({ value, expected });
  assert.equal(result.status, 2);
  assert.equal(JSON.parse(result.stdout).live_authorization, false);
  assert.equal(result.stdout.includes('SYNTHETIC_BODY_MUST_NOT_ECHO'), false);
});
