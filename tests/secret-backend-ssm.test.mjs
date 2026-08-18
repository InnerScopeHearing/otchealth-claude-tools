// Regression suite for the 2026-08-18 Azure-exit cutover of the fleet secret resolver
// (skills/kb-memory/azure-secret.mjs + setup/get-secret.mjs).
//
// Azure subscription 55c84f6b is permanently gone. Three defects made that outage worse than it had
// to be, and each one is pinned here:
//
//   1. SECRET_BACKEND defaulted to "keyvault" and was set NOWHERE in the fleet, so every read
//      addressed a dead store first and paid the full three-path auth walk before reaching the SSM
//      mirror that already held the value.
//   2. Inside kvSecret()'s per-credential loop, a Key Vault reply that was not exactly 401/403
//      (a 5xx, a 404, a proxy error) hit an early `return null` that returned from kvSecret ITSELF,
//      jumping clean over the SSM fallback below it. The fallback existed but was unreachable for a
//      whole class of failures.
//   3. kvSecretSet() dual-wrote SSM then Key Vault but returned kvOk unless SECRET_BACKEND was
//      "ssm" -- which it never was -- so setup/set-secret.mjs printed FAILED and exited 1 on every
//      rotation that had in fact landed durably in SSM.
//
// METHOD. Everything that touches the network runs as a SUBPROCESS with a --import fetch stub, the
// pattern already established by skills/kb-memory/tests/index-one-dispatch.test.mjs. Subprocesses
// are not a stylistic choice here:
//   - azure-secret.mjs caches minted tokens at module scope, so in-process cases would leak state
//     into each other and the third test would silently exercise the first test's token.
//   - azCliToken() shells out to a REAL `az` binary that is present on PATH in CI and in the fleet
//     sandbox. Left alone it would make a live Azure call from a unit test. Each child gets a PATH
//     with no `az` on it, so that credential path deterministically yields no token.
//   - The fleet sandbox exports AWS_ACCESS_KEY_ID="prox..." (a proxy placeholder aws-secret.mjs
//     deliberately rejects), so the child env must set real-shaped test credentials or SSM would be
//     skipped for reasons unrelated to what is under test.
// No test here reaches a real network, a real vault, or a real parameter store.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFileSync, mkdtempSync, readFileSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, delimiter } from "node:path";
import { fileURLToPath } from "node:url";

const execFileP = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const AZURE_SECRET = join(ROOT, "skills", "kb-memory", "azure-secret.mjs");
const GET_SECRET = join(ROOT, "setup", "get-secret.mjs");

const VAULT = "kv-unit-test";
const REGION = "us-east-1";
const SSM_HOST = `ssm.${REGION}.amazonaws.com`;
const VAULT_HOST = `${VAULT}.vault.azure.net`;

/**
 * A preload module that replaces globalThis.fetch and answers the three hosts this code can talk
 * to, logging every URL so a test can assert WHICH store was actually reached.
 *
 * Exact host comparison, never a substring test on the whole URL: a URL that merely mentions a host
 * in a path or query would satisfy a substring check, and proving which host was contacted is the
 * entire point of several of these assertions.
 *
 * @param opts.vaultStatus  HTTP status the Key Vault secret GET/PUT returns (200 serves a value)
 * @param opts.ssmValue     value GetParameter returns, or null for a miss (ParameterNotFound)
 * @param opts.ssmPutStatus HTTP status PutParameter returns
 */
function preloadSource(logPath, opts) {
  const { vaultStatus = 500, ssmValue = null, ssmPutStatus = 200, vaultValue = "FROM-KEYVAULT" } = opts;
  return `
import { appendFileSync } from "node:fs";
function isHost(u, host) { try { return new URL(u).host === host; } catch { return false; } }
const json = (status, body) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json" },
});
globalThis.fetch = async (url, init) => {
  const u = String(typeof url === "string" ? url : (url && url.url) || url);
  appendFileSync(${JSON.stringify(logPath)}, u + "\\n");

  // Entra token endpoint: always mints, so the vault status below is what the test is varying.
  if (isHost(u, "login.microsoftonline.com")) {
    return json(200, { access_token: "unit-test-token", expires_in: 3600 });
  }

  if (isHost(u, ${JSON.stringify(VAULT_HOST)})) {
    const status = ${JSON.stringify(vaultStatus)};
    if (status === 200) return json(200, { value: ${JSON.stringify(vaultValue)} });
    return new Response("vault unavailable", { status });
  }

  if (isHost(u, ${JSON.stringify(SSM_HOST)})) {
    const target = (init && init.headers && (init.headers["x-amz-target"] || init.headers["X-Amz-Target"])) || "";
    if (String(target).endsWith("PutParameter")) {
      const st = ${JSON.stringify(ssmPutStatus)};
      return st === 200 ? json(200, { Version: 1 }) : json(st, { __type: "AccessDeniedException" });
    }
    const v = ${JSON.stringify(ssmValue)};
    if (v == null) return json(400, { __type: "ParameterNotFound" });
    return json(200, { Parameter: { Name: "/otchealth/x", Value: v, Type: "SecureString" } });
  }

  throw new Error("TEST-FAIL: unexpected host reached: " + u);
};
`;
}

