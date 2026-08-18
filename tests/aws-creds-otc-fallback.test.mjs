// awsCreds()'s OTC_-prefixed fallback (2026-08-18, the Azure-loss recovery).
//
// WHY THIS EXISTS. The agent sandbox injects its own placeholder into AWS_ACCESS_KEY_ID (verified
// live: 14 chars, prefix "prox"), which awsCreds() correctly refuses. That refusal is right, but it
// also means an operator cannot reliably hand an agent seat a real AWS credential through the
// standard variable -- whether the operator's value or the proxy's placeholder wins depends on
// injection order. With Azure permanently gone, that was the difference between every agent session
// being able to read the 444-secret SSM store and not.
//
// These tests pin the three properties that make the fallback safe: it does not disturb the existing
// order, it cannot admit a placeholder, and it only ever ADDS a path.
import { test } from "node:test";
import assert from "node:assert/strict";

const KEYS = [
  "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN",
  "OTC_AWS_ACCESS_KEY_ID", "OTC_AWS_SECRET_ACCESS_KEY", "OTC_AWS_SESSION_TOKEN",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", "AWS_CONTAINER_CREDENTIALS_FULL_URI",
];

/** Run `fn` with exactly `env` set for the keys above, restoring everything afterwards. */
async function withEnv(env, fn) {
  const prev = {};
  for (const k of KEYS) { prev[k] = process.env[k]; delete process.env[k]; }
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  try { return await fn(); }
  finally {
    for (const k of KEYS) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; }
  }
}

// awsCreds() is module-private, so it is exercised through ssmAvailable(), whose entire contract is
// "did credentials resolve" -- the exact thing under test, with no network call involved.
async function credsResolve() {
  const m = await import("../skills/kb-memory/aws-secret.mjs");
  return m.ssmAvailable();
}

test("a real AWS_ACCESS_KEY_ID still wins, unchanged by this addition", async () => {
  const ok = await withEnv(
    { AWS_ACCESS_KEY_ID: "AKIAREALLOOKINGKEY01", AWS_SECRET_ACCESS_KEY: "s".repeat(40) },
    credsResolve,
  );
  assert.equal(ok, true);
});

test("the sandbox placeholder alone still resolves to NO credentials", async () => {
  // The pre-existing guard. Signing with the placeholder yields a 403 that reads like a permissions
  // problem, which is far worse to debug than an honest "no credentials".
  const ok = await withEnv(
    { AWS_ACCESS_KEY_ID: "proxy-abcdefg", AWS_SECRET_ACCESS_KEY: "proxy-secret" },
    credsResolve,
  );
  assert.equal(ok, false);
});

test("OTC_AWS_* rescues the seat when the proxy placeholder occupies the standard name", async () => {
  // THE WHOLE POINT: this is the live sandbox's exact shape -- proxy placeholder in the standard
  // variable, operator's real key in the OTC_ name.
  const ok = await withEnv(
    {
      AWS_ACCESS_KEY_ID: "proxy-abcdefg",
      AWS_SECRET_ACCESS_KEY: "proxy-secret",
      OTC_AWS_ACCESS_KEY_ID: "AKIAREALLOOKINGKEY01",
      OTC_AWS_SECRET_ACCESS_KEY: "s".repeat(40),
    },
    credsResolve,
  );
  assert.equal(ok, true, "the OTC_ pair must be reachable when the standard name holds a placeholder");
});

test("OTC_AWS_* works on its own, with the standard names entirely absent", async () => {
  const ok = await withEnv(
    { OTC_AWS_ACCESS_KEY_ID: "AKIAREALLOOKINGKEY01", OTC_AWS_SECRET_ACCESS_KEY: "s".repeat(40) },
    credsResolve,
  );
  assert.equal(ok, true);
});

test("a placeholder cannot sneak in through the NEW door either", async () => {
  // The fallback must not become a way to reintroduce exactly what the original guard exists to
  // reject -- otherwise the fix would hand back a credential that 403s and looks like a permissions
  // failure, which is the "plausible wrong value" shape this fleet keeps getting bitten by.
  const ok = await withEnv(
    { OTC_AWS_ACCESS_KEY_ID: "proxy-abcdefg", OTC_AWS_SECRET_ACCESS_KEY: "proxy-secret" },
    credsResolve,
  );
  assert.equal(ok, false);
});

test("a half-set OTC_ pair resolves to NO credentials, never a partial one", async () => {
  assert.equal(await withEnv({ OTC_AWS_ACCESS_KEY_ID: "AKIAREALLOOKINGKEY01" }, credsResolve), false);
  assert.equal(await withEnv({ OTC_AWS_SECRET_ACCESS_KEY: "s".repeat(40) }, credsResolve), false);
});

test("nothing set at all resolves to NO credentials", async () => {
  assert.equal(await withEnv({}, credsResolve), false);
});
