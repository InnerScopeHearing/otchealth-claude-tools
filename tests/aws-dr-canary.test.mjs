// Tests for skills/aws-dr-canary/canary.mjs's pure functions: the RDS XML parser, the
// newest-available-snapshot picker, the n8n Lightsail AutoSnapshot classifiers, the n8n /healthz status
// classifier, the weekly-drill day-of-week gate, the report-vs-strict exit code policy, and (2026-08-29)
// the per-room brain-freshness check (FND-20260828-3142's canary half). The brain-freshness section adds
// a second style of test beyond the pure-function style above: a stubbed-`fetch` integration test of
// checkOneBrainRoomFreshness() itself, because that function's OWN job (S3-listing -> age-gate ->
// OpenSearch _count) is the thing that most needs a regression guard, not just its inner pure pieces.
// Still no real network, no real AWS credentials, and (this matters for this file specifically) no real
// call ever reaches the live otchealth-brain OpenSearch domain or the live DR buckets -- every fetch is
// intercepted by an in-memory stub that throws on anything it does not recognize, so a bug that widened
// what this check touches would fail the test loudly rather than silently phoning home.
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
  isRoomPipelineInternal,
  pickNewestSourceBlob,
  resolveRoomSloHours,
  assessRoomFreshness,
  checkOneBrainRoomFreshness,
  BRAIN_ROOMS,
} from "../skills/aws-dr-canary/canary.mjs";
import { classifyIndexLane } from "../skills/fleet-backup/os-snapshot.mjs";
import { _resetCredsCacheForTests } from "../skills/kb-memory/s3-blob.mjs";
import { _resetCachesForTests as _resetOpenSearchCachesForTests } from "../skills/kb-memory/opensearch-write.mjs";

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

// ============================ check 7: per-room brain freshness ============================

// ---------- pure functions: no network, no AWS credentials ----------

test("isRoomPipelineInternal: recognizes every pipeline-bookkeeping prefix, and only those", () => {
  for (const p of ["_TEXT/a.txt", "_CATALOG/catalog.jsonl", "_REVIEW/low-confidence.csv", "_MEMORY/_exec/cto.jsonl", "_STATE/x", "_ARCHIVE/old.jsonl", "_SUMMARY/s.md", "_TRASH/deleted.pdf", "_NON-ACCOUNTING/logo.png", "_DUPLICATES/dup.pdf", "_HANDOFF/note.md", "_DISPATCH/task.json"]) {
    assert.equal(isRoomPipelineInternal(p), true, `expected ${p} to be pipeline-internal`);
  }
  for (const p of ["invoices/2026/statement.pdf", "shopify-library/00-index.md", "innd/board-minutes.pdf"]) {
    assert.equal(isRoomPipelineInternal(p), false, `expected ${p} to be a real source object`);
  }
});

test("isRoomPipelineInternal: a prefix match must be at the START of the name, not merely a substring", () => {
  // "invoices/_TEXT/mid-path.pdf" is NOT excluded by the "_TEXT/" rule -- only a TOP-level "_TEXT/..."
  // object is pipeline bookkeeping; a real document that happens to have "_TEXT" later in its own path
  // must never be silently treated as pipeline-internal.
  assert.equal(isRoomPipelineInternal("invoices/_TEXT/mid-path.pdf"), false);
});

test("pickNewestSourceBlob: picks the newest REAL object, ignoring pipeline-internal paths and directory markers even when they are individually newer", () => {
  const blobs = [
    { name: "invoices/jan.pdf", lastModified: "2026-08-01T00:00:00Z" },
    { name: "_TEXT/invoices/jan.pdf.txt", lastModified: "2026-08-29T00:00:00Z" }, // newest raw timestamp, must be ignored (this canary's own pipeline artifact)
    { name: "invoices/feb.pdf", lastModified: "2026-08-15T00:00:00Z" }, // the real newest
    { name: "some-folder/", lastModified: "2026-08-30T00:00:00Z" }, // directory marker, must be ignored
    { name: "_CATALOG/catalog.jsonl", lastModified: "2026-08-28T00:00:00Z" },
  ];
  const newest = pickNewestSourceBlob(blobs);
  assert.equal(newest.name, "invoices/feb.pdf");
});

