#!/usr/bin/env node
/**
 * secrets-dr-restore.mjs — decrypt a secrets-dr-export.mjs archive. This is the "morning Azure is
 * dead" tool: pull the .enc file from S3 (or from Matt's OneDrive/local disk copy) and this script
 * turns it back into usable credentials, either as a printed report (names + which ones exist) or,
 * with --print-values, the actual values (only ever run that locally/interactively).
 *
 * PASSPHRASE INPUT (fixed 2026-07-28 review finding): this decrypts the entire company credential
 * inventory, so the passphrase is NEVER accepted as a positional CLI argument — that would land it in
 * shell history and in `ps`/process-list output for any other user on the box. Provide it one of three
 * ways, checked in this order:
 *   1. --passphrase-file <path>   read the passphrase from a file (e.g. one you just pasted it into)
 *   2. SECRETS_DR_PASSPHRASE env var
 *   3. an interactive, non-echoing terminal prompt (if none of the above is set and stdin is a TTY)
 *
 * USAGE:
 *   node secrets-dr-restore.mjs <file.enc>                                   # prompts for passphrase
 *   node secrets-dr-restore.mjs <file.enc> --passphrase-file pass.txt
 *   SECRETS_DR_PASSPHRASE=... node secrets-dr-restore.mjs <file.enc> --print-values
 *   node secrets-dr-restore.mjs <file.enc> --passphrase-file pass.txt --to-env-file out.env
 */
import { readFileSync, writeFileSync, fchmodSync, openSync, closeSync, constants as fsConstants } from "node:fs";
import { createInterface } from "node:readline";
import { decrypt } from "./crypto-envelope.mjs";

function readPassphraseFromFile(path) {
  return readFileSync(path, "utf8").trim();
}

function promptPassphrase() {
  return new Promise((resolvePromise, rejectPromise) => {
    if (!process.stdin.isTTY) {
      rejectPromise(new Error("no passphrase source given (--passphrase-file or SECRETS_DR_PASSPHRASE) and stdin is not a TTY to prompt on"));
      return;
    }
    process.stdout.write("DR passphrase (input hidden): ");
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    // Hide echoed input by intercepting the output write — readline has no built-in "silent" mode.
    const originalWrite = rl._writeToOutput ? rl._writeToOutput.bind(rl) : null;
    if (originalWrite) rl._writeToOutput = () => {};
    rl.question("", (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolvePromise(answer.trim());
    });
  });
}

// Guarantees the final file mode is 0600 REGARDLESS of whether outPath already existed, AND that it is
// 0600 for the ENTIRE duration of the write, not just after. Two review findings, same root cause:
// (1) the `mode` argument to open()/openSync() is a POSIX no-op for a file that already exists — only
// file CREATION honors it — so overwriting a pre-existing, looser-permissioned file would silently
// leave those old permissions in place unless fixed some other way; (2) the earlier fix called
// chmodSync() AFTER writeFileSync() completed, which closed gap (1) but left a race window during the
// write itself — a pre-existing group/world-readable file would briefly hold the new secret contents
// under the OLD, looser mode. Fixed by chmod'ing the OPEN FILE DESCRIPTOR (fchmodSync) immediately
// after opening, before any content is written — correct for both a brand-new file and an overwrite.
function writeOwnerOnly(outPath, contents) {
  const fd = openSync(outPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC, 0o600);
  try {
    fchmodSync(fd, 0o600); // fixes an existing file's mode BEFORE any write touches it
    writeFileSync(fd, contents);
  } finally {
    closeSync(fd);
  }
}

// Dotenv-safe quoting: wrap in double quotes, escape backslashes/double-quotes, and escape real
// newlines as \n — lossless for multi-line values like PEM keys under standard dotenv-style parsers
// that support double-quoted values with backslash-escape expansion (dotenv, python-dotenv). The
// earlier unquoted version broke on any value containing `#` (parsed as a comment) or a literal
// newline (many loaders do not expand a bare `\n` outside quotes).
function toEnvLine(envName, value) {
  const escaped = String(value)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r");
  return `${envName}="${escaped}"`;
}

async function resolvePassphrase(rest) {
  const fileIdx = rest.indexOf("--passphrase-file");
  if (fileIdx !== -1) {
    const p = rest[fileIdx + 1];
    if (!p) throw new Error("--passphrase-file needs a path");
    return readPassphraseFromFile(p);
  }
  if (process.env.SECRETS_DR_PASSPHRASE) return process.env.SECRETS_DR_PASSPHRASE.trim();
  return promptPassphrase();
}

async function main() {
  const [file, ...rest] = process.argv.slice(2);
  if (!file) {
    console.error("usage: secrets-dr-restore.mjs <file.enc> [--passphrase-file <path>] [--print-values | --to-env-file out.env]");
    console.error("       (or set SECRETS_DR_PASSPHRASE in the environment)");
    process.exit(2);
  }

  const passphrase = await resolvePassphrase(rest);
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
    const lines = names.map((n) => toEnvLine(n.toUpperCase().replace(/-/g, "_"), data.secrets[n]));
    writeOwnerOnly(outPath, lines.join("\n") + "\n");
    console.error(`wrote ${names.length} KEY="value" lines to ${outPath} (mode 600). Delete this file once no longer needed.`);
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
