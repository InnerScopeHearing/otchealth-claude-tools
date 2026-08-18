// Regression tests for setup/session-start.sh's fleet-secret hydration block — the bash that runs
// at the start of EVERY agent session in the fleet and decides whether that session has
// credentials at all. It had no test coverage of any kind before 2026-08-18, which is how two
// defects of the same shape shipped in it: a failure reported as a plausible success.
//
// WHAT IS ACTUALLY UNDER TEST. Not a paraphrase of the block, and not a helper extracted for
// testability — the REAL bytes that ship. The block is delimited in session-start.sh by
// `# >>> BEGIN fleet-secret hydration` / `# >>> END fleet-secret hydration`; this file cuts between
// those markers and sources the result in a harness that reproduces session-start's shell state at
// that point (`set -u`, `set +e`, no pipefail). If someone edits the block, this test runs the
// edit. If someone deletes the markers, extraction fails loudly rather than silently testing
// nothing.
//
// The two hydrators are stubbed at the process boundary (TOOLS_DIR points at a fake setup/ dir), so
// every branch of the SHELL logic is exercised without touching a live store. setup/
// secret-backend.mjs is deliberately NOT stubbed — it is symlinked to the real script, because the
// whole point of the SECRET_BACKEND test below is that the shell and the JS agree.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SESSION_START = join(ROOT, "setup", "session-start.sh");

const BEGIN = "# >>> BEGIN fleet-secret hydration";
const END = "# >>> END fleet-secret hydration";

/** Cut the hydration block out of the real session-start.sh. Throws if the markers are gone. */
function extractBlock() {
  const src = readFileSync(SESSION_START, "utf8");
  const i = src.indexOf(BEGIN);
  const j = src.indexOf(END);
  assert.ok(i !== -1, `session-start.sh lost its "${BEGIN}" marker; the hydration block is untestable`);
  assert.ok(j > i, `session-start.sh lost its "${END}" marker; the hydration block is untestable`);
  return src.slice(i, j + END.length);
}

/**
 * Build a fake TOOLS_DIR whose setup/ holds stub hydrators, then source the real block against it.
 *
 * @param {object} o
 * @param {number} o.ssmRc      exit code for the AWS hydrator stub
 * @param {string} o.ssmOut     its stdout (the `ENV='value'` lines session-start parses)
 * @param {string} o.ssmErr     its stderr (where MISSING-required diagnostics live)
 * @param {string} o.kvOut      stdout for the Key Vault hydrator stub
 * @param {object} o.env        extra environment for the shell
 * @returns {{stdout:string, kvCalled:boolean, fetched:string, source:string}}
 */
