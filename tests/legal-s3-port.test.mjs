// Tests for the 2026-08-28 S3 port of skills/legal/legal.mjs (Azure Blob is permanently dead --
// subscription 55c84f6b deleted 2026-08-13). Structurally this is a thin facade over
// ../skills/kb-memory/s3-blob.mjs (the same relationship skills/kb-memory/commons-store.mjs has), so
// the useful thing to pin here is that legal.mjs targets the RIGHT (account, container) -> bucket for
// company vs personal, that a storage failure never masquerades as "empty" or "saved", and that the
// personal-write-is-IAM-gated posture is a real thrown error, never a caught no-op. s3-blob.mjs's own
// wire protocol (SigV4, single-encode, 404-vs-403 handling) is already covered by
// skills/kb-memory/tests/s3-blob-*.test.mjs and s3-mirror-table.test.mjs; this file does not re-test
// that layer.
//
// NEVER makes a real network call: every fetch-touching test stubs globalThis.fetch (save/restore),
// mirroring s3-blob-write-path.test.mjs's own withStubbedFetch/withEnv convention.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import {
  ensureStore,
  putBlob,
  getBlob,
  listMatterNames,
  matterBlob,
  normalizeDocketRow,
} from "../skills/legal/legal.mjs";
import { s3LocationFor, _resetCredsCacheForTests } from "../skills/kb-memory/s3-blob.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

async function withStubbedFetch(stub, run) {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try { return await run(); } finally { globalThis.fetch = original; }
}
// Resets s3-blob.mjs's module-level AWS-credential cache on both ends of the test, exactly like
// s3-blob-write-path.test.mjs does -- without this a test that overrides AWS_* env vars observes an
// EARLIER test's already-cached credentials (60s TTL) instead of its own.
async function withEnv(vars, run) {
  const saved = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k];
  }
  _resetCredsCacheForTests();
  try { return await run(); } finally {
    for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    _resetCredsCacheForTests();
  }
}
const FAKE_CREDS = { AWS_ACCESS_KEY_ID: "AKIAFAKEFAKEFAKEFAKE", AWS_SECRET_ACCESS_KEY: "fakefakefakefakefakefakefakefakefakefake", AWS_SESSION_TOKEN: undefined, OTC_AWS_ACCESS_KEY_ID: undefined, OTC_AWS_SECRET_ACCESS_KEY: undefined, AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: undefined, AWS_CONTAINER_CREDENTIALS_FULL_URI: undefined };

// ---- sanity: legal.mjs's two namespaces resolve to the SAME mirror rows the gateway's S3 port uses --
test("legal.mjs's company/personal namespaces route through the SAME MIRROR rows the gateway uses (sanity, not a re-test of s3-mirror-table.test.mjs)", () => {
  const company = s3LocationFor("otchealthlegalstore", "company");
  const personal = s3LocationFor("otchealthlegalstore", "personal");
  assert.ok(company, "otchealthlegalstore/company must resolve");
  assert.ok(personal, "otchealthlegalstore/personal must resolve");
  assert.equal(company.bucket, "otchealth-finance-legal-dr-55c84f6b");
  assert.equal(personal.bucket, "otchealth-legal-personal-dr-55c84f6b");
  assert.notEqual(company.bucket, personal.bucket, "company and personal must NEVER share a bucket");
});

// ---- (a) company-ring put/get/list route to the finance-legal bucket host, with the right key ------
test("putBlob(company) targets the finance-legal DR bucket host with the expected object key", async () => {
  let captured = null;
  await withEnv(FAKE_CREDS, () =>
    withStubbedFetch(async (url, opts) => {
      captured = { url: String(url), method: opts.method };
      return { ok: true, status: 200, headers: new Map([["etag", '"abc"']]), text: async () => "" };
    }, () => putBlob("company", matterBlob("ainnova-deal"), JSON.stringify({ id: "ainnova-deal" }))));
  assert.ok(captured, "fetch must have been called");
  assert.equal(captured.method, "PUT");
  assert.ok(captured.url.startsWith("https://otchealth-finance-legal-dr-55c84f6b.s3.us-east-1.amazonaws.com/"), `unexpected host in ${captured.url}`);
  assert.ok(
    captured.url.includes("otchealthlegalstore%2Fcompany%2Fmatters%2Fainnova-deal.json") ||
      captured.url.includes("otchealthlegalstore/company/matters/ainnova-deal.json"),
    `unexpected key in ${captured.url}`,
  );
});

