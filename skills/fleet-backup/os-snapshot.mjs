#!/usr/bin/env node
/**
 * os-snapshot.mjs — off-domain manual snapshot repository admin for the OpenSearch domain
 * `otchealth-brain` (the live company brain the gateway's brain_search federates). The domain's
 * built-in automated snapshots (hourly, 14-day retention) exist but are INSEPARABLE FROM THE DOMAIN:
 * delete or lose the domain and they are gone with it, and they cannot be copied out. A manual
 * snapshot repository backed by our OWN S3 bucket is the real off-domain DR leg this closes.
 *
 * RING SEGREGATION (hard requirement, not a style choice -- see FINDINGS/CLAUDE.md's
 * PERSONAL_LEGAL_RING and s3-mirror.mjs's identical three/four-lane split, REUSED here rather than
 * reinvented): the domain hosts privileged indices (legal-personal, legal-personal-memory,
 * finance-cfo-source-docs, finance-cfo-memory, and anything else matching s3-mirror.mjs's
 * PRIVILEGED_SUBSTRINGS). The non-privileged snapshot repo/policy built by this script EXCLUDES every
 * one of those substrings by pattern, dynamically derived from s3-mirror.mjs's own exported
 * PRIVILEGED_SUBSTRINGS array (imported, not copy-pasted) so the two ring boundaries can never drift
 * apart. `--lane personal-legal` / `--lane finance-legal` exist as a SCAFFOLD ONLY (register/
 * create-policy accept them) but REFUSE to run unless OS_SNAPSHOT_CONFIRM_RING_SCOPE=1 is set --
 * see the refusal message at PRIVILEGED_LANE_GATE below for exactly why this is a decision this
 * script deliberately does not make on its own. As shipped, NOTHING routes privileged index content
 * anywhere; only the non-privileged lane is wired to actually run.
 *
 * TWO DISTINCT AWS APIS, BOTH SIGNED SigV4 SERVICE "es" (reused from opensearch-client.mjs, never
 * re-signed): the domain's own DATA-plane REST API (the snapshot/_cat/_restore endpoints, hit at the
 * domain's data-plane hostname) for everything snapshot-related, and the separate CONTROL-plane API
 * (es.<region>.amazonaws.com) only to RESOLVE that hostname in the first place
 * (osResolveDomainEndpoint) -- never hardcode a domain endpoint anywhere, a domain recreated after a
 * disaster gets a brand new one.
 *
 * REGISTRATION IS SIGNED AND NEEDS iam:PassRole (a real, documented AWS quirk): a plain PUT to
 * _snapshot/... 403s regardless of the domain's access policy -- registration is authorized as an AWS
 * request. The signing identity needs es:ESHttpPut on the domain AND iam:PassRole on the snapshot
 * role being registered. If the domain has fine-grained access control (FGAC) enabled, the signing
 * identity must ALSO be mapped to the `manage_snapshots` OpenSearch security-plugin role or every
 * snapshot call 403s even with IAM fully satisfied -- `register`/`create-policy` print a reminder to
 * check this (`GET DomainStatus.AdvancedSecurityOptions.Enabled`) but do not attempt to fix it (that
 * mapping call needs its own FGAC-admin credential this script does not assume it has).
 *
 * DOMAIN ACCESS-POLICY WARNING: registering a snapshot role does NOT require editing the domain's
 * access policy in the usual case (plain-SigV4 gateway auth on this domain implies the policy already
 * grants account principals broadly) -- but `update-domain-config --access-policies` REPLACES the
 * whole document if anyone ever does touch it, which would silently clobber the LIVE gateway's own
 * brain_search access. This script never calls that API; it is flagged here only so nobody "fixes" a
 * registration 403 by reaching for it without reading the existing policy first and merging.
 *
 * USAGE:
 *   node os-snapshot.mjs list-indices [--json]
 *   node os-snapshot.mjs register [--role-arn <arn>] [--repo <name>] [--lane personal-legal|finance-legal]
 *   node os-snapshot.mjs create-policy [--repo <name>] [--policy-name <name>] [--lane ...]
 *   node os-snapshot.mjs status [--repo <name>] [--json]
 *   node os-snapshot.mjs restore-drill [--index <name>] [--repo <name>]
 *
 * ENV (non-secret; an OpenSearch domain name/region/bucket are not sensitive):
 *   OS_DOMAIN_NAME (default otchealth-brain), OS_REGION / AWS_REGION (default us-east-1)
 *   OS_SNAPSHOT_REPO (default otchealth-brain-s3), OS_SNAPSHOT_BUCKET (default otchealth-brain-dr-55c84f6b)
 *   OS_SNAPSHOT_BASE_PATH (default opensearch-snapshots), OS_SNAPSHOT_ROLE_ARN (required for `register`)
 *   OS_SNAPSHOT_CONFIRM_RING_SCOPE=1 (required, in addition to --lane, to touch a privileged lane -- see above)
 * CREDENTIALS: ambient AWS identity (awsCreds() -- an OIDC-assumed role or the ECS task role), no
 *   secret-store lookup for anything in this file.
 */
