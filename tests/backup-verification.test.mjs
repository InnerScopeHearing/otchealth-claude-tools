import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const shell = process.env.BASH_TEST_SHELL || "bash";
const workflow = readFileSync(new URL("../.github/workflows/nightly-secrets-dr-export.yml", import.meta.url), "utf8");
const section = workflow.split('      - name: "Verify recovery point')[1]?.split("\n      - name: Upload export log")[0];
const script = section?.split("        run: |\n")[1]?.split("\n").map(line => line.startsWith("          ") ? line.slice(10) : line).join("\n");
assert.ok(script, "recovery verification shell step must be present");

const stub = `timeout() {
  case "$1" in
    90) return 0 ;;
    30) case "$SCENARIO" in
          decrypt_fail) return 2 ;;
          empty) return 0 ;;
          *) printf 'synthetic-name\\n' ;;
        esac ;;
    *) return 99 ;;
  esac
}
node() { return 98; }
rm() { :; }
`;

function run(scenario) {
  const env = { PATH: process.env.PATH || "", SCENARIO: scenario,
    SECRETS_DR_PASSPHRASE: scenario === "missing" ? "" : "synthetic-test-only" };
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  const result = spawnSync(shell, ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", stub + script],
    { env, encoding: "utf8" });
  assert.ifError(result.error);
  return result;
}

const options = { skip: process.platform === "win32" && !process.env.BASH_TEST_SHELL };
test("missing passphrase fails verification visibly", options, () => {
  const out = run("missing");
  assert.notEqual(out.status, 0);
  assert.match(out.stdout, /::error::/);
});
test("synthetic verification succeeds when a name is recovered", options, () => {
  const out = run("success");
  assert.equal(out.status, 0);
  assert.match(out.stdout, /verified: decrypt succeeded, 1 secret names recovered/);
});
test("failed decrypt and empty archive fail verification", options, () => {
  assert.notEqual(run("decrypt_fail").status, 0);
  assert.notEqual(run("empty").status, 0);
});
