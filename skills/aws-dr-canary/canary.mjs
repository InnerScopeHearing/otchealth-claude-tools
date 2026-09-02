#!/usr/bin/env node
/**
 * canary.mjs — the AWS-native DR chain's verification canary. See SKILL.md for the full design and
 * the "AGE not a doc-count floor" rationale. Seven checks: SSM secrets-archive freshness (S3), OpenSearch
 * snapshot freshness (repo status + newest SUCCESS), RDS automated-snapshot freshness, n8n's Lightsail
 * AutoSnapshot add-on freshness (+ the add-on itself still being Enabled), n8n's public /healthz
 * reachability, a weekly (day-of-week gated) restore-PROOF drill covering the OpenSearch and SSM legs
 * end to end, and (2026-08-29, closes FND-20260828-3142's canary half) per-room brain freshness: for
 * each non-privileged doc room, the newest S3 source object's age vs a per-room SLO, and — only once
 * that SLO is exceeded — an exact `path`-based existence check in the room's OpenSearch index (never
 * document content). See the "check 7" section below for why this compares OBJECT PRESENCE rather than
 * a literal timestamp field (the live chunked schema has none).
 *
 * THE n8n CHECKS (added 2026-08-28) close the exact "age-not-floor" blind spot this canary was built
 * to prevent, applied to the customer-service n8n host (skills/aws-dr-canary/SKILL.md's rationale):
 * Lightsail's own AutoSnapshot add-on can silently stop landing new snapshots (or be turned off
 * entirely) with nothing else in the fleet watching it, and n8n itself can go down with nothing but a
 * customer complaint to notice.
 *
 * Report-only by default; --strict exits non-zero on any anomaly (STALE/ERROR), which is how the
 * nightly workflow runs it and what makes setup/page-on-failure.mjs's `if: failure()` step fire —
 * matches skills/azure-canary and skills/aws-image-canary's exact convention.
 *
 * USAGE:
 *   node canary.mjs [--json] [--strict]
 *
 * ENV (non-secret unless noted):
 *   SECRETS_DR_S3_BUCKET / SECRETS_DR_S3_REGION  — same defaults as ssm-dr-export.mjs
 *   RDS_DB_INSTANCE_ID (default otchealth-pg), RDS_REGION / AWS_REGION (default us-east-1)
 *   N8N_LIGHTSAIL_INSTANCE_NAME (default otchealth-cs-n8n), N8N_LIGHTSAIL_REGION / AWS_REGION
 *   N8N_HEALTHZ_URL (default https://cs-n8n.otchealthmart.com/healthz)
 *   AWS_DR_CANARY_DRILL_DOW (default 0 = Sunday, UTC) — which day of week runs the restore-proof drill
 *   SECRETS_DR_PASSPHRASE (secret, optional) — needed for the drill's SSM-decrypt leg; without it that
 *     one sub-check reports SKIPPED, not a false anomaly.
 *   BRAIN_FRESHNESS_SLO_H_<ROOM> (optional per-room override, e.g. BRAIN_FRESHNESS_SLO_H_LEGAL_COMPANY)
 *     — see "check 7" below; the in-file BRAIN_ROOMS table default is used when unset.
 *   OPENSEARCH_ENDPOINT / OPENSEARCH_REGION (optional) — resolved by opensearch-write.mjs's
 *     resolveOpenSearchConfig() the same way every other OpenSearch caller in the toolkit resolves them.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { awsCreds } from "../kb-memory/aws-secret.mjs";
import { awsFetch } from "../../setup/aws-sigv4.mjs";
import { s3Head, s3Get } from "../fleet-backup/s3-client.mjs";
import { listBlobsMetaFromS3 } from "../kb-memory/s3-blob.mjs";
import { resolveOpenSearchConfig } from "../kb-memory/opensearch-write.mjs";
import { osCount } from "../doc-indexer/opensearch-client.mjs";
import { classifyIndexLane } from "../fleet-backup/os-snapshot.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const OS_SNAPSHOT_SCRIPT = resolve(REPO_ROOT, "skills", "fleet-backup", "os-snapshot.mjs");
const RESTORE_SCRIPT = resolve(REPO_ROOT, "skills", "fleet-backup", "secrets-dr-restore.mjs");
const FRESHNESS_SLO_H = 26; // a daily job's own slack (matches azure-canary's identical 26h choice)
const MIN_SECRET_COUNT = 400;
const today = (d = new Date()) => d.toISOString().slice(0, 10);
const yesterday = () => today(new Date(Date.now() - 24 * 3600 * 1000));

// The Lightsail instance name + Twilio/ElevenLabs-facing public health endpoint for the recovered
// customer-service n8n host (see otchealth-cto/runbooks/aws-dr-provisioning.md and
// otchealth-cto/.github/workflows/aws-n8n-recovery.yml, which already targets this exact instance name
// and domain). Overridable, same convention as RDS_DB_INSTANCE_ID above.
const N8N_LIGHTSAIL_INSTANCE_NAME = process.env.N8N_LIGHTSAIL_INSTANCE_NAME || "otchealth-cs-n8n";
const N8N_HEALTHZ_URL = process.env.N8N_HEALTHZ_URL || "https://cs-n8n.otchealthmart.com/healthz";

const argv = process.argv.slice(2);
const STRICT = argv.includes("--strict");
const JSON_OUT = argv.includes("--json");

function bucketRegion() {
  return {
    bucket: process.env.SECRETS_DR_S3_BUCKET || "otchealth-secrets-dr-900915535335",
    region: process.env.SECRETS_DR_S3_REGION || process.env.AWS_REGION || "us-east-1",
  };
}

// ---------- pure: gate the weekly drill to one day of the week (UTC) ----------
export function shouldRunDrillToday(now = new Date(), dowOverride) {
  const dow = dowOverride != null ? dowOverride : Number(process.env.AWS_DR_CANARY_DRILL_DOW ?? 0);
  return now.getUTCDay() === dow;
}

// ---------- check 1: SSM secrets archive freshness ----------
async function checkSsmArchive() {
  const c = await awsCreds();
  if (!c) return { name: "ssm-archive", status: "ERROR", detail: "no AWS credentials resolvable" };
  const { bucket, region } = bucketRegion();
  const creds = { accessKeyId: c.ak, secretAccessKey: c.sk, sessionToken: c.st || undefined, bucket, region };
  for (const date of [today(), yesterday()]) {
    const key = `secrets-dr/daily/ssm-otchealth-${date}.json.enc`;
    try {
      const head = await s3Head(creds, key);
      if (!head) continue;
      const ageH = (Date.now() - Date.parse(head.lastModified)) / 3600000;
      const count = Number(head.meta?.secretcount || 0);
      if (ageH > FRESHNESS_SLO_H) return { name: "ssm-archive", status: "STALE", detail: `newest found (${key}) is ${ageH.toFixed(1)}h old, SLO ${FRESHNESS_SLO_H}h` };
      if (count < MIN_SECRET_COUNT) return { name: "ssm-archive", status: "STALE", detail: `${key} reports secretCount=${count}, below the floor of ${MIN_SECRET_COUNT}` };
      return { name: "ssm-archive", status: "OK", detail: `${key}, ${ageH.toFixed(1)}h old, ${count} secrets` };
    } catch (e) {
      return { name: "ssm-archive", status: "ERROR", detail: String(e.message || e).slice(0, 300) };
    }
  }
  return { name: "ssm-archive", status: "STALE", detail: `neither today's nor yesterday's archive found in s3://${bucket}/secrets-dr/daily/` };
}

// ---------- check 2: OpenSearch snapshot freshness (shells to os-snapshot.mjs's own tested `status`) ----------
async function checkOpenSearchSnapshot() {
  try {
    const out = execFileSync("node", [OS_SNAPSHOT_SCRIPT, "status", "--json"], { encoding: "utf8", timeout: 30000 });
    const status = JSON.parse(out);
    if (!status.registered) return { name: "opensearch-snapshot", status: "ERROR", detail: `repo "${status.repo}" is not registered on the domain (a deleted/de-registered repo — distinct from a stale snapshot)` };
    if (!status.newestSuccessful) return { name: "opensearch-snapshot", status: "STALE", detail: `repo "${status.repo}" is registered but has NO successful snapshot` };
    if (status.newestSuccessful.ageHours > FRESHNESS_SLO_H) {
      return { name: "opensearch-snapshot", status: "STALE", detail: `newest SUCCESS snapshot is ${status.newestSuccessful.ageHours.toFixed(1)}h old, SLO ${FRESHNESS_SLO_H}h` };
    }
    return { name: "opensearch-snapshot", status: "OK", detail: `${status.newestSuccessful.id}, ${status.newestSuccessful.ageHours.toFixed(1)}h old` };
  } catch (e) {
    return { name: "opensearch-snapshot", status: "ERROR", detail: String(e.message || e).slice(0, 300) };
  }
}

// ---------- check 3: RDS automated-snapshot freshness ----------
// AWS RDS is a "Query protocol" service (form-encoded POST body, XML response) -- unlike SSM's
// JSON-RPC or OpenSearch's plain REST. It always signs a bare "/" path, so FND-20260828-5ca1's
// double-vs-single-encode fix is a no-op here; this migration onto ../../setup/aws-sigv4.mjs (one of
// six hand-rolled SigV4 implementations consolidated 2026-09-02) is a pure refactor, not a bug fix,
// for this specific caller.
export async function rdsDescribeDbSnapshots(creds, dbInstanceId) {
  const region = process.env.RDS_REGION || process.env.AWS_REGION || "us-east-1";
  const host = `rds.${region}.amazonaws.com`;
  const params = { Action: "DescribeDBSnapshots", Version: "2014-10-31", DBInstanceIdentifier: dbInstanceId, SnapshotType: "automated" };
  const body = Object.keys(params).sort().map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`).join("&");
  const r = await awsFetch(`https://${host}/`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8" },
    body,
  }, { service: "rds", region, credentials: creds });
  if (r.reason) throw new Error(`DescribeDBSnapshots ${r.reason}: ${(r.text || "").slice(0, 400)}`);
  return r.text;
}

/** Pure: extract {createTime, status} per <DBSnapshot> block from the raw XML response. A narrow,
 *  purpose-built regex extractor (matches heartbeat.mjs's own house style for a small, known XML
 *  shape) rather than a general XML parser dependency -- the only two fields this canary needs. */
