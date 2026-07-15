// Tests for agent-state-janitor.mjs's episode-decay rule (Phase 4B3). This is a DELETION path, so
// the tests exist to prove the safety properties, not just the happy path -- mirrors the framing of
// tests/index-writer-gate.test.mjs ("a gate that has never been proven to fail is not a gate").
//
// Fixtures/mocks only: no live Cosmos, Key Vault, or storage account credentials anywhere here.
// Importing agent-state-janitor.mjs does NOT trigger a real run -- the file's isMain guard only
// calls main() when executed directly (node agent-state-janitor.mjs), exactly like
// skills/kb-memory/semantic.mjs's isMain guard (see tests/semantic-docid.test.mjs for the same
// import-is-safe pattern against that file).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isEpisodeEligibleForDecay,
  selectEpisodesForDecay,
  episodeDecayCommitMode,
  archiveBlobPathFor,
  memoryExecDocId,
  decayEpisodesForRule,
} from "../skills/doc-indexer/job/agent-state-janitor.mjs";

const NOW_MS = Date.parse("2026-07-15T12:00:00Z");
const NOW_TS = Math.floor(NOW_MS / 1000);
const CUTOFF_DAYS = 45;
const CUTOFF_TS = NOW_TS - CUTOFF_DAYS * 86400;

/** Build a Cosmos `memory`-container-shaped row. ageDays is relative to NOW_MS/NOW_TS above. */
function makeRow({ id, kind, ageDays, agent = "cto", text = "note" }) {
  const ts = NOW_TS - ageDays * 86400;
  return {
    id,
    agent,
    kind,
    text,
    tags: [],
    source: null,
    created_at: new Date(ts * 1000).toISOString(),
    _ts: ts,
  };
}

// ============================ selection: the safety-critical filter ============================

test("a fact/decision/correction/pitfall/status row is NEVER selected for episode-decay, regardless of age", () => {
  const veryOldDays = 10000; // far older than any realistic cutoff
  const rows = ["fact", "decision", "correction", "pitfall", "status"].map((kind, i) =>
    makeRow({ id: `k${i}`, kind, ageDays: veryOldDays })
  );
  const selected = selectEpisodesForDecay(rows, CUTOFF_TS);
  assert.deepEqual(selected, [], "no non-episode kind should ever be selected, no matter how old");
  for (const doc of rows) {
    assert.equal(isEpisodeEligibleForDecay(doc, CUTOFF_TS), false, `${doc.kind} must not be eligible`);
  }
});

test("an old episode IS selected; a recent episode is NOT", () => {
  const oldEpisode = makeRow({ id: "ep-old", kind: "episode", ageDays: CUTOFF_DAYS + 10 });
  const recentEpisode = makeRow({ id: "ep-new", kind: "episode", ageDays: 1 });
  const selected = selectEpisodesForDecay([oldEpisode, recentEpisode], CUTOFF_TS);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].id, "ep-old");
  assert.equal(isEpisodeEligibleForDecay(oldEpisode, CUTOFF_TS), true);
  assert.equal(isEpisodeEligibleForDecay(recentEpisode, CUTOFF_TS), false);
});

test("selection is a mixed-kind batch aware filter: only the old episode survives among every kind", () => {
  const rows = [
    makeRow({ id: "fact1", kind: "fact", ageDays: 10000 }),
    makeRow({ id: "dec1", kind: "decision", ageDays: 10000 }),
    makeRow({ id: "cor1", kind: "correction", ageDays: 10000 }),
    makeRow({ id: "pit1", kind: "pitfall", ageDays: 10000 }),
    makeRow({ id: "sta1", kind: "status", ageDays: 10000 }),
    makeRow({ id: "ep-old", kind: "episode", ageDays: CUTOFF_DAYS + 1 }),
    makeRow({ id: "ep-new", kind: "episode", ageDays: 2 }),
  ];
  const selected = selectEpisodesForDecay(rows, CUTOFF_TS);
  assert.deepEqual(selected.map((d) => d.id), ["ep-old"]);
});

test("selection tolerates malformed/missing rows without throwing and never selects them", () => {
  const weird = [null, undefined, {}, { kind: "episode" }, { kind: "episode", _ts: "not-a-number" }, { kind: "episode", _ts: NaN }];
  assert.doesNotThrow(() => selectEpisodesForDecay(weird, CUTOFF_TS));
  assert.deepEqual(selectEpisodesForDecay(weird, CUTOFF_TS), []);
  assert.deepEqual(selectEpisodesForDecay(null, CUTOFF_TS), [], "a null rows array must degrade to empty, not throw");
});

// ============================ the double-gate: disarmed by default ============================

