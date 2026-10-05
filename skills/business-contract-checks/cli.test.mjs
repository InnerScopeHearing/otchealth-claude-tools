import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const run = (input) => spawnSync(process.execPath, ['./cli.mjs'], { cwd: new URL('.', import.meta.url), input: JSON.stringify(input), encoding: 'utf8' });
const n08 = JSON.parse(readFileSync(new URL('./pass.json', import.meta.url)));

test('CLI labels a passing fixture as draft-only and never authorizes live action', () => {
  const result = run(n08);
  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, 'ready');
  assert.equal(output.kind, 'draft_validation');
  assert.equal(output.live_authorization, false);
});

test('CLI holds an incomplete handoff fixture', () => {
  const result = run(JSON.parse(readFileSync(new URL('./deny.json', import.meta.url))));
  assert.equal(result.status, 1);
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, 'hold');
  assert.equal(output.live_authorization, false);
  assert.ok(output.errors.length > 0);
});

test('CLI rejects free-text and missing draft-only declarations', () => {
  const freeText = run({ ...n08, memo: 'customer says refund me' });
  assert.equal(freeText.status, 1);
  assert.match(freeText.stdout, /draft_validation/);
  const missingFlag = run({ ...n08, live_authorization: true });
  assert.equal(missingFlag.status, 1);
  assert.match(missingFlag.stdout, /live_authorization=false/);
});
