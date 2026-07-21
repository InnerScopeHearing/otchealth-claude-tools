#!/usr/bin/env node
// selftest.mjs, exercises apple-preflight.mjs end to end with no network and no external
// deps: --list, --app for a registered fleet app (live-read path when the capgo plugin is
// present, fallback path forced via APPLE_PREFLIGHT_CAPGO_DIR), an ad hoc --tags app, and
// the unknown-app error path. Picked up automatically by run-tests.sh.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, 'apple-preflight.mjs');

let failures = 0;
function check(label, cond) {
  if (cond) {
    console.log(`  ok: ${label}`);
  } else {
    console.error(`  FAIL: ${label}`);
    failures++;
  }
}

function run(args, opts = {}) {
  try {
    const out = execFileSync('node', [CLI, ...args], { encoding: 'utf8', ...opts });
    return { out, code: 0 };
  } catch (e) {
    return { out: (e.stdout || '') + (e.stderr || ''), code: e.status ?? 1 };
  }
}

// --list prints the registry and every known app id.
{
  const { out, code } = run(['--list']);
  check('--list exits 0', code === 0);
  check('--list mentions fourvault', out.includes('fourvault'));
  check('--list mentions companion', out.includes('companion'));
}

// --app for a registered app renders the always-on checklists plus its tags.
{
  const { out, code } = run(['--app', 'fourvault']);
  check('--app fourvault exits 0', code === 0);
  check('--app fourvault includes All Apps section', out.includes('All Apps (Universal Guidelines)'));
  check('--app fourvault includes Kids Category section', out.includes('Kids Category'));
  check('--app fourvault includes Export Compliance section', out.includes('Export Compliance'));
  check('--app fourvault is marked advisory only', out.includes('ADVISORY ONLY'));
}

// Fallback path: force the capgo plugin dir to a directory with no matching files, the
// report must still render with the condensed, cited summaries instead of crashing.
{
  const fakeDir = mkdtempSync(join(tmpdir(), 'apple-preflight-selftest-'));
  try {
    const { out, code } = run(['--app', 'companion'], {
      env: { ...process.env, APPLE_PREFLIGHT_CAPGO_DIR: fakeDir },
    });
    check('fallback path exits 0', code === 0);
    check('fallback path says condensed fallback summary', out.includes('condensed fallback summary'));
    check('fallback path still cites a guideline number (5.1.1)', out.includes('5.1.1'));
  } finally {
    rmSync(fakeDir, { recursive: true, force: true });
  }
}

// Ad hoc app via --tags (not in the registry).
{
  const { out, code } = run(['--app', 'brandnewapp', '--tags', 'subscription,ai']);
  check('ad hoc --tags app exits 0', code === 0);
  check('ad hoc --tags app applies subscription checklist', out.includes('Subscriptions and In-App Purchase'));
  check('ad hoc --tags app applies ai checklist', out.includes('AI-Powered'));
}

// Unknown app with no --tags is a hard error, not a silent empty report.
{
  const { code } = run(['--app', 'not-a-real-app']);
  check('unknown app with no --tags exits non-zero', code !== 0);
}

// No args at all is also a hard error with guidance, not a crash.
{
  const { code } = run([]);
  check('no args exits non-zero', code !== 0);
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nall apple-preflight selftests passed');
