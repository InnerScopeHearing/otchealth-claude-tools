import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { infer, buildRegistry, writeRegistry } from "../skills/vault-sync/vault-registry.mjs";

// vault-registry now enumerates AWS SSM Parameter Store (2026-08-28 port; was Azure Key Vault, which
// died with the permanently deleted Azure subscription, 2026-08-13; before that, retired GCP Secret
// Manager). The classifier and the markdown/jsonl builder are pure and source-agnostic (SSM names are
// a 1:1 mirror of the old Key Vault/SM ids), so they are unit-testable without touching any store. The
// main() writer is guarded behind an isMain check so importing this module here does NOT hit AWS.

const VAULT_REGISTRY_MJS = fileURLToPath(new URL("../skills/vault-sync/vault-registry.mjs", import.meta.url));

test("infer() classifies service by known prefix", () => {
  assert.equal(infer("github-app-private-key").service, "GitHub");
  assert.equal(infer("azure-commons-storage-key").service, "Azure");
  assert.equal(infer("asc-api-key-p8").service, "Apple");
  assert.equal(infer("plaid-access-token-wellsfargo").service, "Plaid");
});

test("infer() classifies type", () => {
  assert.equal(infer("github-app-id").type, "OAuth client ID"); // app-id$
  assert.equal(infer("asc-api-key-p8").type, "p8 cert");
  assert.equal(infer("xero-refresh-token-otchealth").type, "OAuth refresh token");
  assert.equal(infer("azure-commons-storage-account").type, "config non-secret"); // account$
});

test("infer() rings MedReview as PHI-BAA, everything else non-PHI", () => {
  assert.equal(infer("medreview-db-url").ring, "PHI-BAA");
  assert.equal(infer("github-app-id").ring, "non-PHI");
  assert.equal(infer("azure-openai-key").ring, "non-PHI");
});

test("buildRegistry groups by service, counts PHI, and never emits a VALUE (names+metadata only)", () => {
  const secrets = [
    { id: "github-app-id", created: "2026-06-17" },
    { id: "github-app-private-key", created: "2026-06-17" },
    { id: "medreview-db-url", created: "2026-05-01" },
    { id: "azure-openai-key", created: "2026-06-14" },
  ];
  const { md, jsonl, rows, services, phi } = buildRegistry(secrets);
  assert.equal(rows.length, 4);
  assert.equal(phi, 1, "medreview-* counts as PHI-BAA");
  assert.ok(services.includes("GitHub") && services.includes("Azure") && services.includes("MedReview"));
  assert.match(md, /## GitHub \(2\)/, "GitHub service groups its 2 secrets");
  assert.match(md, /AWS SSM Parameter Store/, "header names the live store (SSM), not Secret Manager or Key Vault");
  // the registry is a NAMES view; the jsonl rows carry only id + classification + created, never a value.
  for (const line of jsonl.trim().split("\n")) {
    const r = JSON.parse(line);
    assert.deepEqual(Object.keys(r).sort(), ["created", "env", "id", "ring", "service", "type"]);
  }
});

// ---- writeRegistry: S3-backed commons write (2026-08-28 Azure-retirement port) --------------------
// Mirrors the fetch-mock pattern tests/fleet-search-s3.test.mjs already established for a sibling port:
// stub globalThis.fetch and exercise the REAL underlying s3-blob.mjs SigV4 signing (via commons-store's
// cPut), rather than mocking cPut itself -- this proves the write actually reaches the right bucket/key
// through the real code path, not just that some function was called.
import { _resetCredsCacheForTests } from "../skills/kb-memory/s3-blob.mjs";

const S3_BUCKET = "otchealth-brain-dr-55c84f6b";
const S3_KEY_PREFIX = "otchealthcommons/company-journal/";
const S3_HOST = `${S3_BUCKET}.s3.us-east-1.amazonaws.com`;

async function withStubbedFetch(stub, run) {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try { return await run(); } finally { globalThis.fetch = original; }
}
async function withEnv(vars, run) {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; process.env[k] = vars[k]; }
  _resetCredsCacheForTests();
  try { return await run(); } finally {
    for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    _resetCredsCacheForTests();
  }
}
const FAKE_CREDS = { AWS_ACCESS_KEY_ID: "AKIAUNITTESTFAKE0000", AWS_SECRET_ACCESS_KEY: "unit-test-fake-secret-access-key-not-real" };

