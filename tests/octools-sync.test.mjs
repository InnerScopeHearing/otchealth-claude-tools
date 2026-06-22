// Regression tests for the live-sync + fleet-bulletin propagation mechanism (setup/octools-sync.sh,
// setup/bulletin.mjs, FLEET-BULLETIN.md, the UserPromptSubmit wiring). Guards the "all agents stay
// current off main without a restart" design so it cannot silently regress.
import { test } from "node:test";
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("propagation files exist", () => {
  for (const f of ["setup/octools-sync.sh", "setup/bulletin.mjs", "FLEET-BULLETIN.md"]) {
    assert.ok(existsSync(join(ROOT, f)), `${f} should exist`);
  }
});

test("octools-sync auto-reset is /tmp-guarded (never resets a real working checkout)", () => {
  const src = readFileSync(join(ROOT, "setup/octools-sync.sh"), "utf8");
  // the destructive `git reset --hard` must live inside the /tmp/* case guard
  assert.match(src, /case "\$TOOLS_DIR" in\s*\n\s*\/tmp\/\*\)/, "must guard on /tmp/*");
  const guardIdx = src.indexOf("/tmp/*)");
  const esacIdx = src.indexOf("esac");
  const resetIdx = src.indexOf("reset --hard");
  assert.ok(resetIdx > guardIdx && resetIdx < esacIdx, "reset --hard must be inside the /tmp guard");
});

test("UserPromptSubmit hook is wired to octools-sync", () => {
  const settings = JSON.parse(readFileSync(join(ROOT, ".claude/settings.json"), "utf8"));
  const ups = settings.hooks?.UserPromptSubmit ?? [];
  const cmds = ups.flatMap((b) => (b.hooks || []).map((h) => h.command || ""));
  assert.ok(cmds.some((c) => c.includes("octools-sync.sh")), "UserPromptSubmit should run octools-sync.sh");
});

test("install-octools-hook installs the live-sync hook, idempotently, without clobbering", () => {
  const home = mkdtempSync(join(tmpdir(), "ioh-"));
  const installer = join(ROOT, "setup/install-octools-hook.mjs");
  const run = () => execFileSync("node", [installer], { env: { ...process.env, HOME: home }, encoding: "utf8" });
  run();
  const settingsPath = join(home, ".claude", "settings.json");
  const s1 = JSON.parse(readFileSync(settingsPath, "utf8"));
  assert.ok(JSON.stringify(s1.hooks.UserPromptSubmit).includes("octools-sync.sh"), "installs the octools-sync UserPromptSubmit hook");
  run(); // idempotent
  const s2 = JSON.parse(readFileSync(settingsPath, "utf8"));
  assert.strictEqual(s2.hooks.UserPromptSubmit.length, 1, "second run adds no duplicate");
  // never clobber an unparseable user settings file
  const home2 = mkdtempSync(join(tmpdir(), "ioh2-"));
  mkdirSync(join(home2, ".claude"), { recursive: true });
  writeFileSync(join(home2, ".claude", "settings.json"), "NOT JSON {");
  execFileSync("node", [installer], { env: { ...process.env, HOME: home2 }, encoding: "utf8" });
  assert.strictEqual(readFileSync(join(home2, ".claude", "settings.json"), "utf8"), "NOT JSON {", "leaves an unparseable file untouched");
});

test("bulletin `since` shows each entry exactly once (idempotent per environment)", () => {
  const home = mkdtempSync(join(tmpdir(), "blt-"));
  const run = () => execFileSync("node", [join(ROOT, "setup/bulletin.mjs"), "since"], { env: { ...process.env, HOME: home }, encoding: "utf8" });
  const first = run();
  // FLEET-BULLETIN.md is seeded with >=1 entry, so a fresh marker shows at least one update
  assert.match(first, /fleet-bulletin/, "first run should surface the seeded bulletin entry");
  const second = run();
  assert.strictEqual(second.trim(), "", "second run must show nothing new (marker advanced) -> each entry seen once");
});
