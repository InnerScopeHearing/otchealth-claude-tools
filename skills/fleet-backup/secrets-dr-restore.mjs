#!/usr/bin/env node
/**
 * secrets-dr-restore.mjs — decrypt a secrets-dr-export.mjs archive. This is the "morning Azure is
 * dead" tool: pull the .enc file from S3 (or from Matt's OneDrive/local disk copy) and this script
 * turns it back into usable credentials, either as a printed report (names + which ones exist) or,
 * with --print-values, the actual values (only ever run that locally/interactively, never in CI logs).
 *
 * USAGE:
 *   node secrets-dr-restore.mjs <file.enc> <passphrase>                 # names + counts only (safe to log)
 *   node secrets-dr-restore.mjs <file.enc> <passphrase> --print-values  # full plaintext (careful)
 *   node secrets-dr-restore.mjs <file.enc> <passphrase> --to-env-file out.env  # writes KEY=value lines
 */
import crypto from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

function decrypt(buf, passphrase) {
  const salt = buf.subarray(0, 16);
  const iv = buf.subarray(16, 28);
  const authTag = buf.subarray(28, 44);
  const ciphertext = buf.subarray(44);
  const key = crypto.scryptSync(passphrase, salt, 32);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function main() {
  const [file, passphrase, ...rest] = process.argv.slice(2);
  if (!file || !passphrase) {
    console.error("usage: secrets-dr-restore.mjs <file.enc> <passphrase> [--print-values | --to-env-file out.env]");
    process.exit(2);
  }
  const buf = readFileSync(file);
  let plaintext;
  try {
    plaintext = decrypt(buf, passphrase);
  } catch (e) {
    console.error("decrypt failed — wrong passphrase, or the file is corrupt/truncated.");
    process.exit(1);
  }
  const data = JSON.parse(plaintext.toString("utf8"));
  const names = Object.keys(data.secrets || {}).sort();

  console.error(`exported: ${data.exportedAt}  vault: ${data.vault}  secrets: ${names.length}`);

  const envFileIdx = rest.indexOf("--to-env-file");
  if (envFileIdx !== -1) {
    const outPath = rest[envFileIdx + 1];
    if (!outPath) { console.error("--to-env-file needs a path"); process.exit(2); }
    const lines = names.map((n) => {
      const envName = n.toUpperCase().replace(/-/g, "_");
      const v = String(data.secrets[n]).replace(/\n/g, "\\n");
      return `${envName}=${v}`;
    });
    writeFileSync(outPath, lines.join("\n") + "\n", { mode: 0o600 });
    console.error(`wrote ${names.length} KEY=value lines to ${outPath} (mode 600). Delete this file once no longer needed.`);
    return;
  }

  if (rest.includes("--print-values")) {
    for (const n of names) console.log(`${n} = ${data.secrets[n]}`);
  } else {
    console.log(names.join("\n"));
    console.error("\n(names only — pass --print-values or --to-env-file <path> to see actual values)");
  }
}

main();