test("pickNewestSourceBlob: returns null when nothing real is left (empty room, or every object filtered out)", () => {
  assert.equal(pickNewestSourceBlob([]), null);
  assert.equal(pickNewestSourceBlob(undefined), null);
  assert.equal(pickNewestSourceBlob([{ name: "_CATALOG/catalog.jsonl", lastModified: "2026-08-28T00:00:00Z" }]), null);
  assert.equal(pickNewestSourceBlob([{ name: "dir/", lastModified: "2026-08-28T00:00:00Z" }]), null);
});

test("resolveRoomSloHours: falls back to the room's own sloHours when no env override is set", () => {
  delete process.env.BRAIN_FRESHNESS_SLO_H_LEGAL_COMPANY;
  assert.equal(resolveRoomSloHours({ name: "legal-company", sloHours: 168 }), 168);
});

test("resolveRoomSloHours: falls back to the 26h default when a room omits sloHours entirely", () => {
  assert.equal(resolveRoomSloHours({ name: "some-new-room" }), 26);
});

test("resolveRoomSloHours: an env override (BRAIN_FRESHNESS_SLO_H_<ROOM>) wins over the room's own default", () => {
  process.env.BRAIN_FRESHNESS_SLO_H_LEGAL_COMPANY = "12";
  try {
    assert.equal(resolveRoomSloHours({ name: "legal-company", sloHours: 168 }), 12);
  } finally {
    delete process.env.BRAIN_FRESHNESS_SLO_H_LEGAL_COMPANY;
  }
});

test("resolveRoomSloHours: a non-numeric or non-positive env override is ignored, not treated as 0h", () => {
  for (const bad of ["not-a-number", "0", "-5", ""]) {
    process.env.BRAIN_FRESHNESS_SLO_H_COMMONS_COMPANY_JOURNAL = bad;
    try {
      assert.equal(resolveRoomSloHours({ name: "commons-company-journal", sloHours: 48 }), 48, `bad override "${bad}" must not win`);
    } finally {
      delete process.env.BRAIN_FRESHNESS_SLO_H_COMMONS_COMPANY_JOURNAL;
    }
  }
});

test("assessRoomFreshness: still within the SLO is OK regardless of indexedCount (never even checked)", () => {
  const v = assessRoomFreshness(2, 26, null);
  assert.equal(v.state, "OK");
  assert.match(v.reason, /within the 26h SLO/);
});

test("assessRoomFreshness: exactly at the SLO boundary is still OK (<=), matching this file's other assess*Freshness() convention", () => {
  assert.equal(assessRoomFreshness(26, 26, null).state, "OK");
});

