import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseFlags, spendOptions, SPEND_BOOLS } from './cli.mjs';
import { main as renderMain } from './render.mjs';
import { goodManifest, tmp } from './test-helpers.mjs';

const P = (argv) => parseFlags(argv, { bool: SPEND_BOOLS });

test('boolean flags: bare, =false, "false", "no", "0" and "true" all mean what they say', () => {
  assert.equal(P(['a.json', '--commit']).commit, true);
  for (const off of [['--commit', 'false'], ['--commit=false'], ['--commit', 'no'], ['--commit', '0'], ['--commit=0']]) {
    const f = P(['a.json', ...off, '--max-credits', '5']);
    assert.equal(f.commit, false, off.join(' '));
    assert.deepEqual(f._, ['a.json'], 'the value must not leak into positionals');
    assert.equal(spendOptions(f).commit, false);
  }
  assert.equal(P(['a.json', '--commit', 'true']).commit, true);
  assert.equal(P(['a.json', '--allow-unknown-rate', 'false'])['allow-unknown-rate'], false);
});

test('counterfactual: a naive "any value is true" parse would have turned --commit false into a commit', () => {
  const naive = (argv) => { const i = argv.indexOf('--commit'); return i >= 0; };
  assert.equal(naive(['--commit', 'false']), true);      // the bug class
  assert.equal(P(['--commit', 'false']).commit, false);  // the fix
});

test('spendOptions: max-credits parses commas/underscores; junk is NaN (which the planner refuses)', () => {
  assert.equal(spendOptions(P(['--max-credits', '20_000'])).maxCredits, 20000);
  assert.equal(spendOptions(P(['--max-credits=1,500'])).maxCredits, 1500);
  assert.ok(Number.isNaN(spendOptions(P(['--max-credits', 'lots'])).maxCredits));
  assert.equal(spendOptions(P([])).maxCredits, undefined);
});

test('render CLI: `--commit false` is a dry run (exit 0, nothing written)', async () => {
  const dir = tmp('cli-'); const m = goodManifest(dir);
  writeFileSync(join(dir, 'ad.json'), JSON.stringify(m));
  const out = join(dir, 'out');
  const realLog = console.log; console.log = () => {};
  let code;
  try { code = await renderMain([join(dir, 'ad.json'), '--offline', '--commit', 'false', '--max-credits', '9999', '--out', out]); }
  finally { console.log = realLog; }
  assert.equal(code, 0);
  assert.equal(existsSync(out), false);
});

test('render CLI: --audio is refused; --audio false is not', async () => {
  const dir = tmp('cli2-'); const m = goodManifest(dir);
  writeFileSync(join(dir, 'ad.json'), JSON.stringify(m));
  const realLog = console.log, realErr = console.error; console.log = () => {}; const errs = []; console.error = (x) => errs.push(x);
  let refused, ok;
  try {
    refused = await renderMain([join(dir, 'ad.json'), '--offline', '--audio']);
    ok = await renderMain([join(dir, 'ad.json'), '--offline', '--audio', 'false']);
  } finally { console.log = realLog; console.error = realErr; }
  assert.equal(refused, 1); assert.match(errs.join(' '), /NOT mixed/);
  assert.equal(ok, 0);
});
