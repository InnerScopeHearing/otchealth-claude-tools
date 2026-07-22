// Tests for skills/fleet-backup/s3-client.mjs's pure SigV4-adjacent helpers. The file's own header
// comment calls URI-encoding "the #1 source of SigV4 SignatureDoesNotMatch bugs when done wrong" --
// these guard the exact encoding + path-building rules, without needing live AWS credentials.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sha256Hex, awsEncode, canonicalPath } from "../skills/fleet-backup/s3-client.mjs";

test("sha256Hex: matches a known SHA-256 vector", () => {
  // sha256("") -- the canonical empty-string digest, used elsewhere in this skill as EMPTY_SHA256.
  assert.equal(sha256Hex(Buffer.alloc(0)), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(sha256Hex(Buffer.from("abc", "utf8")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("awsEncode: unreserved characters pass through unchanged", () => {
  assert.equal(awsEncode("AZaz09-._~"), "AZaz09-._~");
});

test("awsEncode: reserved/special characters are percent-encoded, uppercase hex", () => {
  assert.equal(awsEncode(" "), "%20");
  assert.equal(awsEncode("/"), "%2F"); // canonicalPath keeps '/' literal by NOT calling awsEncode on it directly
  assert.equal(awsEncode(":"), "%3A");
  assert.equal(awsEncode("index-legal-company-2026-07-15.jsonl"), "index-legal-company-2026-07-15.jsonl");
});

test("awsEncode: multi-byte UTF-8 characters encode one raw byte at a time", () => {
  // 'é' is U+00E9, UTF-8 bytes 0xC3 0xA9 -- a naive per-CODEPOINT encoder (not per-byte) is the classic
  // SigV4 bug this file's header comment warns about.
  assert.equal(awsEncode("é"), "%C3%A9");
});

test("canonicalPath: encodes each path segment but keeps '/' separators literal", () => {
  assert.equal(canonicalPath("index-memory-exec-2026-07-15.jsonl"), "/index-memory-exec-2026-07-15.jsonl");
  assert.equal(canonicalPath("a/b c/d"), "/a/b%20c/d");
});

test("canonicalPath: always starts with a leading slash even for an empty key", () => {
  assert.equal(canonicalPath(""), "/");
});
