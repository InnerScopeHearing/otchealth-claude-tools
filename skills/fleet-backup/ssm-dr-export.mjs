#!/usr/bin/env node
/**
 * ssm-dr-export.mjs — off-AWS-account encrypted backup of every SecureString in AWS SSM Parameter
 * Store (/otchealth/*, ~455 params, the store of record since the 2026-08-13 Azure subscription
 * deletion — see otchealth-claude-tools/CLAUDE.md's 2026-08-27 correction). This is the AWS-native
 * successor to secrets-dr-export.mjs, which reads the now-permanently-dead Key Vault kv-otc-55c84f6bef
 * and can never succeed again; that file is left in place, unmodified, as a historical/documentation
 * artifact (its own tests still pass), but its workflow now dispatches THIS script instead.
 *
 * WHY THIS EXISTS (unchanged from secrets-dr-export.mjs's own rationale): a total loss of the AWS
 * account holding SSM is not a hypothetical here — it is EXACTLY what already happened to the prior
 * Azure subscription. An off-Azure/off-AWS copy of the fleet's own memory/brain is useless without the
 * credentials needed to operate anything with it (GitHub App key, Stripe, PostHog, ASC signing key,
 * Twilio, ElevenLabs, RevenueCat, ...) — every one of those lives ONLY in SSM today. This exports every
 * enabled parameter, AES-256-GCM encrypts the export, and ships the ciphertext to two places OUTSIDE
 * the AWS account: an Object-Lock-protected S3 bucket in a fresh, dedicated DR bucket, and Matt's
 * OneDrive "CTO Incoming" folder (his desktop client mirrors that to local disk automatically) — the
 * SAME "local disk AND cloud, outside the account that could be lost" posture as the Azure-era design,
 * see secrets-dr-export.mjs's header for the fuller discussion of that requirement.
 *
 * DELIBERATELY 100% AWS-NATIVE, ZERO KEY-VAULT TOUCHPOINTS: every credential this script needs comes
 * from the AMBIENT AWS identity the runner already has (an OIDC-assumed IAM role via
 * aws-actions/configure-aws-credentials, resolved through skills/kb-memory/aws-secret.mjs's awsCreds())
 * — not from a `aws-dr-*` secret fetched out of a vault. This is a real security improvement over the
 * Azure-era design, not just a port: the S3 destination needs no long-lived access key stored
 * anywhere at all, because the SAME temporary STS credentials used to read SSM also sign the S3
 * upload (s3-client.mjs's `creds.sessionToken` support). The bucket/region themselves are NOT secret
 * (an S3 bucket name and an AWS region reveal nothing sensitive) and are read from plain env vars
 * (repo Variables in the calling workflow), never from a secret store.
 *
 * RESTORE FIDELITY (2026-08-28 design-review finding): a blanket `Type: SecureString, Tier: Standard`
 * on restore silently corrupts any parameter whose real Type was String/StringList (a consumer reading
 * it WITHOUT WithDecryption then receives ciphertext) and hard-fails for any value over 4KB without
 * Tier=Advanced. Every parameter's Type comes from the same GetParametersByPath call that reads its
 * value; Tier + KMS KeyId come from a SEPARATE DescribeParameters pass (that API returns metadata only,
 * never a value) and are recorded alongside the value in a `paramMeta` map, restored faithfully by
 * secrets-dr-restore.mjs's `--to-ssm` verb. DescribeParameters needs its own IAM permission that most
 * fleet roles deliberately do NOT have (see aws-secret.mjs's ssmListDetailed() comment) — if it is
 * unavailable to the identity running this script, the export still completes with the VALUES (the
 * backup itself is not blocked on a nice-to-have), but `paramMeta` is empty and this is reported loudly
 * as `restoreFidelity: "degraded"`, both in the payload and on stdout, rather than silently shipping a
 * backup that looks complete but would corrupt some parameters on restore.
 *
 * PASSPHRASE GENERATION IS HUMAN-GATED, PRINT-BEFORE-CACHE, FAIL-LOUD ON EVERY INCOMPLETE-BACKUP PATH:
 * all three of these carry over UNCHANGED from secrets-dr-export.mjs's own header (read it for the
 * full rationale) — only the storage location moves from a Key Vault secret to the SSM parameter
 * `/otchealth/secrets-dr-passphrase` (via ssmSecret/ssmSecretSet directly, not the Key-Vault-aware
 * dual-write wrapper in azure-secret.mjs, so this script never touches a dead dependency even as a
 * fallback path).
 *
 * OUTPUT: one file per run, `ssm-otchealth-<date>.json.enc` under `secrets-dr/daily/` (also copied to
 * `secrets-dr/monthly/` on the 1st of the month). Decrypt with the EXISTING, unmodified
 * secrets-dr-restore.mjs — the envelope format and the `{exportedAt, vault, count, secrets}` payload
 * shape are unchanged, so names-only listing, --print-values, and --to-env-file all work with zero
 * changes to that file. The new `paramMeta` field is additive and ignored by every existing verb;
 * only the new `--to-ssm` restore verb reads it.
 *
 * USAGE:
 *   node ssm-dr-export.mjs selftest         # exercises SSM + S3 + OneDrive reachability for real
 *   node ssm-dr-export.mjs run              # real export: encrypt + upload to S3 + OneDrive
 *   node ssm-dr-export.mjs run --dry-run    # report sizes only; never touches the passphrase or uploads anything
 *
 * REQUIRED (ambient, no secret store lookups): an AWS identity (OIDC-assumed role or ECS task role)
 *   with ssm:GetParametersByPath, ssm:GetParameter, ssm:DescribeParameters (path-scoped to
 *   /otchealth and /otchealth/*), kms:Decrypt on whichever key SSM's SecureStrings use, and
 *   s3:PutObject + s3:GetObject scoped to the DR bucket's secrets-dr/* prefix.
 * ENV (non-secret): SECRETS_DR_S3_BUCKET (default otchealth-secrets-dr-900915535335),
 *   SECRETS_DR_S3_REGION (default us-east-1), AWS_REGION (used for SSM if SECRETS_DR_S3_REGION unset).
 * OPTIONAL: SECRETS_DR_ONEDRIVE=0 to skip the OneDrive delivery leg (S3-only run — this SKIPS the
 *   fail-loud OneDrive requirement below too; only use it deliberately, e.g. a one-off S3-only drill).
 */

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import {
  awsCreds,
  ssmSecret,
  ssmSecretSet,
  ssmCall,
  ssmGetParametersByPathAllWithValues,
  ssmDescribeParametersAll,
} from "../kb-memory/aws-secret.mjs";
import { s3Put, s3Head, sha256Hex } from "./s3-client.mjs";
import { encrypt, envelopeSize } from "./crypto-envelope.mjs";
import { hasRotatePersistFailure } from "./secrets-dr-export.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const SSM_PREFIX = process.env.AWS_SSM_PREFIX || "/otchealth";
const PASSPHRASE_NAME = "secrets-dr-passphrase"; // -> /otchealth/secrets-dr-passphrase
const MIN_EXPECTED_COUNT = 400; // ground truth: ~455 params. A floor, not an exact count -- catches an
// auth/scope regression that quietly returns a near-empty list, without hard-coding a number that
// changes every time a secret is added or retired.
const today = () => new Date().toISOString().slice(0, 10);
// Same non-interactive detection as secrets-dr-export.mjs: CI/GITHUB_ACTIONS OR a non-TTY stdout
// (covers cron/systemd/other non-interactive runners the env-var check alone would miss).
const isNonInteractive = Boolean(process.env.CI || process.env.GITHUB_ACTIONS) || !process.stdout.isTTY;

