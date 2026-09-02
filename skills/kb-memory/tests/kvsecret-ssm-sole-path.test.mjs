// kvSecret() under the DEFAULT backend must treat AWS SSM as the SOLE read path (2026-09-02).
//
// WHAT WAS WRONG. kvSecretSet() has skipped the Key Vault leg entirely under SECRET_BACKEND=ssm
// since 2026-08-27, with its own comment explaining why ("burns the whole dead-vault token ladder on
// every rotation and then logs a spurious PARTIAL ROTATION error"). The READ path never got the same
// treatment: on every SSM miss kvSecret() still walked identity -> SP -> az-CLI against Key Vault
// kv-otc-55c84f6bef, which died permanently with Azure subscription 55c84f6b on 2026-08-13 and can
// never answer again. Two concrete harms, both measured live before this change:
//   1. A secret that simply is not in SSM reported as
//      `[kv-secret] READ failed for "x" via all auth paths: identity:no-token, sp:no-token, azcli:no-token`
//      -- three Azure credentials named as the cause, and the store actually consulted (SSM) never
//      mentioned at all. That sends the next reader hunting an Azure auth problem that does not exist.
//   2. Every miss spawned a doomed `az` subprocess, and on any seat carrying AZURE_SP_* would also
//      POST to login.microsoftonline.com for a token it can do nothing with. (See the retraction
//      below: the spawn itself is NOT a measurable cost. The AAD round trip on an SP-equipped seat
//      would be.)
//
// A NUMBER RETRACTED, on purpose, so nobody re-derives it from this file: an earlier draft claimed
// the miss cost ~160ms of wasted `az` spawn (250ms miss vs 91ms hit). That was a COLD first call
// misread as ladder cost. Controlled and warmed, the miss is 68ms after vs 63ms before -- noise. On a
// seat with no AZURE_SP_* the ladder makes no network call at all, so this change is a correctness
// and honesty fix, not a performance one. It only becomes a latency fix on a seat that carries
// AZURE_SP_*, where each miss would POST to login.microsoftonline.com for an unusable token.
//
// These tests pin BEHAVIOR, not log text: a stubbed fetch records every host contacted, and a fake
// `az` on PATH leaves a marker file if it is ever spawned. A log-string assertion would pass just as
// well against a version that still dials Azure and merely words the failure differently.
import { test } from "node:test";
import assert from "node:assert/strict";
// spawnSync, NOT execFileSync: execFileSync returns only stdout, so a stderr capture written in its
// catch branch is silently "" whenever the child SUCCEEDS. Caught live while running these tests RED
// -- the "a miss is silent" assertion below PASSED against a version that was demonstrably printing
// the exact line it forbids, because the forbidden line was never captured. spawnSync surfaces both
// streams on every path.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const AZURE_SECRET = join(HERE, "..", "azure-secret.mjs");

/** Run kvSecret() in a subprocess with fetch stubbed and a booby-trapped `az` on PATH.
 *  Returns { hosts, result, azSpawned, stderr } -- hosts is every host the module actually contacted. */
