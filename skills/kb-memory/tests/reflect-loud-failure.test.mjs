// Tests for reflect.mjs's fail-loud + durable-local-fallback behavior (2026-08-18).
//
// Context: reflect.mjs is Stop-hook-friendly and always exits 0 by design (a best-effort memory
// distiller must never block a session ending). Before this fix that same design silenced a REAL
// write failure completely: mem.mjs's own stderr was thrown away (`stdio: "ignore"`), the catch
// logged one generic line, and on the "stop" hook path even that line is piped to /dev/null by
// kb-inject.sh's own invocations of this script. So a session could end clean while every distilled
// lesson silently vanished. These tests pin the fix at the unit level (the fallback file itself);
// end-to-end proof (a forced Azure write failure producing the loud banner + a populated fallback
// file, then a clean run with no failure once BLOB_BACKEND=s3 succeeds) is in the PR description,
// captured from a real run rather than simulated here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, rm, mkdtemp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FAILED_WRITE_FILE, appendFailedWriteFallback } from "../reflect.mjs";

// appendFailedWriteFallback resolves its path from homedir(), which node:os does not let a test
// override cleanly — so these tests point HOME at a throwaway temp dir for the duration of the
// test, matching how the rest of this toolkit keeps filesystem tests hermetic (mem.mjs's own header
// comment calls out exactly this pattern: "respects a test's temp HOME, so hermetic tests stay
// hermetic").
async function withTempHome(run) {
  const dir = await mkdtemp(join(tmpdir(), "reflect-fallback-test-"));
  const savedHome = process.env.HOME;
  process.env.HOME = dir;
  try { return await run(dir); } finally { process.env.HOME = savedHome; await rm(dir, { recursive: true, force: true }); }
}

test("a failed lesson is appended to a per-agent fallback file, not dropped", async () => {
  await withTempHome(async () => {
    const agent = "test-agent-alpha";
    assert.equal(existsSync(FAILED_WRITE_FILE(agent)), false, "must not exist before any failure");
    appendFailedWriteFallback(agent, { type: "pitfall", text: "example lost lesson", share: false }, "ERROR: put 403 AuthorizationPermissionMismatch");
    assert.equal(existsSync(FAILED_WRITE_FILE(agent)), true);
    const rows = (await readFile(FAILED_WRITE_FILE(agent), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].agent, agent);
    assert.equal(rows[0].type, "pitfall");
    assert.equal(rows[0].text, "example lost lesson");
    assert.equal(rows[0].share, false);
    assert.match(rows[0].error, /403/, "the real underlying error must be preserved, not summarized away");
    assert.equal(rows[0].source, "reflect.mjs");
    assert.ok(rows[0].ts, "must carry a timestamp so a recovery pass can order lost writes");
  });
});

test("multiple failures for the SAME agent append (never overwrite) so nothing already-lost gets lost again", async () => {
  await withTempHome(async () => {
    const agent = "test-agent-beta";
    appendFailedWriteFallback(agent, { type: "remember", text: "first lost fact" }, "err1");
    appendFailedWriteFallback(agent, { type: "decision", text: "second lost fact", share: true }, "err2");
    const rows = (await readFile(FAILED_WRITE_FILE(agent), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(rows.length, 2);
    assert.equal(rows[0].text, "first lost fact");
    assert.equal(rows[1].text, "second lost fact");
    assert.equal(rows[1].share, true);
  });
});

test("different agents get different fallback files (no cross-agent clobber, mirrors the real per-agent shared feed)", async () => {
  await withTempHome(async () => {
    appendFailedWriteFallback("agent-one", { type: "remember", text: "x" }, "e");
    appendFailedWriteFallback("agent-two", { type: "remember", text: "y" }, "e");
    assert.notEqual(FAILED_WRITE_FILE("agent-one"), FAILED_WRITE_FILE("agent-two"));
    assert.ok(existsSync(FAILED_WRITE_FILE("agent-one")));
    assert.ok(existsSync(FAILED_WRITE_FILE("agent-two")));
    const one = (await readFile(FAILED_WRITE_FILE("agent-one"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(one.length, 1, "agent-one's file must not contain agent-two's entry");
  });
});

// ---- counterfactual guard: the shipped commit loop must capture real stderr and never go back to
// silently discarding it, and must still exit 0 unconditionally (the Stop-hook contract). ----------
test("reflect.mjs's per-item commit no longer discards the child's stderr via stdio:\"ignore\"", async () => {
  const src = (await readFile(new URL("../reflect.mjs", import.meta.url), "utf8")).replace(/^\s*\/\/.*$/gm, "");
  const start = src.indexOf("async function main()");
  assert.ok(start > -1);
  const body = src.slice(start);
  assert.doesNotMatch(body, /execFileSync\("node", a, \{ stdio: "ignore" \}\)/, "the per-item commit call must not silently discard stderr");
  assert.match(body, /stdio:\s*\[\s*"ignore",\s*"ignore",\s*"pipe"\s*\]/, "stderr must be piped so a real failure's cause is captured");
  assert.match(body, /appendFailedWriteFallback\(/, "a failed commit must write to the durable local fallback");
  assert.match(body, /LOST WRITE/, "a failed commit must print an unmistakable, greppable banner");
});
test("reflect.mjs still exits 0 unconditionally (the Stop-hook contract: never block a session)", async () => {
  const src = await readFile(new URL("../reflect.mjs", import.meta.url), "utf8");
  const lastExit = [...src.matchAll(/process\.exit\((\d+)\)/g)].pop();
  assert.ok(lastExit, "main() must still call process.exit with a literal code");
  assert.equal(lastExit[1], "0", "the final exit in main() must remain 0 even when failures occurred");
  assert.match(src, /main\(\)\.catch\(\(e\) => \{ console\.error\("reflect ERROR: " \+ e\.message\); process\.exit\(0\); \}\);/, "an uncaught error in main() must still exit 0, not crash the Stop hook");
});
