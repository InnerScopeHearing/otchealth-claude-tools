import test from 'node:test';
import assert from 'node:assert/strict';
import { readMatrix, runMatrix, validateMatrix, observeScenario } from '../scripts/customer-service-harness-lib.mjs';

const matrix = readMatrix(new URL('./fixtures/customer-service-scenarios.json', import.meta.url));

test('scenario matrix is valid, synthetic-only, and broad enough', () => {
  assert.deepEqual(validateMatrix(matrix), []);
  assert.ok(matrix.scenarios.length >= 50);
  assert.deepEqual(new Set(matrix.scenarios.map((scenario) => scenario.channel)), new Set(['email', 'phone', 'sms']));
  for (const family of ['identity', 'order_lookup', 'wismo', 'safety', 'complaints', 'retries', 'dlq', 'csat', 'verified_resolution']) {
    assert.ok(matrix.scenarios.some((scenario) => scenario.family === family), `missing family ${family}`);
  }
});

test('every scenario passes with zero effects', () => {
  const report = runMatrix(matrix);
  assert.equal(report.overall, 'PASS_SYNTHETIC_EVIDENCE_ONLY');
  assert.equal(report.test_summary.failed, 0);
  assert.equal(report.defects.length, 0);
  assert.equal(report.test_summary.executions, matrix.scenarios.length);
  assert.deepEqual(report.no_effect_counters, {
    network_calls: 0,
    customer_contacts: 0,
    provider_calls: 0,
    refunds_or_credits: 0,
    inventory_mutations: 0,
    shipments_created: 0,
    orders_created: 0,
    authorization_consumptions: 0,
    canonical_state_mutations: 0,
    production_dns_changes: 0
  });
});

test('repeat runs are deterministic and preserve the no-go decision', () => {
  const report = runMatrix(matrix, { repeat: 3 });
  assert.equal(report.test_summary.executions, matrix.scenarios.length * 3);
  assert.equal(report.test_summary.failed, 0);
  assert.equal(report.launch_decision, 'HOLD_NO_GO_UNCHANGED');
  const grouped = new Map();
  for (const result of report.results) {
    const signature = JSON.stringify({ status: result.status, observation: result.observation });
    const existing = grouped.get(result.scenario_id);
    if (existing) assert.equal(signature, existing, `nondeterministic result for ${result.scenario_id}`);
    else grouped.set(result.scenario_id, signature);
  }
});

test('high-risk paths are fail-closed', () => {
  const byId = new Map(matrix.scenarios.map((scenario) => [scenario.id, scenario]));
  const safety = observeScenario(byId.get('SAFE-002'));
  assert.equal(safety.outcome, 'safety_escalation');
  assert.equal(safety.ordinary_label, false);
  assert.equal(safety.closure, false);
  const refund = observeScenario(byId.get('COMP-002'));
  assert.equal(refund.refund, false);
  assert.equal(refund.credit, false);
  const wrongRecipient = observeScenario(byId.get('EML-003'));
  assert.equal(wrongRecipient.customer_send, false);
  assert.equal(wrongRecipient.incident_open, true);
  const auth = observeScenario(byId.get('DLQ-004'));
  assert.equal(auth.replayable, false);
  assert.equal(auth.customer_send, false);
});

test('a forbidden destructive expectation cannot enter the matrix', () => {
  const clone = structuredClone(matrix);
  clone.scenarios[0].expected.customer_send = true;
  assert.match(validateMatrix(clone).join('\n'), /destructive expectation customer_send=true/);
});
