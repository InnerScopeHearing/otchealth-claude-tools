// Regression lock for job/nightly.sh's storage-backend selection (fixed 2026-09-01, claude-tools
// PR #508 / commit 7a308e03938fc5687f23a36438850f593124543b). See findings-ledger FND-20260830-6a1a.
//
// WHY THIS EXISTS. nightly.sh (the daily-digest Container Apps Job, cron 59 23 * * *) hardcoded
// `--azure` on six invocations of cfo-store/store.mjs, doc-indexer/indexer.mjs, and
// doc-indexer/enrich.mjs. Azure subscription 55c84f6b was permanently deleted 2026-08-13, so the
// FIRST of those six (staging the day's digest, inside `set -e`) threw on every scheduled run and
// took the whole nightly loop down with it -- the credential-registry regen, the commons index, the
// memory reindex, and the fleet-watch report never ran (observed live: the task stopped exit=1).
//
// This was NOT caught by any existing test. job/librarian.sh's identical migration (2026-08-18) is
// covered by skills/doc-indexer/tests/storage-backend-default.test.mjs (the library's default
// backend) and skills/kb-memory/tests/s3-mirror-table.test.mjs (the MIRROR table), but nightly.sh's
// OWN invocation text -- as opposed to the library functions it calls -- had no lock at all, so the
// hardcoded --azure shipped and ran silently broken every night for days before anyone read the
// script by hand. This file is that lock: a future edit cannot silently reintroduce --azure (or the
// Azure-only --key-secret flag, which has nothing left to do once the backend is S3) on this script
// the way the original regression happened.
//
// FAILING-FIRST PROOF (run manually against the pre-fix content rather than embedded here, so this
// file has no git-history dependency in a shallow-clone CI runner): every assertion below FAILS
// against `git show 6f9624a731199e07725226ba8a63b11ab18f76eb:skills/doc-indexer/job/nightly.sh` (the
// commit immediately before the fix) and PASSES against the current file. See the introducing PR's
// description for the exact commands run and their real output.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { s3LocationFor } from "../skills/kb-memory/s3-blob.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const NIGHTLY_SH = join(ROOT, "skills", "doc-indexer", "job", "nightly.sh");
const src = () => readFileSync(NIGHTLY_SH, "utf8");

// Strips full-line `#` comments (this script's only comment style -- see its header block) before
// scanning for a live flag, so the header's own prose describing the historical bug ("hardcoded
// `--azure`") does not trip the assertion it exists to explain.
const stripComments = (text) => text.replace(/^\s*#.*$/gm, "");

test("nightly.sh never passes --azure on a live invocation (the commons storage account is permanently write-blocked)", () => {
  assert.doesNotMatch(
    stripComments(src()),
    /--azure\b/,
    "a live --azure flag must not appear anywhere in nightly.sh; comments describing the historical bug are fine and are stripped before this check",
  );
});

test("nightly.sh never passes --key-secret (an Azure-only flag with nothing left to do once the backend is S3)", () => {
  assert.doesNotMatch(
    stripComments(src()),
    /--key-secret\b/,
    "--key-secret named the Azure Key Vault secret holding the storage account key; it must be dropped along with the Azure backend",
  );
});

test("both cfo-store/store.mjs 'put' invocations target otchealthcommons/company-journal via --s3", () => {
  const puts = [...src().matchAll(/cfo-store\/store\.mjs[^\n]*\bput\b[^\n]*/g)].map((m) => m[0]);
  assert.equal(
    puts.length,
    2,
    "expected exactly two store.mjs put calls (the daily-digest stage and the fleet-watch stage) -- " +
      "update this test deliberately if nightly.sh grows or loses one",
  );
  for (const line of puts) {
    assert.match(line, /--s3\b/, `store.mjs put call must pass --s3: ${line}`);
    assert.match(line, /--account otchealthcommons\b/, `store.mjs put call must target otchealthcommons: ${line}`);
    assert.match(line, /--container company-journal\b/, `store.mjs put call must target company-journal: ${line}`);
  }
});

test("both doc-indexer/indexer.mjs calls for the commons profile (index, push-search) select --s3", () => {
  const text = src();
  for (const verb of ["index", "push-search"]) {
    const re = new RegExp(`indexer\\.mjs["'\\s]+${verb}\\b[^\\n]*`);
    const m = text.match(re);
    assert.ok(m, `nightly.sh must call indexer.mjs ${verb}`);
    assert.match(m[0], /--profile commons\b/, `indexer.mjs ${verb} call must target the commons profile: ${m[0]}`);
    assert.match(m[0], /--s3\b/, `indexer.mjs ${verb} call must pass --s3: ${m[0]}`);
  }
});

test("both doc-indexer/enrich.mjs calls inside the opt-in ENRICH gate (ensure-schema, run) select --s3", () => {
  const text = src();
  for (const verb of ["ensure-schema", "run"]) {
    const re = new RegExp(`enrich\\.mjs["'\\s]+${verb}\\b[^\\n]*`);
    const m = text.match(re);
    assert.ok(m, `nightly.sh's ENRICH gate must call enrich.mjs ${verb}`);
    assert.match(m[0], /--profile commons\b/, `enrich.mjs ${verb} call must target the commons profile: ${m[0]}`);
    assert.match(m[0], /--s3\b/, `enrich.mjs ${verb} call must pass --s3: ${m[0]}`);
  }
});

test("the commons room nightly.sh writes to actually has a verified S3 mirror mapping, never a guessed bucket", () => {
  // Full ownership of this fact lives in skills/kb-memory/tests/s3-mirror-table.test.mjs; this
  // assertion exists so THIS file, read on its own next to the script it locks, proves the --s3
  // flags asserted above resolve somewhere real rather than merely being present as text.
  const loc = s3LocationFor("otchealthcommons", "company-journal");
  assert.ok(
    loc,
    "otchealthcommons/company-journal has no S3 mirror mapping -- nightly.sh's --s3 flag would fail " +
      "loud rather than write to the wrong place, but the room must not be silently unmapped",
  );
  assert.equal(loc.bucket, "otchealth-brain-dr-55c84f6b");
});

test("sanity: the script itself still parses as valid POSIX sh (a content-only test could pass on a script nothing can execute)", () => {
  execFileSync("sh", ["-n", NIGHTLY_SH], { stdio: "pipe" });
});
