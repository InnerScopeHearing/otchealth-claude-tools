#!/usr/bin/env node
/**
 * azure-watchdog.mjs — the "wake up and Azure is off" self-trigger Matt asked for (2026-07-28).
 *
 * WHY THIS RUNS OUTSIDE AZURE: it has to be able to detect Azure's own death, so it cannot live on
 * anything Azure hosts. It runs from GitHub Actions (already off-Azure) on a tight schedule, and
 * persists its own state in AWS S3 (the same off-Azure store everything else in fleet-backup already
 * writes to) — NOT in Key Vault or Cosmos, which is exactly what might be unreachable when this state
 * matters most.
 *
 * WHAT IT DOES, each run:
 *   1. Checks two independent Azure signals: a Key Vault token mint + cheap secret read, and the
 *      gateway's own /health endpoint. "Healthy" = EITHER signal succeeding (a single dependency blip
 *      should not trigger anything — this is deliberately conservative against false positives).
 *   2. Reads/writes a small state file in S3 (`secrets-dr/watchdog-state.json`): a consecutive-failure
 *      counter and a list of failover "episodes" (declaredAt / recoveredAt).
 *   3. On THRESHOLD consecutive unhealthy runs (default 3, so with a 15-min schedule that's ~30-45
 *      minutes of confirmed downtime, not one bad request) with no currently-open episode: declares a
 *      new episode, best-effort triggers an EMERGENCY secrets + brain export/mirror (this may itself
 *      fail if Azure really is down — that is expected and logged, not a bug; it exists to catch the
 *      cases where Azure is *degraded* rather than *fully* gone, e.g. a billing-lapse grace window
 *      where compute still runs briefly), writes an unmissable marker object to S3, and pages Matt via
 *      setup/page-on-failure.mjs (which already tries an Azure-hosted email path AND falls back to a
 *      PostHog capture event that does NOT depend on Azure — so the page itself does not share fate
 *      with the outage it is reporting).
 *   4. On recovery (a healthy run with a currently-open episode): closes the episode and sends a
 *      matching "Azure reachability restored" notice, so Matt hears both ends, not just the alarm.
 *
 * HONEST SCOPE — WHAT THIS DOES NOT DO (2026-07-28, read before assuming more automation exists than
 * does): it does NOT stand up a live, queryable replacement service on AWS. The `cto-hyperagent` AWS
 * IAM credential this fleet holds is deliberately S3-PutObject/GetObject-ONLY (see README.md's
 * documented least-privilege policy) — it cannot create EC2/Fargate/App Runner/IAM resources, so there
 * is currently no permission to auto-provision compute even if the code existed. "Kick off directly to
 * AWS and come back running" therefore means TODAY: the data (brain rooms + every credential) is
 * pulled to a fresh, current snapshot in S3 the moment an outage is confirmed, and Matt is paged with
 * exactly where that snapshot is and how to use it (see runbooks/AZURE-LOSS-DR-PLAN.md). Turning that
 * into an actually-running AWS replacement needs either broader AWS permissions or a one-time guided
 * provisioning pass — flagged, not silently glossed over.
 *
 * USAGE:
 *   node azure-watchdog.mjs check          # the real check+react cycle (what the schedule runs)
 *   node azure-watchdog.mjs status         # print current S3 state, no writes, no checks
 *   node azure-watchdog.mjs selftest       # reachability diagnostics only, never mutates state
 */
import { execFileSync } from "node:child_process";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { vaultToken, kvSecret } from "../kb-memory/azure-secret.mjs";
import { s3Put, s3Get, s3Head, sha256Hex } from "./s3-client.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const STATE_KEY = "secrets-dr/watchdog-state.json";
const MARKER_KEY_PREFIX = "secrets-dr/FAILOVER-DECLARED";
const THRESHOLD = Number(process.env.WATCHDOG_THRESHOLD || 3);
const GATEWAY_BASE_URL = process.env.GATEWAY_BASE_URL || "https://mcp.otchealth.app";

async function drCreds() {
  const akid = await kvSecret("aws-dr-access-key-id");
  const asecret = await kvSecret("aws-dr-secret-access-key");
  const bucket = await kvSecret("aws-dr-s3-bucket");
  const region = await kvSecret("aws-dr-region");
  if (!akid || !asecret || !bucket || !region) return null;
  return { accessKeyId: akid, secretAccessKey: asecret, bucket, region };
}

async function checkKeyVault() {
  try {
    const token = await vaultToken();
    if (!token) return false;
    const v = await kvSecret("aws-dr-region"); // cheap, already-required read
    return Boolean(v);
  } catch { return false; }
}

async function checkGateway() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const r = await fetch(`${GATEWAY_BASE_URL}/health`, { signal: ctrl.signal });
    clearTimeout(t);
    return r.ok;
  } catch { return false; }
}

async function loadState(creds) {
  const empty = { consecutiveFailures: 0, lastCheckAt: null, lastSuccessAt: null, episodes: [] };
  if (!creds) return empty;
  try {
    const buf = await s3Get(creds, STATE_KEY);
    return { ...empty, ...JSON.parse(buf.toString("utf8")) };
  } catch {
    return empty; // no prior state (first run) or a transient read miss — start clean, never crash on this
  }
}

async function saveState(creds, state) {
  const buf = Buffer.from(JSON.stringify(state, null, 2), "utf8");
  await s3Put(creds, STATE_KEY, buf, sha256Hex(buf), {});
}

