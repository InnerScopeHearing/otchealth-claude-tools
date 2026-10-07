#!/usr/bin/env node
// schedule-canary.mjs -- THE SILENCE MONITOR: the one scheduled checker whose silence-detection pages.
//
// WHY: a monitor that only shows a red run when it runs is blind to the jobs that stopped running. The
// July 2026 family of silent monitors (registered, trusted, never scheduled) is exactly that. This script
// reads setup/heartbeat-registry.json and, for every registered job, judges the AGE of its last proof of
// life against its cadence (max_age_min, else 3x interval_min with a 6h floor), NOT the last reported
// status. It exits non-zero under --strict (wired to the GitHub-issue pager in
// .github/workflows/nightly-fleet-sentinels.yml) when a registered job is STALE, has NO-DATA, is FAILING,
// is UNWITNESSED, or its beat store cannot be read (UNREADABLE). PENDING, a job inside the grace window of
// its first armed days, is the only non-LIVE state that does not page.
//
// TWO WITNESSES per job, and the beat decides first:
//   1. BEAT: the heartbeat store, read via `setup/heartbeat.mjs check --json` (the only _HEARTBEAT reader).
//      A job writes it with `setup/heartbeat.mjs beat <job> ok`, which needs s3:PutObject on its own object.
//   2. GITHUB: for rows carrying "gh_workflow", the Actions API's last SCHEDULED runs of that workflow (did
//      the cron fire, how did the last run conclude). It needs no IAM and NO new token: the job's own
//      GITHUB_TOKEN reads its own repo, and for another repo the same token is tried and then an anonymous
//      read (a public repo answers both). Only a private repo needs the OPTIONAL secret
//      FLEET_WATCH_GH_TOKEN; without it the row reports UNWITNESSED, which names the fix and pages. A row
//      the monitor cannot see is never silent.
// Unregistered beat files that are stale are attention items (heartbeat.mjs alone reads them as LIVE), and a
// "_retired_*" job that is beating again is flagged too. If the heartbeat store cannot be read the result is
// UNREADABLE with the exact missing permission, never a silent pass.
//
// WHO WATCHES THE WATCHER: this script cannot report its own silence. skills/nightly-schedule-canary/
// sentinel-watchdog.mjs (workflow sentinel-watchdog.yml) pages when nightly-fleet-sentinels.yml has not
// completed a run for 26h, and the watchdog is itself a registry row judged here.
//
// Usage: node skills/nightly-schedule-canary/schedule-canary.mjs [--json] [--strict]
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const REGISTRY_PATH = join(REPO_ROOT, "setup", "heartbeat-registry.json");
const HEARTBEAT_CLI = join(REPO_ROOT, "setup", "heartbeat.mjs");

export const BEAT_BUCKET = "otchealth-brain-dr-55c84f6b";
export const BEAT_KEY_PREFIX = "otchealthcommons/company-journal/";
export const MIN_STALE_FLOOR_MIN = 360;
export const UNREGISTERED_MAX_AGE_MIN = 4320;
const FAILED_CONCLUSIONS = new Set(["failure", "timed_out"]);
// Every state that makes the run exit 1 under --strict. LIVE, PENDING and UNREGISTERED (a recent beat with no
// registry row yet) are the only states that do not page.
export const ANOMALY_STATES = new Set(["STALE", "NO-DATA", "UNWITNESSED", "FAILING", "UNREADABLE", "UNREGISTERED-STALE", "RETIRED-BEATING"]);
const TAG = { FAILING: "ERROR", UNWITNESSED: "ERROR", UNREADABLE: "ERROR" }; // everything else is a STALE-class finding
const STATE_ORDER = ["LIVE", "PENDING", "STALE", "NO-DATA", "FAILING", "UNWITNESSED", "UNREADABLE", "UNREGISTERED-STALE", "RETIRED-BEATING", "UNREGISTERED"];

const argv = process.argv.slice(2);
const STRICT = argv.includes("--strict") || process.env.NIGHTLY_SCHEDULE_CANARY_STRICT === "1";
const JSONOUT = argv.includes("--json");