export function parseDbSnapshotsXml(xml) {
  const out = [];
  for (const block of xml.matchAll(/<DBSnapshot>([\s\S]*?)<\/DBSnapshot>/g)) {
    const body = block[1];
    const ct = body.match(/<SnapshotCreateTime>([^<]+)<\/SnapshotCreateTime>/);
    const st = body.match(/<Status>([^<]+)<\/Status>/);
    if (ct) out.push({ createTime: ct[1], status: st ? st[1] : "" });
  }
  return out;
}

/** Pure: newest snapshot with status "available", or null. */
export function pickNewestAvailable(snapshots) {
  const ok = (snapshots || []).filter((s) => s.status === "available" && s.createTime);
  if (!ok.length) return null;
  return ok.reduce((a, b) => (Date.parse(b.createTime) > Date.parse(a.createTime) ? b : a));
}

async function checkRdsSnapshot() {
  const c = await awsCreds();
  if (!c) return { name: "rds-snapshot", status: "ERROR", detail: "no AWS credentials resolvable" };
  const dbId = process.env.RDS_DB_INSTANCE_ID || "otchealth-pg";
  try {
    const xml = await rdsDescribeDbSnapshots({ accessKeyId: c.ak, secretAccessKey: c.sk, sessionToken: c.st || undefined }, dbId);
    const newest = pickNewestAvailable(parseDbSnapshotsXml(xml));
    if (!newest) return { name: "rds-snapshot", status: "STALE", detail: `no available automated snapshot found for "${dbId}"` };
    const ageH = (Date.now() - Date.parse(newest.createTime)) / 3600000;
    if (ageH > FRESHNESS_SLO_H) return { name: "rds-snapshot", status: "STALE", detail: `newest available snapshot is ${ageH.toFixed(1)}h old, SLO ${FRESHNESS_SLO_H}h` };
    return { name: "rds-snapshot", status: "OK", detail: `${ageH.toFixed(1)}h old` };
  } catch (e) {
    return { name: "rds-snapshot", status: "ERROR", detail: String(e.message || e).slice(0, 300) };
  }
}

