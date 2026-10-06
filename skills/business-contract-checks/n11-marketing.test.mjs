import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const dir = new URL('.', import.meta.url);
const pass = JSON.parse(readFileSync(new URL('./marketing-pass.json', dir)));
const hold = JSON.parse(readFileSync(new URL('./marketing-hold.json', dir)));
const run = (input) => spawnSync(process.execPath, ['./cli.mjs', 'marketing'], { cwd: dir, input: JSON.stringify(input), encoding: 'utf8' });

test('N11 CLI passes an exact, current synthetic draft review and keeps native provenance', () => {
  const result = run(pass);
  assert.equal(result.status, 0);
  const out = JSON.parse(result.stdout);
  assert.equal(out.status, 'ready');
  assert.equal(out.kind, 'draft_validation');
  assert.equal(out.live_authorization, false);
  assert.equal(out.activation, 'disabled');
  assert.equal(out.provenance.consent_native_receipt, 'synthetic-consent-receipt-a');
  assert.equal(out.provenance.claim_native_receipts[0], 'synthetic-claim-receipt-a');
  assert.equal(out.provenance.source_refs[0], 'synthetic-source-locator-a');
  assert.equal(out.provenance.reviewer_native_receipt, 'synthetic-review-receipt-a');
  assert.equal(out.provenance.reviewer_ref, 'synthetic-reviewer-ref-a');
  assert.equal(out.provenance.outcome_ref, 'synthetic-review-outcome-a');
});

test('N11 holds revoked consent, stale reviewer version, and absent approvals', () => {
  const result = run(hold);
  assert.equal(result.status, 1);
  const out = JSON.parse(result.stdout);
  assert.equal(out.status, 'hold');
  assert.equal(out.live_authorization, false);
  assert.ok(out.errors.some((error) => error.includes('consent must be active')));
  assert.ok(out.errors.some((error) => error.includes('current draft version')));
  assert.ok(out.errors.some((error) => error.includes('approved status')));
});

test('N11 holds wrong channel/scope and stale source version', () => {
  const input = structuredClone(pass);
  input.marketing_draft.consent.channel = 'synthetic-sms-channel';
  input.marketing_draft.consent.scope.audience = 'synthetic-other-audience';
  input.context.sources[0].version = 'synthetic-source-v4';
  const result = run(input);
  assert.equal(result.status, 1);
  const out = JSON.parse(result.stdout);
  assert.ok(out.errors.some((error) => error.includes('channel must exactly match')));
  assert.ok(out.errors.some((error) => error.includes('scope must exactly match')));
  assert.ok(out.errors.some((error) => error.includes('version does not match')));
});

test('N11 malformed payload stays inside draft-only hold envelope', () => {
  const result = run({ draft_validation: true, live_authorization: false, workflow: 'N11', now: 'bad', marketing_draft: [], context: {} });
  assert.equal(result.status, 1);
  const out = JSON.parse(result.stdout);
  assert.equal(out.kind, 'draft_validation');
  assert.equal(out.status, 'hold');
  assert.equal(out.live_authorization, false);
});

test('N11 CLI rejects free text and wrong workflow subcommand', () => {
  const input = structuredClone(pass);
  input.marketing_draft.body = 'customer supplied content';
  const result = run(input);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /CONTENT_OR_IDENTIFYING_FIELD/);
  const wrongWorkflow = spawnSync(process.execPath, ['./cli.mjs', 'n08'], { cwd: dir, input: JSON.stringify(pass), encoding: 'utf8' });
  assert.equal(wrongWorkflow.status, 2);
});

test('N11 accepts bounded opaque source locators without fetching source bodies', () => {
  const input = structuredClone(pass);
  input.context.sources[0].source_ref = 'urn:approved-source:revision/2026.10#v5';
  const result = run(input);
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).provenance.source_refs[0], input.context.sources[0].source_ref);
});