test("getBlob(company) targets the finance-legal DR bucket host and parses the JSON body", async () => {
  let captured = null;
  const matter = { id: "ainnova-deal", client: "OTCHealth/INND", docket: [] };
  const result = await withEnv(FAKE_CREDS, () =>
    withStubbedFetch(async (url) => {
      captured = String(url);
      return { ok: true, status: 200, headers: new Map(), text: async () => JSON.stringify(matter) };
    }, () => getBlob("company", matterBlob("ainnova-deal"))));
  assert.ok(captured.startsWith("https://otchealth-finance-legal-dr-55c84f6b.s3.us-east-1.amazonaws.com/"), `unexpected host in ${captured}`);
  assert.deepEqual(result, matter);
});

test("listMatterNames(company) targets the finance-legal DR bucket and returns matters/<id>.json names, matching the old Azure listing shape", async () => {
  let captured = null;
  const xml =
    `<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated>` +
    `<Contents><Key>otchealthlegalstore/company/matters/ainnova-deal.json</Key></Contents>` +
    `<Contents><Key>otchealthlegalstore/company/matters/ga-flsa-backwage.json</Key></Contents></ListBucketResult>`;
  const names = await withEnv(FAKE_CREDS, () =>
    withStubbedFetch(async (url) => { captured = String(url); return { ok: true, status: 200, headers: new Map(), text: async () => xml }; },
      () => listMatterNames("company")));
  assert.ok(captured.startsWith("https://otchealth-finance-legal-dr-55c84f6b.s3.us-east-1.amazonaws.com/"), `unexpected host in ${captured}`);
  assert.deepEqual(names.sort(), ["matters/ainnova-deal.json", "matters/ga-flsa-backwage.json"]);
});

test("listMatterNames returns [] for a genuinely empty prefix (a clean 200 is not a failure)", async () => {
  const xml = `<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>`;
  const names = await withEnv(FAKE_CREDS, () =>
    withStubbedFetch(async () => ({ ok: true, status: 200, headers: new Map(), text: async () => xml }),
      () => listMatterNames("company")));
  assert.deepEqual(names, []);
});

// ---- (b) personal-ring READS route to the personal DR bucket -----------------------------------
test("getBlob(personal) targets the personal-legal DR bucket host, NEVER the finance-legal one", async () => {
  let captured = null;
  const matter = { id: "ca-divorce", client: "Matthew Moore (personal)", docket: [] };
  const result = await withEnv(FAKE_CREDS, () =>
    withStubbedFetch(async (url) => { captured = String(url); return { ok: true, status: 200, headers: new Map(), text: async () => JSON.stringify(matter) }; },
      () => getBlob("personal", matterBlob("ca-divorce"))));
  assert.ok(captured.startsWith("https://otchealth-legal-personal-dr-55c84f6b.s3.us-east-1.amazonaws.com/"), `unexpected host in ${captured}`);
  assert.ok(!captured.includes("finance-legal"), "a personal read must never target the finance-legal bucket");
  assert.deepEqual(result, matter);
});

test("getBlob(personal) returns null on a genuine 404 (matter not found), never throws", async () => {
  const result = await withEnv(FAKE_CREDS, () =>
    withStubbedFetch(async () => ({ ok: false, status: 404, headers: new Map(), text: async () => "" }),
      () => getBlob("personal", matterBlob("nonexistent"))));
  assert.equal(result, null);
});