test("episodeDecayCommitMode requires BOTH --commit and EPISODE_DECAY_ENABLED=1; either alone stays report-only", () => {
  assert.equal(episodeDecayCommitMode([], {}), false, "neither flag set -> report-only (the shipped default)");
  assert.equal(episodeDecayCommitMode(["--commit"], {}), false, "--commit alone is not enough");
  assert.equal(episodeDecayCommitMode([], { EPISODE_DECAY_ENABLED: "1" }), false, "EPISODE_DECAY_ENABLED alone is not enough");
  assert.equal(episodeDecayCommitMode(["--commit"], { EPISODE_DECAY_ENABLED: "0" }), false, "EPISODE_DECAY_ENABLED=0 does not count as enabled");
  assert.equal(episodeDecayCommitMode(["--commit"], { EPISODE_DECAY_ENABLED: "1" }), true, "both set -> commit mode");
});

test("episodeDecayCommitMode ignores unrelated argv/env noise", () => {
  assert.equal(episodeDecayCommitMode(["--foo", "--commit", "bar"], { EPISODE_DECAY_ENABLED: "1", OTHER: "x" }), true);
  assert.equal(episodeDecayCommitMode([], undefined), false, "a missing env object must not throw");
});

// ============================ archive path shape ============================

test("archiveBlobPathFor groups by the episode's created_at month and agent, not the archive-time month", () => {
  const doc = { id: "x", agent: "CTO", created_at: "2026-02-14T00:00:00Z", _ts: NOW_TS };
  assert.equal(archiveBlobPathFor(doc, NOW_MS), "_ARCHIVE/episodes/cto/2026-02.jsonl");
});

test("archiveBlobPathFor falls back to _ts, then to now, when created_at is missing", () => {
  const viaTs = archiveBlobPathFor({ id: "x", agent: "cfo", _ts: Math.floor(Date.parse("2026-05-01T00:00:00Z") / 1000) }, NOW_MS);
  assert.equal(viaTs, "_ARCHIVE/episodes/cfo/2026-05.jsonl");
  const viaNow = archiveBlobPathFor({ id: "x", agent: "clo" }, NOW_MS);
  assert.equal(viaNow, "_ARCHIVE/episodes/clo/2026-07.jsonl");
});

test("archiveBlobPathFor sanitizes an unusual agent id and falls back to 'unknown' when missing", () => {
  const path = archiveBlobPathFor({ id: "x", agent: "some agent!!", created_at: "2026-01-01T00:00:00Z" });
  assert.match(path, /^_ARCHIVE\/episodes\/[a-z0-9_-]+\/2026-01\.jsonl$/);
  const missing = archiveBlobPathFor({ id: "x", created_at: "2026-01-01T00:00:00Z" });
  assert.equal(missing, "_ARCHIVE/episodes/unknown/2026-01.jsonl");
});

// ============================ memory-exec index key derivation ============================

test("memoryExecDocId matches skills/kb-memory/semantic.mjs's docId contract (agent__id, Azure-key-safe)", () => {
  assert.equal(memoryExecDocId("cto", "20260715-001"), "cto__20260715-001");
  assert.match(memoryExecDocId("clo-personal", "matter/2026:note 7"), /^[A-Za-z0-9_\-=]+$/);
});

// ============================ orchestration: archive-before-delete, dry-run by default ============================

function tracker() {
  const calls = [];
  return {
    calls,
    archiveRow: async (doc) => { calls.push(["archive", doc.id]); },
    deleteRow: async (doc) => { calls.push(["delete", doc.id]); },
    deleteFromIndex: async (doc) => { calls.push(["index", doc.id]); },
  };
}

test("dry-run (commit=false) touches NOTHING: archiveRow/deleteRow/deleteFromIndex never fire", async () => {
  const rows = [
    makeRow({ id: "ep1", kind: "episode", ageDays: CUTOFF_DAYS + 5 }),
    makeRow({ id: "ep2", kind: "episode", ageDays: CUTOFF_DAYS + 20 }),
    makeRow({ id: "fact1", kind: "fact", ageDays: CUTOFF_DAYS + 20 }), // not eligible either way
  ];
  const t = tracker();
  const result = await decayEpisodesForRule({ rows, cutoffTs: CUTOFF_TS, commit: false, ...t });
  assert.equal(t.calls.length, 0, "no IO callback should fire in report-only mode");
  assert.equal(result.mode, "REPORT-ONLY");
  assert.equal(result.eligible, 2);
  assert.equal(result.archived, 0);
  assert.equal(result.deleted, 0);
});

test("commit mode archives THEN deletes, in that order, for every eligible row", async () => {
  const rows = [
    makeRow({ id: "ep1", kind: "episode", ageDays: CUTOFF_DAYS + 5 }),
    makeRow({ id: "ep2", kind: "episode", ageDays: CUTOFF_DAYS + 20 }),
  ];
  const t = tracker();
  const result = await decayEpisodesForRule({ rows, cutoffTs: CUTOFF_TS, commit: true, ...t });
  assert.equal(result.mode, "COMMIT");
  assert.equal(result.archived, 2);
  assert.equal(result.deleted, 2);
  for (const id of ["ep1", "ep2"]) {
    const archiveIdx = t.calls.findIndex(([op, cid]) => op === "archive" && cid === id);
    const deleteIdx = t.calls.findIndex(([op, cid]) => op === "delete" && cid === id);
    assert.ok(archiveIdx >= 0, `archive should fire for ${id}`);
    assert.ok(deleteIdx >= 0, `delete should fire for ${id}`);
    assert.ok(archiveIdx < deleteIdx, `archive must precede delete for ${id} (got archive@${archiveIdx}, delete@${deleteIdx})`);
  }
});

