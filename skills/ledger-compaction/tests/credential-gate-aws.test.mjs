// The ledger-compaction job's entry gate: is there an AWS credential at all.
//
// HISTORY (2026-08-18): the gate originally tested only `resolveSaJson()` (the retired GCP SA) and
// `AZURE_SP_*` (dead since Azure authorization stopped at ~00:55Z that day), then returned. It
// printed "Fail-open: exiting 0, nothing compacted this run." on every single run while the ECS task
// role sat there holding ssm:GetParameter on /otchealth/* -- exactly what this job needed. Proven,
// not theorised: on a freshly rebuilt image the job still printed the fail-open line as ECS task
// 9306de30f4e64556b6ff3a0ebf484296, because the defect was an outer gate, not stale code.
//
// SIMPLIFIED (2026-09-03): the job's actual storage calls have since been ported off Azure Blob
// entirely (see job/run-compaction.mjs's own header) -- there is no longer a GCP SA path or an Azure
// SP path to test at all, because neither credential is read anywhere in the file any more. The gate
// is now a single condition: is there an AWS credential on any path. This file tests that condition
// directly rather than the historical three-way branch it replaced.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER = join(HERE, "..", "job", "run-compaction.mjs");
const FAIL_OPEN = /no AWS credential on any path|Fail-open: exiting 0/;

/** Run the job with a controlled credential environment. --dry-run + a nonexistent agent name so
 *  the loop body (and any real S3 call) never executes -- this file tests ONLY the entry gate, not
 *  the storage calls (see s3-persistence.test.mjs for those). */
function runWith(extraEnv) {
  const env = { ...process.env };
  for (const k of [
    "GCP_CLAUDE_DRIVER_SA_JSON", "GCP_CLAUDE_DRIVER_SA_JSON_B64",
    "AZURE_SP_CLIENT_ID", "AZURE_SP_CLIENT_SECRET", "AZURE_SP_TENANT_ID",
    "IDENTITY_ENDPOINT", "IDENTITY_HEADER",
    "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", "AWS_CONTAINER_CREDENTIALS_FULL_URI",
    "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN",
    "OTC_AWS_ACCESS_KEY_ID", "OTC_AWS_SECRET_ACCESS_KEY",
  ]) delete env[k];
  Object.assign(env, extraEnv);
  env.HOME = "/nonexistent-ledger-compaction-test-home";
  return spawnSync(process.execPath, [RUNNER, "--dry-run", "--agents", "zzz-nonexistent-test-agent"], {
    encoding: "utf8", env, timeout: 120_000,
  });
}

test("with NO AWS credential on any path, the gate fails open and says so", () => {
  const r = runWith({});
  assert.equal(r.status, 0, "a genuine 'nothing available' condition must still exit 0, not fail the job");
  assert.match(r.stderr, FAIL_OPEN);
  assert.match(r.stderr, /no AWS credential/i);
});

test("an AWS credential is enough to get past the gate", () => {
  // Deliberately fake values: they cannot authenticate to SSM/S3, and that is the point. The
  // assertion is about the GATE, which must not short-circuit before any resolver is consulted.
  // The chosen agent name is not in AGENTS, so the loop body never runs and no network call happens
  // either way -- this test is purely about whether the gate itself lets execution past it.
  const r = runWith({ OTC_AWS_ACCESS_KEY_ID: "AKIAFAKEFAKEFAKEFAKE", OTC_AWS_SECRET_ACCESS_KEY: "fake-secret-not-a-real-credential" });
  assert.equal(r.status, 0);
  assert.doesNotMatch(r.stderr, FAIL_OPEN, "a present AWS credential must not be reported as 'no credentials'");
});

test("an ECS task role (container credentials endpoint) is also enough", () => {
  // The shape that actually applies in production: the Fargate task carries no env keys at all,
  // only AWS_CONTAINER_CREDENTIALS_RELATIVE_URI, and otchealthTaskRole grants ssm:GetParameter +
  // s3:GetObject/PutObject on the two mapped buckets.
  const r = runWith({ AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/v2/credentials/fake-test-uuid" });
  assert.equal(r.status, 0);
  assert.doesNotMatch(r.stderr, FAIL_OPEN, "the ECS task-role path must satisfy the gate");
});

test("the sandbox proxy's placeholder AWS key does NOT count as a credential", () => {
  // aws-secret.mjs's awsCredsPresent() rejects a key beginning with 'prox' because this sandbox's
  // egress proxy injects a non-functional placeholder into AWS_ACCESS_KEY_ID. Treating that as real
  // would trade a silent no-op for a slower, more confusing failure further down.
  const r = runWith({ AWS_ACCESS_KEY_ID: "proxy-placeholder-not-real", AWS_SECRET_ACCESS_KEY: "x" });
  assert.equal(r.status, 0);
  assert.match(r.stderr, FAIL_OPEN, "a placeholder key must be treated as absent");
});

test("the gate consults awsCredsPresent() rather than re-implementing the check, and no Azure/GCP branch remains", () => {
  const src = readFileSync(RUNNER, "utf8");
  assert.match(src, /import \{ awsCredsPresent \} from "\.\.\/\.\.\/kb-memory\/aws-secret\.mjs"/,
    "must reuse the single shared definition of 'is there an AWS credential'");
  assert.match(src, /if \(!aws\.any\)/, "the gate is now a single AWS-only condition");
  assert.doesNotMatch(src, /!raw && !azureOk/, "the old three-way (GCP SA / Azure SP / AWS) gate must be gone, not merely supplemented");
  assert.doesNotMatch(src, /resolveSaJson|azureOk/, "no dead-credential-path plumbing should remain in a file that only ever uses AWS now");
});
