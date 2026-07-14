import { test } from "node:test";
import assert from "node:assert/strict";
import { infer, buildRegistry } from "../skills/vault-sync/vault-registry.mjs";

// vault-registry now enumerates Azure Key Vault (was retired GCP Secret Manager). The classifier and
// the markdown/jsonl builder are pure and source-agnostic (KV names 1:1 mirror the old SM ids), so
// they are unit-testable without touching KV. The main() writer is guarded behind an isMain check so
// importing this module here does NOT hit Key Vault or the commons.

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
  assert.match(md, /Azure Key Vault/, "header names the live store, not Secret Manager");
  // the registry is a NAMES view; the jsonl rows carry only id + classification + created, never a value.
  for (const line of jsonl.trim().split("\n")) {
    const r = JSON.parse(line);
    assert.deepEqual(Object.keys(r).sort(), ["created", "env", "id", "ring", "service", "type"]);
  }
});
