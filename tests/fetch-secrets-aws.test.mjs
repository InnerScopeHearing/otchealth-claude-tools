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
