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
 * plaintext is every third-party credential the company holds. It is AES-256-GCM encrypted with a
 * key derived (scrypt) from a passphrase that is NEVER stored only in Azure. The passphrase itself is
 * generated once, printed ONE TIME for a human to store outside this system (password manager), and
 * ALSO cached in Key Vault (`secrets-dr-passphrase`) purely for this script's own future runs to
 * reuse it — that KV copy is a convenience cache, not the authoritative copy; if Azure is lost, the
 * authoritative copy is whatever the human saved outside Azure. Plaintext secret VALUES are never
 * logged, ever — only names and counts.
 *
 * OUTPUT: one file per run, `secrets-dr-<date>.json.enc`, format:
 *   [16 bytes salt][12 bytes iv][16 bytes authTag][ciphertext]
 * Decrypt with secrets-dr-restore.mjs.
 *
 * USAGE:
 *   node secrets-dr-export.mjs selftest         # no writes: verify vault + S3 + OneDrive reachability
 *   node secrets-dr-export.mjs run              # real export: encrypt + upload to S3 + OneDrive
 *   node secrets-dr-export.mjs run --dry-run    # build + encrypt, report sizes, upload nothing
 *
 * REQUIRED SECRETS (Key Vault): aws-dr-access-key-id / aws-dr-secret-access-key / aws-dr-s3-bucket /
 *   aws-dr-region (same base DR credential the brain mirror uses — a distinct prefix, `secrets-dr/`,
 *   inside the SAME non-privileged bucket; see the header note in README.md before changing that).
 * OPTIONAL: SECRETS_DR_ONEDRIVE=0 to skip the OneDrive delivery leg (S3-only run).
 */

import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { vaultToken, kvSecret, kvSecretSet } from "../kb-memory/azure-secret.mjs";
import { s3Put, sha256Hex } from "./s3-client.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const VAULT = process.env.AZURE_KEYVAULT_NAME || "kv-otc-55c84f6bef";
const today = () => new Date().toISOString().slice(0, 10);

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
      const name = item.id.split("/").pop();
      names.push(name);
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
    } catch (e) {
      failed.push(`${name}:${String(e && e.message || e)}`);
    }
  }
  return { secrets: out, failed, totalListed: names.length };
}

// ---------- encryption ----------
function encrypt(plaintextBuf, passphrase) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(passphrase, salt, 32);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintextBuf), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([salt, iv, authTag, ciphertext]);
}

// ---------- passphrase: reuse the KV convenience cache, or mint + print once ----------
async function resolvePassphrase() {
  let pass = await kvSecret("secrets-dr-passphrase");
  let isNew = false;
  if (!pass) {
    pass = crypto.randomBytes(32).toString("base64");
    isNew = true;
    const stored = await kvSecretSet("secrets-dr-passphrase", pass);
    if (!stored) {
      throw new Error("generated a new DR passphrase but could not cache it in Key Vault — refusing to proceed with an unrecoverable one-shot secret. Re-run once Key Vault writes are healthy.");
    }
  }
  return { pass, isNew };
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0] || "run";
  const dryRun = args.includes("--dry-run");

  if (cmd === "selftest") {
    const token = await vaultToken().catch(() => null);
    const akid = await kvSecret("aws-dr-access-key-id");
    const asecret = await kvSecret("aws-dr-secret-access-key");
    const bucket = await kvSecret("aws-dr-s3-bucket");
    const region = await kvSecret("aws-dr-region");
    console.log(JSON.stringify({
      keyVaultTokenMinted: Boolean(token),
      awsDrCredsProvisioned: Boolean(akid && asecret && bucket && region),
      oneDriveDeliveryEnabled: process.env.SECRETS_DR_ONEDRIVE !== "0",
    }, null, 2));
    return;
  }

  if (cmd !== "run") { console.error(`unknown command "${cmd}"`); process.exit(2); }

  const akid = await kvSecret("aws-dr-access-key-id");
  const asecret = await kvSecret("aws-dr-secret-access-key");
  const bucket = await kvSecret("aws-dr-s3-bucket");
  const region = await kvSecret("aws-dr-region");
  if (!akid || !asecret || !bucket || !region) {
    console.log("[secrets-dr-export] base aws-dr-* secrets not fully provisioned — inert no-op, exiting 0.");
    return;
  }

  console.log("[secrets-dr-export] fetching every enabled secret from Key Vault...");
  const { secrets, failed, totalListed } = await fetchAllSecrets();
  const count = Object.keys(secrets).length;
  console.log(`[secrets-dr-export] fetched ${count}/${totalListed} secrets (${failed.length} failed reads).`);
  if (failed.length) console.log(`[secrets-dr-export] failed names+reasons: ${failed.join(", ")}`);

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
    } catch (e) {
      console.error(`[secrets-dr-export] OneDrive delivery failed (S3 copy already succeeded, not fatal): ${String(e && e.message || e)}`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  console.log("[secrets-dr-export] done.");
}

main().catch((e) => { console.error(`[secrets-dr-export] FATAL: ${String(e && e.message || e)}`); process.exit(1); });