function loadRegistry() {
  try {
    return JSON.parse(readFileSync(REGISTRY_PATH, "utf8"));
  } catch {
    return {};
  }
}

/** PURE: watched job names = every registry key not starting with "_" (the heartbeat.mjs convention). */
export function watchedJobs(registry) {
  return Object.keys(registry || {})
    .filter((k) => !k.startsWith("_") && registry[k] && typeof registry[k] === "object")
    .sort();
}

/** PURE: beat names that belong to retired jobs: the suffix of each "_retired_<name>" key plus its "beats" list. */
export function retiredBeatNames(registry) {
  const out = new Set();
  for (const [k, v] of Object.entries(registry || {})) {
    if (!k.startsWith("_retired_")) continue;
    out.add(k.slice("_retired_".length));
    for (const b of v && Array.isArray(v.beats) ? v.beats : []) if (typeof b === "string" && b) out.add(b);
  }
  return out;
}

/** PURE: how old (minutes) proof of life may be before the job counts as silent. max_age_min wins; else 3x
 *  interval_min (heartbeat.mjs's own DEAD multiplier) with a 6h floor. */
export function staleAfterMin(entry) {
  const e = entry || {};
  if (Number.isFinite(e.max_age_min) && e.max_age_min > 0) return e.max_age_min;
  const iv = Number.isFinite(e.interval_min) && e.interval_min > 0 ? e.interval_min : 0;
  return Math.max(MIN_STALE_FLOOR_MIN, iv * 3);
}

/** PURE: "owner/repo/file.yml" -> {owner, repo, file}, or null. */
export function parseWorkflowRef(ref) {
  const m = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+\.ya?ml)$/.exec(String(ref || ""));
  return m ? { owner: m[1], repo: m[2], file: m[3] } : null;
}

export function fmtAge(min) {
  if (min == null) return "never";
  if (min < 60) return `${min}m`;
  if (min < 2880) return `${Math.round(min / 60)}h`;
  return `${(min / 1440).toFixed(1)}d`;
}

/** PURE: "https://github.com/o/r/actions/runs/123" -> "run 123". The pager redacts a 40+ char path with capitals, which
 *  would turn the URL into "https://github.[redacted]"; the run id plus the row's workflow is enough to find it. */
export function runRef(url) {
  const m = /\/actions\/runs\/(\d+)/.exec(String(url || ""));
  return m ? `run ${m[1]}` : "";
}

/** PURE: reduce GitHub workflow-run objects (event=schedule) to what the verdict needs. */
export function summarizeScheduledRuns(runs, nowMs = Date.now()) {
  const list = (runs || []).filter((r) => r && r.created_at).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  if (!list.length) return { count: 0, lastAgeMin: null, lastConclusion: null, consecutiveFailures: 0, lastRunUrl: null };
  const done = list.filter((r) => r.status === "completed");
  let consecutiveFailures = 0;
  for (const r of done) {
    if (!FAILED_CONCLUSIONS.has(r.conclusion)) break;
    consecutiveFailures++;
  }
  return {
    count: list.length,
    lastAgeMin: Math.max(0, Math.round((nowMs - Date.parse(list[0].created_at)) / 60000)),
    lastConclusion: done.length ? done[0].conclusion : list[0].status,
    consecutiveFailures,
    lastRunUrl: list[0].html_url || null,
  };
}

/** PURE: which token reads the Actions runs of `ref`. The job's own GITHUB_TOKEN is the default for every repo:
 *  it reads its own repo, and a PUBLIC repo answers it (or an anonymous call, see fetchWorkflowRuns) for any
 *  other. The optional read-only FLEET_WATCH_GH_TOKEN wins for a repo other than this one, because it is the
 *  only credential that can read a PRIVATE one. Returns "" when neither is set (an anonymous read). */
export function tokenForRepo(ref, env = process.env) {
  const own = env.GITHUB_TOKEN || "";
  const pat = env.FLEET_WATCH_GH_TOKEN || "";
  const here = (env.GITHUB_REPOSITORY || "").toLowerCase();
  if (here && here === `${ref.owner}/${ref.repo}`.toLowerCase()) return own || pat;
  return pat || own;
}

