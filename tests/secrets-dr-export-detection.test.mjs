// Regression test for hasRotatePersistFailure() in secrets-dr-export.mjs (2026-07-28 review finding:
// this exact detection logic had a real bug earlier this session that no test caught -- the first
// version scanned only execFileSync's stdout-only return value, but the marker it needs to detect is
// written to STDERR by the underlying OneDrive engine (skills/cfo-onedrive/onedrive.mjs, via
// console.error), so the check could never fire. Pinning this here so a future refactor of
// deliverToOneDrive() cannot silently reintroduce a stdout-only (or stderr-only) scan.
import { test } from "node:test";
import assert from "node:assert/strict";
import { hasRotatePersistFailure } from "../skills/fleet-backup/secrets-dr-export.mjs";

test("detects the marker on stderr alone (the real-world case -- onedrive.mjs logs it via console.error)", () => {
  assert.equal(hasRotatePersistFailure("", "ROTATE PERSIST FAILED: SM write 403"), true);
});

test("detects the marker on stdout alone (defensive -- covers a future engine that logs to stdout instead)", () => {
  assert.equal(hasRotatePersistFailure("ROTATE PERSIST FAILED: SM write 403", ""), true);
});

test("detects the marker when both streams are non-empty and only one contains it", () => {
  assert.equal(hasRotatePersistFailure("normal delivery log line", "ROTATE PERSIST FAILED: SM write 403"), true);
});

test("does not false-positive on ordinary successful delivery output", () => {
  assert.equal(hasRotatePersistFailure("rotated OneDrive refresh token -> persisted.\nupload complete", ""), false);
});

test("handles undefined/null streams without throwing (defensive against a spawnSync shape change)", () => {
  assert.equal(hasRotatePersistFailure(undefined, undefined), false);
  assert.equal(hasRotatePersistFailure(null, null), false);
});