test("listMatterNames(personal) targets the personal-legal DR bucket host", async () => {
  let captured = null;
  const xml =
    `<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated>` +
    `<Contents><Key>otchealthlegalstore/personal/matters/ca-divorce.json</Key></Contents></ListBucketResult>`;
  const names = await withEnv(FAKE_CREDS, () =>
    withStubbedFetch(async (url) => { captured = String(url); return { ok: true, status: 200, headers: new Map(), text: async () => xml }; },
      () => listMatterNames("personal")));
  assert.ok(captured.startsWith("https://otchealth-legal-personal-dr-55c84f6b.s3.us-east-1.amazonaws.com/"), `unexpected host in ${captured}`);
  assert.deepEqual(names, ["matters/ca-divorce.json"]);
});

// ---- FAIL LOUD: a storage failure must never masquerade as empty/absent or as a successful save --
test("getBlob THROWS on a 403 rather than reporting the matter as absent -- the exact bug class this port exists to avoid", async () => {
  await withEnv(FAKE_CREDS, () =>
    withStubbedFetch(async () => ({ ok: false, status: 403, headers: new Map(), text: async () => "<Error><Code>AccessDenied</Code></Error>" }),
      () => assert.rejects(() => getBlob("company", matterBlob("ainnova-deal")), /s3 get 403/)));
});

test("listMatterNames THROWS on a listing failure rather than returning a false-empty matter list", async () => {
  await withEnv(FAKE_CREDS, () =>
    withStubbedFetch(async () => ({ ok: false, status: 500, headers: new Map(), text: async () => "internal error" }),
      () => assert.rejects(() => listMatterNames("company"), /s3 list 500/)));
});

// ---- (c) a personal WRITE surfaces loud failure on AccessDenied (legal.mjs's own layer) -----------
// legal.mjs deliberately does NOT wrap this in a named-message helper (see its header comment) --
// the standing IAM gate is verified end-to-end, with the distinct named message, in
// skills/legal-deadline-pager/tests/personal-store-s3-port.test.mjs instead. Here it is enough to
// prove the 403 is never silently swallowed into a "saved successfully" no-op.
test("putBlob(personal) REJECTS on a 403 AccessDenied rather than reporting a silent success -- the standing personal-legal IAM-gate posture", async () => {
  let called = false;
  await withEnv(FAKE_CREDS, () =>
    withStubbedFetch(async () => { called = true; return { ok: false, status: 403, headers: new Map(), text: async () => "<Error><Code>AccessDenied</Code></Error>" }; },
      async () => {
        await assert.rejects(
          () => putBlob("personal", matterBlob("ca-divorce"), JSON.stringify({ id: "ca-divorce" })),
          (e) => { assert.equal(e.status, 403); return true; },
        );
      }));
  assert.ok(called, "the write must actually have been attempted against S3, not short-circuited");
});

test("putBlob(company) succeeds cleanly on a normal 200 (writes are not universally broken, only personal is IAM-gated)", async () => {
  await withEnv(FAKE_CREDS, () =>
    withStubbedFetch(async () => ({ ok: true, status: 200, headers: new Map([["etag", '"abc"']]), text: async () => "" }),
      () => putBlob("company", matterBlob("ainnova-deal"), JSON.stringify({ id: "ainnova-deal" }))));
});

// ---- ensureStore(): the success path only (the failure path calls process.exit(2), which would kill
// the test runner -- consistent with the pre-port test suite, which never exercised that branch either) --
test("ensureStore() does not exit when AWS credentials are present", async () => {
  await withEnv(FAKE_CREDS, async () => {
    ensureStore(); // must not throw or exit; reaching the next line proves it
    assert.ok(true);
  });
});

