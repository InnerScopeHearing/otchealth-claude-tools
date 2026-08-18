// setup/fetch-secrets-aws.mjs is the hydration path session-start.sh was missing entirely: every
// agent session was starting with an empty ~/.designer/credentials.env because the only hydrator
// read a retired Azure subscription.
//
// Its output contract matters more than its internals. session-start.sh folds whatever this prints
// into credentials.env with a shell parser and then `set -a` sources that file into every shell in
// the session. A malformed line there does not fail loudly; it corrupts the environment of
// everything downstream. So these tests pin the format, the quoting, and, above all, the failure
// modes -- an unreachable store must never look like an empty one.
//
// Network is stubbed via --import, per skills/kb-memory/tests/index-one-dispatch.test.mjs. Nothing
// here reaches a real parameter store.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { MAP } from "../setup/secret-map.mjs";

const execFileP = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "setup", "fetch-secrets-aws.mjs");
const REGION = "us-east-1";
const SSM_HOST = `ssm.${REGION}.amazonaws.com`;

/**
 * @param opts.listed      parameter ids GetParametersByPath reports, or null to make listing fail
 * @param opts.values      { id: value } served by GetParameter (absent id => ParameterNotFound)
 * @param opts.listStatus  HTTP status for the enumeration call
 */
function preloadSource(logPath, { listed = [], values = {}, listStatus = 200 } = {}) {
  return `
import { appendFileSync } from "node:fs";
function isHost(u, host) { try { return new URL(u).host === host; } catch { return false; } }
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const LISTED = ${JSON.stringify(listed)};
const VALUES = ${JSON.stringify(values)};
globalThis.fetch = async (url, init) => {
  const u = String(typeof url === "string" ? url : (url && url.url) || url);
  if (!isHost(u, ${JSON.stringify(SSM_HOST)})) throw new Error("TEST-FAIL: unexpected host " + u);
  const target = String((init && init.headers && init.headers["x-amz-target"]) || "");
  const body = JSON.parse((init && init.body) || "{}");
  appendFileSync(${JSON.stringify(logPath)}, target + " " + (body.Name || body.Path || "") + "\\n");

  if (target.endsWith("GetParametersByPath")) {
    const st = ${JSON.stringify(listStatus)};
    if (st !== 200) return json(st, { __type: "AccessDeniedException" });
    // Honour MaxResults/NextToken so pagination is genuinely exercised, not bypassed.
    const start = body.NextToken ? Number(body.NextToken) : 0;
    const size = body.MaxResults || 10;
    const page = LISTED.slice(start, start + size);
    const next = start + size < LISTED.length ? String(start + size) : undefined;
    return json(200, {
      Parameters: page.map((id) => ({ Name: "/otchealth/" + id, LastModifiedDate: 1755000000 })),
      ...(next ? { NextToken: next } : {}),
    });
  }
  if (target.endsWith("GetParameter")) {
    const id = String(body.Name || "").replace(/^\\/otchealth\\//, "");
    if (!(id in VALUES)) return json(400, { __type: "ParameterNotFound" });
    return json(200, { Parameter: { Name: body.Name, Value: VALUES[id], Type: "SecureString" } });
  }
  throw new Error("TEST-FAIL: unexpected SSM target " + target);
};
`;
}

async function run(opts = {}, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), "fetch-aws-"));
  const logPath = join(dir, "calls.log");
  writeFileSync(logPath, "");
  const preloadPath = join(dir, "preload.mjs");
  writeFileSync(preloadPath, preloadSource(logPath, opts));

  const childEnv = {
    PATH: process.env.PATH,
    HOME: dir,
    NODE_OPTIONS: `--import ${preloadPath}`,
    AWS_REGION: REGION,
    AWS_SSM_PREFIX: "/otchealth",
    // aws-secret.mjs rejects a key beginning "prox" (the sandbox proxy placeholder the ambient
    // environment sets), so a real-shaped test key is required for SSM to be attempted at all.
    AWS_ACCESS_KEY_ID: "AKIAUNITTESTONLY0000",
    AWS_SECRET_ACCESS_KEY: "unit-test-secret-not-a-real-credential",
    ...env,
  };
  delete childEnv.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI;
  delete childEnv.AWS_CONTAINER_CREDENTIALS_FULL_URI;
  delete childEnv.AWS_SESSION_TOKEN;

  let stdout = "", stderr = "", code = 0;
  try {
    const r = await execFileP(process.execPath, [SCRIPT], { env: childEnv, timeout: 60_000 });
    stdout = r.stdout; stderr = r.stderr;
  } catch (e) {
    stdout = e.stdout || ""; stderr = e.stderr || ""; code = e.code ?? 1;
  }
  return { stdout, stderr, code, calls: readFileSync(logPath, "utf8").split("\n").filter(Boolean) };
}

