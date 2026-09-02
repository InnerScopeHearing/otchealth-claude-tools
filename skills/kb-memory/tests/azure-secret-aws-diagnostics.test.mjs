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
  // maxRetries: the subprocess under test probes the az CLI, which async-writes ~/.azure inside this
  // temp HOME; on a slow CI disk that write can race a plain recursive rm into ENOTEMPTY (seen live
  // on PR #473's gate run). retryDelay+maxRetries lets the in-flight write settle instead of failing
  // the TEST for a teardown artifact.
  try { return await run(dir); } finally { process.env.HOME = savedHome; await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
}

// ASSERTION UPDATED 2026-09-02, and deliberately not merely to get green: the claim it pinned became
// FALSE. Under the ssm default kvSecret() no longer consults Key Vault at all, so SSM is not a
// "fallback" any more, it is the sole store. A message still calling it a fallback would point the
// reader at a nonexistent Azure auth problem, the exact defect that change removed. The old wording
// stays pinned where it is still true, by the keyvault-backend test added directly below.
test("kvSecretOrThrow(): under the ssm default, names SSM as the SOLE store and what to set", async () => {
  const { kvSecretOrThrow } = await import("../azure-secret.mjs");
  await withTempHome(() => withEnv(NO_CREDS_ENV, async () => {
    await assert.rejects(
      () => kvSecretOrThrow("some-secret-that-does-not-matter"),
      (e) => {
        assert.match(e.message, /AWS SSM/i, "must name the store actually consulted");
        assert.match(e.message, /sole secret store/i, "must say SSM is the only store, not a fallback behind Key Vault");
        assert.match(e.message, /not an Azure auth problem/i, "must actively steer the reader off the dead Azure ladder");
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

// The companion to the updated assertion above: the Key-Vault-plus-SSM-fallback wording is still
// CORRECT under the explicit opt-in backend, so it stays pinned there rather than being deleted.
test("kvSecretOrThrow(): under the explicit keyvault backend, the original Key-Vault-plus-SSM-fallback wording is intact", async () => {
  const { kvSecretOrThrow } = await import("../azure-secret.mjs");
  await withTempHome(() => withEnv({ ...NO_CREDS_ENV, SECRET_BACKEND: "keyvault" }, async () => {
    await assert.rejects(
      () => kvSecretOrThrow("some-secret-that-does-not-matter"),
      (e) => {
        assert.match(e.message, /Key Vault/i, "the opt-in path must still describe Key Vault");
        assert.match(e.message, /SSM fallback/i, "the opt-in path must still mention the SSM cross-fallback");
        return true;
      },
    );
  }));
});

// requireSecrets() calls process.exit(78) directly, so it can only be exercised as a real subprocess.
//
// ASSERTIONS UPDATED 2026-09-02 for the same reason as the kvSecretOrThrow test above: under the ssm
// default the banner's old claim that "all four auth paths (Azure identity/SP/az-CLI, then AWS SSM)
// were tried per secret" is FALSE -- only SSM is consulted. Pinning a false banner would be worse
// than pinning nothing, since the banner exists to point an operator at the real cause. The
// four-paths wording stays pinned under SECRET_BACKEND=keyvault by the counterfactual below.
test("requireSecrets(): FATAL banner (subprocess, real exit code) names SSM as the sole store under the default backend", async () => {
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
  assert.match(stderr, /UNAVAILABLE from AWS SSM Parameter Store/, "the banner must name SSM as the store that failed");
  assert.match(stderr, /OTC_AWS_ACCESS_KEY_ID \+/, "the banner must name the specific fix");
  assert.match(stderr, /is NOT a fallback/, "must tell the operator Key Vault is not in the picture at all");
  assert.doesNotMatch(stderr, /four auth paths/, "must not claim four auth paths were tried when only SSM was consulted");
});

test("requireSecrets(): FATAL banner under SECRET_BACKEND=keyvault still describes the full four-path ladder", async () => {
  const script = `
    import { requireSecrets } from ${JSON.stringify(join(HERE, "..", "azure-secret.mjs"))};
    await requireSecrets(["some-secret-that-does-not-matter"]);
  `;
  let stderr = "", status = 0;
  try {
    execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      env: { ...process.env, ...Object.fromEntries(Object.keys(NO_CREDS_ENV).map((k) => [k, ""])), SECRET_BACKEND: "keyvault" },
      timeout: 20_000,
    });
  } catch (e) {
    stderr = String(e.stderr || "");
    status = e.status;
  }
  assert.equal(status, 78, "must still exit EX_CONFIG (78)");
  assert.match(stderr, /AWS \(SSM fallback, \/otchealth\/\* mirror\)/, "the banner must keep its dedicated AWS/SSM state line on this path");
  assert.match(stderr, /four auth paths/, "the opt-in ladder genuinely does try four paths, and must still say so");
});