test("assessRoomFreshness: past the SLO but present in the index (indexedCount > 0) is OK", () => {
  const v = assessRoomFreshness(30, 26, 3);
  assert.equal(v.state, "OK");
  assert.match(v.reason, /IS present in the index \(3 chunk\(s\)/);
});

test("assessRoomFreshness: past the SLO with zero chunks found is the real STALE finding", () => {
  const v = assessRoomFreshness(30, 26, 0);
  assert.equal(v.state, "STALE");
  assert.match(v.reason, /ZERO chunks found/);
});

test("BRAIN_ROOMS: every entry's index name classifies via the SAME classifyIndexLane() this check itself uses -- the registry's own ring-safety self-check", () => {
  const expected = {
    "commons-company-journal": "non-privileged",
    "commerce-commerce-source-docs": "non-privileged",
    "finance-cfo-source-docs": "finance-company-legal",
    "legal-company": "finance-company-legal",
    "legal-personal": "personal-legal",
  };
  assert.equal(BRAIN_ROOMS.length, 5);
  for (const room of BRAIN_ROOMS) {
    assert.equal(room.name, room.index, `room "${room.name}" must have index === name (this check's own naming convention)`);
    assert.equal(classifyIndexLane(room.index), expected[room.name], `unexpected lane for ${room.name}`);
  }
  // Exactly two rooms are non-privileged (actively checked); three are ring-excluded.
  const lanes = BRAIN_ROOMS.map((r) => classifyIndexLane(r.index));
  assert.equal(lanes.filter((l) => l === "non-privileged").length, 2);
  assert.equal(lanes.filter((l) => l !== "non-privileged").length, 3);
});

// ---------- stubbed-fetch integration tests of checkOneBrainRoomFreshness() ----------
// Mirrors tests/fleet-search-s3.test.mjs's exact withStubbedFetch/withEnv/makeStore-style convention.
// EVERY test below intercepts globalThis.fetch completely; the stub throws on any host/path it does
// not recognize, so a bug that made this check reach further than S3 + the configured OpenSearch host
// would fail LOUD here rather than silently reaching a real endpoint.

const OS_HOST = "unit-test-opensearch.us-east-1.es.amazonaws.com";
const FAKE_ENV = {
  AWS_ACCESS_KEY_ID: "AKIAUNITTESTFAKE0001",
  AWS_SECRET_ACCESS_KEY: "unit-test-fake-secret-access-key-not-real",
  OPENSEARCH_ENDPOINT: OS_HOST,
  OPENSEARCH_REGION: "us-east-1",
};

async function withStubbedFetch(stub, run) {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try { return await run(); } finally { globalThis.fetch = original; }
}
async function withEnv(vars, run) {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; process.env[k] = vars[k]; }
  _resetCredsCacheForTests();
  _resetOpenSearchCachesForTests();
  try { return await run(); } finally {
    for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    _resetCredsCacheForTests();
    _resetOpenSearchCachesForTests();
  }
}

/** A combined S3 + OpenSearch fetch stub. `s3Objects` seeds the S3 world, keyed by the full S3 path
 *  (leading '/', matching the raw pathname a real S3 request carries), each value `{body, lastModified}`
 *  -- body content is irrelevant to this check (only LastModified matters), `lastModified` is an ISO
 *  string rendered verbatim into the mock `<Contents>` block. `osCountResponse` is either a plain
 *  `{count: N}` object (served as a 200 JSON body for every `_count` call) or a function
 *  `(pathValue) => ({count})` / `(pathValue) => ({status, ok, text})` for a test that needs to assert on
 *  which exact path was queried, or to simulate a non-2xx response; `osThrows` simulates a network-level
 *  exception on the `_count` call instead. Any request to a host that is neither an S3 bucket host nor
 *  OS_HOST throws, by design -- this check must never reach anywhere else. */
function makeWorld({ s3Objects = {}, osCountResponse = { count: 0 }, osThrows = null } = {}) {
  const objects = new Map(Object.entries(s3Objects)); // key -> { body, lastModified }
  const calls = [];
  const stub = async (url, opts = {}) => {
    const u = String(url);
    const { hostname, pathname, searchParams } = new URL(u);
    const method = (opts.method || "GET").toUpperCase();
    calls.push({ method, host: hostname, path: pathname, body: opts.body });
    if (hostname.endsWith(".s3.us-east-1.amazonaws.com")) {
      if (searchParams.get("list-type") === "2") {
        const prefix = searchParams.get("prefix") || "";
        const contents = [...objects.entries()]
          .filter(([k]) => k.startsWith("/" + prefix))
          .map(([k, v]) => `<Contents><Key>${k.slice(1)}</Key><Size>${(v.body || "").length}</Size><LastModified>${v.lastModified}</LastModified></Contents>`)
          .join("");
        return { ok: true, status: 200, text: async () => `<ListBucketResult>${contents}<IsTruncated>false</IsTruncated></ListBucketResult>` };
      }
      return { ok: false, status: 404, text: async () => "unexpected S3 call in this test" };
    }
    if (hostname === OS_HOST) {
      if (pathname.endsWith("/_count")) {
        if (osThrows) throw new Error(osThrows);
        const pathValue = JSON.parse(opts.body).query?.term?.["path.keyword"];
        const resolved = typeof osCountResponse === "function" ? osCountResponse(pathValue) : osCountResponse;
        if (resolved.status !== undefined || resolved.ok !== undefined) return resolved; // caller supplied a full {status,ok,text} shape
        return { ok: true, status: 200, text: async () => JSON.stringify(resolved) };
      }
      return { ok: false, status: 404, text: async () => "unexpected OpenSearch call in this test" };
    }
    throw new Error(`TEST SAFETY: fetch reached an unrecognized host "${hostname}" (${method} ${u}) -- this check must never leave S3 + the configured OpenSearch host`);
  };
  return { stub, objects, calls };
}

