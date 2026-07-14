// A MONITOR THAT CANNOT FAIL IS NOT A MONITOR. A GATE THAT CANNOT FAIL IS NOT A GATE.
//
// THE BUG THIS GUARDS. GitHub Actions' default `run:` shell on Linux is `bash -e {0}` -- it sets `-e`
// but NOT `-o pipefail`. So in a step like:
//
//     run: node canary.mjs --strict 2>&1 | tee "$GITHUB_WORKSPACE/canary.log"
//
// the step's exit status is TEE's (always 0), never node's. The canary's `process.exit(1)` -- its entire
// paging mechanism -- is thrown away by the pipe. `--strict` becomes decorative.
//
// On 2026-07-14 this was live in EIGHT steps, including FOUR of the five nightly monitors and, worst,
// the DEPLOY EVAL GATE -- a gate whose whole job is to fail and block a bad deploy, which could not fail.
// Proof it was real: at 2026-07-13T23:39Z `nightly-azure-canary` ran, and reported SUCCESS, on a fleet
// where daily-digest had already failed NINE consecutive scheduled runs. Twenty minutes later it failed
// its tenth. The canary saw nothing it could say.
//
// This is the deepest layer of the fleet's recurring "silent failure" family: it was never only that we
// forgot to LOOK. It is that when we did look, and the sensor did fire, THE PIPE ATE THE ALARM.
//
// The remedy is one line -- `set -o pipefail` -- or `rc=${PIPESTATUS[0]}`. Where tolerance is genuinely
// wanted (the agent runners' timed loop must not die on one bad iteration) it must be DELIBERATE and
// VISIBLE (`|| echo "::warning::..."`), never an accident of shell defaults. This test makes sure nobody
// can add the ninth.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const WF = new URL("../.github/workflows/", import.meta.url).pathname;

/** Split a workflow into step chunks so a `set -o pipefail` in ONE step cannot vouch for another. */
function steps(src) {
  const parts = src.split(/^\s*-\s+name:/m);
  return parts.map((p, i) => ({ idx: i, text: p }));
}

test("CLASS GUARD: no workflow step may discard a command's exit code into a pipe", () => {
  const offenders = [];
  for (const f of readdirSync(WF).filter((f) => f.endsWith(".yml"))) {
    const src = readFileSync(join(WF, f), "utf8");
    for (const s of steps(src)) {
      // A pipe into tee is the fleet's characteristic pattern: "log it AND keep the exit code" -- except
      // it doesn't keep the exit code.
      if (!/\|\s*tee\b/.test(s.text)) continue;
      // Guarded if the step opts into pipefail, or explicitly recovers the real status via PIPESTATUS.
      if (/set -o pipefail|pipefail/.test(s.text) || /PIPESTATUS/.test(s.text)) continue;
      // `echo ... | tee` is only formatting output; echo cannot meaningfully fail. Exempt it.
      const pipesRealCommand = /^\s*(?!.*\becho\b).*\|\s*tee\b/m.test(s.text);
      if (!pipesRealCommand) continue;
      const line = (s.text.split("\n").find((l) => /\|\s*tee\b/.test(l)) || "").trim();
      offenders.push(`${f}: ${line.slice(0, 90)}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `These steps pipe a real command into tee WITHOUT pipefail, so the step's exit status is tee's (always 0) and the command's failure is silently discarded. A monitor that cannot fail is not a monitor; a gate that cannot fail is not a gate. Add "set -o pipefail" to the run block (or capture rc=\${PIPESTATUS[0]}):\n  - ${offenders.join("\n  - ")}`,
  );
});
