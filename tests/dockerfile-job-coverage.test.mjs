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
//
// It matches the DESTINATION, not just the source. The first draft of this test asserted only
// `COPY skills/<skill>/ `, which a `COPY skills/<skill>/ /tmp/whatever/` would satisfy while the
// scheduled task still died at /app/skills/<skill>/job/... -- an "enforceable" guard enforcing the
// half that is salient rather than the half the runtime reads. Review caught it. The task commands
// reference /app/skills/<skill>/job/..., so that exact prefix is what has to be bound.
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

// A skill counts as covered only if it is copied to the path the job command actually references,
// /app/skills/<skill>/. Trailing slash optional on the destination; Docker treats both alike.
function copiedToAppPath(dockerfile, skill) {
  return new RegExp(`^COPY\\s+skills/${skill}/\\s+/app/skills/${skill}/?\\s*$`, "m").test(dockerfile);
}

test("every skill with a job/ entrypoint is COPY'd into the doc-indexer image, or is a recorded exception", () => {
  const dockerfile = readFileSync(join(ROOT, "skills/doc-indexer/job/Dockerfile"), "utf8");
  const skills = readdirSync(join(ROOT, "skills"), { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(ROOT, "skills", d.name, "job")))
    .map((d) => d.name);

  assert.ok(skills.length >= 8, `expected to find the job-bearing skills, found ${skills.length}`);

  const missing = skills.filter(
    (s) => !copiedToAppPath(dockerfile, s) && !NOT_IN_IMAGE[s],
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
  const staleExceptions = Object.keys(NOT_IN_IMAGE).filter((s) => copiedToAppPath(dockerfile, s));
  assert.deepEqual(
    staleExceptions,
    [],
    `these are COPY'd into the image but still listed as exceptions -- remove them from ` +
      `NOT_IN_IMAGE: ${staleExceptions.join(", ")}`,
  );
});

// SECOND CLASS, same root cause, found the hard way one merge later (2026-09-02). The test above
// pins that a job-bearing skill is in the image. It does NOT pin that the skill can actually LOAD:
// skills import each other by relative path (`../datadog/dd-emit.mjs`), and a copied skill importing
// a NON-copied one dies at `ERR_MODULE_NOT_FOUND` on its first scheduled run -- the same invisible
// death, one level down. fleet-medic (copied, runs every 30 min) gained an import of skills/datadog
// (not copied) and would have started crash-looping on the next image build.
//
// This walks the TRANSITIVE closure rather than direct imports only: a copied skill may reach a
// third skill through a second one, and the runtime follows the whole chain.
function copiedSkills(dockerfile) {
  return [...dockerfile.matchAll(/^COPY\s+skills\/([^/\s]+)\/\s+\/app\/skills\/\1\/?\s*$/gm)].map((m) => m[1]);
}

function mjsFilesUnder(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...mjsFilesUnder(p));
    else if (e.name.endsWith(".mjs") || e.name.endsWith(".js")) out.push(p);
  }
  return out;
}

/** Sibling skills this skill reaches directly, via a `../<skill>/...` specifier. */
function siblingImports(skill) {
  const dir = join(ROOT, "skills", skill);
  if (!existsSync(dir)) return [];
  const found = new Set();
  for (const f of mjsFilesUnder(dir)) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/(?:from|import\()\s*["'`]\.\.\/([a-zA-Z0-9._-]+)\//g)) {
      // `../../x` captures ".." -- a path escaping skills/, not a sibling skill. Excluded, or the
      // test reports a phantom "skills/.." alongside its real findings and teaches people to skim it.
      if (m[1] === "." || m[1] === "..") continue;
      found.add(m[1]);
    }
  }
  return [...found];
}

test("every skill reachable by import from a COPY'd skill is itself COPY'd -- a copied skill that imports a missing one dies MODULE_NOT_FOUND at runtime", () => {
  const dockerfile = readFileSync(join(ROOT, "skills/doc-indexer/job/Dockerfile"), "utf8");
  const copied = new Set(copiedSkills(dockerfile));
  assert.ok(copied.size >= 15, `expected to parse the COPY list, parsed ${copied.size}`);

  const seen = new Set();
  const queue = [...copied];
  const missing = new Map(); // needed skill -> the copied skill that reaches it
  while (queue.length) {
    const skill = queue.shift();
    if (seen.has(skill)) continue;
    seen.add(skill);
    for (const dep of siblingImports(skill)) {
      if (!existsSync(join(ROOT, "skills", dep))) continue; // not a skill dir (e.g. a relative data path)
      if (!copied.has(dep)) { if (!missing.has(dep)) missing.set(dep, skill); continue; }
      queue.push(dep);
    }
  }

  assert.deepEqual(
    [...missing.keys()],
    [],
    `these skills are imported from inside the image but never COPY'd into it, so the importing ` +
      `job crashes on load: ` +
      [...missing].map(([dep, via]) => `skills/${dep} (imported by skills/${via})`).join(", ") +
      `. Add the COPY line to skills/doc-indexer/job/Dockerfile.`,
  );
});
