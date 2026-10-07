#!/usr/bin/env node
// sentinel-watchdog.mjs -- WHO WATCHES THE WATCHER.
//
// nightly-fleet-sentinels.yml runs skills/nightly-schedule-canary/schedule-canary.mjs, the silence monitor: it pages
// when any registered job goes quiet. It cannot page for its OWN silence. If its cron stops firing (GitHub disables
// schedules after 60 days without repo activity, the workflow file is deleted or malformed, Actions are switched
// off, a cron typo) no run exists to go red, and the one monitor everyone trusts is dark with nobody told.
//
// This script is the independent second watcher. It asks the GitHub Actions API one question, with nothing but the
// job's own GITHUB_TOKEN (permission actions: read; no AWS role, no stored credential, no cross-repo read): "did
// nightly-fleet-sentinels.yml complete a run inside the last 26 hours?". If not, it prints a line the pager
// extracts and exits 1, and .github/workflows/sentinel-watchdog.yml opens or comments on the GitHub issue
// "[FLEET-ALERT] sentinel-watchdog" through setup/page-on-failure.mjs. In turn the silence monitor watches this
// workflow (setup/heartbeat-registry.json row "sentinel-watchdog"), so neither can go quiet unseen.
//
// DELIBERATELY INDEPENDENT: it imports nothing from schedule-canary.mjs or the rest of the repo (node builtins and
// fetch only). A bug that breaks the monitor must not also break its watchdog.
//
// WHAT COUNTS AS ALIVE. Any trigger (a manual dispatch proves the workflow can run, and masks a dead cron for at
// most one limit). A completed run with conclusion success or failure inside the limit: a red run means the
// monitor ran and found something, which is its job. A run still queued or in progress for no more than an hour
// (it is about to answer). NOT alive: cancelled, timed out, skipped, startup_failure and the like, because a
// monitor that cannot finish has produced no verdict.
//
// TIMING. GitHub starts scheduled runs hours late (observed 5-9h, gaps up to 28h between two runs of one daily
// cron). The monitor's cron is 05:20 UTC, so it normally runs between about 10:30 and 14:30 UTC. This watchdog's
// cron is 13:50 UTC, so it normally runs between about 19:00 and 23:10 UTC, when the monitor's run of the same
// day is 4 to 13 hours old. A whole missed day makes it 28 hours old or more, so the 26 hour limit pages on the
// first watchdog run after one missed monitor run and never on ordinary lateness.
//
// Usage: GITHUB_TOKEN=... node skills/nightly-schedule-canary/sentinel-watchdog.mjs   (exit 0 alive, 1 silent or unreadable)
import { fileURLToPath } from "node:url";

export const WATCHED_WORKFLOW = "nightly-fleet-sentinels.yml";
export const WATCHDOG_LIMIT_MIN = 26 * 60;
export const IN_FLIGHT_GRACE_MIN = 60;
const DEFAULT_REPO = "InnerScopeHearing/otchealth-claude-tools";
const ALIVE_CONCLUSIONS = new Set(["success", "failure"]);
const IN_FLIGHT = new Set(["queued", "in_progress", "waiting", "pending", "requested"]);

const fmt = (min) => (min < 60 ? `${min}m` : min < 2880 ? `${Math.round(min / 60)}h` : `${(min / 1440).toFixed(1)}d`);

/** PURE: minutes since the run last did something. A finished run counts from its completion (updated_at), a run
 *  still in flight from its start. null when the run carries no usable timestamp. */
export function runAgeMin(run, nowMs = Date.now()) {
  const stamps = run && run.status === "completed" ? [run.updated_at, run.run_started_at, run.created_at] : [run && run.run_started_at, run && run.created_at, run && run.updated_at];
  const t = Date.parse(stamps.find(Boolean) || "");
  return Number.isFinite(t) ? Math.max(0, Math.round((nowMs - t) / 60000)) : null;
}

function describe(r, age) {
  const outcome = r.status === "completed" ? r.conclusion || "completed" : r.status;
  // The run id, not its URL: the pager's redaction turns a github.com URL with capitals into "https://github.[redacted]".
  return `a ${r.event || "unknown"} run that is ${outcome}, ${fmt(age)} old${r.id ? ` (run ${r.id})` : ""}`;
}

