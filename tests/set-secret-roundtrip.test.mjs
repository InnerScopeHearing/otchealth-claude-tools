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
//
// AND IT MUST TEST WRITE CAPABILITY, NOT CREDENTIAL PRESENCE (tightened 2026-08-18). The first
// version of that fix used ssmAvailable(), which is literally `(await awsCreds()) !== null` -- it
// answers "are there credentials on this seat", not "may they write". On a read-only-SSM seat
// (ssm:GetParameter but no ssm:PutParameter, a perfectly ordinary least-privilege grant) it
// returned true, the test RAN, PutParameter 403'd and the suite went red for a reason that has
// nothing to do with the code under test. A skip guard that is wrong in the FAILING direction is
// less dangerous than one wrong in the passing direction, but it is still a guard reporting
// something it did not check. So the guard now performs the smallest real write it can -- put one
// synthetic throwaway parameter, then delete it -- and skips only if that write is refused.
//
// THE WRITE PROBE IS NOW OPT-IN, NOT UNCONDITIONAL (fixed 2026-08-18, same day). ssmWritable() ran
// at MODULE LOAD TIME -- a top-level `await`, before any individual test even started -- so every
// ordinary `run-tests.sh` / `node --test` sweep paid for a REAL network round trip (a PutParameter,
// then a DeleteParameter) against live AWS SSM regardless of whether anyone asked for a live
// verification. Measured: this was the single cause of the toolkit suite going from ~35s to ~113s
// (3.25x), not the ~3% a prior pass reported -- a network call that is merely SLOW in one
// environment (a sandboxed proxy that does not fast-fail an unreachable host) can be arbitrarily
// slow in another, and "arbitrarily slow" run on every single unit-test invocation is the wrong
// shape no matter the actual number. A round-trip write test against a REAL external store is
// legitimate and worth keeping, but it belongs behind an explicit opt-in, the same way
// RUN_BROWSER_TESTS gates the heavier browser-agent selftest in run-tests.sh -- never a default
// cost every contributor and every CI run pays on every pass. Set LIVE_SECRET_ROUNDTRIP=1 to run
// the real probe and, if it succeeds, the real round-trip test. Unset (the default), the probe
// itself never touches the network, and the test reports a clear, honest skip explaining how to
// opt in -- it must never look like the write was attempted and failed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { vaultToken, secretBackend } from '../skills/kb-memory/azure-secret.mjs';
import { ssmAvailable, ssmSecretSet, ssmSecretDelete } from '../skills/kb-memory/aws-secret.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SET_SECRET = join(ROOT, 'setup', 'set-secret.mjs');
const GET_SECRET = join(ROOT, 'setup', 'get-secret.mjs');
const VAULT = process.env.AZURE_KEYVAULT_NAME || 'kv-otc-55c84f6bef';

const BACKEND = secretBackend();

/**
 * Can this seat actually WRITE to SSM? Probes with one synthetic throwaway parameter and removes
 * it. Never throws: any refusal (no credentials, no ssm:PutParameter) is reported as "cannot run".
 *
 * The probe is the same operation the test performs, so a probe that succeeds means the test's own
 * write will too -- which is the property a skip guard has to have to be trustworthy.
 */
async function ssmWritable() {
  if (!(await ssmAvailable())) return false;
  const probe = `set-secret-roundtrip-probe-${Date.now()}-${randomUUID().slice(0, 8)}`;
  let ok = false;
  try {
    ok = await ssmSecretSet(probe, 'synthetic-probe-value'); // never a real credential
  } catch {
    ok = false;
  }
  if (ok) {
    try {
      await ssmSecretDelete(probe);
    } catch {
      /* teardown is best-effort; a leftover probe parameter is noise, not a failure */
    }
  }
  return ok;
}

// OPT-IN, NOT UNCONDITIONAL (fixed 2026-08-18): the real network probe below (a PutParameter, then
// a DeleteParameter against live AWS SSM) used to run at MODULE LOAD TIME on every single
// `node --test`/run-tests.sh pass -- see this file's header for the measured 3.25x suite-duration
// regression that caused. `LIVE_SECRET_ROUNDTRIP=1` is the explicit request for a real live
// verification; unset (the default, including CI and every ordinary local run), the probe function
// is never even called, so this file makes ZERO network calls and the round-trip test reports a
// clear, correctly-worded skip explaining that it was never attempted -- never one that reads as
// "the store refused the write", which would be a false claim about a check that did not run.
const LIVE = process.env.LIVE_SECRET_ROUNDTRIP === '1';