function makeStore(seed = {}) {
  const objects = new Map(Object.entries(seed));
  const calls = [];
  const stub = async (url, opts = {}) => {
    const u = String(url);
    const host = new URL(u).hostname;
    const method = (opts.method || "GET").toUpperCase();
    calls.push({ method, url: u });
    if (!host.includes(".s3.") || !host.endsWith(".amazonaws.com")) return { ok: false, status: 404, text: async () => "not found" };
    const { pathname } = new URL(u);
    if (method === "PUT") {
      objects.set(pathname, Buffer.isBuffer(opts.body) ? opts.body.toString("utf8") : String(opts.body));
      return { ok: true, status: 200, headers: new Map([["etag", '"e"']]), text: async () => "" };
    }
    throw new Error("unexpected method " + method);
  };
  return { stub, objects, calls };
}

test("writeRegistry: the registry content lands at _VAULT/registry.md and .jsonl via the S3-backed commons store, containing SSM-derived rows", async () => {
  const secrets = [{ id: "github-app-id", created: "2026-08-01" }, { id: "azure-openai-key", created: "2026-06-14" }];
  const { md, jsonl } = buildRegistry(secrets, "AWS SSM Parameter Store (/otchealth)");
  const world = makeStore();
  await withEnv(FAKE_CREDS, () => withStubbedFetch(world.stub, () => writeRegistry(md, jsonl)));

  const mdPath = "/" + S3_KEY_PREFIX + "_VAULT/registry.md";
  const jsonlPath = "/" + S3_KEY_PREFIX + "_VAULT/registry.jsonl";
  assert.ok(world.objects.has(mdPath), "registry.md must land at _VAULT/registry.md in the commons");
  assert.ok(world.objects.has(jsonlPath), "registry.jsonl must land at _VAULT/registry.jsonl in the commons");
  assert.match(world.objects.get(mdPath), /github-app-id/, "the written markdown must contain the SSM-derived rows");
  assert.match(world.objects.get(mdPath), /AWS SSM Parameter Store/, "the written markdown must name SSM as the source");
  assert.match(world.objects.get(jsonlPath), /github-app-id/, "the written jsonl must contain the SSM-derived rows");
  assert.equal(world.calls.length, 2, "exactly two PUTs (registry.md + registry.jsonl), nothing else");
  assert.ok(world.calls.every((c) => new URL(c.url).host.endsWith(S3_HOST)), "must only ever reach the S3 host, never Azure");
});

test("writeRegistry: a write failure propagates (fails LOUD, never a silent partial registry)", async () => {
  const throwingStub = async () => ({ ok: false, status: 500, text: async () => "internal error" });
  await assert.rejects(
    () => withEnv(FAKE_CREDS, () => withStubbedFetch(throwingStub, () => writeRegistry("# md", "{}\n"))),
    /s3 put 500/,
  );
});

// ---- counterfactual guard: no Azure code remains in the ported file --------------------------------
test("vault-registry.mjs no longer talks to Azure (Key Vault listing or Blob write) -- 2026-08-28 port", () => {
  const src = readFileSync(VAULT_REGISTRY_MJS, "utf8");
  const stripped = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
  assert.doesNotMatch(stripped, /vault\.azure\.net/, "must not list Key Vault directly");
  assert.doesNotMatch(stripped, /blob\.core\.windows\.net/, "must not construct any Azure Blob URL");
  assert.doesNotMatch(stripped, /azure-commons-storage-(account|key)/, "must not read the old Azure Blob storage creds");
  assert.doesNotMatch(stripped, /buildSas/, "the old hand-rolled Azure SAS primitive must be gone");
  assert.doesNotMatch(stripped, /vaultToken|kvSecret|azure-secret\.mjs/, "must not import/use the Key Vault reader at all");
  assert.match(src, /from "\.\.\/kb-memory\/commons-store\.mjs"/, "must route the commons write through the shared S3-backed facade");
  assert.match(src, /from "\.\.\/kb-memory\/aws-secret\.mjs"/, "must enumerate secrets via SSM");
});