/** PURE: the verdict over the workflow's recent runs (any event). */
export function evaluateWatchdog({ runs, nowMs = Date.now(), limitMin = WATCHDOG_LIMIT_MIN, inFlightGraceMin = IN_FLIGHT_GRACE_MIN } = {}) {
  const rows = (runs || [])
    .filter((r) => r && typeof r === "object")
    .map((r) => ({ r, age: runAgeMin(r, nowMs) }))
    .filter((x) => x.age != null)
    .sort((a, b) => a.age - b.age);
  const proof = rows.find(({ r, age }) => (r.status === "completed" && ALIVE_CONCLUSIONS.has(r.conclusion) && age <= limitMin) || (IN_FLIGHT.has(r.status) && age <= inFlightGraceMin));
  const newest = rows[0] || null;
  if (proof) {
    return { ok: true, state: "ALIVE", limitMin, detail: `alive: ${describe(proof.r, proof.age)}, limit ${fmt(limitMin)}`, proofAgeMin: proof.age };
  }
  const notProof = newest && newest.r.status === "completed" && !ALIVE_CONCLUSIONS.has(newest.r.conclusion) ? " A cancelled, timed out or skipped run is not proof the monitor can finish." : "";
  return {
    ok: false,
    state: "SILENT",
    limitMin,
    detail: `no run of ${WATCHED_WORKFLOW} completed inside the last ${fmt(limitMin)}; ${newest ? `the newest run on record is ${describe(newest.r, newest.age)}` : "there is no run on record"}.${notProof}`,
    proofAgeMin: null,
  };
}

/** PURE: the lines setup/alert-issue.mjs extracts into the pager issue ("[STALE   ] ..." / "[ERROR   ] ..."). */
export function renderWatchdog(verdict, readError = null) {
  if (readError) {
    return [`[ERROR   ] sentinel-watchdog: cannot read the run history of ${WATCHED_WORKFLOW} (${readError}), so whether the silence monitor runs is unknown`];
  }
  if (!verdict || verdict.ok) return [];
  return [`[STALE   ] nightly-fleet-sentinels: SILENT -- ${verdict.detail} The silence monitor is not running: check that its cron still fires (Actions enabled, no 60 day inactivity disable, the workflow file intact on the default branch) and dispatch it once by hand.`];
}

/** The workflow's last 20 runs of every event. fetchImpl and sleep are injectable. Retries a network error or a 5xx
 *  once; a 401/403/404 is a configuration problem a retry cannot fix. Errors never include the token. */
export async function fetchSentinelRuns({ repo, token, fetchImpl = globalThis.fetch, timeoutMs = 20_000, attempts = 2, backoffMs = 3000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(String(repo || ""))) return { ok: false, error: "GITHUB_REPOSITORY is not set to owner/repo" };
  if (!token) return { ok: false, error: "GITHUB_TOKEN is not in this step's environment" };
  const url = `https://api.github.com/repos/${repo}/actions/workflows/${WATCHED_WORKFLOW}/runs?per_page=20`;
  let error = "";
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(backoffMs);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "otchealth-sentinel-watchdog" },
        signal: ctl.signal,
      });
      if (res.ok) {
        const body = await res.json();
        return { ok: true, runs: Array.isArray(body && body.workflow_runs) ? body.workflow_runs : [] };
      }
      error = `GitHub API HTTP ${res.status}`;
      if ([401, 403, 404].includes(res.status)) return { ok: false, error: `${error}; the job needs the permission actions: read and the workflow file must exist` };
    } catch (e) {
      error = e && e.name === "AbortError" ? "GitHub API call timed out" : `GitHub API call failed: ${String((e && e.message) || e).split(token).join("***").slice(0, 160)}`;
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, error };
}

async function main() {
  const repo = process.env.GITHUB_REPOSITORY || DEFAULT_REPO;
  const fetched = await fetchSentinelRuns({ repo, token: process.env.GITHUB_TOKEN });
  if (!fetched.ok) {
    for (const l of renderWatchdog(null, fetched.error)) console.log(l);
    console.log("\n[sentinel-watchdog] FAILED: a watchdog that cannot read the run history is a dark sensor");
    process.exit(1);
  }
  const verdict = evaluateWatchdog({ runs: fetched.runs });
  console.log(`[sentinel-watchdog] ${WATCHED_WORKFLOW}: ${verdict.detail}`);
  if (verdict.ok) {
    console.log("[sentinel-watchdog] OK: the silence monitor is running");
    process.exit(0);
  }
  for (const l of renderWatchdog(verdict)) console.log(l);
  console.log("\n[sentinel-watchdog] SILENCE = FAILURE: the silence monitor itself is not running");
  process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(`::error::[sentinel-watchdog] unexpected failure: ${String((e && e.message) || e).slice(0, 300)}`);
    process.exit(1);
  });
}
