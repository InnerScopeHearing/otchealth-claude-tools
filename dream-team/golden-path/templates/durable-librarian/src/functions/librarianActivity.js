// DRAFT SKELETON — the activity that does the REAL work for one room: shell out to the exact
// same indexer.mjs calls librarian.sh already makes (index -> understand -> push-search). No
// indexer logic is rewritten here; this is a thin coordination wrapper so the fan-out
// orchestrator has something to call per room.
//
// Activities have NO code restrictions (unlike orchestrators) — they can do real I/O, spawn
// processes, take as long as they need. The Durable Task runtime guarantees each activity runs
// AT LEAST ONCE, so make this idempotent (indexer.mjs already is, via its catalog checkpoint —
// see otchealth-claude-tools/skills/doc-indexer/job/README.md "index/understand/push-search are
// all resumable").

const df = require('durable-functions');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);

// Resolve the repo root the same way librarian.sh does (relative to this file's own location),
// so this runs identically in a container image and in a local checkout.
const path = require('node:path');
const ROOT = path.resolve(__dirname, '../../../../..'); // adjust to actual repo layout at adopt time
const INDEXER = path.join(ROOT, 'skills/doc-indexer/indexer.mjs');

df.app.activity('librarianRoomRefresh', {
  handler: async (room) => {
    const startedAt = Date.now(); // fine here — this is an ACTIVITY, not the orchestrator; real
    // I/O and non-deterministic calls are allowed and expected in activity code.
    const args = ['--profile', room.profile, '--azure', ...(room.args || [])];
    const steps = ['index', 'understand', 'push-search'];
    const log = [];
    try {
      for (const step of steps) {
        const { stdout, stderr } = await execFileAsync(
          'node',
          [INDEXER, step, ...args],
          // VERIFIED against Microsoft Learn (Azure Functions hosting options,
          // functions-scale#function-app-timeout-duration): Flex Consumption's functionTimeout
          // is UNBOUNDED (default 30 min, raise via host.json's functionTimeout — NOT capped at
          // 10 min like the legacy Consumption plan). The only real ceilings are a 60-min grace
          // period during scale-in and a 10-min grace period during platform updates — both are
          // recycle events the activity should tolerate via retry (Durable Task's at-least-once
          // activity guarantee already covers this), not hard walls on a single execution. So
          // the existing CU_MAX_MINUTES=110 budget on legal-personal does NOT need to shrink to
          // fit this host; set host.json's functionTimeout to match (e.g. "01:55:00") and this
          // execFileAsync timeout to the same value as a belt-and-suspenders local guard.
          { timeout: 115 * 60 * 1000 }
        );
        log.push({ step, stdout: stdout.slice(-2000), stderr: stderr.slice(-2000) });
      }
      return { ok: true, durationMs: Date.now() - startedAt, log };
    } catch (err) {
      return { ok: false, durationMs: Date.now() - startedAt, error: String(err), log };
    }
  },
});

df.app.activity('librarianWriteSummary', {
  handler: async (summary) => {
    // Placeholder: write to the same company-journal / commons store the daily-digest job
    // already targets, so the Durable Functions run's summary is queryable the same way any
    // other fleet artifact is (company-brain can pick it up). Left unimplemented in this draft —
    // wire to the existing cfo-store / doc-indexer storage helper at adopt time rather than
    // reinventing a new storage client here.
    console.log('[librarian-summary]', JSON.stringify(summary));
    return { written: false, note: 'wire to commons-journal storage at adopt time' };
  },
});
