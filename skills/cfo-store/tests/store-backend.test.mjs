// Tests for skills/cfo-store/store.mjs's storage-backend selection (2026-08-18, the fix for the
// CFO-critical write-lock outage).
//
// WHY: every Azure Blob storage account this store can target (otchealthcommons, otchealthcfodata,
// otchealthlegalstore) was placed into a WRITE-BLOCKED state -- every PUT returns 403
// AuthorizationPermissionMismatch, GET/LIST still work (see skills/kb-memory/s3-blob.mjs's header
// for the full evidence). store.mjs used to default to --azure; that default is what silently kept
// pointing cfo-reconstruction's every write at a backend that could not, and never will again,
// accept one. These tests pin (1) the default is now s3, behaviorally, not just as a string in the
// source, (2) a write to an unmapped room fails LOUD before any network call rather than guessing a
// bucket, and (3) --azure/--gcs remain explicitly selectable and are not silently rewritten to s3.
//
// store.mjs has no CLI-entrypoint import guard (unlike indexer.mjs) -- its dispatch runs
// unconditionally at load, so it cannot be `import`ed by a test. Every test here spawns it as a
// real child process instead, mirroring the exact execFileSync + try/catch/e.status convention
// skills/github-app/tests/gh-app.test.mjs already uses for CLI-contract tests in this repo. No test
// touches real network or real credentials: every case here is designed to fail BEFORE any network
// call (an unmapped --account/--container pair short-circuits in s3Cred()/azCred() synchronously),
// so the same assertions hold in CI with no AWS/Azure credentials present at all.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const STORE_MJS = join(HERE, "..", "store.mjs");

// A room guaranteed absent from skills/kb-memory/s3-blob.mjs's MIRROR table, so s3Cred() throws
// its own diagnosable error synchronously, before store.mjs ever opens a socket. Using a run of
// this exact test file as the account name keeps it self-evidently not a real fleet room.
const UNMAPPED_ACCOUNT = "zzz-store-backend-test-unmapped-account";
const UNMAPPED_CONTAINER = "zzz-store-backend-test-unmapped-container";

function run(args) {
  try {
    const stdout = execFileSync("node", [STORE_MJS, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { status: 0, stdout, stderr: "" };
  } catch (e) {
    return { status: e.status, stdout: e.stdout || "", stderr: e.stderr || "" };
  }
}

test("DEFAULT (no --s3/--azure/--gcs flag) resolves to the S3 backend -- an unmapped room fails with the S3-specific error, never silently falling through to Azure/GCS", () => {
  const r = run(["--account", UNMAPPED_ACCOUNT, "--container", UNMAPPED_CONTAINER, "list"]);
  assert.notEqual(r.status, 0, "an unmapped room must not report success");
  assert.match(r.stderr, /no S3 mirror mapping for zzz-store-backend-test-unmapped-account\/zzz-store-backend-test-unmapped-container/, "the default path must be S3's own diagnosable error, proving the default backend is s3");
  assert.equal(r.status, 2, "a refused-to-guess-a-bucket failure is a usage-class error (exit 2), same as a missing Azure key");
});

test("STORAGE_BACKEND=s3 env var explicitly selects the same S3 path as the default", () => {
  let threw = null;
  try {
    execFileSync("node", [STORE_MJS, "--account", UNMAPPED_ACCOUNT, "--container", UNMAPPED_CONTAINER, "list"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, STORAGE_BACKEND: "s3" } });
  } catch (e) { threw = e; }
  assert.ok(threw, "an unmapped room on STORAGE_BACKEND=s3 must not succeed");
  assert.equal(threw.status, 2);
  assert.match(threw.stderr, /no S3 mirror mapping/);
});

test("--azure explicitly selects the Azure path, NOT the S3 default -- the same unmapped-room account/container pair does not trip the S3-specific error under --azure", () => {
  const r = run(["--azure", "--account", UNMAPPED_ACCOUNT, "--container", UNMAPPED_CONTAINER, "--key-secret", "zzz-nonexistent-key-secret-for-this-test", "list"]);
  assert.notEqual(r.status, 0, "a real Azure attempt against a nonexistent room/key must not report success");
  assert.doesNotMatch(r.stderr, /no S3 mirror mapping/, "--azure must bypass the S3 default entirely, not fall through to it");
});

test("--gcs explicitly selects the GCS path, NOT the S3 default", () => {
  const r = run(["--gcs", "list"]);
  // GCS requires GCP_CLAUDE_DRIVER_SA_JSON; without it (or with a bogus one) it fails, but via GCS's
  // own error path, never the S3 mapping check.
  assert.doesNotMatch(r.stderr, /no S3 mirror mapping/, "--gcs must bypass the S3 default entirely");
});

test("a real S3 write failure is reported loud (a clear, non-empty stderr message) and exits non-zero -- never silently swallowed into a success", () => {
  const r = run(["--account", UNMAPPED_ACCOUNT, "--container", UNMAPPED_CONTAINER, "put", STORE_MJS /* any existing local file */, "some/object.json"]);
  assert.notEqual(r.status, 0);
  assert.ok(r.stderr && r.stderr.trim().length > 0, "a write failure must produce a diagnosable stderr message, not silence");
  assert.doesNotMatch(r.stdout, /^put /m, "stdout must never show a success line ('put s3://...') when the write did not happen");
});

test("put-dir reports a non-zero exit when any file in the batch fails to write, never a clean-looking summary for a partial failure", () => {
  const src = readFileSync(STORE_MJS, "utf8");
  // Source-level lock on the exact regression this guards: the loop in runS3()'s put-dir branch
  // must check ok < files.length and exit(1) -- a live end-to-end proof (a batch with one bad key
  // permission) is not practical to run hermetically without live, mixed-permission credentials.
  const startIdx = src.indexOf('cmd === "put-dir"', src.indexOf("async function runS3"));
  assert.ok(startIdx > -1, "runS3's put-dir branch must exist");
  const block = src.slice(startIdx, src.indexOf('} else if (cmd === "list")', startIdx));
  assert.match(block, /if \(ok < files\.length\) process\.exit\(1\)/, "a partial put-dir failure must exit non-zero, not just print FAIL lines and return 0");
});

test("source-level regression lock: the default backend constant reads s3, not azure", () => {
  const src = readFileSync(STORE_MJS, "utf8");
  assert.match(src, /process\.env\.STORAGE_BACKEND \|\| "s3"\)\.toLowerCase\(\)/, "BACKEND must default to s3");
});
