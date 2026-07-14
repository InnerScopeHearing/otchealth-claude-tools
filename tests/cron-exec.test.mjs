// THE TEN-NIGHT FAILURE, ENCODED AS TESTS.
//
// `daily-digest` failed 10 consecutive SCHEDULED runs (2026-07-04 -> 2026-07-13) while every monitor
// called it healthy, because the dead-job sweep judged "the latest execution" -- and every debugging
// re-kick became the latest execution. These tests make that state impossible to ship again.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { scheduledTimeOf, isCronExecution, auditScheduledJob } from "../skills/azure-canary/cron-exec.mjs";

const SKILLS = new URL("../skills/", import.meta.url).pathname;

test("a cron execution name decodes to its exact scheduled slot (verified against live ARM)", () => {
  // daily-digest-29733119 was the real 2026-07-13 execution of cron `59 23 * * *`.
  assert.equal(new Date(scheduledTimeOf("daily-digest-29733119")).toISOString(), "2026-07-13T23:59:00.000Z");
  assert.equal(new Date(scheduledTimeOf("daily-digest-29720159")).toISOString(), "2026-07-04T23:59:00.000Z");
  assert.ok(isCronExecution("daily-digest-29733119"));
});

test("a MANUAL re-kick is never mistaken for a scheduled run", () => {
  // These are the real manual executions from the incident.
  for (const n of ["daily-digest-s7gutka", "daily-digest-56ctg3j", "daily-digest-3qa750b", "daily-digest-yhhxfzr"]) {
    assert.equal(isCronExecution(n), false, `${n} must not be read as a cron execution`);
    assert.equal(scheduledTimeOf(n), null);
  }
});

test("REGRESSION (the whole incident): a FAILED cron hidden behind a PASSING manual re-kick is FLAGGED", () => {
  // This is daily-digest's LITERAL state as of 2026-07-14T00:40Z. The old sweep (top:1) saw
  // "Succeeded" and reported green. It must now fail loud.
  const executions = [
    { name: "daily-digest-s7gutka", status: "Succeeded", startTime: "2026-07-14T00:39:17Z" }, // manual
    { name: "daily-digest-56ctg3j", status: "Succeeded", startTime: "2026-07-14T00:28:08Z" }, // manual
    { name: "daily-digest-29733119", status: "Failed", startTime: "2026-07-13T23:59:00Z" },   // CRON <- the truth
    { name: "daily-digest-yhhxfzr", status: "Succeeded", startTime: "2026-07-13T07:11:16Z" }, // manual
    { name: "daily-digest-29731679", status: "Failed", startTime: "2026-07-12T23:59:00Z" },   // CRON
    { name: "daily-digest-29730239", status: "Failed", startTime: "2026-07-11T23:59:00Z" },   // CRON
  ];
  const f = auditScheduledJob({ name: "daily-digest", executions, nowMs: Date.parse("2026-07-14T00:45:00Z") });
  assert.ok(f.some((x) => /LAST SCHEDULED RUN Failed/.test(x)), "a failed cron behind a green manual MUST page");
  assert.ok(f.some((x) => /manual re-kick does NOT clear this/i.test(x)));
});

test("a job whose last SCHEDULED run passed is clean, even with manual runs interleaved", () => {
  const executions = [
    { name: "dd-aaaaaaa", status: "Failed", startTime: "2026-07-14T01:00:00Z" },  // a manual experiment that failed
    { name: "dd-29733119", status: "Succeeded", startTime: "2026-07-13T23:59:00Z" },
    { name: "dd-29731679", status: "Succeeded", startTime: "2026-07-12T23:59:00Z" },
    { name: "dd-29730239", status: "Succeeded", startTime: "2026-07-11T23:59:00Z" },
  ];
  // A failed MANUAL run must not page the schedule -- symmetry matters, or the canary cries wolf.
  assert.deepEqual(auditScheduledJob({ name: "dd", executions, nowMs: Date.parse("2026-07-14T02:00:00Z") }), []);
});

test("REGRESSION: a schedule that SILENTLY STOPPED FIRING is flagged (absence is the only symptom)", () => {
  // Three daily slots, then nothing for four days. No failed execution exists to look at. The old sweep
  // would report the last (successful) run forever.
  const executions = [
    { name: "dd-29730239", status: "Succeeded", startTime: "2026-07-11T23:59:00Z" },
    { name: "dd-29728799", status: "Succeeded", startTime: "2026-07-10T23:59:00Z" },
    { name: "dd-29727359", status: "Succeeded", startTime: "2026-07-09T23:59:00Z" },
  ];
  const f = auditScheduledJob({ name: "dd", executions, nowMs: Date.parse("2026-07-15T12:00:00Z") });
  assert.ok(f.some((x) => /SCHEDULE HAS NOT FIRED/.test(x)), "a cron that stopped firing must page");
});

test("REGRESSION: a job with only manual executions is flagged, never assumed healthy", () => {
  const executions = [{ name: "dd-s7gutka", status: "Succeeded", startTime: "2026-07-14T00:39:17Z" }];
  const f = auditScheduledJob({ name: "dd", executions, nowMs: Date.parse("2026-07-14T01:00:00Z") });
  assert.ok(f.some((x) => /NO CRON-TRIGGERED EXECUTION/.test(x)));
});

// ---------------------------------------------------------------------------------------------------
// CLASS GUARD. Fix the class, not the instance.
//
// A PUT of an AI Search index schema that omits a field the LIVE index already has is a DELETION, and
// Azure rejects it ("Existing field(s) 'X' cannot be deleted"). That killed daily-digest on 2026-07-13
// when `indexed_at` was backfilled onto an index whose writer still ran a pre-indexed_at schema.
// indexer.mjs was made additive. semantic.mjs -- the writer of memory-exec, THE LIVE BRAIN -- was not,
// and sat there loaded. So did index-ring-memory.mjs. This test makes sure the next writer cannot
// repeat it: it FAILS on any writer that PUTs a hardcoded schema without merging the live one.
// ---------------------------------------------------------------------------------------------------
function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) { if (e !== "node_modules") walk(p, out); }
    else if (e.endsWith(".mjs")) out.push(p);
  }
  return out;
}

test("CLASS GUARD: every writer that PUTs an AI Search index schema MUST merge additively", () => {
  const offenders = [];
  for (const f of walk(SKILLS)) {
    const src = readFileSync(f, "utf8");
    // A PUT against /indexes/<name>?api-version -- i.e. writing an index DEFINITION, not documents.
    const putsIndexSchema = /\/indexes\/\$\{[^}]+\}\?api-version[\s\S]{0,400}?method:\s*["']PUT["']/.test(src);
    if (putsIndexSchema && !src.includes("mergeSchemaAdditive")) offenders.push(f.replace(SKILLS, "skills/"));
  }
  assert.deepEqual(
    offenders,
    [],
    `These writers PUT a hardcoded index schema without merging the live one. A PUT that omits an existing field is a DELETION and Azure will 400 the moment anyone adds a field -- taking the writer down on every run. Use mergeSchemaAdditive (skills/doc-indexer/schema-merge.mjs): ${offenders.join(", ")}`,
  );
});