// ---------- check 4: n8n Lightsail AutoSnapshot freshness (+ the add-on itself still Enabled) ----------
// Lightsail's wire protocol is JSON-1.1 with an x-amz-target header (POST /, application/x-amz-json-1.1
// body) -- a different shape from RDS's Query protocol above (form-encoded body, no x-amz-target), but
// like RDS it always signs a bare "/" path, so this migration onto ../../setup/aws-sigv4.mjs is also a
// pure refactor (no double-vs-single-encode question applies to a rootless path).
export async function lightsailCall(creds, region, action, body) {
  const host = `lightsail.${region}.amazonaws.com`;
  const r = await awsFetch(`https://${host}/`, {
    method: "POST",
    headers: { "content-type": "application/x-amz-json-1.1", "x-amz-target": `Lightsail_20161128.${action}` },
    body: JSON.stringify(body),
  }, { service: "lightsail", region, credentials: creds });
  // awsFetch() never throws (a no-credentials or transport failure comes back as status:0 + reason
  // instead) -- the ORIGINAL bare-fetch() version of this function DID throw on a transport error,
  // which checkN8nAutoSnapshot()'s own try/catch turned into a detailed error message. Preserve that:
  // a real network/credential failure (status 0) still throws here, so callers keep their existing
  // "HTTP <code>" branch for genuine non-2xx responses and their existing catch-block detail for
  // everything else, exactly as before this migration.
  if (r.status === 0) throw new Error(`${action}: ${r.reason}`);
  return { status: r.status, json: r.json, text: r.text };
}

/** Pure: does a Lightsail GetInstance response show the AutoSnapshot add-on as Enabled? Returns false
 *  for a missing/absent add-on entry too (never assume enabled without seeing it). A disabled add-on is
 *  a DISTINCT failure mode from a stale snapshot, mirroring checkOpenSearchSnapshot()'s own "repo not
 *  registered" vs "snapshot is old" split above -- someone can turn the add-on off entirely and the LAST
 *  snapshot taken before that stays inside the freshness SLO for a while, silently hiding that nothing
 *  new will ever land again. */
export function isAutoSnapshotAddOnEnabled(instanceJson) {
  const addOns = instanceJson?.instance?.addOns;
  if (!Array.isArray(addOns)) return false;
  return addOns.some((a) => a?.name === "AutoSnapshot" && a?.status === "Enabled");
}