import { awsCreds } from "../kb-memory/aws-secret.mjs";
import { osFetch, osResolveDomainEndpoint } from "../doc-indexer/opensearch-client.mjs";
import { PRIVILEGED_SUBSTRINGS, PERSONAL_LEGAL_SUBSTRINGS, FINANCE_COMPANY_LEGAL_SUBSTRINGS } from "./s3-mirror.mjs";

const DOMAIN = process.env.OS_DOMAIN_NAME || "otchealth-brain";
const REGION = process.env.OS_REGION || process.env.AWS_REGION || "us-east-1";
const REPO_DEFAULT = process.env.OS_SNAPSHOT_REPO || "otchealth-brain-s3";
const BUCKET_DEFAULT = process.env.OS_SNAPSHOT_BUCKET || "otchealth-brain-dr-55c84f6b";
const BASE_PATH_DEFAULT = process.env.OS_SNAPSHOT_BASE_PATH || "opensearch-snapshots";
const SYSTEM_INDEX_EXCLUDES = [".opendistro*", ".opensearch*", ".kibana*", ".plugins*"];

// ---------- pure: non-privileged index pattern, dynamically derived from s3-mirror.mjs's own ring
// substrings so the two ring boundaries (S3 blob mirror, OpenSearch snapshot) can never drift apart.
// Exported for tests/os-snapshot-index-pattern.test.mjs -- no network, no OpenSearch call. ----------
export function buildNonPrivilegedIndexPattern() {
  const excludes = [...SYSTEM_INDEX_EXCLUDES, ...PRIVILEGED_SUBSTRINGS.map((s) => `*${s}*`)];
  return ["*", ...excludes.map((e) => `-${e}`)].join(",");
}

/** Pure: classify a LIVE index name into exactly one lane, reusing s3-mirror.mjs's own substring
 *  lists (never a second, independently-maintained copy of the ring boundary). Mirrors
 *  s3-mirror.mjs's classifyLane() priority order: personal-legal wins over finance-company-legal,
 *  which wins over non-privileged. */
export function classifyIndexLane(indexName) {
  const lower = indexName.toLowerCase();
  if (SYSTEM_INDEX_EXCLUDES.some((p) => lower.startsWith(p.replace("*", "")))) return "system";
  if (PERSONAL_LEGAL_SUBSTRINGS.some((s) => lower.includes(s))) return "personal-legal";
  if (FINANCE_COMPANY_LEGAL_SUBSTRINGS.some((s) => lower.includes(s))) return "finance-company-legal";
  return "non-privileged";
}

const LANE_BUCKETS = {
  "personal-legal": { envBucket: "OS_SNAPSHOT_PERSONAL_LEGAL_BUCKET", repoSuffix: "-personal-legal" },
  "finance-legal": { envBucket: "OS_SNAPSHOT_FINANCE_LEGAL_BUCKET", repoSuffix: "-finance-legal" },
};

/** The refusal every privileged-lane action goes through. Deliberately NOT satisfiable by any flag
 *  combination this script itself can validate -- it requires a human to have ALREADY confirmed, out
 *  of band, that the target bucket's IAM role/bucket policy does not widen who can read
 *  attorney-privileged or MNPI content. See this file's header for the full reasoning; see the
 *  ground-truth note this was built against: "DR buckets otchealth-finance-legal-dr +
 *  otchealth-legal-personal-dr are ring-segregated ... nothing in your code may widen read access to
 *  them or route their content anywhere new." Registering a NEW snapshot role with write access to
 *  either bucket, sight unseen, is exactly that widening risk. */
