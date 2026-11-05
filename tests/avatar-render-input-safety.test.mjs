import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const text = readFileSync(new URL("../.github/workflows/avatar-render.yml", import.meta.url), "utf8");
function renderScript() {
  const lines = text.split(/\r?\n/);
  const step = lines.findIndex(line => line.trim() === "- name: Render");
  assert.notEqual(step, -1);
  let i = step + 1;
  while (i < lines.length && lines[i].trim() !== "run: |") i++;
  assert.ok(i < lines.length);
  const body = [];
  for (i++; i < lines.length; i++) {
    if (lines[i] && !lines[i].startsWith("          ")) break;
    body.push(lines[i].slice(10));
  }
  return body.join("\n");
}
const bash = process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\bash.exe" : "bash";
function runRender(env) {
  // Replace Python with a fake argv recorder. No rendering, cloud calls or real credentials.
  const fakePython = 'python() { printf "%s\\0" "$@"; }\n';
  return spawnSync(bash, ["-c", fakePython + renderScript()], {
    env: { ...process.env, AVATAR_SCRIPT: "ordinary", AVATAR_MODEL: "latentsync",
      AVATAR_BACKEND: "replicate", AVATAR_BASE_VIDEO: "", ...env },
    encoding: "utf8", timeout: 5000,
  });
}
test("workflow explicitly grants only checkout read permission", () => {
  assert.match(text, /^permissions:\s*\n\s+contents:\s+read\s*$/m);
});
test("each workflow environment input maps to its corresponding dispatch input", () => {
  for (const [envName, inputName] of [
    ["AVATAR_SCRIPT", "script"], ["AVATAR_MODEL", "model"],
    ["AVATAR_BACKEND", "backend"], ["AVATAR_BASE_VIDEO", "base_video"],
  ]) {
    assert.ok(text.includes("          " + envName + ": " + "$" + "{{ inputs." + inputName + " }}"),
      envName + " must receive its corresponding input");
  }
});
test("all existing model and backend choices remain accepted", () => {
  for (const model of ["latentsync", "musetalk", "sadtalker"]) {
    for (const backend of ["azure", "replicate", "modal", "fal"]) {
      const r = runRender({ AVATAR_MODEL: model, AVATAR_BACKEND: backend });
      assert.equal(r.status, 0, model + "/" + backend + ": " + r.stderr);
    }
  }
});
test("shell metacharacters remain literal input arguments", () => {
  const tick = String.fromCharCode(96);
  const payload = 'some text"; printf INJECTED >&2; # $(printf NOT_EXECUTED) ' + tick + 'printf NO' + tick;
  const video = 'sample"; printf INJECTED >&2; #';
  const r = runRender({ AVATAR_SCRIPT: payload, AVATAR_BASE_VIDEO: video });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, "");
  assert.deepEqual(r.stdout.split("\0").slice(0, -1), [
    "orchestrate.py", "--script", payload, "--model", "latentsync",
    "--backend", "replicate", "--base-video", video,
  ]);
});
test("empty optional video is omitted and modal remains supported", () => {
  const r = runRender({ AVATAR_BACKEND: "modal" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.split("\0").slice(0, -1), [
    "orchestrate.py", "--script", "ordinary", "--model", "latentsync", "--backend", "modal",
  ]);
});
test("unsupported model and backend are rejected before invoking Python", () => {
  for (const env of [{ AVATAR_MODEL: 'latentsync;echo bad' }, { AVATAR_BACKEND: 'fal;echo bad' }]) {
    const r = runRender(env);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /Unsupported (model|backend)/);
    assert.equal(r.stdout, "");
  }
});