function bucketRegion() {
  const bucket = process.env.SECRETS_DR_S3_BUCKET || "otchealth-secrets-dr-900915535335";
  const region = process.env.SECRETS_DR_S3_REGION || process.env.AWS_REGION || "us-east-1";
  return { bucket, region };
}

/** Ambient AWS credentials, translated into s3-client.mjs's field-name convention. Throws (not
 *  fail-open) if no AWS identity is resolvable at all -- every downstream step needs this, so a clear
 *  error here beats an opaque failure three calls later. */
async function requireS3Creds() {
  const c = await awsCreds();
  if (!c) {
    throw new Error(
      "no AWS credentials resolvable (checked ECS task-role metadata, AWS_ACCESS_KEY_ID/SECRET_ACCESS_KEY, " +
      "OTC_AWS_ACCESS_KEY_ID/SECRET_ACCESS_KEY) -- this script needs an authenticated AWS identity for both " +
      "SSM reads and the S3 upload; on GitHub Actions this means the aws-actions/configure-aws-credentials " +
      "OIDC step did not run or did not assume a role."
    );
  }
  const { bucket, region } = bucketRegion();
  return { accessKeyId: c.ak, secretAccessKey: c.sk, sessionToken: c.st || undefined, bucket, region };
}

// ---------- passphrase: does it genuinely not exist, or did the read just fail? ----------
// ssmSecret() collapses "genuinely 404" and "any other failure" to the same null return (by design --
// see its own doc comment). Minting a BRAND NEW passphrase on a transient blip would silently produce
// an archive incompatible with every previous night's, so this does its own narrow check instead of
// trusting the collapsed null, exactly mirroring secrets-dr-export.mjs's passphraseExists().
async function passphraseExists() {
  const res = await ssmCall("GetParameter", { Name: `${SSM_PREFIX}/${PASSPHRASE_NAME}`, WithDecryption: true });
  if (res.status === 200 && res.json?.Parameter) return { exists: true, value: res.json.Parameter.Value };
  if (res.status === 400 && res.json?.__type === "ParameterNotFound") return { exists: false };
  throw new Error(
    `unexpected result checking for an existing DR passphrase (HTTP ${res.status}${res.json?.__type ? `, ${res.json.__type}` : ""}) ` +
    "-- aborting rather than risk minting a new, incompatible one over what may just be a transient SSM failure."
  );
}

