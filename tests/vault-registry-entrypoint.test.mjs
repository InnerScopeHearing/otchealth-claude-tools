import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

function fixture(t) {
  const tmp = resolve(tmpdir());
  const root = mkdtempSync(join(tmp, "vault-cli-"));
  assert.equal(resolve(dirname(root)).toLowerCase(), tmp.toLowerCase());
  t.after(() => { assert.equal(resolve(dirname(root)).toLowerCase(), tmp.toLowerCase()); rmSync(root, { recursive: true, force: true }); });
  const skills = join(root, "skills");
  mkdirSync(join(skills, "vault-sync"), { recursive: true });
  mkdirSync(join(skills, "kb-memory"), { recursive: true });
  const script = join(skills, "vault-sync", "vault-registry.mjs");
  writeFileSync(script, readFileSync(new URL("../skills/vault-sync/vault-registry.mjs", import.meta.url)));
  writeFileSync(join(skills, "kb-memory", "aws-secret.mjs"), `export async function ssmListDetailed() { return process.env.TEST_EMPTY === '1' ? [] : [{ id: 'synthetic-example', created: '2026-01-01' }]; }`);
  writeFileSync(join(skills, "kb-memory", "commons-store.mjs"), `export async function cPut() { throw new Error('fake write forbidden'); }`);
  return { root, skills, script };
}
function run(script, args = [], env = {}) {
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env: { ...process.env, ...env } });
}
test("direct dry invocation works with spaces and never calls a real provider", t => {
  const { script } = fixture(t);
  const r = run(script, ["--dry"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /1 credentials/);
  assert.match(r.stdout, /dry: not uploaded/);
});
test("an empty source exits with failure", t => {
  const { script } = fixture(t);
  const r = run(script, ["--dry"], { TEST_EMPTY: "1" });
  assert.equal(r.status, 3);
  assert.match(r.stderr, /refusing to publish an empty registry/);
});
test("a linked directory invocation is recognized", t => {
  const { root, skills } = fixture(t);
  const link = join(root, "skills-link");
  symlinkSync(skills, link, process.platform === "win32" ? "junction" : "dir");
  assert.equal(realpathSync(link).toLowerCase(), realpathSync(skills).toLowerCase());
  const r = run(join(link, "vault-sync", "vault-registry.mjs"), ["--dry"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /dry: not uploaded/);
});
test("importing the module does not run its CLI", t => {
  const { root, script } = fixture(t);
  const entry = join(root, "import-check.mjs");
  writeFileSync(entry, `import { infer } from ${JSON.stringify(pathToFileURL(script).href)}; console.log(infer('synthetic').service);`);
  const r = run(entry);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^Other\s*$/);
  assert.equal(r.stderr, "");
});
test("failed fake writes return a nonzero exit", t => {
  const { script } = fixture(t);
  const r = run(script);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /fake write forbidden/);
});