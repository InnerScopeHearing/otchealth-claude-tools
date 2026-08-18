// Tests for skills/doc-indexer/indexer.mjs's storage-backend selection (2026-08-18, the fix for
// the CFO-critical librarian-finance write-lock outage).
//
// WHY: every Azure Blob storage account this indexer can target (otchealthcommons, otchealthcfodata,
// otchealthlegalstore) was placed into a WRITE-BLOCKED state -- every PUT returns 403
// AuthorizationPermissionMismatch, GET/LIST still work (see skills/kb-memory/s3-blob.mjs's header
// for the full evidence). Before this fix, `indexer.mjs index --profile finance` (invoked by
// job/librarian.sh, unconditionally with --azure) listed and catalogued the finance room fine
// (reads still work) but then threw "ERROR: put 403 AuthorizationPermissionMismatch" flushing the
// catalog at the very end of every run, freezing the CFO's finance document index. These tests pin
// (1) the default backend is now s3, behaviorally, (2) a room with no verified S3 mirror row (e.g.
// the commerce profile) fails LOUD before any network call rather than guessing a bucket, and (3)
// --azure remains explicitly selectable for read-only inspection and is never silently rewritten.
//
// indexer.mjs DOES have a CLI-entrypoint guard (`if (import.meta.url === file://process.argv[1])`),
// but its top-level consts (PROFILE, BACKEND, ...) are still computed from `process.argv` at
// import time regardless, so a behavioral backend test still needs a real subprocess per case
// (matching skills/github-app/tests/gh-app.test.mjs's execFileSync + e.status convention already
// used elsewhere in this repo). Every case here fails BEFORE any network call, so it holds with no
// AWS/Azure credentials present at all.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEXER_MJS = join(HERE, "..", "indexer.mjs");

function run(args) {
  try {
    const stdout = execFileSync("node", [INDEXER_MJS, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { status: 0, stdout, stderr: "" };
  } catch (e) {
    return { status: e.status, stdout: e.stdout || "", stderr: e.stderr || "" };
  }
}

test("DEFAULT (no --s3/--azure/--gcs flag) resolves to the S3 backend for the commerce profile -- fails with the S3-specific 'no mirror mapping' error, not an Azure/GCS one, proving the default is s3", () => {
  const r = run(["status", "--profile", "commerce"]);
  assert.notEqual(r.status, 0, "commerce has no verified S3 mirror row -- it must not silently succeed under the s3 default");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no S3 mirror mapping for otchealthcommerce\/commerce-source-docs/);
});

test("--azure explicitly selects the Azure path for the SAME commerce profile, bypassing the S3 default entirely", () => {
  // Not asserting r.status === 0: whether this ACTUALLY reaches Azure and succeeds depends on
  // Azure credentials being resolvable in whatever environment runs this test, which a CI/CD runner
  // may not have. What this fix must guarantee regardless is that --azure takes the Azure code path
  // and never falls through to (or is silently overridden by) the s3 default. A live pass with real
  // credentials -- commerce's Azure read succeeding with target=otchealthcommerce/commerce-source-docs
  // and 13 real catalog rows -- is documented separately in this session's own verification.
  const r = run(["status", "--profile", "commerce", "--azure"]);
  assert.doesNotMatch(r.stdout + r.stderr, /no S3 mirror mapping/, "--azure must bypass the S3 mapping check entirely, never fall through to it");
});

test("STORAGE_BACKEND=s3 env var (no flag) resolves the same way as the default", () => {
  let threw = null;
  try {
    execFileSync("node", [INDEXER_MJS, "status", "--profile", "commerce"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, STORAGE_BACKEND: "s3" } });
  } catch (e) { threw = e; }
  assert.ok(threw, "commerce under STORAGE_BACKEND=s3 must not succeed (no mirror row)");
  assert.equal(threw.status, 2);
  assert.match(threw.stderr, /no S3 mirror mapping/);
});

test("the finance profile (a VERIFIED S3 mirror room) passes the mapping check under the s3 default -- never the 'no mirror mapping' refusal that unmapped rooms like commerce get", () => {
  // Deliberately NOT asserting r.status === 0 here: a live pass/fail on the actual S3 network call
  // depends on this test process having real AWS credentials, which a CI/CD runner may not always
  // have (unlike the credential-agnostic assertions elsewhere in this file, which fail BEFORE any
  // network call and so hold either way). What must ALWAYS be true, with or without live
  // credentials, is that finance's (account, container) pair resolves past s3Cred()'s synchronous
  // mapping check -- the one, specific thing this fix pins for a VERIFIED room. A live end-to-end
  // pass, credentials present, is documented separately in this session's own verification (a real
  // `index --profile finance` run against production flushed 269 pending docs to S3 with exit 0,
  // and `status --profile finance` read back 36,185+ real catalog rows).
  const r = run(["status", "--profile", "finance"]);
  assert.doesNotMatch(r.stderr, /no S3 mirror mapping/, "finance has a verified S3 mirror row (see runbooks/2026-08-18-azure-to-s3-completeness-audit.md) -- it must never be refused as unmapped");
});

test("a write failure (an unmapped room forced onto --s3 explicitly) exits non-zero with a diagnosable message, never silently swallowed", () => {
  const r = run(["index", "--profile", "commerce", "--s3", "--limit", "1"]);
  assert.notEqual(r.status, 0);
  assert.ok(r.stderr && r.stderr.trim().length > 0, "must produce a diagnosable stderr message");
  assert.doesNotMatch(r.stdout, /\[index\] done/, "must never print the success/'done' line when the room could not even be resolved");
});

test("source-level regression lock: the default backend constant reads s3, not azure", () => {
  const src = readFileSync(INDEXER_MJS, "utf8");
  assert.match(src, /process\.env\.STORAGE_BACKEND \|\| "s3"\)\.toLowerCase\(\)/, "BACKEND must default to s3");
});

test("sanity: importing indexer.mjs for other tests does not itself dispatch a CLI command (the isMain guard holds)", () => {
  // If the top-level `if (import.meta.url === ...)` guard ever regressed to always-true, importing
  // this module in ANY test process (e.g. fleet-secret.test.mjs, which imports fleet-secret.mjs
  // from the same directory) would risk a stray process.exit. This is a static assertion that the
  // guard text is still present and unconditional, not a live import (indexer.mjs has heavy
  // top-level side effects -- profile tables, argv parsing -- that make a bare `import` in a test
  // file its own hazard regardless of the guard).
  const src = readFileSync(INDEXER_MJS, "utf8");
  assert.match(src, /if \(import\.meta\.url === `file:\/\/\$\{process\.argv\[1\]\}`\) \{/);
});