// otchealthcommons/company-journal -> bucket otchealth-brain-dr-55c84f6b, keyPrefix
// "otchealthcommons/company-journal/" (skills/kb-memory/s3-blob.mjs's MIRROR table).
const COMMONS_ROOM = { name: "commons-company-journal", index: "commons-company-journal", account: "otchealthcommons", container: "company-journal", sloHours: 48 };
const LEGAL_PERSONAL_ROOM = { name: "legal-personal", index: "legal-personal", account: "otchealthlegalstore", container: "personal", sloHours: 168 };

test("checkOneBrainRoomFreshness: a privileged room is SKIPPED with ZERO fetch calls -- the ring-safety guarantee", async () => {
  const world = makeWorld({});
  const r = await withEnv(FAKE_ENV, () => withStubbedFetch(world.stub, () => checkOneBrainRoomFreshness(LEGAL_PERSONAL_ROOM)));
  assert.equal(r.name, "brain-room-legal-personal");
  assert.equal(r.status, "SKIPPED");
  assert.match(r.detail, /ring-excluded/);
  assert.match(r.detail, /personal-legal/);
  assert.equal(world.calls.length, 0, "a privileged room must never trigger a single network call, S3 or OpenSearch");
});

test("checkOneBrainRoomFreshness: newest source object still within its room's SLO is OK, and NEVER calls OpenSearch", async () => {
  const world = makeWorld({
    s3Objects: {
      "/otchealthcommons/company-journal/_DOCS/fresh.md": { body: "x", lastModified: new Date(Date.now() - 2 * 3600_000).toISOString() }, // 2h old, well inside the 48h SLO
    },
  });
  const r = await withEnv(FAKE_ENV, () => withStubbedFetch(world.stub, () => checkOneBrainRoomFreshness(COMMONS_ROOM)));
  assert.equal(r.status, "OK");
  assert.match(r.detail, /within the 48h SLO/);
  assert.ok(world.calls.every((c) => c.host !== OS_HOST), "must not query OpenSearch while the newest object is still inside its SLO");
  assert.ok(world.calls.some((c) => c.host.endsWith(".s3.us-east-1.amazonaws.com")), "must have listed S3");
});

