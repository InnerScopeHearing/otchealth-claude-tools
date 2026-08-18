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
  assert.match(r.stdout, /gap was covered: every REQUIRED secret named above/, "a real recovery should be stated as one, scoped to what was checked");
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
  assert.match(r.stdout, /AWS SSM OK — 2 secret\(s\) loaded/);
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

// ─── THE STATE TABLE: every outcome must render as ITSELF, and the last line must be true ───────
//
// The rule this section enforces: there is no input under which the operator's FINAL line claims
// completeness the script did not verify. Each state below asserts the operator-visible output,
// and several assert the LAST line specifically -- because a warning followed by an all-clear is
// read as an all-clear, which is precisely how the blocker below shipped.

/** The last line the hydration block itself printed, before the harness's own markers. */
function lastOperatorLine(stdout) {
  const lines = stdout.split("===FETCHED-BEGIN===")[0].split("\n").filter((l) => l.trim() !== "");
  return lines[lines.length - 1] ?? "";
}

const ALL_CLEAR = /all required secrets are present|gap was covered/;

test("BLOCKER: exit 2 with an UNPARSEABLE miss list must never print an all-clear", () => {
  // THE REPRODUCTION. STILL_MISSING was built by iterating $SSM_MISSING_ENVS; an EMPTY string meant
  // the loop body never ran, STILL_MISSING stayed empty, and the else branch announced "all
  // required secrets are present" having checked nothing. The only thing that populates
  // SSM_MISSING_ENVS is a bash sed against a string literal in fetch-secrets-aws.mjs, so a wording
  // change on either side empties it -- and empty was indistinguishable from "nothing was missing".
  // Here the hydrator still exits 2 (something IS gone) but reformats its message.
  const r = runBlock({
    ssmRc: 2,
    ssmOut: "ELEVENLABS_API_KEY='el'\nDEPOT_TOKEN='dp'\n",
    ssmErr: "[fetch-secrets-aws] MISSING required secret: openai-api-key -> OPENAI_API_KEY (not found)\n",
    kvOut: "", // the vault is dead, as it is today
  });
  assert.ok(!ALL_CLEAR.test(r.stdout), `an unparseable miss list must not produce an all-clear:\n${r.stdout}`);
  assert.match(r.stdout, /could not determine WHICH one/, "the state is UNKNOWN and must be named as unknown");
  assert.match(lastOperatorLine(r.stdout), /^=+$/, "the last thing on screen must be the warning banner, not a reassurance");
});

test("BLOCKER: exit 2 with EMPTY stderr is UNKNOWN, not 'nothing missing'", () => {
  // The degenerate case: the diagnostics are lost entirely (a redirect that failed, a hydrator that
  // wrote nothing). rc=2 has already asserted a required secret is gone; silence about WHICH one is
  // an unknown, and an unknown is not an all-clear.
  const r = runBlock({ ssmRc: 2, ssmOut: "ELEVENLABS_API_KEY='el'\n", ssmErr: "", kvOut: "" });
  assert.ok(!ALL_CLEAR.test(r.stdout), `empty diagnostics must not read as nothing-missing:\n${r.stdout}`);
  assert.match(r.stdout, /INCOMPLETELY hydrated/);
  assert.match(r.stdout, /UNKNOWN, not an all-clear/);
});

test("UNKNOWN is distinguishable from a NAMED still-missing gap", () => {
  // Two different truths must not print the same words: "I know OPENAI_API_KEY is gone" and "I know
  // something is gone but not what" are different operator actions.
  const named = runBlock({ ssmRc: 2, ssmOut: "ELEVENLABS_API_KEY='el'\n", ssmErr: MISSING_ERR, kvOut: "" });
  const unknown = runBlock({ ssmRc: 2, ssmOut: "ELEVENLABS_API_KEY='el'\n", ssmErr: "", kvOut: "" });
  assert.match(named.stdout, /still MISSING after every store: .*OPENAI_API_KEY/);
  assert.ok(!/still MISSING after every store/.test(unknown.stdout), "an unknown must not fabricate a name list");
  assert.ok(!/could not determine WHICH one/.test(named.stdout), "a known name must not be reported as unknown");
});