function runBlock({ ssmRc = 0, ssmOut = "", ssmErr = "", kvOut = "", env = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ssh-hydrate-"));
  mkdirSync(join(dir, "setup"), { recursive: true });

  // Stub hydrators: emit fixed bytes, exit a fixed code, and record that they ran.
  const stub = (outVar, errVar, rcVar, marker) => `
import { appendFileSync } from 'node:fs';
if (process.env.${marker}) appendFileSync(process.env.${marker}, 'called\\n');
if (process.env.${outVar}) process.stdout.write(process.env.${outVar});
if (process.env.${errVar}) process.stderr.write(process.env.${errVar});
process.exit(Number(process.env.${rcVar} || 0));
`;
  writeFileSync(join(dir, "setup", "fetch-secrets-aws.mjs"), stub("STUB_SSM_OUT", "STUB_SSM_ERR", "STUB_SSM_RC", "STUB_SSM_CALLS"));
  writeFileSync(join(dir, "setup", "fetch-secrets-azure.mjs"), stub("STUB_KV_OUT", "STUB_KV_ERR", "STUB_KV_RC", "STUB_KV_CALLS"));

  // NOT a stub: the real normalizer, so "the shell agrees with the JS" is a real assertion. A
  // symlinked .mjs is resolved to its realpath by node, so its own `../skills/...` import still
  // lands on the real module tree.
  symlinkSync(join(ROOT, "setup", "secret-backend.mjs"), join(dir, "setup", "secret-backend.mjs"));

  const blockFile = join(dir, "block.sh");
  writeFileSync(blockFile, extractBlock());

  const kvCalls = join(dir, "kv-calls");
  const harness = join(dir, "harness.sh");
  writeFileSync(
    harness,
    // Reproduce session-start.sh's shell state at the point the block runs: -u on, -e and pipefail
    // off (session-start.sh:25 then :92-93).
    `set -u
set +e
set +o pipefail
TOOLS_DIR="${dir}"
KEYVAULT="kv-test"
FETCHED=""
SECRET_SOURCE=""
. "${blockFile}"
echo "===FETCHED-BEGIN==="
printf '%s' "$FETCHED"
echo ""
echo "===FETCHED-END==="
echo "SECRET_SOURCE=$SECRET_SOURCE"
echo "RESOLVED_BACKEND=$SECRET_BACKEND"
`,
  );

  const stdout = execFileSync("bash", [harness], {
    encoding: "utf8",
    env: {
      ...process.env,
      STUB_SSM_OUT: ssmOut,
      STUB_SSM_ERR: ssmErr,
      STUB_SSM_RC: String(ssmRc),
      STUB_KV_OUT: kvOut,
      STUB_KV_ERR: "",
      STUB_KV_RC: "0",
      STUB_KV_CALLS: kvCalls,
      // Present so the Key Vault fallback's credential guard passes; the stub never uses them.
      AZURE_SP_CLIENT_ID: "test-id",
      AZURE_SP_CLIENT_SECRET: "test-secret",
      AZURE_SP_TENANT_ID: "test-tenant",
      SECRET_BACKEND: "ssm",
      ...env,
    },
  });

  const fetched = stdout.split("===FETCHED-BEGIN===\n")[1]?.split("\n===FETCHED-END===")[0] ?? "";
  const source = /^SECRET_SOURCE=(.*)$/m.exec(stdout)?.[1] ?? "";
  return { stdout, kvCalled: existsSync(kvCalls), fetched, source };
}

const MISSING_ERR =
  "[fetch-secrets-aws] MISSING required secret 'openai-api-key' (env OPENAI_API_KEY) at /otchealth/openai-api-key (us-east-1).\n";

// ─── FINDING 1: exit 2 (a required secret is absent) must not read as success ───────────────────

test("exit 2 with partial output is NOT reported as a successful hydration", () => {
  // The exact reproduction: the hydrator loses a required secret, still emits the others, exits 2.
  // The old block printed "AWS SSM OK — 2 secrets loaded" and moved on.
  const r = runBlock({
    ssmRc: 2,
    ssmOut: "ELEVENLABS_API_KEY='el'\nDEPOT_TOKEN='dp'\n",
    ssmErr: MISSING_ERR,
  });
  assert.ok(!/AWS SSM OK/.test(r.stdout), `a non-zero hydrator exit must never print a success banner:\n${r.stdout}`);
  assert.match(r.stdout, /AWS SSM PARTIAL/, "the partial state must be named as partial");
  assert.ok(!/^SECRET_SOURCE=aws-ssm$/m.test(r.stdout), "the source must not claim a clean aws-ssm hydration");
});

test("exit 2 names the missing REQUIRED secret to the operator instead of discarding stderr", () => {
  const r = runBlock({
    ssmRc: 2,
    ssmOut: "ELEVENLABS_API_KEY='el'\n",
    ssmErr: MISSING_ERR,
  });
  // Both halves matter: the raw hydrator diagnostic (which names the SSM id and path) and the
  // summary line (which names the env var the session will be missing).
  assert.match(r.stdout, /MISSING required secret 'openai-api-key'/, "the hydrator's own diagnostic must reach the operator");
  assert.match(r.stdout, /REQUIRED secret\(s\) MISSING from the store: .*OPENAI_API_KEY/, "the summary must name what is missing");
});

test("exit 2 still attempts the Key Vault fallback (partial output must not short-circuit it)", () => {
  // The second-order harm: the fallback existed precisely to cover the missing secret, and was
  // skipped because SOME other secret had arrived and left $FETCHED non-empty.
  const r = runBlock({
    ssmRc: 2,
    ssmOut: "ELEVENLABS_API_KEY='el'\n",
    ssmErr: MISSING_ERR,
  });
  assert.ok(r.kvCalled, "the Key Vault fallback must run when a required secret is still missing");
});

test("the fallback FILLS the gap without demoting the values SSM did serve", () => {
  const r = runBlock({
    ssmRc: 2,
    ssmOut: "ELEVENLABS_API_KEY='el'\nDEPOT_TOKEN='from-ssm'\n",
    ssmErr: MISSING_ERR,
    kvOut: "OPENAI_API_KEY='from-kv'\nDEPOT_TOKEN='from-kv'\n",
  });
  assert.match(r.fetched, /OPENAI_API_KEY='from-kv'/, "the gap must actually be filled");
  // get_key() takes the first match, so SSM must come first for a name both stores serve.
  const first = r.fetched.split("\n").find((l) => l.startsWith("DEPOT_TOKEN="));
  assert.equal(first, "DEPOT_TOKEN='from-ssm'", "the primary store must stay authoritative for ids it served");
  assert.match(r.stdout, /gap was covered by the fallback/, "a real recovery should be stated as one");
});

test("a gap the fallback could NOT cover is reported, not papered over", () => {
  const r = runBlock({
    ssmRc: 2,
    ssmOut: "ELEVENLABS_API_KEY='el'\n",
    ssmErr: MISSING_ERR,
    kvOut: "", // vault is dead, as it is today
  });
  assert.match(r.stdout, /still MISSING after every store: .*OPENAI_API_KEY/, "an uncovered gap must be stated plainly");
  assert.ok(!/gap was covered/.test(r.stdout), "must not claim a recovery that did not happen");
});

test("exit 0 with real output IS reported as success, and skips the fallback", () => {
  // The counterweight: the fix must not turn every run into a warning. A clean hydration still
  // reads as clean, and does not waste three attempts on a dead vault.
  const r = runBlock({ ssmRc: 0, ssmOut: "OPENAI_API_KEY='sk'\nELEVENLABS_API_KEY='el'\n" });
  assert.match(r.stdout, /AWS SSM OK — 2 secrets loaded/);
  assert.equal(r.source, "aws-ssm");
  assert.ok(!r.kvCalled, "a complete hydration must not fall back");
});

test("exit 1 (no AWS credentials) reports the exit code and falls back", () => {
  const r = runBlock({ ssmRc: 1, ssmOut: "", ssmErr: "[fetch-secrets-aws] no resolvable AWS credentials\n" });
  assert.ok(!/AWS SSM OK/.test(r.stdout));
  assert.match(r.stdout, /AWS SSM returned nothing \(exit 1\)/, "the exit code belongs in the message");
  assert.ok(r.kvCalled, "an unreachable primary must fall back");
});

test("exit 0 but EMPTY output is not a success either", () => {
  const r = runBlock({ ssmRc: 0, ssmOut: "" });
  assert.ok(!/AWS SSM OK/.test(r.stdout), "zero secrets is not a successful hydration");
  assert.ok(r.kvCalled);
});

// ─── FINDING 4: one definition of SECRET_BACKEND, shared by the shell and the JS ────────────────

test("secret-backend.mjs normalizes exactly like secretBackend() does for every caller", () => {
  const run = (v) =>
    execFileSync("node", [join(ROOT, "setup", "secret-backend.mjs")], {
      encoding: "utf8",
      env: { ...process.env, SECRET_BACKEND: v },
      stdio: ["ignore", "pipe", "ignore"],
    });
  assert.equal(run("ssm"), "ssm");
  assert.equal(run("SSM"), "ssm", "case must not change which store is live");
  assert.equal(run(" ssm "), "ssm", "surrounding whitespace must not change which store is live");
  assert.equal(run("Ssm"), "ssm");
  assert.equal(run("keyvault"), "keyvault");
  assert.equal(run("KEYVAULT "), "keyvault");
  assert.equal(run("typo"), "ssm", "an unrecognised value must resolve to the live store, not a dead one");
  assert.equal(run(""), "ssm");
  // No trailing newline: the shell captures this with $(...) and compares it directly.
  assert.ok(!run("ssm").includes("\n"), "must not emit a trailing newline");
});

test("the SHELL and the JS agree on a non-canonical SECRET_BACKEND", () => {
  // The bug: `[ "$SECRET_BACKEND" = "ssm" ]` made the shell skip the AWS hydrator on "SSM" while
  // every Node tool it launched read from SSM anyway — a session with no credentials and no
  // complaint.
  const r = runBlock({
    ssmRc: 0,
    ssmOut: "OPENAI_API_KEY='sk'\n",
    env: { SECRET_BACKEND: " SSM " },
  });
  assert.match(r.stdout, /Fetching secrets from AWS SSM/, "a non-canonical spelling must still run the AWS hydrator");
  assert.match(r.stdout, /AWS SSM OK/);
  assert.match(r.stdout, /^RESOLVED_BACKEND=ssm$/m, "the shell must carry the NORMALIZED value forward");
});

test("session-start.sh derives SECRET_BACKEND from the JS rather than re-parsing it in bash", () => {
  const src = readFileSync(SESSION_START, "utf8");
  assert.match(src, /SECRET_BACKEND="\$\(node "\$\{TOOLS_DIR\}\/setup\/secret-backend\.mjs"/,
    "the shell must ask the JS for the normalized value");
  assert.ok(!/export SECRET_BACKEND="\$\{SECRET_BACKEND:-ssm\}"/.test(src),
    "the raw bash default is a second parser and must not come back");
});

test("credentials.env receives the NORMALIZED backend, so a typo cannot self-perpetuate", () => {
  // session-start.sh writes SECRET_BACKEND into credentials.env, and the shell profile re-sources
  // that file into every later shell. Writing the raw value there is what made one bad spelling
  // outlive the session that introduced it.
  const src = readFileSync(SESSION_START, "utf8");
  const normIdx = src.indexOf('SECRET_BACKEND="$(node "${TOOLS_DIR}/setup/secret-backend.mjs"');
  const writeIdx = src.indexOf('echo "SECRET_BACKEND=${SECRET_BACKEND}"');
  assert.ok(normIdx !== -1, "normalization must exist");
  assert.ok(writeIdx !== -1, "credentials.env must still record the backend");
  assert.ok(writeIdx > normIdx, "the value written to credentials.env must be the normalized one");
});