async function resolvePassphrase() {
  const check = await passphraseExists();
  if (check.exists) return { pass: check.value, isNew: false };

  if (isNonInteractive) {
    throw new Error(
      "secrets-dr-passphrase is not set in SSM and this run looks non-interactive (CI/GITHUB_ACTIONS set, " +
      "or stdout is not a TTY) -- refusing to auto-generate one here. A freshly minted passphrase would be " +
      "printed straight into a log file, exposing the key that decrypts every credential the company holds. " +
      "Run `node ssm-dr-export.mjs run` once INTERACTIVELY (a human at a real terminal, with AWS credentials " +
      "for /otchealth/secrets-dr-passphrase write access) to mint + save it, then re-run this scheduled job."
    );
  }
  const pass2 = crypto.randomBytes(32).toString("base64");
  return { pass: pass2, isNew: true };
}

// ---------- pure merge: values + best-effort metadata -> the export payload's secrets/paramMeta ----------
// Exported (no network, no I/O) so the restore-fidelity classification (full vs degraded, and exactly
// WHEN it degrades) is unit-tested directly without any AWS credentials -- see
// tests/ssm-dr-export-merge.test.mjs. `values` and `metaList` are the raw results of
// ssmGetParametersByPathAllWithValues()/ssmDescribeParametersAll() respectively (already filtered to
// exclude the passphrase by the caller). Coverage threshold matches the in-code comment below: below
// 50% metadata coverage is treated as "something is actually broken", not ordinary two-read drift.
export function mergeParamsWithMeta(values, metaList) {
  let restoreFidelity = "full";
  if (!metaList.length && values.length) {
    restoreFidelity = "degraded";
  } else if (metaList.length < values.length * 0.5) {
    restoreFidelity = "degraded";
  }
  const metaByName = new Map(metaList.map((m) => [m.name, m]));
  const secrets = {};
  const paramMeta = {};
  for (const p of values) {
    secrets[p.name] = p.value;
    const m = metaByName.get(p.name);
    paramMeta[p.name] = { type: p.type, tier: m?.tier || "Standard", keyId: m?.keyId || null };
  }
  return { secrets, paramMeta, restoreFidelity };
}

// ---------- enumerate every parameter's value + best-effort restore-fidelity metadata (I/O wrapper) ----------
async function fetchAllParams() {
  const values = await ssmGetParametersByPathAllWithValues();
  if (!values.length) {
    throw new Error(
      "SSM listed 0 parameters under /otchealth -- refusing to upload an empty archive over the current " +
      "recovery point. This is almost certainly a listing/auth/scope bug, not an actually empty store."
    );
  }
  const filtered = values.filter((p) => p.name !== PASSPHRASE_NAME);
  // secrets-dr-passphrase itself is deliberately EXCLUDED from its own export -- the passphrase must
  // never be recoverable from the thing it encrypts, or the encryption is theater.

  let metaList = [];
  try {
    metaList = await ssmDescribeParametersAll();
  } catch (e) {
    // A THROWN failure here (mid-pagination truncation) is a real problem with the metadata pass
    // specifically -- degrade fidelity rather than fail the whole export over a nice-to-have.
    console.error(`[ssm-dr-export] WARNING: DescribeParameters pass failed (${e.message}) -- proceeding with values only, restoreFidelity degraded.`);
  }

  const { secrets, paramMeta, restoreFidelity } = mergeParamsWithMeta(filtered, metaList);
  if (restoreFidelity === "degraded") {
    if (!metaList.length) {
      console.error(
        "[ssm-dr-export] WARNING: no parameter metadata available from DescribeParameters (likely missing the " +
        "ssm:DescribeParameters permission on this role) -- the export still contains every VALUE, but a restore " +
        "will fall back to Type=SecureString/Tier=Standard for every parameter, which silently corrupts any " +
        "parameter whose real Type was String/StringList and will hard-fail for any value over 4KB. Grant " +
        "ssm:DescribeParameters to close this gap; see the provisioning doc's IAM policy."
      );
    } else {
      console.error(`[ssm-dr-export] WARNING: only ${metaList.length}/${filtered.length} parameters have restore-fidelity metadata -- treating as degraded (see paramMeta gaps for the affected names).`);
    }
  }
  return { secrets, paramMeta, restoreFidelity, totalListed: filtered.length };
}

