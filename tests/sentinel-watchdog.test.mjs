// The sentinel watchdog (skills/nightly-schedule-canary/sentinel-watchdog.mjs + .github/workflows/sentinel-watchdog.yml):
// "who watches the watcher". Hermetic: the GitHub API is a fake fetch, the CLI runs against a stubbed global fetch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  IN_FLIGHT_GRACE_MIN, WATCHDOG_LIMIT_MIN, WATCHED_WORKFLOW, evaluateWatchdog, fetchSentinelRuns, renderWatchdog, runAgeMin,
} from "../skills/nightly-schedule-canary/sentinel-watchdog.mjs";
import { extractFailedChecks, redactSecrets } from "../setup/alert-issue.mjs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const NOW = Date.parse("2026-10-08T20:00:00Z");
const ago = (min) => new Date(NOW - min * 60000).toISOString();
const done = (minAgo, conclusion = "success", event = "schedule", id = minAgo) => ({ id, status: "completed", conclusion, event, created_at: ago(minAgo + 5), run_started_at: ago(minAgo + 5), updated_at: ago(minAgo) });
const live = (minAgo, status = "in_progress") => ({ id: 9, status, conclusion: null, event: "schedule", created_at: ago(minAgo), run_started_at: ago(minAgo), updated_at: ago(minAgo) });
const judge = (runs) => evaluateWatchdog({ runs, nowMs: NOW });

test("constants: 26 hours, the monitor's own workflow file", () => {
  assert.equal(WATCHDOG_LIMIT_MIN, 26 * 60);
  assert.equal(IN_FLIGHT_GRACE_MIN, 60);
  assert.equal(WATCHED_WORKFLOW, "nightly-fleet-sentinels.yml");
  assert.ok(existsSync(new URL(`../.github/workflows/${WATCHED_WORKFLOW}`, import.meta.url)), "the watched workflow file must exist");
});

test("runAgeMin: a finished run counts from its completion, a run in flight from its start", () => {
  assert.equal(runAgeMin(done(120), NOW), 120);
  assert.equal(runAgeMin({ status: "completed", conclusion: "success", created_at: ago(300) }, NOW), 300, "falls back to created_at");
  assert.equal(runAgeMin(live(20), NOW), 20);
  assert.equal(runAgeMin({ status: "in_progress", created_at: ago(40), updated_at: ago(1) }, NOW), 40, "in flight: updated_at is just a heartbeat of the run");
  assert.equal(runAgeMin({ status: "completed" }, NOW), null);
  assert.equal(runAgeMin(null, NOW), null);
});

test("alive: a completed run inside the limit, success or failure, from any trigger", () => {
  for (const r of [done(300), done(300, "failure"), done(300, "success", "workflow_dispatch")]) {
    const v = judge([r]);
    assert.equal(v.ok, true, JSON.stringify(r));
    assert.equal(v.state, "ALIVE");
  }
  assert.match(judge([done(300, "failure")]).detail, /^alive: a schedule run that is failure, 5h old \(run 300\), limit 26h$/);
});

test("alive vs silent at the 26 hour boundary", () => {
  assert.equal(judge([done(25 * 60 + 59)]).ok, true);
  assert.equal(judge([done(26 * 60)]).ok, true);
  const silent = judge([done(26 * 60 + 1)]);
  assert.equal(silent.ok, false);
  assert.equal(silent.state, "SILENT");
});

test("a run that completed long after it was created counts from when it completed", () => {
  const rerun = { id: 5, status: "completed", conclusion: "success", event: "schedule", created_at: ago(30 * 60), run_started_at: ago(30 * 60), updated_at: ago(120) };
  assert.equal(judge([rerun]).ok, true);
});

test("a run still queued or in progress is proof only for an hour (a hung run is not)", () => {
  assert.equal(judge([live(30)]).ok, true);
  assert.equal(judge([live(30, "queued")]).ok, true);
  assert.equal(judge([live(61), done(40 * 60)]).ok, false);
  assert.match(judge([live(61)]).detail, /newest run on record is a schedule run that is in_progress, 1h old/);
});

test("cancelled, timed out and skipped runs are not proof the monitor can finish", () => {
  for (const c of ["cancelled", "timed_out", "skipped", "startup_failure", "neutral", "action_required"]) {
    const v = judge([done(60, c), done(30 * 60)]);
    assert.equal(v.ok, false, c);
    assert.match(v.detail, new RegExp(`newest run on record is a schedule run that is ${c}, 1h old`));
    assert.match(v.detail, /not proof the monitor can finish/);
  }
  assert.equal(judge([done(60, "cancelled"), done(300)]).ok, true, "an older real run inside the limit still counts");
});

