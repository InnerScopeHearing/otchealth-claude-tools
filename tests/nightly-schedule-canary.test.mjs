// The silence monitor (skills/nightly-schedule-canary/schedule-canary.mjs): hermetic tests for the verdict
// logic, the GitHub schedule witness (fake fetch), the registry's hygiene and the workflow wiring.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import {
  MIN_STALE_FLOOR_MIN, diagnoseBeatStoreFailure, evaluateSilence, fetchScheduledRuns, pageExitCode, parseWorkflowRef,
  renderAttention, retiredBeatNames, staleAfterMin, summarizeScheduledRuns, tokenForRepo, watchedJobs,
} from "../skills/nightly-schedule-canary/schedule-canary.mjs";
import { extractFailedChecks, redactSecrets } from "../setup/alert-issue.mjs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const registry = JSON.parse(read("setup/heartbeat-registry.json"));
const NOW = Date.parse("2026-10-07T12:00:00Z");
const run = (minAgo, conclusion = "success", status = "completed") => ({ created_at: new Date(NOW - minAgo * 60000).toISOString(), status, conclusion, html_url: `https://example.test/runs/${minAgo}` });
const sched = (...runs) => ({ ok: true, summary: summarizeScheduledRuns(runs, NOW) });
const REG = {
  beater: { interval_min: 60, owner: "cto" },
  nightly: { interval_min: 1560, max_age_min: 2160, owner: "cto", gh_workflow: "o/r/nightly.yml" },
  _retired_gone: { retired: "2026-10-07", beats: ["gone-beat"] },
};
const GOOD = [{ job: "beater", status: "LIVE", ageMin: 30, consecutive_fail: 0 }];
const verdict = (beatRows, schedule = { nightly: sched(run(300)) }, beatError = null) => evaluateSilence({ registry: REG, beatRows, beatError, schedule });
const state = (v, job) => v.results.find((r) => r.job === job)?.state;

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

test("tokenForRepo: own repo uses GITHUB_TOKEN, any other repo needs FLEET_WATCH_GH_TOKEN", () => {
  const env = { GITHUB_REPOSITORY: "O/R", GITHUB_TOKEN: "own", FLEET_WATCH_GH_TOKEN: "pat" };
  assert.equal(tokenForRepo({ owner: "o", repo: "r" }, env), "own");
  assert.equal(tokenForRepo({ owner: "o", repo: "other" }, env), "pat");
  assert.equal(tokenForRepo({ owner: "o", repo: "other" }, { GITHUB_REPOSITORY: "O/R", GITHUB_TOKEN: "own" }), "");
});

test("fetchScheduledRuns: success, HTTP error and thrown error; the token never leaks into an error", async () => {
  const ref = { owner: "o", repo: "r", file: "w.yml" };
  const ok = await fetchScheduledRuns(ref, "tok", async (url, init) => {
    assert.match(url, /\/repos\/o\/r\/actions\/workflows\/w\.yml\/runs\?event=schedule/);
    assert.equal(init.headers.Authorization, "Bearer tok");
    return { ok: true, status: 200, json: async () => ({ workflow_runs: [run(5)] }) };
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.runs.length, 1);
  const nf = await fetchScheduledRuns(ref, "tok-secret-1", async () => ({ ok: false, status: 404 }));
  assert.equal(nf.ok, false);
  assert.match(nf.error, /HTTP 404/);
  assert.doesNotMatch(nf.error, /tok-secret-1/);
  const boom = await fetchScheduledRuns(ref, "tok-secret-2", async () => { throw new Error("connect failed for tok-secret-2"); });
  assert.equal(boom.ok, false);
  assert.doesNotMatch(boom.error, /tok-secret-2/);
  const none = await fetchScheduledRuns(ref, "", async () => assert.fail("must not call the API without a token"));
  assert.match(none.error, /FLEET_WATCH_GH_TOKEN/);
});

test("evaluateSilence: a fresh beat and a firing cron are LIVE and do not page", () => {
  const v = verdict(GOOD);
  assert.equal(v.ok, true);
  assert.equal(state(v, "beater"), "LIVE");
  assert.equal(v.results.find((r) => r.job === "nightly").witnessed, "github");
});

test("evaluateSilence judges the AGE of the beat, not its last status", () => {
  const stale = verdict([{ job: "beater", status: "LIVE", ageMin: 400, consecutive_fail: 0 }]);
  assert.equal(state(stale, "beater"), "STALE");
  assert.equal(stale.ok, false);
  assert.equal(state(verdict([]), "beater"), "NO-DATA");
  assert.equal(state(verdict([{ job: "beater", ageMin: 30, consecutive_fail: 2 }]), "beater"), "FAILING");
});

test("evaluateSilence: the GitHub witness catches failing, silent, absent and unreachable schedules", () => {
  assert.equal(state(verdict(GOOD, { nightly: sched(run(300, "failure"), run(1700, "failure")) }), "nightly"), "FAILING");
  assert.equal(state(verdict(GOOD, { nightly: sched(run(3000)) }), "nightly"), "STALE");
  assert.equal(state(verdict(GOOD, { nightly: sched() }), "nightly"), "STALE");
  const u = verdict(GOOD, { nightly: { ok: false, error: "GitHub API HTTP 404 reading o/r/nightly.yml" } });
  assert.equal(state(u, "nightly"), "UNVERIFIABLE");
  assert.equal(u.ok, false);
  assert.match(u.results.find((r) => r.job === "nightly").detail, /HTTP 404/);
});

test("an unreadable beat store is UNREADABLE for beat-only jobs but never hides what GitHub can see", () => {
  const v = verdict(null, undefined, "MISSING PERMISSION for the checker's AWS role");
  assert.equal(state(v, "beater"), "UNREADABLE");
  assert.equal(state(v, "nightly"), "LIVE");
  assert.equal(v.ok, false);
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
  }
  assert.equal("nightly-fleet-sentinels" in registry, false, "a monitor cannot watch its own silence");
});

test("registry: the GitHub-witnessed nightly rows are exactly the live scheduled jobs, and same-repo ones have an armed cron", () => {
  const names = watchedJobs(registry).filter((j) => registry[j].kind === "nightly-workflow");
  assert.deepEqual(names, ["aws-health-monitor", "nightly-aws-dr-canary", "nightly-eval", "nightly-fleet-medic", "nightly-secrets-dr-export", "nightly-token-age-metrics"]);
  for (const job of names) {
    assert.equal(registry[job].owner, "cto");
    const ref = parseWorkflowRef(registry[job].gh_workflow);
    if (ref.repo !== "otchealth-claude-tools") continue;
    const p = `.github/workflows/${ref.file}`;
    assert.ok(existsSync(new URL(`../${p}`, import.meta.url)), `${p} must exist`);
    assert.match(read(p), /^  schedule:\s*$/m, `${p} must have an armed schedule`);
  }
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
  assert.match(y, /FLEET_WATCH_GH_TOKEN: \$\{\{ secrets\.FLEET_WATCH_GH_TOKEN \}\}/);
  assert.doesNotMatch(y, /azure\/login|AZURE_/i);
  assert.doesNotMatch(y, /heartbeat\.mjs beat/);
});
