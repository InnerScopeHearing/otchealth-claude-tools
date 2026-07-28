#!/usr/bin/env node
/**
 * secrets-dr-export.mjs — off-Azure encrypted backup of every secret in Key Vault (kv-otc-55c84f6bef).
 *
 * WHY THIS EXISTS: backup.mjs + s3-mirror.mjs (Phase 6) give the fleet an off-Azure copy of the
 * memory/brain layer (Cosmos work-ledger + AI Search rooms), but NOTHING backs up Key Vault itself.
 * If the Azure subscription/tenant were ever lost, the S3 mirror of the brain would be useless
 * without the credentials needed to actually operate anything with it (GitHub App key, Stripe,
 * PostHog, ASC signing key, Twilio, ElevenLabs, RevenueCat, ...) — every one of those lives ONLY in
 * Key Vault today. This closes that gap: a nightly encrypted export of every enabled secret, shipped
 * to two places OUTSIDE Azure (AWS S3 + Matt's OneDrive, which syncs to his local disk).
 *
 * KNOWN OPEN GAP (2026-07-28, tracked in runbooks/AZURE-LOSS-DR-PLAN.md gap #1, FND-20260728-404d):
 * the aws-dr-* credentials THIS SCRIPT NEEDS to reach the S3 bucket themselves live only in Key Vault
 * — so this export is not yet reachable from a true zero-Azure-access starting point. A break-glass
 * read-only AWS credential held outside Key Vault closes that; not this script's job to fix.
 *
 * ENCRYPTION IS THE WHOLE POINT. This is the single most sensitive artifact the fleet produces — the
 * plaintext is every third-party credential the company holds. It is AES-256-GCM encrypted (versioned
 * envelope format + implementation in crypto-envelope.mjs, shared with the restore script and
 * unit-tested) with a key derived from a passphrase that is NEVER stored only in Azure. Plaintext
 * secret VALUES are never logged, ever — only names and counts.
 *
 * PASSPHRASE GENERATION IS HUMAN-GATED, ON PURPOSE (fixed 2026-07-28 review finding): the very first
 * run must happen INTERACTIVELY (a human present to see and save the printed passphrase). This script
 * refuses to mint a new passphrase whenever it looks non-interactive — CI/GITHUB_ACTIONS is set, OR
 * stdout is not a TTY (covers cron/systemd/redirected-shell runners the env-var check alone would
 * miss). The earlier version only checked CI/GITHUB_ACTIONS and would have auto-generated (and printed
 * straight into a log file) on any other non-interactive runner.
 *
 * PRINT-BEFORE-CACHE ORDERING (2026-07-28 review finding): a newly minted passphrase is printed to
 * the terminal BEFORE this script attempts to cache it in Key Vault, not after. The earlier order
 * (cache first, print second) meant a crash in that window would leave the passphrase committed to
 * Key Vault but never shown to a human — permanently unrecoverable-by-a-human in exactly the
 * total-Azure-loss scenario this whole system exists for. If the Key Vault cache write itself then
 * fails, that is now a non-fatal warning (the human already has the authoritative copy from stdout),
 * not a hard failure of the run.
 *
 * FAIL-LOUD, NOT FAIL-OPEN, on every step that would otherwise ship an incomplete or missing backup
 * (2026-07-28 review): a `run` invocation exits non-zero — so the scheduled workflow's pager fires —
 * if the base aws-dr-* secrets are unresolvable, if ANY individual secret read fails (a partial
 * archive silently replacing last night's complete one is worse than no archive), or if the OneDrive
 * delivery leg fails (it is a REQUIRED second off-Azure copy, not a best-effort extra — a swallowed
 * failure there would leave only the S3 leg populated while the job still reports green). `selftest`
 * remains diagnostic-only (never exits non-zero) — it is a human/operator reachability check.
 *
 * DRY-RUN NEVER TOUCHES THE PASSPHRASE (2026-07-28 review finding): the earlier version called the
 * real passphrase resolver even under `--dry-run`, which could mint AND CACHE a brand-new production
 * passphrase as a side effect of a "no writes" validation command. `--dry-run` now reports the exact
 * would-be encrypted size analytically (crypto-envelope.mjs's envelopeSize()) without ever calling
 * encrypt() or touching Key Vault's passphrase entry at all.
 *
 * ONEDRIVE TOKEN FRESHNESS (2026-07-28 review finding): the OneDrive delivery engine
 * (skills/cfo-onedrive/onedrive.mjs) rotates and persists `graph-onedrive-refresh-token` as a side
 * effect of use. If that rotation happens DURING this run's OneDrive delivery step, the archive this
 * run already encrypted (built from the secrets snapshot taken BEFORE delivery) would silently ship a
 * stale copy of that one credential. After delivery, this script re-reads that one secret; if it
 * changed, it patches the in-memory snapshot, re-encrypts, and re-uploads/re-delivers so both copies
 * end up reflecting the truly-final value, not the pre-rotation one.
 *
 * OUTPUT: one file per run, `secrets-dr-<date>.json.enc`. Decrypt with secrets-dr-restore.mjs.
 *
 * USAGE:
 *   node secrets-dr-export.mjs selftest         # no writes: exercises Key Vault + S3 + OneDrive reachability for real
 *   node secrets-dr-export.mjs run              # real export: encrypt + upload to S3 + OneDrive
 *   node secrets-dr-export.mjs run --dry-run    # report sizes only; never touches the passphrase or uploads anything
 *
 * REQUIRED SECRETS (Key Vault): aws-dr-access-key-id / aws-dr-secret-access-key / aws-dr-s3-bucket /
 *   aws-dr-region (same base DR credential the brain mirror uses — a distinct prefix, `secrets-dr/`,
 *   inside the SAME non-privileged bucket; see the header note in README.md before changing that).
 * OPTIONAL: SECRETS_DR_ONEDRIVE=0 to skip the OneDrive delivery leg (S3-only run — this SKIPS the
 *   fail-loud OneDrive requirement above too; only use it deliberately, e.g. a one-off S3-only drill).
 */

