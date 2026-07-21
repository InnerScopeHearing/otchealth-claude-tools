// Tests for setup/governed-skills-audit.mjs -- the "shadow-doctrine" skill detector.
//
// session-start.sh and octools-sync.sh both COPY skills FROM the git skills/ tree INTO
// ~/.claude/skills, and neither ever enumerates or prunes a destination-only directory. So a skill
// dir that lands there some other way (an agent authoring one ad hoc, a stale leftover) persists
// forever, silently, fully outside governance. This test file guards the pure logic that detects that
// class of drift, using ONLY synthetic data -- it must never depend on the real ~/.claude/skills
// contents of the machine running the test, which differ session to session and are not part of this
// repo's tracked state.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { diffOrphans, parseFrontmatter, classifyOrphan, isSafeSkillTarget, orphanSetChanged } from "../setup/governed-skills-audit.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "setup", "governed-skills-audit.mjs");

// ───────────────────────── diffOrphans (the headline pure function) ─────────────────────────

test("diffOrphans: returns dest-only names, sorted, given two synthetic directory listings", () => {
  const dest = ["kb-memory", "designer", "one-brain-ground-first-protocol", "xlsx"];
  const src = ["kb-memory", "designer"];
  assert.deepEqual(diffOrphans(dest, src), ["one-brain-ground-first-protocol", "xlsx"]);
});

test("diffOrphans: empty when every dest name exists in src (the healthy, fully-governed state)", () => {
  const dest = ["kb-memory", "designer", "pdf"];
  const src = ["kb-memory", "designer", "pdf", "amazon-sp-api"]; // src may have MORE (not yet installed) -- fine
  assert.deepEqual(diffOrphans(dest, src), []);
});

test("diffOrphans: dedupes duplicate dest entries", () => {
  assert.deepEqual(diffOrphans(["orphan-a", "orphan-a", "orphan-b"], []), ["orphan-a", "orphan-b"]);
});

test("diffOrphans: treats missing/empty inputs as empty lists rather than throwing", () => {
  assert.deepEqual(diffOrphans(undefined, undefined), []);
  assert.deepEqual(diffOrphans([], []), []);
  assert.deepEqual(diffOrphans(["a"], undefined), ["a"]);
});

test("diffOrphans: REGRESSION -- the known suspect set surfaces as orphans against a realistic src tree", () => {
  // Mirrors the live shape found in reconciliation: a handful of company-specific "custom" skills plus
  // Anthropic marketplace skills (both dest-only relative to skills/), sitting alongside real governed
  // skills that exist in both trees.
  const dest = [
    "kb-memory", "company-brain", "designer", // governed, in both
    "xlsx", "docx", "canvas-design", // marketplace-installed, dest-only by design
    "one-brain-ground-first-protocol", "otchealth-cost-speed-routing",
    "otchealth-gateway-toolkit", "otchealth-stability-playbook", "cross-engine-memory-protocol", // shadow
    "manifest.json", // Claude Code's own registry file, not a skill dir at all, but still dest-only by name
  ];
  const src = ["kb-memory", "company-brain", "designer"];
  const orphans = diffOrphans(dest, src);
  for (const known of [
    "one-brain-ground-first-protocol", "otchealth-cost-speed-routing",
    "otchealth-gateway-toolkit", "otchealth-stability-playbook", "cross-engine-memory-protocol",
  ]) {
    assert.ok(orphans.includes(known), `${known} must be flagged as an orphan`);
  }
  for (const governed of ["kb-memory", "company-brain", "designer"]) {
    assert.ok(!orphans.includes(governed), `${governed} is git-tracked and must NOT be flagged`);
  }
});

// ───────────────────────── parseFrontmatter ─────────────────────────

test("parseFrontmatter: extracts name + description from a leading YAML block", () => {
  const md = "---\nname: Example Skill\ndescription: does a thing\n---\n\n# Body\n";
  assert.deepEqual(parseFrontmatter(md), { name: "Example Skill", description: "does a thing" });
});

test("parseFrontmatter: returns null when there is no leading frontmatter block", () => {
  assert.equal(parseFrontmatter("# Just a heading\nno frontmatter here"), null);
  assert.equal(parseFrontmatter(""), null);
  assert.equal(parseFrontmatter(undefined), null);
});

// ───────────────────────── classifyOrphan ─────────────────────────

test("classifyOrphan: 'anthropic' and 'anthropic-example' manifest sources classify as marketplace (no action)", () => {
  assert.equal(classifyOrphan("xlsx", { source: "anthropic" }).verdict, "marketplace");
  assert.equal(classifyOrphan("canvas-design", { source: "anthropic-example" }).verdict, "marketplace");
});