/** Recent runs of one workflow (optionally one event). fetchImpl is injectable. With a token the call is
 *  authenticated; on 401/403/404 and anonymousFallback it is retried WITHOUT credentials, which is what makes a
 *  public repo readable with no token at all (a stale, revoked or wrong-repo token cannot break it). With no
 *  token it is one anonymous call. Errors never include the token. */
export async function fetchWorkflowRuns(ref, token, { event = "", perPage = 10, fetchImpl = globalThis.fetch, timeoutMs = 20_000, anonymousFallback = false } = {}) {
  const name = `${ref.repo}/${ref.file}`; // no owner: "InnerScopeHearing/..." is a 40+ char run the pager would redact
  const query = [event ? `event=${encodeURIComponent(event)}` : "", `per_page=${perPage}`].filter(Boolean).join("&");
  const url = `https://api.github.com/repos/${ref.owner}/${ref.repo}/actions/workflows/${ref.file}/runs?${query}`;
  const scrub = (m) => (token ? String(m).split(token).join("***") : String(m));
  const tries = token ? (anonymousFallback ? [token, ""] : [token]) : [""];
  const attempted = [];
  let status = null;
  let limited = false;
  for (const tok of tries) {
    attempted.push(tok ? "a token" : "anonymous");
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const headers = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "otchealth-silence-monitor" };
      if (tok) headers.Authorization = `Bearer ${tok}`;
      const res = await fetchImpl(url, { headers, signal: ctl.signal });
      if (res.ok) {
        const body = await res.json();
        return { ok: true, runs: Array.isArray(body && body.workflow_runs) ? body.workflow_runs : [], via: tok ? "token" : "anonymous" };
      }
      status = res.status;
      limited = limited || (res.headers && typeof res.headers.get === "function" && res.headers.get("x-ratelimit-remaining") === "0");
      if (![401, 403, 404].includes(res.status)) break; // only an auth-class refusal is worth the anonymous retry
    } catch (e) {
      const msg = e && e.name === "AbortError" ? "timeout" : scrub((e && e.message) || e).slice(0, 160);
      return { ok: false, error: `GitHub API call failed for ${name}: ${msg}` };
    } finally {
      clearTimeout(timer);
    }
  }
  const hint = limited ? "; rate limited, the next run retries" : [401, 403, 404].includes(status) ? "; private repo or no such file" : "";
  return { ok: false, error: `GitHub HTTP ${status} for ${name} (tried ${attempted.join(", then ")}${hint})` };
}

/** Last 10 scheduled runs of one workflow, with the anonymous fallback on. */
export async function fetchScheduledRuns(ref, token, fetchImpl = globalThis.fetch, timeoutMs = 20_000) {
  return fetchWorkflowRuns(ref, token, { event: "schedule", perPage: 10, fetchImpl, timeoutMs, anonymousFallback: true });
}

/** PURE: turn a heartbeat.mjs failure into one sentence that names the exact fix. Built from short tokens so
 *  setup/alert-issue.mjs's redactSecrets (40+ char runs with capitals) leaves it intact. */
export function diagnoseBeatStoreFailure(raw) {
  const t = String(raw || "");
  if (/exit 78|credentials? (unavailable|not found)|could not load credentials|no credentials/i.test(t)) {
    return "no AWS credentials reached the heartbeat reader (the role assumption step failed or was skipped): check the OIDC trust of the role for this repo (repo variable AWS_FLEET_SENTINELS_ROLE_ARN, default otchealth-aws-dr-canary)";
  }
  if (/\b403\b|AccessDenied|not authorized|forbidden/i.test(t)) {
    return `MISSING PERMISSION for the checker's AWS role: s3:ListBucket on bucket ${BEAT_BUCKET} (s3:prefix covering the "_HEARTBEAT/" folder under ${BEAT_KEY_PREFIX}) and s3:GetObject on the objects in that folder. Jobs that write beats additionally need s3:PutObject there.`;
  }
  return `the heartbeat store could not be read: ${t.slice(0, 200)}`;
}

