// Tests for fleet-backup/crypto-envelope.mjs, the AES-256-GCM envelope shared by
// secrets-dr-export.mjs and secrets-dr-restore.mjs. Pinned with a real test suite (2026-07-28 review
// finding) because a format/KDF drift between the two scripts could otherwise make a night's export
// unrecoverable without anyone noticing until a real incident, when it would be too late to fix.
import { test } from "node:test";
import assert from "node:assert/strict";
import { encrypt, decrypt } from "../skills/fleet-backup/crypto-envelope.mjs";

test("round-trips arbitrary JSON through encrypt/decrypt with the correct passphrase", () => {
  const payload = JSON.stringify({ exportedAt: "2026-07-28T00:00:00Z", vault: "kv-otc-55c84f6bef", secrets: { "example-key": "sk_live_abc123", "pem-like": "-----BEGIN KEY-----\nabc\n-----END KEY-----" } });
  const plaintext = Buffer.from(payload, "utf8");
  const enc = encrypt(plaintext, "correct horse battery staple");
  const dec = decrypt(enc, "correct horse battery staple");
  assert.deepEqual(JSON.parse(dec.toString("utf8")), JSON.parse(payload));
});

test("envelope layout is [16 salt][12 iv][16 authTag][ciphertext] and grows only by the fixed 44-byte header", () => {
  const plaintext = Buffer.from("hello world", "utf8");
  const enc = encrypt(plaintext, "pw");
  assert.equal(enc.length, 44 + plaintext.length);
});

test("two encrypt() calls on the same plaintext+passphrase produce different ciphertexts (random salt/iv)", () => {
  const plaintext = Buffer.from("same input", "utf8");
  const a = encrypt(plaintext, "pw");
  const b = encrypt(plaintext, "pw");
  assert.notEqual(a.toString("hex"), b.toString("hex"));
  assert.equal(decrypt(a, "pw").toString("utf8"), "same input");
  assert.equal(decrypt(b, "pw").toString("utf8"), "same input");
});

test("decrypt throws on a wrong passphrase (GCM auth-tag mismatch), never returns garbage", () => {
  const enc = encrypt(Buffer.from("secret payload", "utf8"), "correct-passphrase");
  assert.throws(() => decrypt(enc, "wrong-passphrase"));
});

test("decrypt throws on a truncated/corrupt envelope", () => {
  const enc = encrypt(Buffer.from("secret payload", "utf8"), "pw");
  assert.throws(() => decrypt(enc.subarray(0, 10), "pw"), /too short/);
  const flipped = Buffer.from(enc);
  flipped[flipped.length - 1] ^= 0xff; // corrupt the last ciphertext byte -> auth tag must fail
  assert.throws(() => decrypt(flipped, "pw"));
});

test("decrypt throws on an empty buffer", () => {
  assert.throws(() => decrypt(Buffer.alloc(0), "pw"), /too short/);
});