function requirePrivilegedLaneConfirmation(lane) {
  if (process.env.OS_SNAPSHOT_CONFIRM_RING_SCOPE === "1") return;
  console.error(
    `[os-snapshot] REFUSING to ${lane ? `touch the "${lane}" lane` : "proceed"}: OpenSearch snapshot DR for the ` +
    "privileged rooms (legal-personal*, finance-cfo-*) has NOT been armed. This is a deliberate, disarmed " +
    "scaffold, not an oversight -- see this file's header. Arming it means creating an IAM role the DOMAIN " +
    "assumes to write into an ALREADY-ring-scoped bucket (otchealth-legal-personal-dr / " +
    "otchealth-finance-legal-dr), and this script has no way to independently verify that role does not " +
    "widen who can read that bucket's content. Before setting OS_SNAPSHOT_CONFIRM_RING_SCOPE=1: confirm with " +
    "Matt/CTO that the target bucket's existing IAM policy has been reviewed and that the new snapshot role " +
    "is scoped to write-only, matching the s3-mirror.mjs double-opt-in convention for the identical boundary."
  );
  process.exit(1);
}

async function requireCreds() {
  const c = await awsCreds();
  if (!c) throw new Error("no AWS credentials resolvable (ECS task role, or AWS_ACCESS_KEY_ID/SECRET_ACCESS_KEY, or OTC_AWS_*) -- cannot sign an OpenSearch request.");
  return { accessKeyId: c.ak, secretAccessKey: c.sk, sessionToken: c.st || undefined, region: REGION };
}

async function domainCfg() {
  const creds = await requireCreds();
  const host = await osResolveDomainEndpoint(creds, DOMAIN);
  return { ...creds, host };
}

async function osJsonCall(cfg, method, path, bodyObj) {
  const r = await osFetch(cfg, { method, path, body: bodyObj ? JSON.stringify(bodyObj) : undefined });
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* leave null */ }
  return { status: r.status, ok: r.ok, json, text };
}

/** Data-only (no printing) so internal callers (cmdRestoreDrill) can reuse it without polluting
 *  stdout with a second, redundant listing every time they need the index set. */
async function fetchIndexRows() {
  const cfg = await domainCfg();
  const r = await osJsonCall(cfg, "GET", "/_cat/indices?format=json");
  if (!r.ok) throw new Error(`_cat/indices failed: HTTP ${r.status} ${r.text.slice(0, 300)}`);
  return (r.json || []).map((row) => ({ index: row.index, docs: row["docs.count"], lane: classifyIndexLane(row.index) }));
}

async function cmdListIndices(argv) {
  const rows = await fetchIndexRows();
  if (argv.includes("--json")) { console.log(JSON.stringify(rows, null, 2)); return rows; }
  const byLane = {};
  for (const row of rows) (byLane[row.lane] ||= []).push(row.index);
  for (const [lane, names] of Object.entries(byLane)) {
    console.log(`${lane} (${names.length}): ${names.join(", ")}`);
  }
  return rows;
}

function optVal(argv, flag, def) {
  const i = argv.indexOf(flag);
  return i !== -1 && argv[i + 1] !== undefined ? argv[i + 1] : def;
}

async function cmdRegister(argv) {
  const lane = optVal(argv, "--lane", null);
  if (lane) requirePrivilegedLaneConfirmation(lane);
  const repo = optVal(argv, "--repo", lane ? `${REPO_DEFAULT}${LANE_BUCKETS[lane]?.repoSuffix || `-${lane}`}` : REPO_DEFAULT);
  const bucket = lane ? (process.env[LANE_BUCKETS[lane]?.envBucket] || optVal(argv, "--bucket", null)) : (optVal(argv, "--bucket", BUCKET_DEFAULT));
  const roleArn = optVal(argv, "--role-arn", process.env.OS_SNAPSHOT_ROLE_ARN);
  if (!bucket) throw new Error(lane ? `no bucket configured for lane "${lane}" (set ${LANE_BUCKETS[lane]?.envBucket} or pass --bucket)` : "no bucket resolved");
  if (!roleArn) throw new Error("--role-arn (or OS_SNAPSHOT_ROLE_ARN) is required -- this is the IAM role the DOMAIN assumes to write to S3, created out of band (see the provisioning doc); this script never creates IAM resources itself.");

  console.log(`[os-snapshot] registering repo "${repo}" -> s3://${bucket}/${BASE_PATH_DEFAULT} (role ${roleArn})...`);
  const cfg = await domainCfg();
  const r = await osJsonCall(cfg, "PUT", `/_snapshot/${encodeURIComponent(repo)}`, {
    type: "s3",
    settings: { bucket, base_path: BASE_PATH_DEFAULT, region: REGION, role_arn: roleArn, server_side_encryption: true },
  });
  if (!r.ok) {
    throw new Error(
      `repo registration failed: HTTP ${r.status} ${r.text.slice(0, 500)}\n` +
      "If this is a 403: check (a) the signing identity has es:ESHttpPut on this domain AND iam:PassRole on " +
      "the role above, and (b) if the domain has fine-grained access control enabled, that this identity is " +
      "ALSO mapped to the manage_snapshots security-plugin role (see this file's header)."
    );
  }
  console.log(`[os-snapshot] repo "${repo}" registered.`);
}

