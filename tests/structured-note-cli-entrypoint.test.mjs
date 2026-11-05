import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const original = resolve(dirname(fileURLToPath(import.meta.url)), "..", "skills", "structured-notes", "note-schema.mjs");
function withFixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), "structured note guard "));
  try {
    const sourceDir = join(dir, "real source");
    mkdirSync(sourceDir);
    const script = join(sourceDir, "note-schema.mjs");
    copyFileSync(original, script);
    return fn({ dir, sourceDir, script });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
function run(args) { return spawnSync(process.execPath, args, { encoding: "utf8", timeout: 5000 }); }

test("direct execution with invalid arguments returns the usage error", () => withFixture(({ script }) => {
  const r = run([script]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage: note-schema/);
}));
test("direct execution normalizes a synthetic note", () => withFixture(({ script }) => {
  const r = run([script, "normalize", '{"subject":"demo","claim":"example"}']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { subject: "demo", claim: "example" });
}));
test("a linked directory still starts the CLI", () => withFixture(({ dir, sourceDir }) => {
  const link = join(dir, "linked source");
  symlinkSync(sourceDir, link, process.platform === "win32" ? "junction" : "dir");
  const r = run([join(link, "note-schema.mjs")]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage: note-schema/);
}));
test("importing the utility does not start its CLI", () => withFixture(({ script }) => {
  const expr = 'import { pathToFileURL } from "node:url"; await import(pathToFileURL(process.argv[2]).href);';
  const r = run(["--input-type=module", "-e", expr, "import-test", script]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "");
  assert.equal(r.stderr, "");
}));
