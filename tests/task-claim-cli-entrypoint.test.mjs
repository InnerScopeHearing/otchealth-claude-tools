import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const original = resolve(dirname(fileURLToPath(import.meta.url)), "..", "skills", "task-claim", "claim.mjs");
function withFixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), "synthetic task claim "));
  try {
    const sourceDir = join(dir, "fake ledger source");
    mkdirSync(sourceDir);
    const script = join(sourceDir, "claim.mjs");
    copyFileSync(original, script);
    writeFileSync(join(sourceDir, "gateway-ledger.mjs"), "export function createGatewayLedger(opts) { return { fake: true, lane: opts.lane }; }");
    writeFileSync(join(sourceDir, "mutex.mjs"), [
      "export async function acquire(ledger, args) { return { acquired: true, fake: ledger.fake, resource: args.resource }; }",
      "export async function release() { return { released: false }; }",
      "export async function heartbeat() { return { extended: true }; }",
      "export async function status() { return { found: false }; }",
    ].join("\n"));
    return fn({ dir, sourceDir, script });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
function run(args) { return spawnSync(process.execPath, args, { encoding: "utf8", timeout: 5000 }); }

test("an invalid command returns usage rather than a false success", () => withFixture(({ script }) => {
  const r = run([script]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /task-claim: commands/);
}));
test("acquire dispatches to the fake ledger and returns its synthetic result", () => withFixture(({ script }) => {
  const r = run([script, "acquire", "synthetic-resource", "--agent", "synthetic-agent"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { acquired: true, fake: true, resource: "synthetic-resource" });
}));
test("release, heartbeat and status retain their distinct exit outcomes", () => withFixture(({ script }) => {
  assert.equal(run([script, "release", "fake-id", "--agent", "fake", "--lease-version", "1"]).status, 1);
  assert.equal(run([script, "heartbeat", "fake-id", "--agent", "fake"]).status, 0);
  assert.equal(run([script, "status", "fake-resource"]).status, 1);
}));
test("a linked directory dispatches to the fake ledger", () => withFixture(({ dir, sourceDir }) => {
  const link = join(dir, "linked source");
  symlinkSync(sourceDir, link, process.platform === "win32" ? "junction" : "dir");
  const r = run([join(link, "claim.mjs"), "acquire", "synthetic-resource", "--agent", "synthetic-agent"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).fake, true);
}));
test("importing does not execute the command", () => withFixture(({ script }) => {
  const expr = 'import { pathToFileURL } from "node:url"; await import(pathToFileURL(process.argv[2]).href);';
  const r = run(["--input-type=module", "-e", expr, "import-test", script]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "");
  assert.equal(r.stderr, "");
}));