async function cmdCreatePolicy(argv) {
  const lane = optVal(argv, "--lane", null);
  if (lane) requirePrivilegedLaneConfirmation(lane);
  const repo = optVal(argv, "--repo", lane ? `${REPO_DEFAULT}${LANE_BUCKETS[lane]?.repoSuffix || `-${lane}`}` : REPO_DEFAULT);
  const policyName = optVal(argv, "--policy-name", lane ? `otchealth-brain-nightly-${lane}` : "otchealth-brain-nightly");
  // Non-privileged lane: a dynamically-derived exclude pattern (never a static list that can go
  // stale relative to s3-mirror.mjs's own ring boundary). A privileged lane (scaffold only, gated
  // above) would need its OWN explicit include list of just that lane's indices -- deliberately not
  // built out here; arming a privileged lane is a decision point, not a code gap.
  const indicesPattern = lane ? null : buildNonPrivilegedIndexPattern();
  if (lane) throw new Error(`create-policy for lane "${lane}" is scaffold-only and intentionally unimplemented -- see requirePrivilegedLaneConfirmation()'s message for why. The non-privileged lane (no --lane) is fully wired.`);

  const cfg = await domainCfg();
  console.log(`[os-snapshot] creating/updating SM policy "${policyName}" on repo "${repo}" (indices: ${indicesPattern})...`);
  const r = await osJsonCall(cfg, "POST", `/_plugins/_sm/policies/${encodeURIComponent(policyName)}`, {
    description: "nightly DR snapshot to S3 (non-privileged lane)",
    creation: { schedule: { cron: { expression: "0 7 * * *", timezone: "UTC" } } },
    deletion: { schedule: { cron: { expression: "30 8 * * *", timezone: "UTC" } }, condition: { max_age: "14d", max_count: 21, min_count: 7 } },
    snapshot_config: { repository: repo, ignore_unavailable: true, include_global_state: false, indices: indicesPattern },
  });
  if (!r.ok) {
    throw new Error(
      `SM policy creation failed: HTTP ${r.status} ${r.text.slice(0, 500)}\n` +
      "If this endpoint 404s, the Snapshot Management plugin may not be available on this domain's engine " +
      "version -- fall back to a scheduled `node os-snapshot.mjs snapshot-now` call from a workflow cron instead."
    );
  }
  console.log(`[os-snapshot] SM policy "${policyName}" created/updated.`);
}

/** Pure: pick the newest snapshot with status SUCCESS from a _cat/snapshots?format=json response --
 *  NEVER the newest row unconditionally (an IN_PROGRESS or FAILED newest snapshot on a big-delta
 *  night must not be reported as "the current recovery point", and must not false-page a caller that
 *  only checks "is there a snapshot newer than 26h" without checking its status). Exported for
 *  tests/os-snapshot-newest-success.test.mjs. */
export function newestSuccessfulSnapshot(rows) {
  const ok = (rows || []).filter((r) => r.status === "SUCCESS" && r.end_epoch);
  if (!ok.length) return null;
  return ok.reduce((a, b) => (Number(b.end_epoch) > Number(a.end_epoch) ? b : a));
}

/** Data-only (no printing) so internal callers (cmdRestoreDrill, and skills/aws-dr-canary's own
 *  shell-out to `status --json`) get a clean, single JSON object on stdout without this function's
 *  own CLI formatting getting mixed in when called as a plain function instead of via the CLI. */
async function fetchSnapshotStatus(repo) {
  const cfg = await domainCfg();
  const repoInfo = await osJsonCall(cfg, "GET", `/_snapshot/${encodeURIComponent(repo)}`);
  const registered = repoInfo.ok;
  const snaps = await osJsonCall(cfg, "GET", `/_cat/snapshots/${encodeURIComponent(repo)}?format=json`);
  const rows = snaps.ok ? snaps.json || [] : [];
  const newest = newestSuccessfulSnapshot(rows);
  return { repo, registered, snapshotCount: rows.length, newestSuccessful: newest ? { id: newest.id, endEpoch: Number(newest.end_epoch), ageHours: (Date.now() / 1000 - Number(newest.end_epoch)) / 3600 } : null };
}

