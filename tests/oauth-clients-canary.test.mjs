import { test } from "node:test";
import assert from "node:assert/strict";
import { computeMissing, laneOf } from "../setup/oauth-clients-canary.mjs";

test("laneOf extracts the lane from canonical secret names", () => {
  assert.equal(laneOf("oauth-lane-cfo-id"), "cfo");
  assert.equal(laneOf("oauth-lane-clo-personal-id"), "clo-personal");
  assert.equal(laneOf("oauth-connector-cto-id"), "cto");
  assert.equal(laneOf("oauth-connector-developer-id"), "developer");
  assert.equal(laneOf("oauth-lane-cfo-secret"), null); // secret name, not an -id
  assert.equal(laneOf("unrelated-secret"), null);
});

test("computeMissing returns canonical clients absent from the live set", () => {
  const expected = ["oc_cfo_1", "occ_cto_2", "occ_cfo_3"];
  // this is the exact regression: the live registry has the lanes but the occ_ connectors were dropped
  assert.deepEqual(computeMissing(expected, ["oc_cfo_1"]), ["occ_cto_2", "occ_cfo_3"]);
  // invariant holds -> nothing missing
  assert.deepEqual(computeMissing(expected, ["oc_cfo_1", "occ_cto_2", "occ_cfo_3", "extra_ok"]), []);
  // empty live => everything is missing
  assert.deepEqual(computeMissing(expected, []), expected);
  // null/undefined ids are ignored, not reported as missing
  assert.deepEqual(computeMissing([null, undefined, "occ_x"], ["occ_x"]), []);
});
