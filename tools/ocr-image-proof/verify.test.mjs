import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { assertEligibleMergedSource, verifyOcrImage } from "./verify.mjs";

const digest = `sha256:${"b".repeat(64)}`;
const paths = ["skills/ocr-sweep/sweep.mjs", "skills/kb-memory/s3-blob.mjs", "setup/aws-sigv4.mjs", "skills/kb-memory/aws-secret.mjs"];
function git(repo, args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}
function sourceFixture({ omit = [] } = {}) {
  const repo = mkdtempSync(join(tmpdir(), "ocr-image-proof-test-"));
  git(repo, ["init"]);
  git(repo, ["config", "user.email", "test@example.invalid"]);
  git(repo, ["config", "user.name", "OCR image proof test"]);
  for (const file of paths) {
    if (omit.includes(file)) continue;
    const destination = join(repo, file);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, "source\n");
  }
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "fixture"]);
  const source = git(repo, ["rev-parse", "HEAD"]);
  git(repo, ["update-ref", "refs/remotes/origin/main", source]);
  return { repo, source };
}
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
  const fixture = sourceFixture();
  try {
    const proof = verifyOcrImage({ ...fixture, digest, platform: "linux/amd64" }, fake());
    assert.equal(proof.match, true); assert.equal(proof.files.length, paths.length);
  } finally { rmSync(fixture.repo, { recursive: true, force: true }); }
});
test("rejects a source/image byte mismatch", () => {
  const fixture = sourceFixture();
  try { assert.throws(() => verifyOcrImage({ ...fixture, digest, platform: "linux/amd64" }, fake({ mismatch: true })), /mismatch/); }
  finally { rmSync(fixture.repo, { recursive: true, force: true }); }
});
test("requires every tracked OCR dependency in a merged main source tree", () => {
  const fixture = sourceFixture();
  try { assert.doesNotThrow(() => assertEligibleMergedSource(fixture.repo, fixture.source)); }
  finally { rmSync(fixture.repo, { recursive: true, force: true }); }
});
test("rejects a merged source tree missing a tracked dependency", () => {
  const fixture = sourceFixture({ omit: ["skills/kb-memory/aws-secret.mjs"] });
  try { assert.throws(() => assertEligibleMergedSource(fixture.repo, fixture.source), /source-tree validation/); }
  finally { rmSync(fixture.repo, { recursive: true, force: true }); }
});