/** Pure: the newest Lightsail auto-snapshot whose status is "Success", or null when there is none at
 *  all (an InProgress/Failed/NotFound-only list is a real anomaly, never mistaken for "no data yet" --
 *  mirrors pickNewestAvailable()'s own RDS convention above). `createdAt` is Lightsail's own
 *  epoch-SECONDS timestamp, the same convention this fleet's other canaries use for AWS JSON-protocol
 *  timestamps (e.g. ECR's imagePushedAt in skills/aws-image-canary/image-canary.mjs). */
export function pickNewestSuccessfulAutoSnapshot(autoSnapshots) {
  const ok = (autoSnapshots || []).filter((s) => s?.status === "Success" && Number.isFinite(s?.createdAt));
  if (!ok.length) return null;
  return ok.reduce((a, b) => (b.createdAt > a.createdAt ? b : a));
}

/** Pure: classify a picked auto-snapshot's age against the freshness SLO. `now` and `sloHours` are
 *  injectable for tests, matching skills/azure-canary/canary.mjs's assessFreshness() convention exactly
 *  (including the <= boundary: exactly-at-SLO is still OK, not STALE). `newest` is whatever
 *  pickNewestSuccessfulAutoSnapshot() returned -- null carries its own distinct STALE reason ("no
 *  successful auto-snapshot at all") rather than being conflated with "the newest one is too old". */
export function assessAutoSnapshotFreshness(newest, now = Date.now(), sloHours = FRESHNESS_SLO_H) {
  if (!newest) return { state: "STALE", reason: "no successful auto-snapshot" };
  const ageH = (now - newest.createdAt * 1000) / 3600000;
  if (ageH > sloHours) return { state: "STALE", reason: `newest successful auto-snapshot is ${ageH.toFixed(1)}h old, SLO ${sloHours}h`, ageH };
  return { state: "OK", ageH };
}

async function checkN8nAutoSnapshot() {
  const c = await awsCreds();
  if (!c) return { name: "n8n-autosnapshot", status: "ERROR", detail: "no AWS credentials resolvable" };
  const creds = { accessKeyId: c.ak, secretAccessKey: c.sk, sessionToken: c.st || undefined };
  const region = process.env.N8N_LIGHTSAIL_REGION || process.env.AWS_REGION || "us-east-1";
  try {
    const inst = await lightsailCall(creds, region, "GetInstance", { instanceName: N8N_LIGHTSAIL_INSTANCE_NAME });
    if (inst.status !== 200) return { name: "n8n-autosnapshot", status: "ERROR", detail: `GetInstance HTTP ${inst.status}: ${(inst.text || "").slice(0, 300)}` };
    if (!isAutoSnapshotAddOnEnabled(inst.json)) {
      return { name: "n8n-autosnapshot", status: "ERROR", detail: `the AutoSnapshot add-on is not Enabled on Lightsail instance "${N8N_LIGHTSAIL_INSTANCE_NAME}" (distinct from a stale snapshot -- nothing new will ever land while this holds)` };
    }
    const snaps = await lightsailCall(creds, region, "GetAutoSnapshots", { resourceName: N8N_LIGHTSAIL_INSTANCE_NAME });
    if (snaps.status !== 200) return { name: "n8n-autosnapshot", status: "ERROR", detail: `GetAutoSnapshots HTTP ${snaps.status}: ${(snaps.text || "").slice(0, 300)}` };
    const newest = pickNewestSuccessfulAutoSnapshot(snaps.json?.autoSnapshots);
    const v = assessAutoSnapshotFreshness(newest);
    if (v.state === "STALE") return { name: "n8n-autosnapshot", status: "STALE", detail: `AutoSnapshot is Enabled on "${N8N_LIGHTSAIL_INSTANCE_NAME}" but ${v.reason}` };
    return { name: "n8n-autosnapshot", status: "OK", detail: `AutoSnapshot Enabled on "${N8N_LIGHTSAIL_INSTANCE_NAME}", newest success (${newest.date || "unknown date"}) ${v.ageH.toFixed(1)}h old` };
  } catch (e) {
    return { name: "n8n-autosnapshot", status: "ERROR", detail: String(e.message || e).slice(0, 300) };
  }
}

// ---------- check 5: n8n /healthz reachability (plain, unauthenticated fetch, no AWS creds needed) ----
/** Pure: classify a healthz probe's HTTP status. Exported so the DECISION (not the network call itself)
 *  is unit-testable without touching fetch -- matches classifyDescribeImagesResponse()'s own "take the
 *  already-fetched status/body, no network" shape in skills/aws-image-canary/image-canary.mjs. */
export function classifyHealthzStatus(status) {
  return status === 200 ? "OK" : "ERROR";
}

async function fetchHealthzOnce(url, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    return { status: r.status, error: null };
  } catch (e) {
    return { status: 0, error: String(e.message || e) };
  } finally {
    clearTimeout(t);
  }
}