/** PURE: the remedy an UNWITNESSED row carries. Neither fix needs a new token: the job beats (it needs s3:PutObject on its
 *  own beat object), or the OPTIONAL read-only secret lets this monitor read a private repo's Actions runs. Kept short and
 *  worded for setup/alert-issue.mjs's redactSecrets (no "token" directly before a colon, no 40+ char run with capitals) and
 *  its 500 char cap per failed-check line. */
export function unwitnessedFix(job) {
  return `Fix, no new token needed: have the job beat (setup/heartbeat.mjs beat ${job} ok, needs s3:PutObject on _HEARTBEAT/${job}.json in bucket ${BEAT_BUCKET}) or set the optional secret FLEET_WATCH_GH_TOKEN.`;
}

/** PURE: can the beat alone decide this row? "fresh" = a recent ok beat (LIVE, or FAILING when the last runs
 *  reported fail); "never-ok-failing" = it has only ever reported fail. null = the beat cannot vouch, so the
 *  GitHub witness is consulted. */
function beatDecides(beat, beatError, limitMin) {
  if (beatError || !beat) return null;
  const age = beat.ageMin != null ? beat.ageMin : null;
  if (age != null && age <= limitMin) return "fresh";
  if (age == null && (beat.consecutive_fail || 0) > 0) return "never-ok-failing";
  return null;
}

/** PURE: does this row need the GitHub witness at all? Only a row carrying "gh_workflow" whose beat cannot
 *  decide, so a healthy beat costs no API call (and no rate-limit exposure). */
export function needsScheduleWitness(entry, beatRow, beatError = null) {
  if (!entry || !entry.gh_workflow) return false;
  return beatDecides(beatRow, beatError, staleAfterMin(entry)) === null;
}

/** PURE: while a newly armed job is inside its first grace window (armed: "YYYY-MM-DD" plus its own limit) and
 *  has shown no proof of life yet, it is PENDING, not STALE. Returns the end of the window (ms) or 0. */
function armedGraceUntil(entry, limitMin, nowMs) {
  if (!entry || !/^\d{4}-\d{2}-\d{2}$/.test(String(entry.armed || ""))) return 0;
  const t = Date.parse(`${entry.armed}T00:00:00Z`);
  if (!Number.isFinite(t)) return 0;
  const until = t + limitMin * 60000;
  return nowMs < until ? until : 0;
}

/** PURE: the verdict. beatRows = heartbeat.mjs `check --json` rows (null when the store was unreadable),
 *  beatError = diagnosis string or null, schedule = { job: {ok, summary|error} } for rows with gh_workflow,
 *  nowMs only matters for a row's "armed" grace window. */
