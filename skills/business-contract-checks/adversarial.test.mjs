import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { validateMarketingDraft } from './marketing.mjs';
import { validateCommerceFreshness } from './commerce.mjs';
const fixture = name => JSON.parse(readFileSync(new URL(name, import.meta.url), 'utf8'));
for (const [label, mutate] of [
  ['conflicting claim approval', v => v.context.approved_claims.unshift({ ...v.context.approved_claims[0], status: 'revoked' })],
  ['conflicting current source', v => v.context.sources.unshift({ ...v.context.sources[0], current: false })],
  ['unknown consent version', v => v.marketing_draft.consent.source_version = 'UNKNOWN'],
  ['unknown reviewer receipt', v => v.marketing_draft.reviewer_ack.native_receipt = 'UNKNOWN'],
  ['impossible consent calendar date', v => v.marketing_draft.consent.effective_at = '2026-02-30T12:00:00Z'],
  ['email in reviewer reference', v => v.marketing_draft.reviewer_ack.reviewer_ref = 'synthetic@example.test'],
  ['missing review context', v => v.context = null],
]) test(`N11 holds ${label} and disables activation`, () => {
  const v = fixture('marketing-pass.json'); mutate(v);
  const r = validateMarketingDraft(v.marketing_draft, v.context, v.now);
  assert.equal(r.status, 'hold'); assert.equal(r.activation, 'disabled'); assert.equal(r.live_authorization, false);
});
for (const [label, mutate] of [
  ['stock value differs from native facts', v => v.stock.available_quantity = 10000],
  ['capacity value differs from native facts', v => v.fulfillment.capacity.available_quantity = 10000],
  ['payment reference differs from native facts', v => v.payment.payment_ref = 'receipt:unrelated'],
  ['missing supplied payment policy', v => delete v.context.accepted_payment_states],
  ['email in evidence pointer', v => v.payment.source.evidence_ref = 'synthetic@example.test'],
  ['missing commerce context', v => v.context = null],
]) test(`N09 holds ${label} and disables activation`, () => {
  const v = fixture('pass-n09.json'); mutate(v);
  const r = validateCommerceFreshness(v);
  assert.equal(r.status, 'hold'); assert.equal(r.activation, 'disabled'); assert.equal(r.live_authorization, false);
});
test('installed interfaces contain metadata rejection and oversized JSON without activation', () => {
  const v = fixture('marketing-pass.json'); v.marketing_draft.body = 'synthetic-body';
  const r = spawnSync(process.execPath, ['cli.mjs', 'marketing'], { cwd: new URL('.', import.meta.url), input: JSON.stringify(v), encoding: 'utf8' });
  assert.equal(r.status, 1); assert.equal(JSON.parse(r.stdout).activation, 'disabled');
  const large = spawnSync(process.execPath, ['cli.mjs', 'commerce'], { cwd: new URL('.', import.meta.url), input: JSON.stringify({ extra: 'x'.repeat(65536) }), encoding: 'utf8' });
  assert.equal(large.status, 2); assert.equal(large.stdout, '');
});
