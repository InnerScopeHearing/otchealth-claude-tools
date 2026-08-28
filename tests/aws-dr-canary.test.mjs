// Tests for skills/aws-dr-canary/canary.mjs's pure functions: the RDS XML parser, the
// newest-available-snapshot picker, the n8n Lightsail AutoSnapshot classifiers, the n8n /healthz status
// classifier, the weekly-drill day-of-week gate, and the report-vs-strict exit code policy. No network,
// no AWS credentials, no live RDS/OpenSearch/S3/Lightsail access.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseDbSnapshotsXml,
  pickNewestAvailable,
  isAutoSnapshotAddOnEnabled,
  pickNewestSuccessfulAutoSnapshot,
  assessAutoSnapshotFreshness,
  classifyHealthzStatus,
  shouldRunDrillToday,
  pageExitCode,
} from "../skills/aws-dr-canary/canary.mjs";

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

// ---------- n8n Lightsail AutoSnapshot add-on state ----------

test("isAutoSnapshotAddOnEnabled: AutoSnapshot add-on present and Enabled", () => {
  const instance = { instance: { addOns: [{ name: "AutoSnapshot", status: "Enabled", snapshotTimeOfDay: "06:00" }] } };
  assert.equal(isAutoSnapshotAddOnEnabled(instance), true);
});

test("isAutoSnapshotAddOnEnabled: AutoSnapshot add-on present but Disabled is a real, distinct anomaly", () => {
  const instance = { instance: { addOns: [{ name: "AutoSnapshot", status: "Disabled" }] } };
  assert.equal(isAutoSnapshotAddOnEnabled(instance), false);
});

test("isAutoSnapshotAddOnEnabled: addOns present but with no AutoSnapshot entry at all is not enabled", () => {
  const instance = { instance: { addOns: [{ name: "StopInstanceOnIdle", status: "Enabled" }] } };
  assert.equal(isAutoSnapshotAddOnEnabled(instance), false);
});

test("isAutoSnapshotAddOnEnabled: a missing addOns array (or a missing instance entirely) never assumes enabled", () => {
  assert.equal(isAutoSnapshotAddOnEnabled({ instance: {} }), false);
  assert.equal(isAutoSnapshotAddOnEnabled({}), false);
  assert.equal(isAutoSnapshotAddOnEnabled(null), false);
  assert.equal(isAutoSnapshotAddOnEnabled(undefined), false);
});

// ---------- n8n Lightsail AutoSnapshot freshness ----------

const T = (iso) => Date.parse(iso) / 1000; // Lightsail's own epoch-SECONDS createdAt convention

const SAMPLE_AUTO_SNAPSHOTS = [
  { date: "2026-08-28", createdAt: T("2026-08-28T06:00:00Z"), status: "Success" },
  { date: "2026-08-27", createdAt: T("2026-08-27T06:00:00Z"), status: "Success" },
  // Newer than both Success rows above, but NOT itself a success -- must never be picked.
  { date: "2026-08-29", createdAt: T("2026-08-29T06:00:00Z"), status: "InProgress" },
];

test("pickNewestSuccessfulAutoSnapshot: picks the newest Success row, ignoring a newer InProgress row", () => {
  const newest = pickNewestSuccessfulAutoSnapshot(SAMPLE_AUTO_SNAPSHOTS);
  assert.equal(newest.date, "2026-08-28");
  assert.equal(newest.status, "Success");
});

test("pickNewestSuccessfulAutoSnapshot: returns null when there is no Success row at all", () => {
  assert.equal(pickNewestSuccessfulAutoSnapshot([{ date: "2026-08-29", createdAt: T("2026-08-29T06:00:00Z"), status: "InProgress" }]), null);
  assert.equal(pickNewestSuccessfulAutoSnapshot([{ date: "2026-08-28", createdAt: T("2026-08-28T06:00:00Z"), status: "Failed" }]), null);
  assert.equal(pickNewestSuccessfulAutoSnapshot([]), null);
  assert.equal(pickNewestSuccessfulAutoSnapshot(undefined), null);
});

test("assessAutoSnapshotFreshness: a fresh successful snapshot PASSES", () => {
  const newest = { date: "2026-08-28", createdAt: T("2026-08-28T06:00:00Z"), status: "Success" };
  const now = Date.parse("2026-08-28T08:00:00Z"); // 2h old, SLO 26h
  const v = assessAutoSnapshotFreshness(newest, now, 26);
  assert.equal(v.state, "OK");
  assert.equal(v.ageH, 2);
});

test("assessAutoSnapshotFreshness: a stale successful snapshot FAILS (AutoSnapshot silently stopped landing)", () => {
  const newest = { date: "2026-08-20", createdAt: T("2026-08-20T06:00:00Z"), status: "Success" };
  const now = Date.parse("2026-08-28T06:00:00Z"); // 8 days = 192h old, SLO 26h
  const v = assessAutoSnapshotFreshness(newest, now, 26);
  assert.equal(v.state, "STALE");
  assert.equal(v.ageH, 192);
  assert.match(v.reason, /192\.0h old/);
});

test("assessAutoSnapshotFreshness: no successful snapshot at all is STALE, with a distinct reason from a merely-old one", () => {
  const v = assessAutoSnapshotFreshness(null, Date.now(), 26);
  assert.equal(v.state, "STALE");
  assert.match(v.reason, /no successful auto-snapshot/);
});

test("assessAutoSnapshotFreshness: exactly at the SLO boundary is still OK (<=), matching assessFreshness()'s own convention", () => {
  const newest = { date: "2026-08-25", createdAt: T("2026-08-25T06:00:00Z"), status: "Success" };
  const now = Date.parse("2026-08-25T06:00:00Z") + 26 * 3_600_000;
  const v = assessAutoSnapshotFreshness(newest, now, 26);
  assert.equal(v.state, "OK");
});

// ---------- n8n /healthz reachability ----------

test("classifyHealthzStatus: HTTP 200 PASSES", () => {
  assert.equal(classifyHealthzStatus(200), "OK");
});

test("classifyHealthzStatus: any non-200 status FAILS, including 0 for a network-level failure", () => {
  assert.equal(classifyHealthzStatus(502), "ERROR");
  assert.equal(classifyHealthzStatus(404), "ERROR");
  assert.equal(classifyHealthzStatus(301), "ERROR");
  assert.equal(classifyHealthzStatus(0), "ERROR");
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
