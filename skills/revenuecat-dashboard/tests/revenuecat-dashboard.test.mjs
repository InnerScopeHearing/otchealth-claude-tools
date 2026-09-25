import { test } from "node:test";
import assert from "node:assert/strict";
import { extractSecretKey, extractPublicKeys, redactKey, dashboardProjectId, validateActions } from "../lib.mjs";

test("extractSecretKey finds an sk_ key and ignores public keys", () => {
  assert.equal(extractSecretKey("label fleet sk_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 2"), "sk_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345");
  assert.equal(extractSecretKey("appl_ABCDEFGHIJKLMNOPQRSTUVWXYZ01"), null);
  assert.equal(extractSecretKey("sk_short"), null);
  assert.equal(extractSecretKey(undefined), null);
});

test("extractPublicKeys returns kind and key for every store prefix", () => {
  const got = extractPublicKeys("a appl_AAAAAAAAAAAAAAAAAAAA b test_BBBBBBBBBBBBBBBBBBBB c sk_CCCCCCCCCCCCCCCCCCCCCC");
  assert.deepEqual(got.map((k) => k.kind), ["appl", "test"]);
});

test("redactKey never returns the key body", () => {
  const k = "sk_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345";
  const r = redactKey(k);
  assert.equal(r, "sk_*** (len 35)");
  assert.ok(!r.includes("ABCDEF"));
});

test("dashboardProjectId strips the v2 proj prefix", () => {
  assert.equal(dashboardProjectId("proja2cc4776"), "a2cc4776");
  assert.equal(dashboardProjectId("a2cc4776"), "a2cc4776");
});

test("validateActions rejects typos and malformed steps before touching the live account", () => {
  assert.doesNotThrow(() => validateActions([{ click: "All projects", exact: true }, { fill: "input[name=x]", value: "y" }, { xy: [1, 2] }, { wait: 100 }]));
  assert.throws(() => validateActions({}), /array/);
  assert.throws(() => validateActions([{ clik: "x" }]), /unknown key/);
  assert.throws(() => validateActions([{ fill: "input" }]), /string value/);
  assert.throws(() => validateActions([{ role: "button" }]), /needs a name/);
  assert.throws(() => validateActions([{ xy: [1] }]), /xy must be/);
});