const REQUIRED = MAP.filter((m) => m.required).map((m) => m.id);

test("emits KEY='value' lines only, for the secrets that exist", async () => {
  const { stdout, code } = await run({
    listed: ["openai-api-key", "elevenlabs-api-key", "depot-token"],
    values: { "openai-api-key": "sk-test", "elevenlabs-api-key": "el-test", "depot-token": "dp-test" },
  });
  assert.equal(code, 0);
  const lines = stdout.split("\n").filter(Boolean);
  assert.deepEqual(lines.sort(), [
    "DEPOT_TOKEN='dp-test'",
    "ELEVENLABS_API_KEY='el-test'",
    "OPENAI_API_KEY='sk-test'",
  ].sort());
  for (const l of lines) {
    assert.match(l, /^[A-Z][A-Z0-9_]*='.*'$/, `line is not shell-safe for \`set -a\` sourcing: ${l}`);
  }
});

test("a value containing a single quote cannot break out of the shell literal", async () => {
  // credentials.env is sourced by the shell. A naive `NAME='value'` with an embedded quote would
  // terminate the literal early and turn the rest of the secret into shell words.
  const { stdout } = await run({
    listed: ["openai-api-key", "elevenlabs-api-key"],
    values: { "openai-api-key": "has'quote", "elevenlabs-api-key": "el" },
  });
  const line = stdout.split("\n").find((l) => l.startsWith("OPENAI_API_KEY="));
  assert.equal(line, "OPENAI_API_KEY='has'\\''quote'");
  // Prove the shell actually reads back the original bytes.
  const { stdout: echoed } = await execFileP("bash", ["-c", `${line}; printf '%s' "$OPENAI_API_KEY"`]);
  assert.equal(echoed, "has'quote", "the round-tripped value must be byte-identical");
});

test("diagnostics go to stderr, never stdout (stdout is parsed)", async () => {
  const { stdout, stderr } = await run({
    listed: ["openai-api-key", "elevenlabs-api-key"],
    values: { "openai-api-key": "sk", "elevenlabs-api-key": "el" },
  });
  for (const l of stdout.split("\n").filter(Boolean)) {
    assert.match(l, /^[A-Z][A-Z0-9_]*=/, `non-assignment text leaked into stdout: ${l}`);
  }
  assert.match(stderr, /hydrated/, "a human-readable summary belongs on stderr");
});

test("exits 2 when a REQUIRED secret is missing, and still emits everything else", async () => {
  const { stdout, stderr, code } = await run({
    listed: ["elevenlabs-api-key"],
    values: { "elevenlabs-api-key": "el-test" },
  });
  assert.equal(code, 2, `a missing required secret must be distinguishable from success (required: ${REQUIRED.join(", ")})`);
  assert.match(stdout, /ELEVENLABS_API_KEY='el-test'/, "a partial hydration is still worth delivering");
  assert.match(stderr, /MISSING required secret 'openai-api-key'/);
});

test("a required secret absent from the listing is STILL fetched directly", async () => {
  // The enumeration is an optimisation, not an authority. If it is stale or wrong, a required
  // secret must not be silently skipped on the strength of a listing that never mentioned it.
  const { stdout, code, calls } = await run({
    listed: ["depot-token"], // listing omits both required ids
    values: { "openai-api-key": "sk", "elevenlabs-api-key": "el", "depot-token": "dp" },
  });
  assert.equal(code, 0, "both required secrets do exist; a stale listing must not turn that into a failure");
  assert.match(stdout, /OPENAI_API_KEY='sk'/);
  assert.match(stdout, /ELEVENLABS_API_KEY='el'/);
  assert.ok(calls.some((c) => c.includes("openai-api-key")), "the required id must be fetched despite its absence from the listing");
});

