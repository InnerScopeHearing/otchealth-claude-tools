// Tests for skills/aws-dr-canary/canary.mjs's pure functions: the RDS XML parser, the
// newest-available-snapshot picker, the weekly-drill day-of-week gate, and the report-vs-strict exit
// code policy. No network, no AWS credentials, no live RDS/OpenSearch/S3 access.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDbSnapshotsXml, pickNewestAvailable, shouldRunDrillToday, pageExitCode } from "../skills/aws-dr-canary/canary.mjs";

const SAMPLE_XML = `<?xml version="1.0"?>
<DescribeDBSnapshotsResponse xmlns="http://rds.amazonaws.com/doc/2014-10-31/">
  <DescribeDBSnapshotsResult>
    <DBSnapshots>
      <DBSnapshot>
        <DBSnapshotIdentifier>rds:otchealth-pg-2026-08-27-09-00</DBSnapshotIdentifier>
        <SnapshotCreateTime>2026-08-27T09:00:12.000Z</SnapshotCreateTime>
        <Status>available</Status>
      </DBSnapshot>
      <DBSnapshot>
        <DBSnapshotIdentifier>rds:otchealth-pg-2026-08-26-09-00</DBSnapshotIdentifier>
        <SnapshotCreateTime>2026-08-26T09:00:07.000Z</SnapshotCreateTime>
        <Status>available</Status>
      </DBSnapshot>
      <DBSnapshot>
        <DBSnapshotIdentifier>rds:otchealth-pg-2026-08-28-09-00</DBSnapshotIdentifier>
        <SnapshotCreateTime>2026-08-28T09:00:01.000Z</SnapshotCreateTime>
        <Status>creating</Status>
      </DBSnapshot>
    </DBSnapshots>
  </DescribeDBSnapshotsResult>
</DescribeDBSnapshotsResponse>`;

test("parseDbSnapshotsXml extracts createTime + status for every <DBSnapshot> block", () => {
  const rows = parseDbSnapshotsXml(SAMPLE_XML);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], { createTime: "2026-08-27T09:00:12.000Z", status: "available" });
  assert.deepEqual(rows[2], { createTime: "2026-08-28T09:00:01.000Z", status: "creating" });
});

test("parseDbSnapshotsXml returns [] for a response with no DBSnapshot blocks", () => {
  assert.deepEqual(parseDbSnapshotsXml("<DescribeDBSnapshotsResponse></DescribeDBSnapshotsResponse>"), []);
});

test("pickNewestAvailable ignores a newer 'creating' row and picks the newest 'available' one", () => {
  const rows = parseDbSnapshotsXml(SAMPLE_XML);
  const newest = pickNewestAvailable(rows);
  assert.equal(newest.createTime, "2026-08-27T09:00:12.000Z"); // NOT the 08-28 'creating' row
});

test("pickNewestAvailable returns null when there is no 'available' row at all", () => {
  assert.equal(pickNewestAvailable([{ createTime: "2026-08-28T00:00:00Z", status: "creating" }]), null);
  assert.equal(pickNewestAvailable([]), null);
  assert.equal(pickNewestAvailable(undefined), null);
});

test("shouldRunDrillToday: matches the configured UTC day-of-week exactly", () => {
  const sunday = new Date("2026-08-30T12:00:00Z"); // a known Sunday (getUTCDay() === 0)
  const monday = new Date("2026-08-31T12:00:00Z");
  assert.equal(shouldRunDrillToday(sunday, 0), true);
  assert.equal(shouldRunDrillToday(monday, 0), false);
  assert.equal(shouldRunDrillToday(monday, 1), true);
});

test("pageExitCode: report-only mode (strict=false) never exits non-zero, even with anomalies", () => {
  const results = [{ status: "STALE" }, { status: "ERROR" }];
  assert.equal(pageExitCode(results, false), 0);
});

test("pageExitCode: --strict exits non-zero when any STALE or ERROR is present", () => {
  assert.equal(pageExitCode([{ status: "STALE" }], true), 1);
  assert.equal(pageExitCode([{ status: "ERROR" }], true), 1);
});

test("pageExitCode: --strict stays zero when every result is OK or SKIPPED", () => {
  assert.equal(pageExitCode([{ status: "OK" }, { status: "SKIPPED" }], true), 0);
});
