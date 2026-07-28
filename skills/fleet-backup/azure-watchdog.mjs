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
 *      setup/page-on-failure.mjs, which tries an Azure-hosted email path AND falls back to a PostHog
 *      capture event — but that PostHog fallback is ONLY genuinely independent of Azure when
 *      POSTHOG_FLEET_INGEST_KEY is supplied as a GitHub Actions secret (2026-07-28 review finding:
 *      page-on-failure.mjs's PostHog path originally resolved its key via Key Vault too, so a real
 *      Key Vault outage would have made BOTH paging channels fail simultaneously, defeating the
 *      "the page does not share fate with the outage" claim — fixed by adding an env-var override
 *      that only this workflow's scheduled run actually sets; every other caller of page-on-failure.mjs
 *      is unaffected). If page() itself throws (both channels failed), this script does NOT record the
 *      episode as declared/recovered — see the "page() BEFORE mutating state" comments at each call
 *      site — so the next scheduled run retries the notification instead of silently giving up on it.
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
import { vaultToken, kvSecret } from "../kb-memory/azure-secret.mjs";
import { s3Put, s3Get, s3Head, sha256Hex } from "./s3-client.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const STATE_KEY = "secrets-dr/watchdog-state.json";
const MARKER_KEY_PREFIX = "secrets-dr/FAILOVER-DECLARED";
const THRESHOLD = Number(process.env.WATCHDOG_THRESHOLD || 3);
const GATEWAY_BASE_URL = process.env.GATEWAY_BASE_URL || "https://mcp.otchealth.app";

// OFF-AZURE FIRST (2026-07-28 review finding — this was the load-bearing bug): the watchdog's own
// credentials for reading/writing its S3 state must NOT depend on Key Vault, or the watchdog cannot
// function during the exact scenario it exists to detect (Key Vault AND the gateway both down) — it
// would return null here, exit before recording anything, declaring an episode, or paging, and the
// whole "self-trigger" premise silently does nothing. GitHub Actions secrets (WATCHDOG_AWS_*) are
// checked FIRST; Key Vault (kvSecret) is a fallback used only for local/manual runs where Azure is
// known to be healthy — never the path the scheduled outage-detection run actually relies on.
async function drCreds() {
  const envAkid = process.env.WATCHDOG_AWS_ACCESS_KEY_ID;
  const envAsecret = process.env.WATCHDOG_AWS_SECRET_ACCESS_KEY;
  const envBucket = process.env.WATCHDOG_AWS_S3_BUCKET;
  const envRegion = process.env.WATCHDOG_AWS_REGION;
  if (envAkid && envAsecret && envBucket && envRegion) {
    return { accessKeyId: envAkid, secretAccessKey: envAsecret, bucket: envBucket, region: envRegion };
  }
  const akid = await kvSecret("aws-dr-access-key-id");
  const asecret = await kvSecret("aws-dr-secret-access-key");
  const bucket = await kvSecret("aws-dr-s3-bucket");
  const region = await kvSecret("aws-dr-region");
  if (!akid || !asecret || !bucket || !region) return null;
  return { accessKeyId: akid, secretAccessKey: asecret, bucket, region };
}

// Bounded (2026-07-28 review, final round): vaultToken()/kvSecret() (shared skills/kb-memory/
// azure-secret.mjs) make their own unbounded internal fetches. Left unguarded here, main()'s
// `Promise.all([checkKeyVault(), checkGateway()])` waits for BOTH to settle before EVER reaching
// loadState/decideNextStep/saveState/page -- so during the exact Key Vault outage this watchdog exists
// to detect, a hung checkKeyVault() could consume the entire outer `timeout 420` budget and get the
// whole process SIGKILLed before the state machine runs even once. Every invocation would then look
// like a watchdog self-failure instead of a detected outage: the consecutive-failure counter never
// increments, the episode never gets declared, the page never fires -- the opposite of this script's
// purpose. Race the check against a local timeout so a hang resolves to `false` (correctly reported as
// "Key Vault unreachable," which is the right answer anyway) and main() proceeds promptly; a no-op
// .catch() on the original promise prevents it surfacing as an unhandled rejection if it settles later
// in the background after main() has already moved on (same pattern as page-on-failure.mjs).
async function checkKeyVault() {
  const check = (async () => {
    const token = await vaultToken();
    if (!token) return false;
    const v = await kvSecret("aws-dr-region"); // cheap, already-required read
    return Boolean(v);
  })();
  check.catch(() => {});
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(false), 8000); });
  try {
    return await Promise.race([check, timeout]);
  } catch { return false; }
  finally { clearTimeout(timer); }
}