test("a FAILED enumeration falls back to per-secret fetch instead of reporting an empty store", async () => {
  // ssmListDetailed() returns [] when the first page fails. Treating that as "there are no
  // secrets" would hydrate an empty session and look like success -- the exact silent
  // under-delivery this script exists to prevent.
  const { stdout, stderr, code } = await run({
    listStatus: 400,
    values: { "openai-api-key": "sk", "elevenlabs-api-key": "el" },
  });
  assert.equal(code, 0);
  assert.match(stdout, /OPENAI_API_KEY='sk'/, "the values were reachable all along; enumeration failing must not hide them");
  assert.match(stderr, /falling back to per-secret fetch/);
});

test("enumeration paginates: a store larger than one page is fully seen", async () => {
  // GetParametersByPath is capped at MaxResults 10 here, so ~450 parameters is ~45 pages. A
  // pagination bug would silently truncate the inventory and under-hydrate the session.
  const listed = MAP.map((m) => m.id); // 98 ids => >= 10 pages
  const values = Object.fromEntries(MAP.map((m) => [m.id, `v-${m.id}`]));
  const { stdout, code, calls } = await run({ listed, values });
  assert.equal(code, 0);
  const emitted = stdout.split("\n").filter(Boolean).length;
  assert.equal(emitted, MAP.length, "every mapped secret present in the store must be hydrated");
  const pages = calls.filter((c) => c.startsWith("AmazonSSM.GetParametersByPath")).length;
  assert.ok(pages >= 10, `expected multi-page enumeration, saw ${pages} page(s)`);
});

test("enumeration is used to AVOID pointless per-secret round trips", async () => {
  // ~60 of the 98 mapped secrets are legitimately absent. Fetching each one to discover that on
  // every session start is the naive shape this deliberately avoids.
  const { calls, code } = await run({
    listed: ["openai-api-key", "elevenlabs-api-key"],
    values: { "openai-api-key": "sk", "elevenlabs-api-key": "el" },
  });
  assert.equal(code, 0);
  const gets = calls.filter((c) => c.startsWith("AmazonSSM.GetParameter ")).length;
  assert.equal(gets, 2, `expected 2 targeted reads, saw ${gets} -- the listing is not being used to narrow the fetch set`);
});

test("no resolvable AWS credentials exits 1 with EMPTY stdout, so the caller falls through", async () => {
  // Distinguishing "store unreachable from here" from "store is empty" is what lets
  // session-start.sh try its next source instead of accepting a blank hydration.
  const { stdout, stderr, code } = await run({}, { AWS_ACCESS_KEY_ID: "proxPLACEHOLDER", AWS_SECRET_ACCESS_KEY: "x" });
  assert.equal(code, 1);
  assert.equal(stdout, "", "an unreachable store must emit nothing at all");
  assert.match(stderr, /no resolvable AWS credentials/);
});

// ─── THE PIPE ITSELF: exit code and payload must agree ──────────────────────────────────────────
//
// Every test above reads stdout through execFile, which drains the pipe as fast as the child fills
// it -- so it can never observe the failure below. The REAL caller is
// `FETCHED="$(node setup/fetch-secrets-aws.mjs 2>"$SSM_ERR")"` in session-start.sh: a bash command
// substitution, whose reader takes measurably longer to start draining. Node writes to a pipe
// ASYNCHRONOUSLY, and process.exit() discards whatever is still queued. Measured through that exact
// shape before the fix: 1000 lines written, 35-47 received, exit 0, not one word of warning.
//
// That is the branch's own thesis ("THE HYDRATOR'S EXIT CODE IS THE ANSWER") failing: rc=0 arriving
// alongside a silently half-delivered hydration. These tests run the shipped script through the
// real shape.

