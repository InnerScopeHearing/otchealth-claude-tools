// ssmParamModifiedMs() is the age SOURCE for otc.fleet.token_age_hours: it must return full-precision
// milliseconds (unlike ssmListDetailed()'s `created`, which is truncated to a YYYY-MM-DD string and
// would make an hours-resolution metric meaningless), never decrypt a value it does not need, and
// return null (not throw) for anything it cannot answer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ssmParamModifiedMs } from "../skills/kb-memory/aws-secret.mjs";

async function withEnvAndFetch(stub, run) {
  const prevAk = process.env.AWS_ACCESS_KEY_ID, prevSk = process.env.AWS_SECRET_ACCESS_KEY;
  process.env.AWS_ACCESS_KEY_ID = "AKIATESTFAKE";
  process.env.AWS_SECRET_ACCESS_KEY = "test-secret-fake";
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try { return await run(); }
  finally {
    globalThis.fetch = original;
    if (prevAk === undefined) delete process.env.AWS_ACCESS_KEY_ID; else process.env.AWS_ACCESS_KEY_ID = prevAk;
    if (prevSk === undefined) delete process.env.AWS_SECRET_ACCESS_KEY; else process.env.AWS_SECRET_ACCESS_KEY = prevSk;
  }
}

test("returns full-precision epoch milliseconds from GetParameter's LastModifiedDate (a fractional epoch-seconds float)", async () => {
  const lastModifiedSeconds = 1755000000.123456; // AWS returns this as a float, not an integer
  const ms = await withEnvAndFetch(
    async () => ({ status: 200, text: async () => JSON.stringify({ Parameter: { Name: "/otchealth/qbo-refresh-otchealth", LastModifiedDate: lastModifiedSeconds } }) }),
    () => ssmParamModifiedMs("qbo-refresh-otchealth"),
  );
  assert.equal(ms, Math.round(lastModifiedSeconds * 1000));
});

test("never requests decryption -- metadata freshness never needs to materialize a plaintext secret value", async () => {
  let seenBody = null;
  await withEnvAndFetch(
    async (url, init) => { seenBody = JSON.parse(init.body); return { status: 200, text: async () => JSON.stringify({ Parameter: { LastModifiedDate: 1755000000 } }) }; },
    () => ssmParamModifiedMs("some-secret"),
  );
  assert.equal(seenBody.WithDecryption, false);
  assert.equal(seenBody.Name, "/otchealth/some-secret");
});

test("a nonexistent parameter (404) returns null, never throws", async () => {
  const ms = await withEnvAndFetch(
    async () => ({ status: 400, text: async () => JSON.stringify({ __type: "ParameterNotFound" }) }),
    () => ssmParamModifiedMs("does-not-exist"),
  );
  assert.equal(ms, null);
});

test("no AWS credentials resolvable returns null, never throws (the ordinary case on a bare seat)", async () => {
  const prev = {
    ak: process.env.AWS_ACCESS_KEY_ID, sk: process.env.AWS_SECRET_ACCESS_KEY,
    rel: process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI, full: process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI,
  };
  delete process.env.AWS_ACCESS_KEY_ID; delete process.env.AWS_SECRET_ACCESS_KEY;
  delete process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI; delete process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI;
  let fetchCalled = false;
  try {
    const original = globalThis.fetch;
    globalThis.fetch = async () => { fetchCalled = true; return { status: 200, text: async () => "{}" }; };
    try {
      const ms = await ssmParamModifiedMs("anything");
      assert.equal(ms, null);
      assert.equal(fetchCalled, false, "must not attempt a signed call with no credentials to sign with");
    } finally { globalThis.fetch = original; }
  } finally {
    for (const [k, v] of Object.entries({ AWS_ACCESS_KEY_ID: prev.ak, AWS_SECRET_ACCESS_KEY: prev.sk, AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: prev.rel, AWS_CONTAINER_CREDENTIALS_FULL_URI: prev.full })) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});