function page(workflowLabel) {
  try {
    execFileSync("node", [join(REPO_ROOT, "setup", "page-on-failure.mjs"), "--workflow", workflowLabel], {
      stdio: "inherit",
      env: process.env,
    });
  } catch (e) {
    console.error(`[azure-watchdog] page-on-failure itself failed: ${String(e && e.message || e)} — this is the worst case (the page about the outage could not be sent). Check oauth-lane-cto-* and posthog-fleet-ingest-key.`);
  }
}

async function emergencyBackup() {
  const results = { secretsExport: null, brainMirror: null };
  try {
    execFileSync("node", [join(HERE, "secrets-dr-export.mjs"), "run"], { stdio: "inherit", timeout: 120000 });
    results.secretsExport = "ok";
  } catch (e) {
    results.secretsExport = `failed: ${String(e && e.message || e).slice(0, 300)}`;
  }
  try {
    execFileSync("node", [join(HERE, "s3-mirror.mjs"), "run"], { stdio: "inherit", timeout: 120000, env: { ...process.env, BACKUP_STORAGE_ACCOUNT: process.env.BACKUP_STORAGE_ACCOUNT || "stotc55c84f6bef" } });
    results.brainMirror = "ok";
  } catch (e) {
    results.brainMirror = `failed: ${String(e && e.message || e).slice(0, 300)}`;
  }
  return results;
}

async function writeMarker(creds, episode, backupResults) {
  const body = [
    "AZURE WATCHDOG: an Azure outage was declared by azure-watchdog.mjs.",
    `Declared at: ${episode.declaredAt}`,
    "",
    "This means the watchdog observed sustained failure (both Key Vault and the gateway health check)",
    "across multiple consecutive checks and is not a single-request blip.",
    "",
    `Emergency backup attempt at declaration time: ${JSON.stringify(backupResults, null, 2)}`,
    "",
    "Next steps: read runbooks/AZURE-LOSS-DR-PLAN.md in otchealth-cto for the full incident checklist.",
    "The latest brain/memory + secrets DR copies are in this same S3 bucket under ledger-backup/ and secrets-dr/.",
  ].join("\n");
  const buf = Buffer.from(body, "utf8");
  const key = `${MARKER_KEY_PREFIX}-${episode.declaredAt.replace(/[:.]/g, "-")}.txt`;
  await s3Put(creds, key, buf, sha256Hex(buf), {});
  return key;
}

async function main() {
  const cmd = process.argv[2] || "check";

  if (cmd === "selftest") {
    const kv = await checkKeyVault();
    const gw = await checkGateway();
    const creds = await drCreds();
    let s3Ok = false;
    if (creds) { try { await s3Head(creds, `secrets-dr/.watchdog-selftest-${Date.now()}`); s3Ok = true; } catch { s3Ok = false; } }
    console.log(JSON.stringify({ keyVaultReachable: kv, gatewayReachable: gw, s3StateStoreReachable: s3Ok }, null, 2));
    return;
  }

  const creds = await drCreds();
  if (!creds) {
    console.error("[azure-watchdog] aws-dr-* creds unavailable — cannot read/write S3 state. Refusing to run (this watchdog's whole point is off-Azure state; running stateless would double-count/never-trigger).");
    process.exit(1);
  }

  if (cmd === "status") {
    console.log(JSON.stringify(await loadState(creds), null, 2));
    return;
  }

  if (cmd !== "check") { console.error(`unknown command "${cmd}"`); process.exit(2); }

  const [kvOk, gwOk] = await Promise.all([checkKeyVault(), checkGateway()]);
  const healthy = kvOk || gwOk;
  const now = new Date().toISOString();

  const state = await loadState(creds);
  state.lastCheckAt = now;
  const openEpisode = state.episodes.find((e) => !e.recoveredAt);

  if (healthy) {
    state.consecutiveFailures = 0;
    state.lastSuccessAt = now;
    if (openEpisode) {
      openEpisode.recoveredAt = now;
      console.log(`[azure-watchdog] RECOVERED: Azure reachability restored (episode declared ${openEpisode.declaredAt}).`);
      page(`AZURE WATCHDOG: reachability RESTORED (was declared down at ${openEpisode.declaredAt})`);
    } else {
      console.log("[azure-watchdog] healthy.");
    }
  } else {
    state.consecutiveFailures += 1;
    console.log(`[azure-watchdog] unhealthy check ${state.consecutiveFailures}/${THRESHOLD} (kvOk=${kvOk} gwOk=${gwOk}).`);
    if (state.consecutiveFailures >= THRESHOLD && !openEpisode) {
      const episode = { declaredAt: now, recoveredAt: null };
      console.error(`[azure-watchdog] DECLARING FAILOVER: ${THRESHOLD} consecutive unhealthy checks. Running emergency backup...`);
      const backupResults = await emergencyBackup();
      state.episodes.push(episode);
      const markerKey = await writeMarker(creds, episode, backupResults);
      console.error(`[azure-watchdog] marker written: s3://${creds.bucket}/${markerKey}`);
      page(`AZURE WATCHDOG: sustained outage DECLARED at ${now} (${THRESHOLD} consecutive checks). Emergency backup: ${JSON.stringify(backupResults)}`);
    }
  }

  await saveState(creds, state);
}

main().catch((e) => { console.error(`[azure-watchdog] FATAL: ${String(e && e.message || e)}`); process.exit(1); });
