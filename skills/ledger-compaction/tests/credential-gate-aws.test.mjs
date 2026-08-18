// The ledger-compaction credential gate must accept the AWS path.
//
// WHY THIS EXISTS (2026-08-18): the job's entry gate tested only `resolveSaJson()` (the retired GCP
// SA) and `AZURE_SP_*` (dead since Azure authorization stopped at ~00:55Z that day), then returned.
// It printed "Fail-open: exiting 0, nothing compacted this run." on every single run while the ECS
// task role sat there holding ssm:GetParameter on /otchealth/* -- exactly what kvSecret()'s SSM
// fallback needs.
//
// This was PROVEN, not theorised: on a freshly rebuilt image (ECR digest c62680f5, pushed
// 2026-08-18T19:49:32Z) the job was run as ECS task 9306de30f4e64556b6ff3a0ebf484296 and its
// CloudWatch log still showed the fail-open line. Rebuilding the image changed nothing because the
// defect was an outer gate, not stale code -- the same shape PR #453 fixed in session-start.sh and
// session-connect.sh.
//
// The behavioural test below is the one that matters. A source-shape assertion alone would pass
// against a gate that imports awsCredsPresent and then ignores it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER = join(HERE, "..", "job", "run-compaction.mjs");
const FAIL_OPEN = /no credentials on ANY path|Fail-open: exiting 0/;

/** Run the job with a controlled credential environment. Always --dry-run so it can never write. */
function runWith(extraEnv) {
  const env = { ...process.env };
  // Strip every credential the harness might have inherited, so the test controls the whole matrix.
  for (const k of [
    "GCP_CLAUDE_DRIVER_SA_JSON", "GCP_CLAUDE_DRIVER_SA_JSON_B64",
    "AZURE_SP_CLIENT_ID", "AZURE_SP_CLIENT_SECRET", "AZURE_SP_TENANT_ID",
    "IDENTITY_ENDPOINT", "IDENTITY_HEADER",
    "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", "AWS_CONTAINER_CREDENTIALS_FULL_URI",
    "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN",
    "OTC_AWS_ACCESS_KEY_ID", "OTC_AWS_SECRET_ACCESS_KEY",
  ]) delete env[k];
  Object.assign(env, extraEnv);
  // HOME is redirected so a stray SA file on the runner's real home cannot satisfy resolveSaJson().
  env.HOME = "/nonexistent-ledger-compaction-test-home";
  return spawnSync(process.execPath, [RUNNER, "--dry-run", "--agents", "zzz-nonexistent-test-agent"], {
    encoding: "utf8", env, timeout: 120_000,
  });
}

test("with NO credential on any path, the gate still fails open and says so (unchanged behaviour)", () => {
  const r = runWith({});
  assert.match(r.stderr, FAIL_OPEN, "with genuinely nothing available it must still short-circuit and say why");
  assert.match(r.stderr, /no AWS credential/i, "the message must now name AWS too, not only the two dead paths");
});

test("an AWS credential is ENOUGH to get past the gate (the actual fix)", () => {
  // Deliberately fake values: they cannot authenticate to SSM, and that is the point. The assertion
  // is about the GATE, which must no longer short-circuit before the resolver is ever consulted.
  // Whatever happens after this line is the resolver's business, not the gate's.
  const r = runWith({ OTC_AWS_ACCESS_KEY_ID: "AKIAFAKEFAKEFAKEFAKE", OTC_AWS_SECRET_ACCESS_KEY: "fake-secret-not-a-real-credential" });
  assert.doesNotMatch(r.stderr, FAIL_OPEN,
    "a present AWS credential must NOT be reported as 'no credentials'; that was the whole defect");
});

test("an ECS task role (container credentials endpoint) is also enough", () => {
  // This is the shape that actually applies in production: the Fargate task carries no env keys at
  // all, only AWS_CONTAINER_CREDENTIALS_RELATIVE_URI, and otchealthTaskRole grants ssm:GetParameter
  // on /otchealth/*. The old gate could not see this credential at all.
  const r = runWith({ AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/v2/credentials/fake-test-uuid" });
  assert.doesNotMatch(r.stderr, FAIL_OPEN, "the ECS task-role path must satisfy the gate");
});

test("the sandbox proxy's placeholder AWS key does NOT count as a credential", () => {
  // aws-secret.mjs's awsCredsPresent() rejects a key beginning with 'prox' because this sandbox's
  // egress proxy injects a non-functional placeholder into AWS_ACCESS_KEY_ID. Treating that as real
  // would trade a silent no-op for a slower, more confusing failure further down.
  const r = runWith({ AWS_ACCESS_KEY_ID: "proxy-placeholder-not-real", AWS_SECRET_ACCESS_KEY: "x" });
  assert.match(r.stderr, FAIL_OPEN, "a placeholder key must be treated as absent");
});

test("the gate consults awsCredsPresent() rather than re-implementing the check", () => {
  const src = readFileSync(join(HERE, "..", "job", "run-compaction.mjs"), "utf8");
  assert.match(src, /import \{ awsCredsPresent \} from "\.\.\/\.\.\/kb-memory\/aws-secret\.mjs"/,
    "must reuse the single shared definition of 'is there an AWS credential'");
  assert.match(src, /if \(!raw && !azureOk && !aws\.any\)/, "all three paths must be in the same condition");
  assert.doesNotMatch(src, /if \(!raw && !azureOk\) \{/,
    "the old two-dead-paths-only gate must be gone, not merely supplemented");
});
