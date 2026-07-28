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
 * ENCRYPTION IS THE WHOLE POINT. This is the single most sensitive artifact the fleet produces — the
 * plaintext is every third-party credential the company holds. It is AES-256-GCM encrypted (envelope
 * format + implementation in crypto-envelope.mjs, shared with the restore script and unit-tested) with
 * a key derived from a passphrase that is NEVER stored only in Azure. Plaintext secret VALUES are
 * never logged, ever — only names and counts.
 *
 * PASSPHRASE GENERATION IS HUMAN-GATED, ON PURPOSE (fixed 2026-07-28 review finding): the very first
 * run must happen INTERACTIVELY (a human present to see and save the printed passphrase). If the
 * cached `secrets-dr-passphrase` Key Vault entry is ever missing during a CI/non-interactive run (the
 * scheduled workflow, or any run with CI/GITHUB_ACTIONS set), this script REFUSES to mint a new one
 * and exits non-zero instead. The earlier version auto-generated and printed a fresh passphrase in
 * that situation — which a CI runner would have written straight into a `tee`'d log file uploaded as
 * a 90-day-retained GitHub Actions artifact, exposing the one key that decrypts every credential the
 * company holds. Never repeat that: passphrase minting only ever happens with a human at the terminal.
 *
 * FAIL-LOUD, NOT FAIL-OPEN, on every step that would otherwise ship an incomplete or missing backup
 * (2026-07-28 review): a `run` invocation exits non-zero — so the scheduled workflow's pager fires —
 * if the base aws-dr-* secrets are unresolvable, if ANY individual secret read fails (a partial
 * archive silently replacing last night's complete one is worse than no archive), or if the OneDrive
 * delivery leg fails (it is a REQUIRED second off-Azure copy, not a best-effort extra — a swallowed
 * failure there would leave only the S3 leg populated while the job still reports green). `selftest`
 * remains diagnostic-only (never exits non-zero) — it is a human/operator reachability check.
 *
 * OUTPUT: one file per run, `secrets-dr-<date>.json.enc`. Decrypt with secrets-dr-restore.mjs.
 *
 * USAGE:
 *   node secrets-dr-export.mjs selftest         # no writes: exercises Key Vault + S3 + OneDrive reachability for real
 *   node secrets-dr-export.mjs run              # real export: encrypt + upload to S3 + OneDrive
 *   node secrets-dr-export.mjs run --dry-run    # build + encrypt, report sizes, upload nothing
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
import { encrypt } from "./crypto-envelope.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const VAULT = process.env.AZURE_KEYVAULT_NAME || "kv-otc-55c84f6bef";
const today = () => new Date().toISOString().slice(0, 10);
const isCI = Boolean(process.env.CI || process.env.GITHUB_ACTIONS);

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
      const r = await fetch(`https://${VAULT}.vault.azure.net/secrets/${name}?api-version=7.4`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) { failed.push(`${name}:http-${r.status}`); continue; }
      const v = (await r.json()).value;
      if (v != null) out[name] = String(v);
      else failed.push(`${name}:null-value`);
    } catch (e) {
      failed.push(`${name}:${String(e && e.message || e)}`);
    }
  }
  return { secrets: out, failed, totalListed: names.length };
}

// ---------- passphrase: reuse the KV convenience cache; NEVER auto-mint under CI ----------
async function resolvePassphrase() {
  const pass = await kvSecret("secrets-dr-passphrase");
  if (pass) return { pass, isNew: false };

  if (isCI) {
    throw new Error(
      "secrets-dr-passphrase is not set in Key Vault and this is a CI/non-interactive run — " +
      "refusing to auto-generate one here. A freshly minted passphrase would be printed straight into " +
      "this job's tee'd log file and its 90-day-retained artifact, exposing the key that decrypts every " +
      "credential the company holds. Run `node secrets-dr-export.mjs run` once INTERACTIVELY (a human " +
      "at the terminal, e.g. this session) to mint + save it, then re-run this scheduled job."
    );
  }

  const pass2 = crypto.randomBytes(32).toString("base64");
  const stored = await kvSecretSet("secrets-dr-passphrase", pass2);
  if (!stored) {
    throw new Error("generated a new DR passphrase but could not cache it in Key Vault — refusing to proceed with an unrecoverable one-shot secret. Re-run once Key Vault writes are healthy.");
  }
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
      // HEAD a definitely-nonexistent key: any response other than a network/auth failure (404 is
      // expected and fine) proves the bucket + credentials are genuinely reachable, not just present
      // as strings. This is what the earlier version of selftest did NOT do.
      await s3Head({ accessKeyId: akid, secretAccessKey: asecret, bucket, region }, `secrets-dr/.selftest-probe-${Date.now()}`);
      report.s3Reachable = true;
    } catch (e) {
      report.s3Reachable = false;
      report.s3Error = String(e && e.message || e).slice(0, 200);
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

  const { pass, isNew } = await resolvePassphrase();
  if (isNew) {
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
  }

  const payload = JSON.stringify({
    exportedAt: new Date().toISOString(),
    vault: VAULT,
    count,
    secrets,
  });
  const plaintextBuf = Buffer.from(payload, "utf8");
  const encBuf = encrypt(plaintextBuf, pass);
  console.log(`[secrets-dr-export] plaintext ${plaintextBuf.length}B -> encrypted ${encBuf.length}B (AES-256-GCM).`);

  const key = `secrets-dr/kv-otc-${today()}.json.enc`;
  if (dryRun) {
    console.log(`[secrets-dr-export] dry-run: would upload ${key} to s3://${bucket} and to CTO Incoming/secrets-dr-${today()}.json.enc on OneDrive.`);
    return;
  }

  await s3Put({ accessKeyId: akid, secretAccessKey: asecret, bucket, region }, key, encBuf, sha256Hex(encBuf), {
    secretCount: String(count),
    vault: VAULT,
  });
  console.log(`[secrets-dr-export] uploaded to s3://${bucket}/${key}`);

  if (process.env.SECRETS_DR_ONEDRIVE !== "0") {
    const tmp = mkdtempSync(join(tmpdir(), "secrets-dr-"));
    const localFile = join(tmp, `secrets-dr-${today()}.json.enc`);
    writeFileSync(localFile, encBuf);
    try {
      execFileSync("node", [
        join(REPO_ROOT, "skills", "cto-onedrive", "cto-onedrive.mjs"),
        "deliver", localFile, `secrets-dr-${today()}.json.enc`,
      ], { stdio: "inherit" });
      console.log("[secrets-dr-export] delivered to Matt's OneDrive (CTO Incoming) — his OneDrive desktop client mirrors this to his local hard disk automatically.");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
    // Deliberately NOT caught above: OneDrive is a REQUIRED second off-Azure copy (see header), so a
    // delivery failure must propagate and fail this run (S3 already succeeded, but reporting the run
    // green with only one of two required copies written would hide the gap from the pager).
  }

  console.log("[secrets-dr-export] done.");
}

main().catch((e) => { console.error(`[secrets-dr-export] FATAL: ${String(e && e.message || e)}`); process.exit(1); });
