// Regression tests for setup/select-agent-auth.sh (Phase 6 AI-OS: the bounded AWS Bedrock
// overflow lane for Tier-2 autonomous Claude Code runners, .github/workflows/autonomous-run.yml
// and overnight-agent.yml). Guards three invariants:
//   1. CLAUDE_CODE_OAUTH_TOKEN always wins when present, even if the Bedrock opt-in and AWS
//      credentials are ALSO present -- no regression to the existing subscription-only path.
//   2. The Bedrock branch only ever fires with BOTH the explicit opt-in AND real AWS credentials
//      present at once; opt-in alone or credentials alone must both still fail.
//   3. With no usable auth path, the script fails loudly (non-zero exit, a ::error:: annotation)
//      instead of silently falling through to `claude -p` with no credentials at all.
import { test } from "node:test";
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "setup/select-agent-auth.sh");
// A deliberately minimal env for every case below: only PATH is forwarded from the test runner,
// so a stray CLAUDE_CODE_OAUTH_TOKEN / AWS_* / ALLOW_BEDROCK_OVERFLOW already present in this
// process's own environment can never leak into a test and produce a false pass.
const BASE_ENV = { PATH: process.env.PATH ?? "/usr/bin:/bin" };

// Sources the script inside a fresh bash -c process with the given env, then prints the
// resulting CLAUDE_CODE_USE_BEDROCK / ANTHROPIC_API_KEY state of that SAME shell, so the
// assertions cover the real export/unset side effects (what a workflow step actually observes),
// not just the script's own stdout line.
function runSourced(env) {
  const script =
    'source "' +
    SCRIPT +
    '"; ' +
    'printf "BEDROCK=%s\\n" "${CLAUDE_CODE_USE_BEDROCK:-unset}"; ' +
    'printf "APIKEY=%s\\n" "${ANTHROPIC_API_KEY:-unset}";';
  const r = spawnSync("bash", ["-c", script], { env, encoding: "utf8" });
  const bedrock = /BEDROCK=(\S+)/.exec(r.stdout || "")?.[1] ?? null;
  const apiKey = /APIKEY=(\S+)/.exec(r.stdout || "")?.[1] ?? null;
  return { status: r.status, stdout: r.stdout || "", stderr: r.stderr || "", bedrock, apiKey };
}

// Executes (not sources) the script directly, the standalone/testing mode called out in its own
// header comment. No env side effects are observable this way (they only affect the subprocess),
// so this is used only to check stdout/stderr/exit-code behavior.
function runExecuted(env) {
  const r = spawnSync("bash", [SCRIPT], { env, encoding: "utf8" });
  return { status: r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
}

test("setup/select-agent-auth.sh exists", () => {
  assert.ok(existsSync(SCRIPT), "setup/select-agent-auth.sh should exist");
});

test("branch (a): CLAUDE_CODE_OAUTH_TOKEN alone selects oauth, unsets ANTHROPIC_API_KEY, never touches Bedrock", () => {
  const r = runSourced({ ...BASE_ENV, CLAUDE_CODE_OAUTH_TOKEN: "tok", ANTHROPIC_API_KEY: "leaked" });
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /AGENT_AUTH_MODE=oauth/);
  assert.strictEqual(r.bedrock, "unset", "CLAUDE_CODE_USE_BEDROCK must not be set on the oauth path");
  assert.strictEqual(r.apiKey, "unset", "ANTHROPIC_API_KEY must be unset so the OAuth token is used");
});

test("branch (a) HARD CONSTRAINT: OAuth wins even when the Bedrock opt-in AND AWS credentials are also present", () => {
  const r = runSourced({
    ...BASE_ENV,
    CLAUDE_CODE_OAUTH_TOKEN: "tok",
    ALLOW_BEDROCK_OVERFLOW: "true",
    AWS_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
    AWS_SECRET_ACCESS_KEY: "secret",
  });
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /AGENT_AUTH_MODE=oauth/);
  assert.strictEqual(r.bedrock, "unset", "Bedrock must never activate while an OAuth token is present, opt-in notwithstanding");
});

test("branch (b): opt-in + AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY selects the Bedrock overflow lane", () => {
  const r = runSourced({
    ...BASE_ENV,
    ALLOW_BEDROCK_OVERFLOW: "true",
    AWS_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
    AWS_SECRET_ACCESS_KEY: "secret",
    ANTHROPIC_API_KEY: "leaked",
  });
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /AGENT_AUTH_MODE=bedrock-overflow/);
  assert.strictEqual(r.bedrock, "1", "CLAUDE_CODE_USE_BEDROCK should be exported as 1");
  assert.strictEqual(r.apiKey, "unset");
});

test("branch (b): opt-in + AWS_PROFILE alone also selects the Bedrock overflow lane", () => {
  const r = runSourced({ ...BASE_ENV, ALLOW_BEDROCK_OVERFLOW: "1", AWS_PROFILE: "myprofile" });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.bedrock, "1");
});

test("branch (b): opt-in + AWS_BEARER_TOKEN_BEDROCK alone also selects the Bedrock overflow lane", () => {
  const r = runSourced({ ...BASE_ENV, ALLOW_BEDROCK_OVERFLOW: "true", AWS_BEARER_TOKEN_BEDROCK: "bedrock-key" });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.bedrock, "1");
});