// ---- (d) no code path in the ported files can reach blob.core.windows.net -------------------------
function readSrc(rel) { return readFileSync(join(ROOT, rel), "utf8"); }
test("legal.mjs contains no reference to blob.core.windows.net (Azure Blob is fully retired here)", () => {
  assert.doesNotMatch(readSrc("skills/legal/legal.mjs"), /blob\.core\.windows\.net/);
});
test("personal-store.mjs contains no reference to blob.core.windows.net (Azure Blob is fully retired here)", () => {
  assert.doesNotMatch(readSrc("skills/legal-deadline-pager/personal-store.mjs"), /blob\.core\.windows\.net/);
});
test("legal.mjs no longer imports the Azure-only azure-secret.mjs kvSecret helper (S3 needs no Azure secret)", () => {
  assert.doesNotMatch(readSrc("skills/legal/legal.mjs"), /azure-secret\.mjs/);
});
test("personal-store.mjs no longer imports the Azure-only azure-secret.mjs kvSecret helper", () => {
  assert.doesNotMatch(readSrc("skills/legal-deadline-pager/personal-store.mjs"), /azure-secret\.mjs/);
});
test("neither ported file references AZURE_LEGAL_STORAGE_KEY any more (no Azure SharedKey signing left)", () => {
  assert.doesNotMatch(readSrc("skills/legal/legal.mjs"), /AZURE_LEGAL_STORAGE_KEY/);
  assert.doesNotMatch(readSrc("skills/legal-deadline-pager/personal-store.mjs"), /AZURE_LEGAL_STORAGE_KEY/);
});

// ---- (e) importers still import cleanly + syntax gate on every touched/importer file ---------------
test("importing legal.mjs still never triggers CLI dispatch, a network call, or process.exit", async () => {
  const mod = await import("../skills/legal/legal.mjs");
  assert.ok(typeof mod.docketAdd === "function");
  assert.ok(typeof mod.docketAddMany === "function");
  assert.ok(typeof mod.docketVerify === "function");
  assert.ok(typeof mod.getMatter === "function");
  assert.ok(typeof mod.putMatter === "function");
  assert.ok(typeof mod.ensureStore === "function");
  // reaching this line at all proves import did not call process.exit()
});

test("deadline-extract.mjs still imports cleanly against the ported legal.mjs (it imports docketAdd + ensureStore)", async () => {
  const mod = await import("../skills/legal/deadline-extract.mjs");
  assert.ok(typeof mod.extractCandidates === "function");
  assert.ok(typeof mod.labelWithLLM === "function");
});

test("courtlistener-watch.mjs still imports cleanly against the ported legal.mjs (it imports getMatter/putMatter/docketAddMany/ensureStore)", async () => {
  const mod = await import("../skills/legal/courtlistener-watch.mjs");
  assert.ok(typeof mod.fetchDocketEntries === "function");
  assert.ok(typeof mod.normalizeEntry === "function");
  assert.ok(typeof mod.selectNewEntries === "function");
  assert.ok(typeof mod.stageRows === "function");
});

test("pager.mjs still imports cleanly against the ported legal.mjs (it imports normalizeDocketRow) and the ported personal-store.mjs", async () => {
  const mod = await import("../skills/legal-deadline-pager/pager.mjs");
  assert.ok(typeof mod.runSweep === "function");
  assert.ok(typeof mod.classifyDocketRows === "function");
  assert.ok(typeof mod.resolveSourceVerified === "function");
});

test("node --check passes on every ported file and every known importer", () => {
  for (const rel of [
    "skills/legal/legal.mjs",
    "skills/legal-deadline-pager/personal-store.mjs",
    "skills/legal/deadline-extract.mjs",
    "skills/legal/courtlistener-watch.mjs",
    "skills/legal-deadline-pager/pager.mjs",
  ]) {
    assert.doesNotThrow(() => execFileSync("node", ["--check", join(ROOT, rel)], { stdio: "pipe" }), `node --check failed for ${rel}`);
  }
});

// ---- normalizeDocketRow still re-exports cleanly (proves the docket-schema surface is untouched) ---
test("normalizeDocketRow (used by pager.mjs's resolveSourceVerified) is unaffected by the storage-layer port", () => {
  const n = normalizeDocketRow({ date: "2026-07-15", what: "x" });
  assert.equal(n.source, "manual");
  assert.equal(n.verified, true);
});
