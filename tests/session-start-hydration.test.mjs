// Integration tests for setup/session-start.sh's fleet-secret hydration block -- the bash that
// runs at the start of EVERY agent session and decides whether that session has credentials.
//
// THIS FILE IS DELIBERATELY THIN. Three prior rounds of fixes each shipped a NEW instance of "a
// failure reported as a plausible success" as bash re-parsed a hydrator's stderr sentence, and the
// exhaustive state-table testing that caught each one lived here, against a hand-rolled shell
// harness. The 2026-08-18 redesign removes the re-parsing itself (see setup/hydration-result.mjs
// and setup/hydration-report.mjs): the shell no longer makes the completeness decision, so most of
// what used to need bash-level state-table coverage is now pure-function coverage in
// tests/hydration-report.test.mjs (fast, precise, no subprocess). What remains here is the
// end-to-end WIRING: does session-start.sh actually run the hydrators, capture their raw output,
// hand both to hydration-report.mjs, and surface exactly what it prints -- with NO decision logic
// of its own left to regress.
//
// WHAT IS ACTUALLY UNDER TEST. Not a paraphrase of the block, and not a helper extracted for
// testability — the REAL bytes that ship. The block is delimited in session-start.sh by
// `# >>> BEGIN fleet-secret hydration` / `# >>> END fleet-secret hydration`; this file cuts between
// those markers and sources the result in a harness that reproduces session-start's shell state at
// that point (`set -u`, `set +e`, no pipefail). If someone edits the block, this test runs the
// edit. If someone deletes the markers, extraction fails loudly rather than silently testing
// nothing.
//
// The two hydrators are stubbed at the process boundary (TOOLS_DIR points at a fake setup/ dir),
// each one able to write a FLEET_HYDRATION_RESULT_FILE exactly like a real hydrator does. The
// REPORTING machinery (hydration-result.mjs, hydration-report.mjs, secret-map.mjs) is the REAL
// shipped code, not a stub -- it is pure and network-free, so running it for real is both safe and
// the only way to prove the wiring between bash and it actually holds.

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
 * Build a fake TOOLS_DIR whose setup/ holds:
 *   - REAL copies of hydration-result.mjs, hydration-report.mjs, secret-map.mjs (pure, network-free
 *     -- running them for real is what proves the shell<->Node wiring, not a paraphrase of it)
 *   - REAL secret-backend.mjs (symlinked, same as before)
 *   - STUB fetch-secrets-aws.mjs / fetch-secrets-azure.mjs, each able to write a
 *     FLEET_HYDRATION_RESULT_FILE (when given a `*Result` object) exactly like the real hydrators
 *
 * @param {object} o
 * @param {number} [o.ssmRc]      exit code for the AWS hydrator stub
 * @param {string} [o.ssmOut]     its stdout (the `ENV='value'` lines session-start parses)
 * @param {string} [o.ssmErr]     its stderr (irrelevant to the decision now -- display only)
 * @param {object} [o.ssmResult]  the structured result it writes; OMIT to simulate a hydrator that
 *                                crashed/exited before ever calling writeHydrationResult()
 * @param {number} [o.kvRc]
 * @param {string} [o.kvOut]
 * @param {object} [o.kvResult]
 * @param {object} [o.env]        extra environment for the shell
 * @param {boolean} [o.omitReportScript] delete hydration-report.mjs from the fake TOOLS_DIR, to
 *                                exercise the outermost safety net when the reporter itself is gone
 */