export function evaluateSilence({ registry, beatRows, beatError = null, schedule = {}, unregisteredMaxAgeMin = UNREGISTERED_MAX_AGE_MIN, nowMs = Date.now() }) {
  const byJob = new Map((beatRows || []).filter((r) => r && r.job).map((r) => [r.job, r]));
  const results = [];
  const add = (job, state, detail, extra = {}) => results.push({ job, state, detail, ...extra });
  const watched = watchedJobs(registry);
  for (const job of watched) {
    const entry = registry[job];
    const limit = staleAfterMin(entry);
    const beat = byJob.get(job);
    const age = beat && beat.ageMin != null ? beat.ageMin : null;
    const fails = (beat && beat.consecutive_fail) || 0;
    const meta = { owner: entry.owner || "", ageMin: age, limitMin: limit };
    const decided = beatDecides(beat, beatError, limit);
    if (decided === "fresh") {
      if (fails > 0) add(job, "FAILING", `beat is fresh (${fmtAge(age)}) but the last ${fails} run(s) reported fail`, { ...meta, witness: "beat" });
      else add(job, "LIVE", `last ok beat ${fmtAge(age)} ago (limit ${fmtAge(limit)})`, { ...meta, witness: "beat" });
      continue;
    }
    if (decided === "never-ok-failing") {
      add(job, "FAILING", `${fails} run(s) reported fail and none has ever reported ok`, { ...meta, witness: "beat" });
      continue;
    }
    const beatNote = beatError ? "beat store unreadable" : age == null ? "never beat ok" : `last ok beat ${fmtAge(age)} ago`;
    const grace = armedGraceUntil(entry, limit, nowMs);
    const pending = () => add(job, "PENDING", `armed ${entry.armed}: no proof of life yet, the first is due by ${new Date(grace).toISOString().slice(0, 16)}Z`, meta);
    if (entry.gh_workflow) {
      const s = schedule[job];
      if (s && s.ok) {
        const sum = s.summary;
        if (sum.count === 0 || sum.lastAgeMin == null || sum.lastAgeMin > limit) {
          if (grace) pending();
          else add(job, "STALE", `no scheduled run inside ${fmtAge(limit)} (${sum.count ? `last scheduled run ${fmtAge(sum.lastAgeMin)} ago` : "none on record"}): the cron is not firing; ${beatNote}`, { ...meta, witness: "github" });
        } else if (FAILED_CONCLUSIONS.has(sum.lastConclusion)) {
          add(job, "FAILING", `last scheduled run ${fmtAge(sum.lastAgeMin)} ago concluded ${sum.lastConclusion}; ${sum.consecutiveFailures} consecutive failed scheduled run(s)${runRef(sum.lastRunUrl) ? ` (${runRef(sum.lastRunUrl)})` : ""}`, { ...meta, witness: "github" });
        } else {
          add(job, "LIVE", `scheduled run ${fmtAge(sum.lastAgeMin)} ago (${sum.lastConclusion}); ${beatNote}`, { ...meta, witness: "github" });
        }
      } else if (age != null) {
        // A stale beat is still evidence of silence; the unavailable GitHub witness is why it cannot be overruled.
        add(job, "STALE", `last ok beat ${fmtAge(age)} ago, limit ${fmtAge(limit)}; the GitHub witness could not show a newer run (${s ? s.error : "not fetched"})`, meta);
      } else {
        add(job, "UNWITNESSED", `${beatNote}; GitHub witness unavailable (${s ? s.error : "not fetched"}). ${unwitnessedFix(job)}`, meta);
      }
    } else if (beatError) {
      add(job, "UNREADABLE", beatError, meta);
    } else if (age == null) {
      if (grace) pending();
      else add(job, "NO-DATA", "registered but has never beaten ok: a monitor that never ran", meta);
    } else {
      add(job, "STALE", `last ok beat ${fmtAge(age)} ago, limit ${fmtAge(limit)}`, meta);
    }
  }
  const known = new Set(watched);
  const retired = retiredBeatNames(registry);
  for (const [job, row] of [...byJob].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (known.has(job)) continue;
    const age = row.ageMin != null ? row.ageMin : null;
    if (retired.has(job)) {
      if (age != null && age <= unregisteredMaxAgeMin) add(job, "RETIRED-BEATING", `retired job is beating again (last ok ${fmtAge(age)} ago): un-retire it in the registry or stop whatever still runs it`, { ageMin: age });
    } else if (age == null || age > unregisteredMaxAgeMin) {
      add(job, "UNREGISTERED-STALE", `beat file with no registry row, last ok ${fmtAge(age)}${age == null ? "" : " ago"}: register it with an interval, or retire it (list it under beats in a _retired_ row)`, { ageMin: age });
    } else {
      add(job, "UNREGISTERED", `beating (last ok ${fmtAge(age)} ago) but has no registry row: add one so its silence pages`, { ageMin: age });
    }
  }
  const anomalies = results.filter((r) => ANOMALY_STATES.has(r.state));
  return { ok: anomalies.length === 0, results, anomalies };
}

/** PURE: "LIVE 4, PENDING 1, UNREADABLE 23" in a fixed order, zero counts left out. */
export function summarizeStates(results) {
  const n = new Map();
  for (const r of results || []) n.set(r.state, (n.get(r.state) || 0) + 1);
  return STATE_ORDER.filter((s) => n.has(s)).map((s) => `${s} ${n.get(s)}`).join(", ");
}