async function cmdStatus(argv) {
  const repo = optVal(argv, "--repo", REPO_DEFAULT);
  const out = await fetchSnapshotStatus(repo);
  if (argv.includes("--json")) console.log(JSON.stringify(out, null, 2));
  else console.log(`repo ${repo}: registered=${out.registered} snapshots=${out.snapshotCount} newestSuccessful=${out.newestSuccessful ? `${out.newestSuccessful.id} (${out.newestSuccessful.ageHours.toFixed(1)}h ago)` : "NONE"}`);
  return out;
}

async function cmdRestoreDrill(argv) {
  const repo = optVal(argv, "--repo", REPO_DEFAULT);
  const cfg = await domainCfg();
  let indexName = optVal(argv, "--index", null);
  if (!indexName) {
    const rows = await fetchIndexRows();
    const nonPriv = rows.filter((r) => r.lane === "non-privileged").sort((a, b) => Number(a.docs || 0) - Number(b.docs || 0));
    if (!nonPriv.length) throw new Error("no non-privileged index found to drill against");
    indexName = nonPriv[0].index;
  }
  const status = await fetchSnapshotStatus(repo);
  if (!status.newestSuccessful) throw new Error(`no SUCCESSFUL snapshot in repo "${repo}" to drill against`);
  const drillIndex = `drill-${indexName}`;
  console.log(`[os-snapshot] restoring "${indexName}" from snapshot "${status.newestSuccessful.id}" as "${drillIndex}"...`);
  const restore = await osJsonCall(cfg, "POST", `/_snapshot/${encodeURIComponent(repo)}/${encodeURIComponent(status.newestSuccessful.id)}/_restore`, {
    indices: indexName, rename_pattern: "(.+)", rename_replacement: "drill-$1", include_global_state: false,
  });
  if (!restore.ok) throw new Error(`restore call failed: HTTP ${restore.status} ${restore.text.slice(0, 300)}`);

  // Poll recovery (bounded, 2s * 30 = 60s budget -- a small single index restores fast).
  let recovered = false;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const health = await osJsonCall(cfg, "GET", `/_cluster/health/${encodeURIComponent(drillIndex)}`);
    if (health.ok && (health.json?.status === "green" || health.json?.status === "yellow")) { recovered = true; break; }
  }
  if (!recovered) throw new Error(`drill index "${drillIndex}" did not reach a healthy status within 60s of the restore call`);

  const [drillCount, liveCount] = await Promise.all([
    osJsonCall(cfg, "POST", `/${encodeURIComponent(drillIndex)}/_count`, {}),
    osJsonCall(cfg, "POST", `/${encodeURIComponent(indexName)}/_count`, {}),
  ]);
  const drillN = drillCount.json?.count ?? -1;
  const liveN = liveCount.json?.count ?? -1;
  // Cleanup FIRST, verify SECOND -- a failed assertion below must not leave a leftover drill index.
  await osJsonCall(cfg, "DELETE", `/${encodeURIComponent(drillIndex)}`);
  console.log(`[os-snapshot] drill: ${drillIndex}=${drillN} docs, live ${indexName}=${liveN} docs (snapshot is up to 24h older; tolerance >= 95%).`);
  if (liveN <= 0) throw new Error(`live index "${indexName}" reports ${liveN} docs -- cannot compute a meaningful tolerance`);
  if (drillN < liveN * 0.95) {
    throw new Error(`restore-drill FAILED: restored ${drillN} docs vs live ${liveN} (${((drillN / liveN) * 100).toFixed(1)}%, below the 95% tolerance)`);
  }
  console.log("[os-snapshot] restore-drill PASSED.");
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "list-indices") return void await cmdListIndices(rest);
  if (cmd === "register") return void await cmdRegister(rest);
  if (cmd === "create-policy") return void await cmdCreatePolicy(rest);
  if (cmd === "status") return void await cmdStatus(rest);
  if (cmd === "restore-drill") return void await cmdRestoreDrill(rest);
  console.error("usage: os-snapshot.mjs <list-indices|register|create-policy|status|restore-drill> [flags]");
  process.exit(2);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(`[os-snapshot] FATAL: ${String(e && e.message || e)}`); process.exit(1); });
}
