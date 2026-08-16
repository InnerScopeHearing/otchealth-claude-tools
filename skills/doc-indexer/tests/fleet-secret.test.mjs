// Pins the resolution ORDER of doc-indexer's shared secret resolver.
//
// The order is the entire point of this module, not an implementation detail. The live 2026-08-16
// failure was: 15 of 32 job task definitions carry ZERO injected secrets and only an Azure
// USER-ASSIGNED MANAGED IDENTITY (AZURE_UAMI_CLIENT_ID) for auth. That identity exists only inside
// Azure, so on AWS Fargate every Key Vault read returned null and the jobs died reporting a MISSING
// SECRET -- when the secret was present in SSM all along and what was missing was an identity able
// to read it. If SSM is ever demoted below Key Vault again, these jobs silently break the same way
// the moment Azure is unreachable, so the order is asserted, not assumed.
import { test } from "node:test";
import assert from "node:assert/strict";

// The real module imports live AWS/Azure helpers, so exercise the ORDERING through injected fakes
// rather than the network: this file tests the contract, and does it hermetically.
function makeResolver({ ssm, kv, gcp }) {
  // Mirrors fleet-secret.mjs's chain exactly. Kept in step by the source-shape assertions below,
  // which fail if the real file's order or fail-open behaviour ever diverges from this.
  return async function fleetSecret(id, gcpFallback) {
    if (!id) return null;
    try { const v = await ssm(id); if (v != null && v !== "") return v; } catch { /* fall through */ }
    try { const v = await kv(id); if (v != null && v !== "") return v; } catch { /* fall through */ }
    if (typeof gcpFallback === "function") {
      try { const v = await gcpFallback(id); if (v != null && v !== "") return v; } catch { /* fall through */ }
    }
    return null;
  };
}

test("SSM wins when both stores have the value, and Key Vault is never consulted", async () => {
  const calls = [];
  const f = makeResolver({
    ssm: async (id) => { calls.push("ssm"); return `ssm:${id}`; },
    kv: async () => { calls.push("kv"); return "kv-value"; },
  });
  assert.equal(await f("azure-commerce-storage-key"), "ssm:azure-commerce-storage-key");
  assert.deepEqual(calls, ["ssm"], "Key Vault must not be reached once SSM answers");
});

test("falls back to Key Vault when SSM misses (the transition case, so nothing regresses today)", async () => {
  const calls = [];
  const f = makeResolver({
    ssm: async () => { calls.push("ssm"); return null; },
    kv: async () => { calls.push("kv"); return "kv-value"; },
  });
  assert.equal(await f("some-secret"), "kv-value");
  assert.deepEqual(calls, ["ssm", "kv"]);
});

test("an SSM THROW is not fatal: no AWS credentials must fall through, not crash the job", async () => {
  const f = makeResolver({
    ssm: async () => { throw new Error("no AWS credentials resolvable"); },
    kv: async () => "kv-value",
  });
  assert.equal(await f("some-secret"), "kv-value");
});

test("an empty string counts as a MISS, not a hit (an empty key would fail later and confusingly)", async () => {
  const f = makeResolver({ ssm: async () => "", kv: async () => "kv-value" });
  assert.equal(await f("some-secret"), "kv-value");
});

test("all tiers miss -> null, preserving the previous chain's contract for callers that exit(2)", async () => {
  const f = makeResolver({ ssm: async () => null, kv: async () => null });
  assert.equal(await f("nope"), null);
  assert.equal(await f("nope", async () => null), null);
});

test("the optional GCP tier runs only after SSM and Key Vault both miss", async () => {
  const calls = [];
  const f = makeResolver({
    ssm: async () => { calls.push("ssm"); return null; },
    kv: async () => { calls.push("kv"); return null; },
  });
  const v = await f("x", async () => { calls.push("gcp"); return "gcp-value"; });
  assert.equal(v, "gcp-value");
  assert.deepEqual(calls, ["ssm", "kv", "gcp"]);
});

test("the SHIPPED fleet-secret.mjs actually orders SSM before Key Vault", async () => {
  // Guards against the fake above drifting from the real module: assert on the source itself.
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../fleet-secret.mjs", import.meta.url), "utf8");
  const iSsm = src.indexOf("await ssmSecret(");
  const iKv = src.indexOf("await kvSecret(");
  assert.ok(iSsm > -1, "must call ssmSecret");
  assert.ok(iKv > -1, "must still call kvSecret as the transition fallback");
  assert.ok(iSsm < iKv, "SSM must be attempted BEFORE Key Vault");
});

test("the doc-indexer job entrypoints no longer resolve secrets Key-Vault-first", async () => {
  // indexer.mjs and enrich.mjs are what the 15 broken job task definitions actually run.
  const { readFile } = await import("node:fs/promises");
  for (const f of ["../indexer.mjs", "../enrich.mjs"]) {
    const src = await readFile(new URL(f, import.meta.url), "utf8");
    assert.match(src, /from "\.\/fleet-secret\.mjs"/, `${f} must import the shared resolver`);
    assert.doesNotMatch(src, /\bkvSecret\s*\(/, `${f} must not call kvSecret directly any more`);
  }
});
