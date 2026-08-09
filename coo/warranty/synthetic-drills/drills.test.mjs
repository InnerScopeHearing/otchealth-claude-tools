import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const report = JSON.parse(fs.readFileSync(path.join(root, 'evidence', 'synthetic-drill-report.json'), 'utf8'));
const receipt = JSON.parse(fs.readFileSync(path.join(root, 'evidence', 'receipt.json'), 'utf8'));
const n8nReceipt = JSON.parse(fs.readFileSync(path.join(root, 'evidence', 'n8n-execution-receipts.json'), 'utf8'));
const renderReceipt = JSON.parse(fs.readFileSync(path.join(root, 'evidence', 'render-receipt.json'), 'utf8'));

test('synthetic drill suite passes without changing launch decision', () => {
  assert.equal(report.overall, 'PASS_SYNTHETIC_EVIDENCE_ONLY');
  assert.equal(report.launch_decision, 'HOLD_NO_GO_UNCHANGED');
  assert.deepEqual(report.test_summary, { tests: 14, passed: 14, failed: 0, assertions: 58 });
});

test('all external and operational effect counters are zero', () => {
  for (const [counter, value] of Object.entries(report.no_effect_counters)) {
    assert.equal(value, 0, `${counter} must stay zero`);
  }
});

test('all 17 launch gates remain represented', () => {
  assert.equal(report.gate_matrix.length, 17);
  assert.ok(report.gate_matrix.every((row) => row.irreducible.length > 0));
  assert.ok(report.gate_matrix.some((row) => row.classification === 'HUMAN_ONLY'));
  assert.ok(report.gate_matrix.some((row) => row.classification.includes('PHYSICAL')));
});

test('every drill distinguishes proven from not proven', () => {
  assert.equal(Object.keys(report.drills).length, 14);
  for (const [name, drill] of Object.entries(report.drills)) {
    assert.ok(drill.status.startsWith('PASS'), `${name} must pass synthetically`);
    assert.ok(Array.isArray(drill.proven) && drill.proven.length > 0, `${name} needs proven list`);
    assert.ok(Array.isArray(drill.not_proven) && drill.not_proven.length > 0, `${name} needs not_proven list`);
  }
});

test('receipt matches report summary and immutable digests are present', () => {
  assert.equal(receipt.overall, report.overall);
  assert.equal(receipt.launch_decision, report.launch_decision);
  assert.match(receipt.report_sha256, /^[a-f0-9]{64}$/);
  assert.match(receipt.fixture_sha256, /^[a-f0-9]{64}$/);
  assert.match(receipt.runner_sha256, /^[a-f0-9]{64}$/);
});

test('all six n8n synthetic contracts have fresh success receipts and zero effects', () => {
  assert.deepEqual(n8nReceipt.summary, {
    executions: 6,
    success: 6,
    failed: 0,
    external_calls: 0,
    authorizations_consumed: 0,
    customer_contacts: 0,
    live_effects: 0
  });
  assert.equal(n8nReceipt.launch_decision, 'HOLD_NO_GO_UNCHANGED');
  assert.ok(n8nReceipt.executions.every((row) => row.status === 'success'));
  assert.ok(n8nReceipt.executions.every((row) => row.external_call_count === 0));
  assert.ok(n8nReceipt.executions.every((row) => row.live_execution_permitted === false));
  assert.ok(n8nReceipt.executions.every((row) => row.customer_contact_permitted === false));
});

test('human-readable packet is bound to the same evidence and HOLD decision', () => {
  assert.equal(renderReceipt.source_report_sha256, receipt.report_sha256);
  assert.equal(renderReceipt.launch_decision, 'HOLD_NO_GO_UNCHANGED');
  assert.deepEqual(renderReceipt.n8n_execution_ids, ['48337', '48336', '48333', '48334', '48335', '48332']);
  assert.match(renderReceipt.output_sha256, /^[a-f0-9]{64}$/);
});
