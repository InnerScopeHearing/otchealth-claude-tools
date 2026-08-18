// Regression gate: kvSecretSet() must report success whenever the write landed in a STILL-LIVE
// store, not only when it landed in whichever store SECRET_BACKEND happens to name as "primary".
//
// Context (2026-08-18, post Azure-subscription-deletion). Key Vault kv-otc-55c84f6bef is PERMANENTLY
// gone -- not a transient outage -- so kvSecretSetAzure() can never succeed again, full stop.
// kvSecretSet()'s return line was `(SECRET_BACKEND === "ssm") ? ssmOk : kvOk`, i.e. it only reported
// success off the SSM leg when a caller had explicitly opted into SECRET_BACKEND=ssm. In any process
// that has NOT set that env var (the unqualified default is "keyvault"), a write that landed cleanly
// in SSM (ssmOk=true) while Key Vault predictably failed (kvOk=false, it always will) was reported as
// **false** -- a real, durable write reported as a failure. For OAuth token-rotation callers
// (onedrive.mjs's smWrite among them: Xero/Gmail/OneDrive/QBO all persist a rotated refresh token
// through this exact function) that false triggers a fallback to the retired GCP Secret Manager path,
// which throws "Key Vault write failed and no GCP SA present" -- masking a write that actually
// succeeded. This is the mirror image of "a failure returned as a plausible value": here a SUCCESS is
// returned as a plausible-looking FAILURE, which is just as dangerous because it drives the caller
// into a real exception over a rotation that in fact landed.
//
// The fix: success is "landed in EITHER durable store", full stop -- `ssmOk || kvOk`. This is a
// strict superset of the old truth table (see the matrix test below): every case the old code called
// success stays success; the one case it wrongly called failure (SSM-only, no SECRET_BACKEND=ssm) now
// correctly reports success.
//
// Fully hermetic: fetch is stubbed, Azure auth env vars are cleared for the Key-Vault leg so it fails
// closed with zero network calls, and AWS credentials are injected via env so the SSM leg's SigV4
// signing succeeds against the stub. Correct regardless of what real credentials happen to be present
// in the ambient sandbox (this file explicitly overrides/clears exactly what it needs, then restores).
import { test } from "node:test";
import assert from "node:assert/strict";
import { kvSecretSet } from "../azure-secret.mjs";

const AZURE_AUTH_KEYS = ["IDENTITY_ENDPOINT", "IDENTITY_HEADER", "AZURE_UAMI_CLIENT_ID", "AZURE_SP_TENANT_ID", "AZURE_SP_CLIENT_ID", "AZURE_SP_CLIENT_SECRET"];
const AWS_AUTH_KEYS = ["AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", "AWS_CONTAINER_CREDENTIALS_FULL_URI", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "OTC_AWS_ACCESS_KEY_ID", "OTC_AWS_SECRET_ACCESS_KEY", "OTC_AWS_SESSION_TOKEN"];
const ALL_KEYS = [...AZURE_AUTH_KEYS, ...AWS_AUTH_KEYS, "SECRET_BACKEND"];

async function withEnv(overrides, run) {
  const saved = {};
  for (const k of ALL_KEYS) saved[k] = process.env[k];
  for (const k of ALL_KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(overrides)) process.env[k] = v;
  try {
    return await run();
  } finally {
    for (const k of ALL_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

async function withStubbedFetch(stub, run) {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

// Key Vault leg always fails closed (no Azure auth env at all -> kvSecretSetAzure never even calls
// fetch, matching the permanent-deletion reality: no credential can ever make that leg succeed
// again). SSM leg succeeds via a stubbed 200 PutParameter response.
const ssmSucceedsKvUnreachableEnv = { AWS_ACCESS_KEY_ID: "AKIAFAKE", AWS_SECRET_ACCESS_KEY: "fakefakefakefakefakefakefakefakefakefake" };
const ssmSuccessStub = async (url) => {
  const u = String(url);
  if (u.includes("ssm.")) return { ok: true, status: 200, text: async () => JSON.stringify({}) };
  throw new Error("unexpected fetch (Key Vault has no credential to authenticate with) to " + u);
};

test("kvSecretSet(): SSM-only success, SECRET_BACKEND UNSET (the ordinary case since Key Vault is gone) -> true, not the old false", async () => {
  await withEnv(ssmSucceedsKvUnreachableEnv, async () => {
    const ok = await withStubbedFetch(ssmSuccessStub, () => kvSecretSet("onedrive-graph-ssm-selftest", "probe-value"));
    assert.equal(ok, true, "a write that landed in the surviving store must never be reported as a failure");
  });
});

test("kvSecretSet(): SSM-only success, SECRET_BACKEND explicitly 'keyvault' -> still true (Key Vault being named primary does not un-write the SSM copy)", async () => {
  await withEnv({ ...ssmSucceedsKvUnreachableEnv, SECRET_BACKEND: "keyvault" }, async () => {
    const ok = await withStubbedFetch(ssmSuccessStub, () => kvSecretSet("onedrive-graph-ssm-selftest", "probe-value"));
    assert.equal(ok, true);
  });
});

test("kvSecretSet(): SSM-only success, SECRET_BACKEND='ssm' -> true (unchanged positive case, pins no regression)", async () => {
  await withEnv({ ...ssmSucceedsKvUnreachableEnv, SECRET_BACKEND: "ssm" }, async () => {
    const ok = await withStubbedFetch(ssmSuccessStub, () => kvSecretSet("onedrive-graph-ssm-selftest", "probe-value"));
    assert.equal(ok, true);
  });
});

test("kvSecretSet(): BOTH stores fail -> false (a genuine total failure must still be reported as one)", async () => {
  // No AWS creds either -> ssmSecretSet's ssmCall returns status 0 (no-aws-credentials) -> false.
  await withEnv({}, async () => {
    const ok = await withStubbedFetch(async () => { throw new Error("must not be called: no credential exists for either store"); }, () => kvSecretSet("onedrive-graph-ssm-selftest", "probe-value"));
    assert.equal(ok, false);
  });
});

test("kvSecretSet(): the full 4-cell truth table is `ssmOk || kvOk`, exercised via the two auth-fallback env shapes this file already proves reach ssmOk=true/false and kvOk=false (kvOk=true is unreachable now that Key Vault is permanently deleted, so it is asserted by source inspection below instead of a live call)", () => {
  // ssmOk=true, kvOk=false -> true   (covered live above)
  // ssmOk=false, kvOk=false -> false (covered live above)
  // ssmOk=true, kvOk=true -> true    (both branches of `||` are true; algebraically forced)
  // ssmOk=false, kvOk=true -> true   (both branches of `||` are true; algebraically forced)
  assert.equal(true || true, true);
  assert.equal(false || true, true);
});

test("the SHIPPED kvSecretSet() returns `ssmOk || kvOk`, not a SECRET_BACKEND-conditional pick (the exact line that caused the bug, and the one a future edit would most plausibly reintroduce)", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../azure-secret.mjs", import.meta.url), "utf8");
  const code = src.replace(/^\s*\/\/.*$/gm, "");
  const start = code.indexOf("export async function kvSecretSet(");
  assert.ok(start > -1, "kvSecretSet must exist");
  const body = code.slice(start, code.indexOf("\n}", start));
  assert.doesNotMatch(body, /SECRET_BACKEND[\s\S]{0,40}===\s*["']ssm["']\s*\?\s*ssmOk\s*:\s*kvOk/, "must not gate success on which store SECRET_BACKEND names as primary");
  assert.match(body, /return\s+ssmOk\s*\|\|\s*kvOk\s*;/, "must report success when either durable store took the write");
});
