#!/usr/bin/env node
/**
 * restore-drill.mjs — proves the S3 DR mirror is actually RESTORABLE, not merely writable. Pulls one
 * (or every) blob back FROM S3, recomputes its sha256 from the downloaded bytes, and compares it
 * against the sha256 recorded in the most recent s3-mirror.mjs run manifest. PASS means: what we can
 * pull back out of S3 right now, byte for byte, matches what was recorded as mirrored.
 *
 * The manifest is read from AZURE BLOB (the copy s3-mirror.mjs is REQUIRED to write there), not from
 * S3, so this drill's correctness never depends on the bonus S3 copy of the manifest existing. This
 * also means the drill genuinely tests "does S3 have what the authoritative record says it should" —
 * comparing the durable record against the actual remote bytes, not the mirror job's own optimistic
 * self-report from the same run.
 *
 * Deliberately does NOT use s3:ListBucket/ListObjects (matches s3-mirror.mjs's least-privilege IAM
 * recommendation — PutObject/GetObject/HeadObject on the DR buckets only, see README.md). Every key
 * this drills comes from the Azure-side manifest, never from asking S3 to enumerate itself.
 *
 * USAGE:
 *   node restore-drill.mjs                        # drill EVERY blob in the latest manifest (full proof)
 *   node restore-drill.mjs <blobKey>               # drill just one blob, non-privileged bucket
 *   node restore-drill.mjs --privileged            # drill every blob mirrored to the privileged bucket
 *   node restore-drill.mjs --privileged <blobKey>  # drill just one blob, privileged bucket
 *
 * SCHEDULED INVOCATION (added 2026-07-22): .github/workflows/nightly-s3-dr-mirror.yml runs this,
 * non-privileged lane, right after s3-mirror.mjs run in the same job, so every scheduled run proves the
 * mirror is actually RESTORABLE, not just that a write succeeded. Manual invocation (drilling one
 * specific blob, or the privileged lane once it is ever armed) is still the commands above, run ad hoc
 * from a session with the same env this file already documents.
 *
 * INERT-SAFE: exits 0 with a clear message if the relevant aws-dr-* (or aws-dr-privileged-*) secrets
 * are not yet in Key Vault. As of 2026-07-22 the base (non-privileged) aws-dr-* secrets are confirmed
 * live in Key Vault (see s3-mirror.mjs's header for the verification details), so this guard is now a
 * permanent fail-open safety net for that lane, not the reason it had never run; the privileged lane's
 * own secrets remain unconfirmed and this guard is still the expected, live gate for it. If creds ARE
 * present but no manifest can be found/read in Azure, or the manifest has nothing recorded for the
 * requested bucket, that IS a real problem (nothing to verify a restore against) and this exits non-zero.
 */

import { fileURLToPath } from "node:url";
import { kvSecret } from "../kb-memory/azure-secret.mjs";
import { listBlobs, getBlob, containerExists } from "./azure-blob-client.mjs";
import { s3Get, sha256Hex } from "./s3-client.mjs";

// Pure (no network/credential dependency): given a list of blob names already listed from the source
// container, pick the most recent s3-mirror-manifest-<date>.json, or null if none exist. Extracted from
// loadLatestManifest() below so the date-picking rule (lexicographic sort equals chronological order
// for a zero-padded YYYY-MM-DD filename suffix) is unit-tested directly, see
// tests/restore-drill-select.test.mjs.
export function latestManifestName(blobNames) {
  const manifests = blobNames
    .filter((n) => /^s3-mirror-manifest-\d{4}-\d{2}-\d{2}\.json$/.test(n))
    .sort((a, b) => (a < b ? 1 : -1)); // lexicographic == chronological for YYYY-MM-DD names
  return manifests[0] || null;
}

async function loadLatestManifest(account, container) {
  const blobs = await listBlobs(account, container);
  const name = latestManifestName(blobs.map((b) => b.name));
  if (!name) return null;
  const buf = await getBlob(account, container, name);
  return { name, data: JSON.parse(buf.toString("utf8")) };
}

// Pure (no network/credential dependency): given an already-loaded manifest's `data` object, the
// resolved destination bucket, and an optional single blobKey filter, compute which blobs this drill
// run should verify. Extracted from run() below (same rationale as latestManifestName above) so the
// candidate-pool rule is unit-tested directly. The pool is the union of blobs freshly uploaded THIS run
// (`mirrored`, excluding dry-run entries) and blobs confirmed already-correct via an S3 HEAD THIS run
// (`skippedUnchanged`) -- see the comment on this exact union at its original call site in run(), below.
// `reason` is null on success, else one of:
//   "BLOB_NOT_IN_MANIFEST"       a specific blobKey was requested but is not recorded for this bucket
//   "NO_CANDIDATES_FOR_BUCKET"   no requested blobKey, but this bucket has nothing recorded at all
export function selectDrillTargets(manifestData, bucket, blobKey) {
  const pool = [...(manifestData.mirrored || []).filter((m) => !m.dryRun), ...(manifestData.skippedUnchanged || [])];
  const candidates = pool.filter((m) => m.bucket === bucket && m.sha256);
  const targets = blobKey ? candidates.filter((m) => m.blob === blobKey) : candidates;
  if (blobKey && !targets.length) return { targets: [], reason: "BLOB_NOT_IN_MANIFEST" };
  if (!targets.length) return { targets: [], reason: "NO_CANDIDATES_FOR_BUCKET" };
  return { targets, reason: null };
}