test("classifyOrphan: 'custom' manifest source classifies as shadow-custom (CTO decide delete vs PR-in)", () => {
  const c = classifyOrphan("one-brain-ground-first-protocol", { source: "custom" });
  assert.equal(c.verdict, "shadow-custom");
  assert.match(c.recommend, /delete/i);
  assert.match(c.recommend, /PR-in/i);
});

test("classifyOrphan: no manifest entry at all classifies as untracked (review, never assumed safe or unsafe)", () => {
  const c = classifyOrphan("session-start-hook", undefined);
  assert.equal(c.verdict, "untracked");
  assert.match(c.recommend, /REVIEW/);
});

// ───────────────────────── isSafeSkillTarget (the --prune guard) ─────────────────────────

test("isSafeSkillTarget: true for a real subdirectory of the skills dir", () => {
  const home = mkdtempSync(join(tmpdir(), "gsa-safe-"));
  const skillsDir = join(home, ".claude", "skills");
  mkdirSync(join(skillsDir, "some-orphan"), { recursive: true });
  assert.equal(isSafeSkillTarget(skillsDir, "some-orphan"), true);
});

test("isSafeSkillTarget: false for names that look like path traversal, without touching the filesystem", () => {
  const skillsDir = join(mkdtempSync(join(tmpdir(), "gsa-trav-")), ".claude", "skills");
  for (const bad of ["..", ".", "../../etc", "a/b", "a\\b", "", undefined, null]) {
    assert.equal(isSafeSkillTarget(skillsDir, bad), false, `expected false for ${JSON.stringify(bad)}`);
  }
});

test("isSafeSkillTarget: false for a name that does not exist under the skills dir", () => {
  const home = mkdtempSync(join(tmpdir(), "gsa-missing-"));
  const skillsDir = join(home, ".claude", "skills");
  mkdirSync(skillsDir, { recursive: true });
  assert.equal(isSafeSkillTarget(skillsDir, "never-created"), false);
});

// ───────────────────────── orphanSetChanged (backs --if-changed) ─────────────────────────

test("orphanSetChanged: true on the very first run (no prior recorded list)", () => {
  assert.equal(orphanSetChanged(null, []), true);
  assert.equal(orphanSetChanged(undefined, ["a"]), true);
});

test("orphanSetChanged: false when the list is identical to the previous run", () => {
  assert.equal(orphanSetChanged(["a", "b"], ["a", "b"]), false);
  assert.equal(orphanSetChanged([], []), false);
});

test("orphanSetChanged: true when the count differs, or the same count but different names", () => {
  assert.equal(orphanSetChanged(["a"], ["a", "b"]), true);
  assert.equal(orphanSetChanged(["a", "b"], ["a"]), true);
  assert.equal(orphanSetChanged(["a", "b"], ["a", "c"]), true);
});

test("isSafeSkillTarget: REGRESSION -- refuses a symlink that escapes the skills dir (would delete something else)", () => {
  const home = mkdtempSync(join(tmpdir(), "gsa-symlink-"));
  const skillsDir = join(home, ".claude", "skills");
  mkdirSync(skillsDir, { recursive: true });
  const outside = join(home, "definitely-not-a-skill");
  mkdirSync(outside, { recursive: true });
  const escapeLink = join(skillsDir, "looks-like-a-skill");
  symlinkSync(outside, escapeLink);
  assert.equal(
    isSafeSkillTarget(skillsDir, "looks-like-a-skill"),
    false,
    "a symlink resolving outside the skills dir must never be treated as a safe prune target",
  );
  // cleanup: rmSync on the symlink itself, never following it
  rmSync(escapeLink, { force: true });
  assert.ok(existsSync(outside), "the escape target itself must be untouched");
});

// ───────────────────────── CLI integration (real script, sandboxed $HOME, never the real ~/.claude) ─────────────────────────
// Runs the ACTUAL shipped setup/governed-skills-audit.mjs as a subprocess with HOME redirected to a
// throwaway temp dir (the execFileSync `env` option, matching tests/octools-sync.test.mjs's own
// pattern) -- never the real environment's ~/.claude/skills, and it deletes nothing that is not inside
// that temp dir. SRC_SKILLS resolves from the script's own location, so it is this repo's REAL skills/
// tree; the synthetic orphan name below is chosen to be certain not to collide with anything real.

