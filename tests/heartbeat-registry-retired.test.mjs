// Regression gate for the RETIRED-JOB convention in the heartbeat registry (setup/heartbeat.mjs
// isWatchedJobKey + loadRegistry's filter, added 2026-09-01).
//
// WHY THIS EXISTS. Retiring a scheduled job used to be a lose-lose: delete its registry row and the
// reason it was retired is gone from the file that decides what gets watched; keep the row and
// `heartbeat check` reports it DEAD forever, because a DISABLED or DELETED job can never beat. The
// second failure mode is the dangerous one -- it pages on every sentinel run for a job nobody
// intends to run, which trains the reader to ignore the pager. claude-tools#487 hit exactly this
// when azure-canary's workflow was deleted while its registry entry stayed live.
//
// The convention: a key starting with "_" is documentation, not a watched job. This test pins both
// halves, because a filter that is too broad is its own outage: a real job must never be silently
// dropped from the watch set by a naming accident.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { isWatchedJobKey } from "../setup/heartbeat.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REG = JSON.parse(readFileSync(join(HERE, "..", "setup", "heartbeat-registry.json"), "utf8"));

test("an underscore-prefixed key is documentation, not a watched job", () => {
  assert.equal(isWatchedJobKey("_retired_docintel-ocr-sweep"), false);
  assert.equal(isWatchedJobKey("_note"), false);
});

test("every ordinary job name is still watched (the filter is not over-broad)", () => {
  for (const k of ["daily-digest", "librarian-finance", "innd-stock-daily", "brain-reindex", "os-healthz-monitor"]) {
    assert.equal(isWatchedJobKey(k), true, `${k} must stay in the watch set`);
  }
});

test("docintel-ocr-sweep is REVIVED (2026-09-03, Textract): live row present, retirement history retained", () => {
  // Retired 2026-09-01 (Azure Document Intelligence died with subscription 55c84f6b); revived 2026-09-03
  // on Amazon Textract (claude-tools#540/#542, task def otchealth-job-docintel-ocr-sweep:3). The live row
  // must be back in the watch set, and the reason it was ever retired must survive as documentation.
  assert.ok("docintel-ocr-sweep" in REG, "the live row must be back so check() watches the Textract sweep");
  assert.equal(isWatchedJobKey("docintel-ocr-sweep"), true);
  assert.equal(REG["docintel-ocr-sweep"].interval_min, 120);
  assert.ok(!("_retired_docintel-ocr-sweep" in REG), "a job is watched or retired, never both");
  const hist = REG["_history_docintel-ocr-sweep"];
  assert.ok(hist, "the retirement history must survive in the registry, not just vanish");
  assert.match(String(hist.note), /Document Intelligence/i);
  assert.match(String(hist.note), /Textract/);
  assert.ok(hist.retired && hist.revived, "history carries both the retired and the revived dates");
  assert.equal(isWatchedJobKey("_history_docintel-ocr-sweep"), false);
});

test("no retired key can shadow a live one (a job is watched or retired, never both)", () => {
  const live = new Set(Object.keys(REG).filter(isWatchedJobKey));
  for (const k of Object.keys(REG).filter((x) => !isWatchedJobKey(x))) {
    const bare = k.replace(/^_retired_/, "");
    assert.ok(!live.has(bare), `${bare} is both live and retired in the registry`);
  }
});