test("branch (c): opt-in alone with no AWS credentials at all still fails (opt-in is not a credential)", () => {
  const r = runSourced({ ...BASE_ENV, ALLOW_BEDROCK_OVERFLOW: "true" });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /::error::/);
  assert.strictEqual(r.bedrock, null, "the probe never runs because the sourced script exits the shell");
});

test("branch (c): AWS credentials alone with no opt-in still fails (Bedrock is never a silent default)", () => {
  const r = runSourced({ ...BASE_ENV, AWS_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE", AWS_SECRET_ACCESS_KEY: "secret" });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /::error::/);
});

test("branch (c): ALLOW_BEDROCK_OVERFLOW=false with AWS credentials present still fails", () => {
  const r = runSourced({
    ...BASE_ENV,
    ALLOW_BEDROCK_OVERFLOW: "false",
    AWS_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
    AWS_SECRET_ACCESS_KEY: "secret",
  });
  assert.strictEqual(r.status, 1);
});

test("branch (c): nothing set at all fails loudly with a clear, non-em-dash message naming both remedies", () => {
  const r = runSourced(BASE_ENV);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /::error::/);
  assert.match(r.stderr, /CLAUDE_CODE_OAUTH_TOKEN/);
  assert.match(r.stderr, /ALLOW_BEDROCK_OVERFLOW/);
  assert.doesNotMatch(r.stderr, /[–—]/, "error text must not contain an em dash or en dash");
});

test("GITHUB_ENV propagation: the Bedrock branch appends CLAUDE_CODE_USE_BEDROCK=1 for the next step", () => {
  const dir = mkdtempSync(join(tmpdir(), "gha-env-"));
  const ghEnvFile = join(dir, "github_env");
  // GITHUB_ENV must point at a real, pre-existing file the runner appends to (as Actions itself
  // guarantees); create an empty one to mirror that.
  spawnSync("bash", ["-c", `: > "${ghEnvFile}"`]);
  const r = runSourced({
    ...BASE_ENV,
    ALLOW_BEDROCK_OVERFLOW: "true",
    AWS_BEARER_TOKEN_BEDROCK: "bedrock-key",
    GITHUB_ENV: ghEnvFile,
  });
  assert.strictEqual(r.status, 0);
  const contents = readFileSync(ghEnvFile, "utf8");
  assert.match(contents, /^CLAUDE_CODE_USE_BEDROCK=1$/m);
});

test("GITHUB_ENV is untouched on the oauth path (no Bedrock flag leaks into later steps)", () => {
  const dir = mkdtempSync(join(tmpdir(), "gha-env-"));
  const ghEnvFile = join(dir, "github_env");
  spawnSync("bash", ["-c", `: > "${ghEnvFile}"`]);
  runSourced({ ...BASE_ENV, CLAUDE_CODE_OAUTH_TOKEN: "tok", GITHUB_ENV: ghEnvFile });
  const contents = readFileSync(ghEnvFile, "utf8");
  assert.strictEqual(contents.trim(), "", "GITHUB_ENV must stay empty when the oauth branch is chosen");
});

test("direct execution (not sourced) mirrors the same decision and exit codes", () => {
  const ok = runExecuted({ ...BASE_ENV, CLAUDE_CODE_OAUTH_TOKEN: "tok" });
  assert.strictEqual(ok.status, 0);
  assert.match(ok.stdout, /AGENT_AUTH_MODE=oauth/);

  const fail = runExecuted(BASE_ENV);
  assert.strictEqual(fail.status, 1);
  assert.match(fail.stderr, /::error::/);
});

// Regression: a non-empty AWS_ACCESS_KEY_ID is not evidence of usable AWS auth.
// The Claude Code cloud sandbox injects an agent-proxy placeholder ("prox...",
// lowercase, 14 chars) into AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY. Presence
// alone previously selected bedrock-overflow, so every Bedrock call would fail
// with InvalidClientTokenId while this selector reported it had found working
// auth. Real key ids are uppercase alphanumeric and at least 16 chars.
test("opt-in + the agent-proxy AWS placeholder does NOT select the Bedrock lane", () => {
  const r = runSourced({
    ...BASE_ENV,
    ALLOW_BEDROCK_OVERFLOW: "true",
    AWS_ACCESS_KEY_ID: "proxy-key-abc",
    AWS_SECRET_ACCESS_KEY: "proxy-secret",
  });
  assert.strictEqual(r.status, 1, "placeholder credentials must not count as usable AWS auth");
  assert.doesNotMatch(r.stdout, /bedrock-overflow/);
});

test("opt-in + a real-shaped AWS key id still selects the Bedrock lane", () => {
  const r = runSourced({
    ...BASE_ENV,
    ALLOW_BEDROCK_OVERFLOW: "true",
    AWS_ACCESS_KEY_ID: "ASIAIOSFODNN7EXAMPLE",
    AWS_SECRET_ACCESS_KEY: "secret",
  });
  assert.strictEqual(r.status, 0, "STS-style ASIA keys must remain acceptable");
  assert.match(r.stdout, /bedrock-overflow/);
});