/**
 * Run a driver snippet in a child process with the fetch stub installed and a fully controlled env.
 * Returns { stdout, stderr, code, urls } where urls is every host the stub saw.
 */
async function runChild(driverSource, { env = {}, preload = {}, script = null, args = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "secret-backend-"));
  const logPath = join(dir, "urls.log");
  writeFileSync(logPath, "");
  const preloadPath = join(dir, "preload.mjs");
  writeFileSync(preloadPath, preloadSource(logPath, preload));

  let target = script;
  if (!target) {
    target = join(dir, "driver.mjs");
    writeFileSync(target, driverSource);
  }

  // PATH deliberately excludes any directory containing `az`, so azCliToken() cannot make a live
  // Azure call from a unit test. It resolves to null exactly as it does on a seat without az.
  const safePath = (process.env.PATH || "")
    .split(delimiter)
    .filter((p) => p && !existsSync(join(p, "az")))
    .join(delimiter);

  const childEnv = {
    PATH: safePath,
    HOME: dir,
    NODE_OPTIONS: `--import ${preloadPath}`,
    AZURE_KEYVAULT_NAME: VAULT,
    AWS_REGION: REGION,
    AWS_SSM_PREFIX: "/otchealth",
    // Real-shaped test credentials: aws-secret.mjs rejects a key beginning "prox" (the sandbox
    // proxy placeholder), which the ambient environment sets.
    AWS_ACCESS_KEY_ID: "AKIAUNITTESTONLY0000",
    AWS_SECRET_ACCESS_KEY: "unit-test-secret-not-a-real-credential",
    // Azure SP creds so spToken() has something to exchange; the stub mints for any tenant.
    AZURE_SP_CLIENT_ID: "unit-test-client",
    AZURE_SP_CLIENT_SECRET: "unit-test-secret",
    AZURE_SP_TENANT_ID: "unit-test-tenant",
    ...env,
  };
  // Explicitly ensure the container-credentials endpoints are absent: if either is set, awsCreds()
  // tries the task-role path first and the stub would see an unexpected host.
  delete childEnv.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI;
  delete childEnv.AWS_CONTAINER_CREDENTIALS_FULL_URI;
  delete childEnv.AWS_SESSION_TOKEN;
  delete childEnv.IDENTITY_ENDPOINT;
  delete childEnv.IDENTITY_HEADER;

  let stdout = "", stderr = "", code = 0;
  try {
    const r = await execFileP(process.execPath, [target, ...args], { env: childEnv, timeout: 60_000 });
    stdout = r.stdout; stderr = r.stderr;
  } catch (e) {
    stdout = e.stdout || ""; stderr = e.stderr || ""; code = e.code ?? 1;
  }
  const urls = readFileSync(logPath, "utf8").split("\n").filter(Boolean);
  return { stdout, stderr, code, urls, dir };
}

const hosts = (urls) => urls.map((u) => { try { return new URL(u).host; } catch { return u; } });

// ── 1. The default ────────────────────────────────────────────────────────────
// Pure function, no network, so this one is safe to exercise in-process.
test("secretBackend() defaults to ssm when SECRET_BACKEND is unset (was: keyvault)", async () => {
  const prev = process.env.SECRET_BACKEND;
  const { secretBackend } = await import(`${AZURE_SECRET}?case=default`);
  try {
    delete process.env.SECRET_BACKEND;
    assert.equal(secretBackend(), "ssm", "unset must resolve to the live store, not the retired one");

    process.env.SECRET_BACKEND = "";
    assert.equal(secretBackend(), "ssm", "empty string is unset, not a selection");

    process.env.SECRET_BACKEND = "keyvault";
    assert.equal(secretBackend(), "keyvault", "an explicit legacy opt-in must still be honoured");

    process.env.SECRET_BACKEND = "SSM";
    assert.equal(secretBackend(), "ssm", "case-insensitive");

    // A typo must not silently route the fleet at a store that cannot answer.
    process.env.SECRET_BACKEND = "keyvaultt";
    assert.equal(secretBackend(), "ssm", "an unrecognised value must fall back to the LIVE store");
  } finally {
    if (prev === undefined) delete process.env.SECRET_BACKEND;
    else process.env.SECRET_BACKEND = prev;
  }
});

