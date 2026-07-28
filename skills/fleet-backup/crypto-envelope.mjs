#!/usr/bin/env node
/**
 * crypto-envelope.mjs — shared AES-256-GCM encrypt/decrypt used by secrets-dr-export.mjs and
 * secrets-dr-restore.mjs. Pulled into its own module (rather than duplicated inline in each script,
 * which is how it originally shipped) so the archive format has ONE definition and a real test suite
 * (tests/secrets-dr-crypto.test.mjs) can pin it: a format/KDF change in either script independently
 * could otherwise make a night's export unrecoverable without anyone noticing until a real incident.
 *
 * Envelope layout: [16 bytes salt][12 bytes iv][16 bytes authTag][ciphertext]. Key = scrypt(passphrase,
 * salt, 32). decrypt() throws (GCM auth-tag mismatch) on a wrong passphrase or a truncated/corrupt
 * buffer — callers should treat any thrown error as "cannot verify this archive", never partial data.
 */
import crypto from "node:crypto";

export function encrypt(plaintextBuf, passphrase) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(passphrase, salt, 32);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintextBuf), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([salt, iv, authTag, ciphertext]);
}

export function decrypt(buf, passphrase) {
  if (buf.length < 44) throw new Error("envelope too short to contain salt+iv+authTag");
  const salt = buf.subarray(0, 16);
  const iv = buf.subarray(16, 28);
  const authTag = buf.subarray(28, 44);
  const ciphertext = buf.subarray(44);
  const key = crypto.scryptSync(passphrase, salt, 32);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
