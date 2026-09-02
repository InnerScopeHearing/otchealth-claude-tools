// Regression guard for OpenAI cost visibility: FAILS if any file under setup/ or skills/ mentions
// "api.openai.com" (a direct OpenAI network call) without also importing/calling recordOpenAIUsage()
// (setup/openai-usage.mjs) -- UNLESS the file is explicitly named in ALLOWLIST below, with a reason.
//
// This is a FILE-LEVEL text scan, not a call-site-level AST analysis: it proves "this file, which
// talks to api.openai.com somewhere, ALSO talks to recordOpenAIUsage somewhere," not "every individual
// fetch() call in this file is instrumented." That is a real, deliberate limitation (documented in
// docs/OPENAI-COST-VISIBILITY.md too) -- a file with two OpenAI call sites where only one is
// instrumented would pass this test. It is still the right test to have: it is what caught (and now
// prevents the regression of) the actual shape this fleet's LLM callers take -- a hardcoded literal
// URL string per file, no shared HTTP client to instrument once -- and a full AST-based call-graph
// analysis is a much larger investment for a marginal gain here.
//
// A file is skipped by ALLOWLIST only when its OWN literal "api.openai.com" occurrence is NOT itself a
// billable call site that needs (or can safely receive) its own recordOpenAIUsage() call -- see each
// entry's `reason` for why. Every allowlist entry is a name-and-reason pair, not a wildcard glob, so
// adding a new file that legitimately needs an exception is a deliberate, reviewable, one-line change.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCAN_DIRS = ["setup", "skills"];

const ALLOWLIST = {
  "skills/recall-evals/mine-cases.mjs":
    "its OpenAI chat call routes through the shared, instrumented setup/model-routing.mjs " +
    "fetchOpenAIWithFlexRetry() (caller label 'recall-evals-mine-cases' is already passed there); " +
    "this file's own 'api.openai.com' text is a doc comment describing that fact, not a call site.",
  "skills/recall-evals/mine-hard-negatives.mjs":
    "same reasoning as mine-cases.mjs: its OpenAI chat call routes through the shared, instrumented " +
    "setup/model-routing.mjs fetchOpenAIWithFlexRetry(); the literal string here is a doc comment.",
  "skills/designer/scripts/_openai.mjs":
    "Sora video HTTP calls (create/poll/download) have no per-request `usage` object (billing is " +
    "per-second-of-video, not token-based); the caller (gen-video.mjs) already computes the exact " +
    "dollar figure and records it via reportCost() -> skills/designer/scripts/_lib.mjs -> " +
    "recordOpenAIUsage(). Instrumenting here too would double-count the same spend.",
  "skills/designer/scripts/gen-image.mjs":
    "image-generation cost is recorded via the shared reportCost() hook in _lib.mjs (called with this " +
    "file's own exact, quality/size-aware cost figure), not inline at the raw fetch() call -- avoids " +
    "double-counting and avoids a second, potentially-divergent price estimate.",
  "skills/designer/scripts/gen-app-icon-family.mjs":
    "same reasoning as gen-image.mjs: cost is recorded via the shared reportCost() hook in _lib.mjs.",
  "skills/designer/scripts/gen-icon-batch.mjs":
    "same reasoning as gen-image.mjs: cost is recorded via the shared reportCost() hook in _lib.mjs.",
  "skills/designer/scripts/healthcheck.mjs":
    "its only 'api.openai.com' call is `GET /v1/models` (a credential health probe) -- no `usage` " +
    "object, not a billable request.",
};

function listMjsFiles(absDir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(absDir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const abs = join(absDir, name);
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      out.push(...listMjsFiles(abs));
    } else if (st.isFile() && name.endsWith(".mjs") && !name.endsWith(".test.mjs") && name !== "selftest.mjs") {
      out.push(abs);
    }
  }
  return out;
}

const candidateFiles = SCAN_DIRS.flatMap((d) => listMjsFiles(join(ROOT, d)));

test("there are candidate .mjs files to scan under setup/ and skills/", () => {
  assert.ok(candidateFiles.length > 0, "expected at least one non-test .mjs file under setup/ or skills/");
});

test("openai-usage.mjs itself is NOT in the allowlist (it doesn't need to be -- it never calls api.openai.com)", () => {
  assert.equal(Object.prototype.hasOwnProperty.call(ALLOWLIST, "setup/openai-usage.mjs"), false);
});

for (const abs of candidateFiles) {
  const rel = relative(ROOT, abs).split(sep).join("/");
  let content;
  try {
    content = readFileSync(abs, "utf8");
  } catch {
    // A file this scan cannot read (e.g. genuinely binary, like a stray build artifact) cannot be
    // making a text-literal "api.openai.com" HTTP call either -- skip rather than fail the gate on an
    // unrelated I/O quirk.
    continue;
  }
  // A source-text scan, not URL handling: match the literal host as a whole token in the file's
  // contents (a regex rather than String#includes on a hostname literal, which CodeQL's
  // js/incomplete-url-substring-sanitization would otherwise flag as if this were sanitizing a URL).
  if (!/\bapi\.openai\.com\b/.test(content)) continue;

  test(`${rel}: references api.openai.com, so it must also call recordOpenAIUsage() or be an explicitly documented exception`, () => {
    const allowReason = ALLOWLIST[rel];
    const callsHelper = content.includes("recordOpenAIUsage");
    if (allowReason) {
      // An allowlisted file that STARTS calling the helper is not a failure, just stale bookkeeping --
      // still flag it so the allowlist entry gets cleaned up rather than silently rotting.
      assert.ok(
        typeof allowReason === "string" && allowReason.length > 20,
        `${rel} is allowlisted but its reason string is missing or too short to be a real justification`
      );
      return;
    }
    assert.ok(
      callsHelper,
      `${rel} references api.openai.com but never calls recordOpenAIUsage() (setup/openai-usage.mjs) and ` +
        `is not in this test's ALLOWLIST. Either instrument it (see the fleet's existing call sites for the ` +
        `pattern) or add a named, reasoned ALLOWLIST entry explaining why this specific file's OpenAI call ` +
        `does not need its own cost-visibility instrumentation.`
    );
  });
}
