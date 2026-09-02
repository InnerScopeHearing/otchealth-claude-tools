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

test("docintel-ocr-sweep is retired, not merely deleted: the reason survives in the registry", () => {
  // Its backend (Azure Document Intelligence) died with subscription 55c84f6b on 2026-08-13 and the
  // EventBridge schedule otchealth-docintel-ocr-sweep was DISABLED on 2026-09-01, so it cannot beat.
  assert.ok(!("docintel-ocr-sweep" in REG), "the live row must be gone or check() pages on it forever");
  const retired = REG["_retired_docintel-ocr-sweep"];
  assert.ok(retired, "the retirement must stay documented in the registry, not just vanish");
  assert.match(String(retired.note), /Document Intelligence/i);
  assert.ok(retired.retired, "a retired row carries the date it was retired");
});

test("no retired key can shadow a live one (a job is watched or retired, never both)", () => {
  const live = new Set(Object.keys(REG).filter(isWatchedJobKey));
  for (const k of Object.keys(REG).filter((x) => !isWatchedJobKey(x))) {
    const bare = k.replace(/^_retired_/, "");
    assert.ok(!live.has(bare), `${bare} is both live and retired in the registry`);
  }
});
