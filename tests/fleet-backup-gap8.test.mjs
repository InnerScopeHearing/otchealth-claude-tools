// Regression gate for skills/fleet-backup/backup.mjs's GAP-8 wiring (the direct Cosmos export of
// memory / events / decisions_pending, closing DR gap #8 -- see backup.mjs's own header "GAP-8"
// note). Two things are pinned here:
//
//   1. Importing backup.mjs must NEVER trigger a real run() or selftest() as a side effect. Before
//      this change the file dispatched unconditionally at module scope (`const cmd = process.argv[2]
//      ...; if (cmd === "run") { run(...) }`), so simply `import`-ing it for a test -- or for
//      anything else -- would kick off a live run against production. The CLI-entrypoint guard added
//      alongside GAP-8 (mirrors skills/fleet-backup/s3-mirror.mjs's convention) fixes this; this test
//      is the regression pin for it staying fixed.
//   2. mergeBackupIncomplete() -- the small pure helper both the GAP-8 Cosmos-container block and the
//      pre-existing AI-Search-index block write manifest.backup_incomplete through -- never clobbers
//      a value either block already wrote. Before this fix both blocks did a plain `manifest.
//      backup_incomplete = failures` assignment; since the GAP-8 block runs FIRST in run()'s
//      execution order, an AI-Search-index failure recorded by the SECOND block would have silently
//      overwritten (deleted) any GAP-8 Cosmos failure the first block had already recorded -- exactly
//      the "a real failure goes unreported" class of bug this whole session has been hunting.
//
// exportCosmosContainer() itself is a one-line wrapper around cosmos-export.mjs's dumpContainer() --
// its own pagination/allowlist/fail-loud behavior is covered exhaustively in
// tests/fleet-backup-cosmos-export.test.mjs, not re-tested here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKUP_MJS = path.join(__dirname, "..", "skills", "fleet-backup", "backup.mjs");

test("importing backup.mjs does NOT trigger a real run()/selftest() as a side effect (CLI-entrypoint guard)", async () => {
  // A real run() would immediately fail on BACKUP_STORAGE_ACCOUNT being unset (process.exit(78)) or
  // attempt a live network call; a real selftest() would print a JSON report and exit cleanly but
  // still be an unwanted side effect of a plain import. Neither should happen here: process.exit must
  // never be called as a consequence of this import, and the module's exports must be reachable
  // immediately (which would not be true if a synchronous top-level dispatch had already run and
  // exited the process).
  let exitCalled = false;
  const originalExit = process.exit;
  process.exit = (code) => { exitCalled = true; throw new Error(`process.exit(${code}) called as an import side effect`); };
  try {
    const mod = await import("../skills/fleet-backup/backup.mjs");
    assert.equal(typeof mod.exportCosmosContainer, "function", "exportCosmosContainer must be reachable immediately after import");
    assert.equal(typeof mod.mergeBackupIncomplete, "function", "mergeBackupIncomplete must be reachable immediately after import");
  } finally {
    process.exit = originalExit;
  }
  assert.equal(exitCalled, false, "import must never call process.exit");
});

test("running backup.mjs as a CLI script (subprocess) still dispatches normally -- the guard does not break real invocation", () => {
  // selftest() never writes anything and is safe to run for real; it just reports credential/
  // container reachability (which will be false in this sandbox -- that's fine, we're only proving
  // the CLI dispatch path itself still fires, not that production credentials are present here).
  const result = spawnSync(process.execPath, [BACKUP_MJS, "selftest"], { encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 0, `selftest should exit 0; stderr: ${result.stderr}`);
  const report = JSON.parse(result.stdout);
  assert.ok(Object.prototype.hasOwnProperty.call(report, "identityPresent"));
  assert.ok(Object.prototype.hasOwnProperty.call(report, "kvSecretReachable"));
  assert.ok(Object.prototype.hasOwnProperty.call(report, "blobContainerReachable"));
});

test("running backup.mjs with an unknown subcommand still prints usage and exits non-zero (unchanged CLI contract)", () => {
  const result = spawnSync(process.execPath, [BACKUP_MJS, "not-a-real-command"], { encoding: "utf8", timeout: 30_000 });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /usage: node backup\.mjs run/);
});

const { mergeBackupIncomplete } = await import("../skills/fleet-backup/backup.mjs");

test("mergeBackupIncomplete(): undefined existing + no additions -> stays undefined (never invents an empty-but-present key)", () => {
  assert.equal(mergeBackupIncomplete(undefined, []), undefined);
  assert.equal(mergeBackupIncomplete(undefined, undefined), undefined);
});

test("mergeBackupIncomplete(): no prior value, first block reports failures -> those failures are returned", () => {
  assert.deepEqual(mergeBackupIncomplete(undefined, ["memory: 0 rows"]), ["memory: 0 rows"]);
  assert.deepEqual(mergeBackupIncomplete(null, ["events: HTTP 500"]), ["events: HTTP 500"]);
});

test("mergeBackupIncomplete(): REGRESSION PIN -- a second block's failures are APPENDED to a first block's, never overwriting/clobbering them", () => {
  // This is the exact bug pattern that existed before GAP-8: the GAP-8 Cosmos-container block runs
  // FIRST in run() and may set manifest.backup_incomplete; the pre-existing AI-Search-index block
  // runs SECOND and, before this fix, did `manifest.backup_incomplete = failures` -- a plain
  // assignment that would silently discard whatever the first block had already recorded.
  const afterFirstBlock = mergeBackupIncomplete(undefined, ["memory: 0 rows", "events: HTTP 503"]);
  const afterSecondBlock = mergeBackupIncomplete(afterFirstBlock, ["memory-exec: HTTP 500"]);
  assert.deepEqual(afterSecondBlock, ["memory: 0 rows", "events: HTTP 503", "memory-exec: HTTP 500"], "both blocks' failures must all be present, in order, none dropped");
});

test("mergeBackupIncomplete(): a block reporting NO new failures does not disturb an existing value", () => {
  const afterFirstBlock = mergeBackupIncomplete(undefined, ["decisions_pending: connection refused"]);
  const afterSecondBlockWithNothingNew = mergeBackupIncomplete(afterFirstBlock, []);
  assert.deepEqual(afterSecondBlockWithNothingNew, ["decisions_pending: connection refused"]);
});

test("mergeBackupIncomplete(): does not mutate the `existing` array in place (safe to call repeatedly across independent blocks)", () => {
  const original = ["a"];
  const merged = mergeBackupIncomplete(original, ["b"]);
  assert.deepEqual(original, ["a"], "the original array passed in must be untouched");
  assert.deepEqual(merged, ["a", "b"]);
  assert.notEqual(merged, original, "must return a new array, not mutate/return the same reference");
});
