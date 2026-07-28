#!/usr/bin/env node
/**
 * crypto-envelope.mjs — shared AES-256-GCM encrypt/decrypt used by secrets-dr-export.mjs and
 * secrets-dr-restore.mjs. Pulled into its own module (rather than duplicated inline in each script,
 * which is how it originally shipped) so the archive format has ONE definition and a real test suite
 * (tests/secrets-dr-crypto.test.mjs) can pin it: a format/KDF change in either script independently
 * could otherwise make a night's export unrecoverable without anyone noticing until a real incident.
 *
 * VERSIONED HEADER (added 2026-07-28 review finding): the original v0 format had no magic bytes or
 * version marker — a future format/KDF change would have had no way to tell an old on-disk archive
 * apart from a new one, stranding every historical nightly export with no legacy decode path. Layout:
 *   [4 bytes magic "SDRE"][1 byte format version][format-version-specific body]
 * Version 1 body: [16 bytes salt][12 bytes iv][16 bytes authTag][ciphertext]. Key = scrypt(passphrase,
 * salt, 32). A future version 2 gets its own decodeV2() branch in decrypt() below; version 1 archives
 * stay decryptable forever via decodeV1(). decrypt() throws a clear, distinct error for (a) missing/
 * wrong magic bytes ("not a recognized envelope" — e.g. pointed at the wrong file), (b) an unknown
 * version byte (a newer archive than this build of the script understands), and (c) a wrong passphrase
 * or corrupt/truncated body (GCM auth-tag mismatch) — never silently returns garbage in any case.
 */
import crypto from "node:crypto";

const MAGIC = Buffer.from("SDRE", "ascii"); // "Secrets DR Envelope"
const CURRENT_VERSION = 1;

export function encrypt(plaintextBuf, passphrase) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(passphrase, salt, 32);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintextBuf), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([MAGIC, Buffer.from([CURRENT_VERSION]), salt, iv, authTag, ciphertext]);
}

function decodeV1(body, passphrase) {
  if (body.length < 44) throw new Error("v1 envelope body too short to contain salt+iv+authTag");
  const salt = body.subarray(0, 16);
  const iv = body.subarray(16, 28);
  const authTag = body.subarray(28, 44);
  const ciphertext = body.subarray(44);
  const key = crypto.scryptSync(passphrase, salt, 32);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export function decrypt(buf, passphrase) {
  if (buf.length < 5) throw new Error("envelope too short to contain a header (magic+version)");
  const magic = buf.subarray(0, 4);
  if (!magic.equals(MAGIC)) {
    throw new Error("not a recognized secrets-dr envelope (bad magic bytes) — wrong file, or this predates the versioned-header format");
  }
  const version = buf.readUInt8(4);
  const body = buf.subarray(5);
  if (version === 1) return decodeV1(body, passphrase);
  throw new Error(`unsupported envelope format version ${version} — this decoder only knows version 1; you need a newer secrets-dr-restore.mjs`);
}

/** Exact byte size of an encrypted envelope for a given plaintext length, WITHOUT actually encrypting
 *  anything (no passphrase needed). Lets a --dry-run report an accurate size without minting or
 *  touching the DR passphrase at all. */
export function envelopeSize(plaintextLength) {
  return MAGIC.length + 1 /* version byte */ + 16 /* salt */ + 12 /* iv */ + 16 /* authTag */ + plaintextLength;
}
