// Regression gate for FND-20260902-67ce -- the beacon.mjs half of the fix. A session whose kb-memory
// hooks are not wired YET (session-start.sh has not reached install-octools-hook.mjs) used to read
// identically to a genuinely broken agent: both computed hooksWired()=false -> status=DARK. Verified
// live 2026-09-02: an agent's most recent beacon read DARK while `whoami` PASSED on 2093 ledger
// entries and hooksWired() returned true against the live settings moments later -- a startup race,
// not a real outage. This pins the new "starting" status + its grace window, the session-start-marker
// / first-seen-stamp session-age clock, and a counterfactual proving the grace window (not some
// unrelated change) is what suppresses the false positive.
import { test, after } from "node:test";
import assert from "node:assert";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, utimesSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// beacon.mjs bakes STARTUP_MARKER/FIRST_SEEN_STAMP paths from homedir() at MODULE-LOAD time (top-level
// consts, not re-read per call), so HOME must point at a scratch dir BEFORE the very first import.
// Every test below shares this one scratch HOME and manages the two marker files directly, rather than
// re-importing per test (node --test runs each *.test.mjs file in its own process by default, so this
// mutation cannot leak into any other test file).
const SCRATCH_HOME = mkdtempSync(join(tmpdir(), "beacon-test-"));
process.env.HOME = SCRATCH_HOME;
process.env.BEACON_STARTUP_GRACE_MIN = "10"; // pin the default this file's tests are written against
const { decideStatus, sessionAgeMin } = await import("../skills/kb-memory/beacon.mjs");

const MARKER = join(SCRATCH_HOME, ".claude", ".octools-installed-commit");
const FIRST_SEEN = join(SCRATCH_HOME, ".claude", "kb-journal", ".beacon-first-seen");
function resetMarkers() {
  rmSync(MARKER, { force: true });
  rmSync(FIRST_SEEN, { force: true });
}

after(() => { rmSync(SCRATCH_HOME, { recursive: true, force: true }); });

// ---------------------------------------------------------------------------------------------------
// decideStatus(): the pure core. No I/O, so these are pinned directly against fabricated ageMin values
// (mirrors how fleet-medic's classify() tests are written -- fabricated inputs, no real filesystem).

test("starting-within-grace: hooks not wired + session younger than the grace window -> DISTINCT 'starting' status, not DARK", () => {
  const r = decideStatus({ ledgerSize: 0, hooksWired: false, ageMin: 1 });
  assert.strictEqual(r.status, "starting");
  assert.strictEqual(r.startupGrace, true);
});

test("dark-after-grace: hooks not wired + session OLDER than the grace window -> falls back to the ORIGINAL DARK behaviour", () => {
  const r = decideStatus({ ledgerSize: 0, hooksWired: false, ageMin: 15 });
  assert.strictEqual(r.status, "DARK");
  assert.strictEqual(r.startupGrace, false);
});

test("grace boundary: ageMin exactly equal to graceMin is already OUTSIDE the window (strict less-than, no off-by-one)", () => {
  const r = decideStatus({ ledgerSize: 0, hooksWired: false, ageMin: 10, graceMin: 10 });
  assert.strictEqual(r.status, "DARK");
  assert.strictEqual(r.startupGrace, false);
});

test("a WIRED session is byte-identical to the pre-fix formula regardless of age -- the grace window never applies when hooks ARE wired", () => {
  assert.strictEqual(decideStatus({ ledgerSize: 5, hooksWired: true, ageMin: 1 }).status, "LIVE");
  assert.strictEqual(decideStatus({ ledgerSize: 5, hooksWired: true, ageMin: 999 }).status, "LIVE");
  // wired but genuinely empty ledger is still a real DARK, not "starting" -- hooksWired gates the
  // grace path entirely, so a truly-broken wired agent is never masked by this fix.
  assert.strictEqual(decideStatus({ ledgerSize: 0, hooksWired: true, ageMin: 1 }).status, "DARK");
});

test("counterfactual: graceMin:0 (the pre-fix-equivalent) reproduces the ORIGINAL false positive -- proving the grace window is what suppresses it, not some other change", () => {
  const r = decideStatus({ ledgerSize: 0, hooksWired: false, ageMin: 1, graceMin: 0 });
  assert.strictEqual(r.status, "DARK", "graceMin:0 must reproduce the pre-fix DARK-on-startup false positive");
  assert.strictEqual(r.startupGrace, false);
});

test("BEACON_STARTUP_GRACE_MIN env var actually drives the default graceMin (not hardcoded)", async () => {
  // Cache-bust the import (a distinct query string forces Node's ESM loader to re-evaluate the module
  // fresh, so the new env value is captured into a NEW copy of the GRACE_MIN module constant) rather
  // than relying on the file-level default of 10 pinned above.
  process.env.BEACON_STARTUP_GRACE_MIN = "3";
  const fresh = await import(`../skills/kb-memory/beacon.mjs?envtest=${Date.now()}`);
  assert.strictEqual(fresh.decideStatus({ ledgerSize: 0, hooksWired: false, ageMin: 2 }).status, "starting", "2m old should be inside a 3m grace window");
  assert.strictEqual(fresh.decideStatus({ ledgerSize: 0, hooksWired: false, ageMin: 4 }).status, "DARK", "4m old should be outside a 3m grace window");
  process.env.BEACON_STARTUP_GRACE_MIN = "10"; // restore for any later test in this file
});

// ---------------------------------------------------------------------------------------------------
// sessionAgeMin(): the session-start marker / first-seen-stamp resolution that feeds `ageMin` above.

test("sessionAgeMin(): with no marker and no prior stamp, lazily creates a first-seen stamp and reports ~0", () => {
  resetMarkers();
  const age = sessionAgeMin();
  assert.ok(age >= -0.01 && age < 0.5, `expected ~0, got ${age}`);
  assert.ok(existsSync(FIRST_SEEN), "must have written the fallback first-seen stamp");
});

test("sessionAgeMin(): a second call reuses the SAME first-seen stamp (does not reset the clock on every call)", () => {
  resetMarkers();
  sessionAgeMin(); // creates the stamp
  const before = readFileSync(FIRST_SEEN, "utf8");
  const age = sessionAgeMin();
  assert.strictEqual(readFileSync(FIRST_SEEN, "utf8"), before, "must not overwrite an existing first-seen stamp");
  assert.ok(age >= 0, `age should be non-negative, got ${age}`);
});

test("sessionAgeMin(): the session-start marker, when present, TAKES PRIORITY over the first-seen fallback and reflects its own mtime", () => {
  resetMarkers();
  mkdirSync(join(SCRATCH_HOME, ".claude"), { recursive: true });
  writeFileSync(MARKER, "deadbeef");
  const old = new Date(Date.now() - 15 * 60000);
  utimesSync(MARKER, old, old);
  const age = sessionAgeMin();
  assert.ok(age > 14 && age < 16, `expected ~15min, got ${age}`);
});

test("sessionAgeMin(): a freshly re-stamped marker (session-start.sh just ran again) reports ~0 even with an older first-seen stamp also present", () => {
  resetMarkers();
  sessionAgeMin(); // seed a first-seen stamp (would read ~0 age on its own too, so make it stale)
  const old = new Date(Date.now() - 60 * 60000);
  utimesSync(FIRST_SEEN, old, old);
  mkdirSync(join(SCRATCH_HOME, ".claude"), { recursive: true });
  writeFileSync(MARKER, "freshcommit");
  const age = sessionAgeMin();
  assert.ok(age >= -0.01 && age < 0.5, `expected ~0 (marker wins over the older first-seen stamp), got ${age}`);
});
