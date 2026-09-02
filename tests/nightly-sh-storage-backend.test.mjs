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
// SOURCES for the operational history above, none of which this test establishes on its own and all
// of which are checkable: the Azure deletion date and its consequences are in
// otchealth-claude-tools/CLAUDE.md ("CORRECTION, 2026-08-27"); the cron schedule is on the
// EventBridge schedule otchealth-daily-digest; the failing run and its exit status are in the
// findings-ledger entry named above. Cited rather than dropped because a regression lock is easier
// to judge when the reader can see what it was built to prevent, but an unsourced assertion in a
// header is just a claim.
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
// file has no git-history dependency in a shallow-clone CI runner). Swapping in
// `git show 6f9624a731199e07725226ba8a63b11ab18f76eb:skills/doc-indexer/job/nightly.sh` (the commit
// immediately before the fix) and running this file gives **5 failures and 2 passes**, and all 7
// pass against the current file.
//
// The two that pass against the pre-fix script are SUPPOSED to: the mirror-table assertion reads
// s3-blob.mjs, not nightly.sh, and the `sh -n` assertion only parses the script -- neither one looks
// at a backend flag, so neither can distinguish pre-fix from post-fix. The five that fail are
// exactly the five that inspect invocation text. An earlier draft of this header claimed "every
// assertion below FAILS", which was not true and contradicted the introducing PR's own reported
// output; a regression lock whose stated evidence overstates itself is the same class of defect it
// exists to catch, so the real count is recorded here.
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

// Strips `#` comments -- both full-line and trailing -- before scanning for a live flag, so prose
// describing the historical bug ("hardcoded `--azure`") does not trip the assertion it exists to
// explain. A trailing comment must be stripped too: an earlier version handled only full-line
// comments, so a perfectly ordinary `... indexer.mjs index  # was --azure before the fix` made the
// --azure ban fail on a script that was correct. That is a loud false positive rather than a missed
// regression, but a guard that cries wolf gets muted, which costs the same in the end.
//
// A `#` only opens a comment when it is unquoted AND begins a word, so quote state is tracked rather
// than pattern-matched: `--container 'a#b'` and `echo "x # y"` keep their text. SCOPE, stated
// honestly: this handles single and double quotes, which is what this script uses. It does not model
// heredocs, backslash escapes, or `$'...'`. nightly.sh contains no heredoc (verified), and if one is
// ever added, a `#` inside it would be treated as a comment -- affecting only what this scanner
// ignores, never what it flags.
const stripComments = (text) =>
  text
    .split("\n")
    .map((line) => {
      let sq = false;
      let dq = false;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === "'" && !dq) sq = !sq;
        else if (c === '"' && !sq) dq = !dq;
        else if (c === "#" && !sq && !dq && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
      }
      return line;
    })
    .join("\n");

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

// Collects EVERY invocation line for a script+verb, not just the first. Taking only the first match
// would let a second, differently-flagged call be added without failing anything -- and the point of
// this file is that no invocation of these scripts can quietly select a dead backend.
const invocations = (text, script, verb) =>
  [...text.matchAll(new RegExp(`${script}\\.mjs["'\\s]+${verb}\\b[^\\n]*`, "g"))].map((m) => m[0]);

test("each doc-indexer/indexer.mjs call for the commons profile (index, push-search) occurs exactly once and selects --s3", () => {
  const text = stripComments(src());
  for (const verb of ["index", "push-search"]) {
    const calls = invocations(text, "indexer", verb);
    assert.equal(
      calls.length,
      1,
      `expected exactly one live indexer.mjs ${verb} call in nightly.sh, found ${calls.length} -- ` +
        "update this test deliberately if the script grows another, so a new call cannot inherit this lock without review",
    );
    assert.match(calls[0], /--profile commons\b/, `indexer.mjs ${verb} call must target the commons profile: ${calls[0]}`);
    assert.match(calls[0], /--s3\b/, `indexer.mjs ${verb} call must pass --s3: ${calls[0]}`);
  }
});

test("each doc-indexer/enrich.mjs call (ensure-schema, run) occurs exactly once, sits inside the opt-in ENRICH gate, and selects --s3", () => {
  const text = stripComments(src());

  // Locate the gate body rather than trusting the test's own name. Without this, the calls could be
  // hoisted out of the `if [ "$ENRICH" = "1" ]` block -- turning an opt-in pass into an unconditional
  // one on every nightly run -- and every other assertion here would still pass.
  const lines = text.split("\n");
  const gateStart = lines.findIndex((l) => /^\s*if\s+\[\s+"\$ENRICH"\s*=\s*"1"\s*\]/.test(l));
  assert.notEqual(gateStart, -1, 'nightly.sh must keep the enrichment pass behind an `if [ "$ENRICH" = "1" ]` gate');
  const gateEnd = lines.findIndex((l, i) => i > gateStart && /^\s*(else|fi)\b/.test(l));
  assert.notEqual(gateEnd, -1, "the ENRICH gate must be closed by an else/fi");

  for (const verb of ["ensure-schema", "run"]) {
    const calls = invocations(text, "enrich", verb);
    assert.equal(
      calls.length,
      1,
      `expected exactly one live enrich.mjs ${verb} call in nightly.sh, found ${calls.length}`,
    );
    const at = lines.findIndex((l) => l.includes(calls[0]));
    assert.ok(
      at > gateStart && at < gateEnd,
      `enrich.mjs ${verb} must stay INSIDE the ENRICH gate (line ${at + 1} is outside ${gateStart + 1}..${gateEnd + 1}); ` +
        "enrichment is opt-in and must not run on every nightly pass",
    );
    assert.match(calls[0], /--profile commons\b/, `enrich.mjs ${verb} call must target the commons profile: ${calls[0]}`);
    assert.match(calls[0], /--s3\b/, `enrich.mjs ${verb} call must pass --s3: ${calls[0]}`);
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

test("sanity: the script still parses under /bin/sh (a content-only test could pass on a script nothing can execute)", () => {
  // Scope note: this runs `sh -n` against whichever implementation /bin/sh is on the host, so it
  // catches syntax errors -- it does NOT establish strict POSIX portability, which would need a
  // conformance checker or a second shell. Claiming the stronger property would be the same kind of
  // overstatement this file's header now corrects.
  execFileSync("sh", ["-n", NIGHTLY_SH], { stdio: "pipe" });
});
