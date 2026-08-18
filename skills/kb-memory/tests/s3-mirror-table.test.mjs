// Locks the (account, container) -> bucket allow-list in s3-blob.mjs (2026-08-18).
//
// WHY THIS FILE EXISTS. That table is maintained by hand-copying from otchealth-mcp-server's
// src/legal/s3-blob-store.ts. The first version of it shipped with the commons row pointing at
// otchealth-finance-legal-dr-55c84f6b, because the checkout it was copied from predated that repo's
// own fix for the identical bug (mcp-server #248). The file's header said "copied verbatim"; it
// was not, and nothing checked. A comment asserting two things agree is documentation. This is the
// mechanism.
//
// The failure mode is worth stating precisely, because it is not "a read returns nothing": this is
// the WRITE path, so a wrong bucket here does not fail loudly. It succeeds, into the wrong place.
// The ledger forks (the gateway writing one bucket, mem.mjs writing another), and shared memory
// lands in a ring it does not belong in. Both halves look healthy in isolation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { s3LocationFor } from "../s3-blob.mjs";

// The bucket holding attorney-privileged personal legal (CA family/civil matters, minors' data).
// Mirrors PERSONAL_LEGAL_BUCKET in the gateway's s3-blob-store.ts.
const PERSONAL_LEGAL_BUCKET = "otchealth-legal-personal-dr-55c84f6b";

// Every (account, container) pair the table is expected to carry, and the bucket each must resolve
// to. Kept as data so a row silently disappearing is as visible as a row changing.
const EXPECTED = Object.freeze({
  "otchealthlegalstore/personal": PERSONAL_LEGAL_BUCKET,
  "otchealthlegalstore/company": "otchealth-finance-legal-dr-55c84f6b",
  "otchealthlegalstore/exec": "otchealth-finance-legal-dr-55c84f6b",
  "otchealthcfodata/cfo-source-docs": "otchealth-finance-legal-dr-55c84f6b",
  "otchealthcfodata/cro-from-the-chair": "otchealth-finance-legal-dr-55c84f6b",
  "otchealthcfodata/innd-stock": "otchealth-finance-legal-dr-55c84f6b",
  "otchealthcommons/company-journal": "otchealth-brain-dr-55c84f6b",
});

test("the commons feed resolves to brain-dr, the bucket the data is actually in", () => {
  const loc = s3LocationFor("otchealthcommons", "company-journal");
  assert.ok(loc, "the commons row must exist at all -- its ABSENCE was the original outage");
  assert.equal(
    loc.bucket,
    "otchealth-brain-dr-55c84f6b",
    "The shared exec brain physically lives at otchealth-brain-dr-55c84f6b/otchealthcommons/" +
      "company-journal/_MEMORY/_exec/*.jsonl (observed by listing the live bucket: 29 lane files, " +
      "cto.jsonl ~1.2MB, cfo.jsonl ~1.9MB). It is NOT finance-legal-dr. If you are changing this " +
      "because IAM grants PutObject on finance-legal-dr: that grant covers BOTH buckets in one " +
      "statement and cannot discriminate between them. IAM says a write is permitted; only a " +
      "listing says where the data is.",
  );
  assert.equal(loc.keyPrefix, "otchealthcommons/company-journal/");
});

test("every mapped room resolves to its expected bucket, and no row has quietly vanished", () => {
  for (const [key, bucket] of Object.entries(EXPECTED)) {
    const [account, container] = key.split("/");
    const loc = s3LocationFor(account, container);
    assert.ok(loc, `row "${key}" is missing from the MIRROR table`);
    assert.equal(loc.bucket, bucket, `row "${key}" resolves to the wrong bucket`);
    assert.equal(loc.keyPrefix, `${key}/`, `row "${key}" has a mismatched keyPrefix`);
  }
});

test("the privileged personal-legal bucket is reachable from the personal row and nothing else", () => {
  // Ring safety, asserted in both directions: a slip that pointed some OTHER room at the privileged
  // bucket, or pointed personal at a shared one, would each be silent in production.
  for (const [key, bucket] of Object.entries(EXPECTED)) {
    if (key === "otchealthlegalstore/personal") {
      assert.equal(bucket, PERSONAL_LEGAL_BUCKET, "personal legal must stay in its own bucket");
    } else {
      assert.notEqual(
        bucket,
        PERSONAL_LEGAL_BUCKET,
        `row "${key}" resolves to the attorney-privileged bucket; only personal legal may`,
      );
    }
  }
});

test("an unmapped pair returns null rather than a guessed default", () => {
  assert.equal(s3LocationFor("otchealthcommons", "not-a-real-container"), null);
  assert.equal(s3LocationFor("no-such-account", "company-journal"), null);
  assert.equal(s3LocationFor("", ""), null);
  assert.equal(s3LocationFor(undefined, undefined), null);
});
