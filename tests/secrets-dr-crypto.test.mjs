// Tests for fleet-backup/crypto-envelope.mjs, the AES-256-GCM envelope shared by
// secrets-dr-export.mjs and secrets-dr-restore.mjs. Pinned with a real test suite (2026-07-28 review
// finding) because a format/KDF drift between the two scripts could otherwise make a night's export
// unrecoverable without anyone noticing until a real incident, when it would be too late to fix.
import { test } from "node:test";
import assert from "node:assert/strict";
import { encrypt, decrypt, envelopeSize } from "../skills/fleet-backup/crypto-envelope.mjs";

test("round-trips arbitrary JSON through encrypt/decrypt with the correct passphrase", () => {
  const payload = JSON.stringify({ exportedAt: "2026-07-28T00:00:00Z", vault: "kv-otc-55c84f6bef", secrets: { "example-key": "sk_live_abc123", "pem-like": "-----BEGIN KEY-----\nabc\n-----END KEY-----" } });
  const plaintext = Buffer.from(payload, "utf8");
  const enc = encrypt(plaintext, "correct horse battery staple");
  const dec = decrypt(enc, "correct horse battery staple");
  assert.deepEqual(JSON.parse(dec.toString("utf8")), JSON.parse(payload));
});

test("envelope layout is [4 magic][1 version][16 salt][12 iv][16 authTag][ciphertext] = 49-byte fixed overhead", () => {
  const plaintext = Buffer.from("hello world", "utf8");
  const enc = encrypt(plaintext, "pw");
  assert.equal(enc.length, 49 + plaintext.length);
  assert.equal(enc.subarray(0, 4).toString("ascii"), "SDRE");
  assert.equal(enc.readUInt8(4), 1);
});

test("envelopeSize predicts the exact encrypted size without encrypting anything (no passphrase needed)", () => {
  const plaintext = Buffer.from("some plaintext of arbitrary length here", "utf8");
  const enc = encrypt(plaintext, "pw");
  assert.equal(envelopeSize(plaintext.length), enc.length);
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

test("decrypt throws a distinct error on bad magic bytes (wrong file / pre-versioned format)", () => {
  const notAnEnvelope = Buffer.from("this is just some random file content, not an envelope at all!!", "utf8");
  assert.throws(() => decrypt(notAnEnvelope, "pw"), /bad magic bytes/);
});

test("decrypt throws a distinct error on an unknown future format version", () => {
  const enc = encrypt(Buffer.from("payload", "utf8"), "pw");
  const tampered = Buffer.from(enc);
  tampered[4] = 99; // corrupt the version byte to an unknown value
  assert.throws(() => decrypt(tampered, "pw"), /unsupported envelope format version 99/);
});

test("decrypt throws on a truncated/corrupt envelope", () => {
  const enc = encrypt(Buffer.from("secret payload", "utf8"), "pw");
  assert.throws(() => decrypt(enc.subarray(0, 10), "pw"));
  const flipped = Buffer.from(enc);
  flipped[flipped.length - 1] ^= 0xff; // corrupt the last ciphertext byte -> auth tag must fail
  assert.throws(() => decrypt(flipped, "pw"));
});

test("decrypt throws on an empty buffer", () => {
  assert.throws(() => decrypt(Buffer.alloc(0), "pw"), /too short/);
});

test("GOLDEN FIXTURE: a real v1 envelope produced by an earlier build still decrypts correctly", () => {
  // Frozen 2026-07-28, produced by encrypt(Buffer.from("golden fixture plaintext for regression
  // pinning"), "golden-fixture-passphrase-v1") on the version-1 format. If a future change to
  // decodeV1() ever breaks this, every already-written nightly archive on S3/OneDrive breaks with it
  // -- that is exactly the scenario this fixture exists to catch before it ships.
  const golden = Buffer.from(
    "U0RSRQFLQq1dmu9MhcifYPsOJzwYRerAhgCjF23ySd2HFX5L9QMxclBRBy6jYug3/Ezc/e6kuJ9ITPyQukD5hf2JE8lJmxort6/KvWkBZUQbASFhBvbo9fX+xVtfdpXX",
    "base64",
  );
  const plaintext = decrypt(golden, "golden-fixture-passphrase-v1");
  assert.equal(plaintext.toString("utf8"), "golden fixture plaintext for regression pinning");
});
