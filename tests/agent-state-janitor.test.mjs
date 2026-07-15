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
  resolveEpisodeDecayArmed,
  archiveBlobPathFor,
  memoryExecDocId,
  appendEpisodeToArchive,
  decayEpisodesForRule,
} from "../skills/doc-indexer/job/agent-state-janitor.mjs";
// Canonical docId source of truth (kb-memory semantic.mjs). Safe to import: semantic.mjs's isMain
// guard means importing it defines exports without running its CLI (the same import the existing
// tests/semantic-docid.test.mjs relies on).
import { docId } from "../skills/kb-memory/semantic.mjs";

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

// The COMPOSED production gate as actually used in runEpisodeDecay: episodeDecayCommitMode && !DRY_RUN.
test("resolveEpisodeDecayArmed: --commit + EPISODE_DECAY_ENABLED=1 + no JANITOR_DRY_RUN -> ARMED", () => {
  assert.equal(resolveEpisodeDecayArmed(["--commit"], { EPISODE_DECAY_ENABLED: "1" }), true);
});

test("resolveEpisodeDecayArmed: the JANITOR_DRY_RUN belt forces report-only even when both arming flags are set", () => {
  assert.equal(
    resolveEpisodeDecayArmed(["--commit"], { EPISODE_DECAY_ENABLED: "1", JANITOR_DRY_RUN: "1" }),
    false,
    "JANITOR_DRY_RUN=1 must win and force report-only"
  );
});

test("resolveEpisodeDecayArmed: either arming flag missing -> report-only, regardless of JANITOR_DRY_RUN", () => {
  assert.equal(resolveEpisodeDecayArmed([], { EPISODE_DECAY_ENABLED: "1" }), false, "no --commit -> report-only");
  assert.equal(resolveEpisodeDecayArmed(["--commit"], {}), false, "no EPISODE_DECAY_ENABLED -> report-only");
  assert.equal(resolveEpisodeDecayArmed([], {}), false, "neither -> report-only (the shipped default)");
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

test("memoryExecDocId is byte-identical to kb-memory semantic.mjs's canonical docId() across representative inputs", () => {
  // Derive the expectation from the CANONICAL source (semantic.mjs docId), not hardcoded strings, so
  // any future drift in either implementation is caught here. Includes inputs that hit the sanitize
  // regex (slash, colon, space, plus, dot) -- the delete would target the wrong memory-exec row if
  // the two derivations ever diverged.
  const cases = [
    ["cto", "20260715-001"],
    ["cfo", "20260621-042"],
    ["clo-personal", "matter/2026:note 7"],
    ["developer", "id.with.dots+plus"],
    ["gateway", "m_abc=DEF-123"],
    ["cto", "correlation:abc/def ghi"],
  ];
  for (const [agent, id] of cases) {
    assert.equal(memoryExecDocId(agent, id), docId(agent, id), `docId parity for (${agent}, ${id})`);
    assert.match(memoryExecDocId(agent, id), /^[A-Za-z0-9_\-=]+$/, "must be a valid Azure document key");
  }
});

// ============================ archive append: concurrency-safe, no lost line ============================

// In-memory store that models Azure APPEND-BLOB semantics: create-if-missing + ATOMIC append. The
// `await` inside appendBlock happens BEFORE the synchronous get+set of the map entry, so the
// read-and-write is one indivisible step (single-threaded JS) -- i.e. Append Block never clobbers a
// concurrent append. Crucially this store exposes ONLY ensureAppendBlob + appendBlock (no full-blob
// put), so appendEpisodeToArchive is structurally forced onto the append path (no read-modify-write
// possible). ensureCalls/createCount let the tests assert the create raced correctly.
function makeAppendStore() {
  const blobs = new Map(); // name -> accumulated content string
  let createCount = 0;
  return {
    blobs,
    get createCount() { return createCount; },
    ensureAppendBlob: async (name) => {
      // simulate the create round-trip latency so two ensures can interleave
      await new Promise((r) => setTimeout(r, Math.random() * 4));
      if (!blobs.has(name)) { blobs.set(name, ""); createCount++; }
    },
    appendBlock: async (name, data) => {
      // latency BEFORE the mutation forces interleave; the get+set below is synchronous => atomic
      await new Promise((r) => setTimeout(r, Math.random() * 6));
      blobs.set(name, (blobs.get(name) || "") + data);
    },
  };
}

test("two concurrent archive appends to the SAME agent/month blob lose NO line (append-blob atomicity)", async () => {
  const store = makeAppendStore();
  const docA = makeRow({ id: "epA", kind: "episode", ageDays: CUTOFF_DAYS + 5, agent: "cto" });
  const docB = makeRow({ id: "epB", kind: "episode", ageDays: CUTOFF_DAYS + 5, agent: "cto" });
  const path = archiveBlobPathFor(docA);
  assert.equal(path, archiveBlobPathFor(docB), "both docs must target the same month/agent blob for this to be a real race");

  // Fire both appends concurrently (this is the manual-run-during-cron-run scenario).
  await Promise.all([
    appendEpisodeToArchive(store, path, docA),
    appendEpisodeToArchive(store, path, docB),
  ]);

  const lines = (store.blobs.get(path) || "").split("\n").filter(Boolean);
  assert.equal(lines.length, 2, "BOTH archived lines must be present -- neither concurrent append clobbered the other");
  const ids = lines.map((l) => JSON.parse(l).id).sort();
  assert.deepEqual(ids, ["epA", "epB"]);
});

test("many concurrent archive appends to one blob all survive (no last-writer-wins loss)", async () => {
  const store = makeAppendStore();
  const path = "_ARCHIVE/episodes/cto/2026-05.jsonl";
  const docs = Array.from({ length: 20 }, (_, i) => makeRow({ id: `ep${i}`, kind: "episode", ageDays: CUTOFF_DAYS + 5, agent: "cto" }));
  // Force every doc onto the SAME blob path regardless of its created_at month.
  await Promise.all(docs.map((d) => appendEpisodeToArchive(store, path, d)));

  const lines = (store.blobs.get(path) || "").split("\n").filter(Boolean);
  assert.equal(lines.length, 20, "all 20 concurrent appends must be present -- a read-modify-write would have lost some");
  assert.equal(store.createCount, 1, "the create raced to exactly one winner; the rest were no-ops");
  const ids = new Set(lines.map((l) => JSON.parse(l).id));
  assert.equal(ids.size, 20, "every distinct episode id survived");
});

test("appendEpisodeToArchive writes each row as exactly one newline-terminated JSON line with an archived_at stamp", async () => {
  const store = makeAppendStore();
  const path = "_ARCHIVE/episodes/cfo/2026-05.jsonl";
  await appendEpisodeToArchive(store, path, makeRow({ id: "ep1", kind: "episode", ageDays: CUTOFF_DAYS + 5, agent: "cfo" }), "2026-07-15T00:00:00.000Z");
  const content = store.blobs.get(path);
  assert.ok(content.endsWith("\n"), "line must be newline-terminated so appends never merge into one line");
  const parsed = JSON.parse(content.trim());
  assert.equal(parsed.id, "ep1");
  assert.equal(parsed.archived_at, "2026-07-15T00:00:00.000Z", "the injected archive timestamp is recorded");
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