test("a secret supplied as a DIRECT env var is not reported missing", () => {
  // get_key() (session-start.sh, just below this block) resolves "${!name}" FIRST and only then
  // looks in $FETCHED, and this script's own header documents passing OPENAI_API_KEY straight in as
  // a supported configuration. Grepping $FETCHED alone called that MISSING while the session was in
  // fact about to use it. A false alarm is safer than a false all-clear, but it trains the operator
  // to ignore this warning -- which then hides a real one.
  const r = runBlock({
    ssmRc: 2,
    ssmOut: "ELEVENLABS_API_KEY='el'\n",
    ssmErr: MISSING_ERR,
    kvOut: "",
    env: { OPENAI_API_KEY: "supplied-directly-by-the-environment" },
  });
  assert.ok(
    !/still MISSING after every store/.test(r.stdout),
    `a secret present as a direct env var must not be reported missing:\n${r.stdout}`,
  );
  assert.match(r.stdout, /gap was covered/, "it is genuinely covered, just not by $FETCHED");
});

test("the same secret ABSENT from the environment is still reported missing", () => {
  // The counterweight to the test above: the direct-env-var allowance must not become a blanket
  // excuse that silences the warning for everyone.
  const r = runBlock({
    ssmRc: 2,
    ssmOut: "ELEVENLABS_API_KEY='el'\n",
    ssmErr: MISSING_ERR,
    kvOut: "",
    env: { OPENAI_API_KEY: "" },
  });
  assert.match(r.stdout, /still MISSING after every store: .*OPENAI_API_KEY/);
});

// ─── rc=0 WITH TRUNCATED OUTPUT MUST NOT READ AS SUCCESS ────────────────────────────────────────

const hydratedLine = (n) => `[fetch-secrets-aws] ${n} secret(s) hydrated from /otchealth (us-east-1).\n`;

test("exit 0 whose payload arrived SHORT of the hydrator's own count is not a success", () => {
  // The hydrator states on stderr how many lines it wrote; the shell counts how many arrived.
  // A mismatch means the transfer lost data, and a payload that is provably not the one sent cannot
  // be called complete whatever the exit code says.
  const r = runBlock({
    ssmRc: 0,
    ssmOut: "OPENAI_API_KEY='sk'\nELEVENLABS_API_KEY='el'\n",
    ssmErr: hydratedLine(5),
    kvOut: "",
  });
  assert.ok(!/AWS SSM OK/.test(r.stdout), `a short payload must never print a success banner:\n${r.stdout}`);
  assert.match(r.stdout, /AWS SSM TRUNCATED — the hydrator reported writing 5 secret\(s\) but only 2 arrived/);
  assert.ok(!ALL_CLEAR.test(r.stdout), "a truncated read must not end in an all-clear");
  assert.match(r.stdout, /Which secrets were lost is UNKNOWN/);
  assert.ok(r.kvCalled, "a truncated primary read must still try the fallback");
});

test("exit 0 whose payload MATCHES the hydrator's count reads as success, and says so precisely", () => {
  const r = runBlock({
    ssmRc: 0,
    ssmOut: "OPENAI_API_KEY='sk'\nELEVENLABS_API_KEY='el'\n",
    ssmErr: hydratedLine(2),
  });
  assert.match(r.stdout, /AWS SSM OK — 2 secret\(s\) loaded; every REQUIRED secret resolved, and all 2 sent line\(s\) arrived intact/);
  assert.equal(r.source, "aws-ssm");
  assert.ok(!r.kvCalled);
});

test("an ABSENT count is reported as unverified, not invented as a mismatch", () => {
  // Inventing a failure from a measurement that could not be taken is the mirror image of the bug
  // being fixed. No count on stderr => the integrity check simply did not run.
  const r = runBlock({ ssmRc: 0, ssmOut: "OPENAI_API_KEY='sk'\n", ssmErr: "" });
  assert.match(r.stdout, /AWS SSM OK — 1 secret\(s\) loaded; every REQUIRED secret resolved\./);
  assert.ok(!/arrived intact/.test(r.stdout), "an unmeasured transfer must not claim it was measured");
  assert.ok(!/TRUNCATED/.test(r.stdout));
});

// ─── THE SUCCESS BANNER MUST NOT IMPLY A COMPLETENESS IT NEVER CHECKED ──────────────────────────

