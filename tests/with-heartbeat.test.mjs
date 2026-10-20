import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const wrapper = resolve("setup/with-heartbeat.sh");

test("with-heartbeat emits sanitized warnings for failed beats and preserves workload exit", () => {
  const root = mkdtempSync(join(tmpdir(), "heartbeat-wrapper-"));
  try {
    const bin = join(root, "bin"); mkdirSync(bin);
    const nodeStub = join(bin, "node");
    writeFileSync(nodeStub, `#!/bin/sh\nprintf '%s\\n' "$*" >> "$BEAT_LOG"\ncase "$*" in *' start') echo 'secret-token-start' >&2; exit 9;; *' fail '*) echo 'secret-token-completion' >&2; exit 9;; esac\nexit 0\n`);
    chmodSync(nodeStub, 0o755);
    const workload = join(root, "workload");
    writeFileSync(workload, "#!/bin/sh\nexit 23\n");
    chmodSync(workload, 0o755);
    const result = spawnSync("bash", [wrapper, "synthetic-job", "--", workload], {
      encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, BEAT_LOG: join(root, "beats") },
    });
    assert.equal(result.status, 23);
    assert.match(result.stderr, /WARNING: heartbeat start write failed; continuing workload/);
    assert.match(result.stderr, /WARNING: heartbeat completion write failed; workload exit status preserved/);
    assert.doesNotMatch(result.stderr, /secret-token/);
    assert.doesNotMatch(result.stdout, /\bok\b/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("with-heartbeat does not synthesize success when the workload fails", () => {
  const root = mkdtempSync(join(tmpdir(), "heartbeat-success-"));
  try {
    const bin = join(root, "bin"); mkdirSync(bin);
    const nodeStub = join(bin, "node");
    writeFileSync(nodeStub, "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$BEAT_LOG\"\nexit 0\n");
    chmodSync(nodeStub, 0o755);
    const workload = join(root, "workload"); writeFileSync(workload, "#!/bin/sh\nexit 7\n");
    chmodSync(workload, 0o755);
    const result = spawnSync("bash", [wrapper, "synthetic-job", "--", workload], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, BEAT_LOG: join(root, "beats") } });
    assert.equal(result.status, 7);
    assert.match(readFileSync(join(root, "beats"), "utf8"), /synthetic-job fail --detail exit 7/);
    assert.doesNotMatch(readFileSync(join(root, "beats"), "utf8"), /synthetic-job ok/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