test("the ssm default is not merely a default: no CODE path still hardcodes the keyvault fallback", async () => {
  // Comments are stripped first, deliberately. The fix's own history note quotes the old expression
  // verbatim so a future reader understands what changed, and that note is worth keeping -- but a
  // naive scan of the raw file would match it and make this guard permanently red, which is how a
  // useful guard gets deleted. Strip comments, then assert on what actually executes.
  const src = readFileSync(AZURE_SECRET, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
  assert.equal(
    /SECRET_BACKEND\s*\|\|\s*["']keyvault["']/.test(src),
    false,
    'no live `process.env.SECRET_BACKEND || "keyvault"` may remain: that expression was the bug, in three places',
  );
  // And the replacement must actually be the single source of truth.
  assert.match(src, /export function secretBackend\s*\(/, "the default must live in one named, testable helper");
});

// ── 2. The unreachable fallback (evidence b) ──────────────────────────────────
// The regression is specific: with Key Vault as PRIMARY, a non-401/403 reply used to return from
// kvSecret() itself and skip the SSM fallback entirely. Each status below is one that took that
// early-return branch.
for (const status of [500, 503, 404]) {
  test(`Key Vault HTTP ${status} still falls through to the SSM fallback (was: returned null, skipping SSM)`, async () => {
    const { stdout, urls, code } = await runChild(
      `import { kvSecret } from ${JSON.stringify(AZURE_SECRET)};
       const v = await kvSecret("unit-test-secret");
       process.stdout.write("RESULT:" + String(v));`,
      { env: { SECRET_BACKEND: "keyvault" }, preload: { vaultStatus: status, ssmValue: "FROM-SSM" } },
    );
    assert.equal(code, 0, `child exited ${code}`);
    assert.match(stdout, /RESULT:FROM-SSM/, `a ${status} from Key Vault must not stop the resolver before SSM`);
    assert.ok(hosts(urls).includes(VAULT_HOST), "Key Vault must still be tried first when it is the primary");
    assert.ok(hosts(urls).includes(SSM_HOST), `SSM was never contacted after the ${status} -- the fallback is unreachable again`);
  });
}

test("Key Vault 401 still escalates through the other Azure credentials before SSM (policy preserved)", async () => {
  // The credential-escalation policy is deliberately UNCHANGED by the fix: a 401/403 means "this
  // credential is not allowed", which is worth retrying with another identity. Only the
  // cross-STORE fallback was made unconditional. If this ever stops trying the vault more than
  // once, the RBAC-masking fix from 2026-07-08 has been undone.
  const { stdout, urls } = await runChild(
    `import { kvSecret } from ${JSON.stringify(AZURE_SECRET)};
     const v = await kvSecret("unit-test-secret");
     process.stdout.write("RESULT:" + String(v));`,
    { env: { SECRET_BACKEND: "keyvault" }, preload: { vaultStatus: 401, ssmValue: "FROM-SSM" } },
  );
  assert.match(stdout, /RESULT:FROM-SSM/);
  assert.ok(hosts(urls).filter((h) => h === VAULT_HOST).length >= 1, "the vault must be attempted");
  assert.ok(hosts(urls).includes(SSM_HOST), "and SSM must still be reached once every credential is exhausted");
});

test("with the ssm default, a hit is served from SSM and Key Vault is never contacted", async () => {
  const { stdout, urls } = await runChild(
    `import { kvSecret } from ${JSON.stringify(AZURE_SECRET)};
     const v = await kvSecret("unit-test-secret");
     process.stdout.write("RESULT:" + String(v));`,
    { preload: { vaultStatus: 200, vaultValue: "FROM-KEYVAULT", ssmValue: "FROM-SSM" } },
  );
  assert.match(stdout, /RESULT:FROM-SSM/, "SSM is the primary; its value wins");
  assert.equal(
    hosts(urls).includes(VAULT_HOST), false,
    "the retired vault must not be touched at all on a successful SSM read -- avoiding that dead round trip is the point of the cutover",
  );
});

test("with the ssm default, an SSM miss still falls through to Key Vault (transition safety net)", async () => {
  const { stdout, urls } = await runChild(
    `import { kvSecret } from ${JSON.stringify(AZURE_SECRET)};
     const v = await kvSecret("unit-test-secret");
     process.stdout.write("RESULT:" + String(v));`,
    { preload: { vaultStatus: 200, vaultValue: "FROM-KEYVAULT", ssmValue: null } },
  );
  assert.match(stdout, /RESULT:FROM-KEYVAULT/, "a secret that exists only in the vault must still resolve during the transition");
  assert.ok(hosts(urls).includes(SSM_HOST), "SSM must be tried first");
});

test("kvSecret still returns null rather than throwing when neither store can serve (fail-open contract)", async () => {
  // ~400 call sites depend on kvSecret never throwing. A cutover that made it throw would convert a
  // degraded fleet into a dead one, so this contract is pinned explicitly.
  const { stdout, code } = await runChild(
    `import { kvSecret } from ${JSON.stringify(AZURE_SECRET)};
     let threw = false;
     let v;
     try { v = await kvSecret("unit-test-secret"); } catch { threw = true; }
     process.stdout.write("THREW:" + threw + " RESULT:" + String(v));`,
    { preload: { vaultStatus: 500, ssmValue: null } },
  );
  assert.equal(code, 0);
  assert.match(stdout, /THREW:false/, "kvSecret must never throw -- its header promises fail-open and callers rely on it");
  assert.match(stdout, /RESULT:null/);
});

test("kvSecretStatus reports which store answered, without changing kvSecret's contract", async () => {
  const { stdout } = await runChild(
    `import { kvSecretStatus } from ${JSON.stringify(AZURE_SECRET)};
     const r = await kvSecretStatus("unit-test-secret");
     process.stdout.write(JSON.stringify({ value: r.value, source: r.source, backend: r.backend, ssmTried: r.ssmTried }));`,
    { preload: { vaultStatus: 500, ssmValue: "FROM-SSM" } },
  );
  const r = JSON.parse(stdout);
  assert.equal(r.value, "FROM-SSM");
  assert.equal(r.source, "ssm", "a health caller needs to know WHICH store served the value");
  assert.equal(r.backend, "ssm");
  assert.equal(r.ssmTried, true);
});

// ── 3. The write path (evidence c) ────────────────────────────────────────────
test("kvSecretSet reports SUCCESS when the SSM write succeeds and Key Vault is dead (was: reported FAILED)", async () => {
  const { stdout, urls } = await runChild(
    `import { kvSecretSet } from ${JSON.stringify(AZURE_SECRET)};
     const ok = await kvSecretSet("unit-test-secret", "unit-test-value");
     process.stdout.write("OK:" + ok);`,
    { preload: { vaultStatus: 403, ssmPutStatus: 200 } },
  );
  assert.match(stdout, /OK:true/, "the rotation landed durably in the live store; reporting failure would be a lie");
  assert.ok(hosts(urls).includes(SSM_HOST), "SSM must actually be written");
  assert.equal(
    hosts(urls).includes(VAULT_HOST), false,
    "with ssm primary the dead vault mirror leg is skipped by default (SECRET_MIRROR_KEYVAULT=1 re-arms it)",
  );
});

test("kvSecretSet reports FAILURE when the SSM write itself fails", async () => {
  const { stdout } = await runChild(
    `import { kvSecretSet } from ${JSON.stringify(AZURE_SECRET)};
     const ok = await kvSecretSet("unit-test-secret", "unit-test-value");
     process.stdout.write("OK:" + ok);`,
    { preload: { vaultStatus: 403, ssmPutStatus: 403 } },
  );
  assert.match(stdout, /OK:false/, "a rotation that reached NO store must never report success");
});

test("SECRET_MIRROR_KEYVAULT=1 re-arms the dual-write, and SSM success still decides the verdict", async () => {
  const { stdout, urls } = await runChild(
    `import { kvSecretSet } from ${JSON.stringify(AZURE_SECRET)};
     const ok = await kvSecretSet("unit-test-secret", "unit-test-value");
     process.stdout.write("OK:" + ok);`,
    { env: { SECRET_MIRROR_KEYVAULT: "1" }, preload: { vaultStatus: 403, ssmPutStatus: 200 } },
  );
  assert.match(stdout, /OK:true/, "ssm is the active primary, so its success is the verdict");
  assert.ok(hosts(urls).includes(VAULT_HOST), "the mirror leg must actually run when explicitly re-armed");
});

test("SECRET_BACKEND=keyvault keeps the legacy write semantics exactly (Key Vault decides)", async () => {
  const { stdout, urls } = await runChild(
    `import { kvSecretSet } from ${JSON.stringify(AZURE_SECRET)};
     const ok = await kvSecretSet("unit-test-secret", "unit-test-value");
     process.stdout.write("OK:" + ok);`,
    { env: { SECRET_BACKEND: "keyvault" }, preload: { vaultStatus: 403, ssmPutStatus: 200 } },
  );
  assert.match(stdout, /OK:false/, "under the legacy backend the Key Vault result is still the verdict");
  assert.ok(hosts(urls).includes(VAULT_HOST), "and the dual-write still runs unconditionally there");
});

// ── 4. The CLI every CLAUDE.md tells agents to run (evidence e) ───────────────
test("get-secret.mjs resolves via SSM when Key Vault is unreachable, and emits no trailing newline", async () => {
  const { stdout, code, urls } = await runChild(null, {
    script: GET_SECRET,
    args: ["unit-test-secret"],
    preload: { vaultStatus: 500, ssmValue: "FROM-SSM" },
  });
  assert.equal(code, 0, "the fleet's most-documented command must succeed off the live store");
  assert.equal(stdout, "FROM-SSM", "exact bytes, no trailing newline: callers substitute this into header values");
  assert.ok(hosts(urls).includes(SSM_HOST));
});

test("get-secret.mjs works with NO Azure SP credentials at all (was: exited 1 before even trying)", async () => {
  // The old script exited 1 up front unless AZURE_SP_* were all set. On an AWS-only seat that made
  // it fail 100% of the time while the value sat readable in SSM.
  const { stdout, code, urls } = await runChild(null, {
    script: GET_SECRET,
    args: ["unit-test-secret"],
    env: { AZURE_SP_CLIENT_ID: "", AZURE_SP_CLIENT_SECRET: "", AZURE_SP_TENANT_ID: "" },
    preload: { vaultStatus: 500, ssmValue: "FROM-SSM" },
  });
  assert.equal(code, 0);
  assert.equal(stdout, "FROM-SSM");
  assert.equal(hosts(urls).includes("login.microsoftonline.com"), false, "with no SP creds there is nothing to exchange");
});

test("get-secret.mjs writes an outfile at mode 600 and prints nothing to stdout", async () => {
  // Absolute path into a per-run temp dir: a relative outfile would be resolved against this
  // process's cwd and litter the repo working tree with a materialized-secret file.
  const out = join(mkdtempSync(join(tmpdir(), "get-secret-out-")), "materialized.key");
  const { stdout, stderr, code } = await runChild(null, {
    script: GET_SECRET,
    args: ["unit-test-secret", out],
    preload: { vaultStatus: 500, ssmValue: "FROM-SSM" },
  });
  assert.equal(code, 0, stderr);
  assert.equal(stdout, "", "outfile mode must keep stdout clean; diagnostics go to stderr");
  assert.equal(readFileSync(out, "utf8"), "FROM-SSM");
  assert.equal(statSync(out).mode & 0o777, 0o600, "a materialized secret must never be world-readable");
});

test("get-secret.mjs exits non-zero when neither store has the secret", async () => {
  const { code, stderr } = await runChild(null, {
    script: GET_SECRET,
    args: ["unit-test-secret"],
    preload: { vaultStatus: 500, ssmValue: null },
  });
  assert.equal(code, 1, "a miss must be loud: callers branch on the exit code");
  assert.match(stderr, /not available from either store/);
});

test("get-secret-azure.mjs is an alias that resolves identically (no second implementation)", async () => {
  const { stdout, code } = await runChild(null, {
    script: join(ROOT, "setup", "get-secret-azure.mjs"),
    args: ["unit-test-secret"],
    preload: { vaultStatus: 500, ssmValue: "FROM-SSM" },
  });
  assert.equal(code, 0);
  assert.equal(stdout, "FROM-SSM", "the -azure alias must inherit the same fallback, not re-open-code a vault-only read");
});