test("silent with nothing on record, with junk rows, and with rows that have no timestamps", () => {
  assert.match(judge([]).detail, /there is no run on record/);
  assert.equal(judge(undefined).ok, false);
  assert.equal(judge([null, 7, "x", {}, { status: "completed", conclusion: "success" }]).ok, false);
});

test("timing: ordinary GitHub lateness never pages, a whole missed monitor day does", () => {
  // The monitor's cron is 05:20 UTC and GitHub starts it about 5-9 hours late; the watchdog's is 13:50 UTC, started about 5-9 hours late too.
  const at = (watchdogIso, monitorRunIsos) => evaluateWatchdog({ runs: monitorRunIsos.map((iso) => ({ id: 1, status: "completed", conclusion: "success", event: "schedule", updated_at: iso })), nowMs: Date.parse(watchdogIso) });
  assert.equal(at("2026-10-08T19:00:00Z", ["2026-10-08T14:36:00Z"]).ok, true, "latest monitor run today, earliest watchdog");
  assert.equal(at("2026-10-08T23:10:00Z", ["2026-10-08T10:30:00Z"]).ok, true, "earliest monitor run today, latest watchdog: 12h40m");
  assert.equal(at("2026-10-08T19:00:00Z", ["2026-10-07T14:36:00Z"]).ok, false, "the monitor skipped today: 28h24m at the earliest watchdog run");
  assert.equal(at("2026-10-08T23:10:00Z", ["2026-10-07T10:30:00Z"]).ok, false, "and 36h40m at the latest");
});

