// Tests for skills/fleet-backup/restore-drill.mjs's pure selection helpers: which manifest to read,
// and which blobs a drill run should verify. Pure, deterministic, no network/credential dependency.
import { test } from "node:test";
import assert from "node:assert/strict";
import { latestManifestName, selectDrillTargets } from "../skills/fleet-backup/restore-drill.mjs";

test("latestManifestName: picks the most recent date, ignores non-manifest blobs", () => {
  const names = [
    "tasks-2026-07-14.jsonl",
    "s3-mirror-manifest-2026-07-13.json",
    "s3-mirror-manifest-2026-07-15.json",
    "s3-mirror-manifest-2026-07-14.json",
    "manifest-2026-07-15.json", // backup.mjs's own manifest -- NOT an s3-mirror manifest, must be ignored
  ];
  assert.equal(latestManifestName(names), "s3-mirror-manifest-2026-07-15.json");
});

test("latestManifestName: null when no s3-mirror manifest exists", () => {
  assert.equal(latestManifestName(["tasks-2026-07-14.jsonl", "manifest-2026-07-14.json"]), null);
  assert.equal(latestManifestName([]), null);
});

const SAMPLE_MANIFEST = {
  ts: "2026-07-22T06:50:00.000Z",
  mirrored: [
    { blob: "tasks-2026-07-22.jsonl", bucket: "otchealth-brain-dr-55c84f6b", sha256: "aaaa" },
    { blob: "dry-run-blob.jsonl", bucket: "otchealth-brain-dr-55c84f6b", sha256: "bbbb", dryRun: true },
    { blob: "no-sha-yet.jsonl", bucket: "otchealth-brain-dr-55c84f6b" }, // no sha256 -- must be excluded
  ],
  skippedUnchanged: [
    { blob: "index-memory-exec-2026-07-21.jsonl", bucket: "otchealth-brain-dr-55c84f6b", sha256: "cccc" },
    { blob: "index-legal-company-2026-07-21.jsonl", bucket: "some-other-privileged-bucket", sha256: "dddd" },
  ],
};

test("selectDrillTargets: with no blobKey, returns every real candidate for the bucket (dryRun and no-sha excluded)", () => {
  const { targets, reason } = selectDrillTargets(SAMPLE_MANIFEST, "otchealth-brain-dr-55c84f6b", undefined);
  assert.equal(reason, null);
  const blobs = targets.map((t) => t.blob).sort();
  assert.deepEqual(blobs, ["index-memory-exec-2026-07-21.jsonl", "tasks-2026-07-22.jsonl"]);
});

test("selectDrillTargets: a bucket mismatch (privileged bucket blob) never leaks into the requested bucket's targets", () => {
  const { targets } = selectDrillTargets(SAMPLE_MANIFEST, "otchealth-brain-dr-55c84f6b", undefined);
  assert.ok(!targets.some((t) => t.bucket === "some-other-privileged-bucket"));
});

test("selectDrillTargets: a specific blobKey narrows to just that one blob", () => {
  const { targets, reason } = selectDrillTargets(SAMPLE_MANIFEST, "otchealth-brain-dr-55c84f6b", "tasks-2026-07-22.jsonl");
  assert.equal(reason, null);
  assert.equal(targets.length, 1);
  assert.equal(targets[0].blob, "tasks-2026-07-22.jsonl");
});

test("selectDrillTargets: an unrecorded blobKey is BLOB_NOT_IN_MANIFEST, not a silent empty pass", () => {
  const { targets, reason } = selectDrillTargets(SAMPLE_MANIFEST, "otchealth-brain-dr-55c84f6b", "never-mirrored.jsonl");
  assert.equal(reason, "BLOB_NOT_IN_MANIFEST");
  assert.equal(targets.length, 0);
});

test("selectDrillTargets: a bucket with nothing recorded at all is NO_CANDIDATES_FOR_BUCKET", () => {
  const { targets, reason } = selectDrillTargets(SAMPLE_MANIFEST, "a-bucket-nothing-was-ever-mirrored-to", undefined);
  assert.equal(reason, "NO_CANDIDATES_FOR_BUCKET");
  assert.equal(targets.length, 0);
});

test("selectDrillTargets: tolerates a manifest with missing mirrored/skippedUnchanged arrays", () => {
  const { targets, reason } = selectDrillTargets({}, "any-bucket", undefined);
  assert.equal(reason, "NO_CANDIDATES_FOR_BUCKET");
  assert.equal(targets.length, 0);
});
