#!/usr/bin/env node
// drift-sentinel.mjs — A12-DRIFT-SENTINEL (P0 stability, 2026-07-05). Thin orchestrator that
// consolidates the fleet's THREE separate drift/liveness checks —
//   heartbeat.mjs check   (silence = failure: which scheduled jobs are LATE/DEAD)
//   image-drift.mjs       (mutable ":latest"-style tags instead of immutable @sha256 pins)
//   drift-recon.mjs       (pinned-but-STALE @sha256 digests vs what main currently builds)
// — into ONE combined report + ONE overall exit code, so a single heartbeat entry
// ("drift-sentinel") represents "is the fleet's config/identity/digest posture healthy" instead of
// a human having to check three separate job outputs individually. Same execFileSync-each pattern
// already used by skills/doc-indexer/job/nightly.sh's "fleet watcher" block (which calls all three
// scripts sequentially and staged the concatenated stdout to commons) — this formalizes that same
// idea as its own standalone, heartbeat-able, --json-able job rather than a shell block buried
// inside the nightly digest job.
//
// Design: runs each sub-check as a child process (execFileSync, matching this fleet's established
// "shell out to the existing script, don't re-implement its logic" convention — heartbeat.mjs,
// image-drift.mjs and drift-recon.mjs each already have their own ARM/creds/output-shape logic and
// this orchestrator must not duplicate or fork it). Captures stdout+exit code from each, always
// with --json so this script can parse structured findings rather than scrape text. A sub-check
// that exits non-zero-but-report-only (these three all report-only by exit 0 unless the caller
// passes --strict) is treated as "ran cleanly, has N findings" — drift-sentinel decides pass/fail
// for the COMBINED signal itself by inspecting each sub-check's own JSON output, then re-invokes
// nothing with --strict itself (sub-scripts always run in --json report mode here; the STRICT
// decision belongs to drift-sentinel's own combined verdict, not to each child's own exit code).
//
// A sub-check that fails to even RUN (script crash, missing creds -> exit 78, ARM unreachable) is
// distinguished from a sub-check that ran fine and FOUND drift — both make the combined report
// non-clean, but the detail lines say which happened.
//
// This script is itself wrapped in a heartbeat.mjs beat start/ok/fail pair (same semantics as
// setup/with-heartbeat.sh: start before running, ok if the combined run found nothing needing
// attention, fail --detail "<summary>" otherwise), so `node setup/heartbeat.mjs check` alone shows
// whether the fleet's config/identity/digest posture is healthy without a human separately reading
// three different job outputs. Fail-open on the heartbeat call itself (a heartbeat outage never
// blocks or masks this script's own real exit code) — matches with-heartbeat.sh's own fail-open
// contract exactly, just reimplemented here (not shelling to bash) so this stays a pure-Node,
// dependency-free script.
//
// Usage:
//   node setup/drift-sentinel.mjs [--json] [--strict] [--skip heartbeat,image-drift,drift-recon]
//     [--no-beat]                 # skip the heartbeat.mjs beat start/ok/fail wrapper entirely
//     [-- <extra args forwarded to drift-recon.mjs, e.g. --jobs a,b,c or --registry X>]
//
// Exit codes: 0 = combined report clean OR --strict not passed; 3 = --strict AND any sub-check
// either found drift/DEAD-or-LATE jobs OR crashed; 1 = unexpected harness error.

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, def) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : def; };

const dashIdx = argv.indexOf("--");
const extraArgs = dashIdx >= 0 ? argv.slice(dashIdx + 1) : [];
const skipSet = new Set((opt("--skip", "") || "").split(",").map((s) => s.trim()).filter(Boolean));
const doBeat = !flag("--no-beat");
const JOB_NAME = "drift-sentinel";

function runSub(name, scriptRelPath, leadingCliArgs = [], trailingCliArgs = []) {
  if (skipSet.has(name)) {
    return { name, ran: false, status: "SKIPPED", detail: "excluded via --skip", raw: null };
  }
  const scriptPath = join(HERE, scriptRelPath);
  try {
    // heartbeat.mjs takes a leading subcommand ("check") before its flags; image-drift.mjs and
    // drift-recon.mjs are flags-only. leadingCliArgs go before --json so heartbeat.mjs's argv[0]
    // subcommand dispatch still sees "check" first.
    const stdout = execFileSync("node", [scriptPath, ...leadingCliArgs, "--json", ...trailingCliArgs], {
      encoding: "utf8",
      timeout: 120_000,
      // Sub-scripts sometimes exit non-zero even in default (non---strict) mode is NOT expected —
      // all three default to exit 0 — but if a sub-script's own creds/env is missing it exits 78
      // (EX_CONFIG) or 1. Capture that instead of throwing so drift-sentinel can report it as a
      // structured finding rather than crashing the whole orchestrator.
      stdio: ["ignore", "pipe", "pipe"],
    });
    return parseSubOutput(name, stdout, 0, null);
  } catch (e) {
    // execFileSync throws on non-zero exit; e.stdout/e.status/e.stderr are still populated.
    const stdout = e.stdout ? e.stdout.toString("utf8") : "";
    const stderr = e.stderr ? e.stderr.toString("utf8") : "";
    if (stdout.trim()) return parseSubOutput(name, stdout, e.status ?? 1, stderr);
    return { name, ran: false, status: "CRASHED", detail: `exit ${e.status ?? "?"}: ${(stderr || e.message).slice(0, 300)}`, raw: null };
  }
}

