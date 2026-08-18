// Byte-fidelity regression for setup/get-secret.mjs — the command every CLAUDE.md in the fleet
// tells an agent to run to materialize a PEM / multiline / binary secret to a file.
//
// THE BUG THIS PINS (2026-08-18). get-secret.mjs was rewritten to resolve through the shared
// kvSecret()/kvSecretStatus() resolver instead of open-coding its own vault fetch. That was the
// right call, but the shared resolver trims: `String(v).trim() || null` in both ssmSecret() and
// keyVaultRead(). Trimming is correct for the ~400 callers that paste a value into an Authorization
// header. It is wrong here, and this is the one call site whose entire purpose is exact bytes.
//
// Measured before the fix, against a 148-byte EC private key ending in \n: 147 bytes on disk,
// exit 0, "[get-secret] wrote 147 bytes" printed as success. The affected ids are real and are all
// Apple signing material -- asc-api-key-p8, medreview-asc-api-key-p8, apple-apns-key-p8,
// flatstick-apple-signin-key-p8 -- plus azure-legal-storage-key, fourvault-neon-database-url and
// the plaid tokens. A .p8 missing its terminating newline is rejected by tools strict about PEM
// framing, and the failure surfaces far from here as an unexplained signing error.
//
// A SECOND INSTANCE OF THE SAME CLASS, also pinned below: `|| null` collapses a whitespace-only
// value to null, so a secret the store IS holding was reported "not available from either store"
// with exit 1.
//
// HOW THIS TESTS WITHOUT A LIVE STORE: the stub replaces globalThis.fetch, so every line of the
// real resolver and the real get-secret.mjs runs untouched -- only the network boundary is faked.
// Both store legs are covered, because the trim existed on both.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GET_SECRET = join(ROOT, 'setup', 'get-secret.mjs');

// A realistic EC private key shape: multi-line, and terminated by a newline the way openssl writes
// one. The trailing \n is the byte that used to vanish.
const PEM = [
  '-----BEGIN PRIVATE KEY-----',
  'MIGTAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBHkwdwIBAQQgSYNTHETICtEsTvALU',
  'EsTtEsTvALUEsTtEsTvALUEsTtEsTvALUEsTtEsTvALUEsTtEsTvALUEsTtEsTvA',
  '-----END PRIVATE KEY-----',
  '',
].join('\n');

/** Run the REAL get-secret.mjs with only the HTTP boundary stubbed. */
function runGetSecret(value, { leg = 'ssm', args = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'getsec-'));
  const preload = join(dir, 'stub.mjs');
  writeFileSync(
    preload,
    `
const VALUE = ${JSON.stringify(value)};
const LEG = ${JSON.stringify(leg)};
globalThis.fetch = async (url) => {
  const u = String(url);
  // AWS SSM (SigV4 POST to ssm.<region>.amazonaws.com)
  if (u.includes('ssm.') && u.includes('amazonaws.com')) {
    if (LEG !== 'ssm') return new Response('{}', { status: 400 });
    return new Response(JSON.stringify({ Parameter: { Value: VALUE } }), { status: 200 });
  }
  // Entra token mint for the Key Vault leg
  if (u.includes('login.microsoftonline.com')) {
    return new Response(JSON.stringify({ access_token: 'test-token', expires_in: 3600 }), { status: 200 });
  }
  if (u.includes('vault.azure.net')) {
    if (LEG !== 'kv') return new Response('{}', { status: 404 });
    return new Response(JSON.stringify({ value: VALUE }), { status: 200 });
  }
  return new Response('{}', { status: 404 });
};
`,
  );
  const outfile = join(dir, 'out.pem');
  const env = {
    ...process.env,
    SECRET_BACKEND: leg === 'ssm' ? 'ssm' : 'keyvault',
    // Real-looking creds so awsCreds()/spToken() take their normal path into the stubbed fetch.
    AWS_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
    AWS_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    AWS_SESSION_TOKEN: '',
    AZURE_SP_CLIENT_ID: 'test-client',
    AZURE_SP_CLIENT_SECRET: 'test-secret',
    AZURE_SP_TENANT_ID: 'test-tenant',
  };
  delete env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI;
  delete env.AWS_CONTAINER_CREDENTIALS_FULL_URI;
  let code = 0, stdout = '';
  try {
    stdout = execFileSync('node', ['--import', preload, GET_SECRET, 'test-secret-id', ...args, ...(args.length ? [] : [outfile])], {
      encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    code = e.status ?? 1;
    stdout = e.stdout ?? '';
  }
  return { code, stdout, outfile, dir };
}

test('a PEM written to a file keeps its terminating newline (SSM leg)', () => {
  const r = runGetSecret(PEM);
  assert.equal(r.code, 0, 'a resolvable secret must exit 0');
  const bytes = readFileSync(r.outfile);
  assert.equal(bytes.length, Buffer.byteLength(PEM), `expected ${Buffer.byteLength(PEM)} bytes on disk, got ${bytes.length}`);
  assert.equal(bytes[bytes.length - 1], 0x0a, 'the final byte of a PEM must be the newline the store holds');
  assert.equal(bytes.toString('utf8'), PEM, 'the file must be byte-identical to the stored value');
});

test('a PEM written to a file keeps its terminating newline (Key Vault leg)', () => {
  // The trim was on BOTH legs, so a fix applied to only one would still corrupt a vault-served key.
  const r = runGetSecret(PEM, { leg: 'kv' });
  assert.equal(r.code, 0);
  const bytes = readFileSync(r.outfile);
  assert.equal(bytes.toString('utf8'), PEM, 'the Key Vault leg must be byte-exact too');
});

test('stdout mode is byte-exact as well (no trailing newline added OR removed)', () => {
  // The existing suite already pins "does not APPEND a newline". This pins the other direction,
  // which is the one that was broken: it must not REMOVE one either.
  const r = runGetSecret(PEM, { args: [] });
  const stdoutRun = runGetSecretStdout(PEM);
  assert.equal(stdoutRun, PEM, 'piping to $(...) must yield the stored bytes exactly');
  void r;
});

function runGetSecretStdout(value) {
  const dir = mkdtempSync(join(tmpdir(), 'getsec-so-'));
  const preload = join(dir, 'stub.mjs');
  writeFileSync(
    preload,
    `const VALUE = ${JSON.stringify(value)};
globalThis.fetch = async (url) => String(url).includes('ssm.') && String(url).includes('amazonaws.com')
  ? new Response(JSON.stringify({ Parameter: { Value: VALUE } }), { status: 200 })
  : new Response('{}', { status: 404 });`,
  );
  const env = {
    ...process.env, SECRET_BACKEND: 'ssm',
    AWS_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
    AWS_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  };
  delete env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI;
  delete env.AWS_CONTAINER_CREDENTIALS_FULL_URI;
  return execFileSync('node', ['--import', preload, GET_SECRET, 'test-secret-id'], {
    encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'ignore'],
  });
}

