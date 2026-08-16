import { test } from "node:test";
import assert from "node:assert/strict";
import { authMechanismRefusal } from "../pg-wire.mjs";

/**
 * The Postgres SERVER chooses the password mechanism, so a client that implements the legacy ones
 * will use them the moment some server asks -- with no code change, no config change, and no log
 * line. That makes this a branch nobody exercises until the day it matters.
 *
 * These tests pin the decision at every combination, because the failure mode is silent: a
 * downgrade to md5, or a password sent in the clear, both produce a perfectly successful
 * connection. There is no error to notice.
 */

const SCRAM = 10;
const MD5 = 5;
const CLEARTEXT = 3;

test("SCRAM-SHA-256 is always allowed, encrypted or not", () => {
  for (const encrypted of [true, false]) {
    assert.equal(authMechanismRefusal(SCRAM, { encrypted, allowWeakAuth: false }), null);
  }
});

test("MD5 is refused by default, on an encrypted connection too", () => {
  // TLS does not rescue md5: the weakness is in the stored verifier and the challenge construction,
  // not in the confidentiality of the wire.
  for (const encrypted of [true, false]) {
    const refusal = authMechanismRefusal(MD5, { encrypted, allowWeakAuth: false });
    assert.ok(refusal, `md5 should be refused when encrypted=${encrypted}`);
    assert.match(refusal, /MD5/);
    assert.match(refusal, /scram-sha-256/i, "the refusal must say how to fix the server");
    assert.match(refusal, /PG_ALLOW_WEAK_AUTH/, "the refusal must name the override");
  }
});

test("cleartext is refused ONLY when the connection is not actually encrypted", () => {
  assert.equal(
    authMechanismRefusal(CLEARTEXT, { encrypted: true, allowWeakAuth: false }),
    null,
    "cleartext under TLS is normal and must not be broken",
  );

  const refusal = authMechanismRefusal(CLEARTEXT, { encrypted: false, allowWeakAuth: false });
  assert.ok(refusal, "cleartext on a plaintext socket must be refused");
  assert.match(refusal, /UNENCRYPTED/);
});

test("the override unlocks both weak mechanisms, and nothing else changes", () => {
  assert.equal(authMechanismRefusal(MD5, { encrypted: false, allowWeakAuth: true }), null);
  assert.equal(authMechanismRefusal(CLEARTEXT, { encrypted: false, allowWeakAuth: true }), null);
  assert.equal(authMechanismRefusal(SCRAM, { encrypted: true, allowWeakAuth: true }), null);
});

test("unknown mechanisms are not silently refused here", () => {
  // Codes this gate does not know about are the authentication loop's business, which throws a
  // specific "unsupported authentication method" error naming the code. If this gate swallowed them
  // by returning a refusal, that clearer error would be replaced by a misleading one about weak auth.
  for (const code of [0, 7, 11, 12, 99]) {
    assert.equal(authMechanismRefusal(code, { encrypted: false, allowWeakAuth: false }), null);
  }
});
