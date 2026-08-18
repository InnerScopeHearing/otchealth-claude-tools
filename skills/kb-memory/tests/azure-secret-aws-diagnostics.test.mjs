// Tests for azure-secret.mjs's AWS/SSM-aware diagnostics (2026-08-18, the agent-seat credential
// bootstrap fix). Before this, requireSecrets()'s FATAL banner and kvSecretOrThrow()'s error only ever
// reported the THREE Azure auth paths -- even though kvSecret() had already, silently, ALSO tried the
// AWS SSM fallback and failed there too by the time either of these fires. A reader saw "Azure paths
// failed" and had no way to know a fourth path (AWS) was ever a factor, let alone what env var to set
// to fix it. These pin that both diagnostics now name the AWS/SSM state explicitly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const NO_CREDS_ENV = {
  AZURE_SP_CLIENT_ID: undefined, AZURE_SP_CLIENT_SECRET: undefined, AZURE_SP_TENANT_ID: undefined,
  IDENTITY_ENDPOINT: undefined, IDENTITY_HEADER: undefined,
  AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: undefined, AWS_CONTAINER_CREDENTIALS_FULL_URI: undefined,
  AWS_ACCESS_KEY_ID: undefined, AWS_SECRET_ACCESS_KEY: undefined, AWS_SESSION_TOKEN: undefined,
  OTC_AWS_ACCESS_KEY_ID: undefined, OTC_AWS_SECRET_ACCESS_KEY: undefined, OTC_AWS_SESSION_TOKEN: undefined,
  GCP_CLAUDE_DRIVER_SA_JSON: undefined,
};
async function withEnv(vars, run) {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  try { return await run(); } finally { for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
}
async function withTempHome(run) {
  const dir = await mkdtemp(join(tmpdir(), "azsec-diag-test-"));
  const savedHome = process.env.HOME;
  process.env.HOME = dir;
  try { return await run(dir); } finally { process.env.HOME = savedHome; await rm(dir, { recursive: true, force: true }); }
}

test("kvSecretOrThrow(): with no credentials at all, names that AWS was tried too and what to set", async () => {
  const { kvSecretOrThrow } = await import("../azure-secret.mjs");
  await withTempHome(() => withEnv(NO_CREDS_ENV, async () => {
    await assert.rejects(
      () => kvSecretOrThrow("some-secret-that-does-not-matter"),
      (e) => {
        assert.match(e.message, /SSM fallback/i, "must mention the SSM fallback was tried, not just Key Vault");
        assert.match(e.message, /OTC_AWS_ACCESS_KEY_ID \+ OTC_AWS_SECRET_ACCESS_KEY/, "must name the specific fix");
        return true;
      },
    );
  }));
});

test("kvSecretOrThrow(): with AWS creds present but the secret genuinely missing, does not wrongly claim 'set OTC_AWS_*' (it is already set)", async () => {
  const { kvSecretOrThrow } = await import("../azure-secret.mjs");
  await withTempHome(() => withEnv({ ...NO_CREDS_ENV, OTC_AWS_ACCESS_KEY_ID: "AKIAFAKE", OTC_AWS_SECRET_ACCESS_KEY: "fakefake" }, async () => {
    await assert.rejects(
      () => kvSecretOrThrow("some-secret-that-genuinely-does-not-exist-xyz"),
      (e) => {
        assert.match(e.message, /AWS creds resolvable: yes/, "must acknowledge AWS creds ARE present, not repeat the 'go set them' advice");
        assert.doesNotMatch(e.message, /set OTC_AWS_ACCESS_KEY_ID/, "must not tell an operator to set a credential that is already set");
        return true;
      },
    );
  }));
});

// requireSecrets() calls process.exit(78) directly, so it can only be exercised as a real subprocess.
test("requireSecrets(): FATAL banner (subprocess, real exit code) reports AWS/SSM state, not just the three Azure paths", async () => {
  const script = `
    import { requireSecrets } from ${JSON.stringify(join(HERE, "..", "azure-secret.mjs"))};
    await requireSecrets(["some-secret-that-does-not-matter"]);
  `;
  let stderr = "", status = 0;
  try {
    execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      env: { ...process.env, ...Object.fromEntries(Object.keys(NO_CREDS_ENV).map((k) => [k, ""])) },
      timeout: 15_000,
    });
  } catch (e) {
    stderr = String(e.stderr || "");
    status = e.status;
  }
  assert.equal(status, 78, "requireSecrets() must still exit EX_CONFIG (78) on a total miss");
  assert.match(stderr, /AWS \(SSM fallback, \/otchealth\/\* mirror\)/, "the banner must have a dedicated AWS/SSM state line");
  assert.match(stderr, /OTC_AWS_ACCESS_KEY_ID \+/, "the banner must name the specific fix");
  assert.match(stderr, /four auth paths/, "must describe FOUR paths now (three Azure + SSM), not just three");
});