// Interpret each sub-script's own --json shape (each is stable/documented in its own file) to
// extract a pass/fail verdict + a one-line human summary, without re-implementing its logic.
function parseSubOutput(name, stdout, exitCode, stderr) {
  let parsed;
  try { parsed = JSON.parse(stdout); } catch {
    return { name, ran: true, status: "UNPARSEABLE", detail: `exit ${exitCode}, non-JSON output (${(stderr || "").slice(0, 200) || stdout.slice(0, 200)})`, raw: stdout };
  }
  if (name === "heartbeat") {
    const rows = Array.isArray(parsed) ? parsed : [];
    const bad = rows.filter((r) => r.status === "DEAD" || r.status === "LATE" || r.consecutive_fail > 0 || r.armFailed);
    return {
      name, ran: true, status: bad.length ? "FAIL" : "OK",
      detail: bad.length ? `${bad.length}/${rows.length} job(s) need attention: ${bad.map((r) => r.job).join(", ")}` : `${rows.length} job(s), all LIVE`,
      raw: parsed,
    };
  }
  if (name === "image-drift") {
    const rows = Array.isArray(parsed) ? parsed : [];
    const drift = rows.filter((r) => !r.pinned);
    return {
      name, ran: true, status: drift.length ? "FAIL" : "OK",
      detail: drift.length ? `${drift.length}/${rows.length} resource(s) on MUTABLE tags: ${drift.map((r) => r.name).join(", ")}` : `${rows.length} resource(s), all pinned`,
      raw: parsed,
    };
  }
  if (name === "drift-recon") {
    const rows = Array.isArray(parsed?.jobs) ? parsed.jobs : [];
    const stale = rows.filter((r) => r.status === "STALE");
    const unpinned = rows.filter((r) => r.status === "UNPINNED");
    const bad = [...stale, ...unpinned];
    return {
      name, ran: true, status: bad.length ? "FAIL" : "OK",
      detail: bad.length ? `${stale.length} STALE + ${unpinned.length} UNPINNED of ${rows.length}: ${bad.map((r) => r.name).join(", ")}` : `${rows.length} job(s) checked, all CURRENT`,
      raw: parsed,
    };
  }
  return { name, ran: true, status: "OK", detail: "ran, no known verdict rule for this sub-check name", raw: parsed };
}

// ── heartbeat.mjs beat wrapper (mirrors with-heartbeat.sh's start/ok/fail semantics, fail-open) ──
function beat(event, detail) {
  if (!doBeat) return;
  try {
    execFileSync("node", [join(HERE, "heartbeat.mjs"), "beat", JOB_NAME, event, ...(detail ? ["--detail", detail] : [])], { stdio: "ignore", timeout: 15_000 });
  } catch { /* fail-open: a heartbeat outage never blocks or masks this script's own exit code */ }
}

(async () => {
  beat("start");

  const results = [
    runSub("heartbeat", "heartbeat.mjs", ["check"]), // heartbeat.mjs dispatches on a leading subcommand
    runSub("image-drift", "image-drift.mjs"),
    runSub("drift-recon", "drift-recon.mjs", [], extraArgs),
  ];

  const crashed = results.filter((r) => r.status === "CRASHED" || r.status === "UNPARSEABLE");
  const failed = results.filter((r) => r.status === "FAIL");
  const ok = results.filter((r) => r.status === "OK");
  const skipped = results.filter((r) => r.status === "SKIPPED");
  const needsAttention = [...crashed, ...failed];

  if (flag("--json")) {
    console.log(JSON.stringify({ job: JOB_NAME, checked_at: new Date().toISOString(), results, summary: { ok: ok.length, failed: failed.length, crashed: crashed.length, skipped: skipped.length } }, null, 2));
  } else {
    console.log(`# DRIFT-SENTINEL — ${results.length} sub-check(s); ${needsAttention.length} needing attention`);
    for (const r of results) {
      const tag = r.status === "OK" ? "OK    " : r.status === "SKIPPED" ? "SKIP  " : r.status === "FAIL" ? "DRIFT " : "CRASH ";
      console.log(`[${tag}] ${r.name.padEnd(14)} ${r.detail}`);
    }
    if (needsAttention.length) console.log(`\nNEEDS ATTENTION: ${needsAttention.map((r) => r.name).join(", ")} — combined fleet config/identity/digest posture is NOT clean.`);
    else console.log(`\nCombined fleet config/identity/digest posture: CLEAN.`);
  }

  const summaryLine = needsAttention.length
    ? `${needsAttention.length}/${results.length} sub-check(s) need attention: ${needsAttention.map((r) => `${r.name}(${r.status})`).join(", ")}`
    : `all ${results.length} sub-check(s) clean`;

  if (needsAttention.length) beat("fail", summaryLine);
  else beat("ok", summaryLine);

  process.exit(flag("--strict") && needsAttention.length ? 3 : 0);
})().catch((e) => {
  beat("fail", `harness error: ${e.message}`);
  console.error("[drift-sentinel] ERROR: " + e.message);
  process.exit(1);
});
