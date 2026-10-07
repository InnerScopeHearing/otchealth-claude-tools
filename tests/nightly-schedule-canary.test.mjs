// The silence monitor (skills/nightly-schedule-canary/schedule-canary.mjs): hermetic tests for the verdict
// logic, the two witnesses (beat store, GitHub schedule history via a fake fetch), the registry's hygiene, the
// coverage of every armed cron and the workflow wiring. tests/sentinel-watchdog.test.mjs covers the watchdog.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import {
  ANOMALY_STATES, MIN_STALE_FLOOR_MIN, diagnoseBeatStoreFailure, evaluateSilence, fetchScheduledRuns, fetchWorkflowRuns,
  needsScheduleWitness, pageExitCode, parseWorkflowRef, renderAttention, retiredBeatNames, runRef, staleAfterMin,
  summarizeScheduledRuns, summarizeStates, tokenForRepo, unwitnessedFix, watchedJobs,
} from "../skills/nightly-schedule-canary/schedule-canary.mjs";
import { extractFailedChecks, parseMentions, redactSecrets } from "../setup/alert-issue.mjs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const registry = JSON.parse(read("setup/heartbeat-registry.json"));
const NOW = Date.parse("2026-10-07T12:00:00Z");
const run = (minAgo, conclusion = "success", status = "completed") => ({ created_at: new Date(NOW - minAgo * 60000).toISOString(), status, conclusion, html_url: `https://github.com/o/r/actions/runs/${minAgo}` });
const sched = (...runs) => ({ ok: true, summary: summarizeScheduledRuns(runs, NOW) });
const REG = {
  beater: { interval_min: 60, owner: "cto" },
  nightly: { interval_min: 1560, max_age_min: 2160, owner: "cto", gh_workflow: "o/r/nightly.yml" },
  _retired_gone: { retired: "2026-10-07", beats: ["gone-beat"] },
};
const GOOD = [{ job: "beater", status: "LIVE", ageMin: 30, consecutive_fail: 0 }];
const verdict = (beatRows, schedule = { nightly: sched(run(300)) }, beatError = null, reg = REG, nowMs = NOW) => evaluateSilence({ registry: reg, beatRows, beatError, schedule, nowMs });
const row = (v, job) => v.results.find((r) => r.job === job);
const state = (v, job) => row(v, job)?.state;

test("watchedJobs skips underscore rows; retiredBeatNames reads the suffix and the beats list", () => {
  assert.deepEqual(watchedJobs(REG), ["beater", "nightly"]);
  assert.deepEqual([...retiredBeatNames(REG)].sort(), ["gone", "gone-beat"]);
  assert.deepEqual(watchedJobs(undefined), []);
});

test("staleAfterMin: max_age_min wins, otherwise 3x the interval with a 6h floor", () => {
  assert.equal(staleAfterMin({ interval_min: 1560, max_age_min: 2160 }), 2160);
  assert.equal(staleAfterMin({ interval_min: 5 }), MIN_STALE_FLOOR_MIN);
  assert.equal(staleAfterMin({ interval_min: 480 }), 1440);
  assert.equal(staleAfterMin(undefined), MIN_STALE_FLOOR_MIN);
});

test("parseWorkflowRef accepts owner/repo/file.yml only", () => {
  assert.deepEqual(parseWorkflowRef("InnerScopeHearing/otchealth-cto/aws-health-monitor.yml"), { owner: "InnerScopeHearing", repo: "otchealth-cto", file: "aws-health-monitor.yml" });
  for (const bad of ["", "a/b", "a/b/c.txt", "a/b/c/d.yml", undefined]) assert.equal(parseWorkflowRef(bad), null);
});

test("summarizeScheduledRuns: newest run, newest completed conclusion, consecutive failures", () => {
  const s = summarizeScheduledRuns([run(1500, "failure"), run(60, "failure"), run(2900)], NOW);
  assert.deepEqual([s.lastAgeMin, s.lastConclusion, s.consecutiveFailures, s.count], [60, "failure", 2, 3]);
  const live = summarizeScheduledRuns([run(10, null, "in_progress"), run(1500)], NOW);
  assert.deepEqual([live.lastAgeMin, live.lastConclusion, live.consecutiveFailures], [10, "success", 0]);
  assert.equal(summarizeScheduledRuns([], NOW).count, 0);
});

