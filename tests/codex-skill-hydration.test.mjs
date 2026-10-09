import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("hydrator mirrors every repository skill and required setup module into the Codex global root", () => {
  const home = mkdtempSync(join(tmpdir(), "codex-skill-hydration-"));
  const agentsRoot = join(home, ".agents");
  execFileSync("bash", [join(ROOT, "setup/hydrate-skills.sh"), agentsRoot], { encoding: "utf8" });

  const sourceSkills = readdirSync(join(ROOT, "skills"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const hydratedSkills = readdirSync(join(agentsRoot, "skills"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(hydratedSkills, sourceSkills);

  const setupModules = readdirSync(join(ROOT, "setup")).filter((file) => file.endsWith(".mjs")).sort();
  const installedModules = readdirSync(join(agentsRoot, "setup")).sort();
  assert.deepEqual(installedModules, setupModules, "only shared .mjs setup modules are copied");
  for (const file of setupModules) {
    assert.equal(readFileSync(join(agentsRoot, "setup", file), "utf8"), readFileSync(join(ROOT, "setup", file), "utf8"));
  }
});

test("fresh and live session setup both hydrate Codex skills from the shared source", () => {
  for (const file of ["setup/session-start.sh", "setup/octools-sync.sh"]) {
    const source = readFileSync(join(ROOT, file), "utf8");
    assert.match(source, /hydrate-skills\.sh[^\n]*\.agents/, `${file} must refresh ~/.agents`);
  }
  const codex = readFileSync(join(ROOT, "setup/codex-session-start.sh"), "utf8");
  assert.match(codex, /hydrate-skills\.sh[^\n]*\.agents/);
});
