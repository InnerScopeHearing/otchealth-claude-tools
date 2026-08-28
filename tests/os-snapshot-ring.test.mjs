// Tests for os-snapshot.mjs's pure ring-classification + snapshot-selection logic. No network, no
// AWS credentials, no OpenSearch cluster -- the exact thing that must be right before any live
// registration/policy call is trusted: which indices the non-privileged snapshot policy is allowed to
// touch, and which snapshot row counts as "the current recovery point".
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildNonPrivilegedIndexPattern, classifyIndexLane, newestSuccessfulSnapshot } from "../skills/fleet-backup/os-snapshot.mjs";
import { PRIVILEGED_SUBSTRINGS } from "../skills/fleet-backup/s3-mirror.mjs";

test("buildNonPrivilegedIndexPattern excludes every s3-mirror.mjs privileged substring, wildcarded", () => {
  const pattern = buildNonPrivilegedIndexPattern();
  assert.ok(pattern.startsWith("*,"), "pattern must start with a broad positive '*' selection");
  for (const s of PRIVILEGED_SUBSTRINGS) {
    assert.ok(pattern.includes(`-*${s}*`), `pattern is missing an exclude for privileged substring "${s}": ${pattern}`);
  }
});

test("buildNonPrivilegedIndexPattern also excludes the OpenSearch system index families", () => {
  const pattern = buildNonPrivilegedIndexPattern();
  for (const sys of ["-.opendistro*", "-.opensearch*", "-.kibana*", "-.plugins*"]) {
    assert.ok(pattern.includes(sys), `pattern is missing system exclude "${sys}": ${pattern}`);
  }
});

test("classifyIndexLane: real non-privileged room names classify as non-privileged", () => {
  for (const name of ["memory-exec", "commons-company-journal", "commerce-commerce-source-docs"]) {
    assert.equal(classifyIndexLane(name), "non-privileged", name);
  }
});

test("classifyIndexLane: personal-legal rooms classify as personal-legal, never non-privileged", () => {
  for (const name of ["legal-personal", "legal-personal-memory"]) {
    assert.equal(classifyIndexLane(name), "personal-legal", name);
  }
});

test("classifyIndexLane: finance/company-legal rooms classify as finance-company-legal", () => {
  for (const name of ["finance-cfo-source-docs", "finance-cfo-memory", "legal-company"]) {
    assert.equal(classifyIndexLane(name), "finance-company-legal", name);
  }
});

test("classifyIndexLane: personal-legal wins priority over a name that could also read as finance/company (matches s3-mirror.mjs's priority order)", () => {
  // a hypothetical index containing both a personal marker and "cfo" -- personal-legal must win
  assert.equal(classifyIndexLane("cfo-personal-notes"), "personal-legal");
});

test("classifyIndexLane: OpenSearch system indices classify as system, not non-privileged", () => {
  assert.equal(classifyIndexLane(".opendistro_security"), "system");
  assert.equal(classifyIndexLane(".kibana_1"), "system");
});

test("newestSuccessfulSnapshot: picks the SUCCESS row with the highest end_epoch, ignoring IN_PROGRESS/FAILED even if newer", () => {
  const rows = [
    { id: "old-ok", status: "SUCCESS", end_epoch: "1000" },
    { id: "newer-in-progress", status: "IN_PROGRESS", end_epoch: "2000" },
    { id: "newest-failed", status: "FAILED", end_epoch: "3000" },
  ];
  const picked = newestSuccessfulSnapshot(rows);
  assert.equal(picked.id, "old-ok", "must not be fooled by a newer non-SUCCESS row");
});

test("newestSuccessfulSnapshot: returns null when there is no SUCCESS row at all", () => {
  assert.equal(newestSuccessfulSnapshot([{ id: "a", status: "IN_PROGRESS", end_epoch: "1" }]), null);
  assert.equal(newestSuccessfulSnapshot([]), null);
  assert.equal(newestSuccessfulSnapshot(undefined), null);
});

test("newestSuccessfulSnapshot: among multiple SUCCESS rows, picks the highest end_epoch", () => {
  const rows = [
    { id: "a", status: "SUCCESS", end_epoch: "500" },
    { id: "b", status: "SUCCESS", end_epoch: "1500" },
    { id: "c", status: "SUCCESS", end_epoch: "999" },
  ];
  assert.equal(newestSuccessfulSnapshot(rows).id, "b");
});