/** Run the REAL script the way session-start.sh does: bash command substitution over a pipe. */
async function runViaShell(opts = {}, { env = {}, reader = "substitution" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "fetch-aws-pipe-"));
  const logPath = join(dir, "calls.log");
  writeFileSync(logPath, "");
  const preloadPath = join(dir, "preload.mjs");
  writeFileSync(preloadPath, preloadSource(logPath, opts));
  const errPath = join(dir, "stderr.txt");

  const childEnv = {
    PATH: process.env.PATH,
    HOME: dir,
    NODE_OPTIONS: `--import ${preloadPath}`,
    AWS_REGION: REGION,
    AWS_SSM_PREFIX: "/otchealth",
    AWS_ACCESS_KEY_ID: "AKIAUNITTESTONLY0000",
    AWS_SECRET_ACCESS_KEY: "unit-test-secret-not-a-real-credential",
    ...env,
  };
  delete childEnv.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI;
  delete childEnv.AWS_CONTAINER_CREDENTIALS_FULL_URI;
  delete childEnv.AWS_SESSION_TOKEN;

  // Two readers, both real bash, for two different jobs.
  //
  // `substitution` is byte-for-byte the shape in session-start.sh. It is a sanity check that the
  // normal path is intact -- NOT the regression guard, because whether it loses data is a race
  // between how fast node queues and how fast bash drains. Measured under a deliberately restored
  // process.exit(): ~3.9 MB truncated on three consecutive runs in one sitting and survived three
  // consecutive runs in another. A guard that reports the bug only sometimes is not a guard.
  //
  // `slow` removes the race instead of betting on it: the reader sleeps before draining, so the
  // queue provably builds. That is not a contrivance -- a loaded machine or a slow consumer is
  // exactly the real-world condition that turns this latent bug into a lost credential, and it is
  // the condition a test has to be able to create on demand. PIPESTATUS[0] is used because the
  // pipeline's own $? belongs to the reader, not to node.
  const outPath = join(dir, "stdout.txt");
  const script =
    reader === "slow"
      ? `node ${JSON.stringify(SCRIPT)} 2>${JSON.stringify(errPath)} | { sleep 0.5; cat; } > ${JSON.stringify(outPath)}
rc=\${PIPESTATUS[0]}
grep -c '=' ${JSON.stringify(outPath)} || true
echo "RC=$rc"`
      : `FETCHED="$(node ${JSON.stringify(SCRIPT)} 2>${JSON.stringify(errPath)})" && rc=0 || rc=$?
printf '%s' "$FETCHED" | grep -c '=' || true
echo "RC=$rc"`;
  const { stdout } = await execFileP("bash", ["-c", script], { env: childEnv, maxBuffer: 64 * 1024 * 1024, timeout: 120_000 });
  const received = Number(stdout.split("\n")[0]);
  const rc = Number(/RC=(\d+)/.exec(stdout)?.[1] ?? -1);
  const stderr = readFileSync(errPath, "utf8");
  const claimed = Number(/\[fetch-secrets-aws\] (\d+) secret\(s\) hydrated /.exec(stderr)?.[1] ?? -1);
  return { received, rc, stderr, claimed };
}

test("REGRESSION GUARD: a slow reader must not cost the caller a single secret", async () => {
  // The deterministic form. The reader stalls half a second before draining, so node's stdout queue
  // provably builds up; process.exit() then discards it while still exiting 0. This is the test
  // that goes RED the moment process.exit() comes back to this script.
  const listed = MAP.map((m) => m.id);
  const big = "x".repeat(Number(process.env.PIPE_TEST_BYTES || 4000)); // ~390 KB total, realistic-ish
  const values = Object.fromEntries(MAP.map((m) => [m.id, `${big}-${m.id}`]));
  const { received, rc, claimed } = await runViaShell({ listed, values }, { reader: "slow" });
  assert.equal(rc, 0, "all required secrets are present, so this is a clean run");
  assert.equal(claimed, MAP.length, "the script must state on stderr how many lines it wrote");
  assert.equal(
    received,
    claimed,
    `stdout was truncated in transit: the script reported writing ${claimed} line(s) but the ` +
      `caller received ${received}. An exit code of 0 over a truncated payload is a failure ` +
      `returned as a plausible value -- do not reintroduce process.exit() in this script.`,
  );
});

