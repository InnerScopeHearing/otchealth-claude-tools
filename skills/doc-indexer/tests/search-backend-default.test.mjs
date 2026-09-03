// Pins skills/doc-indexer/enrich.mjs's SEARCH backend default (2026-09-03, FND-20260903-bf43).
//
// WHY: this defaulted to "azure" -- a PERMANENTLY DELETED service (subscription 55c84f6b, deleted
// 2026-08-13) -- so any caller that did not set SEARCH_BACKEND silently targeted a dead backend
// instead of failing loud. It was masked in practice only because session-start.sh and every ECS
// task definition set the variable explicitly, which is exactly the shape that makes a latent trap
// survive: it is invisible until the one caller that forgets. The AWS default-flip
// (claude-tools#466) moved STORAGE_BACKEND to "s3" and missed SEARCH_BACKEND, so this file also
// pins the two as SYMMETRIC, which is the property that actually prevents the same miss recurring.
//
// SCOPE, STATED HONESTLY: these assertions are credential-free by construction, and none of them
// claims to observe the RESOLVED `BACKEND` constant at runtime. That was deliberate. The one
// subprocess path that echoes the resolved value (cmdVerify's usage line) calls `await
// resolveStorage()` FIRST, so a test built on it would pass only in a seat holding live
// credentials and fail in CI -- precisely the non-hermetic-test defect that held claude-tools#553
// on the same day this file was written. A weaker assertion that always runs is worth more than a
// stronger one that silently cannot.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENRICH_MJS = join(HERE, "..", "enrich.mjs");

/** Run enrich.mjs with SEARCH_BACKEND and every AWS credential variable stripped, so each case
 *  exercises the true unset-environment default and holds on a runner with no credentials. */
function runBare(args) {
  const env = { ...process.env };
  for (const k of ["SEARCH_BACKEND", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN",
                   "OTC_AWS_ACCESS_KEY_ID", "OTC_AWS_SECRET_ACCESS_KEY",
                   "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", "AWS_CONTAINER_CREDENTIALS_FULL_URI"]) delete env[k];
  try {
    const stdout = execFileSync("node", [ENRICH_MJS, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env });
    return { status: 0, stdout, stderr: "" };
  } catch (e) {
    return { status: e.status, stdout: e.stdout || "", stderr: e.stderr || "" };
  }
}

test("the default search backend is opensearch, not the deleted azure service (source-level lock on the constant itself)", () => {
  const src = readFileSync(ENRICH_MJS, "utf8");
  assert.match(
    src,
    /process\.env\.SEARCH_BACKEND \|\| "opensearch"\) \|\| "opensearch"\)\.toLowerCase\(\)/,
    'BACKEND must default to opensearch on BOTH fallbacks; a stray "azure" on either one reinstates the dead-service default',
  );
  assert.doesNotMatch(src, /SEARCH_BACKEND \|\| "azure"/, "the dead-service default must not reappear");
});

test("SYMMETRY with storage: both backend defaults name a live AWS service, so a future default-flip cannot move one and miss the other again", () => {
  const src = readFileSync(ENRICH_MJS, "utf8");
  assert.match(src, /process\.env\.STORAGE_BACKEND \|\| "s3"/, "STORAGE_BACKEND must default to the live s3");
  assert.match(src, /process\.env\.SEARCH_BACKEND \|\| "opensearch"/, "SEARCH_BACKEND must default to the live opensearch");
});

test("the CLI help documents opensearch as the default (runs with no credentials and no SEARCH_BACKEND)", () => {
  const r = runBare([]); // no command -> usage + exit 2, printed at top level before any network call
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--search-backend opensearch\|azure \(default opensearch/,
    "help text must not advertise the retired azure backend as the default");
});

test("azure remains an ACCEPTED value, only no longer the default -- the flag is genuinely parsed, not ignored", () => {
  // An invalid value is rejected by the top-level guard BEFORE any command dispatch or network
  // call, and the guard echoes what it received. That proves --search-backend is really read.
  const bad = runBare(["run", "--search-backend", "not-a-backend"]);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /--search-backend must be "azure" or "opensearch" \(got "not-a-backend"\)/);
  // ...and neither valid value trips that guard.
  for (const v of ["azure", "opensearch"]) {
    const r = runBare(["run", "--search-backend", v, "--profile", "legal", "--container", "personal"]);
    assert.doesNotMatch(r.stderr, /--search-backend must be/, `"${v}" must remain an accepted value`);
  }
});

test("the attorney-privileged refusal still fires ahead of everything, under the new default too", () => {
  // Guards the interaction: the refusal must not depend on which backend resolved.
  const r = runBare(["run", "--profile", "legal", "--container", "personal"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /REFUSED: --profile legal --container personal/);
});
