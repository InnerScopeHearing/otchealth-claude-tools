// Regression gate for fleet-dispatch guard + fail-open paths. The directed inbox send/check happy paths
// need the commons (network), but the SAFETY paths must hold hermetically: `check` must FAIL-OPEN (exit
// 0, never hang) on a credential-less box (so the SessionStart hook can never break a session), and
// `send` must reject missing args before touching the network. All guards return before any I/O.
import { test } from "node:test";
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const D = join(ROOT, "skills/fleet-dispatch/dispatch.mjs");
function run(args) {
  const HOME = mkdtempSync(join(tmpdir(), "disp-"));
  return spawnSync("node", [D, ...args], { env: { ...process.env, HOME, GCP_CLAUDE_DRIVER_SA_JSON: "" }, encoding: "utf8", timeout: 10000 });
}

test("check fails OPEN on a credential-less box (exit 0, no hang) so SessionStart never breaks", () => {
  const r = run(["check", "--agent", "developer"]);
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.signal, null, "must not hang/timeout");
});

test("check with no agent is a clean no-op (exit 0)", () => {
  assert.strictEqual(run(["check"]).status, 0);
});

test("send rejects a missing recipient/text before any network call (exit 2)", () => {
  assert.strictEqual(run(["send"]).status, 2, "no args -> usage error");
  assert.strictEqual(run(["send", "developer"]).status, 2, "recipient but no message -> usage error");
});

test("an unknown verb prints usage and exits 2", () => {
  assert.strictEqual(run(["frobnicate"]).status, 2);
});