async function checkN8nHealthz() {
  // n8n can be briefly slow (first-boot migrations, a cold container) -- retry a couple of times before
  // reporting an anomaly, mirroring the recovery workflow's own lesson that "the post-restore health
  // gate must RETRY (~2 min of first-boot migrations before /healthz answers)"
  // (otchealth-cto/.github/workflows/aws-n8n-recovery.yml).
  const MAX_ATTEMPTS = 3;
  const attempts = [];
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const r = await fetchHealthzOnce(N8N_HEALTHZ_URL, 10000);
    attempts.push(r.error ? `attempt ${attempt}: ${r.error}` : `attempt ${attempt}: HTTP ${r.status}`);
    if (classifyHealthzStatus(r.status) === "OK") {
      return { name: "n8n-healthz", status: "OK", detail: `${N8N_HEALTHZ_URL} -> HTTP 200 (attempt ${attempt}/${MAX_ATTEMPTS})` };
    }
    if (attempt < MAX_ATTEMPTS) await new Promise((res) => setTimeout(res, 3000));
  }
  return { name: "n8n-healthz", status: "ERROR", detail: `${N8N_HEALTHZ_URL} never returned HTTP 200 after ${MAX_ATTEMPTS} attempts (${attempts.join("; ")})` };
}

// ---------- check 6: weekly restore-proof drill ----------
async function checkWeeklyDrill() {
  if (!shouldRunDrillToday()) {
    return { name: "weekly-restore-drill", status: "SKIPPED", detail: `not scheduled today (runs on UTC day-of-week ${process.env.AWS_DR_CANARY_DRILL_DOW ?? 0})` };
  }
  const results = [];

  try {
    execFileSync("node", [OS_SNAPSHOT_SCRIPT, "restore-drill"], { encoding: "utf8", timeout: 90000, stdio: "pipe" });
    results.push("opensearch:PASS");
  } catch (e) {
    return { name: "weekly-restore-drill", status: "ERROR", detail: `OpenSearch restore-drill FAILED: ${String(e.stderr || e.message || e).slice(0, 400)}` };
  }

  const pass = process.env.SECRETS_DR_PASSPHRASE;
  if (!pass) {
    results.push("ssm-decrypt:SKIPPED(no SECRETS_DR_PASSPHRASE)");
    return { name: "weekly-restore-drill", status: "OK", detail: results.join(", ") };
  }
  const c = await awsCreds();
  if (!c) return { name: "weekly-restore-drill", status: "ERROR", detail: "OpenSearch drill passed but no AWS credentials for the SSM leg" };
  const { bucket, region } = bucketRegion();
  const creds = { accessKeyId: c.ak, secretAccessKey: c.sk, sessionToken: c.st || undefined, bucket, region };
  let buf = null;
  for (const date of [today(), yesterday()]) {
    buf = await s3Get(creds, `secrets-dr/daily/ssm-otchealth-${date}.json.enc`).catch(() => null);
    if (buf) break;
  }
  if (!buf) return { name: "weekly-restore-drill", status: "ERROR", detail: `${results.join(", ")}, ssm-decrypt:FAIL(no archive found in S3)` };
  const tmp = mkdtempSync(join(tmpdir(), "aws-dr-canary-"));
  const file = join(tmp, "drill.enc");
  try {
    writeFileSync(file, buf);
    const out = execFileSync("node", [RESTORE_SCRIPT, file], { encoding: "utf8", env: { ...process.env, SECRETS_DR_PASSPHRASE: pass }, timeout: 30000 });
    const count = out.split("\n").filter((l) => l.trim()).length;
    if (count < 1) return { name: "weekly-restore-drill", status: "ERROR", detail: `${results.join(", ")}, ssm-decrypt:FAIL(decrypted 0 names)` };
    results.push(`ssm-decrypt:PASS(${count} names)`);
    return { name: "weekly-restore-drill", status: "OK", detail: results.join(", ") };
  } catch (e) {
    return { name: "weekly-restore-drill", status: "ERROR", detail: `${results.join(", ")}, ssm-decrypt:FAIL(${String(e.stderr || e.message || e).slice(0, 200)})` };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------- check 7: per-room brain freshness (S3 source vs OpenSearch index), 2026-08-29 ----------
// Closes the CANARY HALF of FND-20260828-3142 ("docs added since 2026-08-13 unindexed ... add
// per-room newest-indexed_at-vs-newest-S3-object canary"). The backfill half (making the librarian
// jobs actually run push-search per room) is separate and tracked elsewhere; this is the sensor.
//
// WHY THIS COMPARES OBJECT PRESENCE, NOT A LITERAL TIMESTAMP FIELD (a deliberate divergence from the
// finding's own literal wording, written down here for the same reason indexer.mjs's own
// buildChunkDocs() header documents its schema choices in this much detail): the finding's title asks
// for "newest-indexed_at" freshness, which assumes a per-document timestamp field on the OpenSearch
// side. skills/doc-indexer/indexer.mjs's CHUNKED-room-ingest section (2026-08-28) establishes, by
// live query against three separate rooms, that NO such field exists anywhere in the live chunked
// mapping — and that indexer.mjs was deliberately told never to invent one (adding a new mapping
// field to a live, historically-migrated chunked index is exactly the kind of schema change that
// section's own header warns against). setup/expected-indexes.json's header agrees
// ("the S1 chunked schema carries NO per-doc timestamp field"). So "compare the newest indexed_at" is
// not implementable without contradicting an explicit, load-bearing decision made one day before this
// canary was written — reusing a stale premise instead of checking it against the actual live schema
// would be exactly the mistake this file's own commit history keeps calling out in other checks.
//
// The chosen substitute answers the SAME question the finding actually cares about — "did the newest
// thing added to S3 make it into the index" — more precisely than a raw max(indexed_at) comparison
// ever could, because it never has to worry about clock skew between the S3 and OpenSearch timestamps
// or about *which* document is "newest" once one has been re-embedded: it asks OpenSearch, by an
// EXACT `path.keyword` term match (the identical field/technique enrich.mjs's own osFindChunkIds()
// already uses live), whether the single most-recently-modified real source object in the room has
// ANY chunk present at all. `_count` returns only an integer — no `_source`, no document fields, not
// even a hit list — so this is a strictly narrower read than "timestamps only" would already permit.
//
// AGE GATE BEFORE THE PRESENCE CHECK (age-not-floor, same house rule as every other check in this
// file): an object uploaded five minutes ago that is not yet indexed is not an anomaly, it is normal
// pipeline latency — the librarian jobs run on a cadence (6h for the privileged rooms per
// expected-indexes.json), not instantly. So the OpenSearch call is skipped entirely, and the room
// reports OK, whenever the newest source object's own age is still inside its room's SLO. Only once
// that SLO is exceeded does "still not indexed" become worth an actual query, and only then can it
// become the STALE anomaly this finding exists to catch.
//
// RING SAFETY (hard, per this section's own dispatch task): classifyIndexLane() — imported from
// os-snapshot.mjs, never copy-pasted, so this canary's ring boundary can never drift from the DR
// snapshot canary's own privileged/non-privileged split — is consulted FIRST, before any network call
// of any kind. A room that is not "non-privileged" is reported SKIPPED with the exact classification
// named in the detail string (explicit, never a silent omission — "when in doubt, exclude and note
// it"), and neither the S3 listing nor the OpenSearch query is ever attempted against it. Of the five
// real chunked doc rooms, that currently excludes finance-cfo-source-docs and legal-company (both
// classify "finance-company-legal") and legal-personal (classifies "personal-legal") — leaving
// commons-company-journal and commerce-commerce-source-docs as the only two this canary actively
// checks. Even for those two, the check never reads a document's `chunk`/`content`/`title`/`entity`
// field or any enrichment field — only S3 object metadata (name/size/lastModified) and an OpenSearch
// document COUNT.
//
// "CANNOT CHECK" vs "CHECKED AND STALE" (the other hard requirement): every failure that prevents the
// check from running at all — an unmapped room, a failed S3 listing, unresolvable OpenSearch
// credentials/config, a failed or non-2xx `_count` call — reports ERROR, never STALE. STALE is
// reserved for the one case where the check actually completed and found a real gap: the newest
// source object is past its room's SLO and OpenSearch reports zero chunks for its exact path. An
// unreachable sensor must never report healthy, and it must not report the WRONG kind of unhealthy
// either — an ops engineer reading ERROR knows to check credentials/connectivity; STALE means the
// pipeline itself needs attention.

const BRAIN_FRESHNESS_DEFAULT_SLO_H = 26; // same constant as FRESHNESS_SLO_H above; used only for a room whose own BRAIN_ROOMS entry omits sloHours

// Union of pipeline-paths.mjs's PIPELINE_PREFIXES (_TEXT/, _CATALOG/, _REVIEW/, _MEMORY/, _STATE/,
// _ARCHIVE/) and indexer.mjs's own local SKIP_PREFIXES (_SUMMARY/, _TRASH/, _NON-ACCOUNTING/,
// _DUPLICATES/, _HANDOFF/, _DISPATCH/, plus the four already listed). A parallel local copy, not a
// cross-file import of either: pipeline-paths.mjs's own list is a strict subset (missing _TRASH/, the
// live legal_blob_delete soft-delete destination, among others) and indexer.mjs cannot be imported at
// all without triggering its top-level argv parsing and CLI dispatch as a side effect of the import
// (the exact hazard pipeline-paths.mjs's own header documents) — this codebase's established
// convention for a tiny, static path predicate like this one is a small parallel copy per file (see
// indexer.mjs's own dirnameBelowRoot() comment), not a forced cross-file dependency. Keep in sync by
// re-reading both source lists if either ever changes; a missed prefix here only makes this canary
// MORE cautious (it would treat a pipeline artifact as a "new document" and wait out its SLO before
// alerting), never less safe.
export const ROOM_PIPELINE_PREFIXES = Object.freeze([
  "_TEXT/", "_CATALOG/", "_REVIEW/", "_MEMORY/", "_STATE/", "_ARCHIVE/",
  "_SUMMARY/", "_TRASH/", "_NON-ACCOUNTING/", "_DUPLICATES/", "_HANDOFF/", "_DISPATCH/",
]);

/** True when a raw S3-listed object name is this pipeline's own bookkeeping (a _TEXT/ sidecar, the
 *  catalog, a triage folder, ...) rather than a real source document. Pure, exported for a direct
 *  unit test with no listing/network involved. */
export function isRoomPipelineInternal(name) {
  return ROOM_PIPELINE_PREFIXES.some((p) => String(name || "").startsWith(p));
}

// The five real chunked doc rooms (skills/doc-indexer/indexer.mjs's CHUNKED-room-ingest section,
// verified live 2026-08-28) plus each one's (account, container) pair for the S3 source listing
// (skills/kb-memory/s3-blob.mjs's MIRROR table) and a default per-room SLO. `index` is always
// identical to `name` here — it is the OpenSearch index name, computed the SAME way
// indexer.mjs's computeIndexName() computes it (`${profile}-${container}`) — kept as its own field
// (rather than re-deriving it from account/container at call time) so a future room whose index name
// diverges from that formula is not silently mishandled. Default sloHours are NOT the blanket 26h —
// they are copied verbatim from setup/expected-indexes.json's OWN max_age_h for the same index name
// (reuse, not reinvention: that file already encodes "rooms with legitimately slow churn should not
// flap" for these exact rooms), overridable per room via BRAIN_FRESHNESS_SLO_H_<ROOM> (see
// resolveRoomSloHours below) without a code change.
export const BRAIN_ROOMS = Object.freeze([
  { name: "commons-company-journal", index: "commons-company-journal", account: "otchealthcommons", container: "company-journal", sloHours: 48 },
  { name: "commerce-commerce-source-docs", index: "commerce-commerce-source-docs", account: "otchealthcommerce", container: "commerce-source-docs", sloHours: 72 },
  { name: "finance-cfo-source-docs", index: "finance-cfo-source-docs", account: "otchealthcfodata", container: "cfo-source-docs", sloHours: 168 },
  { name: "legal-company", index: "legal-company", account: "otchealthlegalstore", container: "company", sloHours: 168 },
  { name: "legal-personal", index: "legal-personal", account: "otchealthlegalstore", container: "personal", sloHours: 168 },
]);

/** Pure: pick the single newest (`lastModified`) object out of a room's raw S3 listing, after
 *  filtering out directory-marker entries (a trailing '/') and this pipeline's own bookkeeping
 *  prefixes. Returns null when nothing real is left (an empty room, or every object filtered out).
 *  Exported for a direct unit test with a plain array, no S3/network involved — mirrors this file's
 *  own pickNewestAvailable()/pickNewestSuccessfulAutoSnapshot() "filter, then reduce to the max"
 *  shape exactly. */
export function pickNewestSourceBlob(blobs) {
  const real = (blobs || []).filter((b) => b && b.name && !b.name.endsWith("/") && !isRoomPipelineInternal(b.name));
  if (!real.length) return null;
  return real.reduce((a, b) => (Date.parse(b.lastModified) > Date.parse(a.lastModified) ? b : a));
}

function sloEnvName(roomName) {
  return `BRAIN_FRESHNESS_SLO_H_${String(roomName).toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
}

/** Pure (reads only process.env, no network): a room's effective SLO in hours — an explicit
 *  BRAIN_FRESHNESS_SLO_H_<ROOM> env override (e.g. BRAIN_FRESHNESS_SLO_H_LEGAL_COMPANY) when set to a
 *  finite positive number, else the room's own BRAIN_ROOMS.sloHours, else BRAIN_FRESHNESS_DEFAULT_SLO_H
 *  (26h, matching this file's other FRESHNESS_SLO_H). Exported for a direct unit test. */
export function resolveRoomSloHours(room) {
  const raw = process.env[sloEnvName(room.name)];
  const n = raw != null && raw !== "" ? Number(raw) : NaN;
  if (Number.isFinite(n) && n > 0) return n;
  return Number.isFinite(room.sloHours) ? room.sloHours : BRAIN_FRESHNESS_DEFAULT_SLO_H;
}

/** Pure: the actual freshness DECISION, isolated from every network call above it so it is directly
 *  unit-testable (mirrors assessAutoSnapshotFreshness()'s own separation of decision from I/O).
 *  `indexedCount` is ignored (may be null) when `ageHours <= sloHours` — the object is still within
 *  normal pipeline latency, so whether it happens to be indexed yet is not this call's concern. */
export function assessRoomFreshness(ageHours, sloHours, indexedCount) {
  if (ageHours <= sloHours) {
    return { state: "OK", reason: `is within the ${sloHours}h SLO -- not yet expected to be indexed` };
  }
  if (indexedCount > 0) {
    return { state: "OK", reason: `is past the ${sloHours}h SLO but IS present in the index (${indexedCount} chunk(s) found by exact path match)` };
  }
  return { state: "STALE", reason: `is past the ${sloHours}h SLO with ZERO chunks found in the index by exact path match -- looks unindexed` };
}

/** One room's full freshness check: ring-gate first (no network on a privileged room, ever), then S3
 *  listing -> pick the newest real source object -> age-gate -> (only past SLO) an exact-path
 *  OpenSearch `_count`. Exported so a single room is directly testable (including the "zero fetch
 *  calls for a privileged room" ring-safety regression guard) without running the whole registry. */
export async function checkOneBrainRoomFreshness(room) {
  const name = `brain-room-${room.name}`;
  const lane = classifyIndexLane(room.index);
  if (lane !== "non-privileged") {
    return { name, status: "SKIPPED", detail: `ring-excluded: classifyIndexLane("${room.index}") = "${lane}" -- this canary never reads a privileged room's content OR document existence (explicitly noted, not silently omitted)` };
  }
  const sloHours = resolveRoomSloHours(room);
  let blobs;
  try {
    blobs = await listBlobsMetaFromS3(room.account, room.container, "");
  } catch (e) {
    return { name, status: "ERROR", detail: `cannot check (S3 listing of ${room.account}/${room.container} failed): ${String((e && e.message) || e).slice(0, 300)}` };
  }
  const newest = pickNewestSourceBlob(blobs);
  if (!newest) {
    return { name, status: "ERROR", detail: `cannot check cleanly: 0 source object(s) found under ${room.account}/${room.container} after filtering pipeline-internal paths -- either genuinely empty or a listing/permission problem` };
  }
  const ageH = (Date.now() - Date.parse(newest.lastModified)) / 3600000;
  if (ageH <= sloHours) {
    const v = assessRoomFreshness(ageH, sloHours, null);
    return { name, status: v.state, detail: `newest source object "${newest.name}" (${ageH.toFixed(1)}h old) ${v.reason}` };
  }
  let cfg;
  try {
    cfg = await resolveOpenSearchConfig();
  } catch (e) {
    return { name, status: "ERROR", detail: `cannot check (OpenSearch config/credentials unresolvable): ${String((e && e.message) || e).slice(0, 300)}` };
  }
  const fullPath = `${room.account}/${room.container}/${newest.name}`;
  let res;
  try {
    res = await osCount(cfg, room.index, { term: { "path.keyword": fullPath } });
  } catch (e) {
    return { name, status: "ERROR", detail: `cannot check (OpenSearch _count against "${room.index}" failed): ${String((e && e.message) || e).slice(0, 300)}` };
  }
  if (!res.ok) {
    return { name, status: "ERROR", detail: `cannot check (OpenSearch _count HTTP ${res.status} for index "${room.index}"): ${(res.text || "").slice(0, 200)}` };
  }
  const count = Number(res.json?.count ?? 0);
  const v = assessRoomFreshness(ageH, sloHours, count);
  return { name, status: v.state, detail: `newest source object "${newest.name}" (${ageH.toFixed(1)}h old, SLO ${sloHours}h) ${v.reason}` };
}

async function checkBrainRoomsFreshness() {
  return Promise.all(BRAIN_ROOMS.map((room) => checkOneBrainRoomFreshness(room)));
}

/** Exit-code policy, mirrors every sibling canary's convention exactly: report-only by default (never
 *  a non-zero exit), --strict pages (non-zero exit) on any live anomaly (STALE/ERROR). SKIPPED is
 *  never an anomaly (a day the drill is not scheduled, or a missing optional passphrase, is expected). */
export function pageExitCode(results, strict) {
  const anomalies = results.filter((r) => r.status === "STALE" || r.status === "ERROR");
  if (!strict) return 0;
  return anomalies.length ? 1 : 0;
}

async function main() {
  const results = [
    ...(await Promise.all([
      checkSsmArchive(),
      checkOpenSearchSnapshot(),
      checkRdsSnapshot(),
      checkN8nAutoSnapshot(),
      checkN8nHealthz(),
      checkWeeklyDrill(),
    ])),
    ...(await checkBrainRoomsFreshness()),
  ];
  if (JSON_OUT) {
    console.log(JSON.stringify({ ts: new Date().toISOString(), strict: STRICT, results }, null, 2));
  } else {
    console.log(`# aws-dr-canary — ${results.length} check(s)${STRICT ? " [--strict]" : ""}`);
    for (const r of results) console.log(`[${r.status.padEnd(8)}] ${r.name.padEnd(24)} ${r.detail}`);
  }
  const anomalies = results.filter((r) => r.status === "STALE" || r.status === "ERROR");
  if (anomalies.length) {
    console.error(`::warning::[aws-dr-canary] ${anomalies.length} anomal${anomalies.length === 1 ? "y" : "ies"}: ${anomalies.map((a) => a.name).join(", ")}`);
  }
  process.exit(pageExitCode(results, STRICT));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(`[aws-dr-canary] FATAL: ${String(e && e.message || e)}`); process.exit(1); });
}
