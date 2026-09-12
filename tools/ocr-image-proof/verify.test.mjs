import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { assertEligibleMergedSource, verifyOcrImage } from "./verify.mjs";

const source = execFileSync("git", ["rev-parse", "origin/main"], { encoding: "utf8" }).trim();
const digest = `sha256:${"b".repeat(64)}`;
const paths = ["skills/ocr-sweep/sweep.mjs", "skills/kb-memory/s3-blob.mjs", "setup/aws-sigv4.mjs", "skills/kb-memory/aws-secret.mjs"];
function fake({ mismatch = false, architecture = "amd64" } = {}) {
  return (command, args) => {
    if (command === "git" && args.includes("cat-file")) return Buffer.from("commit");
    if (command === "git") return Buffer.from("source\n");
    if (args[0] === "image") return Buffer.from(JSON.stringify({ Os: "linux", Architecture: architecture, RepoDigests: [`900915535335.dkr.ecr.us-east-1.amazonaws.com/doc-indexer@${digest}`] }));
    if (args[0] === "create") return Buffer.from("c".repeat(64));
    if (args[0] === "cp") { const target = args[2]; mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, mismatch ? "changed\n" : "source\n"); }
    return Buffer.from("");
  };
}
test("verifies every OCR runtime file without starting a container", () => {
  const proof = verifyOcrImage({ repo: ".", source, digest, platform: "linux/amd64" }, fake());
  assert.equal(proof.match, true); assert.equal(proof.files.length, paths.length);
});
test("rejects a source/image byte mismatch", () => assert.throws(() => verifyOcrImage({ repo: ".", source, digest, platform: "linux/amd64" }, fake({ mismatch: true })), /mismatch/));
test("requires every tracked OCR dependency in a merged main source tree", () => {
  assert.doesNotThrow(() => assertEligibleMergedSource(".", source));
});
