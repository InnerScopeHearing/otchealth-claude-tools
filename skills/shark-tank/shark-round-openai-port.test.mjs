// Tests for skills/shark-tank/shark-round.mjs's OpenAI-direct port (2026-08-28). Azure Foundry (the
// whole estate initModel()/ask() used exclusively) is permanently deleted -- verified HTTP 401 forever,
// not a transient outage (the same dead-dependency class as skills/doc-indexer/enrich.mjs's 2026-08-19
// finding). Ports to the same idiom already proven in skills/kb-memory/memory-librarian.mjs and
// skills/critic-pass/run.mjs.
//
// Offline by construction: every test stubs global.fetch in-process (save/restore), the same
// withStubbedFetch/withEnv convention as skills/kb-memory/tests/s3-blob-write-path.test.mjs. The
// bottom-of-file isMain guard added alongside this port is what makes importing this module here
// safe -- without it, the CLI's top-level try/await/catch would execute against process.argv the
// instant this file is imported, which would have made this whole test file unwritable before the
// port (this was a real gap: shark-tank previously had zero tests at all).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { initModel, ask } from "../shark-tank/shark-round.mjs";

async function withStubbedFetch(stub, run) {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try { return await run(); } finally { globalThis.fetch = original; }
}
async function withEnv(vars, run) {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  try { return await run(); } finally { for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
}

// Cleared on every test so a real sandbox credential never leaks in and every scenario is fully
// deterministic -- kvSecret()'s SSM/Key-Vault legs must never actually be reachable from these tests.
const NO_CREDS_ENV = {
  OPENAI_API_KEY: undefined, SHARK_MODEL: undefined,
  AWS_ACCESS_KEY_ID: undefined, AWS_SECRET_ACCESS_KEY: undefined, AWS_SESSION_TOKEN: undefined,
  OTC_AWS_ACCESS_KEY_ID: undefined, OTC_AWS_SECRET_ACCESS_KEY: undefined, OTC_AWS_SESSION_TOKEN: undefined,
  AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: undefined, AWS_CONTAINER_CREDENTIALS_FULL_URI: undefined,
  AZURE_SP_TENANT_ID: undefined, AZURE_SP_CLIENT_ID: undefined, AZURE_SP_CLIENT_SECRET: undefined,
  IDENTITY_ENDPOINT: undefined, IDENTITY_HEADER: undefined,
};

test("initModel() with no OPENAI_API_KEY and no resolvable fleet secret throws distinctly (never silently proceeds with an empty key)", async () => {
  let fetchCalled = false;
  await withEnv(NO_CREDS_ENV, () =>
    withStubbedFetch(
      async () => { fetchCalled = true; throw new Error("must not call fetch with zero resolvable AWS/Azure credentials"); },
      () => assert.rejects(() => initModel(), /missing openai-api-key/),
    ));
  assert.equal(fetchCalled, false, "with no AWS/Azure credentials resolvable at all, kvSecret's SSM/KeyVault legs must short-circuit without ever calling fetch");
});

test("THE OPENAI PATH WORKS: initModel() + ask() call api.openai.com with the standard-tier model and Bearer auth, and return the parsed content", async () => {
  let captured = null;
  await withEnv({ ...NO_CREDS_ENV, OPENAI_API_KEY: "sk-test-fake-not-real" }, async () => {
    await initModel();
    const content = await withStubbedFetch(async (url, opts) => {
      captured = { url: String(url), headers: opts.headers, body: JSON.parse(opts.body) };
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"reaction":"tough but fair","rating":7,"in":true}' } }] }) };
    }, () => ask("You are Mark Cuban.", "PITCH:\nAn app for X"));
    assert.equal(captured.url, "https://api.openai.com/v1/chat/completions");
    assert.equal(captured.headers.Authorization, "Bearer sk-test-fake-not-real");
    assert.equal(captured.body.model, "gpt-4.1", "default SHARK_MODEL resolves to the OpenAI standard tier (gpt-4.1), not an Azure Foundry deployment name");
    assert.equal(captured.body.temperature, 0.7, "the shark persona temperature (0.7) is unchanged by the provider port");
    assert.match(content, /tough but fair/);
  });
});

test("SHARK_MODEL overrides the default deployment verbatim (an explicit raw model id, not tier-resolved)", async () => {
  let captured = null;
  await withEnv({ ...NO_CREDS_ENV, OPENAI_API_KEY: "sk-test-fake-not-real", SHARK_MODEL: "gpt-4o" }, async () => {
    await initModel();
    await withStubbedFetch(async (url, opts) => {
      captured = JSON.parse(opts.body);
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "{}" } }] }) };
    }, () => ask("sys", "user"));
  });
  assert.equal(captured.model, "gpt-4o");
});

test("THE FAIL-LOUD CHECK: a genuine (non-429) OpenAI failure REJECTS distinctly and is never silently absorbed into a fake shark verdict", async () => {
  await withEnv({ ...NO_CREDS_ENV, OPENAI_API_KEY: "sk-test-fake-not-real" }, async () => {
    await initModel();
    await assert.rejects(
      () => withStubbedFetch(async () => ({ ok: false, status: 500, text: async () => "internal error" }), () => ask("sys", "user")),
      /chat 500/,
    );
  });
});

// ---- counterfactual: the ported file still calls OpenAI direct and keeps the Foundry path as a kept opt-in ----
test("shark-round.mjs calls OpenAI direct by default and keeps the Foundry path only behind LLM_PROVIDER=foundry/azure (not deleted)", () => {
  const src = readFileSync(new URL("../shark-tank/shark-round.mjs", import.meta.url), "utf8");
  assert.match(src, /api\.openai\.com\/v1\/chat\/completions/, "must call OpenAI direct");
  assert.match(src, /LLM_PROVIDER.*openai/i, "must default to the openai provider");
  assert.match(src, /azure-foundry-openai-endpoint/, "the Foundry opt-in path must still exist, not be deleted");
});

test("importing shark-round.mjs does NOT auto-execute the CLI against this test runner's own process.argv (the isMain guard)", () => {
  // If the isMain guard were missing or broken, importing this module at the top of this file would
  // already have called process.exit() before any test here ran -- every test in this file passing at
  // all is the real proof; this assertion just names the guarantee explicitly.
  assert.equal(typeof initModel, "function");
  assert.equal(typeof ask, "function");
});