test("checkOneBrainRoomFreshness: newest source object past the SLO but present in the index (exact path match) is OK", async () => {
  const staleIso = new Date(Date.now() - 100 * 3600_000).toISOString(); // 100h old, past the 48h SLO
  const world = makeWorld({
    s3Objects: { "/otchealthcommons/company-journal/_DOCS/old-but-indexed.md": { body: "x", lastModified: staleIso } },
    osCountResponse: (pathValue) => {
      assert.equal(pathValue, "otchealthcommons/company-journal/_DOCS/old-but-indexed.md", "must query the exact account/container/path convention buildChunkDocs() writes");
      return { count: 7 };
    },
  });
  const r = await withEnv(FAKE_ENV, () => withStubbedFetch(world.stub, () => checkOneBrainRoomFreshness(COMMONS_ROOM)));
  assert.equal(r.status, "OK");
  assert.match(r.detail, /IS present in the index \(7 chunk\(s\) found/);
});

test("checkOneBrainRoomFreshness: newest source object past the SLO with zero chunks found is the real STALE finding", async () => {
  const staleIso = new Date(Date.now() - 100 * 3600_000).toISOString();
  const world = makeWorld({
    s3Objects: { "/otchealthcommons/company-journal/_DOCS/orphaned.md": { body: "x", lastModified: staleIso } },
    osCountResponse: { count: 0 },
  });
  const r = await withEnv(FAKE_ENV, () => withStubbedFetch(world.stub, () => checkOneBrainRoomFreshness(COMMONS_ROOM)));
  assert.equal(r.status, "STALE");
  assert.match(r.detail, /ZERO chunks found/);
  assert.match(r.detail, /orphaned\.md/);
});

test("checkOneBrainRoomFreshness: a genuine S3 listing failure is ERROR (cannot check), never STALE", async () => {
  const throwingStub = async () => { throw new Error("simulated network exploded"); };
  const r = await withEnv(FAKE_ENV, () => withStubbedFetch(throwingStub, () => checkOneBrainRoomFreshness(COMMONS_ROOM)));
  assert.equal(r.status, "ERROR");
  assert.match(r.detail, /cannot check/);
  assert.match(r.detail, /S3 listing/);
});

test("checkOneBrainRoomFreshness: a room whose listing returns 0 real objects (all pipeline-internal) reports ERROR, not a silent OK", async () => {
  const world = makeWorld({
    s3Objects: { "/otchealthcommons/company-journal/_CATALOG/catalog.jsonl": { body: "x", lastModified: "2026-08-01T00:00:00Z" } },
  });
  const r = await withEnv(FAKE_ENV, () => withStubbedFetch(world.stub, () => checkOneBrainRoomFreshness(COMMONS_ROOM)));
  assert.equal(r.status, "ERROR");
  assert.match(r.detail, /0 source object\(s\)/);
});

test("checkOneBrainRoomFreshness: OpenSearch _count returning a non-2xx is ERROR (cannot check), distinct from STALE", async () => {
  const staleIso = new Date(Date.now() - 100 * 3600_000).toISOString();
  const world = makeWorld({
    s3Objects: { "/otchealthcommons/company-journal/_DOCS/x.md": { body: "x", lastModified: staleIso } },
    osCountResponse: { status: 403, ok: false, text: async () => "Forbidden" },
  });
  const r = await withEnv(FAKE_ENV, () => withStubbedFetch(world.stub, () => checkOneBrainRoomFreshness(COMMONS_ROOM)));
  assert.equal(r.status, "ERROR");
  assert.match(r.detail, /cannot check/);
  assert.match(r.detail, /HTTP 403/);
});

test("checkOneBrainRoomFreshness: OpenSearch _count throwing (network exception) is ERROR (cannot check)", async () => {
  const staleIso = new Date(Date.now() - 100 * 3600_000).toISOString();
  const world = makeWorld({
    s3Objects: { "/otchealthcommons/company-journal/_DOCS/x.md": { body: "x", lastModified: staleIso } },
    osThrows: "simulated opensearch connection reset",
  });
  const r = await withEnv(FAKE_ENV, () => withStubbedFetch(world.stub, () => checkOneBrainRoomFreshness(COMMONS_ROOM)));
  assert.equal(r.status, "ERROR");
  assert.match(r.detail, /cannot check/);
  assert.match(r.detail, /simulated opensearch connection reset/);
});

test("checkOneBrainRoomFreshness: an unmapped (account, container) pair fails loud as ERROR via s3-blob.mjs's own fail-closed mapping, never guesses a bucket", async () => {
  const world = makeWorld({});
  const unmapped = { name: "totally-unknown-room", index: "totally-unknown-room", account: "nope", container: "nowhere", sloHours: 26 };
  const r = await withEnv(FAKE_ENV, () => withStubbedFetch(world.stub, () => checkOneBrainRoomFreshness(unmapped)));
  assert.equal(r.status, "ERROR");
  assert.match(r.detail, /no S3 mirror mapping/);
  assert.equal(world.calls.length, 0, "an unmapped room must fail before any network call, not attempt a guessed bucket");
});