// Validates the SAME documented /health contract setup/gateway-canary.mjs already checks (2026-07-28
// review finding): body.status === "ok" AND body.tool_count is a number >= 800 (deploy.yml's own
// MIN_TOOLS floor), not just "the HTTP status was 2xx." A bare r.ok check would count a maintenance
// page, a misconfigured reverse proxy, or a degraded-but-200-responding gateway as fully healthy,
// which could reset the consecutive-failure counter and suppress a real declaration.
async function checkGateway() {
  // 2026-07-28 review finding: the abort timer was cleared as soon as fetch() returned (headers
  // received), BEFORE r.json() was awaited -- so a response that sent headers promptly but then
  // stalled mid-body left the json() read completely unprotected, able to hang indefinitely. Keep the
  // timer alive through the whole fetch+parse and only clear it in `finally`, so the same 8s bound
  // covers both.
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(`${GATEWAY_BASE_URL}/health`, { signal: ctrl.signal });
    if (!r.ok) return false;
    const body = await r.json().catch(() => null);
    if (!body) return false;
    if (body.status !== "ok") return false;
    if (typeof body.tool_count !== "number" || body.tool_count < 800) return false;
    return true;
  } catch { return false; }
  finally { clearTimeout(t); }
}

// 2026-07-28 review finding: a real S3 read error (network blip, transient auth failure, a corrupt
// object) is NOT the same as "no prior state." The earlier version collapsed both to an empty state,
// which during an actual outage could silently ERASE an already-accumulated consecutive-failure count
// on a transient hiccup — delaying or preventing the very failover declaration this script exists to
// make. Only a clean 404 (s3Get returns null: genuinely never run before) initializes empty state;
// any other failure throws and the caller aborts this cycle WITHOUT calling saveState(), so whatever
// real state already exists in S3 is left untouched for the next run to read correctly.
async function loadState(creds) {
  const empty = { consecutiveFailures: 0, lastCheckAt: null, lastSuccessAt: null, episodes: [] };
  let buf;
  try {
    buf = await s3Get(creds, STATE_KEY);
  } catch (e) {
    throw new Error(`could not read watchdog state from S3 (not a clean 404 — a real error, aborting rather than risk erasing accumulated failure evidence): ${String(e && e.message || e)}`);
  }
  if (buf == null) return empty; // clean 404: genuinely first run
  try {
    return { ...empty, ...JSON.parse(buf.toString("utf8")) };
  } catch (e) {
    throw new Error(`watchdog state object is present but not valid JSON — refusing to treat corrupt state as empty: ${String(e && e.message || e)}`);
  }
}

async function saveState(creds, state) {
  const buf = Buffer.from(JSON.stringify(state, null, 2), "utf8");
  await s3Put(creds, STATE_KEY, buf, sha256Hex(buf), {});
}

// ---------- the actual state machine, pure and exported so it is unit-testable without mocking S3,
// exec, or the network (2026-07-28 review finding: none of threshold-crossing, recovery, or the
// no-open-episode-guard had a deterministic test). Given (state, healthy, now, threshold), decides
// what main() should DO next without performing any I/O itself — main() executes the side effects
// (paging, emergency backup, marker write) and only commits `next` via saveState() once those side
// effects it depends on have succeeded, per the page-before-mutate ordering documented at each call
// site in main(). This function's OWN contract: never mutates its `state` argument (returns a fresh
// `next` object), so a caller can freely inspect `state` after calling this without surprises.
export function decideNextStep(state, healthy, now, threshold) {
  const openEpisode = state.episodes.find((e) => !e.recoveredAt) || null;
  const next = { ...state, lastCheckAt: now, episodes: state.episodes.map((e) => ({ ...e })) };

  if (healthy) {
    next.consecutiveFailures = 0;
    next.lastSuccessAt = now;
    if (openEpisode) {
      const nextOpenEpisode = next.episodes.find((e) => !e.recoveredAt);
      return { next, action: "recover", episode: nextOpenEpisode };
    }
    return { next, action: "noop" };
  }

  next.consecutiveFailures = state.consecutiveFailures + 1;
  if (next.consecutiveFailures >= threshold && !openEpisode) {
    return { next, action: "declare", episode: { declaredAt: now, recoveredAt: null } };
  }
  return { next, action: "increment" };
}