import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { vaultToken, kvSecret, kvSecretSet } from "../kb-memory/azure-secret.mjs";
import { s3Put, s3Head, sha256Hex } from "./s3-client.mjs";
import { encrypt, envelopeSize } from "./crypto-envelope.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const VAULT = process.env.AZURE_KEYVAULT_NAME || "kv-otc-55c84f6bef";
const today = () => new Date().toISOString().slice(0, 10);
// Non-interactive if flagged by CI/GITHUB_ACTIONS OR if stdout is plainly not a terminal (covers
// cron/systemd/other non-GitHub-Actions non-interactive runners the env-var check alone would miss).
const isNonInteractive = Boolean(process.env.CI || process.env.GITHUB_ACTIONS) || !process.stdout.isTTY;

// ---------- list + fetch every enabled secret ----------
async function listSecretNames(token) {
  const names = [];
  let url = `https://${VAULT}.vault.azure.net/secrets?api-version=7.4&maxresults=25`;
  while (url) {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error(`list secrets failed: HTTP ${r.status} ${(await r.text()).slice(0, 300)}`);
    const body = await r.json();
    for (const item of body.value || []) {
      const enabled = item.attributes?.enabled !== false;
      if (!enabled) continue; // skip disabled/soft-deleted-shadow entries; nothing operational depends on them
      names.push(item.id.split("/").pop());
    }
    url = body.nextLink || null;
  }
  return names;
}

