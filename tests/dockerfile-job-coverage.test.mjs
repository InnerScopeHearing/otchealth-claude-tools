// Every skill that ships a job/ entrypoint must be COPY'd into the doc-indexer image, or its
// scheduled task cannot run.
//
// THE FAILURE THIS PINS (2026-09-02). The Dockerfile uses a SELECTIVE COPY list, so adding a skill
// to this repo does not add it to the image, and nothing in CI linked the two. Its own comment says
// so -- "a schedule override pointing at a skill NOT copied dies MODULE_NOT_FOUND at runtime while
// RunTask reports success" -- and safety-monitor was deployed straight into that trap anyway, by
// someone who had read the comment. A pre-deploy rehearsal caught it (`/bin/sh: 0: cannot open
// /app/skills/safety-monitor/job/sweep.sh`), which is luck dressed as process: a comment cannot
// enforce anything, and the next skill would have hit it the same way.
//
// The check is an ALLOWLIST of exceptions rather than a warning, deliberately. A warning is
// ignorable and rots; a hard failure with no escape hatch gets deleted the first time it blocks a
// legitimate case. Requiring an explicit entry forces whoever adds one to write down WHY a
// job-bearing skill is absent from the image -- the decision that was previously implicit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// A job-bearing skill may be absent from the image ONLY with a reason recorded here.
const NOT_IN_IMAGE = {
  "legal-deadline-pager":
    "Deliberately undeployed: ships disarmed (needs BOTH --commit and LEGAL_PAGER_ENABLED=1) and " +
    "is ring-sensitive, touching attorney-privileged personal-legal matters. Verified 2026-09-02 " +
    "that no EventBridge schedule references it, so it is not silently dark in production -- it is " +
    "not shipped at all, pending Matt's arming decision. Copying it into the image would be a " +
    "deploy decision wearing a build change, so it stays out until that decision is made.",
};

test("every skill with a job/ entrypoint is COPY'd into the doc-indexer image, or is a recorded exception", () => {
  const dockerfile = readFileSync(join(ROOT, "skills/doc-indexer/job/Dockerfile"), "utf8");
  const skills = readdirSync(join(ROOT, "skills"), { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(ROOT, "skills", d.name, "job")))
    .map((d) => d.name);

  assert.ok(skills.length >= 8, `expected to find the job-bearing skills, found ${skills.length}`);

  const missing = skills.filter(
    (s) => !new RegExp(`^COPY skills/${s}/ `, "m").test(dockerfile) && !NOT_IN_IMAGE[s],
  );
  assert.deepEqual(
    missing,
    [],
    `these skills ship a job/ entrypoint but are not COPY'd into the image, so a scheduled run of ` +
      `them dies at exec: ${missing.join(", ")}. Add a COPY line to skills/doc-indexer/job/Dockerfile, ` +
      `or add an entry to NOT_IN_IMAGE in this file explaining why it is deliberately absent.`,
  );

  // An exception that is no longer needed is itself drift: once a skill IS copied, delete its entry
  // rather than leaving a stale justification that reads as current.
  const staleExceptions = Object.keys(NOT_IN_IMAGE).filter((s) =>
    new RegExp(`^COPY skills/${s}/ `, "m").test(dockerfile),
  );
  assert.deepEqual(
    staleExceptions,
    [],
    `these are COPY'd into the image but still listed as exceptions -- remove them from ` +
      `NOT_IN_IMAGE: ${staleExceptions.join(", ")}`,
  );
});