// Throws on failure (2026-07-28 review finding) rather than swallowing it. The earlier version logged
// and continued, which let the caller commit an "episode declared" (or "episode recovered") state to
// S3 even though Matt was never actually notified — the NEXT run would then see an already-open (or
// already-closed) episode and never retry the page, permanently suppressing the one notification the
// whole system exists to deliver. Callers must NOT persist state past a failed page() call.
// severity="info" (2026-07-28 review finding): page-on-failure.mjs hardcodes "[RED] ... failed" /
// canary_red for its default severity, which made the "reachability RESTORED" recovery notice get
// delivered and indexed as a fresh red alarm — exactly backwards for good news. The declare (real
// outage) call keeps the default "red" severity; only the recover call passes "info".
function page(workflowLabel, severity = "red") {
  const args = [join(REPO_ROOT, "setup", "page-on-failure.mjs"), "--workflow", workflowLabel];
  if (severity === "info") args.push("--severity", "info", "--message", workflowLabel);
  // timeout (2026-07-28 review finding): this synchronous child-process call had no bound, so a hung
  // socket inside page-on-failure.mjs (which itself relies on an EXTERNAL OS timeout, not true
  // in-process cancellation -- see that file's own header) could block THIS process's event loop until
  // the outer workflow-level `timeout 420` on the whole azure-watchdog.mjs invocation kills everything,
  // including saveState() below, which never gets to run -- the exact "page succeeded but state was
  // never saved, so the next run re-declares and re-pages" bug the surrounding comments already guard
  // against for a THROWING page(), just via a different route (a hang instead of a rejection). 60s
  // matches the same bound used for the standalone "Page on the watchdog's OWN failure" workflow step.
  execFileSync("node", args, {
    stdio: "inherit",
    env: process.env,
    timeout: 60000,
  });
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
    if (creds) {
      // Round-trip a real object rather than HEAD a synthetic never-existing key (2026-07-28 review
      // finding): the recommended least-privilege IAM policy for these creds (README.md's "Recommended
      // IAM policy") is deliberately s3:PutObject + s3:GetObject ONLY, with no s3:ListBucket. AWS's
      // actual behavior on a HEAD/GET for a missing key depends on that grant -- WITH ListBucket a
      // missing key 404s (s3Head returns null, no throw, s3Ok stays true); WITHOUT it the identical
      // request 403s instead (s3Head throws, the catch below sets s3Ok=false). So probing a guaranteed-
      // missing key made this selftest report "S3 unreachable" for perfectly valid, correctly-scoped
      // credentials that simply lack a permission they were never supposed to have. PUT-then-HEAD a
      // fixed (not timestamped) marker key instead: a genuine 200 on the read-back proves real
      // reachability with the actual granted permissions, with no dependence on 403-vs-404 semantics,
      // and reusing one fixed key (overwritten each run) avoids accumulating throwaway objects this
      // credential has no DeleteObject permission to clean up.
      try {
        const marker = "secrets-dr/.watchdog-selftest-marker";
        const buf = Buffer.from(`selftest ${new Date().toISOString()}`, "utf8");
        await s3Put(creds, marker, buf, sha256Hex(buf), {});
        const head = await s3Head(creds, marker);
        s3Ok = head !== null;
      } catch {
        s3Ok = false;
      }
    }
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
  const decision = decideNextStep(state, healthy, now, THRESHOLD);

  if (decision.action === "noop") {
    console.log("[azure-watchdog] healthy.");
  } else if (decision.action === "recover") {
    // page() BEFORE mutating the episode (2026-07-28 review finding): if the page throws, this whole
    // function throws too, main()'s top-level catch aborts BEFORE saveState() runs, and the episode
    // stays open in the last-saved state — so the NEXT run still sees it open and retries the
    // recovery notice, instead of silently marking it recovered with nobody ever told.
    page(`AZURE WATCHDOG: reachability RESTORED (was declared down at ${decision.episode.declaredAt})`, "info");
    decision.episode.recoveredAt = now;
    console.log(`[azure-watchdog] RECOVERED: Azure reachability restored (episode declared ${decision.episode.declaredAt}).`);
  } else if (decision.action === "increment") {
    console.log(`[azure-watchdog] unhealthy check ${decision.next.consecutiveFailures}/${THRESHOLD} (kvOk=${kvOk} gwOk=${gwOk}).`);
  } else if (decision.action === "declare") {
    console.error(`[azure-watchdog] DECLARING FAILOVER: ${THRESHOLD} consecutive unhealthy checks. Running emergency backup...`);
    const backupResults = await emergencyBackup();
    const markerKey = await writeMarker(creds, decision.episode, backupResults);
    console.error(`[azure-watchdog] marker written: s3://${creds.bucket}/${markerKey}`);
    // page() BEFORE pushing the episode into state, same reasoning as the recovery branch above: a
    // failed page must not be recorded as "declared" (that would permanently suppress retry).
    page(`AZURE WATCHDOG: sustained outage DECLARED at ${now} (${THRESHOLD} consecutive checks). Emergency backup: ${JSON.stringify(backupResults)}`);
    decision.next.episodes.push(decision.episode);
  }

  await saveState(creds, decision.next);
}

// Only auto-run when executed directly (CLI), not when imported as a module (e.g. by
// tests/azure-watchdog-state.test.mjs importing decideNextStep) — importing this file must never have
// the side effect of kicking off a real check/status/selftest run.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(`[azure-watchdog] FATAL: ${String(e && e.message || e)}`); process.exit(1); });
}
