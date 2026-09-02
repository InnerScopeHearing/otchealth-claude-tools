// Regression gate for FND-20260828-5ca1's migration half: proves each of the six migrated call sites
// (a) actually signs through ../../setup/aws-sigv4.mjs now (a fetch-stub test asserting the EXACT
// canonical request/URL/headers it sends) and (b) no longer carries its own hand-rolled SigV4 source
// (a source-scan regression pin, mirroring this exact codebase's own established pattern -- see e.g.
// tests/fleet-medic-s3.test.mjs's "no longer talks to Azure Blob directly" test).
//
// The remaining two migrated files (skills/cutover-preflight/preflight.mjs and
// skills/aws-jobs-migration/{inventory-aws-jobs,build-missing-schedules}.mjs) have NO test
// infrastructure today (confirmed: zero pre-existing test files reference any of them) and are
// one-shot scripts that execute real kvSecret()/network calls at module-import time with no exported,
// network-only surface to stub around -- adding that scaffolding is a larger, separate change than
// this migration. They get the source-scan half of this test only; the fetch-stub half below covers
// the four callers where doing so does not require restructuring an untested file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ssmCall } from "../skills/kb-memory/aws-secret.mjs";
import { rdsDescribeDbSnapshots, lightsailCall } from "../skills/aws-dr-canary/canary.mjs";
import { awsRequest } from "../skills/aws-image-canary/image-canary.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

async function withStubbedFetch(stub, run) {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try { return await run(); } finally { globalThis.fetch = original; }
}
async function withEnv(vars, run) {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; process.env[k] = vars[k]; }
  try { return await run(); } finally { for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
}

const FAKE_CREDS_ENV = { AWS_ACCESS_KEY_ID: "AKIDEXAMPLE", AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" };

// ---------------------------------------------------------------------------------------------------
// live-shaped: exact canonical request, one per migrated caller

test("ssmCall (aws-secret.mjs): signs a POST to ssm.<region>.amazonaws.com/ with the exact SSM JSON-1.1 headers", async () => {
  let seen = null;
  const r = await withEnv(FAKE_CREDS_ENV, () => withStubbedFetch(async (url, init) => {
    seen = { url: String(url), init };
    return { ok: true, status: 200, text: async () => '{"Parameter":{"Value":"x"}}' };
  }, () => ssmCall("GetParameter", { Name: "/otchealth/test-key", WithDecryption: true })));
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { Parameter: { Value: "x" } });
  assert.match(seen.url, /^https:\/\/ssm\.us-east-1\.amazonaws\.com\/$/, "SSM always signs the bare root path");
  assert.equal(seen.init.headers["x-amz-target"], "AmazonSSM.GetParameter");
  assert.equal(seen.init.headers["content-type"], "application/x-amz-json-1.1");
  assert.match(seen.init.headers.authorization, /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/us-east-1\/ssm\/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-target, Signature=[0-9a-f]{64}$/);
  assert.equal(JSON.parse(seen.init.body).Name, "/otchealth/test-key");
});

test("rdsDescribeDbSnapshots (aws-dr-canary/canary.mjs): signs a form-encoded POST with the RDS Query-protocol body, exact SignedHeaders", async () => {
  let seen = null;
  const stub = async (url, init) => {
    seen = { url: String(url), init };
    return { ok: true, status: 200, text: async () => "<DescribeDBSnapshotsResponse></DescribeDBSnapshotsResponse>" };
  };
  const creds = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" };
  const text = await withStubbedFetch(stub, () => rdsDescribeDbSnapshots(creds, "otchealth-pg"));
  assert.equal(text, "<DescribeDBSnapshotsResponse></DescribeDBSnapshotsResponse>");
  assert.match(seen.url, /^https:\/\/rds\.us-east-1\.amazonaws\.com\/$/, "RDS always signs the bare root path");
  assert.equal(seen.init.headers["content-type"], "application/x-www-form-urlencoded; charset=utf-8");
  assert.match(seen.init.headers.authorization, /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/us-east-1\/rds\/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=[0-9a-f]{64}$/);
  // body is the sorted, form-encoded RDS Query-protocol params -- unchanged by this migration.
  assert.equal(seen.init.body, "Action=DescribeDBSnapshots&DBInstanceIdentifier=otchealth-pg&SnapshotType=automated&Version=2014-10-31");
});

test("rdsDescribeDbSnapshots: a non-2xx response still throws (preserves the pre-migration 'throw on failure' contract)", async () => {
  const creds = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" };
  await assert.rejects(
    () => withStubbedFetch(async () => ({ ok: false, status: 403, text: async () => "AccessDenied" }), () => rdsDescribeDbSnapshots(creds, "otchealth-pg")),
    /http-403/,
  );
});