function makeSandboxHome() {
  const home = mkdtempSync(join(tmpdir(), "gsa-cli-"));
  const skillsDir = join(home, ".claude", "skills");
  mkdirSync(join(skillsDir, "kb-memory"), { recursive: true }); // a REAL skills/ entry -> must NOT be flagged
  mkdirSync(join(skillsDir, "gsa-test-shadow-skill"), { recursive: true }); // synthetic, certain not to exist in skills/
  writeFileSync(join(skillsDir, "gsa-test-shadow-skill", "SKILL.md"), "---\nname: gsa-test-shadow-skill\ndescription: synthetic test fixture\n---\nbody\n");
  writeFileSync(
    join(skillsDir, "manifest.json"),
    JSON.stringify({ skills: [{ name: "gsa-test-shadow-skill", source: "custom", updatedAt: "2026-01-01T00:00:00Z" }] }),
  );
  return { home, skillsDir };
}

function run(args, home) {
  return execFileSync("node", [SCRIPT, ...args], { env: { ...process.env, HOME: home }, encoding: "utf8" });
}

test("CLI --report: flags the synthetic shadow skill, leaves a real skills/ entry alone", () => {
  const { home } = makeSandboxHome();
  const out = run(["--report"], home);
  assert.match(out, /gsa-test-shadow-skill/);
  assert.doesNotMatch(out, /(^|\s)kb-memory(\s|$)/m);
});

test("CLI --detail --json: classifies the synthetic orphan as shadow-custom via its manifest.json entry", () => {
  const { home } = makeSandboxHome();
  const out = run(["--report", "--detail", "--json"], home);
  const parsed = JSON.parse(out);
  assert.ok(parsed.orphans.includes("gsa-test-shadow-skill"));
  const row = parsed.detail.find((d) => d.name === "gsa-test-shadow-skill");
  assert.equal(row.verdict, "shadow-custom");
  assert.equal(row.manifest_source, "custom");
});

test("CLI --prune (no --yes) is a true dry run: the directory survives on disk", () => {
  const { home, skillsDir } = makeSandboxHome();
  const out = run(["--prune"], home);
  assert.match(out, /DRY RUN/);
  assert.ok(existsSync(join(skillsDir, "gsa-test-shadow-skill")), "dry run must never delete anything");
});

test("CLI --prune --yes: removes the synthetic shadow orphan for real, in complete isolation from the real ~/.claude", () => {
  const { home, skillsDir } = makeSandboxHome();
  const out = run(["--prune", "--yes"], home);
  assert.match(out, /LIVE/);
  assert.ok(!existsSync(join(skillsDir, "gsa-test-shadow-skill")), "--prune --yes must actually remove the target");
  assert.ok(existsSync(join(skillsDir, "kb-memory")), "a real (non-orphan) skill dir must never be touched");
});

// ───────────────────────── session-hook wiring (the tool is only useful if something calls it) ─────────────────────────

test("session-start.sh runs the (report-only) audit after installing skills, fail-open", () => {
  const src = readFileSync(join(ROOT, "setup", "session-start.sh"), "utf8");
  assert.match(src, /governed-skills-audit\.mjs.*--report/, "session-start.sh should call the auditor in --report mode");
  assert.doesNotMatch(src, /governed-skills-audit\.mjs[^\n]*--prune/, "session-start.sh must never invoke --prune");
});

test("octools-sync.sh runs the audit in --if-changed mode, fail-open, never --prune", () => {
  const src = readFileSync(join(ROOT, "setup", "octools-sync.sh"), "utf8");
  assert.match(src, /governed-skills-audit\.mjs.*--if-changed/, "octools-sync.sh should call the auditor in --if-changed mode (avoids reprinting every prompt)");
  assert.doesNotMatch(src, /governed-skills-audit\.mjs[^\n]*--prune/, "octools-sync.sh must never invoke --prune");
});

test("CLI --report --if-changed: silent on a second identical run, speaks again once the set changes", () => {
  const { home, skillsDir } = makeSandboxHome();
  const first = run(["--report", "--if-changed"], home);
  assert.match(first, /gsa-test-shadow-skill/, "first-ever --if-changed run must report (no prior baseline)");
  const second = run(["--report", "--if-changed"], home);
  assert.equal(second.trim(), "", "an unchanged orphan set must produce no output on the next --if-changed run");
  // introduce a NEW orphan -> must speak up again
  mkdirSync(join(skillsDir, "gsa-test-shadow-skill-2"), { recursive: true });
  const third = run(["--report", "--if-changed"], home);
  assert.match(third, /gsa-test-shadow-skill-2/, "a newly-appeared orphan must be reported even in --if-changed mode");
});
