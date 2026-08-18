// Regression for skills/kb-memory/secret-drift.mjs — the only check that would notice the two
// secret stores diverging, and therefore the only reason the Azure-outage fallback in kvSecret() is
// trustworthy at all.
//
// THE BUG THIS PINS (2026-08-18). secret-drift read the Azure side through kvSecret() while
// forcing SECRET_BACKEND=keyvault, on the theory that the env var pinned which store answered. It
// does not. kvSecret() delegates to resolveSecret(), whose entire job is to hide which store
// answered: when the Key Vault leg came back empty for ANY reason, resolveSecret() fell through to
// SSM and returned that value as though the vault had served it. The comparison was then SSM
// against itself, which agrees by construction. Measured, one secret, vault answering 404 for a
// name SSM holds: reported `in-sync=1`, exit 0. Correct answer: `KV-MISSING`, exit 1.
//
// SCOPE, STATED HONESTLY: 4 of the 6 vault-outcome classes (401, 403, unreachable, no-credential)
// were ALREADY self-comparing before this branch; the branch took it to 6 of 6 by adding 404 and
// 5xx. So the regression is narrower than "the branch blinded the detector" -- but the detector was
// already mostly blind, and the fix has to close all six, not just the two that regressed. The
// tests below cover every class.
//
// The third state matters as much as the fix. With no Azure credential resolvable -- which is
// every seat today, subscription 55c84f6b being retired -- simply reading the vault leg directly
// would emit one KV-MISSING line per secret and exit 1 forever. A permanent false alarm is the same
// failure as a permanent false green: both end with a human ignoring the check. So "cannot compare"
// is its own reported outcome with its own exit code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DRIFT = join(ROOT, 'skills', 'kb-memory', 'secret-drift.mjs');
const NAME = 'drift-test-secret';

/**
 * Run the REAL secret-drift.mjs with only the HTTP boundary stubbed.
 * @param {object} o
 * @param {string|null} o.ssm      value SSM holds for NAME (null = absent)
 * @param {string|null} o.kv       value the vault holds for NAME (null = it answers kvStatus)
 * @param {number} o.kvStatus      status the vault returns when it has no value (404 / 500 / 403)
 * @param {boolean} o.azureAuth    whether any Azure credential resolves at all
 */
