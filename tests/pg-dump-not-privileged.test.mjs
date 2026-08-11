// Regression guard tying skills/fleet-backup/pg-dump.mjs to skills/fleet-backup/s3-mirror.mjs's ring-
// segregation classification (README.md "ring segregation, hard compliance requirement"). pg-dump.mjs's
// design (see its own header) depends entirely on `pg-dumps/<db>-<date>.sql.gz` being classified
// NON-privileged by s3-mirror.mjs's existing, unmodified logic -- that is what lets the two scripts
// integrate with zero code changes to s3-mirror.mjs itself. If a future rename of either the blob-name
// convention (pg-dump.mjs) OR the privileged-substring list (s3-mirror.mjs) ever made these names match
// each other, the pg dumps would silently stop reaching the S3 DR bucket (classified privileged, routed
// to the separate, double-opt-in, currently-inert privileged lane instead) with no error anywhere --
// exactly the "coverage silently dropped" failure class the rest of this skill directory works hard to
// avoid. This test imports BOTH real modules (not a hand-copied literal of either) so it fails the
// instant that drift actually happens, in either direction.
import { test } from "node:test";
import assert from "node:assert/strict";
import { pgDumpBlobName } from "../skills/fleet-backup/pg-dump.mjs";
import { isPrivilegedByName } from "../skills/fleet-backup/s3-mirror.mjs";

test("pg-dump blob names for the current fleet databases are NOT classified privileged", () => {
  for (const db of ["flatstick", "fourvault"]) {
    const name = pgDumpBlobName(db, "2026-08-04");
    assert.equal(isPrivilegedByName(name), false, `${name} must reach the non-privileged S3 DR bucket`);
  }
});

test("a hypothetical future privileged-sounding database name WOULD correctly be classified privileged (proves the guard above is a real assertion, not a tautology)", () => {
  // not a real fleet database -- purely proves isPrivilegedByName still does its job against this exact
  // blob-naming shape, so the test above is meaningfully exercising the classifier, not just checking
  // that "flatstick"/"fourvault" happen not to contain banned substrings by coincidence
  assert.equal(isPrivilegedByName(pgDumpBlobName("medreview", "2026-08-04")), true);
  assert.equal(isPrivilegedByName(pgDumpBlobName("finance-ledger", "2026-08-04")), true);
});