test('a value that is only whitespace is served, not reported as a total miss', () => {
  // `String(v).trim() || null` turned a present value into null, and get-secret then printed
  // "not available from either store" and exited 1 while the store was holding it. A present
  // secret reported as absent is the same defect class as a missing one reported as present.
  const r = runGetSecret('   \n');
  assert.equal(r.code, 0, 'the store answered; this is not a miss');
  assert.equal(readFileSync(r.outfile, 'utf8'), '   \n');
});

test('the DEFAULT resolver still trims, so the ~400 header/DSN callers are unchanged', async () => {
  // The fix must be scoped to the byte-materializer. If trimming had simply been deleted from the
  // resolver, every caller pasting a value into an Authorization header would inherit stray
  // whitespace instead -- trading one silent corruption for another.
  const { ssmSecret } = await import('../skills/kb-memory/aws-secret.mjs');
  assert.equal(typeof ssmSecret, 'function');
  const src = readFileSync(join(ROOT, 'skills', 'kb-memory', 'aws-secret.mjs'), 'utf8');
  assert.match(src, /raw \? String\(v\) : String\(v\)\.trim\(\) \|\| null/,
    'trim must remain the default and raw must be opt-in');
  const kvSrc = readFileSync(join(ROOT, 'skills', 'kb-memory', 'azure-secret.mjs'), 'utf8');
  assert.match(kvSrc, /raw \? String\(v\) : String\(v\)\.trim\(\) \|\| null/,
    'the Key Vault leg must follow the same opt-in rule');
});

test('the SIBLING materializer setup/get-secret-aws.mjs is byte-exact too', () => {
  // Found by sweeping for the same call shape after fixing get-secret.mjs: get-secret-aws.mjs is
  // the SSM-only helper with the same documented job, and it had the identical trim. Measured
  // before the fix: a 38-byte value written out as 37 bytes, exit 0, success line printed. A fix
  // that closed only one of two adjacent materializers would read as complete while a PEM fetched
  // through the other stayed corrupt.
  const dir = mkdtempSync(join(tmpdir(), 'getsec-aws-'));
  const preload = join(dir, 'stub.mjs');
  writeFileSync(
    preload,
    `const VALUE = ${JSON.stringify(PEM)};
globalThis.fetch = async (url) => String(url).includes('ssm.') && String(url).includes('amazonaws.com')
  ? new Response(JSON.stringify({ Parameter: { Value: VALUE } }), { status: 200 })
  : new Response('{}', { status: 404 });`,
  );
  const outfile = join(dir, 'out.pem');
  const env = {
    ...process.env,
    AWS_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
    AWS_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  };
  delete env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI;
  delete env.AWS_CONTAINER_CREDENTIALS_FULL_URI;
  execFileSync('node', ['--import', preload, join(ROOT, 'setup', 'get-secret-aws.mjs'), 'test-id', outfile], {
    encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(readFileSync(outfile, 'utf8'), PEM, 'the SSM-only helper must be byte-exact as well');
  // The file must never exist world-readable, not even briefly between create and chmod.
  assert.equal(statSync(outfile).mode & 0o777, 0o600, 'the outfile must be created at mode 600');
});

test('get-secret.mjs asks for raw bytes explicitly', () => {
  const src = readFileSync(GET_SECRET, 'utf8');
  assert.match(src, /kvSecretStatus\(id,\s*\{\s*raw:\s*true\s*\}\)/,
    'the byte-materializer must request raw resolution, not inherit the trimming default');
});