test("an archive failure for one row skips ITS delete, but does not block other rows in the batch", async () => {
  const rows = [
    makeRow({ id: "bad", kind: "episode", ageDays: CUTOFF_DAYS + 5 }),
    makeRow({ id: "good", kind: "episode", ageDays: CUTOFF_DAYS + 5 }),
  ];
  const calls = [];
  const archiveRow = async (doc) => {
    if (doc.id === "bad") throw new Error("simulated archive failure");
    calls.push(["archive", doc.id]);
  };
  const deleteRow = async (doc) => { calls.push(["delete", doc.id]); };
  const deleteFromIndex = async (doc) => { calls.push(["index", doc.id]); };
  const result = await decayEpisodesForRule({ rows, cutoffTs: CUTOFF_TS, commit: true, archiveRow, deleteRow, deleteFromIndex });
  assert.ok(!calls.some(([op, id]) => op === "delete" && id === "bad"), "delete must NEVER be called for a row whose archive failed");
  assert.ok(!calls.some(([op, id]) => op === "archive" && id === "bad"), "the failed archive call itself is not recorded as a success");
  assert.ok(calls.some(([op, id]) => op === "delete" && id === "good"), "the other, successfully-archived row is still processed");
  assert.equal(result.archiveErrors, 1);
  assert.equal(result.archived, 1);
  assert.equal(result.deleted, 1);
});

test("a memory-exec index-cleanup failure is logged/counted but does not undo the delete or fail the row", async () => {
  const rows = [makeRow({ id: "ep1", kind: "episode", ageDays: CUTOFF_DAYS + 5 })];
  const calls = [];
  const archiveRow = async (doc) => { calls.push(["archive", doc.id]); };
  const deleteRow = async (doc) => { calls.push(["delete", doc.id]); };
  const deleteFromIndex = async () => { throw new Error("search index unreachable"); };
  const result = await decayEpisodesForRule({ rows, cutoffTs: CUTOFF_TS, commit: true, archiveRow, deleteRow, deleteFromIndex });
  assert.equal(result.archived, 1);
  assert.equal(result.deleted, 1, "the Cosmos delete already succeeded and must stay counted as a success");
  assert.equal(result.indexErrors, 1);
});

test("a Cosmos-delete failure after a successful archive is counted, and index cleanup is skipped for that row", async () => {
  const rows = [makeRow({ id: "ep1", kind: "episode", ageDays: CUTOFF_DAYS + 5 })];
  const calls = [];
  const archiveRow = async (doc) => { calls.push(["archive", doc.id]); };
  const deleteRow = async () => { throw new Error("cosmos delete 500"); };
  const deleteFromIndex = async (doc) => { calls.push(["index", doc.id]); };
  const result = await decayEpisodesForRule({ rows, cutoffTs: CUTOFF_TS, commit: true, archiveRow, deleteRow, deleteFromIndex });
  assert.equal(result.archived, 1);
  assert.equal(result.deleted, 0);
  assert.equal(result.deleteErrors, 1);
  assert.ok(!calls.some(([op]) => op === "index"), "index cleanup must not run for a row still live in Cosmos");
});

test("maxPerRun bounds how many eligible rows are processed in a single invocation", async () => {
  const rows = Array.from({ length: 5 }, (_, i) => makeRow({ id: `ep${i}`, kind: "episode", ageDays: CUTOFF_DAYS + 5 }));
  const t = tracker();
  const result = await decayEpisodesForRule({ rows, cutoffTs: CUTOFF_TS, commit: true, ...t, maxPerRun: 2 });
  assert.equal(result.eligible, 5);
  assert.equal(result.processed, 2);
  assert.equal(result.archived, 2);
  assert.equal(result.deleted, 2);
  const archiveCalls = t.calls.filter(([op]) => op === "archive");
  assert.equal(archiveCalls.length, 2, "only maxPerRun rows should ever reach archiveRow");
});

test("decayEpisodesForRule never mutates the input rows array or any row object", async () => {
  const rows = [
    makeRow({ id: "ep1", kind: "episode", ageDays: CUTOFF_DAYS + 5 }),
    makeRow({ id: "fact1", kind: "fact", ageDays: CUTOFF_DAYS + 5 }),
  ];
  const before = JSON.stringify(rows);
  for (const r of rows) Object.freeze(r);
  Object.freeze(rows);
  const t = tracker();
  await decayEpisodesForRule({ rows, cutoffTs: CUTOFF_TS, commit: true, ...t });
  assert.equal(JSON.stringify(rows), before, "the source rows must be byte-identical after processing");
});
