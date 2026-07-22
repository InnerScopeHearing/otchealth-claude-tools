// Regression + CI round-trip guard for setup/set-secret.mjs, the Key Vault write path (GCP Secret
// Manager is retired). Confirms set-secret.mjs actually writes a value that get-secret.mjs later
// reads back byte-identical, end to end through the real CLI scripts, using an obviously-synthetic
// throwaway secret name/value (never a real credential, per the fleet's hard rule that no secret
// VALUE ever lands in a repo or a test fixture).
//
// LIVE-CREDS ONLY: this needs a real Key Vault to round-trip against, so it follows the fleet's
// established pattern (tests/memory-backend-present.test.mjs; .github/workflows/
// verify-get-secret-migration.yml) of skipping cleanly rather than failing CI when live Azure creds
// are not present, instead of assuming any particular test environment has them. Wire
// AZURE_SP_CLIENT_ID / AZURE_SP_CLIENT_SECRET / AZURE_SP_TENANT_ID as CI secrets to run this for real.
//
// Cleanup: kv-otc-55c84f6bef has purge protection enabled, so a deleted secret cannot be purged
// immediately, it goes through Key Vault's normal soft-delete/retention flow instead. This test
// issues the soft-delete (confirmed live: HTTP 200, removes it from reads/lists) and best-effort
// attempts a purge, but never asserts on the purge call itself: a rejected purge on a purge-protected
// vault (confirmed live: HTTP 403 "purge protection is enabled") is expected Key Vault behavior, not
// a defect in this script or this test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { vaultToken } from '../skills/kb-memory/azure-secret.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SET_SECRET = join(ROOT, 'setup', 'set-secret.mjs');
const GET_SECRET = join(ROOT, 'setup', 'get-secret.mjs');
const VAULT = process.env.AZURE_KEYVAULT_NAME || 'kv-otc-55c84f6bef';

const LIVE_CREDS = Boolean(
  process.env.AZURE_SP_CLIENT_ID && process.env.AZURE_SP_CLIENT_SECRET && process.env.AZURE_SP_TENANT_ID,
);

test('set-secret.mjs -> get-secret.mjs round-trip: a written value reads back byte-identical', async (t) => {
  if (!LIVE_CREDS) {
    t.skip(
      'AZURE_SP_CLIENT_ID/AZURE_SP_CLIENT_SECRET/AZURE_SP_TENANT_ID not set; the round-trip needs a ' +
      'real Key Vault. Set them as CI secrets to run this for real (mirrors the opt-in guard in ' +
      '.github/workflows/verify-get-secret-migration.yml).',
    );
    return;
  }

  const name = `set-secret-roundtrip-test-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const value = `synthetic-test-value-${randomUUID()}`; // obviously fake, never a real credential

  try {
    // 1. write via the actual CLI script under test
    execFileSync('node', [SET_SECRET, name, value], { encoding: 'utf8' });

    // 2. read back via the actual CLI script under test (the sibling read path)
    const readBack = execFileSync('node', [GET_SECRET, name], { encoding: 'utf8' });
    assert.equal(readBack, value, 'get-secret.mjs must read back exactly what set-secret.mjs wrote');
  } finally {
    // 3. best-effort cleanup: soft-delete (verified live to succeed), then attempt a purge (verified
    // live to be rejected on this purge-protected vault) -- neither call's outcome is asserted, this
    // is teardown, not the thing under test.
    const tok = await vaultToken();
    if (tok) {
      try {
        await fetch(`https://${VAULT}.vault.azure.net/secrets/${name}?api-version=7.4`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${tok}` },
        });
      } catch { /* best-effort cleanup only; never fail the test on teardown */ }
      try {
        await fetch(`https://${VAULT}.vault.azure.net/deletedsecrets/${name}?api-version=7.4`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${tok}` },
        });
      } catch { /* purge protection / retention window; expected on this vault, not a failure */ }
    }
  }
});
