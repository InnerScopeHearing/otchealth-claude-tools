#!/usr/bin/env node
/**
 * secrets-dr-restore.mjs — decrypt a secrets-dr-export.mjs OR ssm-dr-export.mjs archive (the format
 * is source-agnostic: both write the same `{exportedAt, vault, count, secrets}` envelope, and this
 * script has never needed to know which one produced it). This is the "morning the account is dead"
 * tool: pull the .enc file from S3 (or from Matt's OneDrive/local disk copy) and this script turns it
 * back into usable credentials, either as a printed report (names + which ones exist), --print-values
 * (only ever run that locally/interactively), --to-env-file (an owner-only, base64-encoded env file),
 * or --to-ssm (2026-08-28, restores directly into a live AWS SSM Parameter Store -- see that verb's
 * own section below for the restore-fidelity design).
 *
 * PASSPHRASE INPUT (fixed 2026-07-28 review finding): this decrypts the entire company credential
 * inventory, so the passphrase is NEVER accepted as a positional CLI argument — that would land it in
 * shell history and in `ps`/process-list output for any other user on the box. Provide it one of three
 * ways, checked in this order:
 *   1. --passphrase-file <path>   read the passphrase from a file (e.g. one you just pasted it into)
 *   2. SECRETS_DR_PASSPHRASE env var
 *   3. an interactive, non-echoing terminal prompt (if none of the above is set and stdin is a TTY)
 *
 * A NOTE ON METHOD 2 AT AN INTERACTIVE SHELL (2026-07-28 review, round 2): `VAR=value command` prefix
 * syntax avoids `ps`/process-list exposure (env vars are not listed there the way argv is), but if you
 * TYPE the real passphrase directly into an interactive terminal this way, the whole line -- including
 * the real value -- still lands in your shell history exactly like a positional argument would; the env
 * var form is not automatically history-safe. Method 2 is intended for NON-interactive contexts where
 * the value is injected programmatically and never typed (CI/CD secrets, a sourced env file, a secret
 * manager's `export`-and-run wrapper) -- if you are a human at a live terminal, prefer method 1
 * (--passphrase-file, itself reachable without typing the value by piping it in) or method 3 (the
 * hidden-input interactive prompt) instead.
 *
 * USAGE:
 *   node secrets-dr-restore.mjs <file.enc>                                   # prompts for passphrase (safest for a human at a terminal)
 *   node secrets-dr-restore.mjs <file.enc> --passphrase-file pass.txt
 *   SECRETS_DR_PASSPHRASE=... node secrets-dr-restore.mjs <file.enc> --print-values  # non-interactive/CI use only -- see the note above; do not type the real value here at a live terminal
 *   node secrets-dr-restore.mjs <file.enc> --passphrase-file pass.txt --to-env-file out.env
 *   node secrets-dr-restore.mjs <file.enc> --passphrase-file pass.txt --to-ssm [--dry-run]
 *
 * --TO-SSM (2026-08-28, the "restore into a live AWS account" path): writes every recovered parameter
 * back into AWS SSM Parameter Store at /otchealth/<name>, using the archive's own recorded `paramMeta`
 * (Type/Tier/KMS-KeyId) when present, so a String parameter is restored as a String (not silently
 * corrupted into an encrypted SecureString a plain-read consumer cannot use) and a >4KB value is
 * restored with Tier=Advanced (not a hard PutParameter failure). An archive with no `paramMeta` (an
 * older export, or one where DescribeParameters access was unavailable at export time -- see
 * ssm-dr-export.mjs's own "restoreFidelity" reporting) falls back to the same safe
 * SecureString/Standard defaults every restore has always assumed; this verb never refuses to restore
 * just because the fidelity metadata is missing. Prints only NAMES and a pass/fail count, never a
 * value, matching --to-env-file's --print-values-refusal posture. `--dry-run` prints the exact plan
 * (name -> type/tier) without writing anything.
 */
import { readFileSync, writeFileSync, fchmodSync, openSync, closeSync, constants as fsConstants } from "node:fs";
import { createInterface } from "node:readline";
import { decrypt } from "./crypto-envelope.mjs";
import { ssmPutParameterFull } from "../kb-memory/aws-secret.mjs";

/** Pure planner (no network): given the decrypted `secrets` map and the archive's optional
 *  `paramMeta` map, compute exactly what --to-ssm would write, one row per name, sorted. Exported so
 *  the restore-fidelity fallback logic (String/StringList/SecureString, Standard/Advanced tier, an
 *  archive with no paramMeta at all) is unit-tested without any AWS credentials or network access —
 *  see tests/secrets-dr-restore-to-ssm.test.mjs. Never includes the VALUE in its return shape by
 *  design (the caller already has `secrets[name]` and this plan is also what gets printed/logged). */
export function planSsmRestore(secretNames, paramMeta) {
  const meta = paramMeta || {};
  return secretNames.slice().sort().map((name) => {
    const m = meta[name] || {};
    const type = m.type === "String" || m.type === "StringList" ? m.type : "SecureString";
    const tier = m.tier === "Advanced" || m.tier === "Intelligent-Tiering" ? m.tier : "Standard";
    return { name, type, tier, keyId: type === "SecureString" ? (m.keyId || null) : null };
  });
}

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