async function probe({ env = {}, secretName = "some-secret-not-in-ssm", ssmStatus = 400, ssmType = "ParameterNotFound", ssmThrowMessage = null } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "kvsecret-sole-path-"));
  const marker = join(dir, "az-was-spawned");
  const bin = join(dir, "az");
  // A fake `az` that records its own invocation. If the module still walks the az-CLI rung, this
  // file appears -- which no amount of log rewording can hide.
  await writeFile(bin, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 1\n`);
  await chmod(bin, 0o755);

  const script = `
    const hosts = [];
    globalThis.fetch = async (url) => {
      const u = new URL(String(url));
      hosts.push(u.host);
      if (u.host.startsWith("ssm.")) {
        const thrown = ${JSON.stringify(ssmThrowMessage)};
        // Reproduces ssmCall()'s transport catch, which builds reason: \`error-\${e.message}\` from a
        // RAW Error -- the path by which an upstream message can reach a log line.
        if (thrown) throw new Error(thrown);
        return new Response(JSON.stringify({ __type: ${JSON.stringify(ssmType)}, message: "stub" }), {
          status: ${ssmStatus}, headers: { "content-type": "application/x-amz-json-1.1" },
        });
      }
      // Any Azure host: pretend the token/vault call "works" so a still-walking ladder cannot be
      // mistaken for "it tried but the network was down". A correct implementation never gets here.
      return new Response(JSON.stringify({ access_token: "stub", value: "stub-vault-value" }), { status: 200 });
    };
    const { kvSecret } = await import(${JSON.stringify(AZURE_SECRET)});
    const result = await kvSecret(${JSON.stringify(secretName)});
    process.stdout.write(JSON.stringify({ hosts, result }));
  `;

  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    timeout: 30_000,
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      HOME: dir,
      // Fake-but-well-formed AWS creds so awsCreds() resolves off env with no network, and the
      // "prox" placeholder guard does not reject them.
      OTC_AWS_ACCESS_KEY_ID: "AKIAFAKEFAKEFAKE",
      OTC_AWS_SECRET_ACCESS_KEY: "fakesecretfakesecret",
      AWS_ACCESS_KEY_ID: "", AWS_SECRET_ACCESS_KEY: "", AWS_SESSION_TOKEN: "",
      AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "", AWS_CONTAINER_CREDENTIALS_FULL_URI: "",
      ...env,
    },
  });
  const stdout = String(r.stdout || "");
  const stderr = String(r.stderr || "");
  const azSpawned = existsSync(marker);
  const parsed = stdout ? JSON.parse(stdout) : { hosts: [], result: null };
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  return { ...parsed, azSpawned, stderr };
}

const isAzureHost = (h) => /vault\.azure\.net$/.test(h) || /login\.microsoftonline\.com$/.test(h);

test("default backend: an SSM miss contacts SSM and NOTHING else -- no Key Vault, no AAD token mint", async () => {
  const { hosts, result, azSpawned } = await probe();
  assert.equal(result, null, "a genuinely absent secret must still resolve to null");
  assert.ok(hosts.some((h) => h.startsWith("ssm.")), "SSM must actually be consulted");
  assert.deepEqual(hosts.filter(isAzureHost), [], `must not contact any Azure host, got: ${hosts.join(", ")}`);
  assert.equal(azSpawned, false, "must not spawn the az CLI on a miss");
});

test("default backend: an SSM miss stays SSM-only EVEN WITH AZURE_SP_* present (the seat that would pay a real network round trip)", async () => {
  const { hosts, result, azSpawned } = await probe({
    env: {
      AZURE_SP_CLIENT_ID: "00000000-0000-0000-0000-000000000000",
      AZURE_SP_CLIENT_SECRET: "not-a-real-secret",
      AZURE_SP_TENANT_ID: "11111111-1111-1111-1111-111111111111",
    },
  });
  // The stub would have returned a usable token AND a vault value, so a still-walking ladder would
  // return "stub-vault-value" here rather than null. Asserting null proves the rung never ran.
  assert.equal(result, null, "must not resolve a value out of Key Vault under the ssm backend");
  assert.deepEqual(hosts.filter(isAzureHost), [], `must not contact any Azure host, got: ${hosts.join(", ")}`);
  assert.equal(azSpawned, false, "must not spawn the az CLI");
});

// AZURE_SP_* is REQUIRED here, not incidental: with no Azure credentials in the environment, every
// rung of the ladder returns null WITHOUT making a request (identity has no IDENTITY_ENDPOINT, sp has
// no client id, az exits non-zero), so even the un-fixed code contacts no Azure host and this
// counterfactual would "pass" while proving nothing. Found by running it RED.
test("COUNTERFACTUAL: SECRET_BACKEND=keyvault still walks the Azure ladder (the opt-in escape hatch is intact, and this test can detect the difference)", async () => {
  const { hosts, result } = await probe({
    env: {
      SECRET_BACKEND: "keyvault",
      AZURE_SP_CLIENT_ID: "00000000-0000-0000-0000-000000000000",
      AZURE_SP_CLIENT_SECRET: "not-a-real-secret",
      AZURE_SP_TENANT_ID: "11111111-1111-1111-1111-111111111111",
    },
  });
  assert.ok(
    hosts.some(isAzureHost),
    `under the explicit keyvault backend the Azure ladder MUST still run -- otherwise the two tests above prove nothing. Got: ${hosts.join(", ")}`,
  );
  assert.equal(result, "stub-vault-value", "the keyvault path must still return the vault's value");
});

test("a miss is SILENT when the store answered honestly (ParameterNotFound), so an optional-secret probe stops emitting a fake error", async () => {
  const { stderr } = await probe();
  assert.doesNotMatch(stderr, /via all auth paths/, "the misleading three-Azure-paths line must be gone");
  assert.doesNotMatch(stderr, /READ failed/, "'not present' is an answer, not a failure -- it must not log as one");
});

test("a miss is LOUD and names the real cause when the store could NOT be asked (no AWS credentials)", async () => {
  const { stderr, result } = await probe({
    env: {
      OTC_AWS_ACCESS_KEY_ID: "", OTC_AWS_SECRET_ACCESS_KEY: "",
      AWS_ACCESS_KEY_ID: "", AWS_SECRET_ACCESS_KEY: "",
    },
  });
  assert.equal(result, null);
  assert.match(stderr, /OTC_AWS_ACCESS_KEY_ID/, "must name the specific credential to set");
  assert.match(stderr, /kv-secret|aws-secret|SSM/i, "must identify which store could not be reached");
});

test("a miss is LOUD and says DENIED (not 'missing') when SSM answers AccessDenied -- a permissions error must never read as 'the secret does not exist'", async () => {
  const { stderr, result } = await probe({ ssmStatus: 400, ssmType: "AccessDeniedException" });
  assert.equal(result, null);
  assert.match(stderr, /denied/i, "an AccessDenied must be reported as a permissions problem");
  assert.doesNotMatch(stderr, /not found in/i, "must not describe a denial as an absent parameter");
});

// ── Sink redaction (2026-09-02, follow-up to CodeQL alerts 94/95 on PR #513) ──────────────────────
//
// ssmCall()'s transport catch builds `error-${e.message}` from a RAW Error, and that string reaches
// reportSsmMiss()'s console.error as `detail`. A raw Error.message is precisely what the fleet rule
// forbids in a log: an execFile or fetch rejection can embed the whole attempted request, including
// an Authorization header. This is the eval-runner incident (otchealth-mcp-server #256) in a
// different file, so it gets the same treatment: redact at the SINK, by SHAPE, never by trusting the
// producer.
//
// NOTE ON THE OTHER HALF OF THOSE ALERTS: CodeQL also flags `name` on these lines. That is a false
// positive and is deliberately NOT "fixed" -- `name` is a secret NAME (e.g. "mercury-api-token"),
// which the fleet rule explicitly permits ("names fine, values never"), and naming the secret is the
// entire diagnostic value of the line. CodeQL reaches it because token-keeper's `cfg.apiToken` (a
// name literal) and `apiToken` (the resolved value) are indistinguishable to its heuristic.

test("a poisoned upstream error message is REDACTED at the log sink: no bearer token or AWS key id survives to stderr", async () => {
  const BEARER = "Bearer eyJhbGciOiJIUzI1NiJ9.SUPERSECRETPAYLOADVALUE.c2lnbmF0dXJlZGF0YQ";
  const AKIA = "AKIAIOSFODNN7EXAMPLE";
  const { stderr, result } = await probe({
    ssmThrowMessage: `connect ECONNREFUSED while sending -H '${BEARER}' -H 'x-amz-security-token: ${AKIA}'`,
  });
  assert.equal(result, null);
  assert.doesNotMatch(stderr, /SUPERSECRETPAYLOADVALUE/, "the bearer payload must never reach stderr");
  assert.doesNotMatch(stderr, /eyJhbGciOiJIUzI1NiJ9/, "no part of the token may survive");
  assert.doesNotMatch(stderr, new RegExp(AKIA), "an AWS key id must never reach stderr");
  assert.match(stderr, /\[redacted\]/, "the redaction must be visible, not a silent truncation");
  // The benign, useful part of the message must survive -- redaction that destroys all diagnostic
  // value gets worked around by the next person instead of relied on.
  assert.match(stderr, /ECONNREFUSED/, "the actual transport cause must still be readable");
});

test("safeDetail(): shape-based, so a credential it has never seen before is still caught", async () => {
  const { safeDetail } = await import("../azure-secret.mjs");
  assert.match(safeDetail("Bearer abc.def.ghi"), /\[redacted\]/);
  assert.match(safeDetail("AKIAIOSFODNN7EXAMPLE"), /\[redacted\]/);
  assert.match(safeDetail(`authorization: ${"z".repeat(50)}`), /\[redacted\]/);
  assert.match(safeDetail("a".repeat(64)), /\[redacted\]/, "a long base64-ish run is credential-shaped");
  assert.match(safeDetail("f0".repeat(30)), /\[redacted\]/, "a long hex run is credential-shaped");
  // Benign details must pass through untouched, or the diagnostics become useless.
  assert.equal(safeDetail("ParameterNotFound"), "ParameterNotFound");
  assert.equal(safeDetail("http-403"), "http-403");
  assert.equal(safeDetail(""), "unspecified");
  assert.equal(safeDetail(null), "unspecified");
  assert.ok(safeDetail("x".repeat(400)).length <= 163, "an unbounded upstream string must be truncated");
});

test("FAIL ON OLD CODE: no console.error in azure-secret.mjs interpolates a raw ${detail}", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(AZURE_SECRET, "utf8");
  // The exact regression this guards: a future edit adding a diagnostic that drops safeDetail().
  const raw = src.match(/console\.error\([^;]*\$\{detail\}/g) || [];
  assert.deepEqual(raw, [], `every logged detail must go through safeDetail(); found raw: ${raw.join(" | ")}`);
});

// ── safeDetail() hardening (2026-09-02, auto-critic on #515 + one gap found while verifying it) ────
//
// EVERY assertion here checks that the SECRET SUBSTRING IS GONE, never that "[redacted]" appears.
// That distinction is the whole point: the Credential= case below PASSES a marker-presence check
// while leaking the key id, because an unrelated part of the same string does get redacted. A
// redactor must be proven to ACT, not to look like it acted.
test("safeDetail(): ASIA temporary key ids are redacted -- the ECS task-role case, which AKIA-only missed", async () => {
  const { safeDetail } = await import("../azure-secret.mjs");
  for (const prefix of ["AKIA", "ASIA", "AROA", "ANPA", "APKA"]) {
    const id = `${prefix}IOSFODNN7EXAMPLE`;
    assert.ok(!safeDetail(`creds ${id} used`).includes(id), `${prefix}-prefixed key id must not survive`);
  }
});

test("safeDetail(): a SigV4 Credential= field is redacted, not merely accompanied by a [redacted] marker", async () => {
  const { safeDetail } = await import("../azure-secret.mjs");
  const KEY = "ASIAIOSFODNN7EXAMPLE";
  const out = safeDetail(`authorization: AWS4-HMAC-SHA256 Credential=${KEY}/20260902/us-east-1/ssm/aws4_request`);
  assert.ok(!out.includes(KEY), `the key id must be gone, got: ${out}`);
  // Guards the exact false-confidence shape: marker present AND secret present.
  assert.ok(!(out.includes("[redacted]") && out.includes(KEY)), "a marker beside a live key is worse than no marker");
});

test("safeDetail(): base64url runs (underscore/hyphen) are redacted, not split under the length threshold", async () => {
  const { safeDetail } = await import("../azure-secret.mjs");
  const TOKEN = "abcd_efgh-ijkl_mnop_qrst-uvwx_yzab_cdef-ghij_klmn";
  assert.ok(!safeDetail(`tok ${TOKEN}`).includes(TOKEN), "a base64url token must not survive");
});

test("safeDetail(): a long lowercase path or kebab identifier is NOT redacted -- over-redaction destroys the diagnostic", async () => {
  const { safeDetail } = await import("../azure-secret.mjs");
  const PATH = "/otchealth/some-really-long-secret-name-goes-right-here";
  assert.ok(PATH.length >= 40, "fixture must actually exceed the long-run threshold to be meaningful");
  assert.equal(safeDetail(`reading ${PATH}`), `reading ${PATH}`);
});
