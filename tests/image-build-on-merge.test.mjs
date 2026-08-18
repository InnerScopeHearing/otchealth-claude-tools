// MERGED IS NOT DEPLOYED. This test exists so that stops being possible to forget.
//
// THE BUG THIS GUARDS. The 18 scheduled Fargate jobs pull `doc-indexer:latest` by TAG, and Fargate
// re-pulls on every task start, so a job runs whatever `:latest` happens to be at that moment. Until
// 2026-08-18 the ONLY way `:latest` ever moved was a human clicking Run workflow: the builder was
// `workflow_dispatch`-only and all 8 runs it had ever had were manual. That is not a safety gate, it
// is a remembering gate, and it failed the way remembering gates fail.
//
// Proof it was real, from the fleet's own history: on 2026-08-18 the merge-to-deploy gap was 14.64
// hours (merge 04:27:18Z, rebuild 19:05:27Z), and an earlier gap ran 42 hours. Throughout those
// windows every "fix" merged to main was inert in every running job, while the merge itself looked
// exactly like the fix landing -- a PR going green and closing is indistinguishable, from the outside,
// from a fix reaching production. Multiple sessions reported fixes as shipped during those windows.
//
// WHY paths-ignore AND NOT paths, which is the subtle half. An allowlist (`paths:`) fails UNSAFE: the
// day someone adds a file in a directory nobody thought to list, the rebuild silently stops firing for
// it and staleness returns wearing the same disguise. A denylist (`paths-ignore:`) fails SAFE: an
// unrecognised new path still triggers a build. Given the failure being fixed is precisely "a step
// silently stopped happening", the trigger must fail toward building too often, never too rarely.
//
// The gateway builder is deliberately NOT covered here. It tags images with the commit sha rather than
// a floating tag, and its deploy is a separate operator-gated step by design, so building it on merge
// would not change what is running. That is a real design decision, not an oversight.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const WF = new URL("../.github/workflows/build-doc-indexer-ecr.yml", import.meta.url).pathname;
const src = readFileSync(WF, "utf8");

/** The `on:` block, from the top-level `on:` key to the next top-level key. */
function triggerBlock(text) {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => /^on:\s*$/.test(l));
  assert.ok(start > -1, "build-doc-indexer-ecr.yml must have a top-level `on:` block");
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^[A-Za-z_]/.test(l)); // next top-level key
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
}

test("the doc-indexer image rebuilds on merge to main, not only when a human remembers", () => {
  const on = triggerBlock(src);
  assert.match(on, /^\s{2}push:/m,
    "the builder MUST have a push trigger. Without it, `:latest` only moves when someone clicks Run " +
    "workflow, and every merged fix stays inert in all 18 jobs until they do.");
  assert.match(on, /branches:\s*\[\s*main\s*\]|branches:\s*\n\s*-\s*main/,
    "the push trigger must be scoped to main");
});

test("manual dispatch survives, so an out-of-band rebuild is still possible", () => {
  const on = triggerBlock(src);
  assert.match(on, /^\s{2}workflow_dispatch:/m,
    "workflow_dispatch must remain: rebuilding without a merge is needed for a rollback or a retag");
});

test("the path filter fails SAFE (paths-ignore), never UNSAFE (paths)", () => {
  const on = triggerBlock(src);
  assert.doesNotMatch(on, /^\s+paths:/m,
    "an allowlist `paths:` fails unsafe -- a future file outside the list silently stops triggering a " +
    "rebuild, which is the exact failure mode this trigger exists to remove. Use paths-ignore.");
  assert.match(on, /paths-ignore:/,
    "keep paths-ignore so documentation-only commits do not burn a build, while any unrecognised new " +
    "path still does");
});

test("concurrent merges queue rather than cancel, so no commit is skipped over", () => {
  assert.match(src, /concurrency:/,
    "a concurrency group is required so two close merges do not race to overwrite the same tag");
  assert.match(src, /cancel-in-progress:\s*false/,
    "cancel-in-progress MUST be false. Cancelling the first of two builds would leave `:latest` " +
    "carrying the earlier commit while main has already moved past it -- a smaller copy of the same " +
    "staleness bug.");
});

test("the tag expression still resolves to `latest` on a push event", () => {
  // On a push there is no `github.event.inputs`, so the expression must fall through to the default.
  // If someone ever changes this to a bare `${{ github.event.inputs.tag }}`, every merge would push an
  // EMPTY tag and `:latest` would silently stop moving again -- with the push trigger still present
  // and looking correct.
  assert.match(src, /github\.event\.inputs\.tag \|\| 'latest'/,
    "the tag must default to 'latest' when inputs are absent (i.e. on every push-triggered build)");
});