// base64, not backslash-escaping (2026-07-28 review finding, corrected same day): the earlier
// quote-and-escape approach is NOT actually round-trip-safe for every value this export can contain.
// A value that already holds a literal two-character `\n` sequence (common inside a JSON-formatted
// credential, e.g. a service-account key where a multi-line field is JSON-escaped) gets re-escaped to
// `\\n` by this function — but whether a downstream dotenv-style parser resolves that back to a
// literal backslash+n or corrupts it into a real newline (breaking the JSON) depends on that parser's
// exact escape-resolution ORDER, which varies across implementations and is not something this script
// controls or can verify for every consumer. base64 has no special characters at all (no quoting, no
// escaping, no parser-order ambiguity) and is trivially, unambiguously reversible — `base64 -d`, or any
// language's base64 decoder. The cost is one manual decode step per value instead of a directly
// readable file; correctness for JSON/PEM/binary-ish credentials is worth that.
function toEnvLine(envName, value) {
  return `${envName}=${Buffer.from(String(value), "utf8").toString("base64")}`;
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
    console.error("usage: secrets-dr-restore.mjs <file.enc> [--passphrase-file <path>] [--print-values | --to-env-file out.env | --to-ssm [--dry-run]]");
    console.error("       (or set SECRETS_DR_PASSPHRASE in the environment)");
    process.exit(2);
  }

  const passphrase = await resolvePassphrase(rest);
  const buf = readFileSync(file);
  let plaintext;
  try {
    plaintext = decrypt(buf, passphrase);
  } catch (e) {
    // Include e.message, not a generic string (2026-07-28 review finding): crypto-envelope.mjs's
    // decrypt() deliberately throws DISTINCT errors for bad magic bytes, an unsupported/future version,
    // and wrong-passphrase/corruption (see its own header) -- collapsing all three to one generic
    // message defeats that design. In particular, an OLDER restore tool opening a FUTURE-version
    // archive needs to be told to update its decoder, not misled into thinking the passphrase is wrong.
    console.error(`decrypt failed: ${e && e.message ? e.message : e}`);
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
    console.error(`wrote ${names.length} KEY=<base64> lines to ${outPath} (mode 600). Values are base64-encoded for a guaranteed round-trip (JSON/PEM-safe) -- decode with e.g. echo "$VALUE" | base64 -d, or your language's base64 decoder. Delete this file once no longer needed.`);
    return;
  }

  if (rest.includes("--to-ssm")) {
    const dryRun = rest.includes("--dry-run");
    const plan = planSsmRestore(names, data.paramMeta);
    if (dryRun) {
      console.log(`[secrets-dr-restore] --to-ssm --dry-run: would write ${plan.length} parameter(s) to AWS SSM /otchealth/* (no network call made):`);
      for (const p of plan) console.log(`  ${p.name}  type=${p.type}  tier=${p.tier}${p.keyId ? `  keyId=${p.keyId}` : ""}`);
      return;
    }
    console.error(`[secrets-dr-restore] --to-ssm: writing ${plan.length} parameter(s) to AWS SSM /otchealth/* (values never printed)...`);
    let ok = 0;
    const failures = [];
    for (const p of plan) {
      const res = await ssmPutParameterFull(p.name, data.secrets[p.name], { type: p.type, tier: p.tier, keyId: p.keyId });
      if (res.ok) { ok += 1; console.error(`  ok    ${p.name}`); }
      else { failures.push(p.name); console.error(`  FAIL  ${p.name} (${res.reason || "unknown error"})`); }
    }
    console.error(`[secrets-dr-restore] --to-ssm: ${ok}/${plan.length} written.`);
    if (failures.length) {
      console.error(`::error::[secrets-dr-restore] --to-ssm: ${failures.length} parameter(s) FAILED to write: ${failures.join(", ")}`);
      process.exit(1);
    }
    return;
  }

  if (rest.includes("--print-values")) {
    // TTY guard (2026-07-28 review finding): --print-values is documented as interactive-only ("only
    // ever run that locally/interactively" -- see this file's header), but nothing enforced that. Piped
    // or redirected stdout (a CI log, `> out.txt`, `| less`) would silently write the ENTIRE decrypted
    // credential inventory somewhere durable/broadly-readable. Refuse outside a real interactive
    // terminal and point at the owner-only --to-env-file path instead.
    if (!process.stdout.isTTY) {
      console.error("--print-values refuses to run with stdout redirected or piped (not a TTY) -- this would write every decrypted secret value somewhere durable/broadly-readable instead of just your terminal. Use --to-env-file <path> instead (writes owner-only, mode 600, base64-encoded).");
      process.exit(1);
    }
    for (const n of names) console.log(`${n} = ${data.secrets[n]}`);
  } else {
    console.log(names.join("\n"));
    console.error("\n(names only — pass --print-values or --to-env-file <path> to see actual values)");
  }
}

// isMain guard (2026-08-28 fix, latent bug found while adding a unit test for planSsmRestore()):
// this file previously called main() UNCONDITIONALLY at module load, with no import.meta.url guard --
// unlike every sibling script in this family (secrets-dr-export.mjs, restore-drill.mjs,
// page-on-failure.mjs, heartbeat.mjs all guard this exact way). Simply IMPORTING this module for its
// pure exports (planSsmRestore, needed for a hermetic restore-fidelity test with no AWS credentials)
// ran the full CLI body, printed the usage banner, and called process.exit(2) -- killing the entire
// test process, caught live writing tests/secrets-dr-restore-to-ssm.test.mjs for this same change.
// Adding the guard changes nothing about real CLI invocation (`node secrets-dr-restore.mjs <file>
// ...` still runs main() exactly as before, since import.meta.url equals argv[1] in that case) and
// does not affect tests/secrets-dr-restore.test.mjs, which already runs this file as a subprocess.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