function runBlock({ ssmRc = 0, ssmOut = "", ssmErr = "", ssmResult, kvRc = 0, kvOut = "", kvResult, env = {}, omitReportScript = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ssh-hydrate-"));
  mkdirSync(join(dir, "setup"), { recursive: true });

  const stub = (outVar, errVar, rcVar, resultVar) => `
import { appendFileSync, writeFileSync } from 'node:fs';
if (process.env.${outVar}) process.stdout.write(process.env.${outVar});
if (process.env.${errVar}) process.stderr.write(process.env.${errVar});
if (process.env.${resultVar} && process.env.FLEET_HYDRATION_RESULT_FILE) {
  writeFileSync(process.env.FLEET_HYDRATION_RESULT_FILE, process.env.${resultVar});
}
process.exitCode = Number(process.env.${rcVar} || 0);
`;
  writeFileSync(join(dir, "setup", "fetch-secrets-aws.mjs"), stub("STUB_SSM_OUT", "STUB_SSM_ERR", "STUB_SSM_RC", "STUB_SSM_RESULT"));
  writeFileSync(join(dir, "setup", "fetch-secrets-azure.mjs"), stub("STUB_KV_OUT", "STUB_KV_ERR", "STUB_KV_RC", "STUB_KV_RESULT"));

  // REAL, not stubbed: the whole point of this file is proving the shell hands these the right
  // arguments and renders exactly what they say. Symlinked so each still resolves its own sibling
  // imports (secret-map.mjs, hydration-result.mjs) against the REAL module tree.
  for (const f of ["secret-backend.mjs", "hydration-result.mjs", "secret-map.mjs"]) {
    symlinkSync(join(ROOT, "setup", f), join(dir, "setup", f));
  }
  if (!omitReportScript) symlinkSync(join(ROOT, "setup", "hydration-report.mjs"), join(dir, "setup", "hydration-report.mjs"));

  const blockFile = join(dir, "block.sh");
  writeFileSync(blockFile, extractBlock());

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
      STUB_SSM_RESULT: ssmResult ? JSON.stringify(ssmResult) : "",
      STUB_KV_OUT: kvOut,
      STUB_KV_ERR: "",
      STUB_KV_RC: String(kvRc),
      STUB_KV_RESULT: kvResult ? JSON.stringify(kvResult) : "",
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
  return { stdout, fetched, source };
}

const REQ_A_ENV = "OPENAI_API_KEY";
const REQ_B_ENV = "ELEVENLABS_API_KEY";

// ─── property A: no prose re-parsing left in the shipped block ──────────────────────────────────

test("REGRESSION GUARD: the old prose-reparsing constructs are GONE from session-start.sh", () => {
  // This is the direct proof that the defect class was removed, not merely patched again. Every
  // one of these strings was part of a shipped bug this round fixes; none may return.
  const block = extractBlock();
  for (const banned of [
    "SSM_MISSING_ENVS=",
    'sed -n "s/.*MISSING required secret',
    "ssm_claimed=",
    "STILL_MISSING=",
    "[ -z \"$SSM_MISSING_ENVS\" ]",
    "for env_name in $SSM_MISSING_ENVS",
  ]) {
    assert.ok(!block.includes(banned), `the shipped block must not contain the old parsing construct: ${banned}`);
  }
  // And the positive claim: the block now delegates to the structured reporter.
  assert.match(block, /hydration-report\.mjs/, "the block must call the new structured reporter");
  assert.match(block, /FLEET_HYDRATION_RESULT_FILE/, "the block must pass the structured-result path to each hydrator");
});

// ─── the wiring: clean success ────────────────────────────────────────────────────────────────

test("a clean SSM hydration is reported OK, KV is never attempted, and the all-clear prints", () => {
  const r = runBlock({
    ssmRc: 0,
    ssmOut: `${REQ_A_ENV}='sk'\n${REQ_B_ENV}='el'\n`,
    ssmResult: { store: "aws-ssm", reachable: true, emittedCount: 2, requiredTotal: 2, requiredMissing: [] },
  });
  assert.match(r.stdout, /AWS SSM OK/);
  assert.match(r.stdout, /All required secrets are present/);
  assert.equal(r.source, "aws-ssm");
  assert.doesNotMatch(r.stdout, /Fetching secrets from Azure Key Vault/, "a clean ok must skip the fallback (needsFallback gate)");
});

// ─── the wiring: a real gap, filled by the fallback ──────────────────────────────────────────────

test("an SSM gap correctly triggers the KV fallback, and the fallback covering it is reported precisely", () => {
  const r = runBlock({
    ssmRc: 2,
    ssmOut: `${REQ_B_ENV}='el'\n`,
    ssmResult: { store: "aws-ssm", reachable: true, emittedCount: 1, requiredTotal: 2, requiredMissing: [{ id: "openai-api-key", env: REQ_A_ENV }] },
    kvRc: 0,
    kvOut: `${REQ_A_ENV}='from-kv'\n`,
    kvResult: { store: "azure-keyvault", reachable: true, emittedCount: 1, requiredTotal: 2, requiredMissing: [] },
  });
  assert.match(r.stdout, /Fetching secrets from Azure Key Vault/, "a partial SSM result must trigger the fallback");
  assert.match(r.fetched, new RegExp(`${REQ_A_ENV}='from-kv'`), "the gap must actually be filled");
  assert.doesNotMatch(r.stdout, /still MISSING/);
  assert.doesNotMatch(r.stdout, /could not determine/);
});

// ─── property B, replayed end-to-end: an unparseable/absent result is UNKNOWN, never an all-clear ─

test("BLOCKER regression, replayed live: a hydrator that never writes a result file is UNKNOWN, not an all-clear", () => {
  // The exact shape of the historical bug, reproduced through the REAL shell wiring instead of a
  // hand-crafted stderr string: the hydrator exits 2 (something required is gone) but -- for
  // whatever reason, crash, disk full, a future refactor bug -- never calls writeHydrationResult()
  // at all. No `ssmResult` is passed, so no file is written. KV is not configured with useful
  // creds coverage either. The report must say UNKNOWN, never "all required secrets are present".
  const r = runBlock({
    ssmRc: 2,
    ssmOut: `${REQ_B_ENV}='el'\n`,
    ssmErr: "some hydrator crashed before writing anything structured\n",
    // no ssmResult
    kvRc: 1, // Key Vault also fails to help
  });
  assert.doesNotMatch(r.stdout, /All required secrets are present/);
  assert.doesNotMatch(r.stdout, /gap was covered/);
  assert.match(r.stdout, /UNVERIFIED for AWS SSM|could not determine whether these REQUIRED/);
});

test("wording changes in a hydrator's stderr sentence have NO effect on the decision (the old coupling is gone)", () => {
  // Direct proof that the shell no longer derives anything from this text: two runs with wildly
  // different stderr wording but IDENTICAL structured results must produce the identical
  // completeness verdict.
  const base = {
    ssmRc: 2,
    ssmOut: `${REQ_B_ENV}='el'\n`,
    ssmResult: { store: "aws-ssm", reachable: true, emittedCount: 1, requiredTotal: 2, requiredMissing: [{ id: "openai-api-key", env: REQ_A_ENV }] },
  };
  const a = runBlock({ ...base, ssmErr: "[fetch-secrets-aws] MISSING required secret 'openai-api-key' (env OPENAI_API_KEY) ...\n" });
  const b = runBlock({ ...base, ssmErr: "totally reformatted diagnostic text that shares NOTHING with the old sed pattern\n" });
  const stillMissingLine = (s) => s.split("\n").find((l) => l.includes("still MISSING after every store"));
  assert.equal(stillMissingLine(a.stdout), stillMissingLine(b.stdout));
});

// ─── outermost safety net: even a missing reporter cannot become a silent all-clear ──────────────

test("outermost safety net: if hydration-report.mjs itself is absent, the session is UNVERIFIED, never silent and never an all-clear", () => {
  const r = runBlock({
    ssmRc: 0,
    ssmOut: `${REQ_A_ENV}='sk'\n${REQ_B_ENV}='el'\n`,
    ssmResult: { store: "aws-ssm", reachable: true, emittedCount: 2, requiredTotal: 2, requiredMissing: [] },
    omitReportScript: true,
  });
  assert.match(r.stdout, /hydration completeness report itself could not be produced/);
  assert.doesNotMatch(r.stdout, /All required secrets are present/);
  assert.doesNotMatch(r.stdout, /AWS SSM OK/, "the per-arm banner comes from the missing reporter too -- nothing about it may print");
  assert.equal(r.source, "unknown");
});

// ─── property E, replayed end-to-end: a direct session env var is session-truth, not store-truth ──

test("a required secret supplied only via a direct session env var is covered, but labelled session-truth", () => {
  const r = runBlock({
    ssmRc: 2,
    ssmOut: `${REQ_B_ENV}='el'\n`,
    ssmResult: { store: "aws-ssm", reachable: true, emittedCount: 1, requiredTotal: 2, requiredMissing: [{ id: "openai-api-key", env: REQ_A_ENV }] },
    kvRc: 1, // Key Vault cannot help either
    env: { [REQ_A_ENV]: "supplied-directly-by-the-environment" },
  });
  assert.doesNotMatch(r.stdout, /still MISSING/, "a secret present as a direct env var must not be reported missing");
  assert.match(r.stdout, /direct session env var, not a store/);
});
