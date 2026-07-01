// DRAFT SKELETON — the fan-out/fan-in orchestrator that replaces the 4 separate
// librarian-{finance,commerce,legal-company,legal-personal} Container Apps Jobs (currently
// staggered on cron :00/:15/:20/:40 as a manual parallelism workaround) with ONE orchestrator
// that fans them out as parallel activities and fans back in to a single combined status.
//
// Node.js v4 Durable Functions programming model (`df.app.orchestration` in code, no
// function.json). See https://learn.microsoft.com/azure/durable-task/durable-functions/durable-functions-node-model-upgrade
//
// Orchestrator code MUST be deterministic (no Date.now(), no Math.random(), no direct I/O —
// use context.df.currentUtcDateTime and push all real work into activities). This file follows
// that constraint throughout; librarianActivity.js is where the actual indexer.mjs shell-outs
// happen.

const df = require('durable-functions');

// The rooms this orchestrator fans out to. Mirrors the profile/container pairs the 4 existing
// Container Apps Jobs already run (see otchealth-claude-tools/skills/doc-indexer/job/librarian.sh
// and its per-job --args). Ring separation is preserved: legal-personal stays its own activity
// call against its own container, never co-mingled with legal-company or any other room.
const ROOMS = [
  { profile: 'finance', args: [] },
  { profile: 'commerce', args: [] },
  { profile: 'legal', args: ['--container', 'company'] },
  { profile: 'legal', args: ['--container', 'personal'] }, // privileged; CLO-owned data, own index
];

df.app.orchestration('librarianFanOut', function* (context) {
  const startedAt = context.df.currentUtcDateTime; // deterministic clock, not Date.now()

  // ── FAN OUT: schedule all 4 room-refresh activities in parallel. ──
  // context.df.Task.all() is the fan-in primitive — it returns a task that completes only when
  // every parallel activity has completed, exactly like Promise.all but resilient to process
  // recycling (the Durable Task runtime replays history to reconstruct state, so a mid-run
  // restart resumes rather than starting over). This is the single orchestrator-level fix for
  // "librarian rooms silently overlap/clobber, and failed replicas are undiagnosable" — every
  // room's outcome (success, partial, or error) is captured in ONE queryable instance history
  // instead of 4 separate job-run logs with no shared view.
  const tasks = ROOMS.map((room) =>
    context.df.callActivity('librarianRoomRefresh', room)
  );
  const results = yield context.df.Task.all(tasks);

  // ── FAN IN: aggregate results into one combined status doc. ──
  const summary = {
    startedAt,
    completedAt: context.df.currentUtcDateTime,
    rooms: ROOMS.map((room, i) => ({
      profile: room.profile,
      container: (room.args[1]) || null,
      ...results[i], // { ok: bool, docsProcessed, errors, durationMs } — see librarianActivity.js
    })),
    allOk: results.every((r) => r.ok),
  };

  // No I/O here (orchestrator constraint) — writing the summary to Blob/company-journal is a
  // FIFTH activity call, not done inline. Left as a single follow-up activity so the orchestrator
  // itself never touches storage directly.
  yield context.df.callActivity('librarianWriteSummary', summary);

  return summary;
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// HUMAN-IN-THE-LOOP APPROVAL GATE PATTERN (documented here, NOT wired to a live call in this
// draft — this is the pattern the CFO xero-bulk-poster job should use once it exists, per
// otchealth-cto/runbooks/AZURE-AI-OPERATING-SYSTEM.md's note that "the CFO 20k-txn backlog is a
// Tier-1 fit... OTCHealth+personal unattended OK, INND/HA gated"):
//
//   df.app.orchestration('cfoXeroBulkPoster', function* (context) {
//     const entities = context.df.getInput(); // e.g. ['otchealth', 'personal', 'innd', 'hearingassist']
//     const unattended = entities.filter(e => e === 'otchealth' || e === 'personal');
//     const gated = entities.filter(e => e === 'innd' || e === 'hearingassist');
//
//     // Unattended entities post immediately, fanned out same as the librarian rooms above.
//     yield context.df.Task.all(unattended.map(e => context.df.callActivity('xeroPostBatch', e)));
//
//     // Gated entities wait for an explicit human (or Tier-2 claude -p run) approval event
//     // before posting ANY transaction. The orchestration PAUSES here — no polling, no timeout
//     // busy-loop, the Durable Task runtime literally suspends and resumes on the event.
//     if (gated.length > 0) {
//       const timeoutTask = context.df.createTimer(addHours(context.df.currentUtcDateTime, 72));
//       const approvalTask = context.df.waitForExternalEvent('CfoApproval');
//       const winner = yield context.df.Task.any([approvalTask, timeoutTask]);
//       if (winner === approvalTask && approvalTask.result === true) {
//         yield context.df.Task.all(gated.map(e => context.df.callActivity('xeroPostBatch', e)));
//       } else {
//         yield context.df.callActivity('notifyCfoApprovalTimedOut', gated);
//       }
//     }
//   });
//
// A human (or an automated caller) approves by POSTing to the orchestration's own
// `sendEventPostUri` (returned in the original HTTP 202 from the starter):
//   curl -X POST "<sendEventPostUri-with-eventName-replaced-by-CfoApproval>" -d 'true'
// This is the exact mechanism the design brief asked for ("human-in-the-loop approval gates")
// and it costs zero extra infrastructure — waitForExternalEvent is a built-in orchestrator API.