test("renderWatchdog emits lines the pager extracts and does not redact", () => {
  const silent = renderWatchdog(judge([done(30 * 60, "success", "schedule", 37669544722)]));
  assert.equal(silent.length, 1);
  assert.match(silent[0], /^\[STALE {3}\] nightly-fleet-sentinels: SILENT -- no run of nightly-fleet-sentinels\.yml completed inside the last 26h/);
  assert.match(silent[0], /newest run on record is a schedule run that is success, 30h old \(run 37669544722\)/);
  assert.match(silent[0], /dispatch it once by hand/);
  assert.equal(extractFailedChecks(silent).length, 1);
  assert.equal(redactSecrets(extractFailedChecks(silent)[0]), extractFailedChecks(silent)[0]);
  assert.deepEqual(renderWatchdog(judge([done(60)])), []);
  const unreadable = renderWatchdog(null, "GitHub API HTTP 403; the job needs the permission actions: read and the workflow file must exist");
  assert.match(unreadable[0], /^\[ERROR {3}\] sentinel-watchdog: cannot read the run history of nightly-fleet-sentinels\.yml \(GitHub API HTTP 403/);
  assert.equal(extractFailedChecks(unreadable).length, 1);
});

const okJson = (runs) => ({ ok: true, status: 200, json: async () => ({ workflow_runs: runs }) });
const noSleep = async () => {};

test("fetchSentinelRuns: one authenticated call for the last 20 runs of every event", async () => {
  const calls = [];
  const r = await fetchSentinelRuns({
    repo: "o/r", token: "tok", sleep: noSleep,
    fetchImpl: async (url, init) => { calls.push({ url, init }); return okJson([done(5)]); },
  });
  assert.equal(r.ok, true);
  assert.equal(r.runs.length, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.github.com/repos/o/r/actions/workflows/nightly-fleet-sentinels.yml/runs?per_page=20");
  assert.equal(calls[0].init.headers.Authorization, "Bearer tok");
  assert.doesNotMatch(calls[0].url, /event=/, "all events: a manual run proves the workflow can run");
});

test("fetchSentinelRuns: a configuration error is not retried, a transient one is, and the token never leaks", async () => {
  let n = 0;
  const denied = await fetchSentinelRuns({ repo: "o/r", token: "tok", sleep: noSleep, fetchImpl: async () => { n++; return { ok: false, status: 403 }; } });
  assert.equal(n, 1);
  assert.equal(denied.ok, false);
  assert.match(denied.error, /HTTP 403; the job needs the permission actions: read/);

  let m = 0;
  const flaky = await fetchSentinelRuns({ repo: "o/r", token: "tok", sleep: noSleep, fetchImpl: async () => (++m === 1 ? { ok: false, status: 502 } : okJson([done(5)])) });
  assert.equal(m, 2);
  assert.equal(flaky.ok, true);

  const down = await fetchSentinelRuns({ repo: "o/r", token: "tok-secret-9", sleep: noSleep, fetchImpl: async () => { throw new Error("connect failed for tok-secret-9"); } });
  assert.equal(down.ok, false);
  assert.match(down.error, /GitHub API call failed: connect failed for \*\*\*/);
  assert.doesNotMatch(down.error, /tok-secret-9/);

  const slow = await fetchSentinelRuns({ repo: "o/r", token: "tok", sleep: noSleep, fetchImpl: async () => { const e = new Error("aborted"); e.name = "AbortError"; throw e; } });
  assert.match(slow.error, /timed out/);

  const naps = [];
  await fetchSentinelRuns({ repo: "o/r", token: "tok", backoffMs: 1234, sleep: async (ms) => { naps.push(ms); }, fetchImpl: async () => ({ ok: false, status: 500 }) });
  assert.deepEqual(naps, [1234], "one backoff between the two attempts");
});

test("fetchSentinelRuns refuses to guess: a missing repo or token is an explicit error", async () => {
  const never = async () => assert.fail("must not call the API");
  assert.match((await fetchSentinelRuns({ repo: "", token: "t", fetchImpl: never })).error, /GITHUB_REPOSITORY/);
  assert.match((await fetchSentinelRuns({ repo: "nonsense", token: "t", fetchImpl: never })).error, /GITHUB_REPOSITORY/);
  assert.match((await fetchSentinelRuns({ repo: "o/r", token: "", fetchImpl: never })).error, /GITHUB_TOKEN/);
});

// End to end: run the real script as a child process with a stubbed global fetch (--import of a data: module).
const SCRIPT = fileURLToPath(new URL("../skills/nightly-schedule-canary/sentinel-watchdog.mjs", import.meta.url));
function cli({ runs, status = 200, env = {} }) {
  const stub = `globalThis.fetch = async () => ({ ok: ${status === 200}, status: ${status}, json: async () => ({ workflow_runs: ${JSON.stringify(runs || [])} }) });`;
  const r = spawnSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(stub)}`, SCRIPT], {
    encoding: "utf8", timeout: 30000, env: { PATH: process.env.PATH, GITHUB_REPOSITORY: "o/r", GITHUB_TOKEN: "tok", ...env },
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}
const iso = (minAgo) => new Date(Date.now() - minAgo * 60000).toISOString();
const wireRun = (minAgo, conclusion = "success") => ({ id: 77, status: "completed", conclusion, event: "schedule", created_at: iso(minAgo + 5), updated_at: iso(minAgo) });

test("CLI: exit 0 when the monitor ran recently, exit 1 with an extractable line when it did not", () => {
  const alive = cli({ runs: [wireRun(240)] });
  assert.equal(alive.code, 0, alive.out);
  assert.match(alive.out, /\[sentinel-watchdog\] OK: the silence monitor is running/);

  const failing = cli({ runs: [wireRun(240, "failure")] });
  assert.equal(failing.code, 0, "a red monitor run means the monitor ran: its own pager handles the findings");

  const silent = cli({ runs: [wireRun(40 * 60)] });
  assert.equal(silent.code, 1, silent.out);
  assert.match(silent.out, /^\[STALE {3}\] nightly-fleet-sentinels: SILENT -- /m);
  assert.match(silent.out, /SILENCE = FAILURE: the silence monitor itself is not running/);
  assert.equal(extractFailedChecks([silent.out]).length, 1);

  const empty = cli({ runs: [] });
  assert.equal(empty.code, 1);
});

test("CLI: an unreadable run history is a failure with an [ERROR] line, never a silent pass", () => {
  const denied = cli({ runs: [], status: 403 });
  assert.equal(denied.code, 1, denied.out);
  assert.match(denied.out, /^\[ERROR {3}\] sentinel-watchdog: cannot read the run history/m);
  assert.match(denied.out, /dark sensor/);
  const noToken = cli({ runs: [wireRun(10)], env: { GITHUB_TOKEN: "" } });
  assert.equal(noToken.code, 1);
  assert.match(noToken.out, /GITHUB_TOKEN is not in this step's environment/);
});

test("the watchdog is independent: it imports nothing but node builtins", () => {
  const src = read("skills/nightly-schedule-canary/sentinel-watchdog.mjs");
  const specs = [...src.matchAll(/^import\b[^"']*["']([^"']+)["']/gm)].map((m) => m[1]);
  assert.ok(specs.length >= 1);
  for (const s of specs) assert.match(s, /^node:/, `${s}: a bug that breaks the monitor must not also break its watchdog`);
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n"); // comments name the files it must not import
  assert.doesNotMatch(code, /schedule-canary\.mjs|alert-issue|heartbeat\.mjs/, "no code reference to the monitor, the pager or the beat store");
  assert.doesNotMatch(code, /\bimport\s*\(|\brequire\s*\(/, "no dynamic imports or require either");
});

test("registry: the monitor watches the watchdog, the watchdog watches the monitor", () => {
  const registry = JSON.parse(read("setup/heartbeat-registry.json"));
  const row = registry["sentinel-watchdog"];
  assert.ok(row, "the watchdog needs a registry row");
  assert.equal(row.gh_workflow, "InnerScopeHearing/otchealth-claude-tools/sentinel-watchdog.yml");
  assert.match(row.armed, /^\d{4}-\d{2}-\d{2}$/, "armed gives the first scheduled run time to appear, so day one is not a false alarm");
  assert.ok(existsSync(new URL("../.github/workflows/sentinel-watchdog.yml", import.meta.url)));
  assert.equal("nightly-fleet-sentinels" in registry, false, "the monitor is not a row: only the watchdog can watch it");
  assert.match(registry["_retired_nightly-fleet-sentinels"].note, /sentinel-watchdog/);
  assert.equal(WATCHED_WORKFLOW, "nightly-fleet-sentinels.yml");
});

const y = read(".github/workflows/sentinel-watchdog.yml");
const stepText = (pattern) => {
  const lines = y.split("\n");
  const start = lines.findIndex((l) => /^ {6}- name:/.test(l) && pattern.test(l));
  assert.notEqual(start, -1, `step matching ${pattern} exists`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) if (/^ {6}- name:/.test(lines[i])) { end = i; break; }
  return { text: lines.slice(start, end).join("\n"), index: start };
};

test("workflow: a daily cron offset from the monitor's, manual dispatch, and exactly the permissions it needs", () => {
  assert.match(y, /^name: Sentinel Watchdog$/m);
  assert.match(y, /^  schedule:\s*$/m);
  assert.match(y, /cron: '50 13 \* \* \*'/);
  assert.doesNotMatch(y, /cron: '20 5 /, "must not share the monitor's 05:20 slot");
  assert.match(y, /^  workflow_dispatch: \{\}$/m);
  const perms = y.match(/^permissions:\n((?: {2}.*\n)+)/m)?.[1] ?? "";
  assert.match(perms, /^ {2}actions: read\b/m);
  assert.match(perms, /^ {2}issues: write\b/m);
  assert.match(perms, /^ {2}contents: read\b/m);
  assert.doesNotMatch(perms, /id-token/, "no AWS role: it needs nothing but GITHUB_TOKEN");
  assert.doesNotMatch(y, /role-to-assume|aws-actions|azure\/login|secrets\.(?!POSTHOG_FLEET_INGEST_KEY)/);
  assert.match(y, /group: sentinel-watchdog/);
});

test("workflow: the watchdog step cannot swallow its own failure and the pager fires on failure with the owner mentioned", () => {
  const dog = stepText(/Watchdog: newest completed/).text;
  assert.match(dog, /^ {8}id: watchdog$/m);
  assert.match(dog, /set -o pipefail/);
  assert.match(dog, /sentinel-watchdog\.mjs 2>&1 \| tee "\$\{GITHUB_WORKSPACE\}\/sentinel-watchdog\.log"/);
  assert.match(dog, /GITHUB_TOKEN: \$\{\{ github\.token \}\}/);
  assert.doesNotMatch(dog, /continue-on-error/);

  const page = stepText(/Page on failure/).text;
  assert.match(page, /if: failure\(\)/);
  assert.match(page, /GITHUB_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(page, /PAGE_GITHUB_MENTION: \$\{\{ vars\.FLEET_ALERT_MENTION \|\| '@GBGolfMatt' \}\}/);
  assert.match(page, /PAGE_STEP_OUTCOMES: "watchdog=\$\{\{ steps\.watchdog\.outcome \}\}"/);
  assert.match(page, /page-on-failure\.mjs --workflow "Sentinel Watchdog" --github-issue "\[FLEET-ALERT\] sentinel-watchdog" --tail-lines 60 --log "\$\{GITHUB_WORKSPACE\}\/sentinel-watchdog\.log"/);
  assert.doesNotMatch(page, /continue-on-error/);
  assert.ok(page.length > 0 && stepText(/Page on failure/).index > stepText(/Upload watchdog log/).index);
  assert.match(stepText(/Upload watchdog log/).text, /if: always\(\)/);
});

test("workflow: every step name containing a colon is quoted (an unquoted one fails the workflow at startup, 0 jobs)", () => {
  for (const line of y.split("\n")) {
    const m = line.match(/^ {6}- name: (.*)$/);
    if (!m) continue;
    const value = m[1].trim();
    if (value.startsWith('"') || value.startsWith("'")) continue;
    assert.doesNotMatch(value, /: |:$/, `unquoted step name with a colon: ${value}`);
  }
});

test("workflow: actions are pinned to full commit SHAs, the same pins as the monitor", () => {
  const monitor = read(".github/workflows/nightly-fleet-sentinels.yml");
  const uses = (text) => [...text.matchAll(/uses: (\S+@[0-9a-f]{40})/g)].map((m) => m[1]);
  assert.ok(uses(y).length >= 3);
  for (const u of uses(y)) assert.ok(uses(monitor).includes(u), `${u} is not pinned the same way in nightly-fleet-sentinels.yml`);
  assert.doesNotMatch(y, /uses: \S+@(?![0-9a-f]{40}\b)\S+/, "every action must be pinned to a full SHA");
});