// Write capability of the store the write path will actually use -- not of whichever store happened
// to be primary when this file was written, and not merely whether credentials exist.
// NOTE, stated rather than hidden: the Key Vault arm is still a PRESENCE check (vaultToken()), not
// a write probe. It is left that way deliberately -- SECRET_BACKEND=keyvault points at a retired
// subscription where vaultToken() already returns null, so the arm skips for the right reason
// today, and minting a real write against a dead vault would prove nothing. If Key Vault ever comes
// back as primary, this arm needs the same probe treatment.
const ACTIVE_STORE_WRITABLE =
  LIVE && (BACKEND === 'ssm' ? await ssmWritable() : (await vaultToken()) !== null);

test('set-secret.mjs -> get-secret.mjs round-trip: a written value reads back byte-identical', async (t) => {
  if (!LIVE) {
    t.skip(
      `LIVE_SECRET_ROUNDTRIP is not set, so this test never attempted a network call (the default, ` +
        `and the fast path every ordinary run-tests.sh / node --test pass takes). Set ` +
        `LIVE_SECRET_ROUNDTRIP=1 to actually probe SECRET_BACKEND=${BACKEND} and, if it accepts a ` +
        `write, run the real round trip against it.`,
    );
    return;
  }
  if (!ACTIVE_STORE_WRITABLE) {
    t.skip(
      `LIVE_SECRET_ROUNDTRIP=1 was set, but SECRET_BACKEND=${BACKEND} did not accept a write from this ` +
        `seat, so there is nothing to round-trip against. For SSM: a task role, or ` +
        `AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY with ssm:PutParameter + ssm:GetParameter + ` +
        `ssm:DeleteParameter on ${process.env.AWS_SSM_PREFIX || '/otchealth'}/*. For Key Vault: any ` +
        `credential vaultToken() accepts. This skips ONLY when genuinely unrunnable; it must not ` +
        `skip on a working configuration.`,
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
  // PRESENCE IS NOT CAPABILITY. ssmAvailable() is `(await awsCreds()) !== null` -- it cannot tell a
  // read-only seat from a writable one, so on an ordinary least-privilege grant the guard said RUN
  // and PutParameter then 403'd. The guard has to actually attempt the write it is gating.
  assert.match(code, /ssmSecretSet\(/, 'the guard must PROBE the write, not just check for credentials');
  assert.ok(
    /ACTIVE_STORE_WRITABLE[\s\S]*ssmWritable\(\)/.test(code),
    'the gate the test reads must be the write probe',
  );
});

test('REGRESSION GUARD: the real network probe stays opt-in, never unconditional at module load', () => {
  // Direct guard against the exact regression this round fixed: ssmWritable() (a real
  // PutParameter+DeleteParameter round trip) running unconditionally at top-level await cost every
  // ordinary test run a live network call and 3.25x'd the whole toolkit suite's duration. Anyone
  // deleting the LIVE_SECRET_ROUNDTRIP gate to "simplify" this file must fail here, loudly, rather
  // than the suite silently getting slow again with no test pointing at why.
  const src = execFileSync('cat', [join(ROOT, 'tests', 'set-secret-roundtrip.test.mjs')], { encoding: 'utf8' });
  const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.match(code, /LIVE_SECRET_ROUNDTRIP/, 'the opt-in env gate must exist in source');
  // The gate must actually SHORT-CIRCUIT ssmWritable() -- `LIVE &&` before the call, not merely
  // present somewhere in the file. `&&` short-circuits in JS, so when LIVE is false the right side
  // (the network call) is never evaluated at all.
  assert.match(
    code,
    /LIVE\s*&&\s*\(BACKEND\s*===\s*'ssm'\s*\?\s*await ssmWritable\(\)/,
    'LIVE must short-circuit the write probe, not merely be read afterward',
  );
});