test("the exact session-start.sh command-substitution shape delivers the whole payload", async () => {
  // The realistic shape, asserted for completeness of the normal path. Stated honestly: this one
  // does NOT reliably catch a reintroduced process.exit() -- see the runner comment above -- which
  // is why the slow-reader test exists alongside it rather than instead of it.
  const listed = MAP.map((m) => m.id);
  const values = Object.fromEntries(MAP.map((m) => [m.id, `v-${m.id}`]));
  const { received, rc, claimed } = await runViaShell({ listed, values });
  assert.equal(rc, 0);
  assert.equal(received, claimed, "the caller must receive every line the script reported writing");
  assert.equal(received, MAP.length);
});

test("the script never calls process.exit(), which is what discards queued stdout", async () => {
  // The behavioural test above is the real guard; this one names the cause so a future edit that
  // reaches for process.exit() fails with the reason attached rather than an unexplained count.
  const src = readFileSync(SCRIPT, "utf8");
  const calls = src.split("\n").filter((l) => /^\s*process\.exit\s*\(/.test(l));
  assert.deepEqual(calls, [], `process.exit() discards queued pipe writes; use process.exitCode:\n${calls.join("\n")}`);
});

// ─── THE CROSS-FILE CONTRACT: REAL JSON written by THIS script, read by the REAL reader ─────────
//
// Superseded 2026-08-18: session-start.sh used to recover the missing env NAMES and the hydrated
// COUNT by running sed against this script's stderr, and until that round each side was only ever
// tested against a PRIVATE COPY of the other -- this file asserted its own message format,
// tests/session-start-hydration.test.mjs fed the shell a hand-written string shaped like it, and
// nothing ever ran one against the other. A wording change on either side could pass both suites
// while silently emptying the list at runtime, which is exactly the shape of bug that round fixed
// three separate times. The redesign removes the prose contract itself: this script now writes a
// JSON FLEET_HYDRATION_RESULT_FILE (setup/hydration-result.mjs), and session-start.sh reads it via
// setup/hydration-report.mjs, never via sed. The cross-file contract this test now pins is
// therefore "the REAL writer and the REAL reader agree on the schema" -- proven by running both,
// not by comparing each side's private description of it.
test("the REAL result file this script writes is read back correctly by the REAL hydration-result reader", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hydration-contract-"));
  const resultFile = join(dir, "result.json");
  const { stdout, code } = await run(
    {
      listed: ["elevenlabs-api-key"],
      values: { "elevenlabs-api-key": "el-test" }, // openai-api-key absent => a real MISSING entry
    },
    { FLEET_HYDRATION_RESULT_FILE: resultFile },
  );
  assert.equal(code, 2, "precondition: this run must actually produce a missing-required secret");

  const { readHydrationResult, statusOf } = await import("../setup/hydration-result.mjs");
  const result = readHydrationResult(resultFile);
  assert.notEqual(result, null, "the REAL reader must accept the REAL file this script wrote -- a schema drift here is exactly the cross-file contract failure this test exists to catch");
  assert.equal(statusOf(result), "partial");
  assert.deepEqual(
    result.requiredMissing.map((m) => m.env).sort(),
    ["OPENAI_API_KEY"],
    "the missing entry's env name must be usable directly, with no further parsing",
  );
  assert.equal(result.store, "aws-ssm");
  assert.equal(result.emittedCount, 1);

  // And the transport-layer half of the same contract: the count this script CLAIMED it emitted
  // must match what actually arrived on stdout, verified with the REAL counter session-start.sh's
  // reporter uses -- not a re-implementation of it.
  const { countAssignmentLines } = await import("../setup/hydration-report.mjs");
  assert.equal(countAssignmentLines(stdout), result.emittedCount);
});

test("an unreachable store (no credentials) is written as reachable:false, with every required id listed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hydration-contract-unreachable-"));
  const resultFile = join(dir, "result.json");
  const { code } = await run({}, { FLEET_HYDRATION_RESULT_FILE: resultFile, AWS_ACCESS_KEY_ID: "", AWS_SECRET_ACCESS_KEY: "" });
  assert.equal(code, 1);

  const { readHydrationResult } = await import("../setup/hydration-result.mjs");
  const result = readHydrationResult(resultFile);
  assert.notEqual(result, null);
  assert.equal(result.reachable, false);
  const requiredEnvs = MAP.filter((m) => m.required).map((m) => m.env).sort();
  assert.deepEqual(result.requiredMissing.map((m) => m.env).sort(), requiredEnvs);
});
