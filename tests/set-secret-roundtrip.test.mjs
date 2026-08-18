// Round-trip guard for the fleet's secret WRITE path: setup/set-secret.mjs writes a value and
// setup/get-secret.mjs reads it back byte-identical, end to end through the real CLI scripts, using
// an obviously-synthetic throwaway name/value (never a real credential, per the fleet's hard rule
// that no secret VALUE lands in a repo or a fixture).
//
// THE SKIP GUARD WAS INVERTED FOR THE POST-AZURE WORLD (fixed 2026-08-18). It gated on
// AZURE_SP_CLIENT_ID/_SECRET/_TENANT_ID, written when Key Vault was the only store. After the SSM
// cutover those three variables are still present on agent seats -- they are the credentials of a
// PERMANENTLY DELETED subscription -- so the guard read "live creds available" and RAN the test
// against a vault that cannot answer, failing every time. Meanwhile AWS SSM, the store the write
// path actually uses, had no bearing on the guard at all. The test therefore SKIPPED on the
// configuration that works and RAN on the one that cannot: the only test pinning the write path
// never meaningfully executed.
//
// The guard now asks the same question the write path asks: is the ACTIVE store reachable?
// kvSecretSet() returns success when the ACTIVE PRIMARY took the write (SSM under SECRET_BACKEND=
// ssm, the default; Key Vault under SECRET_BACKEND=keyvault), so runnability is exactly the
// reachability of whichever store that is. Anything else is a genuine skip.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { vaultToken, secretBackend } from '../skills/kb-memory/azure-secret.mjs';
import { ssmAvailable, ssmSecretDelete } from '../skills/kb-memory/aws-secret.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SET_SECRET = join(ROOT, 'setup', 'set-secret.mjs');
const GET_SECRET = join(ROOT, 'setup', 'get-secret.mjs');
const VAULT = process.env.AZURE_KEYVAULT_NAME || 'kv-otc-55c84f6bef';

const BACKEND = secretBackend();
// Reachability of the store the write path will actually use -- not of whichever store happened to
// be primary when this file was written.
const ACTIVE_STORE_REACHABLE =
  BACKEND === 'ssm' ? await ssmAvailable() : (await vaultToken()) !== null;

test('set-secret.mjs -> get-secret.mjs round-trip: a written value reads back byte-identical', async (t) => {
  if (!ACTIVE_STORE_REACHABLE) {
    t.skip(
      `SECRET_BACKEND=${BACKEND} but that store is not reachable from this seat, so there is nothing ` +
        `to round-trip against. For SSM: a task role, or AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY with ` +
        `ssm:PutParameter + ssm:GetParameter + ssm:DeleteParameter on ${process.env.AWS_SSM_PREFIX || '/otchealth'}/*. ` +
        `For Key Vault: any credential vaultToken() accepts. This skips ONLY when genuinely unrunnable; ` +
        `it must not skip on a working configuration.`,
    );
    return;
  }

  const name = `set-secret-roundtrip-test-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const value = `synthetic-test-value-${randomUUID()}`; // obviously fake, never a real credential

  // A second, multi-line value ending in a newline: the PEM shape. get-secret.mjs is the fleet's
  // byte-materializer for .p8 signing keys, and a trim anywhere in the resolver silently eats that
  // final byte. Against a real store this is the end-to-end proof that it does not.
  const pemName = `${name}-pem`;
  const pemValue = `-----BEGIN TEST-----\nsynthetic-${randomUUID()}\n-----END TEST-----\n`;

  try {
    execFileSync('node', [SET_SECRET, name, value], { encoding: 'utf8' });
    const readBack = execFileSync('node', [GET_SECRET, name], { encoding: 'utf8' });
    assert.equal(readBack, value, 'get-secret.mjs must read back exactly what set-secret.mjs wrote');

    execFileSync('node', [SET_SECRET, pemName, pemValue], { encoding: 'utf8' });
    const pemBack = execFileSync('node', [GET_SECRET, pemName], { encoding: 'utf8' });
    assert.equal(pemBack, pemValue, 'a multi-line value must survive the round-trip byte-for-byte');
    assert.ok(pemBack.endsWith('\n'), 'the terminating newline of a PEM must survive the round-trip');
  } finally {
    // Teardown, never asserted. SSM is always written by kvSecretSet(), so it is always cleaned;
    // the Key Vault leg is attempted only best-effort, and on a purge-protected vault a rejected
    // purge (HTTP 403) is expected Key Vault behaviour, not a defect.
    for (const n of [name, pemName]) {
      try { await ssmSecretDelete(n); } catch { /* teardown only */ }
    }
    const tok = await vaultToken();
    if (tok) {
      for (const n of [name, pemName]) {
        for (const path of [`secrets/${n}`, `deletedsecrets/${n}`]) {
          try {
            await fetch(`https://${VAULT}.vault.azure.net/${path}?api-version=7.4`, {
              method: 'DELETE',
              headers: { Authorization: `Bearer ${tok}` },
            });
          } catch { /* best-effort cleanup only; never fail the test on teardown */ }
        }
      }
    }
  }
});

test('the skip guard tracks the ACTIVE store, not a hardcoded Azure credential', () => {
  // Structural guard for the inversion itself. The behavioural test above cannot catch a re-broken
  // guard, because a wrong guard makes it silently skip -- which is exactly how this went unnoticed.
  const src = execFileSync('cat', [join(ROOT, 'tests', 'set-secret-roundtrip.test.mjs')], { encoding: 'utf8' });
  const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.match(code, /secretBackend\(\)/, 'the guard must consult the active backend');
  assert.match(code, /ssmAvailable\(\)/, 'the guard must consider SSM reachability');
  assert.ok(
    !/const LIVE_CREDS = Boolean\(\s*process\.env\.AZURE_SP_CLIENT_ID/.test(code),
    'the guard must not key off Azure SP vars alone; those are present-but-dead on every seat today',
  );
});
