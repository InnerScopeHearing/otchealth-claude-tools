// Tests for secrets-dr-restore.mjs's --to-env-file output path (2026-07-28 review finding: no
// automated test exercised this at all -- the crypto-envelope tests cover encrypt/decrypt, but not
// this script's own security guarantees: the output file must always end up owner-only (0600), even
// when it OVERWRITES a pre-existing, more-permissively-moded file, and every value must round-trip
// exactly through base64 regardless of embedded newlines/JSON/PEM content (see writeOwnerOnly()'s and
// toEnvLine()'s own header comments in secrets-dr-restore.mjs for the two bugs this pins against
// regressing: chmod-after-write leaving a race window, and backslash-escaping corrupting a value that
// already contains a literal `\n` two-character sequence).
//
// Runs the script as a real subprocess (matches how it's actually invoked -- a CLI/subprocess test is
// what the review asked for, and it exercises the full path: resolvePassphrase -> decrypt -> the
// --to-env-file branch -> writeOwnerOnly), rather than importing its unexported internals.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, statSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { encrypt } from "../skills/fleet-backup/crypto-envelope.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const RESTORE_SCRIPT = resolve(HERE, "..", "skills", "fleet-backup", "secrets-dr-restore.mjs");
const PASSPHRASE = "test passphrase for secrets-dr-restore.test.mjs only";

// A representative slice of the real secret shapes this archive holds: a plain token, a PEM-style
// multi-line value, and a JSON-blob-style value that contains a LITERAL two-character `\n` sequence
// (the exact case toEnvLine()'s header comment calls out as the reason base64, not backslash-escaping,
// is used -- a naive escaper can re-escape that into `\\n` and corrupt the round-trip depending on a
// downstream parser's escape-resolution order).
const SECRETS = {
  "plain-api-key": "sk_live_abc123XYZ",
  "pem-like-key": "-----BEGIN PRIVATE KEY-----\nMIIExampleNotARealKey\n-----END PRIVATE KEY-----\n",
  "json-with-literal-backslash-n": '{"note":"line1\\nline2","real_newline":"a\nb"}',
};

function buildArchive(dir) {
  const payload = JSON.stringify({ exportedAt: "2026-07-28T00:00:00Z", vault: "kv-otc-test", secrets: SECRETS });
  const enc = encrypt(Buffer.from(payload, "utf8"), PASSPHRASE);
  const file = join(dir, "test-archive.json.enc");
  writeFileSync(file, enc);
  return file;
}

test("--to-env-file always ends up mode 0600, even overwriting a pre-existing world-readable file", () => {
  const dir = mkdtempSync(join(tmpdir(), "secrets-dr-restore-test-"));
  try {
    const archive = buildArchive(dir);
    const outFile = join(dir, "out.env");
    // Pre-create the target file wide open (0666) BEFORE the restore runs, to prove the fix covers an
    // OVERWRITE of an existing looser-permissioned file, not just fresh creation (the bug this pins:
    // the `mode` argument to open()/openSync() is a POSIX no-op on an already-existing file).
    writeFileSync(outFile, "stale content");
    chmodSync(outFile, 0o666);

    execFileSync("node", [RESTORE_SCRIPT, archive, "--to-env-file", outFile], {
      env: { ...process.env, SECRETS_DR_PASSPHRASE: PASSPHRASE },
      stdio: "pipe",
    });

    const mode = statSync(outFile).mode & 0o777;
    assert.equal(mode, 0o600, `expected mode 0600, got ${mode.toString(8)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--to-env-file base64-round-trips a plain value, a PEM-style multi-line value, and a value with a literal backslash-n", () => {
  const dir = mkdtempSync(join(tmpdir(), "secrets-dr-restore-test-"));
  try {
    const archive = buildArchive(dir);
    const outFile = join(dir, "out.env");

    execFileSync("node", [RESTORE_SCRIPT, archive, "--to-env-file", outFile], {
      env: { ...process.env, SECRETS_DR_PASSPHRASE: PASSPHRASE },
      stdio: "pipe",
    });

    const lines = readFileSync(outFile, "utf8").trim().split("\n");
    const decoded = {};
    for (const line of lines) {
      const eq = line.indexOf("=");
      const envName = line.slice(0, eq);
      const b64Value = line.slice(eq + 1);
      decoded[envName] = Buffer.from(b64Value, "base64").toString("utf8");
    }

    assert.equal(decoded["PLAIN_API_KEY"], SECRETS["plain-api-key"]);
    assert.equal(decoded["PEM_LIKE_KEY"], SECRETS["pem-like-key"]);
    assert.equal(decoded["JSON_WITH_LITERAL_BACKSLASH_N"], SECRETS["json-with-literal-backslash-n"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