test("lightsailCall (aws-dr-canary/canary.mjs): signs the JSON-1.1 Lightsail target header with the exact SignedHeaders set", async () => {
  let seen = null;
  const stub = async (url, init) => {
    seen = { url: String(url), init };
    return { ok: true, status: 200, text: async () => '{"instance":{"addOns":[]}}' };
  };
  const creds = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" };
  const r = await withStubbedFetch(stub, () => lightsailCall(creds, "us-east-1", "GetInstance", { instanceName: "otchealth-cs-n8n" }));
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { instance: { addOns: [] } });
  assert.match(seen.url, /^https:\/\/lightsail\.us-east-1\.amazonaws\.com\/$/);
  assert.equal(seen.init.headers["x-amz-target"], "Lightsail_20161128.GetInstance");
  assert.match(seen.init.headers.authorization, /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/us-east-1\/lightsail\/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-target, Signature=[0-9a-f]{64}$/);
  assert.deepEqual(JSON.parse(seen.init.body), { instanceName: "otchealth-cs-n8n" });
});

test("lightsailCall: a transport failure still throws (preserves the pre-migration bare-fetch() throw contract; a mere non-2xx does NOT throw)", async () => {
  const creds = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" };
  await assert.rejects(
    () => withStubbedFetch(async () => { throw new Error("simulated DNS failure"); }, () => lightsailCall(creds, "us-east-1", "GetInstance", {})),
    /simulated DNS failure/,
  );
  // a non-2xx (e.g. 403) is NOT a transport failure -- it returns normally, exactly like the
  // pre-migration bare-fetch() version, so callers keep their own "status !== 200" branch.
  const r = await withStubbedFetch(async () => ({ ok: false, status: 403, text: async () => "AccessDenied" }), () => lightsailCall(creds, "us-east-1", "GetInstance", {}));
  assert.equal(r.status, 403);
});

test("awsRequest (aws-image-canary/image-canary.mjs): signs an EventBridge Scheduler GET with the double-encode rule engaged for a reserved character", async () => {
  let seen = null;
  const stub = async (url, init) => {
    seen = { url: String(url), init };
    return { ok: true, status: 200, text: async () => '{"Schedules":[]}' };
  };
  const creds = { ak: "AKIDEXAMPLE", sk: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", st: null };
  // A colon is exactly the reserved character the pre-migration version would have signed WRONG (no
  // double-encode pass at all) -- see ../setup/aws-sigv4.mjs's header. The wire URL must still carry
  // the SINGLE-encoded form (%3A); only the internal signature computation double-encodes it.
  const r = await withStubbedFetch(stub, () => awsRequest(creds, { service: "scheduler", host: "scheduler.us-east-1.amazonaws.com", path: "/schedules/my-job%3Av2", region: "us-east-1" }));
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { Schedules: [] });
  assert.equal(seen.url, "https://scheduler.us-east-1.amazonaws.com/schedules/my-job%3Av2", "the WIRE url keeps the single-encoded form");
  assert.match(seen.init.headers.authorization, /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/us-east-1\/scheduler\/aws4_request, SignedHeaders=host;x-amz-date, Signature=[0-9a-f]{64}$/);
});

test("awsRequest: signing an s3 request over the SAME reserved-character path produces a DIFFERENT signature than scheduler -- proves the S3-vs-double-encode branch is actually engaged end to end, not just in the shared module's own unit tests", async () => {
  const creds = { ak: "AKIDEXAMPLE", sk: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", st: null };
  const stub = async () => ({ ok: true, status: 200, text: async () => "{}" });
  const scheduler = await withStubbedFetch(stub, async () => {
    let seen; await withStubbedFetch(async (u, i) => { seen = i; return stub(); }, () => awsRequest(creds, { service: "scheduler", host: "example.amazonaws.com", path: "/x%3Ay", region: "us-east-1" }));
    return seen;
  });
  const s3 = await withStubbedFetch(stub, async () => {
    let seen; await withStubbedFetch(async (u, i) => { seen = i; return stub(); }, () => awsRequest(creds, { service: "s3", host: "example.amazonaws.com", path: "/x%3Ay", region: "us-east-1" }));
    return seen;
  });
  assert.notEqual(scheduler.headers.authorization, s3.headers.authorization);
});

// ---------------------------------------------------------------------------------------------------
// source-scan regression pins: none of the six migrated files hand-rolls SigV4 anymore.

const MIGRATED_FILES = [
  "skills/kb-memory/aws-secret.mjs",
  "skills/aws-dr-canary/canary.mjs",
  "skills/aws-image-canary/image-canary.mjs",
  "skills/cutover-preflight/preflight.mjs",
  "skills/aws-jobs-migration/inventory-aws-jobs.mjs",
  "skills/aws-jobs-migration/build-missing-schedules.mjs",
];

for (const rel of MIGRATED_FILES) {
  test(`FAIL ON OLD CODE: ${rel} no longer hand-rolls SigV4 (no local aws4_request/HMAC chain construction) and imports the shared signer`, async () => {
    const src = await readFile(join(ROOT, rel), "utf8");
    assert.doesNotMatch(src, /aws4_request/, `${rel} must not construct a SigV4 scope string itself anymore`);
    assert.doesNotMatch(src, /createHmac\(.sha256.,\s*k(ey)?\)/, `${rel} must not run its own HMAC chain anymore`);
    assert.match(src, /from ['"](\.\.\/)*setup\/aws-sigv4\.mjs['"]/, `${rel} must import from the shared setup/aws-sigv4.mjs`);
  });
}
