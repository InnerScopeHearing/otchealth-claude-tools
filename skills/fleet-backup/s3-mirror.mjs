#!/usr/bin/env node
/**
 * s3-mirror.mjs — Phase 6 disaster-recovery mirror. Replicates the fleet's Azure-Blob backup
 * artifacts (everything skills/fleet-backup/backup.mjs writes to the `ledger-backup` container) to
 * AWS S3 as an OFF-AZURE cold copy, so a total loss of the Azure subscription/tenant is not also a
 * total loss of the only durable copy of the Cosmos work-ledger and the live AI Search room dumps.
 *
 * THIS DOES NOT RE-EXPORT FROM SOURCE. It consumes backup.mjs's OUTPUT (the blobs already sitting in
 * `ledger-backup`), never touches Cosmos or AI Search directly, and never duplicates backup.mjs's own
 * export logic. Run this AFTER backup.mjs, on the same cadence or less frequently.
 *
 * VERIFIED AGAINST SOURCE (2026-07, this file was written after reading backup.mjs in full — see
 * that file for the authoritative account): backup.mjs writes exactly three blob-name shapes into a
 * single container, `ledger-backup`, on the account named by BACKUP_STORAGE_ACCOUNT —
 *   tasks-<date>.jsonl              Cosmos work-ledger export (tasks + full event-log history)
 *   index-<indexName>-<date>.jsonl  one per LIVE AI Search index in setup/expected-indexes.json
 *   manifest-<date>.json            backup.mjs's own run manifest (blob names, row/byte counts, sha256)
 * It does NOT write any separate "_TEXT" or "originals" path (those sidecars are a doc-indexer concept
 * that lives in the SOURCE data-room containers, e.g. otchealthlegalstore/otchealthcfodata — outside
 * `ledger-backup` entirely, and outside this mirror's scope, which is specifically backup.mjs's
 * output). Rather than hardcode that blob-name shape, this script LISTS THE WHOLE CONTAINER and
 * classifies whatever it finds by name, so it automatically covers backup.mjs's actual output whether
 * or not it changes shape later, with no risk of drifting out of sync with a hardcoded pattern list.
 *
 * RING SEGREGATION (hard compliance requirement, not a style choice — see README.md "S3 DR mirror"):
 *   v1 DEFAULT excludes every privileged/sensitive room from the mirror. A blob is privileged if its
 *   name contains any of: legal-personal, legal-company, cfo, finance-, -personal, medreview, phi
 *   (case-insensitive substring match — deliberately OVER-inclusive: a false positive just means a
 *   safe room stays Azure-only a little longer, which is the fail-closed/safe direction; a false
 *   negative would leak a privileged room into the wrong bucket, which is the direction that must
 *   never happen). This is cross-checked against setup/expected-indexes.json's `queried_by` field
 *   (anything gated behind "kb_search_privileged" is ALSO forced privileged) as a second, independent
 *   signal — best-effort only, the substring check above is the primary, always-on gate.
 *
 *   TWO-LANE SPLIT (2026-08-04, AZURE-LOSS-DR-PLAN.md gap #3): a privileged room is NEVER just "arm
 *   one shared privileged lane." That original v1 design (a single aws-dr-privileged-* credential/
 *   bucket shared by CFO + CLO + Matt) would give CFO read access to legal-personal content (Matt's
 *   California divorce/family/civil matters, including minors' data) the moment anyone armed it —
 *   recreating the exact P0 cross-ring leak the gateway itself had and closed on 2026-07-16
 *   (otchealth-mcp-server PR #124, PERSONAL_LEGAL_RING = ['clo-personal','exec'], CFO deliberately
 *   excluded from legal-personal/legal-personal-memory at that layer). This file now mirrors that same
 *   ring split at the S3-mirror layer, with a THIRD, permanent category on top:
 *     1. NEVER-MIRROR (medreview, phi): PHI is absolute-wall, GCP-BAA-only, and never enters this
 *        non-PHI Azure/AWS plane in the first place per fleet architecture — any blob whose name still
 *        matches these substrings is excluded from EVERY lane, unconditionally, with no opt-in flag
 *        that can ever re-include it. This is not "extra privileged," it is "never leaves Azure at all
 *        via this script," full stop.
 *     2. PERSONAL-LEGAL (legal-personal, legal-personal-memory, any other *-personal* room): its own
 *        bucket + credential (aws-dr-personal-legal-*), armed only by
 *        `--include-personal-legal` + `S3_DR_INCLUDE_PERSONAL_LEGAL=1`. This credential is for CLO +
 *        Matt only — never hand it to CFO, never let it share a bucket with lane 3.
 *     3. FINANCE-COMPANY-LEGAL (legal-company, cfo, finance-, and any other ring-gated-privileged room
 *        not caught by lane 1 or 2): its own bucket + credential (aws-dr-finance-legal-*), armed only
 *        by `--include-finance-legal` + `S3_DR_INCLUDE_FINANCE_LEGAL=1`. This one CAN be shared by
 *        CFO + CLO + Matt, matching the gateway's existing (non-personal) exec-ring access today.
 *   All three lanes/buckets/credentials must be pairwise distinct — the code below refuses to run if
 *   any two resolve to the same bucket name. Nothing is armed by default; both opt-ins require BOTH
 *   the CLI flag AND the matching env var, same double-opt-in shape as the original design.
 *
 * INERT-SAFE (permanent defense-in-depth, NOT the current reason this has never run): if any of the
 * four base aws-dr-* secrets is missing from Key Vault, this prints a clear message and exits 0. No
 * error, no partial state, safe to wire into a cron/Container Apps Job today. This guard stays in the
 * code forever as a fail-open safety net (a deleted/rotated secret, a Key Vault outage, or a future
 * credential swap should degrade to a clean no-op, never a crash) -- but it is NOT what has kept this
 * script from running in production. CORRECTED 2026-07-22: the base (non-privileged) aws-dr-* credential
 * set is LIVE in kv-otc-55c84f6bef, independently confirmed with a real STS GetCallerIdentity call (IAM
 * user cto-hyperagent, AWS account 900915535335) and a real S3 ListObjectsV2 call against the
 * destination bucket (HTTP 200, bucket exists, 0 objects so far, because nothing has ever invoked this
 * script -- no Container Apps Job and no GitHub Actions workflow scheduled it; see
 * .github/workflows/nightly-s3-dr-mirror.yml, added in this same change, which closes that gap). This
 * item was a schedule gap, not a credential gap.
 *
 * REQUIRED SECRETS (Key Vault, kv-otc-55c84f6bef by default):
 *   aws-dr-access-key-id / aws-dr-secret-access-key / aws-dr-s3-bucket / aws-dr-region
 *     -> the non-privileged DR mirror. ALL FOUR required or the run is a no-op (see INERT-SAFE above).
 *     CONFIRMED LIVE 2026-07-22 (see above) -- this lane is fully self-serve, no further provisioning
 *     needed; the INERT-SAFE gate above will not trip for it under normal operation.
 *   aws-dr-personal-legal-access-key-id / aws-dr-personal-legal-secret-access-key /
 *   aws-dr-personal-legal-s3-bucket -> the personal-legal lane (CLO + Matt only). Region optional,
 *     falls back to aws-dr-region. Only read/required when BOTH --include-personal-legal and
 *     S3_DR_INCLUDE_PERSONAL_LEGAL=1 are set.
 *   aws-dr-finance-legal-access-key-id / aws-dr-finance-legal-secret-access-key /
 *   aws-dr-finance-legal-s3-bucket -> the finance/company-legal lane (CFO + CLO + Matt). Region
 *     optional, falls back to aws-dr-region. Only read/required when BOTH --include-finance-legal and
 *     S3_DR_INCLUDE_FINANCE_LEGAL=1 are set.
 *   NEITHER privileged lane's secrets exist in Key Vault yet as of this change (2026-08-04) -- both
 *   stay inert-safe (by design, double opt-in) until Matt provisions genuinely distinct AWS
 *   credentials/buckets for each. Run `node s3-mirror.mjs selftest` to check current state.
 *   See README.md for the exact `az keyvault secret set` commands and the recommended least-privilege
 *   IAM policy for each lane.
 *
 * REQUIRED ENV (non-secret, same names backup.mjs already uses — deploy this as a sibling job with
 * the identical env block):
 *   BACKUP_STORAGE_ACCOUNT   e.g. stotc55c84f6bef (same account backup.mjs writes to)
 *   BACKUP_CONTAINER         default "ledger-backup"
 *   S3_DR_MAX_MB             default 500 — single-blob size guard (see MAX_MIRROR_BYTES below); a
 *                            blob over this size is SKIPPED with a loud warning, not silently dropped,
 *                            and not OOM-risked by an unbounded in-memory buffer.
 *
 * USAGE:
 *   node s3-mirror.mjs run [--include-personal-legal] [--include-finance-legal] [--dry-run]
 *   node s3-mirror.mjs selftest       # no writes: reports Azure auth, source container, AWS creds presence
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { kvSecret } from "../kb-memory/azure-secret.mjs";
import { listBlobs, getBlob, putBlockBlob, containerExists, blobToken, blobAuthMode } from "./azure-blob-client.mjs";
import { s3Put, s3Head, sha256Hex } from "./s3-client.mjs";

const MAX_MIRROR_BYTES = Number(process.env.S3_DR_MAX_MB || 500) * 1024 * 1024;

// ---------- ring segregation ----------
// Exported: this is the hard compliance boundary of the whole mirror (README.md "ring segregation,
// hard compliance requirement") and pure/deterministic, so it is unit-tested directly
// (tests/s3-mirror-privileged.test.mjs) rather than only exercised indirectly through a full `run()`
// with live Azure/AWS credentials.
//
// PRIVILEGED_SUBSTRINGS stays as the AGGREGATE "does this need to stay out of the non-privileged
// bucket" check (unchanged meaning/behavior from before the lane split). NEVER_MIRROR_SUBSTRINGS and
// PERSONAL_LEGAL_SUBSTRINGS are checked FIRST, in that priority order, so classify() below always
// resolves each privileged blob to exactly one lane -- never-mirror wins over personal-legal, which
// wins over finance-company-legal (the catch-all for anything else privileged).
export const NEVER_MIRROR_SUBSTRINGS = ["medreview", "phi"];
export const PERSONAL_LEGAL_SUBSTRINGS = ["legal-personal", "-personal"];
export const FINANCE_COMPANY_LEGAL_SUBSTRINGS = ["legal-company", "cfo", "finance-"];
export const PRIVILEGED_SUBSTRINGS = [...PERSONAL_LEGAL_SUBSTRINGS, ...FINANCE_COMPANY_LEGAL_SUBSTRINGS, ...NEVER_MIRROR_SUBSTRINGS];

const hasAny = (blobName, substrings) => {
  const lower = blobName.toLowerCase();
  return substrings.some((s) => lower.includes(s));
};
export function isPrivilegedByName(blobName) {
  return hasAny(blobName, PRIVILEGED_SUBSTRINGS);
}
export function isNeverMirrorByName(blobName) {
  return hasAny(blobName, NEVER_MIRROR_SUBSTRINGS);
}
export function isPersonalLegalByName(blobName) {
  return !isNeverMirrorByName(blobName) && hasAny(blobName, PERSONAL_LEGAL_SUBSTRINGS);
}

function loadExpectedIndexRegistry() {
  try {
    const registry = JSON.parse(readFileSync(new URL("../../setup/expected-indexes.json", import.meta.url), "utf8"));
    return registry.indexes || [];
  } catch (e) {
    console.warn(`[s3-mirror] WARN: could not read setup/expected-indexes.json (${e.message}) -- the ring-gated-index cross-check is skipped; the name-substring privileged check above is still fully active.`);
    return [];
  }
}
export function ringGatedIndexNames(registry) {
  const names = new Set();
  for (const ix of registry) {
    const queriedBy = (ix.queried_by || []).join(" ");
    if (/privileged/i.test(queriedBy)) names.add(ix.index);
  }
  return names;
}
export function isPrivileged(blobName, ringGatedNames) {
  if (isPrivilegedByName(blobName)) return true;
  for (const n of ringGatedNames) if (blobName.includes(n)) return true;
  return false;
}
// Resolves a blob to exactly ONE of four lanes: "never-mirror" (medreview/phi, no bucket, ever),
// "personal-legal", "finance-company-legal", or "non-privileged". A ring-gated-registry hit that
// isn't caught by any name substring falls through to "finance-company-legal" -- the less-restrictive
// of the two arm-able lanes -- rather than silently landing in "non-privileged"; a room the registry
// itself flags as privileged must never reach the open bucket by default.
export function classifyLane(blobName, ringGatedNames) {
  if (isNeverMirrorByName(blobName)) return "never-mirror";
  if (isPersonalLegalByName(blobName)) return "personal-legal";
  if (hasAny(blobName, FINANCE_COMPANY_LEGAL_SUBSTRINGS)) return "finance-company-legal";
  for (const n of ringGatedNames || []) {
    if (blobName.includes(n)) return "finance-company-legal";
  }
  return "non-privileged";
}
export function indexNameFromBlob(blobName) {
  const m = blobName.match(/^index-(.+)-\d{4}-\d{2}-\d{2}\.jsonl$/);
  return m ? m[1] : null;
}

function todayStamp() {
  return new Date().toISOString().slice(0, 10);
}

// ---------- manifest sha256 lookup (reuse backup.mjs's own recorded hashes where available) ----------
async function loadManifestShaMap(account, container, blobs) {
  const manifestBlobs = blobs.filter((b) => /^manifest-\d{4}-\d{2}-\d{2}\.json$/.test(b.name));
  const shaMap = new Map(); // blobName -> sha256 (as recorded by backup.mjs's own manifest)
  for (const mb of manifestBlobs) {
    try {
      const buf = await getBlob(account, container, mb.name);
      const manifest = JSON.parse(buf.toString("utf8"));
      if (manifest.ledger && manifest.ledger.blob && manifest.ledger.sha256) shaMap.set(manifest.ledger.blob, manifest.ledger.sha256);
      // GAP-8 (2026-08): backup.mjs also records manifest.memory / manifest.events /
      // manifest.decisions_pending in the same {blob, sha256} shape as manifest.ledger -- pick those
      // up too so the idempotent-skip check below works for the three new Cosmos-container blobs, not
      // just the pre-existing tasks-<date>.jsonl.
      for (const key of ["memory", "events", "decisions_pending"]) {
        const entry = manifest[key];
        if (entry && entry.blob && entry.sha256) shaMap.set(entry.blob, entry.sha256);
      }
      for (const ix of manifest.indexes || []) {
        if (ix.blob && ix.sha256) shaMap.set(ix.blob, ix.sha256);
      }
    } catch (e) {
      console.warn(`[s3-mirror] WARN: could not parse ${mb.name} (${e.message}) -- skipping it as a sha256 source; blobs it would have covered fall back to direct download+hash.`);
    }
  }
  return shaMap;
}

async function run({ includePersonalLegal, includeFinanceLegal, dryRun }) {
  const account = process.env.BACKUP_STORAGE_ACCOUNT;
  const container = process.env.BACKUP_CONTAINER || "ledger-backup";
  if (!account) {
    console.error("[FATAL] BACKUP_STORAGE_ACCOUNT is not set. Refusing to run.");
    process.exit(78);
  }

  // ---- INERT-SAFE gate: the base (non-privileged) AWS DR credential ----
  const [akid, asecret, bucket, region] = await Promise.all([
    kvSecret("aws-dr-access-key-id"),
    kvSecret("aws-dr-secret-access-key"),
    kvSecret("aws-dr-s3-bucket"),
    kvSecret("aws-dr-region"),
  ]);
  const missingBase = [];
  if (!akid) missingBase.push("aws-dr-access-key-id");
  if (!asecret) missingBase.push("aws-dr-secret-access-key");
  if (!bucket) missingBase.push("aws-dr-s3-bucket");
  if (!region) missingBase.push("aws-dr-region");
  if (missingBase.length) {
    console.log(`[s3-mirror] AWS DR credentials not provisioned (Matt gate: store ${missingBase.join(", ")} in Key Vault) -- nothing mirrored.`);
    process.exit(0);
  }
  const baseCreds = { accessKeyId: akid, secretAccessKey: asecret, bucket, region };

  // ---- source: list + classify everything backup.mjs has written ----
  const ok = await containerExists(account, container);
  if (!ok) {
    console.error(`[FATAL] source container '${container}' not reachable/does not exist on ${account} (auth mode tried: ${blobAuthMode() || "none minted"}).`);
    process.exit(1);
  }
  console.log(`[s3-mirror] listing ${container} on ${account} ...`);
  const blobs = await listBlobs(account, container);
  if (!blobs.length) {
    console.warn("[s3-mirror] WARNING: source container is empty -- nothing to mirror (has backup.mjs run yet?).");
  }
  const shaMap = await loadManifestShaMap(account, container, blobs);

  const registry = loadExpectedIndexRegistry();
  const ringGated = ringGatedIndexNames(registry);

  const nonPrivileged = [];
  const personalLegal = [];
  const financeCompanyLegal = [];
  const neverMirror = [];
  for (const b of blobs) {
    const lane = classifyLane(b.name, ringGated);
    if (lane === "never-mirror") neverMirror.push(b);
    else if (lane === "personal-legal") personalLegal.push(b);
    else if (lane === "finance-company-legal") financeCompanyLegal.push(b);
    else nonPrivileged.push(b);
  }
  console.log(`[s3-mirror] classified ${blobs.length} blob(s): ${nonPrivileged.length} non-privileged, ${personalLegal.length} personal-legal, ${financeCompanyLegal.length} finance-company-legal, ${neverMirror.length} never-mirror (PHI wall).`);
  if (personalLegal.length) console.log(`[s3-mirror] SKIPPED-as-personal-legal (excluded from the non-privileged mirror by default, never silently -- listed here): ${personalLegal.map((b) => b.name).join(", ")}`);
  if (financeCompanyLegal.length) console.log(`[s3-mirror] SKIPPED-as-finance-company-legal (excluded from the non-privileged mirror by default, never silently -- listed here): ${financeCompanyLegal.map((b) => b.name).join(", ")}`);
  if (neverMirror.length) console.log(`[s3-mirror] BLOCKED (PHI wall, never mirrored anywhere by any flag): ${neverMirror.map((b) => b.name).join(", ")}`);

  // ---- opt-in privileged lanes: BOTH the flag AND the matching env var are required, INDEPENDENTLY
  // per lane. Getting one armed never implicitly arms the other, and the two credentials/buckets must
  // be genuinely distinct from each other AND from the non-privileged bucket. ----
  async function resolveLaneCreds({ requested, envVar, envName, secretPrefix, laneLabel, otherBuckets }) {
    if (!requested) return null;
    if (process.env[envVar] !== "1") {
      console.warn(`[s3-mirror] --include-${laneLabel} was passed but ${envVar}=1 is NOT set in env -- BOTH are required. ${envName} rooms stay EXCLUDED this run.`);
      return null;
    }
    const [akidL, asecretL, bucketL, regionOwnL] = await Promise.all([
      kvSecret(`aws-dr-${secretPrefix}-access-key-id`),
      kvSecret(`aws-dr-${secretPrefix}-secret-access-key`),
      kvSecret(`aws-dr-${secretPrefix}-s3-bucket`),
      kvSecret(`aws-dr-${secretPrefix}-region`),
    ]);
    const missing = [];
    if (!akidL) missing.push(`aws-dr-${secretPrefix}-access-key-id`);
    if (!asecretL) missing.push(`aws-dr-${secretPrefix}-secret-access-key`);
    if (!bucketL) missing.push(`aws-dr-${secretPrefix}-s3-bucket`);
    if (missing.length) {
      console.warn(`[s3-mirror] --include-${laneLabel} + ${envVar}=1 requested, but AWS creds are not provisioned (${missing.join(", ")}) -- ${envName} rooms stay SKIPPED.`);
      return null;
    }
    const collision = otherBuckets.find((ob) => ob.name === bucketL);
    if (collision) {
      console.error(`::error::[s3-mirror] aws-dr-${secretPrefix}-s3-bucket resolves to the SAME bucket as ${collision.label} (${bucketL}) -- refusing to co-mingle lanes in one bucket. Provision a genuinely separate bucket. ${envName} rooms stay SKIPPED this run.`);
      return null;
    }
    const creds = { accessKeyId: akidL, secretAccessKey: asecretL, bucket: bucketL, region: regionOwnL || region };
    console.log(`[s3-mirror] ${envName} mirror ENABLED -> separate bucket s3://${creds.bucket}.`);
    return creds;
  }

  const personalLegalCreds = await resolveLaneCreds({
    requested: includePersonalLegal,
    envVar: "S3_DR_INCLUDE_PERSONAL_LEGAL",
    envName: "personal-legal",
    secretPrefix: "personal-legal",
    laneLabel: "personal-legal",
    otherBuckets: [{ name: bucket, label: "aws-dr-s3-bucket (non-privileged)" }],
  });
  const financeLegalCreds = await resolveLaneCreds({
    requested: includeFinanceLegal,
    envVar: "S3_DR_INCLUDE_FINANCE_LEGAL",
    envName: "finance-company-legal",
    secretPrefix: "finance-legal",
    laneLabel: "finance-legal",
    otherBuckets: [
      { name: bucket, label: "aws-dr-s3-bucket (non-privileged)" },
      ...(personalLegalCreds ? [{ name: personalLegalCreds.bucket, label: "aws-dr-personal-legal-s3-bucket" }] : []),
    ],
  });

  const manifest = {
    ts: new Date().toISOString(),
    source: { account, container },
    dryRun: Boolean(dryRun),
    nonPrivilegedBucket: bucket,
    personalLegalBucket: personalLegalCreds ? personalLegalCreds.bucket : null,
    financeCompanyLegalBucket: financeLegalCreds ? financeLegalCreds.bucket : null,
    mirrored: [],
    skippedUnchanged: [],
    skippedPersonalLegal: personalLegal.map((b) => b.name),
    skippedFinanceCompanyLegal: financeCompanyLegal.map((b) => b.name),
    blockedNeverMirror: neverMirror.map((b) => b.name),
    skippedOversize: [],
    failed: [],
  };

  async function mirrorGroup(list, creds, label) {
    for (const b of list) {
      try {
        const known = shaMap.get(b.name);
        // idempotent skip: if S3 already has this exact blob (matching sha256 recorded as custom
        // metadata on a prior PUT), don't re-download from Azure or re-upload at all.
        if (known) {
          const head = await s3Head(creds, b.name);
          if (head && head.metaSha256 === known) {
            manifest.skippedUnchanged.push({ blob: b.name, sha256: known, bucket: creds.bucket });
            console.log(`[s3-mirror] (${label}) SKIP (unchanged) ${b.name}`);
            continue;
          }
        }
        if (dryRun) {
          console.log(`[s3-mirror] (${label}) DRY-RUN would mirror ${b.name}${known ? ` (known sha256 ${known.slice(0, 12)}...)` : " (no recorded sha256 -- would download+hash)"}`);
          manifest.mirrored.push({ blob: b.name, bucket: creds.bucket, dryRun: true });
          continue;
        }
        console.log(`[s3-mirror] (${label}) mirroring ${b.name} ...`);
        const buf = await getBlob(account, container, b.name);
        if (buf.length > MAX_MIRROR_BYTES) {
          console.warn(`::warning::[s3-mirror] ${b.name} is ${buf.length} bytes, over the ${MAX_MIRROR_BYTES}-byte guard (S3_DR_MAX_MB=${process.env.S3_DR_MAX_MB || 500}) -- SKIPPED, NOT mirrored. Raise S3_DR_MAX_MB to include it.`);
          manifest.skippedOversize.push({ blob: b.name, bytes: buf.length });
          continue;
        }
        const actualSha = sha256Hex(buf);
        if (known && known !== actualSha) {
          console.warn(`::warning::[s3-mirror] ${b.name}: downloaded bytes sha256 (${actualSha}) does not match the manifest-recorded sha256 (${known}) -- the Azure blob may have changed since that manifest was written, or the manifest is stale. Uploading the ACTUAL bytes' hash; investigate the mismatch.`);
        }
        await s3Put(creds, b.name, buf, actualSha, { sourceAccount: account, sourceContainer: container, sourceBlob: b.name });
        manifest.mirrored.push({ blob: b.name, bucket: creds.bucket, bytes: buf.length, sha256: actualSha });
        console.log(`[s3-mirror] (${label}) OK ${b.name} -> s3://${creds.bucket}/${b.name} (${buf.length} bytes, sha256 ${actualSha.slice(0, 12)}...)`);
      } catch (e) {
        console.error(`::error::[s3-mirror] (${label}) FAILED ${b.name}: ${e.message}`);
        manifest.failed.push({ blob: b.name, error: e.message });
      }
    }
  }

  await mirrorGroup(nonPrivileged, baseCreds, "non-privileged");
  if (personalLegalCreds) await mirrorGroup(personalLegal, personalLegalCreds, "PERSONAL-LEGAL");
  if (financeLegalCreds) await mirrorGroup(financeCompanyLegal, financeLegalCreds, "FINANCE-COMPANY-LEGAL");
  // neverMirror is NEVER passed to mirrorGroup, under any flag combination -- see the file header.

  // ---- fail-loud coverage check: an expected non-privileged room with NO blob found at all is a
  // real gap (backup.mjs may not have run for it), not just "0 rows inside a blob that exists" (that
  // case is already backup.mjs's own concern via manifest.backup_incomplete). ----
  const expectedNonPrivNames = registry.filter((ix) => !isPrivileged(ix.index, ringGated)).map((ix) => ix.index);
  const foundNonPrivIndexNames = new Set(nonPrivileged.map((b) => indexNameFromBlob(b.name)).filter(Boolean));
  const missingExpectedRooms = expectedNonPrivNames.filter((n) => !foundNonPrivIndexNames.has(n));
  manifest.missingExpectedRooms = missingExpectedRooms;
  if (missingExpectedRooms.length) {
    console.error(`::error::[s3-mirror] expected non-privileged room(s) with NO blob found in ${container}: ${missingExpectedRooms.join(", ")} -- backup.mjs may not have run for them, or they are only present under a different date than what's in the container.`);
  }
  const hasTasksLedgerBlob = blobs.some((b) => /^tasks-\d{4}-\d{2}-\d{2}\.jsonl$/.test(b.name));
  manifest.missingCosmosLedger = !hasTasksLedgerBlob;
  if (!hasTasksLedgerBlob && blobs.length) {
    console.error(`::error::[s3-mirror] no tasks-<date>.jsonl (Cosmos work-ledger export) found in ${container} -- expected non-privileged coverage per the task instructions is incomplete.`);
  }

  // ---- persist the manifest BEFORE failing (mirrors backup.mjs's own ordering: partial progress is
  // always recorded even when the run ultimately reports a failure). Required destination: Azure Blob
  // + stdout. Bonus (best-effort, non-fatal if it fails): also PUT to S3 so restore-drill.mjs can work
  // from S3 alone if Azure itself were ever the thing that failed. ----
  const manifestBuf = Buffer.from(JSON.stringify(manifest, null, 2), "utf8");
  const manifestBlobName = `s3-mirror-manifest-${todayStamp()}.json`;
  if (!dryRun) {
    await putBlockBlob(account, container, manifestBlobName, manifestBuf, "application/json");
    console.log(`[s3-mirror] manifest written: ${container}/${manifestBlobName} (Azure, required)`);
    try {
      await s3Put(baseCreds, manifestBlobName, manifestBuf, sha256Hex(manifestBuf), {});
      console.log(`[s3-mirror] manifest also written: s3://${bucket}/${manifestBlobName} (bonus, makes restore-drill.mjs self-contained from S3 alone)`);
    } catch (e) {
      console.warn(`[s3-mirror] WARN: could not also upload the manifest to S3 (non-fatal, the Azure copy is authoritative): ${e.message}`);
    }
  }
  console.log(JSON.stringify(manifest, null, 2));

  const problems = [];
  if (manifest.failed.length) problems.push(`${manifest.failed.length} blob(s) failed to mirror: ${manifest.failed.map((f) => f.blob).join(", ")}`);
  if (missingExpectedRooms.length) problems.push(`${missingExpectedRooms.length} expected non-privileged room(s) missing entirely: ${missingExpectedRooms.join(", ")}`);
  if (manifest.missingCosmosLedger && blobs.length) problems.push("Cosmos tasks ledger export (tasks-<date>.jsonl) missing entirely");
  if (!dryRun && problems.length) {
    throw new Error(`[s3-mirror] INCOMPLETE: ${problems.join("; ")}`);
  }
}

async function selftest() {
  const report = {};
  try {
    report.azureBlobTokenMinted = Boolean(await blobToken());
  } catch (e) {
    report.azureBlobTokenError = e.message;
  }
  report.azureBlobAuthMode = blobAuthMode();
  const account = process.env.BACKUP_STORAGE_ACCOUNT;
  report.backupStorageAccountSet = Boolean(account);
  if (account) {
    try {
      report.sourceContainerReachable = await containerExists(account, process.env.BACKUP_CONTAINER || "ledger-backup");
    } catch (e) {
      report.sourceContainerError = e.message;
    }
  }
  const [akid, asecret, bucket, region] = await Promise.all([
    kvSecret("aws-dr-access-key-id"),
    kvSecret("aws-dr-secret-access-key"),
    kvSecret("aws-dr-s3-bucket"),
    kvSecret("aws-dr-region"),
  ]);
  report.awsDrCredsProvisioned = Boolean(akid && asecret && bucket && region);
  report.awsDrMissing = [!akid && "aws-dr-access-key-id", !asecret && "aws-dr-secret-access-key", !bucket && "aws-dr-s3-bucket", !region && "aws-dr-region"].filter(Boolean);
  const [plakid, plasecret, plbucket] = await Promise.all([
    kvSecret("aws-dr-personal-legal-access-key-id"),
    kvSecret("aws-dr-personal-legal-secret-access-key"),
    kvSecret("aws-dr-personal-legal-s3-bucket"),
  ]);
  report.awsDrPersonalLegalCredsProvisioned = Boolean(plakid && plasecret && plbucket);
  const [flakid, flasecret, flbucket] = await Promise.all([
    kvSecret("aws-dr-finance-legal-access-key-id"),
    kvSecret("aws-dr-finance-legal-secret-access-key"),
    kvSecret("aws-dr-finance-legal-s3-bucket"),
  ]);
  report.awsDrFinanceCompanyLegalCredsProvisioned = Boolean(flakid && flasecret && flbucket);
  if (plbucket && plbucket === flbucket) report.laneCollisionWarning = "aws-dr-personal-legal-s3-bucket and aws-dr-finance-legal-s3-bucket resolve to the SAME bucket -- this must be fixed before either lane is armed.";
  console.log(JSON.stringify(report, null, 2));
}

// Only run as a script (not when imported by a test) -- matches the fleet's established convention
// (see skills/azure-canary/canary.mjs, skills/continuity-canary/continuity-canary.mjs). Without this
// guard, importing the pure classification helpers above for unit tests would also execute this
// argv-driven dispatch (and process.exit) as a side effect of the import itself.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const cmd = process.argv[2] || "run";
  const flags = new Set(process.argv.slice(3));
  if (cmd === "selftest") {
    selftest().catch((e) => {
      console.error("ERR", e.message);
      process.exit(1);
    });
  } else if (cmd === "run") {
    run({
      includePersonalLegal: flags.has("--include-personal-legal"),
      includeFinanceLegal: flags.has("--include-finance-legal"),
      dryRun: flags.has("--dry-run"),
    }).catch((e) => {
      console.error("ERR", e.message);
      process.exit(1);
    });
  } else {
    console.error("usage: node s3-mirror.mjs run [--include-personal-legal] [--include-finance-legal] [--dry-run] | selftest");
    process.exit(2);
  }
}
