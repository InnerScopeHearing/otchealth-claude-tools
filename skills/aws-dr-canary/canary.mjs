#!/usr/bin/env node
/**
 * canary.mjs — the AWS-native DR chain's verification canary. See SKILL.md for the full design and
 * the "AGE not a doc-count floor" rationale. Four checks: SSM secrets-archive freshness (S3), OpenSearch
 * snapshot freshness (repo status + newest SUCCESS), RDS automated-snapshot freshness, and a weekly
 * (day-of-week gated) restore-PROOF drill covering both the OpenSearch and SSM legs end to end.
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
 *   AWS_DR_CANARY_DRILL_DOW (default 0 = Sunday, UTC) — which day of week runs the restore-proof drill
 *   SECRETS_DR_PASSPHRASE (secret, optional) — needed for the drill's SSM-decrypt leg; without it that
 *     one sub-check reports SKIPPED, not a false anomaly.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { awsCreds } from "../kb-memory/aws-secret.mjs";
import { s3Head, s3Get } from "../fleet-backup/s3-client.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const OS_SNAPSHOT_SCRIPT = resolve(REPO_ROOT, "skills", "fleet-backup", "os-snapshot.mjs");
const RESTORE_SCRIPT = resolve(REPO_ROOT, "skills", "fleet-backup", "secrets-dr-restore.mjs");
const FRESHNESS_SLO_H = 26; // a daily job's own slack (matches azure-canary's identical 26h choice)
const MIN_SECRET_COUNT = 400;
const today = (d = new Date()) => d.toISOString().slice(0, 10);
const yesterday = () => today(new Date(Date.now() - 24 * 3600 * 1000));

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
// JSON-RPC or OpenSearch's plain REST, so this is a small dedicated signer rather than a reuse of
// either existing client. Same SigV4 mechanics throughout the toolkit; only the request/response
// SHAPE differs, which is exactly the class of difference that makes forcing a shared abstraction
// across all three not worth it.
function sha256Hex(s) { return crypto.createHash("sha256").update(s, "utf8").digest("hex"); }
function hmac(key, data) { return crypto.createHmac("sha256", key).update(data, "utf8").digest(); }

async function rdsDescribeDbSnapshots(creds, dbInstanceId) {
  const region = process.env.RDS_REGION || process.env.AWS_REGION || "us-east-1";
  const host = `rds.${region}.amazonaws.com`;
  const params = { Action: "DescribeDBSnapshots", Version: "2014-10-31", DBInstanceIdentifier: dbInstanceId, SnapshotType: "automated" };
  const body = Object.keys(params).sort().map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`).join("&");
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const headers = { host, "content-type": "application/x-www-form-urlencoded; charset=utf-8", "x-amz-date": amzDate, ...(creds.sessionToken ? { "x-amz-security-token": creds.sessionToken } : {}) };
  const sortedNames = Object.keys(headers).sort();
  const canonicalHeaders = sortedNames.map((n) => `${n}:${String(headers[n]).trim()}\n`).join("");
  const signedHeaders = sortedNames.join(";");
  const canonicalRequest = ["POST", "/", "", canonicalHeaders, signedHeaders, sha256Hex(body)].join("\n");
  const scope = `${dateStamp}/${region}/rds/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
  let k = hmac(`AWS4${creds.secretAccessKey}`, dateStamp);
  k = hmac(k, region); k = hmac(k, "rds"); k = hmac(k, "aws4_request");
  const signature = hmac(k, stringToSign).toString("hex");
  const authorization = `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const r = await fetch(`https://${host}/`, { method: "POST", headers: { ...headers, Authorization: authorization }, body });
  const text = await r.text();
  if (!r.ok) throw new Error(`DescribeDBSnapshots HTTP ${r.status}: ${text.slice(0, 400)}`);
  return text;
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

// ---------- check 4: weekly restore-proof drill ----------
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

/** Exit-code policy, mirrors every sibling canary's convention exactly: report-only by default (never
 *  a non-zero exit), --strict pages (non-zero exit) on any live anomaly (STALE/ERROR). SKIPPED is
 *  never an anomaly (a day the drill is not scheduled, or a missing optional passphrase, is expected). */
export function pageExitCode(results, strict) {
  const anomalies = results.filter((r) => r.status === "STALE" || r.status === "ERROR");
  if (!strict) return 0;
  return anomalies.length ? 1 : 0;
}

async function main() {
  const results = await Promise.all([checkSsmArchive(), checkOpenSearchSnapshot(), checkRdsSnapshot(), checkWeeklyDrill()]);
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