test("runRef keeps the run id and drops the URL the pager would redact", () => {
  assert.equal(runRef("https://github.com/InnerScopeHearing/otchealth-claude-tools/actions/runs/37487658211"), "run 37487658211");
  assert.equal(runRef(null), "");
  assert.equal(runRef("https://example.test/x"), "");
  const url = "https://github.com/InnerScopeHearing/otchealth-claude-tools/actions/runs/37487658211";
  assert.notEqual(redactSecrets(url), url, "this is why the URL is not printed");
  assert.equal(redactSecrets(runRef(url)), runRef(url));
});

test("tokenForRepo: no new token is needed, the job's own token is the default for every repo", () => {
  const env = { GITHUB_REPOSITORY: "O/R", GITHUB_TOKEN: "own", FLEET_WATCH_GH_TOKEN: "pat" };
  assert.equal(tokenForRepo({ owner: "o", repo: "r" }, env), "own", "own repo: its own token");
  assert.equal(tokenForRepo({ owner: "o", repo: "other" }, env), "pat", "another repo: the optional PAT, the only credential that reads a private one");
  assert.equal(tokenForRepo({ owner: "o", repo: "other" }, { GITHUB_REPOSITORY: "O/R", GITHUB_TOKEN: "own" }), "own", "no PAT: the job token, which a PUBLIC repo answers");
  assert.equal(tokenForRepo({ owner: "o", repo: "r" }, { GITHUB_REPOSITORY: "O/R", FLEET_WATCH_GH_TOKEN: "pat" }), "pat");
  assert.equal(tokenForRepo({ owner: "o", repo: "other" }, { GITHUB_REPOSITORY: "O/R" }), "", "nothing set: an anonymous read");
  assert.equal(tokenForRepo({ owner: "o", repo: "r" }, { FLEET_WATCH_GH_TOKEN: "pat", GITHUB_TOKEN: "own" }), "pat", "a local run prefers the PAT");
});

