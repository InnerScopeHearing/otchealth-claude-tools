// Tests for ssm-dr-export.mjs's mergeParamsWithMeta() -- the pure restore-fidelity classification
// (full vs degraded) that decides whether a restore can trust the recorded Type/Tier/KeyId, or must
// fall back to the safe SecureString/Standard defaults. Pure/no-network, so this is exercised directly
// rather than only through a live export against real AWS credentials.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeParamsWithMeta } from "../skills/fleet-backup/ssm-dr-export.mjs";

const V = (name, value, type = "SecureString") => ({ name, value, type });
const M = (name, tier = "Standard", keyId = null) => ({ name, tier, keyId });

test("full fidelity when every value has matching metadata", () => {
  const out = mergeParamsWithMeta([V("a", "1"), V("b", "2")], [M("a"), M("b")]);
  assert.equal(out.restoreFidelity, "full");
  assert.deepEqual(out.secrets, { a: "1", b: "2" });
  assert.deepEqual(out.paramMeta.a, { type: "SecureString", tier: "Standard", keyId: null });
});

test("degraded when metadata is completely empty but values are present (likely a missing IAM permission)", () => {
  const out = mergeParamsWithMeta([V("a", "1"), V("b", "2")], []);
  assert.equal(out.restoreFidelity, "degraded");
  // values are still fully present even when fidelity is degraded -- the backup itself is not blocked
  assert.deepEqual(out.secrets, { a: "1", b: "2" });
  assert.deepEqual(out.paramMeta.a, { type: "SecureString", tier: "Standard", keyId: null });
});

test("degraded when metadata coverage is below 50% (looks broken, not benign drift)", () => {
  const values = Array.from({ length: 10 }, (_, i) => V(`p${i}`, String(i)));
  const meta = [M("p0"), M("p1"), M("p2"), M("p3")]; // 4/10 = 40%
  const out = mergeParamsWithMeta(values, meta);
  assert.equal(out.restoreFidelity, "degraded");
});

test("full fidelity tolerated at exactly 50% coverage (the threshold is a strict less-than)", () => {
  const values = Array.from({ length: 10 }, (_, i) => V(`p${i}`, String(i)));
  const meta = Array.from({ length: 5 }, (_, i) => M(`p${i}`)); // 5/10 = 50%
  const out = mergeParamsWithMeta(values, meta);
  assert.equal(out.restoreFidelity, "full");
});

test("a small benign gap (one name missing from metadata) does not degrade overall fidelity, but that one name gets safe defaults", () => {
  const values = [V("a", "1"), V("b", "2"), V("c", "3")];
  const meta = [M("a", "Advanced", "alias/x"), M("b")]; // "c" missing
  const out = mergeParamsWithMeta(values, meta);
  assert.equal(out.restoreFidelity, "full");
  assert.deepEqual(out.paramMeta.a, { type: "SecureString", tier: "Advanced", keyId: "alias/x" });
  assert.deepEqual(out.paramMeta.c, { type: "SecureString", tier: "Standard", keyId: null });
});

test("no values and no metadata is trivially full (nothing to degrade)", () => {
  const out = mergeParamsWithMeta([], []);
  assert.equal(out.restoreFidelity, "full");
  assert.deepEqual(out.secrets, {});
});

test("preserves a String/StringList Type recorded on the value itself (Type comes from GetParametersByPath, not DescribeParameters)", () => {
  const out = mergeParamsWithMeta([V("flag", "true", "String")], [M("flag")]);
  assert.equal(out.paramMeta.flag.type, "String");
});