function runDrift({ ssm = 'v', kv = null, kvStatus = 404, azureAuth = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'drift-'));
  const preload = join(dir, 'stub.mjs');
  writeFileSync(
    preload,
    `
const SSM = ${JSON.stringify(ssm)};
const KV = ${JSON.stringify(kv)};
const KV_STATUS = ${kvStatus};
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.includes('ssm.') && u.includes('amazonaws.com')) {
    const body = JSON.parse(init.body);
    // The reachability probe and any name other than the one under test are absent from SSM too.
    if (SSM === null || !String(body.Name).endsWith(${JSON.stringify(NAME)})) {
      return new Response(JSON.stringify({ __type: 'ParameterNotFound' }), { status: 400 });
    }
    return new Response(JSON.stringify({ Parameter: { Value: SSM } }), { status: 200 });
  }
  if (u.includes('login.microsoftonline.com')) {
    return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 });
  }
  if (u.includes('vault.azure.net')) {
    // The up-front reachability probe must get a real HTTP answer (404 is a fine one).
    if (u.includes('secret-drift-reachability-probe-0000')) return new Response('{}', { status: 404 });
    if (KV === null) return new Response('{}', { status: KV_STATUS });
    return new Response(JSON.stringify({ value: KV }), { status: 200 });
  }
  return new Response('{}', { status: 404 });
};
`,
  );
  // An empty PATH keeps the az CLI out of reach, so the "no Azure credential" case is genuinely
  // credential-free rather than quietly rescued by a logged-in az on the runner.
  const env = {
    HOME: dir,
    PATH: dir,
    AWS_REGION: 'us-east-1',
    AWS_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
    AWS_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    ...(azureAuth
      ? { AZURE_SP_CLIENT_ID: 'c', AZURE_SP_CLIENT_SECRET: 's', AZURE_SP_TENANT_ID: 't' }
      : {}),
  };
  let code = 0, stdout = '', stderr = '';
  try {
    stdout = execFileSync(process.execPath, ['--import', preload, DRIFT, NAME], {
      encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    code = e.status ?? 1;
    stdout = e.stdout ?? '';
    stderr = e.stderr ?? '';
  }
  return { code, stdout, stderr, all: stdout + stderr };
}

test('THE REGRESSION: SSM has a secret the vault does not, and that is reported as divergence', () => {
  // Before the fix this printed in-sync=1 and exited 0, because the "key vault value" it compared
  // was the SSM value that resolveSecret() had fallen through to fetch.
  const r = runDrift({ ssm: 'only-in-ssm', kv: null, kvStatus: 404 });
  assert.match(r.all, /KV-MISSING/, 'a secret present in one store and absent from the other is divergence');
  assert.equal(r.code, 1, 'divergence must exit non-zero');
  assert.ok(!/in-sync=1/.test(r.all), 'must never report agreement it did not observe');
});

test('a 5xx from the vault is INCONCLUSIVE, never agreement', () => {
  const r = runDrift({ ssm: 'v', kv: null, kvStatus: 500 });
  assert.match(r.all, /UNKNOWN/, 'a vault that errored tells us nothing about the secret');
  assert.ok(!/in-sync=1/.test(r.all), 'an error must not be counted as agreement');
  assert.equal(r.code, 2, 'inconclusive must exit with the cannot-compare code, not 0');
});

test('a 403 from the vault is INCONCLUSIVE, never agreement (blind on main too)', () => {
  const r = runDrift({ ssm: 'v', kv: null, kvStatus: 403 });
  assert.match(r.all, /UNKNOWN/);
  assert.ok(!/in-sync=1/.test(r.all));
  assert.equal(r.code, 2);
});

test('genuinely divergent values are still reported as DRIFT', () => {
  const r = runDrift({ ssm: 'value-a', kv: 'value-b' });
  assert.match(r.all, /DRIFT/);
  assert.equal(r.code, 1);
  // Values are compared by hash and must never be printed.
  assert.ok(!r.all.includes('value-a') && !r.all.includes('value-b'), 'secret values must never be logged');
});

test('genuinely matching values are still reported as in-sync, exit 0', () => {
  // The counterweight: the fix must not make every run fail. A real agreement still reads clean.
  const r = runDrift({ ssm: 'same', kv: 'same' });
  assert.match(r.all, /in-sync=1/);
  assert.equal(r.code, 0);
});

test('no resolvable Azure credential is CANNOT-COMPARE, not a clean bill of health', () => {
  // This is the state of every seat today. It must be loud, must not exit 0, and must not spray a
  // KV-MISSING line per secret either.
  const r = runDrift({ ssm: 'v', azureAuth: false });
  assert.match(r.all, /CANNOT COMPARE/, 'must say plainly that nothing was compared');
  assert.equal(r.code, 2, 'cannot-compare gets its own exit code, distinct from 0 and from drift');
  assert.ok(!/in-sync=1/.test(r.all), 'must not report agreement');
  assert.ok(!/KV-MISSING/.test(r.all), 'must not turn an unreachable vault into per-secret false alarms');
});

test('the checker reads the vault leg DIRECTLY, never through the cross-store resolver', () => {
  // Structural guard. The bug was not a bad flag value, it was routing the comparison through a
  // resolver whose purpose is to obscure which store answered. A future edit that reintroduces
  // kvSecret() here would reintroduce the blindness even if every behavioural test above still
  // passed on a reachable vault.
  const src = readFileSyncUtf8(DRIFT);
  assert.match(src, /import \{ keyVaultRead \} from "\.\/azure-secret\.mjs"/,
    'must import the Key-Vault-only leg');
  // Strip line comments: the header documents the old bug by name on purpose, and a guard that
  // matched prose would fire on the explanation instead of the code.
  const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.ok(!/\bkvSecret\b/.test(code),
    'must not use the cross-store resolver to read the store it is checking');
  assert.ok(!/SECRET_BACKEND/.test(code),
    'must not depend on SECRET_BACKEND at all; that dependency was the defeated defense');
});

function readFileSyncUtf8(p) {
  return execFileSync('cat', [p], { encoding: 'utf8' });
}
