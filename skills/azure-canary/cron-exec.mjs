// cron-exec.mjs -- TELL A SCHEDULED RUN FROM A MANUAL RE-KICK.
//
// THE FAILURE THIS EXISTS TO END. Between 2026-07-04 and 2026-07-13, `daily-digest` failed TEN
// CONSECUTIVE SCHEDULED RUNS. Every monitor reported it healthy the whole time. Not because the
// monitors were broken -- because of this line in the dead-job sweep:
//
//     azure_job_executions({ job_name, top: 1 })   // the LATEST execution, of ANY trigger type
//
// Each time an engineer re-kicked the job by hand to debug it, that MANUAL execution became "the latest
// execution", and the canary went green. THE ACT OF DEBUGGING LAUNDERED THE FAILURE. Three separate
// sessions each declared daily-digest "fixed" on the strength of a manual run that passed, while the
// 23:59 cron kept dying. A MANUAL RE-KICK IS NOT A TEST OF A SCHEDULE. It is a different experiment
// wearing the same name.
//
// HOW WE TELL THEM APART (verified against live ARM data, not assumed). Azure Container Apps Jobs are
// Kubernetes CronJobs underneath, and the cron controller names each scheduled execution:
//
//     {job-name}-{minutes since the Unix epoch OF THE SCHEDULED TIME}
//
// Proof: execution `daily-digest-29733119` -> 29,733,119 x 60 = 1783987140 = 2026-07-13T23:59:00Z --
// exactly its cron slot (`59 23 * * *`). Manual executions get a short random alphanumeric suffix
// instead (`daily-digest-s7gutka`, `-56ctg3j`, `-3qa750b`). So the name does not just tell us WHICH
// trigger fired -- it tells us the exact wall-clock slot the scheduler intended. That is a free,
// authoritative signal we were throwing away.
//
// This module is pure (no I/O, no env) so its logic is fully unit-tested and can never drift from the
// tests that guard it.

/** {job}-{minutesSinceEpoch}. 8+ digits: current epoch-minutes are 8 digits, manual suffixes are 7 chars. */
const CRON_SUFFIX = /-(\d{8,})$/;

/**
 * The wall-clock slot the SCHEDULER intended for this execution, or null if it was a manual run.
 * Sanity-bounded to 2020..2100 so a manual suffix that happened to be all digits cannot masquerade.
 */
export function scheduledTimeOf(name) {
  const m = String(name || "").match(CRON_SUFFIX);
  if (!m) return null;
  const ms = Number(m[1]) * 60_000;
  if (!Number.isFinite(ms) || ms < Date.UTC(2020, 0, 1) || ms > Date.UTC(2100, 0, 1)) return null;
  return ms;
}

/** True only for executions created by the cron controller. Manual re-kicks return false. */
export function isCronExecution(name) {
  return scheduledTimeOf(name) !== null;
}

/**
 * Judge a scheduled job the way it must be judged: on its SCHEDULE, not on whatever ran last.
 *
 * Two assertions, and the second one is the one nobody had:
 *   (1) Did the most recent CRON-TRIGGERED run succeed?  (a manual re-kick can no longer launder it green)
 *   (2) Did the schedule FIRE AT ALL recently?  A cron that silently stops producing executions emits no
 *       error, no failed run, and nothing at all to look at -- the last execution just sits there, green,
 *       forever. Absence of a failure is not success. Silence is the failure.
 *
 * The cadence is SELF-CALIBRATING: it is the median gap between the scheduled slots we can read straight
 * out of the execution names. No cron parser, and no second config file to drift out of sync with reality.
 */
export function auditScheduledJob({ name, executions, nowMs, graceMin = 20, minCadenceMin = 5 }) {
  const findings = [];
  const cron = (executions || [])
    .map((e) => ({ ...e, sched: scheduledTimeOf(e.name) }))
    .filter((e) => e.sched !== null)
    .sort((a, b) => b.sched - a.sched);

  if (!cron.length) {
    findings.push(
      `${name}: NO CRON-TRIGGERED EXECUTION among the last ${(executions || []).length} run(s) -- the schedule may never have fired, or has not fired in a long time. Manual runs do not count.`,
    );
    return findings;
  }

  const last = cron[0];

  // (1) The last SCHEDULED run. Not the last run.
  if (last.status !== "Succeeded") {
    findings.push(
      `${name}: LAST SCHEDULED RUN ${last.status} @ ${new Date(last.sched).toISOString()} (execution ${last.name}). A manual re-kick does NOT clear this -- only a passing cron does.`,
    );
  }

  // (2) Did the scheduler fire at all? Needs >=3 slots to infer a cadence honestly.
  if (cron.length >= 3) {
    const gaps = [];
    for (let i = 0; i + 1 < cron.length; i++) gaps.push((cron[i].sched - cron[i + 1].sched) / 60_000);
    gaps.sort((a, b) => a - b);
    const cadence = gaps[Math.floor(gaps.length / 2)];
    if (cadence >= minCadenceMin) {
      const ageMin = (nowMs - last.sched) / 60_000;
      if (ageMin > cadence * 1.5 + graceMin) {
        findings.push(
          `${name}: SCHEDULE HAS NOT FIRED in ${Math.round(ageMin)}m (observed cadence ~${Math.round(cadence)}m). A cron that stops firing produces no failed execution and no error -- its silence is the only symptom.`,
        );
      }
    }
  }

  return findings;
}