test("the success banner scopes its claim to REQUIRED secrets and disclaims the rest", () => {
  // Only 2 of the 98 entries in setup/secret-map.mjs are `required: true`, so exit 0 attests to 2
  // secrets, not 98. SSM serving 3 of 98 exits 0 and, under the old wording ("N secrets loaded"),
  // printed a clean banner and skipped the fallback -- a completeness the script never verified.
  const r = runBlock({ ssmRc: 0, ssmOut: "OPENAI_API_KEY='sk'\nELEVENLABS_API_KEY='el'\nDEPOT_TOKEN='dp'\n" });
  assert.match(r.stdout, /every REQUIRED secret resolved/, "the banner must say WHAT was verified");
  assert.match(r.stdout, /not a completeness check/, "the banner must say what it does NOT verify");
});

test("an unrecognised exit code fails loudly and names the code", () => {
  const r = runBlock({ ssmRc: 7, ssmOut: "", ssmErr: "[fetch-secrets-aws] something unexpected\n" });
  assert.ok(!/AWS SSM OK/.test(r.stdout));
  assert.match(r.stdout, /AWS SSM returned nothing \(exit 7\)/, "the operator needs the actual code to act on");
  assert.ok(!ALL_CLEAR.test(r.stdout));
  assert.ok(r.kvCalled);
});

test("NO input produces an all-clear as the final line without a verified, named gap closure", () => {
  // The design rule, asserted directly over the whole state table rather than one branch at a time.
  const cases = [
    { name: "rc=2, unparseable stderr", o: { ssmRc: 2, ssmOut: "A='1'\n", ssmErr: "reformatted\n", kvOut: "" } },
    { name: "rc=2, empty stderr", o: { ssmRc: 2, ssmOut: "A='1'\n", ssmErr: "", kvOut: "" } },
    { name: "rc=2, named + vault dead", o: { ssmRc: 2, ssmOut: "A='1'\n", ssmErr: MISSING_ERR, kvOut: "" } },
    { name: "rc=0, truncated", o: { ssmRc: 0, ssmOut: "A='1'\n", ssmErr: hydratedLine(9), kvOut: "" } },
    { name: "rc=1, unreachable", o: { ssmRc: 1, ssmOut: "", ssmErr: "", kvOut: "" } },
    { name: "rc=7, unknown code", o: { ssmRc: 7, ssmOut: "", ssmErr: "", kvOut: "" } },
    { name: "rc=0, empty payload", o: { ssmRc: 0, ssmOut: "", ssmErr: "", kvOut: "" } },
  ];
  for (const c of cases) {
    const r = runBlock(c.o);
    assert.ok(!ALL_CLEAR.test(r.stdout), `${c.name} must not produce an all-clear anywhere:\n${r.stdout}`);
  }
  // And the one state that IS allowed to say it: a named gap the fallback demonstrably filled.
  const covered = runBlock({
    ssmRc: 2,
    ssmOut: "ELEVENLABS_API_KEY='el'\n",
    ssmErr: MISSING_ERR,
    kvOut: "OPENAI_API_KEY='from-kv'\n",
  });
  assert.match(covered.stdout, /gap was covered: every REQUIRED secret named above \(OPENAI_API_KEY *\) is now present/);
});

test("a garbled env NAME cannot silently switch the whole honesty check off", () => {
  // The sed that recovers env names captures [A-Z0-9_]*, which admits "9BAD". Bash answers
  // "${!9BAD}" with an `invalid variable name` EXPANSION error, and that aborts the sourced block
  // where it stands -- measured: the still-missing warning, the covered message and the
  // no-secrets-at-all banner were ALL skipped, so one malformed diagnostic line turned off exactly
  // the reporting this round exists to make trustworthy. Silence is not an acceptable rendering of
  // any state.
  const r = runBlock({
    ssmRc: 2,
    ssmOut: "ELEVENLABS_API_KEY='el'\n",
    ssmErr: "[fetch-secrets-aws] MISSING required secret 'x' (env 9BAD) at /otchealth/x (us-east-1).\n",
    kvOut: "",
  });
  assert.match(r.stdout, /still MISSING after every store: .*9BAD/, "the block must reach its own conclusion, not die mid-way");
  assert.ok(!/invalid variable name/.test(r.stdout));
});
