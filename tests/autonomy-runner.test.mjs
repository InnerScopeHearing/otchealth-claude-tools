// Regression tests for the unattended-agent runners (.github/workflows/autonomous-run.yml and
// overnight-agent.yml). Guards the "never silently discard the agent's work" safety net: a timed/
// overnight run that edits files but never runs git itself used to lose everything at runner teardown
// (only the log artifact survived). Each runner must now deterministically capture the work onto a
// claude/* branch and open a DRAFT PR, and must NEVER push to the default branch.
import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");

const RUNNERS = [
  { file: ".github/workflows/autonomous-run.yml", branch: 'BRANCH="claude/autonomous-${RUN_ID}"' },
  { file: ".github/workflows/overnight-agent.yml", branch: 'BRANCH="claude/overnight-${RUN_ID}"' },
];

for (const { file, branch } of RUNNERS) {
  test(`${file} has the post-run safety-net step`, () => {
    const src = read(file);
    assert.match(src, /Persist agent work to a draft PR \(safety net\)/, "safety-net step must exist");
    assert.ok(src.includes(branch), "must target a unique claude/* branch for this run");
    assert.match(src, /gh pr create --draft/, "must open the PR as a draft");
  });

  test(`${file} pushes only the claude/* branch, never the default branch`, () => {
    const src = read(file);
    // the only push in the safety net is to the run's claude/* branch variable
    assert.match(src, /git push -u origin "\$BRANCH"/, "push must target the safety-net branch var");
    // a hard-coded push to main/the default ref must not appear
    assert.doesNotMatch(src, /git push[^\n]*origin[^\n]*\$\{?DEFAULT_BRANCH\}?/, "must not push the default branch");
    assert.doesNotMatch(src, /git push[^\n]*origin\s+main\b/, "must not push main");
  });

  test(`${file} skips when the agent left nothing or already pushed (no duplicate PRs)`, () => {
    const src = read(file);
    assert.match(src, /No agent work to persist/, "must no-op on a clean tree with no new commits");
    assert.match(src, /safety net not needed/, "must skip if the agent already pushed its own branch");
  });
}
