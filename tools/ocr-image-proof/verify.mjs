import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, lstatSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const paths = [
  "skills/ocr-sweep/sweep.mjs",
  "skills/kb-memory/s3-blob.mjs",
  "setup/aws-sigv4.mjs",
  "setup/aws-secret.mjs",
];
const imageRepo = "900915535335.dkr.ecr.us-east-1.amazonaws.com/doc-indexer";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function run(command, args) {
  const result = spawnSync(command, args, { maxBuffer: 32 * 1024 * 1024, timeout: 120_000 });
  if (result.status !== 0) throw new Error(`${command} failed; command output suppressed`);
  return result.stdout;
}

/** Verify that an immutable platform manifest contains exact tracked OCR runtime bytes.
 * The container is never started. All output is hashes and immutable identities only. */
export function verifyOcrImage({ repo, source, digest, platform }, execute = run) {
  if (!/^[a-f0-9]{40}$/.test(source || "") || !/^sha256:[a-f0-9]{64}$/.test(digest || "") || !/^linux\/(amd64|arm64)$/.test(platform || "")) {
    throw new Error("Immutable source, platform digest, and supported platform are required");
  }
  if (execute("git", ["-C", repo, "cat-file", "-t", source]).toString().trim() !== "commit") throw new Error("Source object must be a commit");
  const image = `${imageRepo}@${digest}`;
  const dir = mkdtempSync(join(tmpdir(), "ocr-image-proof-"));
  let container;
  try {
    execute("docker", ["pull", "--platform", platform, image]);
    const inspected = JSON.parse(execute("docker", ["image", "inspect", image, "--format", "{{json .}}"]).toString());
    const [os, architecture] = platform.split("/");
    if (inspected.Os !== os || inspected.Architecture !== architecture || !inspected.RepoDigests?.includes(image)) throw new Error("Image identity or platform mismatch");
    container = execute("docker", ["create", "--platform", platform, "--entrypoint", "/bin/true", image]).toString().trim();
    if (!/^[a-f0-9]{64}$/.test(container)) throw new Error("Invalid container identifier");
    const files = [];
    for (const file of paths) {
      const sourceBytes = execute("git", ["-C", repo, "show", `${source}:${file}`]);
      const destination = join(dir, file);
      mkdirSync(dirname(destination), { recursive: true });
      execute("docker", ["cp", `${container}:/app/${file}`, destination]);
      const stat = lstatSync(destination);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Image path is not a regular file: ${file}`);
      const actual = sha256(readFileSync(destination));
      const expected = sha256(sourceBytes);
      if (actual !== expected) throw new Error(`Image/source mismatch: ${file}`);
      files.push({ file, sha256: actual });
    }
    return { schema_version: 1, kind: "cfo-ocr-image-byte-proof", source, image, digest, platform, match: true, files };
  } finally {
    try { if (/^[a-f0-9]{64}$/.test(container || "")) execute("docker", ["rm", container]); }
    finally { rmSync(dir, { recursive: true, force: true }); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 6) throw new Error("Usage: verify.mjs checkout source-commit platform-digest platform");
  const [repo, source, digest, platform] = process.argv.slice(2);
  const proof = verifyOcrImage({ repo, source, digest, platform });
  console.log(JSON.stringify(proof));
}