async function fetchOneSecret(token, name) {
  const r = await fetch(`https://${VAULT}.vault.azure.net/secrets/${name}?api-version=7.4`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error(`http-${r.status}`);
  const v = (await r.json()).value;
  if (v == null) throw new Error("null-value");
  return String(v);
}

async function fetchAllSecrets() {
  const token = await vaultToken();
  if (!token) throw new Error("could not mint a Key Vault token via any auth path (identity/sp/az-cli)");
  const names = await listSecretNames(token);
  const out = {};
  const failed = [];
  for (const name of names) {
    // secrets-dr-passphrase itself is deliberately EXCLUDED from its own export — the passphrase must
    // never be recoverable from the thing it encrypts, or the encryption is theater.
    if (name === "secrets-dr-passphrase") continue;
    try {
      out[name] = await fetchOneSecret(token, name);
    } catch (e) {
      failed.push(`${name}:${String(e && e.message || e)}`);
    }
  }
  return { secrets: out, failed, totalListed: names.length };
}

// ---------- passphrase: reuse the KV convenience cache; NEVER auto-mint when non-interactive ----------
// Returns { pass, isNew }. Deliberately does NOT cache a newly minted passphrase itself — the caller
// must print it to the human FIRST, then cache it, so a crash between mint and display can never
// leave a passphrase committed to Key Vault that no human ever actually saw (see header).
async function resolvePassphrase() {
  const pass = await kvSecret("secrets-dr-passphrase");
  if (pass) return { pass, isNew: false };

  if (isNonInteractive) {
    throw new Error(
      "secrets-dr-passphrase is not set in Key Vault and this run looks non-interactive (CI/GITHUB_ACTIONS " +
      "set, or stdout is not a TTY) — refusing to auto-generate one here. A freshly minted passphrase would " +
      "be printed straight into a log file (a CI job's tee'd/uploaded artifact, or any other captured " +
      "non-interactive output), exposing the key that decrypts every credential the company holds. Run " +
      "`node secrets-dr-export.mjs run` once INTERACTIVELY (a human at a real terminal) to mint + save it, " +
      "then re-run this scheduled job."
    );
  }

  const pass2 = crypto.randomBytes(32).toString("base64");
  return { pass: pass2, isNew: true };
}

async function realSelftest() {
  const report = { keyVaultTokenMinted: false, s3Reachable: false, oneDriveReachable: false, oneDriveDeliveryEnabled: process.env.SECRETS_DR_ONEDRIVE !== "0" };

  const token = await vaultToken().catch(() => null);
  report.keyVaultTokenMinted = Boolean(token);

  const akid = await kvSecret("aws-dr-access-key-id");
  const asecret = await kvSecret("aws-dr-secret-access-key");
  const bucket = await kvSecret("aws-dr-s3-bucket");
  const region = await kvSecret("aws-dr-region");
  report.awsDrCredsProvisioned = Boolean(akid && asecret && bucket && region);
  if (report.awsDrCredsProvisioned) {
    try {
      // HEAD a definitely-nonexistent key. Under the documented least-privilege policy (no
      // s3:ListBucket), S3 can legitimately answer a HEAD-on-missing-object with 403 instead of 404
      // (masking object existence) even with fully valid credentials — so a bare 403 here means
      // "reachable, just can't confirm this exact object's absence," NOT "unreachable." Only treat a
      // genuine auth/network failure (401, or the fetch itself throwing) as unreachable.
      await s3Head({ accessKeyId: akid, secretAccessKey: asecret, bucket, region }, `secrets-dr/.selftest-probe-${Date.now()}`);
      report.s3Reachable = true;
    } catch (e) {
      const msg = String(e && e.message || e);
      if (/\b403\b/.test(msg)) {
        report.s3Reachable = true;
        report.s3Note = "HEAD returned 403 on a nonexistent key (expected under the no-ListBucket least-privilege policy) — credentials + bucket are reachable, this is not a failure.";
      } else {
        report.s3Reachable = false;
        report.s3Error = msg.slice(0, 200);
      }
    }
  }

  if (report.oneDriveDeliveryEnabled) {
    try {
      execFileSync("node", [join(REPO_ROOT, "skills", "cto-onedrive", "cto-onedrive.mjs"), "stat", "/"], { stdio: "pipe", timeout: 30000 });
      report.oneDriveReachable = true;
    } catch (e) {
      report.oneDriveReachable = false;
      report.oneDriveError = String(e && e.message || e).slice(0, 200);
    }
  }

  return report;
}

function deliverToOneDrive(buf, label) {
  const tmp = mkdtempSync(join(tmpdir(), "secrets-dr-"));
  const localFile = join(tmp, `secrets-dr-${today()}.json.enc`);
  writeFileSync(localFile, buf);
  try {
    execFileSync("node", [
      join(REPO_ROOT, "skills", "cto-onedrive", "cto-onedrive.mjs"),
      "deliver", localFile, `secrets-dr-${today()}.json.enc`,
    ], { stdio: "inherit" });
    console.log(`[secrets-dr-export] ${label} delivered to Matt's OneDrive (CTO Incoming) — his OneDrive desktop client mirrors this to his local hard disk automatically.`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  // Deliberately NOT caught above: OneDrive is a REQUIRED second off-Azure copy (see header), so a
  // delivery failure must propagate and fail this run.
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0] || "run";
  const dryRun = args.includes("--dry-run");

  if (cmd === "selftest") {
    console.log(JSON.stringify(await realSelftest(), null, 2));
    return; // diagnostic only — never fails the process
  }

  if (cmd !== "run") { console.error(`unknown command "${cmd}"`); process.exit(2); }

  const akid = await kvSecret("aws-dr-access-key-id");
  const asecret = await kvSecret("aws-dr-secret-access-key");
  const bucket = await kvSecret("aws-dr-s3-bucket");
  const region = await kvSecret("aws-dr-region");
  if (!akid || !asecret || !bucket || !region) {
    // FAIL LOUD, not inert: this is a REQUIRED nightly backup of the company's credentials, not an
    // optional/bootstrap-phase mirror. A silently-missing credential must page, not quietly no-op.
    throw new Error("base aws-dr-* secrets are not fully provisioned — refusing to silently skip a required credential backup. Provision them or investigate why they disappeared.");
  }

  console.log("[secrets-dr-export] fetching every enabled secret from Key Vault...");
  const { secrets, failed, totalListed } = await fetchAllSecrets();
  const count = Object.keys(secrets).length;
  console.log(`[secrets-dr-export] fetched ${count}/${totalListed} secrets (${failed.length} failed reads).`);
  if (failed.length) {
    // FAIL LOUD: a partial archive silently replacing last night's complete one is worse than no
    // archive at all — it looks like a successful backup while actually degrading the recovery point.
    throw new Error(`${failed.length} secret read(s) failed, refusing to upload a partial archive: ${failed.join(", ")}`);
  }

  const payload = JSON.stringify({ exportedAt: new Date().toISOString(), vault: VAULT, count, secrets });
  const plaintextBuf = Buffer.from(payload, "utf8");
  const key = `secrets-dr/kv-otc-${today()}.json.enc`;

  if (dryRun) {
    // No passphrase resolution, no encryption, no Key Vault mutation of any kind in dry-run mode —
    // the encrypted size is computed analytically.
    console.log(`[secrets-dr-export] dry-run: plaintext ${plaintextBuf.length}B -> ~${envelopeSize(plaintextBuf.length)}B encrypted (AES-256-GCM; not actually encrypted, no passphrase touched). Would upload ${key} to s3://${bucket} and to CTO Incoming/secrets-dr-${today()}.json.enc on OneDrive.`);
    return;
  }

  const { pass, isNew } = await resolvePassphrase();
  if (isNew) {
    // Print FIRST, guaranteed before any Key Vault write is attempted (see header rationale).
    console.log("");
    console.log("=".repeat(78));
    console.log("A NEW disaster-recovery passphrase was just generated. This is the ONLY time");
    console.log("it will be printed. Save it in a password manager OUTSIDE Azure/OneDrive now —");
    console.log("it is what decrypts every credential export if Azure itself is ever lost:");
    console.log("");
    console.log(`    ${pass}`);
    console.log("");
    console.log("=".repeat(78));
    console.log("");
    const stored = await kvSecretSet("secrets-dr-passphrase", pass);
    if (!stored) {
      console.error("[secrets-dr-export] WARNING: could not cache the passphrase in Key Vault. You already have the authoritative copy from the output above, so THIS run proceeds — but until Key Vault writes are healthy again, a FUTURE run with no cached passphrase will mint a DIFFERENT new one, incompatible with this archive. Set it manually or re-run kvSecretSet once Key Vault is healthy.");
    }
  }

  const encBuf = encrypt(plaintextBuf, pass);
  console.log(`[secrets-dr-export] plaintext ${plaintextBuf.length}B -> encrypted ${encBuf.length}B (AES-256-GCM).`);

  const creds = { accessKeyId: akid, secretAccessKey: asecret, bucket, region };
  await s3Put(creds, key, encBuf, sha256Hex(encBuf), { secretCount: String(count), vault: VAULT });
  console.log(`[secrets-dr-export] uploaded to s3://${bucket}/${key}`);

  if (process.env.SECRETS_DR_ONEDRIVE !== "0") {
    deliverToOneDrive(encBuf, "archive");

    // Freshness check: did OneDrive's own token rotation (a side effect of the delivery call above)
    // change the one credential this run's snapshot captured BEFORE that rotation happened? If so,
    // patch, re-encrypt, and re-ship both copies so neither ends up stale.
    const rotatedToken = await kvSecret("graph-onedrive-refresh-token");
    if (rotatedToken && secrets["graph-onedrive-refresh-token"] && rotatedToken !== secrets["graph-onedrive-refresh-token"]) {
      console.log("[secrets-dr-export] graph-onedrive-refresh-token rotated during delivery — patching the archive with the current value and re-uploading so the recovery point isn't stale.");
      secrets["graph-onedrive-refresh-token"] = rotatedToken;
      const patchedPayload = JSON.stringify({ exportedAt: new Date().toISOString(), vault: VAULT, count, secrets });
      const patchedBuf = encrypt(Buffer.from(patchedPayload, "utf8"), pass);
      await s3Put(creds, key, patchedBuf, sha256Hex(patchedBuf), { secretCount: String(count), vault: VAULT });
      console.log(`[secrets-dr-export] re-uploaded patched archive to s3://${bucket}/${key}`);
      deliverToOneDrive(patchedBuf, "patched archive");
    }
  }

  console.log("[secrets-dr-export] done.");
}

main().catch((e) => { console.error(`[secrets-dr-export] FATAL: ${String(e && e.message || e)}`); process.exit(1); });
