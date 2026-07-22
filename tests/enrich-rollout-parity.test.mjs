// Guards the finding this workstream turned up: deep-finance / deep-legal-company / deep-legal-personal
// (job/deep-pass.sh -> deep-pass.mjs) are a DIFFERENT, older pipeline (re-summarization + signature
// detection) from the proven S1 metadata-enrichment pipeline (enrich.mjs), and the two must never be
// silently conflated or allowed to drift apart. Two things this test locks down:
//
//   1. Every room-refresh job script that is supposed to offer the opt-in ENRICH=1 metadata-enrichment
//      gate (job/librarian.sh for finance/commerce/legal-company/legal-personal, job/nightly.sh for
//      commons) actually carries it, with the same shape: `if [ "$ENRICH" = "1" ]`, an `ensure-schema`
//      call, and a `run` call into enrich.mjs. A future edit to one script that forgets the pattern (or
//      accidentally points at a different script) fails this test instead of silently regressing.
//   2. job/deep-pass.sh does NOT itself invoke enrich.mjs and does NOT reference the ENRICH gate --
//      it is a genuinely separate pass, not an alternate spelling of the same one. If a future change
//      merges the two pipelines on purpose, this assertion should be updated deliberately, not silently.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const JOB_DIR = join(ROOT, "skills", "doc-indexer", "job");
const read = (name) => readFileSync(join(JOB_DIR, name), "utf8");

const ENRICH_GATE_RE = /if \[ "\$ENRICH" = "1" \]; then/;
const ENSURE_SCHEMA_RE = /enrich\.mjs["'\s]+ensure-schema\b/;
const ENRICH_RUN_RE = /enrich\.mjs["'\s]+run\b/;

for (const script of ["librarian.sh", "nightly.sh"]) {
  test(`job/${script} carries the opt-in ENRICH=1 metadata-enrichment gate`, () => {
    const src = read(script);
    assert.match(src, ENRICH_GATE_RE, `${script} is missing the ENRICH=1 gate`);
    assert.match(src, ENSURE_SCHEMA_RE, `${script} does not call enrich.mjs ensure-schema`);
    assert.match(src, ENRICH_RUN_RE, `${script} does not call enrich.mjs run`);
  });
}

test("job/deep-pass.sh does NOT call enrich.mjs (it is a separate pipeline, not an alias)", () => {
  const src = read("deep-pass.sh");
  assert.doesNotMatch(src, /enrich\.mjs/, "deep-pass.sh must not reference enrich.mjs -- deep-pass.mjs and enrich.mjs are complementary but distinct passes");
  assert.match(src, /deep-pass\.mjs/, "deep-pass.sh should still dispatch to deep-pass.mjs itself");
});

test("job/nightly.sh's ENRICH gate targets the commons profile (the room it actually owns)", () => {
  const src = read("nightly.sh");
  const m = src.match(/enrich\.mjs["'\s]+run\b[^\n]*/);
  assert.ok(m, "nightly.sh's enrich.mjs run call not found");
  assert.match(m[0], /--profile commons\b/, "nightly.sh must enrich the commons room");
});
