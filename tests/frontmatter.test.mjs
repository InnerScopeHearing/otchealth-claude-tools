// Guards the skill-registration invariant: EVERY skills/<name>/SKILL.md must open with YAML frontmatter
// that has `name:` and `description:`. A SKILL.md without frontmatter does NOT register as a skill
// (this silently broke focus-group-loop, shark-tank, and company-brain until it was caught). This test
// fails CI the moment a skill is added without frontmatter, so the bug class can never recur.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SKILLS = join(ROOT, "skills");

function parseFrontmatter(md) {
  // frontmatter must be the very first thing in the file: ---\n...\n---
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const body = m[1];
  const has = (k) => new RegExp(`^${k}:\\s*\\S`, "m").test(body);
  return { name: has("name"), description: has("description") };
}

const skillDirs = existsSync(SKILLS)
  ? readdirSync(SKILLS).filter((d) => statSync(join(SKILLS, d)).isDirectory())
  : [];

test("there are skills to check", () => {
  assert.ok(skillDirs.length > 0, "no skill directories found under skills/");
});

for (const dir of skillDirs) {
  const skillMd = join(SKILLS, dir, "SKILL.md");
  // A skill dir is only required to register if it ships a SKILL.md; sub-tooling-only dirs are exempt.
  if (!existsSync(skillMd)) continue;
  test(`skills/${dir}/SKILL.md has valid frontmatter (name + description)`, () => {
    const fm = parseFrontmatter(readFileSync(skillMd, "utf8"));
    assert.ok(fm, `skills/${dir}/SKILL.md is missing the leading --- YAML frontmatter block; it will NOT register as a skill`);
    assert.ok(fm.name, `skills/${dir}/SKILL.md frontmatter is missing a non-empty 'name:'`);
    assert.ok(fm.description, `skills/${dir}/SKILL.md frontmatter is missing a non-empty 'description:'`);
  });
}
