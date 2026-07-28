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
 * ONEDRIVE TOKEN FRESHNESS (2026-07-28 review finding, corrected same day): the OneDrive delivery
 * engine (skills/cfo-onedrive/onedrive.mjs) rotates and persists `graph-onedrive-refresh-token` as a
 * side effect of EVERY invocation (observed live: every run this session logged "rotated OneDrive
 * refresh token -> persisted"). If that rotation happens during this run's OneDrive delivery step, the
 * archive already encrypted (built from the secrets snapshot taken BEFORE delivery) would silently
 * ship a stale copy of that one credential. After delivery, this script re-reads that one secret and,
 * if it changed, patches the S3 copy and re-uploads. It deliberately does NOT re-deliver to OneDrive a
 * second time to "fix" that copy too — a second delivery call rotates the token AGAIN, which never
 * converges. The OneDrive copy may therefore lag by one rotation on this single field; see the
 * in-code comment at the fix site for why that is an accepted, narrow, low-severity limitation.
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
import { s3Put, s3Get, sha256Hex } from "./s3-client.mjs";
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

// ---------- does secrets-dr-passphrase genuinely not exist, or did the read just fail? ----------
// kvSecret() collapses "404, genuinely missing" and "5xx/network transient failure" to the SAME null
// return (see azure-secret.mjs's own comment: "404/5xx: don't retry via the other path"). Minting a
// BRAND NEW passphrase on a transient blip would silently produce an archive incompatible with every
// previous night's — a real, reviewed finding. So this call site does its own narrow HTTP check
// instead of trusting kvSecret()'s collapsed null.
async function passphraseExists() {
  const token = await vaultToken();
  if (!token) throw new Error("could not mint a Key Vault token to check for an existing DR passphrase");
  const r = await fetch(`https://${VAULT}.vault.azure.net/secrets/secrets-dr-passphrase?api-version=7.4`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (r.status === 404) return { exists: false };
  if (r.ok) return { exists: true, value: (await r.json()).value };
  throw new Error(`unexpected HTTP ${r.status} checking for an existing DR passphrase — aborting rather than risk minting a new, incompatible one over what may just be a transient Key Vault failure`);
}

// ---------- passphrase: reuse the KV convenience cache; NEVER auto-mint when non-interactive ----------
// Returns { pass, isNew }. Deliberately does NOT cache a newly minted passphrase itself — the caller
// must print it to the human FIRST, then cache it, so a crash between mint and display can never
// leave a passphrase committed to Key Vault that no human ever actually saw (see header).
async function resolvePassphrase() {
  const check = await passphraseExists();
  if (check.exists) return { pass: check.value, isNew: false };

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
      // GET (not HEAD) a definitely-nonexistent key. GET responses carry a body, so a real S3 error
      // (bad credentials, wrong signature, an actual deny) is DISTINGUISHABLE from a clean missing-
      // object 404 — empirically verified against this exact bucket: a valid-credential GET on a
      // missing key returns a clean null, while a broken credential throws with a parseable
      // <Code>SignatureDoesNotMatch</Code>-style body. So here, ANY throw means genuinely unreachable
      // — there is no masked-404-looks-like-403 case to special-case for THIS bucket's observed
      // behavior (an earlier version of this check treated any 403 as "reachable," which would have
      // hidden a real broken-credential failure behind a false-positive pass).
      await s3Get({ accessKeyId: akid, secretAccessKey: asecret, bucket, region }, `secrets-dr/.selftest-probe-${Date.now()}`);
      report.s3Reachable = true;
    } catch (e) {
      report.s3Reachable = false;
      report.s3Error = String(e && e.message || e).slice(0, 300);
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
    // patch and re-upload the S3 copy (S3 has no rotation side effect, so this converges cleanly).
    //
    // Deliberately NOT re-delivering to OneDrive a second time here (an earlier version of this fix
    // did, and it was wrong): the OneDrive engine rotates the refresh token on EVERY invocation
    // (observed live, every run this session logged "rotated OneDrive refresh token -> persisted"),
    // so a second `deliver` call would just rotate AGAIN, leaving the re-delivered file exactly as
    // stale as the first — an infinite regress that never converges, not a fix. Accepted, narrow,
    // low-severity limitation instead: the OneDrive copy's `graph-onedrive-refresh-token` field may
    // lag by one rotation if it rotates mid-run. That credential's only use is operating this same
    // OneDrive delivery pipeline — if it is ever actually stale/invalid, OneDrive re-authentication
    // (a fresh OAuth consent) recovers it; it is not load-bearing for recovering anything else.
    const rotatedToken = await kvSecret("graph-onedrive-refresh-token");
    if (rotatedToken && secrets["graph-onedrive-refresh-token"] && rotatedToken !== secrets["graph-onedrive-refresh-token"]) {
      console.log("[secrets-dr-export] graph-onedrive-refresh-token rotated during delivery — patching the S3 archive with the current value (the OneDrive copy may lag by one rotation on this one field; see header).");
      secrets["graph-onedrive-refresh-token"] = rotatedToken;
      const patchedPayload = JSON.stringify({ exportedAt: new Date().toISOString(), vault: VAULT, count, secrets });
      const patchedBuf = encrypt(Buffer.from(patchedPayload, "utf8"), pass);
      await s3Put(creds, key, patchedBuf, sha256Hex(patchedBuf), { secretCount: String(count), vault: VAULT });
      console.log(`[secrets-dr-export] re-uploaded patched archive to s3://${bucket}/${key}`);
    }
  }

  console.log("[secrets-dr-export] done.");
}

main().catch((e) => { console.error(`[secrets-dr-export] FATAL: ${String(e && e.message || e)}`); process.exit(1); });