// ---------- OneDrive delivery (small, deliberately NOT shared with secrets-dr-export.mjs's own
// deliverToOneDrive() -- that file is a frozen, already-reviewed, historical artifact against a dead
// Key Vault; duplicating this ~25-line wrapper is lower risk than refactoring a working, tested file
// that no longer runs in production. hasRotatePersistFailure() itself IS reused (imported above), not
// duplicated -- it is pure detection logic with its own regression test. ) ----------
function deliverToOneDrive(buf, label) {
  const tmp = mkdtempSync(join(tmpdir(), "ssm-dr-"));
  const localFile = join(tmp, `secrets-dr-${today()}.json.enc`);
  writeFileSync(localFile, buf);
  try {
    const spawned = spawnSync("node", [
      join(REPO_ROOT, "skills", "cto-onedrive", "cto-onedrive.mjs"),
      "deliver", localFile, `secrets-dr-${today()}.json.enc`,
    ], { encoding: "utf8", timeout: 90000 });
    const stdout = spawned.stdout || "";
    const stderr = spawned.stderr || "";
    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
    if (spawned.error) throw spawned.error;
    if (spawned.status !== 0) throw new Error(`OneDrive delivery (cto-onedrive.mjs deliver) exited ${spawned.status}`);
    if (hasRotatePersistFailure(stdout, stderr)) {
      throw new Error(
        "OneDrive delivery succeeded but the underlying engine reported \"ROTATE PERSIST FAILED\" while " +
        "rotating graph-onedrive-refresh-token -- the stored refresh token may now be stale. Re-authenticate " +
        "OneDrive if the next run's delivery also fails."
      );
    }
    console.log(`[ssm-dr-export] ${label} delivered to Matt's OneDrive (CTO Incoming) -- his OneDrive desktop client mirrors this to his local hard disk automatically.`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  // No catch above besides temp-dir cleanup: OneDrive is a REQUIRED second off-account copy by
  // default (see header) -- any delivery failure must propagate and fail this run.
}

async function realSelftest() {
  const report = { ssmReachable: false, s3Reachable: false, oneDriveReachable: false, oneDriveDeliveryEnabled: process.env.SECRETS_DR_ONEDRIVE !== "0" };

  try {
    // A real, unambiguous, read-only probe (MaxResults:1 against the actual path) rather than a call
    // shaped to fail on a missing key -- see s3Reachable's comment below for why that distinction
    // matters (the same lesson secrets-dr-export.mjs's own selftest fix already documents).
    const res = await ssmCall("DescribeParameters", { ParameterFilters: [{ Key: "Path", Option: "Recursive", Values: [SSM_PREFIX] }], MaxResults: 1 });
    report.ssmReachable = res.status === 200;
    if (res.status !== 200) report.ssmError = `HTTP ${res.status}${res.json?.__type ? ` (${res.json.__type})` : ""}`;
  } catch (e) {
    report.ssmError = String(e && e.message || e).slice(0, 300);
  }

  try {
    const creds = await requireS3Creds();
    // PUT-then-HEAD a fixed (not timestamped) marker key: a genuine 200 on the read-back proves real
    // reachability with the actual granted permissions, with no dependence on 403-vs-404 semantics for
    // a least-privilege credential that lacks s3:ListBucket (see secrets-dr-export.mjs's own selftest
    // comment for the fuller explanation of why a GET-a-missing-key probe is the wrong test).
    const marker = "secrets-dr/.selftest-probe-marker";
    const markerBuf = Buffer.from(`selftest ${new Date().toISOString()}`, "utf8");
    await s3Put(creds, marker, markerBuf, sha256Hex(markerBuf), {});
    const head = await s3Head(creds, marker);
    report.s3Reachable = head !== null;
    report.s3Bucket = creds.bucket;
  } catch (e) {
    report.s3Reachable = false;
    report.s3Error = String(e && e.message || e).slice(0, 300);
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
    return; // diagnostic only -- never fails the process
  }
  if (cmd !== "run") { console.error(`unknown command "${cmd}"`); process.exit(2); }

  console.log("[ssm-dr-export] fetching every enabled parameter from AWS SSM (/otchealth/*)...");
  const { secrets, paramMeta, restoreFidelity, totalListed } = await fetchAllParams();
  const count = Object.keys(secrets).length;
  console.log(`[ssm-dr-export] fetched ${count} parameters (restoreFidelity: ${restoreFidelity}).`);
  if (count < MIN_EXPECTED_COUNT) {
    // FAIL LOUD: a count far below the known-good floor is almost certainly a listing/auth/scope bug,
    // not a genuine mass-deletion -- refuse to silently ship a degraded recovery point as if it were
    // a normal night. Mirrors secrets-dr-export.mjs's identical zero-count guard, generalized to a
    // floor because SSM's real count moves over time as secrets are added/retired.
    throw new Error(`fetched only ${count} parameters, below the expected floor of ${MIN_EXPECTED_COUNT} (ground truth: ~455) -- refusing to upload what looks like a partial/regressed export.`);
  }

  const payload = JSON.stringify({ exportedAt: new Date().toISOString(), vault: "aws-ssm:/otchealth", count, secrets, paramMeta, restoreFidelity });
  const plaintextBuf = Buffer.from(payload, "utf8");
  const key = `secrets-dr/daily/ssm-otchealth-${today()}.json.enc`;
  const { bucket } = bucketRegion();

  if (dryRun) {
    console.log(`[ssm-dr-export] dry-run: plaintext ${plaintextBuf.length}B -> ~${envelopeSize(plaintextBuf.length)}B encrypted (AES-256-GCM; not actually encrypted, no passphrase touched). Would upload ${key} to s3://${bucket} and to CTO Incoming/secrets-dr-${today()}.json.enc on OneDrive.`);
    return;
  }

  const { pass, isNew } = await resolvePassphrase();
  if (isNew) {
    console.log("");
    console.log("=".repeat(78));
    console.log("A NEW disaster-recovery passphrase was just generated. This is the ONLY time");
    console.log("it will be printed. Save it in a password manager OUTSIDE this AWS account now --");
    console.log("it is what decrypts every credential export if this account is ever lost:");
    console.log("");
    console.log(`    ${pass}`);
    console.log("");
    console.log("=".repeat(78));
    console.log("");
    const stored = await ssmSecretSet(PASSPHRASE_NAME, pass);
    if (!stored) {
      console.error("[ssm-dr-export] WARNING: could not cache the passphrase in SSM. You already have the authoritative copy from the output above, so THIS run proceeds -- but until SSM writes are healthy again, a FUTURE run with no cached passphrase will mint a DIFFERENT new one, incompatible with this archive.");
    }
  }

  const encBuf = encrypt(plaintextBuf, pass);
  console.log(`[ssm-dr-export] plaintext ${plaintextBuf.length}B -> encrypted ${encBuf.length}B (AES-256-GCM).`);

  const creds = await requireS3Creds();
  await s3Put(creds, key, encBuf, sha256Hex(encBuf), { secretCount: String(count), source: "aws-ssm", restoreFidelity });
  console.log(`[ssm-dr-export] uploaded to s3://${bucket}/${key}`);

  if (today().endsWith("-01")) {
    const monthlyKey = `secrets-dr/monthly/ssm-otchealth-${today()}.json.enc`;
    await s3Put(creds, monthlyKey, encBuf, sha256Hex(encBuf), { secretCount: String(count), source: "aws-ssm", restoreFidelity });
    console.log(`[ssm-dr-export] first of the month -- also uploaded to s3://${bucket}/${monthlyKey}`);
  }

  if (process.env.SECRETS_DR_ONEDRIVE !== "0") {
    deliverToOneDrive(encBuf, "archive");
  }

  console.log("[ssm-dr-export] done.");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(`[ssm-dr-export] FATAL: ${String(e && e.message || e)}`); process.exit(1); });
}
