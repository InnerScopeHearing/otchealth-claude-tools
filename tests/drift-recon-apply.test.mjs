import { test } from "node:test";
import assert from "node:assert/strict";
import { repointPatchBody } from "../setup/drift-recon.mjs";

// drift-recon --apply is the FIX for the "rebuild, then manually re-pin 9 jobs" treadmill. Its core is
// the pure repointPatchBody(): a MINIMAL image-only PATCH that preserves everything else by sending the
// full container array with only [0].image swapped (a partial container would drop env under merge-patch
// -- the 07-05 failure family, one layer up). These tests cover the swap logic without hitting Azure
// (importing the module does not run the ARM flow -- isMain guard).

const OLD = "sha256:0000000000000000000000000000000000000000000000000000000000000000";
const NEW = "sha256:3f0bf3f8e93b18fa742c309c2e9dbff8abb32448e7ae4511c9cbd9b5a3c7e914";
const jobWith = (image) => ({
  name: "daily-digest",
  identity: { type: "UserAssigned", userAssignedIdentities: { "/subs/.../id-otc-jobs-kv": {} } },
  properties: {
    configuration: { secrets: [] },
    template: { containers: [{ name: "doc-indexer", image, env: [{ name: "A", value: "1" }, { name: "B", value: "2" }], resources: { cpu: 1 } }] },
  },
});

test("stale pin -> swaps the @sha256 digest, keeps the full container (env preserved)", () => {
  const plan = repointPatchBody(jobWith(`otchealthacr.azurecr.io/doc-indexer@${OLD}`), NEW);
  assert.ok(plan, "should produce a plan");
  const c0 = plan.patchBody.properties.template.containers[0];
  assert.equal(c0.image, `otchealthacr.azurecr.io/doc-indexer@${NEW}`);
  assert.equal((c0.env || []).length, 2, "env must ride along in the full-array PATCH");
  assert.match(plan.fromImage, /@sha256:0000/);
  assert.equal(plan.toImage, `otchealthacr.azurecr.io/doc-indexer@${NEW}`);
});

test("mutable :tag (no digest) -> pins by digest (strips the tag)", () => {
  const plan = repointPatchBody(jobWith("otchealthacr.azurecr.io/doc-indexer:latest"), NEW);
  assert.ok(plan);
  assert.equal(plan.toImage, `otchealthacr.azurecr.io/doc-indexer@${NEW}`);
});

test("already on the target digest -> null (no-op, nothing to reconcile)", () => {
  assert.equal(repointPatchBody(jobWith(`otchealthacr.azurecr.io/doc-indexer@${NEW}`), NEW), null);
});

test("accepts latestDigest with or without the sha256: prefix", () => {
  const bare = NEW.slice("sha256:".length);
  const plan = repointPatchBody(jobWith(`otchealthacr.azurecr.io/doc-indexer@${OLD}`), bare);
  assert.equal(plan.toImage, `otchealthacr.azurecr.io/doc-indexer@${NEW}`);
});

test("no container / malformed job -> null (never throws)", () => {
  assert.equal(repointPatchBody({}, NEW), null);
  assert.equal(repointPatchBody({ properties: { template: { containers: [] } } }, NEW), null);
  assert.equal(repointPatchBody(null, NEW), null);
});
