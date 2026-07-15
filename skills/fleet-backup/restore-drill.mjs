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
 * INERT-SAFE: exits 0 with a clear message if the relevant aws-dr-* (or aws-dr-privileged-*) secrets
 * are not yet in Key Vault — the same Matt gate as s3-mirror.mjs. If creds ARE present but no manifest
 * can be found/read in Azure, or the manifest has nothing recorded for the requested bucket, that IS a
 * real problem (nothing to verify a restore against) and this exits non-zero.
 */

import { kvSecret } from "../kb-memory/azure-secret.mjs";
import { listBlobs, getBlob, containerExists } from "./azure-blob-client.mjs";
import { s3Get, sha256Hex } from "./s3-client.mjs";

async function loadLatestManifest(account, container) {
  const blobs = await listBlobs(account, container);
  const manifests = blobs
    .filter((b) => /^s3-mirror-manifest-\d{4}-\d{2}-\d{2}\.json$/.test(b.name))
    .sort((a, b) => (a.name < b.name ? 1 : -1)); // lexicographic == chronological for YYYY-MM-DD names
  if (!manifests.length) return null;
  const buf = await getBlob(account, container, manifests[0].name);
  return { name: manifests[0].name, data: JSON.parse(buf.toString("utf8")) };
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
  const pool = [...(manifest.data.mirrored || []).filter((m) => !m.dryRun), ...(manifest.data.skippedUnchanged || [])];
  const candidates = pool.filter((m) => m.bucket === creds.bucket && m.sha256);

  const targets = blobKey ? candidates.filter((m) => m.blob === blobKey) : candidates;
  if (blobKey && !targets.length) {
    console.error(`[FATAL] "${blobKey}" is not recorded as mirrored to bucket ${creds.bucket} in manifest ${manifest.name}.`);
    process.exit(1);
  }
  if (!targets.length) {
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

const argv = process.argv.slice(2);
const privileged = argv.includes("--privileged");
const blobKey = argv.find((a) => !a.startsWith("--"));
run({ blobKey, privileged }).catch((e) => {
  console.error("ERR", e.message);
  process.exit(1);
});