test("fetchScheduledRuns: success, HTTP error and thrown error; the token never leaks into an error", async () => {
  const ref = { owner: "o", repo: "r", file: "w.yml" };
  const ok = await fetchScheduledRuns(ref, "tok", async (url, init) => {
    assert.match(url, /\/repos\/o\/r\/actions\/workflows\/w\.yml\/runs\?event=schedule&per_page=10$/);
    assert.equal(init.headers.Authorization, "Bearer tok");
    return { ok: true, status: 200, json: async () => ({ workflow_runs: [run(5)] }) };
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.runs.length, 1);
  assert.equal(ok.via, "token");
  const nf = await fetchScheduledRuns(ref, "tok-secret-1", async () => ({ ok: false, status: 404 }));
  assert.equal(nf.ok, false);
  assert.equal(nf.error, "GitHub HTTP 404 for r/w.yml (tried a token, then anonymous; private repo or no such file)");
  assert.doesNotMatch(nf.error, /tok-secret-1/);
  assert.equal(redactSecrets(nf.error), nf.error, "the pager must not mangle it");
  const boom = await fetchScheduledRuns(ref, "tok-secret-2", async () => { throw new Error("connect failed for tok-secret-2"); });
  assert.equal(boom.ok, false);
  assert.match(boom.error, /connect failed for \*\*\*/);
  assert.doesNotMatch(boom.error, /tok-secret-2/);
});

test("fetchWorkflowRuns: an auth-class refusal is retried anonymously (a public repo needs no token at all), nothing else is", async () => {
  const ref = { owner: "o", repo: "r", file: "w.yml" };
  const seen = [];
  const viaAnon = await fetchScheduledRuns(ref, "stale-pat", async (url, init) => {
    seen.push(init.headers.Authorization);
    return init.headers.Authorization ? { ok: false, status: 401 } : { ok: true, status: 200, json: async () => ({ workflow_runs: [run(5)] }) };
  });
  assert.deepEqual(seen, ["Bearer stale-pat", undefined], "the second call carries no credentials");
  assert.equal(viaAnon.ok, true);
  assert.equal(viaAnon.via, "anonymous");

  let n = 0;
  const server = await fetchScheduledRuns(ref, "tok", async () => { n++; return { ok: false, status: 500 }; });
  assert.equal(n, 1, "a 500 is not an auth problem");
  assert.equal(server.error, "GitHub HTTP 500 for r/w.yml (tried a token)");

  const headers = [];
  const none = await fetchScheduledRuns(ref, "", async (url, init) => { headers.push(init.headers); return { ok: false, status: 404 }; });
  assert.equal(headers.length, 1, "no token is ONE anonymous call, never a refusal to try");
  assert.equal("Authorization" in headers[0], false);
  assert.match(none.error, /HTTP 404 for r\/w\.yml \(tried anonymous; private repo or no such file\)/);

  const limited = await fetchScheduledRuns(ref, "", async () => ({ ok: false, status: 403, headers: { get: (h) => (h === "x-ratelimit-remaining" ? "0" : null) } }));
  assert.match(limited.error, /rate limited/);

  const noRetry = await fetchWorkflowRuns(ref, "tok", { fetchImpl: async () => ({ ok: false, status: 404 }) });
  assert.match(noRetry.error, /\(tried a token; private repo/, "without anonymousFallback only the token is tried");
});

test("fetchWorkflowRuns: the event filter is optional and per_page is honoured", async () => {
  let seen = "";
  const r = await fetchWorkflowRuns({ owner: "o", repo: "r", file: "w.yml" }, "t", { perPage: 20, fetchImpl: async (u) => { seen = u; return { ok: true, json: async () => ({ workflow_runs: [] }) }; } });
  assert.equal(r.ok, true);
  assert.match(seen, /\/runs\?per_page=20$/);
});

test("evaluateSilence: a fresh beat and a firing cron are LIVE and do not page, and each says who witnessed it", () => {
  const v = verdict(GOOD);
  assert.equal(v.ok, true);
  assert.equal(state(v, "beater"), "LIVE");
  assert.equal(row(v, "beater").witness, "beat");
  assert.equal(row(v, "nightly").witness, "github");
});

test("evaluateSilence judges the AGE of the beat, not its last status", () => {
  const stale = verdict([{ job: "beater", status: "LIVE", ageMin: 400, consecutive_fail: 0 }]);
  assert.equal(state(stale, "beater"), "STALE");
  assert.equal(stale.ok, false);
  assert.equal(state(verdict([]), "beater"), "NO-DATA");
  assert.equal(state(verdict([{ job: "beater", ageMin: 30, consecutive_fail: 2 }]), "beater"), "FAILING");
});

test("a job that has only ever reported fail is FAILING, not 'never ran'", () => {
  const v = verdict([{ job: "beater", ageMin: null, consecutive_fail: 3 }]);
  assert.equal(state(v, "beater"), "FAILING");
  assert.match(row(v, "beater").detail, /3 run\(s\) reported fail and none has ever reported ok/);
  assert.equal(state(verdict([{ job: "beater", ageMin: null, consecutive_fail: 0 }]), "beater"), "NO-DATA");
});

test("evaluateSilence: the GitHub witness catches failing, silent and absent schedules", () => {
  const failing = verdict(GOOD, { nightly: sched(run(300, "failure"), run(1700, "failure")) });
  assert.equal(state(failing, "nightly"), "FAILING");
  assert.match(row(failing, "nightly").detail, /2 consecutive failed scheduled run\(s\) \(run 300\)$/);
  assert.equal(state(verdict(GOOD, { nightly: sched(run(3000)) }), "nightly"), "STALE");
  assert.equal(state(verdict(GOOD, { nightly: sched() }), "nightly"), "STALE");
});

test("UNWITNESSED replaces UNVERIFIABLE: neither witness can speak, it pages, and it names the fix", () => {
  assert.equal(ANOMALY_STATES.has("UNWITNESSED"), true);
  assert.equal(ANOMALY_STATES.has("UNVERIFIABLE"), false);
  const u = verdict(GOOD, { nightly: { ok: false, error: "GitHub HTTP 404 for r/nightly.yml (tried anonymous)" } });
  assert.equal(state(u, "nightly"), "UNWITNESSED");
  assert.equal(u.ok, false);
  const d = row(u, "nightly").detail;
  assert.match(d, /never beat ok; GitHub witness unavailable \(GitHub HTTP 404 for r\/nightly\.yml/);
  for (const needle of ["setup/heartbeat.mjs beat nightly ok", "s3:PutObject", "_HEARTBEAT/nightly.json", "otchealth-brain-dr-55c84f6b", "FLEET_WATCH_GH_TOKEN"]) assert.ok(d.includes(needle), needle);
  assert.match(d, /no new token needed/);
  assert.equal(state(verdict(GOOD, {}), "nightly"), "UNWITNESSED", "a witness that was never consulted is not a pass either");
  assert.ok(unwitnessedFix("job-x").includes("_HEARTBEAT/job-x.json"));
});

test("a stale beat with an unreachable GitHub witness is STALE: the beat is still evidence of silence", () => {
  const v = verdict([...GOOD, { job: "nightly", ageMin: 2400, consecutive_fail: 0 }], { nightly: { ok: false, error: "GitHub HTTP 404 for r/nightly.yml (tried anonymous)" } });
  assert.equal(state(v, "nightly"), "STALE");
  assert.match(row(v, "nightly").detail, /last ok beat 40h ago, limit 36h; the GitHub witness could not show a newer run/);
});

test("an unreadable beat store is UNREADABLE for beat-only jobs but never hides what GitHub can see", () => {
  const v = verdict(null, undefined, "MISSING PERMISSION for the checker's AWS role");
  assert.equal(state(v, "beater"), "UNREADABLE");
  assert.equal(state(v, "nightly"), "LIVE");
  assert.equal(v.ok, false);
  const both = verdict(null, { nightly: { ok: false, error: "GitHub HTTP 404 for r/nightly.yml (tried anonymous)" } }, "MISSING PERMISSION");
  assert.equal(state(both, "nightly"), "UNWITNESSED");
  assert.match(row(both, "nightly").detail, /^beat store unreadable; GitHub witness unavailable/);
});

test("needsScheduleWitness: GitHub is consulted only when the beat cannot vouch", () => {
  const gh = { gh_workflow: "o/r/w.yml", interval_min: 60 }; // limit 360
  assert.equal(needsScheduleWitness({ interval_min: 60 }, undefined), false, "a beat-only row has no GitHub witness");
  assert.equal(needsScheduleWitness(undefined, undefined), false);
  assert.equal(needsScheduleWitness(gh, { ageMin: 30, consecutive_fail: 0 }), false, "a fresh ok beat decides");
  assert.equal(needsScheduleWitness(gh, { ageMin: 30, consecutive_fail: 2 }), false, "a fresh beat that reports fail is FAILING from the beat");
  assert.equal(needsScheduleWitness(gh, { ageMin: null, consecutive_fail: 3 }), false, "only ever failed: decided by the beat");
  assert.equal(needsScheduleWitness(gh, { ageMin: 400 }), true, "a stale beat cannot vouch");
  assert.equal(needsScheduleWitness(gh, undefined), true, "never beat");
  assert.equal(needsScheduleWitness(gh, { ageMin: 30 }, "beat store unreadable"), true, "an unreadable store cannot vouch");
});

test("armed: a newly armed job is PENDING inside its grace window, STALE after it, and real proof overrides it", () => {
  const reg = { fresh: { interval_min: 1560, max_age_min: 2160, owner: "cto", gh_workflow: "o/r/w.yml", armed: "2026-10-08" } };
  const at = (iso, schedule) => evaluateSilence({ registry: reg, beatRows: [], schedule: { fresh: schedule }, nowMs: Date.parse(iso) });
  const none = sched();
  const pending = at("2026-10-08T14:00:00Z", none);
  assert.equal(state(pending, "fresh"), "PENDING");
  assert.equal(pending.ok, true, "PENDING does not page");
  assert.equal(ANOMALY_STATES.has("PENDING"), false);
  assert.match(row(pending, "fresh").detail, /armed 2026-10-08: no proof of life yet, the first is due by 2026-10-09T12:00Z/);
  assert.equal(state(at("2026-10-09T11:59:00Z", none), "fresh"), "PENDING");
  assert.equal(state(at("2026-10-09T12:01:00Z", none), "fresh"), "STALE");
  assert.equal(state(at("2026-10-08T14:00:00Z", sched(run(60))), "fresh"), "LIVE");
  assert.equal(state(at("2026-10-08T14:00:00Z", { ok: false, error: "GitHub HTTP 404 for r/w.yml (tried anonymous)" }), "fresh"), "UNWITNESSED", "an unavailable witness is not masked by the grace");
  const beatOnly = { b: { interval_min: 60, owner: "cto", armed: "2026-10-08" } }; // limit 6h, so the grace ends 2026-10-08T06:00Z
  assert.equal(state(evaluateSilence({ registry: beatOnly, beatRows: [], nowMs: Date.parse("2026-10-08T05:00:00Z") }), "b"), "PENDING");
  assert.equal(state(evaluateSilence({ registry: beatOnly, beatRows: [], nowMs: Date.parse("2026-10-08T07:00:00Z") }), "b"), "NO-DATA");
  assert.equal(state(evaluateSilence({ registry: beatOnly, beatRows: null, beatError: "x", nowMs: Date.parse("2026-10-08T05:00:00Z") }), "b"), "UNREADABLE", "an unreadable store is not masked either");
  assert.equal(state(evaluateSilence({ registry: { b: { interval_min: 60, owner: "cto", armed: "soon" } }, beatRows: [], nowMs: NOW }), "b"), "NO-DATA", "a malformed armed date grants no grace");
});

test("unregistered stale beats and beating retired jobs are attention items; recent unregistered beats are info", () => {
  const v = verdict([...GOOD, { job: "mystery", ageMin: 9000 }, { job: "fresh-new", ageMin: 100 }, { job: "gone-beat", ageMin: 100 }, { job: "gone", ageMin: 99999 }]);
  assert.equal(state(v, "mystery"), "UNREGISTERED-STALE");
  assert.equal(state(v, "fresh-new"), "UNREGISTERED");
  assert.equal(state(v, "gone-beat"), "RETIRED-BEATING");
  assert.equal(state(v, "gone"), undefined);
  assert.deepEqual(v.anomalies.map((r) => r.job).sort(), ["gone-beat", "mystery"]);
});

test("diagnoseBeatStoreFailure names the exact permission and survives the pager's redaction", () => {
  const perm = diagnoseBeatStoreFailure("heartbeat.mjs check failed: exit 1: [heartbeat] ERROR: AccessDenied: not authorized to perform s3:ListBucket");
  for (const needle of ["MISSING PERMISSION", "s3:ListBucket", "s3:GetObject", "s3:PutObject", "otchealth-brain-dr-55c84f6b", "_HEARTBEAT/"]) assert.ok(perm.includes(needle), needle);
  assert.equal(redactSecrets(perm), perm);
  const creds = diagnoseBeatStoreFailure("heartbeat.mjs check failed: exit 78: credentials unavailable");
  assert.match(creds, /no AWS credentials/);
  assert.doesNotMatch(creds, /MISSING PERMISSION/);
  assert.equal(redactSecrets(creds), creds);
  assert.match(diagnoseBeatStoreFailure("exit 1: ECONNRESET"), /could not be read/);
});

test("renderAttention emits exactly the lines the GitHub-issue pager extracts", () => {
  const v = verdict([{ job: "beater", ageMin: 400 }, { job: "mystery", ageMin: 9000 }], { nightly: sched(run(300, "failure")) });
  const lines = renderAttention(v.anomalies);
  assert.equal(lines.length, 3);
  assert.equal(extractFailedChecks([lines.join("\n")]).length, 3);
  assert.match(lines.find((l) => l.includes("nightly:")), /^\[ERROR {3}\] nightly: FAILING/);
  const dark = renderAttention(verdict(null, undefined, "diagnosis text").anomalies);
  assert.equal(dark.length, 1);
  assert.match(dark[0], /^\[ERROR {3}\] beat store unreadable, 1 beat-only job/);
  const unwitnessed = renderAttention(verdict(GOOD, { nightly: { ok: false, error: "GitHub HTTP 404 for r/nightly.yml (tried anonymous)" } }).anomalies);
  assert.match(unwitnessed[0], /^\[ERROR {3}\] nightly: UNWITNESSED -- /);
});

test("UNWITNESSED survives the pager for every GitHub-witnessed registry row: not redacted, not cut at 500 characters", async () => {
  for (const job of watchedJobs(registry).filter((j) => registry[j].gh_workflow)) {
    const ref = parseWorkflowRef(registry[job].gh_workflow);
    const refused = await fetchScheduledRuns(ref, "tok", async () => ({ ok: false, status: 404 }));
    const v = evaluateSilence({ registry, beatRows: null, beatError: "x", schedule: { [job]: refused }, nowMs: NOW });
    assert.equal(state(v, job), "UNWITNESSED", job);
    const [check] = extractFailedChecks(renderAttention([row(v, job)]));
    assert.equal(redactSecrets(check), check, `${job}: the pager would redact part of this line`);
    assert.ok(check.length <= 500, `${job}: ${check.length} characters, the issue body keeps 500`);
    for (const needle of ["no new token needed", "s3:PutObject", `_HEARTBEAT/${job}.json`, "FLEET_WATCH_GH_TOKEN"]) assert.ok(check.includes(needle), `${job}: ${needle}`);
  }
});

test("summarizeStates counts in a fixed order and leaves zeros out", () => {
  assert.equal(summarizeStates([{ state: "UNREADABLE" }, { state: "LIVE" }, { state: "UNREADABLE" }, { state: "PENDING" }]), "LIVE 1, PENDING 1, UNREADABLE 2");
  assert.equal(summarizeStates([]), "");
});

test("pageExitCode: only --strict with an anomaly pages", () => {
  assert.equal(pageExitCode(1, true), 1);
  assert.equal(pageExitCode(0, true), 0);
  assert.equal(pageExitCode(3, false), 0);
});

test("registry: watched rows are well formed, with no dead Azure rg field", () => {
  for (const job of watchedJobs(registry)) {
    const e = registry[job];
    assert.ok(e.interval_min > 0, `${job} needs interval_min`);
    assert.ok(e.owner, `${job} needs an owner`);
    assert.equal("rg" in e, false, `${job} must not carry the dead Azure rg field`);
    if (e.max_age_min !== undefined) assert.ok(e.max_age_min >= e.interval_min, `${job} max_age_min must not be below interval_min`);
    if (e.gh_workflow) assert.ok(parseWorkflowRef(e.gh_workflow), `${job} gh_workflow must be owner/repo/file.yml`);
    if (e.armed !== undefined) assert.match(e.armed, /^\d{4}-\d{2}-\d{2}$/, `${job} armed must be a YYYY-MM-DD date`);
  }
  assert.equal("nightly-fleet-sentinels" in registry, false, "a monitor cannot watch its own silence");
});

test("registry: the GitHub-witnessed rows are exactly the live scheduled jobs, and same-repo ones have an armed cron", () => {
  const names = watchedJobs(registry).filter((j) => registry[j].kind === "nightly-workflow");
  assert.deepEqual(names, [
    "aws-health-monitor", "codex-continuity-lane", "nightly-aws-dr-canary", "nightly-eval", "nightly-fleet-medic",
    "nightly-secrets-dr-export", "nightly-token-age-metrics", "sentinel-watchdog", "stale-pr-closer",
  ]);
  for (const job of names) {
    assert.equal(registry[job].owner, "cto");
    const ref = parseWorkflowRef(registry[job].gh_workflow);
    if (ref.repo !== "otchealth-claude-tools") continue;
    const p = `.github/workflows/${ref.file}`;
    assert.ok(existsSync(new URL(`../${p}`, import.meta.url)), `${p} must exist`);
    assert.match(read(p), /^  schedule:\s*$/m, `${p} must have an armed schedule`);
  }
});

test("registry: the cadence of the daily and weekly rows covers GitHub's scheduling lateness", () => {
  for (const job of ["nightly-aws-dr-canary", "nightly-eval", "nightly-secrets-dr-export", "nightly-token-age-metrics", "nightly-fleet-medic", "stale-pr-closer", "sentinel-watchdog"]) {
    assert.equal(staleAfterMin(registry[job]), 2160, `${job}: a daily cron gets 36h, gaps of 27h45m were observed`);
  }
  assert.equal(staleAfterMin(registry["codex-continuity-lane"]), 15840, "weekly cron: 11 days");
  assert.equal(staleAfterMin(registry["aws-health-monitor"]), 1080, "hourly cron throttled to 4-6 runs a day: 18h");
});

// COVERAGE: every cron that is armed in this repo must be witnessed, or a job can die with nobody told. This is the
// reverse of the check above (every row has a workflow); a new scheduled workflow fails here until it has a row.
const WORKFLOW_DIR = new URL("../.github/workflows/", import.meta.url);
const workflowFiles = readdirSync(WORKFLOW_DIR).filter((f) => /\.ya?ml$/.test(f)).sort();
const armedWorkflows = workflowFiles.filter((f) => /^\s*schedule:\s*$/m.test(readFileSync(new URL(f, WORKFLOW_DIR), "utf8")));
const NOT_A_ROW = { "nightly-fleet-sentinels.yml": "the monitor itself: it cannot watch its own silence, so sentinel-watchdog.yml watches it" };

test("coverage: every workflow with an armed cron is witnessed by a registry row, or exempt with a reason", () => {
  assert.ok(armedWorkflows.length >= 5, `the scan found only ${armedWorkflows.length} armed workflows, it is not reading them`);
  const witnessed = new Set(
    watchedJobs(registry).map((j) => parseWorkflowRef(registry[j].gh_workflow)).filter((r) => r && r.repo === "otchealth-claude-tools").map((r) => r.file),
  );
  const unwatched = armedWorkflows.filter((f) => !witnessed.has(f) && !(f in NOT_A_ROW));
  assert.deepEqual(unwatched, [], `these workflows run on a cron but no registry row witnesses them, so their silence pages nobody: add a row with gh_workflow (see skills/nightly-schedule-canary/SKILL.md, "Adding a job"):\n  ${unwatched.join("\n  ")}`);
  for (const f of Object.keys(NOT_A_ROW)) assert.ok(armedWorkflows.includes(f), `${f} is exempt but no longer has an armed schedule: drop the exemption`);
});

test("registry: every retired row carries a date", () => {
  const rows = Object.keys(registry).filter((k) => k.startsWith("_retired_"));
  assert.ok(rows.length >= 11);
  for (const k of rows) assert.match(registry[k].retired, /^\d{4}-\d{2}-\d{2}$/, k);
});

test("retired Azure-only monitors: a _retired_ row, no schedule, and a RETIRED banner in the workflow", () => {
  for (const name of ["nightly-embedding-drift", "nightly-recall-eval", "nightly-recall-eval-deep", "nightly-continuity-canary", "oauth-clients-canary", "nightly-s3-dr-mirror"]) {
    assert.ok(registry[`_retired_${name}`], `${name} needs a _retired_ row`);
    assert.equal(name in registry, false, `${name} must not also be watched`);
    const y = read(`.github/workflows/${name}.yml`);
    assert.match(y, /RETIRED 2026-10-07/);
    assert.doesNotMatch(y, /^\s*#?\s*schedule:\s*$/m);
    assert.match(y, /^  workflow_dispatch/m);
  }
});

test("the real registry, judged as the first run after this change sees it, then once the one-time IAM grant and the beat are in", () => {
  const beatOnly = watchedJobs(registry).filter((j) => !registry[j].gh_workflow);
  assert.equal(beatOnly.length, 23, "the ECS-era beat-only jobs");
  const gh = {
    "nightly-aws-dr-canary": sched(run(300, "failure"), run(1700, "failure")),
    "nightly-eval": sched(run(300)),
    "nightly-secrets-dr-export": sched(run(300)),
    "nightly-token-age-metrics": sched(run(300)),
    "nightly-fleet-medic": sched(run(300)), // otchealth-mcp-server is public: the job token or an anonymous read answers
    "stale-pr-closer": sched(run(300)),
    "codex-continuity-lane": sched(run(600, "failure"), run(10680, "failure")),
    "sentinel-watchdog": sched(), // armed, no scheduled run yet
    "aws-health-monitor": { ok: false, error: "GitHub HTTP 404 for otchealth-cto/aws-health-monitor.yml (tried a token, then anonymous; private repo or no such file)" },
  };
  const first = evaluateSilence({ registry, beatRows: null, beatError: diagnoseBeatStoreFailure("exit 1: AccessDenied"), schedule: gh, nowMs: NOW });
  assert.equal(summarizeStates(first.results), "LIVE 5, PENDING 1, FAILING 2, UNWITNESSED 1, UNREADABLE 23");
  assert.equal(state(first, "aws-health-monitor"), "UNWITNESSED");
  assert.equal(state(first, "nightly-fleet-medic"), "LIVE");
  assert.equal(state(first, "sentinel-watchdog"), "PENDING");
  assert.deepEqual(first.anomalies.filter((r) => r.state !== "UNREADABLE").map((r) => r.job), ["aws-health-monitor", "codex-continuity-lane", "nightly-aws-dr-canary"]);

  const beats = [...beatOnly.map((job) => ({ job, ageMin: 30, consecutive_fail: 0 })), { job: "aws-health-monitor", ageMin: 40, consecutive_fail: 0 }, { job: "nightly-aws-dr-canary", ageMin: 100, consecutive_fail: 0 }];
  const granted = evaluateSilence({ registry, beatRows: beats, beatError: null, schedule: gh, nowMs: NOW });
  assert.deepEqual(granted.anomalies.map((r) => r.job), ["codex-continuity-lane"], "only a real failure is left once every job can be seen");
  assert.equal(row(granted, "aws-health-monitor").witness, "beat");
  assert.equal(row(granted, "nightly-aws-dr-canary").witness, "beat", "the beat decides first; the canary's own pager reports its content failures");
});

test("the checker workflow pages through the GitHub-issue pager and carries no Azure or self-beat leftovers", () => {
  const y = read(".github/workflows/nightly-fleet-sentinels.yml");
  assert.match(y, /^  schedule:\s*$/m);
  assert.match(y, /cron: '20 5 \* \* \*'/);
  for (const perm of ["id-token: write", "actions: read", "issues: write", "contents: read"]) assert.ok(y.includes(perm), perm);
  assert.match(y, /set -o pipefail/);
  assert.match(y, /schedule-canary\.mjs --strict/);
  assert.match(y, /name: "Silence monitor: heartbeat age against cadence/);
  assert.match(y, /if: failure\(\)/);
  assert.match(y, /page-on-failure\.mjs --workflow "Nightly Fleet Sentinels" --github-issue "\[FLEET-ALERT\] nightly-fleet-sentinels"/);
  assert.match(y, /FLEET_WATCH_GH_TOKEN: \$\{\{ secrets\.FLEET_WATCH_GH_TOKEN \}\}/, "the PAT stays an optional extra, wired but never required");
  assert.match(y, /GITHUB_TOKEN: \$\{\{ github\.token \}\}/);
  assert.doesNotMatch(y, /azure\/login|AZURE_/i);
  assert.doesNotMatch(y, /heartbeat\.mjs beat/);
});

test("paging mentions the owner by default: every GitHub-issue pager defaults to a handle GitHub will notify", () => {
  // The task text said 'GBGolfMatt', but setup/alert-issue.mjs's parseMentions keeps only handles with a leading at sign, so a bare
  // login is dropped in silence and the page notifies nobody. The default therefore carries the at sign.
  assert.equal(parseMentions("@GBGolfMatt"), "@GBGolfMatt");
  assert.equal(parseMentions("GBGolfMatt"), "", "a bare login is dropped, which is why the default has the at sign");
  const pagerCall = /^\s+run: .*page-on-failure\.mjs[^\n]*--github-issue/m; // the run line, not a comment that mentions the flag
  const pagers = workflowFiles.filter((f) => pagerCall.test(read(`.github/workflows/${f}`)));
  assert.ok(pagers.length >= 5, `the scan found only ${pagers.length} workflows using the issue pager`);
  for (const f of pagers) {
    const y = read(`.github/workflows/${f}`);
    assert.match(y, /^ {10}PAGE_GITHUB_MENTION: \$\{\{ vars\.FLEET_ALERT_MENTION \|\| '@GBGolfMatt' \}\}$/m, `${f} must default PAGE_GITHUB_MENTION to the owner`);
    const perms = y.match(/^permissions:\n((?: {2}.*\n)+)/m)?.[1] ?? "";
    assert.match(perms, /^ {2}issues: write\b/m, `${f}: the issue pager needs issues: write or GitHub answers 403`);
    const lines = y.split("\n");
    const at = lines.findIndex((l) => pagerCall.test(l));
    let start = at;
    while (start > 0 && !/^ {6}- name:/.test(lines[start])) start--;
    const step = lines.slice(start, at + 1).join("\n");
    assert.match(step, /GITHUB_TOKEN: \$\{\{ github\.token \}\}/, `${f}: the page step must carry the job token`);
    assert.match(step, /if: failure\(\)/, `${f}: the page step fires on failure`);
  }
});
