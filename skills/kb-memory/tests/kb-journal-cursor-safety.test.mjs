// Counterfactual guards for kb-journal.mjs's 2026-08-18 fixes: (1) the write path now targets S3 by
// default (the account it journals into is write-blocked on Azure, same as mem.mjs's ledgers), and
// (2) the cursor file no longer advances past a turn whose blob write actually failed. Live,
// end-to-end proof of both (a forced-Azure-failure run that neither advances the cursor nor loses
// the turns on retry, verified against real S3) is captured in the PR description; these tests pin
// the SHIPPED source so a future edit cannot quietly reintroduce either bug.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

async function readSrc() {
  const raw = await readFile(new URL("../kb-journal.mjs", import.meta.url), "utf8");
  return { raw, stripped: raw.replace(/^\s*\/\/.*$/gm, "") };
}

test("kb-journal.mjs defaults BLOB_BACKEND to 's3'", async () => {
  const { raw } = await readSrc();
  assert.match(raw, /const BLOB_BACKEND = \(process\.env\.BLOB_BACKEND \|\| "s3"\)\.toLowerCase\(\);/);
});

test("the cursor write is gated on having actually written something new, not unconditional", async () => {
  const { stripped } = await readSrc();
  const start = stripped.indexOf("async function main()");
  assert.ok(start > -1);
  const body = stripped.slice(start);
  // The exact old bug: writeFileSync(curFile, String(turns[turns.length - 1].idx)) with no guard,
  // reachable even when every putBuf() above had thrown. Must not reappear verbatim.
  assert.doesNotMatch(
    body,
    /writeFileSync\(curFile, String\(turns\[turns\.length - 1\]\.idx\)\);\s*\}\s*catch/,
    "the cursor must not be set to the LAST turn's idx unconditionally -- that marks a failed write as handled",
  );
  assert.match(body, /maxWrittenIdx/, "must track how far writes actually succeeded");
  assert.match(body, /if \(maxWrittenIdx > lastIdx\)/, "the cursor write must be conditioned on real progress, not just 'this run ran'");
});

test("a per-date write failure is reported by name (the key) and states the turns will retry", async () => {
  const { stripped } = await readSrc();
  assert.match(stripped, /LOST WRITE for \$\{key\}/);
  assert.match(stripped, /will retry next run/);
});

test("kb-journal.mjs's credential gate no longer hard-exits when S3 is the active backend and Azure creds are simply unavailable", async () => {
  const { stripped } = await readSrc();
  const start = stripped.indexOf("async function main()");
  const body = stripped.slice(start);
  assert.match(body, /if \(AKEY\) \{ SAS = buildSas\(\); \}\s*\n\s*else if \(!S3_WRITES\)/, "the Azure key must be treated as best-effort once S3_WRITES is the active backend");
});
