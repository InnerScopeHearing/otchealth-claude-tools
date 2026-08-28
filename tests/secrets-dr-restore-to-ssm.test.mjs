// Tests for secrets-dr-restore.mjs's planSsmRestore() (2026-08-28, the AWS-native --to-ssm restore
// verb): the restore-fidelity fallback logic (String/StringList/SecureString, Standard/Advanced tier,
// and the case of an archive with NO paramMeta at all -- an older export, or one where
// ssm-dr-export.mjs could not reach DescribeParameters) must be exactly right, since a wrong Type
// silently corrupts a restored parameter (a String read back as SecureString ciphertext, or vice
// versa) and a wrong Tier hard-fails PutParameter for any value over 4KB. This is a pure function
// (no AWS credentials, no network), so it is tested directly rather than only through a live restore.
import { test } from "node:test";
import assert from "node:assert/strict";
import { planSsmRestore } from "../skills/fleet-backup/secrets-dr-restore.mjs";

test("defaults to SecureString/Standard when paramMeta is entirely absent (an older archive)", () => {
  const plan = planSsmRestore(["foo-key", "bar-key"], undefined);
  assert.deepEqual(plan, [
    { name: "bar-key", type: "SecureString", tier: "Standard", keyId: null },
    { name: "foo-key", type: "SecureString", tier: "Standard", keyId: null },
  ]);
});

test("preserves a recorded String type (restoring it as SecureString would corrupt it for a plain reader)", () => {
  const plan = planSsmRestore(["plain-flag"], { "plain-flag": { type: "String", tier: "Standard" } });
  assert.deepEqual(plan, [{ name: "plain-flag", type: "String", tier: "Standard", keyId: null }]);
});

test("preserves a recorded StringList type", () => {
  const plan = planSsmRestore(["region-list"], { "region-list": { type: "StringList", tier: "Standard" } });
  assert.equal(plan[0].type, "StringList");
});

test("preserves Advanced tier for a large SecureString and carries a customer KMS KeyId", () => {
  const plan = planSsmRestore(["big-sa-json"], { "big-sa-json": { type: "SecureString", tier: "Advanced", keyId: "alias/otchealth-secrets-dr" } });
  assert.deepEqual(plan[0], { name: "big-sa-json", type: "SecureString", tier: "Advanced", keyId: "alias/otchealth-secrets-dr" });
});

test("never attaches a keyId to a non-SecureString type even if paramMeta carries a stray one", () => {
  const plan = planSsmRestore(["odd-one"], { "odd-one": { type: "String", tier: "Standard", keyId: "alias/should-be-ignored" } });
  assert.equal(plan[0].keyId, null);
});

test("falls back to Standard tier + no keyId for a name missing from paramMeta, while others in the same archive keep their recorded metadata", () => {
  const plan = planSsmRestore(["known", "unknown"], { known: { type: "SecureString", tier: "Advanced", keyId: "alias/x" } });
  assert.deepEqual(plan, [
    { name: "known", type: "SecureString", tier: "Advanced", keyId: "alias/x" },
    { name: "unknown", type: "SecureString", tier: "Standard", keyId: null },
  ]);
});

test("output is sorted by name regardless of input order (deterministic dry-run/log output)", () => {
  const plan = planSsmRestore(["zebra", "alpha", "mango"], {});
  assert.deepEqual(plan.map((p) => p.name), ["alpha", "mango", "zebra"]);
});

test("never includes the actual secret VALUE in the plan shape", () => {
  const plan = planSsmRestore(["a-secret"], {});
  assert.ok(!("value" in plan[0]), "plan rows must never carry a value field");
});
