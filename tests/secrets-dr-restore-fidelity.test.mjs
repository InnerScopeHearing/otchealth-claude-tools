import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, copyFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { encrypt } from "../skills/fleet-backup/crypto-envelope.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const passphrase = "synthetic test passphrase";
const secretValue = "synthetic-value-never-print";
for (const [label, fidelity, expected, useJunction] of [
  ["degraded", "degraded", /WARNING: archive reports degraded restore metadata/],
  ["legacy full", "full", /older full labels may be incomplete/],
  ["unknown", "untrusted-synthetic-value", /WARNING: archive restore metadata fidelity is unknown/],
  ["degraded through directory link", "degraded", /WARNING: archive reports degraded restore metadata/, true],
]) {
  test(`--to-ssm --dry-run warns about ${label} metadata without exposing values`, () => {
    const dir = mkdtempSync(join(tmpdir(), "restore fidelity test "));
    try {
      const base = join(dir, "skills", "fleet-backup");
      const kb = join(dir, "skills", "kb-memory");
      mkdirSync(base, { recursive: true });
      mkdirSync(kb, { recursive: true });
      const script = join(base, "secrets-dr-restore.mjs");
      copyFileSync(join(repository, "skills", "fleet-backup", "secrets-dr-restore.mjs"), script);
      copyFileSync(join(repository, "skills", "fleet-backup", "crypto-envelope.mjs"), join(base, "crypto-envelope.mjs"));
      writeFileSync(join(kb, "aws-secret.mjs"), "export async function ssmPutParameterFull() { throw new Error('unexpected cloud write'); }");
      const file = join(dir, "sample.enc");
      const payload = { exportedAt: "2026-01-01", vault: "synthetic", secrets: { example: secretValue }, restoreFidelity: fidelity };
      writeFileSync(file, encrypt(Buffer.from(JSON.stringify(payload)), passphrase));
      let launchScript = script;
      if (useJunction) {
        const link = join(dir, "linked restore");
        symlinkSync(base, link, process.platform === "win32" ? "junction" : "dir");
        launchScript = join(link, "secrets-dr-restore.mjs");
      }
      const result = spawnSync(process.execPath, [launchScript, file, "--to-ssm", "--dry-run"], {
        env: { ...process.env, SECRETS_DR_PASSPHRASE: passphrase },
        encoding: "utf8", timeout: 10000,
      });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stderr, expected);
      assert.match(result.stdout, /would write 1 parameter/);
      assert.doesNotMatch(result.stdout + result.stderr, /synthetic-value-never-print|untrusted-synthetic-value/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