async function resolveCreds(privileged) {
  const prefix = privileged ? "aws-dr-privileged-" : "aws-dr-";
  const [akid, asecret, bucket, ownRegion, fallbackRegion] = await Promise.all([
    kvSecret(`${prefix}access-key-id`),
    kvSecret(`${prefix}secret-access-key`),
    kvSecret(`${prefix}s3-bucket`),
    privileged ? kvSecret("aws-dr-privileged-region") : kvSecret("aws-dr-region"),
    privileged ? kvSecret("aws-dr-region") : Promise.resolve(null),
  ]);
  const region = ownRegion || fallbackRegion;
  const missing = [];
  if (!akid) missing.push(`${prefix}access-key-id`);
  if (!asecret) missing.push(`${prefix}secret-access-key`);
  if (!bucket) missing.push(`${prefix}s3-bucket`);
  if (!region) missing.push(privileged ? "aws-dr-privileged-region (or aws-dr-region as a fallback)" : "aws-dr-region");
  if (missing.length) return { missing };
  return { creds: { accessKeyId: akid, secretAccessKey: asecret, bucket, region } };
}

async function run({ blobKey, privileged }) {
  const account = process.env.BACKUP_STORAGE_ACCOUNT;
  const container = process.env.BACKUP_CONTAINER || "ledger-backup";
  if (!account) {
    console.error("[FATAL] BACKUP_STORAGE_ACCOUNT is not set. Refusing to run.");
    process.exit(78);
  }

  const { creds, missing } = await resolveCreds(privileged);
  if (missing) {
    console.log(`[restore-drill] AWS DR credentials not provisioned (Matt gate: store ${missing.join(", ")} in Key Vault) -- nothing to drill.`);
    process.exit(0);
  }

  const ok = await containerExists(account, container);
  if (!ok) {
    console.error(`[FATAL] source container '${container}' not reachable/does not exist on ${account}.`);
    process.exit(1);
  }

  console.log(`[restore-drill] loading the latest s3-mirror manifest from ${container} on ${account} ...`);
  const manifest = await loadLatestManifest(account, container);
  if (!manifest) {
    console.error("[FATAL] no s3-mirror-manifest-*.json found in the source container -- s3-mirror.mjs has not produced a manifest yet, or it was lost. Nothing to verify a restore against.");
    process.exit(1);
  }
  console.log(`[restore-drill] using manifest ${manifest.name} (run ts ${manifest.data.ts || "unknown"}).`);

  // The candidate pool is the UNION of blobs freshly uploaded THIS run (`mirrored`, sha256 computed
  // from the just-downloaded bytes) and blobs confirmed already-correct via an S3 HEAD THIS run
  // (`skippedUnchanged`, sha256 = the matched recorded value) — both represent "this blob IS correctly
  // in S3 as of the manifest's run", just via different code paths. On any run after the first,
  // `mirrored` alone would be near-empty (idempotent re-runs skip almost everything), so using only
  // `mirrored` would make the drill nearly toothless after day one.
  const { targets, reason } = selectDrillTargets(manifest.data, creds.bucket, blobKey);
  if (reason === "BLOB_NOT_IN_MANIFEST") {
    console.error(`[FATAL] "${blobKey}" is not recorded as mirrored to bucket ${creds.bucket} in manifest ${manifest.name}.`);
    process.exit(1);
  }
  if (reason === "NO_CANDIDATES_FOR_BUCKET") {
    console.error(`[FATAL] manifest ${manifest.name} has no mirrored blob(s) recorded for bucket ${creds.bucket} (${privileged ? "privileged" : "non-privileged"} lane). Nothing to drill.`);
    process.exit(1);
  }

  console.log(`[restore-drill] drilling ${targets.length} blob(s) against s3://${creds.bucket} ...`);
  const results = [];
  for (const t of targets) {
    try {
      const buf = await s3Get(creds, t.blob);
      if (!buf) {
        results.push({ blob: t.blob, status: "FAIL", reason: "object not found in S3 (404)" });
        continue;
      }
      const actual = sha256Hex(buf);
      const expected = t.sha256;
      if (actual === expected) results.push({ blob: t.blob, status: "PASS", bytes: buf.length, sha256: actual });
      else results.push({ blob: t.blob, status: "FAIL", reason: `sha256 mismatch: expected ${expected}, got ${actual}`, bytes: buf.length });
    } catch (e) {
      results.push({ blob: t.blob, status: "FAIL", reason: e.message });
    }
  }

  const passed = results.filter((r) => r.status === "PASS").length;
  const failed = results.filter((r) => r.status === "FAIL");
  const report = { ts: new Date().toISOString(), manifest: manifest.name, bucket: creds.bucket, lane: privileged ? "privileged" : "non-privileged", drilled: results.length, passed, failed: failed.length, results };
  console.log(JSON.stringify(report, null, 2));
  console.log(`[restore-drill] ${passed}/${results.length} PASS.`);
  if (failed.length) {
    console.error(`::error::[restore-drill] ${failed.length} blob(s) FAILED restore verification: ${failed.map((f) => f.blob).join(", ")}`);
    process.exit(1);
  }
  console.log("[restore-drill] ALL PASS -- the S3 mirror is verified restorable.");
}

// Only run as a script (not when imported by a test) -- matches the fleet's established convention
// (see skills/azure-canary/canary.mjs, skills/continuity-canary/continuity-canary.mjs, and the same
// guard added to skills/fleet-backup/s3-mirror.mjs in this same change).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const argv = process.argv.slice(2);
  const privileged = argv.includes("--privileged");
  const blobKey = argv.find((a) => !a.startsWith("--"));
  run({ blobKey, privileged }).catch((e) => {
    console.error("ERR", e.message);
    process.exit(1);
  });
}
