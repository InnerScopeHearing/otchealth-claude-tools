// Tests for critic-pass/run.mjs, the executor that turns critic-pass from advisory into an actual pass.
// Offline by construction: every test injects a fake chatFn (or forces the fail-safe), so no network /
// no Azure creds are needed. This pins the gate short-circuit, the verdict plumbing, and the fail-safe.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runCriticPass, criticGate } from "../run.mjs";

const approveJson = '{"verdict":"approve","issues":[],"confidence":0.9}';
const reviseJson = '{"verdict":"revise","issues":[{"severity":"high","note":"unsupported claim"}],"confidence":0.8}';

test("criticGate short-circuits with NO model call when useCritic is false", async () => {
  let called = false;
  const chatFn = async () => { called = true; return approveJson; };
  const r = await criticGate({ useCritic: false, task: "t", draft: "d", chatFn });
  assert.equal(r.ran, false);
  assert.equal(called, false, "the model must not be called when useCritic=false");
  assert.equal(r.shouldRevise, false);
});

test("criticGate runs the pass when useCritic is true and returns the parsed verdict", async () => {
  const chatFn = async () => approveJson;
  const r = await criticGate({ useCritic: true, task: "t", draft: "d", chatFn });
  assert.equal(r.ran, true);
  assert.equal(r.verdict, "approve");
  assert.equal(r.shouldRevise, false);
  assert.equal(r.malformed, false);
});

test("runCriticPass surfaces a revise verdict and shouldRevise at/above min severity", async () => {
  const chatFn = async () => reviseJson;
  const r = await runCriticPass({ task: "t", draft: "d", chatFn, minSeverity: "medium" });
  assert.equal(r.verdict, "revise");
  assert.equal(r.shouldRevise, true);
  assert.equal(r.issues[0].severity, "high");
});

test("a high min-severity floor suppresses a revise driven only by a low-severity issue", async () => {
  const chatFn = async () => '{"verdict":"revise","issues":[{"severity":"low","note":"nit"}],"confidence":0.5}';
  const r = await runCriticPass({ task: "t", draft: "d", chatFn, minSeverity: "high" });
  assert.equal(r.verdict, "revise");
  assert.equal(r.shouldRevise, false, "a low-only revise must not trip a high-severity gate");
});

test("fail-safe: a throwing model call degrades to approve (malformed) and NEVER blocks", async () => {
  const chatFn = async () => { throw new Error("simulated 500 from the model"); };
  const r = await runCriticPass({ task: "t", draft: "d", chatFn });
  assert.equal(r.ran, true);
  assert.equal(r.verdict, "approve");
  assert.equal(r.malformed, true);
  assert.equal(r.shouldRevise, false);
  assert.match(r.error, /simulated 500/);
});

test("fail-safe: malformed (non-JSON) model output degrades to approve, not a throw", async () => {
  const chatFn = async () => "the model rambled without any json";
  const r = await runCriticPass({ task: "t", draft: "d", chatFn });
  assert.equal(r.verdict, "approve");
  assert.equal(r.malformed, true);
  assert.equal(r.shouldRevise, false);
});

test("the resolved model tier is reported (default standard = gpt-4o, never the banned mini)", async () => {
  const chatFn = async () => approveJson;
  const r = await runCriticPass({ task: "t", draft: "d", chatFn });
  assert.equal(typeof r.model, "string");
  assert.notEqual(r.model, "gpt-4.1-mini");
});

// CLI-level test: --task-file is read (injection-safe input) and --if-critic gates a low-stakes task
// to a no-model-call short-circuit. Offline: the allocator's decision is pure, no network is touched.
import { test as _t2 } from "node:test";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

_t2("CLI --task-file + --if-critic short-circuits a low-stakes lookup with no model call", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const runMjs = join(here, "..", "run.mjs");
  const dir = mkdtempSync(join(tmpdir(), "critic-cli-"));
  const tf = join(dir, "task.txt");
  const df = join(dir, "draft.txt");
  writeFileSync(tf, "what is the current app version number"); // pure lookup -> useCritic=false
  writeFileSync(df, "the version is 1.5.15");
  const out = execFileSync("node", [runMjs, "--task-file", tf, "--draft-file", df, "--if-critic"], { encoding: "utf8" });
  const parsed = JSON.parse(out);
  assert.equal(parsed.ran, false);
  assert.equal(parsed.skipped, "useCritic=false");
});