/** PURE: the lines setup/alert-issue.mjs extracts into the pager issue ("[STALE   ] ..." / "[ERROR   ] ..."). */
export function renderAttention(anomalies) {
  const lines = [];
  const dark = anomalies.filter((a) => a.state === "UNREADABLE");
  if (dark.length) {
    const shown = dark.slice(0, 5).map((a) => a.job).join(", ");
    lines.push(`[ERROR   ] beat store unreadable, ${dark.length} beat-only job(s) cannot be verified (${shown}${dark.length > 5 ? ", ..." : ""}): ${dark[0].detail}`);
  }
  for (const a of anomalies) {
    if (a.state === "UNREADABLE") continue;
    lines.push(`[${(TAG[a.state] || "STALE").padEnd(8)}] ${a.job}: ${a.state} -- ${a.detail}`);
  }
  return lines;
}

/** Exit-code policy: report-only by default, --strict pages (exit 1) on any anomaly. */
export function pageExitCode(anomalyCount, strict) {
  return strict && anomalyCount > 0 ? 1 : 0;
}

/** Shell out to heartbeat.mjs (the only _HEARTBEAT reader). A crash is returned, never swallowed. */
function runHeartbeatCheck() {
  try {
    const out = execFileSync(process.execPath, [HEARTBEAT_CLI, "check", "--json"], { encoding: "utf8", timeout: 120_000, stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true, rows: JSON.parse(out) };
  } catch (e) {
    const stderr = e.stderr ? e.stderr.toString("utf8") : "";
    return { ok: false, error: `heartbeat.mjs check failed: exit ${e.status ?? "?"}: ${String(stderr || e.message || "").replace(/\s+/g, " ").slice(0, 300)}` };
  }
}

async function main() {
  const registry = loadRegistry();
  const watched = watchedJobs(registry);
  if (!watched.length) {
    console.error("::error::[silence-monitor] the heartbeat registry is empty or unreadable: nothing is being watched");
    process.exit(pageExitCode(1, STRICT));
  }
  const hb = runHeartbeatCheck();
  const role = process.env.FLEET_SENTINELS_ROLE_ARN ? ` (role ${process.env.FLEET_SENTINELS_ROLE_ARN})` : "";
  const beatError = hb.ok ? null : `${diagnoseBeatStoreFailure(hb.error)}${role}`;
  const beatByJob = new Map((hb.ok ? hb.rows : []).filter((r) => r && r.job).map((r) => [r.job, r]));
  const schedule = {};
  await Promise.all(
    watched.filter((j) => needsScheduleWitness(registry[j], beatByJob.get(j), beatError)).map(async (job) => {
      const ref = parseWorkflowRef(registry[job].gh_workflow);
      if (!ref) {
        schedule[job] = { ok: false, error: `unparseable gh_workflow "${registry[job].gh_workflow}"` };
        return;
      }
      const r = await fetchScheduledRuns(ref, tokenForRepo(ref));
      schedule[job] = r.ok ? { ok: true, summary: summarizeScheduledRuns(r.runs) } : r;
    }),
  );
  const verdict = evaluateSilence({ registry, beatRows: hb.ok ? hb.rows : null, beatError, schedule });
  if (JSONOUT) {
    console.log(JSON.stringify(verdict, null, 2));
  } else {
    console.log(`[silence-monitor] ${watched.length} registered job(s) checked, ${verdict.anomalies.length} needing attention (${summarizeStates(verdict.results)})`);
    for (const r of verdict.results) console.log(`  ${r.state.padEnd(19)} ${r.job.padEnd(30)} ${r.state === "UNREADABLE" ? "beat store unreadable (reason under ATTENTION)" : r.detail}${r.witness ? ` [${r.witness}]` : ""}`);
    const att = renderAttention(verdict.anomalies);
    if (att.length) {
      console.log("\nATTENTION");
      for (const l of att) console.log(l);
    }
    console.log(verdict.ok ? "\n[silence-monitor] OK: every registered job has recent proof of life" : `\n[silence-monitor] SILENCE = FAILURE: ${verdict.anomalies.map((r) => r.job).join(", ")}`);
  }
  process.exit(pageExitCode(verdict.anomalies.length, STRICT));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(`::error::[silence-monitor] unexpected failure: ${String((e && e.message) || e).slice(0, 300)}`);
    process.exit(1);
  });
}
